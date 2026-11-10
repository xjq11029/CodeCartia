// @evidence F.receipt:start
export function createReceiptSender() {
  const sent = [];
  const failures = [];
  let failNextSend = false;

  return {
    // @evidence F.receipt.target:start
    async send(request, runtimeTarget) {
      // 只写内存以模拟发送，没有邮件、网络或外部通知。
      if (failNextSend) {
        failNextSend = false;
        throw new Error('合成回执发送失败');
      }
      // 目的地来自运行时参数；只保存其标签，不验证或访问任何地址。
      sent.push({ requestId: request.id, state: request.state, target: runtimeTarget, mode: 'simulated' });
    },
    // @evidence F.receipt.target:end
    recordFailure(request, error) {
      failures.push({ requestId: request.id, message: error.message });
    },
    snapshot: () => structuredClone({ sent, failures }),
    failNext() { failNextSend = true; },
    reset() {
      sent.length = 0;
      failures.length = 0;
      failNextSend = false;
    },
  };
}
// @evidence F.receipt:end
