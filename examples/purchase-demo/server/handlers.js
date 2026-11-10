import { DemoError } from './errors.js';
import { recordAudit } from './audit.js';

export function createHandlers({ repository, receipt, workflow }) {
  // @evidence F.handler.submit:start
  function submit(principal, request) {
    if (request.state !== 'DRAFT') {
      throw new DemoError(409, 'INVALID_STATE', '只有 DRAFT 申请可以提交');
    }
    if (!(request.amount > 0)) {
      throw new DemoError(422, 'INVALID_AMOUNT', '提交金额必须大于 0 元');
    }
    // @evidence F.commit.submit:start
    const submitted = repository.transaction(tx => {
      const updated = tx.setState(request.id, 'SUBMITTED');
      recordAudit(tx, { action: 'request.submit', principal, request: updated });
      return updated;
    });
    // @evidence F.commit.submit:end
    return {
      request: submitted,
      nextCandidates: workflow.candidatesFor('审批人', submitted),
    };
  }
  // @evidence F.handler.submit:end

  // @evidence F.handler.approve:start
  async function approve(principal, request, receiptTarget) {
    if (request.state !== 'SUBMITTED') {
      throw new DemoError(409, 'INVALID_STATE', '只有 SUBMITTED 申请可以审批');
    }
    if (!(request.amount <= 5000)) {
      throw new DemoError(422, 'AMOUNT_LIMIT', '审批金额不能超过 5000 元');
    }
    // @evidence F.tx.approve:start
    const approved = repository.transaction(tx => {
      const updated = tx.setState(request.id, 'APPROVED');
      recordAudit(tx, { action: 'request.approve', principal, request: updated });
      return updated;
    });
    // @evidence F.tx.approve:end

    // @evidence F.receipt.after-commit:start
    let receiptStatus = 'sent';
    try {
      await receipt.send(approved, receiptTarget);
    } catch (error) {
      receipt.recordFailure(approved, error);
      receiptStatus = 'failed';
      // 事务已经提交；这里记录回执失败，不回滚 APPROVED 和审计。
    }
    // @evidence F.receipt.after-commit:end
    return {
      request: approved,
      receipt: { status: receiptStatus, mode: 'simulated' },
      observerCandidates: workflow.candidatesFor('观察者', approved),
    };
  }
  // @evidence F.handler.approve:end

  // @evidence F.handler.read:start
  function read(principal, request) {
    // request 由路由按同一 ID 从仓储读取，并已经通过对应读取策略。
    return {
      request,
      viewedBy: principal.id,
      applicantCandidates: workflow.candidatesFor('申请人', request),
      observerCandidates: workflow.candidatesFor('观察者', request),
    };
  }
  // @evidence F.handler.read:end

  return { submit, approve, read };
}
