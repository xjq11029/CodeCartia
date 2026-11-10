import { createDemoSessions, establishDemoContext } from './auth.js';
import { createRepository } from './repository.js';
import { createReceiptSender } from './receipt.js';
import { loadWorkflow } from './workflow.js';
import { createHandlers } from './handlers.js';
import { createRoutes } from './routes.js';
import { DemoError } from './errors.js';

export function createPurchaseApp(options = {}) {
  const sessions = createDemoSessions(options.users);
  const repository = createRepository(options.requests);
  const receipt = createReceiptSender();
  const workflow = options.workflow ?? loadWorkflow();
  const handlers = createHandlers({ repository, receipt, workflow });
  const dispatch = createRoutes({ repository, handlers });

  return {
    // sessionToken 是宿主识别演示会话的参数；body 不参与认证或资源绑定。
    async handle({ method, path, sessionToken, body, receiptTarget }) {
      const context = Object.freeze({
        ...establishDemoContext(sessions, sessionToken),
        // 原型诊断扩展：宿主可提供运行时目的地，仅供内存模拟记录。
        receiptTarget: receiptTarget ?? 'demo-memory-inbox',
      });
      try {
        const result = await dispatch({ method, path, context });
        return { status: 200, body: result };
      } catch (error) {
        if (error instanceof DemoError) {
          return { status: error.status, body: { error: error.code, message: error.message } };
        }
        throw error;
      }
    },
    repository,
    receipt,
    workflow,
    reset() {
      repository.reset();
      receipt.reset();
    },
  };
}
