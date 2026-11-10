// @evidence F.audit:start
// 提交与审批共用此函数；审计写入调用者的事务，而非独立提交。
export function recordAudit(tx, { action, principal, request }) {
  tx.appendAudit({
    action,
    actor: principal.id,
    realm: principal.realm,
    tenant: principal.tenant,
    requestId: request.id,
    state: request.state,
  });
}
// @evidence F.audit:end
