# 示例工程

本目录存放用于理解 CodeCartia 目标阅读体验的合成工程。

| 目录 | 用途与状态 |
|---|---|
| [purchase-demo](purchase-demo/README.md) | 原生 JavaScript 前后端采购示例，可运行三类动作与公开功能测试；HTML 体验原型嵌入其真实源码，关系与场景结果仍为模拟数据 |
| [prototypes](prototypes/README.md) | JS/TS、Python、C# 局部语义实验，跨领域业务发现及精确引用/发布世代参考模型；实际命令、检查结果和限制见各目录 README 与 [复审记录](../docs/progress/M1-设计复审修复记录.md)，环境见 [盘点](../docs/progress/M1-04-环境盘点.md) |

示例不代表 CodeCartia 分析器已实现，不是完整 BS/AP 可执行基准或独立保留测试集。按 2026-11-12 [D13 决定](../docs/decisions/D13-初版语言验证范围.md)，初版只验证 JS/TS 与 Python，Java、C#、C、C++ 整体延后；已有 C# 实验记录保留。初版范围内的深度分析与跨项目改进仍须独立验收。

G1 首批已在 prototypes 新增静态完整工程加载、独立预期/评估、受控 worker 与 SQLite 恢复实验，结果见[本批验证记录](../docs/progress/G1-工程加载与进程恢复验证.md)。合成完整工程和已有示例观察各自记录，不能作为外部独立项目泛化成绩。
