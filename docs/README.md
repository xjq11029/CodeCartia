# CodeCartia 文档

当前文档包含设计方案 v0.6（2026-11-09）、历史审查与业务主线修订记录、推进方案 v0.4 及验收样例 v0.3；M1-01 文档已交付，M1-02 四份 `0.1-draft` 统一契约草案已通过文档复核，M1-03 worker 协议及独立正反例规格已交付并通过文档交叉复核（2026-11-10）。跨语言事实核对与协议运行验证仍待完成，M1-04 已交付本机环境盘点并准备局部实验初稿，最终验证尚未完成。仓库仍处于实施准备阶段，尚未实现产品应用或完成完整分析验证原型，M1 基线未冻结、G1 未通过。

## 阅读顺序与路径对照

建议按“产品目标 → 具体案例 → 技术设计 → 推进与现状 → 验收和风险”阅读。下表的实际路径均以仓库根目录为起点，点击路径可打开对应文件；文档名称中的 v0.6、v0.4、v0.3 是内容版本，不包含在实际文件名中。

| 顺序 | 文档或页面名称 | 实际路径（相对仓库根目录） | 阅读重点与当前状态 |
|---|---|---|---|
| 1 | 项目介绍 | [README.md](../README.md) | 工程用途、首版目标与实际状态 |
| 2 | 文档索引 | [docs/README.md](README.md) | 本页：阅读顺序、文档名称与实际文件路径的对照 |
| 3 | 架构图解与产品体验原型 | [docs/diagrams/index.html](diagrams/index.html)、[docs/prototype/index.html](prototype/index.html) | 图解说明架构；体验原型展示申请状态、业务条件与成功/失败结果，并可在具体业务规则和代码实现之间双向定位；结果为模拟，未运行分析器 |
| 4 | 设计方案 v0.6 | [docs/CodeCartia-设计方案.md](CodeCartia-设计方案.md) | 先读第 1–4 章了解需求、分析深度、用户流程和架构；以业务步骤组织角色授权，保留全语言及 R08–R10，尚未实施 |
| 5 | 业务场景与权限验收样例 v0.3 | [docs/CodeCartia-业务场景与权限验收样例.md](CodeCartia-业务场景与权限验收样例.md) | 先读第 2 章基础输入、BS01/BS02 与 AP01–AP03；BS01–BS05、AP01–AP07 覆盖场景主线、共享实体、未关联声明、索引顺序及策略/身份结果对照，尚未执行 |
| 6 | 完整推进方案 v0.4 | [docs/CodeCartia-推进方案.md](CodeCartia-推进方案.md) | 先读第 3、4 节的 M1–M6 路线、M1 工作包和 G1 完成判据；落实步骤授权绑定、同图角色反查与诊断，保留原验收任务，不承诺日期 |
| 7 | M1 任务清单 | [docs/progress/M1-任务清单.md](progress/M1-任务清单.md) | 十个工作包的实际状态、依赖、产物、下一步与 G1 缺口 |
| 8 | 需求与验收追踪 | [docs/acceptance/M1-需求与验收追踪.md](acceptance/M1-需求与验收追踪.md) | M1-01：需求及 R/S/Q/BS/AP 到任务、责任与验收的初步映射；验收尚未执行 |
| 9 | 语言框架与输入覆盖清单 | [docs/capabilities/M1-语言框架与输入覆盖清单.md](capabilities/M1-语言框架与输入覆盖清单.md) | 目标语言、设计框架、关系/协议、必要输入与待冻结细节 |
| 10 | 业务与授权覆盖清单 | [docs/capabilities/M1-业务与授权覆盖清单.md](capabilities/M1-业务与授权覆盖清单.md) | 场景、动作和对象对应的规则、状态及步骤授权绑定模式，含角色反查、证据和未关联边界 |
| 11 | M1 待决策清单 | [docs/decisions/M1-待决策清单.md](decisions/M1-待决策清单.md) | D01–D11 的依据、责任、依赖和最迟决定阶段；尚未冻结范围、预算、阈值或选型 |
| 12 | 设计审查报告 | [docs/CodeCartia-设计审查报告.md](CodeCartia-设计审查报告.md) | 先扫问题汇总，再看历史问题、R08–R10 与 v0.6 业务主线/步骤绑定修订；相关实现仍待验收 |
| 13 | M1-01 复核记录 | [docs/progress/M1-01-复核记录.md](progress/M1-01-复核记录.md) | M1-01 文档交付已完成并通过交叉复核；查看修订、检查与尚未交付项 |
| 14 | M1-02 统一契约草案 | [docs/contracts/README.md](contracts/README.md) | 开始 worker/语义原型前阅读：公共身份/证据/来源、上下文/HTTP、资源/快照/规则、业务步骤授权；四份草案共用版本，均未冻结 |
| 15 | M1-02 复核记录 | [docs/progress/M1-02-复核记录.md](progress/M1-02-复核记录.md) | 草案交付分工、交叉问题处理、文档检查与待执行的各语言核对/契约原型 |
| 16 | M1-03 worker 与扩展协议 | [docs/contracts/M1-worker与扩展协议.md](contracts/M1-worker与扩展协议.md)、[独立正反例与实验规格](contracts/M1-worker协议正反例与实验规格.md) | 引导/兼容、任务与尝试隔离、批次/引用、取消/失败、来源、完整性与发布；逻辑消息预期尚未执行 |
| 17 | M1-03 复核记录 | [docs/progress/M1-03-复核记录.md](progress/M1-03-复核记录.md) | 草案分工、实际复核、工具环境只读观察、结构检查及运行验证缺口 |
| 18 | M1-04 本机环境盘点 | [docs/progress/M1-04-环境盘点.md](progress/M1-04-环境盘点.md) | Windows x64 的工具/SDK、项目依赖与安装建议；局部实验初稿见 [examples/prototypes](../examples/prototypes/README.md)，最终验证待完成 |

