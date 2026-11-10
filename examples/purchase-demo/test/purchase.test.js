import test from 'node:test';
import assert from 'node:assert/strict';
import { createPurchaseApp } from '../server/app.js';
import { createWorkflow, loadWorkflow } from '../server/workflow.js';
import { REQUESTS, REALM, ROLES } from '../data/fixtures.js';

function invoke(app, user, id, action, body) {
  return app.handle({
    method: action === 'read' ? 'GET' : 'POST',
    path: `/requests/${id}${action === 'read' ? '' : `/${action}`}`,
    sessionToken: user ? `demo-${user}` : undefined,
    body,
  });
}

// 独立声明的 B0 运行预期：200 是本示例成功，403 是授权拒绝，
// 409/422 是授权之后的状态/金额业务拒绝，不代表没有权限。
const expectedStatuses = {
  read: [
    [200, 200, 200, 403],
    [200, 200, 200, 403],
    [200, 200, 200, 403],
    [403, 403, 403, 200],
  ],
  submit: [
    [200, 409, 409, 403],
    [403, 403, 403, 403],
    [403, 403, 403, 403],
    [403, 403, 403, 403],
  ],
  approve: [
    [403, 403, 403, 403],
    [409, 200, 422, 403],
    [403, 403, 403, 403],
    [403, 403, 403, 403],
  ],
};

for (const action of ['read', 'submit', 'approve']) {
  test(`${action}：u1-u4 × r1-r4 的 B0 结果矩阵`, async () => {
    for (let userIndex = 0; userIndex < 4; userIndex++) {
      for (let requestIndex = 0; requestIndex < 4; requestIndex++) {
        const user = `u${userIndex + 1}`;
        const id = `r${requestIndex + 1}`;
        const app = createPurchaseApp();
        const result = await invoke(app, user, id, action);
        assert.equal(result.status, expectedStatuses[action][userIndex][requestIndex], `${user} ${action} ${id}`);
        if (result.status !== 200) {
          assert.deepEqual(app.repository.snapshot().audits, []);
          assert.deepEqual(app.repository.get(id), REQUESTS[requestIndex]);
          assert.deepEqual(app.receipt.snapshot(), { sent: [], failures: [] });
        }
      }
    }
  });
}

test('三个入口均拒绝未认证主体；请求体不能建立认证身份', async () => {
  const app = createPurchaseApp();
  for (const action of ['read', 'submit', 'approve']) {
    const result = await invoke(app, undefined, 'r2', action, {
      userId: 'u2', roles: [ROLES.manager], tenant: 'T1', authenticated: true,
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.error, 'AUTHENTICATION_REQUIRED');
  }
  const invalidSession = await app.handle({ method: 'GET', path: '/requests/r2', sessionToken: 'invalid' });
  assert.equal(invalidSession.status, 401);
});

test('u4 自报 T1 / manager 不改变已绑定的 T2 认证上下文', async () => {
  const app = createPurchaseApp();
  const result = await invoke(app, 'u4', 'r2', 'approve', {
    userId: 'u2', tenant: 'T1', roles: [ROLES.manager],
  });
  assert.equal(result.status, 403);
  assert.equal(app.repository.get('r2').state, 'SUBMITTED');
  assert.deepEqual(app.repository.snapshot().audits, []);
});

test('绑定路由 ID 的原始申请；请求体不能替换对象、租户或金额', async () => {
  const app = createPurchaseApp();
  const forgedObject = await invoke(app, 'u2', 'r4', 'approve', {
    id: 'r2', owner: 'u1', tenant: 'T1', state: 'SUBMITTED', amount: 1000,
  });
  assert.equal(forgedObject.status, 403);
  const forgedAmount = await invoke(app, 'u2', 'r3', 'approve', { amount: 1000 });
  assert.equal(forgedAmount.status, 422);
  assert.equal(forgedAmount.body.error, 'AMOUNT_LIMIT');
  assert.equal(app.repository.get('r3').amount, 6000);
});

test('提交改变同一个 r1 的已提交内存状态，并写入共享审计函数的记录', async () => {
  const app = createPurchaseApp();
  const result = await invoke(app, 'u1', 'r1', 'submit');
  assert.equal(result.status, 200);
  assert.equal(result.body.request.state, 'SUBMITTED');
  assert.deepEqual(app.repository.get('r1'), { ...REQUESTS[0], state: 'SUBMITTED' });
  assert.deepEqual(app.repository.snapshot().audits, [{
    action: 'request.submit', actor: 'u1', realm: REALM, tenant: 'T1', requestId: 'r1', state: 'SUBMITTED',
  }]);
  assert.deepEqual(result.body.nextCandidates, ['u2']);
  assert.deepEqual(app.receipt.snapshot(), { sent: [], failures: [] });
});

test('提交金额 0 和负数被业务校验拒绝', async () => {
  for (const amount of [0, -1]) {
    const app = createPurchaseApp({ requests: [{ ...REQUESTS[0], amount }] });
    const result = await invoke(app, 'u1', 'r1', 'submit');
    assert.equal(result.status, 422);
    assert.equal(result.body.error, 'INVALID_AMOUNT');
    assert.equal(app.repository.get('r1').state, 'DRAFT');
    assert.deepEqual(app.repository.snapshot().audits, []);
  }
});

test('审批提交状态和审计之后才调用模拟回执', async () => {
  const app = createPurchaseApp();
  const result = await invoke(app, 'u2', 'r2', 'approve');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.receipt, { status: 'sent', mode: 'simulated' });
  assert.deepEqual(app.repository.get('r2'), { ...REQUESTS[1], state: 'APPROVED' });
  assert.deepEqual(app.repository.snapshot().audits, [{
    action: 'request.approve', actor: 'u2', realm: REALM, tenant: 'T1', requestId: 'r2', state: 'APPROVED',
  }]);
  assert.deepEqual(app.receipt.snapshot(), {
    sent: [{ requestId: 'r2', state: 'APPROVED', target: 'demo-memory-inbox', mode: 'simulated' }], failures: [],
  });
  assert.deepEqual(result.body.observerCandidates, ['u2', 'u3']);
  assert.equal(app.repository.get('r4').state, 'SUBMITTED');
});

