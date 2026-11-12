# worker 进程与持久化实验

本目录推进 M1-03/07/08 的跨进程消息与 SQLite 发布恢复验证，属于隔离实验。受控生产者发送测试事实，不能计为语言分析或业务识别成绩；不替代完整 worker/schema 实现。

先读 [SPEC.md](SPEC.md)。传输采用探索用 UTF-8 JSONL，消息与日志分别走 stdout/stderr；存储采用当前 Python 标准库 SQLite。版本、流控、期限均为本实验配置，不冻结 D02/D04/D10 或产品支持范围。

实验不会执行被分析工程，只启动本目录登记的受控 Python 子进程；数据库、日志及临时文件仅写入 reports/。写入拒绝根外路径、现存重解析点与硬链接文件；未证明并发替换路径的安全性。

| 文件 | 作用 |
|---|---|
| [wire.py](wire.py)、[host.py](host.py)、[producer.py](producer.py) | 探索分帧/摘要、宿主接收与终态、可故障注入的受控生产者 |
| [store.py](store.py)、[store_probe.py](store_probe.py) | SQLite 最新请求/快照事务，提交窗口内的独立故障进程 |
| [cases.py](cases.py)、[verify.py](verify.py) | 对应既有 W-* 独立规格的受控输入和断言；不充当分析真值 |
| [io_policy.py](io_policy.py) | 所有实验写入的统一边界 |
| [执行报告](reports/verification.json)、[原始轨迹](reports/traces.json) | 用例、指纹、环境、观察顺序、进程清理和恢复记录 |

在本目录执行已验证命令：

```powershell
python -B verify.py
```

当前报告记录了版本/能力拒绝、前向精确引用、重复/冲突/缺批/错计数、来源与因果环、零 credit 取消、取消/完成三个窗口、崩溃/超时、严格 partial、最新请求乱序和 SQLite 提交前后杀进程恢复。完成裁决与发布资格分开；新请求失败不会给旧请求补位。源码/测试或规格修改后须重跑，报告中的指纹与用例数为实际依据。

尚未完成：语言适配器直接在该 worker 中执行、完整主题 schema、跨 worker 外部生产者引用、同进程多任务隔离、物理断电及损坏恢复、跨平台/打包/产品性能。试验的有限控制数据不测代码识别准确率，不能据此关闭整个 M1-03/07/08 或 G1。

依据：[worker 协议](../../../docs/contracts/M1-worker与扩展协议.md)、[独立正反例](../../../docs/contracts/M1-worker协议正反例与实验规格.md)、[精确引用参考模型](../contracts/README.md)。