看完第 5 步的业务样例后，回到设计方案，按第 6、7、8、13 章深入理解关系与证据模型、跨工程链路、数据管理与 AI、跨项目规则改进，再补读第 5、9、10、12 章的支持范围、执行边界、质量验收和待验证问题。

进入子目录时，先读对应 README：[docs/diagrams/README.md](diagrams/README.md)、[docs/prototype/README.md](prototype/README.md)、[docs/contracts/README.md](contracts/README.md)、[docs/progress/README.md](progress/README.md)、[docs/acceptance/README.md](acceptance/README.md)、[docs/capabilities/README.md](capabilities/README.md)、[docs/decisions/README.md](decisions/README.md)。图解与体验原型的维护方式见各自 README。

## 目录与验收边界

本目录包含文档索引和四份设计/审查/推进/验收主文档，以及 `diagrams/`、`prototype/`、`contracts/` 和四个追踪子目录 `capabilities/`、`acceptance/`、`decisions/`、`progress/`。内容具体以各目录 README 为准；`contracts/` 当前为 M1-02 四份统一契约、M1-03 worker 主协议及独立正反例/实验规格草案。协议实现与各语言接入待执行。体验原型使用模拟关系与真实示例位置，不进行自动分析。当前设计以 v0.6 为准；文档修订、图解、体验原型、覆盖登记或契约草案交付不代表实现通过。核心验收采用自动静态分析，AI 解释与人工调整另报；业务场景和步骤是阅读主线，角色与授权通过有据绑定解释这些动作，反查使用同一套关系。代码行为、业务含义与运行事实分别表达。

98%／90% 数值仍需基准验证，不直接套用于新增业务/权限能力。传播与业务/授权模式表、计算预算、样本和各分项门槛须在 M1 冻结；本目录已有环境盘点，尚无完整原型验收或产品验收报告。安装说明、实测能力矩阵、扩展指南与质量报告将在相应实现完成后补充。
