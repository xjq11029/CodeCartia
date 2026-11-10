import { REQUESTS } from '../data/fixtures.js';
import { DemoError } from './errors.js';

export function createRepository(initialRequests = REQUESTS) {
  let state;
  const failures = new Set();

  function reset() {
    state = {
      requests: Object.fromEntries(initialRequests.map(request => [request.id, { ...request }])),
      audits: [],
    };
    failures.clear();
  }

  function consumeFailure(point) {
    if (failures.delete(point)) {
      throw new DemoError(503, 'TRANSACTION_FAILED', `合成故障：${point}`);
    }
  }

  // @evidence F.repository.get:start
  function get(id, from = state) {
    const request = from.requests[id];
    if (!request) throw new DemoError(404, 'REQUEST_NOT_FOUND', '申请不存在');
    return { ...request };
  }
  // @evidence F.repository.get:end

  // @evidence F.repository.transaction:start
  // 同步内存事务：先在独立副本写入，全部成功后一次替换已提交状态。
  // 不模拟磁盘耐久性，也不允许回调跨 await，以避免并发副本覆盖。
  function transaction(work) {
    const pending = structuredClone(state);
    const tx = {
      get: id => get(id, pending),
      setState(id, nextState) {
        const request = get(id, pending);
        pending.requests[id] = { ...request, state: nextState };
        return get(id, pending);
      },
      appendAudit(event) {
        consumeFailure('audit-write');
        pending.audits.push({ ...event });
      },
    };
    const result = work(tx);
    if (result?.then) throw new TypeError('此演示仅支持同步事务回调');
    consumeFailure('transaction-commit');
    state = pending;
    return result;
  }
  // @evidence F.repository.transaction:end

  reset();
  return {
    get,
    transaction,
    reset,
    snapshot: () => structuredClone(state),
    // 仅供测试编排，不挂载为 HTTP 接口。
    failNext(point) {
      if (!['audit-write', 'transaction-commit'].includes(point)) {
        throw new TypeError(`未知故障点：${point}`);
      }
      failures.add(point);
    },
  };
}
