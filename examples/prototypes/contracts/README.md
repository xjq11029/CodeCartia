# 精确引用与发布顺序参考实验

本目录是 R11/R12 的可执行最小参考模型，使用 Node.js 标准库，不需安装依赖。它验证精确事实版本引用、独立推导、以及“最后发起的请求才可发布”的协调规则，不实现语言分析器、完整 schema 校验器、worker 传输或真实数据库事务。

| 文件 | 用途 |
|---|---|
| [model.mjs](model.mjs) | 精确事实引用和发布槽位状态机 |
| [cases.mjs](cases.mjs) | 独立构造输入和预期的正反例；不调用实现的键生成函数计算答案 |
| [contract.test.mjs](contract.test.mjs) | Node 内置测试入口 |
| [mutation-check.mjs](mutation-check.mjs) | 故意移除关键保护，确认独立断言能发现错误实现 |
| [REPORT.md](REPORT.md) | 实际运行范围、结果与尚未验证的边界 |

仓库根目录执行：

```powershell
node --test --test-isolation=none examples/prototypes/contracts/contract.test.mjs
node examples/prototypes/contracts/mutation-check.mjs
```

模型只处理测试内存中的合成记录，不读取或执行被分析项目，也不将预期注入分析器。恢复实验使用导出/重新载入状态，原子切换以单个同步状态转换模拟；磁盘 fsync、数据库事务、真实并发进程崩溃与恢复仍须 M1-08 单独验证。事实/协议草案为 `0.2-draft`，独立 bootstrap 和坐标策略版本不随之升级。

契约入口：[统一图与证据](../../../docs/contracts/M1-统一图与证据契约.md)、[资源/快照/规则](../../../docs/contracts/M1-资源快照与规则组合契约.md)、[worker 协议](../../../docs/contracts/M1-worker与扩展协议.md)。