test('审批金额 5000 元处于允许的业务边界', async () => {
  const app = createPurchaseApp({ requests: [{ ...REQUESTS[1], amount: 5000 }] });
  const result = await invoke(app, 'u2', 'r2', 'approve');
  assert.equal(result.status, 200);
  assert.equal(app.repository.get('r2').state, 'APPROVED');
});

test('同租户 manager 可读取自己的申请，仍禁止审批自己的申请', async () => {
  const ownRequest = { id: 'r5', owner: 'u2', tenant: 'T1', state: 'SUBMITTED', amount: 1000 };
  const app = createPurchaseApp({ requests: [...REQUESTS, ownRequest] });
  assert.equal((await invoke(app, 'u2', 'r5', 'read')).status, 200);
  assert.equal((await invoke(app, 'u2', 'r5', 'approve')).status, 403);
  assert.equal(app.repository.get('r5').state, 'SUBMITTED');
});

test('employee 不可读取或提交同租户他人的申请', async () => {
  const otherRequest = { id: 'r6', owner: 'other', tenant: 'T1', state: 'DRAFT', amount: 1000 };
  const app = createPurchaseApp({ requests: [otherRequest] });
  assert.equal((await invoke(app, 'u1', 'r6', 'read')).status, 403);
  assert.equal((await invoke(app, 'u1', 'r6', 'submit')).status, 403);
});

for (const point of ['audit-write', 'transaction-commit']) {
  test(`审批 ${point} 故障不提交状态/审计，也不调用回执`, async () => {
    const app = createPurchaseApp();
    const before = app.repository.snapshot();
    app.repository.failNext(point);
    const result = await invoke(app, 'u2', 'r2', 'approve');
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'TRANSACTION_FAILED');
    assert.deepEqual(app.repository.snapshot(), before);
    assert.deepEqual(app.receipt.snapshot(), { sent: [], failures: [] });
  });

  test(`提交 ${point} 故障不留下 SUBMITTED 或审计`, async () => {
    const app = createPurchaseApp();
    const before = app.repository.snapshot();
    app.repository.failNext(point);
    const result = await invoke(app, 'u1', 'r1', 'submit');
    assert.equal(result.status, 503);
    assert.deepEqual(app.repository.snapshot(), before);
  });
}

