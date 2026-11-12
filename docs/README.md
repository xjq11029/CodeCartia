# CodeCartia 文档

当前文档包含设计方案 v0.6、推进方案 v0.4（均于 2026-11-12 同步初版语言范围）、验收样例 v0.3 及历史复核。[D13](decisions/D13-初版语言验证范围.md) 已由用户确认初版只验证 JS/TS 与 Python，Java、C#、C、C++ 整体延后。M1-01 文档已交付；M1-02/03 当前使用独立的事实 schema 与 worker protocol `0.2-draft`，修复 R11 精确版本引用和 R12 并发发布。D12 已由用户确认最后发起请求决定当前结果。局部语义、业务发现、契约参考模型与评估器的实测和限制见[复审修复记录](progress/M1-设计复审修复记录.md)，已有 C# 实验按历史保留。初版语言深度、worker/存储恢复、真实项目加载与产品验收仍待完成，M1 基线未冻结、G1 未通过。

## 阅读顺序与路径对照

最新执行入口：[G1 工程加载与进程恢复验证](progress/G1-工程加载与进程恢复验证.md)。本批增加两条语言的静态完整工程切片、独立预期/拒错、新鲜度核对及真实进程/SQLite 恢复实验；[工程加载模式与预算](capabilities/M1-工程加载实验模式与预算.md)记录探索边界，不冻结首版支持和产品预算。

本批后续包括[双语公共事实映射](../examples/prototypes/fact-mapping/README.md)及用户提供的[platform-server 真实工程观察](../examples/prototypes/external-projects/README.md)。源码抽查、字段映射和完整框架/业务验收分别记录，G1 仍未通过。

建议按“产品目标 → 具体案例 → 技术设计 → 推进与现状 → 验收和风险”阅读。下表的实际路径均以仓库根目录为起点，点击路径可打开对应文件；文档名称中的 v0.6、v0.4、v0.3 是内容版本，不包含在实际文件名中。

| 顺序 | 文档或页面名称 | 实际路径（相对仓库根目录） | 阅读重点与当前状态 |
|---|---|---|---|
| 1 | 项目介绍 | [README.md](../README.md) | 工程用途、首版目标与实际状态 |
| 2 | 文档索引 | [docs/README.md](README.md) | 本页：阅读顺序、文档名称与实际文件路径的对照 |
| 3 | 架构图解与产品体验原型 | [docs/diagrams/index.html](diagrams/index.html)、[docs/prototype/index.html](prototype/index.html) | 图解说明架构；体验原型展示申请状态、业务条件与成功/失败结果，并可在具体业务规则和代码实现之间双向定位；结果为模拟，未运行分析器 |
| 4 | 设计方案 v0.6 | [docs/CodeCartia-设计方案.md](CodeCartia-设计方案.md) | 先读第 1–4 章了解需求、分析深度、用户流程和架构；第 5 章区分初版 JS/TS/Python 与后续语言，业务步骤授权及 R08–R10 要求继续保留 |
| 5 | 业务场景与权限验收样例 v0.3 | [docs/CodeCartia-业务场景与权限验收样例.md](CodeCartia-业务场景与权限验收样例.md) | 先读第 2 章基础输入、BS01/BS02 与 AP01–AP03；BS01–BS05、AP01–AP07 覆盖场景主线、共享实体、未关联声明、索引顺序及策略/身份结果对照，尚未执行 |
| 6 | 完整推进方案 v0.4 | [docs/CodeCartia-推进方案.md](CodeCartia-推进方案.md) | 先读第 3、4 节的 M1–M6 路线、M1 工作包和 G1 完成判据；按初版范围安排语言验证，落实步骤授权绑定、同图角色反查与诊断，不承诺日期 |
| 7 | M1 任务清单 | [docs/progress/M1-任务清单.md](progress/M1-任务清单.md) | 十个工作包的实际状态、依赖、产物、下一步与 G1 缺口 |
| 8 | 需求与验收追踪 | [docs/acceptance/M1-需求与验收追踪.md](acceptance/M1-需求与验收追踪.md) | M1-01：需求及 R/S/Q/BS/AP 到任务、责任与验收的初步映射；验收尚未执行 |
| 9 | 语言框架与输入覆盖清单 | [docs/capabilities/M1-语言框架与输入覆盖清单.md](capabilities/M1-语言框架与输入覆盖清单.md) | 初版与后续语言、框架、关系/协议、必要输入与待冻结细节；延后条目保留 ID |
| 10 | 业务与授权覆盖清单 | [docs/capabilities/M1-业务与授权覆盖清单.md](capabilities/M1-业务与授权覆盖清单.md) | 场景、动作和对象对应的规则、状态及步骤授权绑定模式，含角色反查、证据和未关联边界 |
| 11 | M1 待决策清单 | [docs/decisions/M1-待决策清单.md](decisions/M1-待决策清单.md) | D01–D11 的依据、责任与待决事项；D12 发布行为及 D13 初版语言范围已确认，具体模式、预算、阈值和选型仍待冻结 |
| 12 | 设计审查报告 | [docs/CodeCartia-设计审查报告.md](CodeCartia-设计审查报告.md) | 先扫问题汇总，再看历史问题、R08–R10 与 v0.6 业务主线/步骤绑定修订；相关实现仍待验收 |
| 13 | M1-01 复核记录 | [docs/progress/M1-01-复核记录.md](progress/M1-01-复核记录.md) | M1-01 文档交付已完成并通过交叉复核；查看修订、检查与尚未交付项 |
| 14 | M1-02 统一契约草案 | [docs/contracts/README.md](contracts/README.md) | 开始 worker/语义原型前阅读：公共身份/证据/来源、上下文/HTTP、资源/快照/规则、业务步骤授权；四份草案共用版本，均未冻结 |
| 15 | M1-02 复核记录 | [docs/progress/M1-02-复核记录.md](progress/M1-02-复核记录.md) | 草案交付分工、交叉问题处理、文档检查与待执行的各语言核对/契约原型 |
| 16 | M1-03 worker 与扩展协议 | [docs/contracts/M1-worker与扩展协议.md](contracts/M1-worker与扩展协议.md)、[独立正反例与实验规格](contracts/M1-worker协议正反例与实验规格.md) | 引导/兼容、任务与尝试隔离、批次/引用、取消/失败、来源、完整性与发布；受控消息/进程/SQLite 子集已有执行；完整序列和语言 worker 接入待完成 |
| 17 | M1-03 复核记录 | [docs/progress/M1-03-复核记录.md](progress/M1-03-复核记录.md) | 草案分工、实际复核、工具环境只读观察、结构检查及运行验证缺口 |
| 18 | M1-04 本机环境盘点 | [docs/progress/M1-04-环境盘点.md](progress/M1-04-环境盘点.md) | Windows x64 的工具/SDK、初版按需依赖与后续语言环境储备；局部实验见 [examples/prototypes](../examples/prototypes/README.md)，最终验证待完成 |
| 19 | 设计复审修复与局部评估 | [修复记录](progress/M1-设计复审修复记录.md)、[评估口径](acceptance/M1-局部实验与独立评估.md) | R11/R12、业务发现/语言实验、错误输出拒绝与实际验证；完整 M1 仍未完成 |
| 20 | M1-04 Ubuntu 虚拟机环境核对 | [Ubuntu 核对记录](progress/M1-04-Ubuntu环境核对.md)、[原始输出](progress/M1-04-Ubuntu环境原始报告.txt) | 系统/资源/工具观察及容器安装预览记录；后续容器准备不阻塞初版，实际安装与镜像验证未执行 |
| 21 | 并发发布决定 | [D12](decisions/D12-并发分析当前快照.md) | 最后登记请求的发布世代、历史结果与失败/取消行为，用户已确认 |
| 22 | 初版语言验证范围 | [D13](decisions/D13-初版语言验证范围.md) | 用户确认只验证 JS/TS 与 Python，Java、C#、C、C++ 整体延后；环境、阶段门槛与后续恢复条件 |

