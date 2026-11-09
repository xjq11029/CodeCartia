# CodeCartia（源图）

目标是通过 CLI＋本地 Web，提供跨语言代码理解与架构探索；
以业务场景和逻辑为主线，将角色授权绑定到具体步骤、动作和对象。

## 当前状态

M1-01 文档交付已完成，M1 基线尚未冻结。
目前只有文档，没有应用源码、包配置、可执行原型或运行命令。

## 关键目录

- docs/：设计、审查、推进方案及验收样例。
- docs/diagrams/：离线 HTML 图解、SVG 与可编辑图源。
- docs/capabilities/：语言、业务与授权覆盖清单。
- docs/acceptance/：需求与验收追踪。
- docs/decisions/：待决策事项。
- docs/progress/：任务状态与复核记录。

## 工程边界

- 规划能力不能描述为已实现或已通过验收。
- 首版目标语言须分别通过深度分析验收，范围见设计方案。
- 核心验收采用自动静态分析，AI 辅助与人工调整单独报告。

## 阅读入口

- [README.md](README.md)：项目介绍。
- [架构与设计图解](docs/diagrams/index.html)：从总览到步骤与依据的交互阅读。
- [docs/README.md](docs/README.md)：设计及专题文档索引。
- [M1 任务清单](docs/progress/M1-任务清单.md)：实际进度与任务依赖。
- 外部参考工程 SeeCode：`D:\ProjectCode\SeeCode`（本机路径），供后续设计与实现参考。