test('回执失败记录错误，保留已提交 APPROVED 和审计', async () => {
  const app = createPurchaseApp();
  app.receipt.failNext();
  const result = await invoke(app, 'u2', 'r2', 'approve');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.receipt, { status: 'failed', mode: 'simulated' });
  assert.equal(app.repository.get('r2').state, 'APPROVED');
  assert.equal(app.repository.snapshot().audits[0].state, 'APPROVED');
  assert.deepEqual(app.receipt.snapshot(), {
    sent: [], failures: [{ requestId: 'r2', message: '合成回执发送失败' }],
  });
  const read = await invoke(app, 'u3', 'r2', 'read');
  assert.equal(read.body.request.state, 'APPROVED');
});

test('重复提交或审批返回状态错误，不增加重复审计或回执', async () => {
  const submitApp = createPurchaseApp();
  await invoke(submitApp, 'u1', 'r1', 'submit');
  const secondSubmit = await invoke(submitApp, 'u1', 'r1', 'submit');
  assert.equal(secondSubmit.status, 409);
  assert.equal(submitApp.repository.snapshot().audits.length, 1);

  const approveApp = createPurchaseApp();
  await invoke(approveApp, 'u2', 'r2', 'approve');
  const secondApprove = await invoke(approveApp, 'u2', 'r2', 'approve');
  assert.equal(secondApprove.status, 409);
  assert.equal(approveApp.repository.snapshot().audits.length, 1);
  assert.equal(approveApp.receipt.snapshot().sent.length, 1);
});

test('工作流确实加载 JSON，并保留 manager 的两种参与者映射', () => {
  const workflow = loadWorkflow();
  assert.deepEqual(workflow.candidatesFor('申请人', REQUESTS[1]), ['u1']);
  assert.deepEqual(workflow.candidatesFor('审批人', REQUESTS[1]), ['u2']);
  assert.deepEqual(workflow.candidatesFor('观察者', REQUESTS[1]), ['u2', 'u3']);
  assert.deepEqual(workflow.candidatesFor('观察者', REQUESTS[3]), ['u4']);
});

test('改变候选人映射不授予审批权限', async () => {
  const workflow = createWorkflow({ realm: REALM, actorBindings: { '审批人': [ROLES.readonly] } });
  const app = createPurchaseApp({ workflow });
  assert.deepEqual(app.workflow.candidatesFor('审批人', REQUESTS[1]), ['u3']);
  assert.equal((await invoke(app, 'u3', 'r2', 'approve')).status, 403);
  assert.equal((await invoke(app, 'u2', 'r2', 'approve')).status, 200);
});

test('运行时回执目的地只记入内存，不改变 B0 授权与状态效果', async () => {
  const app = createPurchaseApp();
  const result = await app.handle({
    method: 'POST', path: '/requests/r2/approve', sessionToken: 'demo-u2',
    receiptTarget: 'runtime-chosen-demo-destination',
  });
  assert.equal(result.status, 200);
  assert.equal(app.repository.get('r2').state, 'APPROVED');
  assert.equal(app.receipt.snapshot().sent[0].target, 'runtime-chosen-demo-destination');
});

test('应用实例相互隔离，reset 独立恢复数据、审计和回执', async () => {
  const appA = createPurchaseApp();
  const appB = createPurchaseApp();
  await invoke(appA, 'u2', 'r2', 'approve');
  assert.equal(appB.repository.get('r2').state, 'SUBMITTED');
  appA.reset();
  assert.deepEqual(appA.repository.snapshot(), appB.repository.snapshot());
  assert.deepEqual(appA.receipt.snapshot(), { sent: [], failures: [] });
});

test('返回值或快照的修改不能变更已提交的仓储数据', async () => {
  const app = createPurchaseApp();
  const result = await invoke(app, 'u1', 'r2', 'read');
  result.body.request.owner = 'u2';
  app.repository.snapshot().requests.r2.state = 'APPROVED';
  assert.deepEqual(app.repository.get('r2'), REQUESTS[1]);
});

test('未注册入口和不存在的申请保留不同错误', async () => {
  const app = createPurchaseApp();
  const route = await app.handle({ method: 'DELETE', path: '/requests/r2', sessionToken: 'demo-u2' });
  assert.equal(route.status, 404);
  assert.equal(route.body.error, 'ROUTE_NOT_FOUND');
  const resource = await invoke(app, 'u2', 'unknown', 'read');
  assert.equal(resource.status, 404);
  assert.equal(resource.body.error, 'REQUEST_NOT_FOUND');
});