看完第 5 步的业务样例后，回到设计方案，按第 6、7、8、13 章深入理解关系与证据模型、跨工程链路、数据管理与 AI、跨项目规则改进，再补读第 5、9、10、12 章的支持范围、执行边界、质量验收和待验证问题。

进入子目录时，先读对应 README：[docs/diagrams/README.md](diagrams/README.md)、[docs/prototype/README.md](prototype/README.md)、[docs/contracts/README.md](contracts/README.md)、[docs/progress/README.md](progress/README.md)、[docs/acceptance/README.md](acceptance/README.md)、[docs/capabilities/README.md](capabilities/README.md)、[docs/decisions/README.md](decisions/README.md)。图解与体验原型的维护方式见各自 README。

## 目录与验收边界

本目录包含文档索引和四份设计/审查/推进/验收主文档，以及 `diagrams/`、`prototype/`、`contracts/` 和四个追踪子目录 `capabilities/`、`acceptance/`、`decisions/`、`progress/`。内容具体以各目录 README 为准；`contracts/` 当前为 M1-02 四份统一契约、M1-03 worker 主协议及独立正反例/实验规格草案。协议实现与初版 JS/TS、Python 接入待完成，延后语言的契约扩展位置保留。体验原型使用模拟关系与真实示例位置，不进行自动分析。当前设计以 v0.6 及 2026-11-12 的 D13 范围调整为准；文档修订、图解、体验原型、覆盖登记或契约草案交付不代表实现通过。核心验收采用自动静态分析，AI 解释与人工调整另报；业务场景和步骤是阅读主线，角色与授权通过有据绑定解释这些动作，反查使用同一套关系。代码行为、业务含义与运行事实分别表达。

98%／90% 数值仍需基准验证，不直接套用于新增业务/权限能力。传播与业务/授权模式表、计算预算、样本和各分项门槛须在 M1 冻结；本目录已有环境盘点，尚无完整原型验收或产品验收报告。安装说明、实测能力矩阵、扩展指南与质量报告将在相应实现完成后补充。
