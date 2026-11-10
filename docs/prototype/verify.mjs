// 原型回归：真实示例结果、业务路径、证据定位与内存 DOM 交互。
// 不启动浏览器或服务，不安装依赖，不写生成成品；DOM 替身不验证视觉布局。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import template from './reader.template.mjs';
import { createPurchaseApp } from '../../examples/purchase-demo/server/app.js';
import { REQUESTS } from '../../examples/purchase-demo/data/fixtures.js';

const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(directory, '../..');
const html = readFileSync(resolve(directory, 'index.html'), 'utf8').replaceAll('\r\n', '\n');
const data = JSON.parse(readFileSync(resolve(directory, 'demo-data.json'), 'utf8'));
const model = JSON.parse(readFileSync(resolve(directory, 'demo-model.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const byId = (items, id) => items.find(item => item.id === id);
const readField = (object, path) => path.split('.').reduce((value, part) => value?.[part], object);
function verifyEvidence(snapshot) {
  for (const file of snapshot.files) {
    const raw = readFileSync(resolve(repository, file.path));
    assert.equal(hash(raw), file.sha256, `${file.path} 指纹已过期`);
    assert.equal(raw.toString('utf8').replaceAll('\r\n', '\n'), file.content);
  }
  for (const evidence of snapshot.evidence) {
    const file = byId(snapshot.files, evidence.fileId);
    assert(file, `缺证据文件 ${evidence.id}`);
    assert.equal(evidence.sha256, file.sha256);
    assert(evidence.startLine >= 1 && evidence.endLine >= evidence.startLine && evidence.endLine <= file.lineCount);
    assert.equal(evidence.excerpt, file.content.split('\n').slice(evidence.startLine - 1, evidence.endLine).join('\n'));
  }
}
let checks = 0;
async function check(name, work) {
  await work();
  checks += 1;
  console.log(`通过：${name}`);
}

// 只实现本阅读器使用的 DOM 操作；事件运行真实的页面回调。
class MemoryNode {
  constructor(tag = '', text = '') {
    this.tagName = tag.toUpperCase();
    this.nodeType = tag ? 1 : 3;
    this._text = String(text);
    this.childNodes = [];
    this.parentElement = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.listeners = new Map();
    this._value = undefined;
    this.className = '';
    this.clientWidth = 1100;
    this.clientHeight = 650;
    this.scrollTop = 0;
    this.offsetTop = 100;
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get lastChild() { return this.childNodes.at(-1) || null; }
  get firstChild() { return this.childNodes[0] || null; }
  get options() { return this.children.filter(node => node.tagName === 'OPTION'); }
  get value() { return this._value ?? (this.tagName === 'SELECT' ? this.options[0]?.value ?? '' : ''); }
  set value(value) { this._value = String(value); }
  get textContent() { return this._text + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this._text = String(value ?? ''); this.replaceChildren(); }
  get isConnected() { return this.parentElement ? this.parentElement.isConnected : this.tagName === 'HTML'; }
  get classList() {
    const node = this;
    return {
      contains(name) { return node.className.split(/\s+/).includes(name); },
      add(...names) { node.className = [...new Set([...node.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove(...names) { node.className = node.className.split(/\s+/).filter(name => name && !names.includes(name)).join(' '); },
      toggle(name, force) {
        const present = this.contains(name);
        const next = force ?? !present;
        if (next) this.add(name); else this.remove(name);
        return next;
      },
    };
  }
  setAttribute(name, value) {
    value = String(value);
    this.attributes.set(name, value);
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    if (name === 'value') this.value = value;
    if (name.startsWith('data-')) this.dataset[dataName(name.slice(5))] = value;
  }
  getAttribute(name) {
    if (name === 'class') return this.className;
    if (name.startsWith('data-')) return this.dataset[dataName(name.slice(5))] ?? null;
    return this.attributes.get(name) ?? null;
  }
  appendChild(node) {
    if (node.parentElement) node.remove();
    this.childNodes.push(node);
    node.parentElement = this;
    return node;
  }
  append(...nodes) { nodes.forEach(node => this.appendChild(typeof node === 'string' ? new MemoryNode('', node) : node)); }
  replaceChildren(...nodes) {
    this.childNodes.forEach(node => { node.parentElement = null; });
    this.childNodes = [];
    nodes.forEach(node => this.appendChild(node));
  }
  remove() {
    if (!this.parentElement) return;
    this.parentElement.childNodes = this.parentElement.childNodes.filter(node => node !== this);
    this.parentElement = null;
  }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== listener));
  }
  dispatchEvent(event) {
    event.target ??= this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) || []) listener.call(this, event);
    return !event.defaultPrevented;
  }
  click() { return this.dispatchEvent(memoryEvent('click')); }
  focus() {}
  select() {}
  scrollIntoView() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(item => this.matches(item.trim()));
    const attrs = [...selector.matchAll(/\[([^\]=]+)(?:=["']?([^\]"']*)["']?)?\]/g)];
    const bare = selector.replace(/\[[^\]]*\]/g, '');
    const tag = bare.match(/^[\w-]+/)?.[0];
    if (tag && this.tagName !== tag.toUpperCase()) return false;
    const id = bare.match(/#([\w-]+)/)?.[1];
    if (id && this.id !== id) return false;
    if ([...bare.matchAll(/\.([\w-]+)/g)].some(match => !this.classList.contains(match[1]))) return false;
    return attrs.every(([, name, value]) => value === undefined ? this.getAttribute(name) !== null : this.getAttribute(name) === value);
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
}
function dataName(name) { return name.replace(/-([a-z])/g, (_, character) => character.toUpperCase()); }
function memoryEvent(type, values = {}) {
  return { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...values };
}

function createReader() {
  const documentElement = new MemoryNode('html');
  documentElement.dataset.theme = 'dark';
  const body = documentElement.appendChild(new MemoryNode('body'));
  const document = {
    documentElement, body,
    createElement: tag => new MemoryNode(tag),
    createElementNS: (_, tag) => new MemoryNode(tag),
    createTextNode: value => new MemoryNode('', value),
    getElementById: id => documentElement.querySelector(`#${id}`),
    querySelector: selector => documentElement.querySelector(selector),
    querySelectorAll: selector => documentElement.querySelectorAll(selector),
    listeners: new Map(),
    addEventListener: MemoryNode.prototype.addEventListener,
    removeEventListener: MemoryNode.prototype.removeEventListener,
    execCommand: () => false,
  };
  // 静态骨架只提供真实 HTML 中已声明的元素；不生成任何业务/地图内容。
  const staticHtml = html.slice(0, html.indexOf('<script id="prototype-data"'));
  const staticIds = [...staticHtml.matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)];
  for (const [, tag, id] of staticIds) {
    const element = body.appendChild(new MemoryNode(tag));
    element.id = id;
    if (id === 'role-filter') {
      const option = element.appendChild(new MemoryNode('option', '全部角色'));
      option.value = '';
    }
  }
  const prototypeData = body.appendChild(new MemoryNode('script', JSON.stringify(data)));
  prototypeData.id = 'prototype-data';
  const scheduled = [];
  const blobs = [];
  const context = createContext({
    document,
    window: { innerWidth: 1200, innerHeight: 900, scrollTo() {} },
    navigator: {},
    localStorage: { getItem() { return null; }, setItem() {} },
    Blob,
    URL: { createObjectURL(blob) { blobs.push(blob); return `memory:blob-${blobs.length}`; }, revokeObjectURL() {} },
    requestAnimationFrame(callback) { scheduled.push(callback); return scheduled.length; },
    cancelAnimationFrame() {},
    ResizeObserver: class { observe() {} disconnect() {} },
    setTimeout() { return 1; }, clearTimeout() {},
    console,
  });
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .filter(match => !match[0].slice(0, match[0].indexOf('>')).includes('application/json'));
  assert.equal(scripts.length, 1);
  const script = scripts[0][1].replace(/\}\)\(\);\s*$/, `
globalThis.__readerTest = {
  get state() { return state; },
  call(name, ...args) { return eval(name).apply(null, args); },
  get(name) { return eval(name); }
};
})();`);
  runInContext(script, context, { timeout: 5000 });
  const flush = () => {
    let callbacks = 0;
    while (scheduled.length) {
      scheduled.shift()(0);
      callbacks += 1;
      assert(callbacks < 1000, '页面调度未结束');
    }
  };
  flush();
  const hook = context.__readerTest;
  assert(hook, '未成功载入页面脚本');
  return {
    document, hook, blobs, flush,
    call(name, ...args) { const result = hook.call(name, ...args); flush(); return result; },
    click(node) { assert(node, '没有找到待点击元素'); node.click(); flush(); },
    change(node, value) { assert(node, '没有找到待选择元素'); node.value = value; node.dispatchEvent(memoryEvent('change')); flush(); },
  };
}

