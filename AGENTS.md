# CodeCartia（源图）

目标是通过 CLI＋本地 Web，提供跨语言代码理解与架构探索；
以业务场景和逻辑为主线，将角色授权绑定到具体步骤、动作和对象。

## 当前状态

M1-01 文档已完成；M1-02/03 当前为 0.2-draft，补入精确事实引用与最后请求发布世代。M1-04/06/07/08/10 已有局部实验及评估入口，实际结果见复审修复记录，M1 基线尚未冻结。
2026-11-12 已增加双语静态工程加载/事实映射、独立评估、platform-server 只读抽查及受控 worker/SQLite 恢复实验；仅覆盖声明子集，见 G1 首批验证记录。
已有设计图解、模拟体验原型与可运行采购示例；产品分析器、CLI 和 Web 尚未实现，M1 分析验收未完成。

## 关键目录

- docs/：设计、审查、推进方案及验收样例。
- docs/contracts/：统一图/证据、调用/HTTP、资源/快照/规则、业务步骤授权及 worker 协议/实验规格草案。
- docs/diagrams/：离线 HTML 图解、SVG 与可编辑图源。
- docs/prototype/：业务闭环与代码实现双向映射的模拟体验原型、生成器及验证脚本。
- examples/purchase-demo/：真实合成源码、功能测试与证据索引。
- examples/prototypes/：局部语义/业务实验、工程加载与独立评估、契约参考模型、worker 进程/持久化实验；范围与命令见各 README，不计为产品验收。
- docs/progress/：任务状态与复核记录。

## 工程边界

- 样例仅用于说明与验证能力；实际设计与开发保持跨项目通用性，不将样例的业务名词、流程、角色、权限或数值规则固化为核心模型、分析逻辑、产品界面或默认行为的假设。具体项目语义来自被分析工程的源码、元数据或显式配置。
- 规划能力不能描述为已实现或已通过验收。
- 初版只验证 JS/TS 与 Python，范围内仍须分别通过深度分析验收；Java、C#、C、C++ 整体延后，不阻塞初版。范围及依据见设计方案 §5 与 D13。
- 核心验收采用自动静态分析，AI 辅助与人工调整单独报告。

## 已验证命令

- 仓库根目录：`node docs/prototype/build.mjs` 生成原型；`node docs/prototype/verify.mjs` 验证业务结果与交互。
- `examples/purchase-demo/`：`pnpm test` 验证示例功能；以上均不作为产品分析验收。
- `examples/prototypes/project-loading/`：`python -B verify.py` 核验完整工程输入与独立预期；`examples/prototypes/worker-runtime/`：`python -B verify.py` 核验受控进程及 SQLite 恢复；均为 G1 局部实验。

## 阅读入口

- [README.md](README.md)：项目介绍与推荐阅读顺序。
- [docs/README.md](docs/README.md)：完整阅读路线及文档名称与实际路径对照。
- [docs/diagrams/index.html](docs/diagrams/index.html)：图解成品入口，从总览进入步骤与依据。
- [docs/prototype/index.html](docs/prototype/index.html)：产品体验入口，结果为模拟数据。
- [docs/progress/M1-任务清单.md](docs/progress/M1-任务清单.md)：实际进度与任务依赖。
- [docs/progress/G1-工程加载与进程恢复验证.md](docs/progress/G1-工程加载与进程恢复验证.md)：本批执行证据、复核与 G1 剩余条件。
- [docs/progress/M1-设计复审修复记录.md](docs/progress/M1-设计复审修复记录.md)：R11/R12、局部验证结果与尚未关闭的 G1 条件。
- [docs/decisions/D13-初版语言验证范围.md](docs/decisions/D13-初版语言验证范围.md)：初版语言范围与后续验证条件。
- 外部参考工程 SeeCode：`D:\ProjectCode\SeeCode`（本机路径），供后续设计与实现参考。