await check('生成成品与当前模板、数据快照一致', () => {
  const encoded = JSON.stringify(data).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const expected = template.replace('__PROTOTYPE_DATA__', encoded).replaceAll('\r\n', '\n');
  const difference = [...Array(Math.min(html.length, expected.length)).keys()].find(index => html[index] !== expected[index]);
  assert.equal(hash(html), hash(expected), `成品尚未同步模板/数据，首个差异位置 ${difference ?? Math.min(html.length, expected.length)}`);
  assert.equal(data.meta.origin, 'mock');
  assert.equal(data.meta.analyzerRun, false);
  assert.equal(model.meta.origin, 'mock');
});

await check('所有源码指纹和证据片段与实际文件一致', () => {
  verifyEvidence(data);
  const stale = structuredClone(data);
  stale.evidence.find(item => item.id === 'F.approve.amount').excerpt = 'amount <= 3000';
  assert.throws(() => verifyEvidence(stale), '过期金额规则证据应被识别');
});

await check('业务路径连续、失败终点封闭且实现映射保持场景归属', () => {
  for (const scene of data.scenarios) {
    assert(scene.flow?.nodes.length && scene.flow?.edges.length && scene.flow?.paths.length, `${scene.id} 缺业务闭环`);
    const flow = scene.flow;
    for (const node of flow.nodes) {
      assert.equal(node.origin, 'mock');
      assert(node.evidence.length && node.codeNodeIds.length, `${node.id} 没有实现依据`);
      assert(byId(scene.steps, node.stepId), `${node.id} 未绑定业务步骤`);
      for (const id of node.codeNodeIds) assert(byId(data.graph.nodes, id)?.scenarios.includes(scene.id), `${node.id} 的代码归属错误`);
      for (const id of node.codeEdgeIds) assert(byId(data.graph.edges, id)?.scenarios.includes(scene.id), `${node.id} 的代码边归属错误`);
      for (const id of node.evidence) assert(byId(data.evidence, id), `${node.id} 缺证据 ${id}`);
      if (node.kind === 'outcome') assert.equal(flow.edges.filter(edge => edge.from === node.id).length, 0, `${node.id} 结果仍继续执行`);
    }
    for (const path of flow.paths) {
      assert.equal(path.nodeIds[0], flow.startId);
      assert.equal(path.nodeIds.at(-1), path.outcomeId);
      assert.equal(path.edgeIds.length, path.nodeIds.length - 1);
      assert.equal(byId(flow.nodes, path.outcomeId)?.kind, 'outcome');
      path.edgeIds.forEach((id, index) => {
        const edge = byId(flow.edges, id);
        assert(edge && edge.from === path.nodeIds[index] && edge.to === path.nodeIds[index + 1], `${scene.id}/${path.id} 路径断裂`);
      });
    }
  }
  const amount = byId(byId(data.scenarios, 'approve').flow.nodes, 'approve.flow.amount-check');
  const amountEvidence = byId(data.evidence, 'F.approve.amount');
  assert(amount.evidence.includes(amountEvidence.id));
  assert(amountEvidence.endLine - amountEvidence.startLine <= 4, '金额规则应定位实际条件片段，而非整段处理器');
  assert.match(amountEvidence.excerpt, /request\.amount <= 5000/);
  assert.match(amountEvidence.excerpt, /AMOUNT_LIMIT/);
  assert(data.implementation.byCodeNode['handler-approve'].some(ref => ref.flowNodeId === amount.id && ref.stepId === amount.stepId), '代码反向索引丢失金额规则');
  assert(data.implementation.byEvidence[amountEvidence.id].some(ref => ref.flowNodeId === amount.id), '源码片段反向索引丢失业务规则');
  assert(data.implementation.byCodeEdge['approve-receipt-failure'].some(ref => ref.flowNodeId === 'approve.flow.record-receipt-failure'), '回执错误处理调用没有映射到失败业务逻辑');
});

const reader = createReader();
const scenarios = reader.hook.get('scenarios');
const state = reader.hook.state;
let comparisons = 0;
function assertDisplayedPath(scene, result) {
  const pathIds = Array.from(result.path.nodeIds).sort();
  const activeIds = reader.document.querySelectorAll('.business-node.active').map(node => node.dataset.flowNodeId).sort();
  assert.deepEqual(activeIds, pathIds, `${scene.id}/${result.pathId} 业务图高亮与条件路径不一致`);
  const inactiveIds = reader.document.querySelectorAll('.business-node.skipped').map(node => node.dataset.flowNodeId).sort();
  assert.deepEqual(inactiveIds, Array.from(scene.flow.nodes).filter(node => !pathIds.includes(node.id)).map(node => node.id).sort());
  const activeEdges = reader.document.querySelectorAll('.business-edge.active').map(node => node.dataset.flowEdgeId).sort();
  assert.deepEqual(activeEdges, Array.from(result.path.edgeIds).sort(), `${scene.id}/${result.pathId} 业务分支线与条件路径不一致`);
}
function actualPath(result, fault) {
  const paths = { AUTHENTICATION_REQUIRED: 'unauthenticated', REQUEST_NOT_FOUND: 'not-found', FORBIDDEN: 'authorization-denied', INVALID_STATE: 'invalid-state', INVALID_AMOUNT: 'invalid-amount', AMOUNT_LIMIT: 'amount-limit' };
  if (result.body.error === 'TRANSACTION_FAILED') return fault;
  if (result.body.error) return paths[result.body.error];
  return result.body.receipt?.status === 'failed' ? 'receipt-failed' : 'success';
}
async function compare({ action, subjectId, resourceId, fault = 'none', resource }) {
  const scene = byId(scenarios, action);
  Object.assign(state, { scenarioId: action, subjectId, resourceId, fault });
  if (resource && !byId(reader.hook.get('resources'), resource.id)) reader.hook.get('resources').push(resource);
  const condition = reader.call('conditionFor', scene);
  const app = createPurchaseApp(resource ? { requests: [resource] } : {});
  const before = app.repository.snapshot();
  const calls = [];
  const originalGet = app.repository.get.bind(app.repository);
  app.repository.get = id => { calls.push('load-object'); return originalGet(id); };
  const originalTransaction = app.repository.transaction.bind(app.repository);
  app.repository.transaction = work => originalTransaction(tx => {
    const observed = {
      ...tx,
      setState(...args) { calls.push('stage-state'); return tx.setState(...args); },
      appendAudit(...args) { calls.push('append-audit'); return tx.appendAudit(...args); },
    };
    const result = work(observed);
    calls.push('transaction-commit');
    return result;
  });
  const originalSend = app.receipt.send.bind(app.receipt);
  app.receipt.send = (...args) => { calls.push('send-receipt'); return originalSend(...args); };
  const originalRecord = app.receipt.recordFailure.bind(app.receipt);
  app.receipt.recordFailure = (...args) => { calls.push('record-receipt-failure'); return originalRecord(...args); };
  if (fault === 'audit-failed') app.repository.failNext('audit-write');
  if (fault === 'transaction-failed') app.repository.failNext('transaction-commit');
  if (fault === 'receipt-failed') app.receipt.failNext();
  const id = resourceId === '__missing' ? '__missing' : resourceId;
  const result = await app.handle({
    method: action === 'read' ? 'GET' : 'POST',
    path: `/requests/${id}${action === 'read' ? '' : `/${action}`}`,
    sessionToken: subjectId === '__anonymous' ? undefined : `demo-${subjectId}`,
  });
  const expectedPath = actualPath(result, fault);
  assert.equal(condition.pathId, expectedPath, `${subjectId}/${resourceId}/${action}/${fault} 业务路径与真实源码不同`);
  const path = byId(scene.flow.paths, expectedPath);
  const outcome = byId(scene.flow.nodes, path.outcomeId);
  const observable = new Set(['load-object', 'stage-state', 'append-audit', 'transaction-commit', 'send-receipt', 'record-receipt-failure']);
  const pathCalls = Array.from(path.nodeIds, id => id.split('.').at(-1)).filter(id => observable.has(id));
  assert.deepEqual(calls, pathCalls, `${action}/${expectedPath} 业务路径与真实调用先后顺序不同`);
  assert.equal(outcome.result.status, result.status, `${action}/${expectedPath} HTTP 结果不符`);
  if (result.body.error) assert.equal(outcome.result.code, result.body.error);
  const after = app.repository.snapshot();
  if (outcome.result.state === 'unchanged') assert.deepEqual(after, before, `${action}/${expectedPath} 不能写入状态或审计`);
  else assert.equal(after.requests[id].state, outcome.result.state);
  for (const field of outcome.result.fields || []) {
    assert.notEqual(readField(result.body, field), undefined, `${action}/${expectedPath} 返回字段 ${field} 不存在`);
  }
  for (const [field, value] of Object.entries(outcome.result.values || {})) assert.equal(readField(result.body, field), value, `${action}/${expectedPath} 返回值 ${field} 不符`);
  if (result.status !== 200 || action !== 'approve') assert.equal(app.receipt.snapshot().sent.length + app.receipt.snapshot().failures.length, 0);
  else {
    assert.equal(after.audits.length, 1);
    assert.equal(app.receipt.snapshot()[expectedPath === 'receipt-failed' ? 'failures' : 'sent'].length, 1);
  }
  comparisons += 1;
}

await check('48 个 B0 条件组合与真实示例的路径、状态、审计和回执一致', async () => {
  for (const action of ['submit', 'approve', 'read']) {
    for (const subjectId of ['u1', 'u2', 'u3', 'u4']) {
      for (const resourceId of ['r1', 'r2', 'r3', 'r4']) await compare({ action, subjectId, resourceId });
    }
  }
});

await check('认证、对象缺失、金额边界和事务/审计/回执故障有准确结果', async () => {
  for (const action of ['submit', 'approve', 'read']) {
    await compare({ action, subjectId: '__anonymous', resourceId: 'r2' });
    await compare({ action, subjectId: 'u2', resourceId: '__missing' });
  }
  for (const fault of ['audit-failed', 'transaction-failed']) {
    await compare({ action: 'submit', subjectId: 'u1', resourceId: 'r1', fault });
    await compare({ action: 'approve', subjectId: 'u2', resourceId: 'r2', fault });
    await compare({ action: 'approve', subjectId: 'u2', resourceId: 'r3', fault });
  }
  await compare({ action: 'approve', subjectId: 'u2', resourceId: 'r2', fault: 'receipt-failed' });
  for (const amount of [0, -1]) {
    const resource = { ...REQUESTS[0], id: `verify-submit-${amount}`, amount };
    await compare({ action: 'submit', subjectId: 'u1', resourceId: resource.id, resource });
  }
  for (const amount of [5000, 5001]) {
    const resource = { ...REQUESTS[1], id: `verify-approve-${amount}`, amount };
    await compare({ action: 'approve', subjectId: 'u2', resourceId: resource.id, resource });
  }
});

await check('同一申请的生命周期依赖与分别发起的业务动作一致', async () => {
  const lifecycle = data.lifecycle;
  assert(lifecycle?.transitions.length === 2, '生命周期应只包含已实现的提交和审批迁移');
  assert.deepEqual(lifecycle.transitions.map(transition => [transition.from, transition.to, transition.scenarioId]), [['DRAFT', 'SUBMITTED', 'submit'], ['SUBMITTED', 'APPROVED', 'approve']]);
  const app = createPurchaseApp();
  await app.handle({ method: 'POST', path: '/requests/r1/submit', sessionToken: 'demo-u1' });
  assert.equal(app.repository.get('r1').state, 'SUBMITTED');
  assert.equal(app.repository.snapshot().audits.length, 1);
  assert.equal(app.receipt.snapshot().sent.length, 0, '提交不应自动触发审批回执');
  const read = await app.handle({ method: 'GET', path: '/requests/r1', sessionToken: 'demo-u3' });
  assert.equal(read.body.request.state, 'SUBMITTED');
  assert.equal(app.repository.snapshot().audits.length, 1, '读取不应触发状态迁移或审计');
  await app.handle({ method: 'POST', path: '/requests/r1/approve', sessionToken: 'demo-u2' });
  assert.equal(app.repository.get('r1').state, 'APPROVED');
  assert.equal(app.repository.snapshot().audits.length, 2);
});

// 后续 DOM 场景使用初始模拟主体/申请，不改变源文件或目标示例。
Object.assign(state, { subjectId: 'u2', resourceId: 'r3', fault: 'none', role: '' });
await check('金额失败的页面路径标出停止点，规则可以定位代码实现', () => {
  reader.call('openScene', 'approve');
  const scene = byId(scenarios, 'approve');
  const condition = reader.call('conditionFor', scene);
  assert.equal(condition.pathId, 'amount-limit');
  assertDisplayedPath(scene, condition);
  const amount = scene.flow.nodes.find(node => node.kind === 'check' && /金额/.test(node.title));
  assert(amount, '缺少独立金额规则节点');
  assert.equal(state.flowNodeId, amount.id, '默认条件详情和阅读位置必须指向金额停止点');
  reader.click(reader.document.querySelectorAll('.scene-tab').find(node => node.textContent === '业务实现地图'));
  assert(reader.document.querySelector('.map-focus')?.textContent.includes(amount.title), '直接切换地图标签应保留默认金额规则');
  reader.click(reader.document.querySelectorAll('.scene-tab').find(node => node.textContent === '业务逻辑闭环'));
  const flowButton = reader.document.querySelector(`[data-flow-node-id="${amount.id}"]`);
  reader.click(flowButton);
  assert.equal(state.flowNodeId, amount.id);
  reader.call('openImplementation', scene.id, amount.id, amount.stepId);
  assert.equal(state.flowNodeId, amount.id);
  assert.equal(state.stepId, amount.stepId);
  const focused = reader.document.querySelectorAll('.graph-node').filter(node => node.classList.contains('business-focus') || node.classList.contains('focused') || node.classList.contains('mapped'));
  assert(focused.some(node => node.dataset.codeNodeId === 'handler-approve'), '金额规则没有聚焦到审批处理器');
});

await check('故障选择联动完整业务路径，区分未提交和已审批回执失败', () => {
  Object.assign(reader.hook.state, { subjectId: 'u2', resourceId: 'r2', fault: 'none' });
  reader.call('openScene', 'approve');
  const scene = byId(scenarios, 'approve');
  for (const fault of ['audit-failed', 'transaction-failed', 'receipt-failed']) {
    reader.change(reader.document.querySelector('select[aria-label="后续故障假设"]'), fault);
    const condition = reader.call('conditionFor', scene);
    assert.equal(condition.pathId, fault);
    assertDisplayedPath(scene, condition);
    assert.equal(condition.result.state, fault === 'receipt-failed' ? 'APPROVED' : 'unchanged');
    assert.equal(condition.result.status, fault === 'receipt-failed' ? 200 : 503);
  }
  reader.change(reader.document.querySelector('select[aria-label="条件演示对象"]'), 'r3');
  reader.change(reader.document.querySelector('select[aria-label="后续故障假设"]'), 'transaction-failed');
  const amountFailure = reader.call('conditionFor', scene);
  assert.equal(amountFailure.pathId, 'amount-limit', '金额失败必须先于未进入的事务故障');
  assertDisplayedPath(scene, amountFailure);
  Object.assign(reader.hook.state, { subjectId: 'u3', resourceId: 'r2', fault: 'receipt-failed' });
  reader.call('openScene', 'read');
  const faultOptions = reader.document.querySelector('select[aria-label="后续故障假设"]').options.map(option => option.value);
  assert.deepEqual(faultOptions, ['none'], '独立读取不能提供事务或回执故障路径');
  assert.equal(reader.hook.state.fault, 'none');
  assert.equal(reader.call('conditionFor', byId(scenarios, 'read')).pathId, 'success');
});

await check('步骤切换后地图、业务详情和导出均跟随新步骤', async () => {
  Object.assign(reader.hook.state, { subjectId: 'u2', resourceId: 'r3', fault: 'none' });
  reader.call('openScene', 'approve');
  const scene = byId(scenarios, 'approve');
  const commit = byId(scene.steps, 'approve.commit');
  reader.click(reader.document.querySelectorAll('.scene-tab').find(node => node.textContent === '步骤说明'));
  reader.click(reader.document.querySelectorAll('.step-button').find(node => node.textContent.includes(commit.name)));
  assert.equal(reader.hook.state.stepId, commit.id);
  assert.notEqual(reader.hook.state.flowNodeId, 'approve.flow.amount-check', '选择新步骤后不能保留旧金额逻辑');
  reader.click(reader.document.querySelectorAll('.scene-tab').find(node => node.textContent === '业务实现地图'));
  const focus = reader.document.querySelector('.map-focus');
  assert(focus && !focus.textContent.includes('金额不超过 5,000 元'), '新步骤地图仍聚焦旧金额规则');
  reader.click(reader.document.querySelectorAll('.scene-tab').find(node => node.textContent === '业务逻辑闭环'));
  assert.equal(reader.hook.state.stepId, commit.id);
  assert.equal(byId(scene.flow.nodes, reader.hook.state.flowNodeId)?.stepId, commit.id, '切回业务图不能回到旧校验步骤');
  reader.call('exportView');
  const exported = JSON.parse(await reader.blobs.at(-1).text());
  assert.equal(exported.selectedStep.id, commit.id);
  assert.equal(exported.selectedFlowNode.stepId, commit.id);
});

await check('生命周期入口定位实际事务提交，主体切换同步业务路径和阅读位置', () => {
  reader.call('go', { view: 'overview', role: '' });
  reader.click(reader.document.querySelector('.lifecycle').querySelectorAll('button').find(node => node.textContent.startsWith(byId(scenarios, 'submit').name)));
  assert.equal(reader.hook.state.flowNodeId, 'submit.flow.transaction-commit', '生命周期提交不能误定位到尚未提交的副本写入');
  reader.call('go', { view: 'overview' });
  reader.click(reader.document.querySelector('.lifecycle').querySelectorAll('button').find(node => node.textContent.startsWith(byId(scenarios, 'approve').name)));
  assert.equal(reader.hook.state.flowNodeId, 'approve.flow.transaction-commit');
  Object.assign(reader.hook.state, { subjectId: 'u2', resourceId: 'r2', fault: 'none' });
  reader.call('openScene', 'read');
  reader.change(reader.document.querySelector('select[aria-label="条件演示主体"]'), 'u4');
  const condition = reader.call('conditionFor', byId(scenarios, 'read'));
  assert.equal(condition.pathId, 'authorization-denied');
  assert.equal(reader.hook.state.flowNodeId, 'read.flow.authorization', '主体切换后阅读位置应跟随新停止点');
});

await check('代码节点和调用边反查保留具体业务规则及步骤，历史可以往返', () => {
  const scene = byId(scenarios, 'approve');
  const amount = scene.flow.nodes.find(node => node.kind === 'check' && /金额/.test(node.title));
  reader.call('showNode', 'handler-approve');
  const inspector = reader.document.getElementById('inspector-content');
  const amountCard = inspector.querySelectorAll('.implementation-ref').find(node => node.textContent.includes(amount.title));
  const amountLink = amountCard?.querySelector('button');
  reader.click(amountLink);
  assert.equal(state.scenarioId, scene.id);
  assert.equal(state.stepId, amount.stepId);
  assert.equal(state.flowNodeId, amount.id);
  reader.click(reader.document.getElementById('history-back'));
  reader.click(reader.document.getElementById('history-forward'));
  assert.equal(reader.hook.state.flowNodeId, amount.id);
  reader.call('showEdge', 'approve-receipt');
  const receipt = scene.flow.nodes.find(node => node.codeEdgeIds.includes('approve-receipt'));
  const receiptCard = inspector.querySelectorAll('.implementation-ref').find(node => node.textContent.includes(receipt.title));
  const receiptLink = receiptCard?.querySelector('button');
  reader.click(receiptLink);
  assert.equal(reader.hook.state.flowNodeId, receipt.id);
  assert.equal(reader.hook.state.stepId, receipt.stepId);
});

await check('导出保留当前业务节点、条件路径和实现映射', async () => {
  Object.assign(reader.hook.state, { subjectId: 'u2', resourceId: 'r2', fault: 'receipt-failed' });
  reader.call('openScene', 'approve');
  reader.call('exportView');
  assert(reader.blobs.length);
  const exported = JSON.parse(await reader.blobs.at(-1).text());
  assert.equal(exported.reading.flowNodeId, reader.hook.state.flowNodeId);
  assert.equal(exported.conditionDemo.pathId, 'receipt-failed');
  assert.equal(exported.activePath.id, 'receipt-failed');
  assert.equal(exported.selectedFlowNode.id, reader.hook.state.flowNodeId);
  assert(exported.selectedScenario.flow?.nodes.length);
  assert(exported.implementation || exported.businessImplementation || exported.implementationMappings, '导出缺少实现映射');
});

console.log(`完成 ${checks} 组回归，${comparisons} 个真实示例结果对照；内存 DOM 覆盖交互，视觉布局仍需另行检查。`);
