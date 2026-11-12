# M1 局部分析与契约实验

本目录承载 M1-04/06/07/08/10 的隔离实验，不是 CodeCartia 产品模块。已有局部语言提取器、独立预期/评估器、业务发现实验和精确引用/发布世代参考模型。实际执行和复核见各目录报告及[复审记录](../../docs/progress/M1-设计复审修复记录.md)；尚无完整语言深度、完整协议/存储恢复、项目加载或产品准入结论，框架版本与具体支持模式未冻结。

2026-11-12 [D13 决定](../../docs/decisions/D13-初版语言验证范围.md)将初版验证限定为 JS/TS 与 Python。Java、C#、C、C++ 整体延后；本目录已有 C# 局部实验按历史成果保留，不作为初版必需验证或已支持声明。

| 目录 | 当前实际状态 |
|---|---|
| [js-ts](js-ts/README.md) | Compiler API 局部符号/调用/坐标、组件实验与读取边界检查；提取/验证脚本及最新报告已交付 |
| [python](python/README.md) | 标准库 AST 与有限词法引用、动态未知和原始位置；提取/验证器、独立预期及报告已交付 |
| [csharp](csharp/README.md) | 历史局部实验：显式源码/元数据下 Roslyn 绑定、重载/缺引用/dynamic 与坐标；实际报告和独立检查已交付，项目加载未测；后续验证已延后 |
| [business-discovery](business-discovery/README.md) | 两领域合成源码自动生成入口/步骤/检查绑定；错误输出、源码变体及输入/输出边界检查，非完整业务或授权判定 |
| [contracts](contracts/README.md) | 0.2 草案的精确 FactRef、独立推导和最新请求发布世代参考模型；正反例及错误实现检测，非真实 worker/存储 |
| [project-loading](project-loading/README.md) | JS/TS、Python 静态完整工程输入、独立预期、错结果/过期报告拒绝；调用引用与运行目标分开，非框架或保留集验收 |
| [worker-runtime](worker-runtime/README.md) | 真实子进程协议/日志、批次/引用、取消/超时及 SQLite 发布/进程崩溃恢复；受控生产者与公共记录子集，非真实语言 worker 或完整协议 |
| [fact-mapping](fact-mapping/README.md) | 两语言纯实际报告到 EntityRef/FactRef、Evidence、静态 reference 与独立 Derivation 的字段映射及拒错核对；完整 schema、工程新鲜度及跨快照身份尚未通过 |
| [external-projects](external-projects/README.md) | 用户提供 platform-server 的 JS 服务/Python 侧车只读观察，六个预先选定源码锚点、无扩展名入口及读取/新鲜度核对；一个真实家族的有限抽查，不计完整项目准确率 |

2026-11-12 首批交付与当前 G1 缺口见[工程加载与进程恢复验证](../../docs/progress/G1-工程加载与进程恢复验证.md)。既有 JS/TS、Python 的扁平局部接口保留，新增项目加载入口及开发回归见对应目录 README；公共支持范围及模式/预算未冻结。

工具和待安装环境见 [M1-04 本机环境盘点](../../docs/progress/M1-04-环境盘点.md)。本轮未安装或下载依赖；实测仅约束各实验声明范围，API 可调用不等于整个语义栈已可交付。源文件、脚本或配置改变后须重跑相应报告。

读取根、输入版本、探索工具版本和失败边界须明确登记。实验只读解析输入，不加载/执行被分析项目、不触发构建或下载。合成输入只说明待验证的通用模式，业务、角色、流程、路径和数值不固化为产品假设。

原始源码输入与独立预期分别保存；预期不能成为分析器输入。局部语法/绑定实验、真实语义工具链输出、worker 协议验证及产品验收分别报告，不能相互替代。

依据：[实验与状态入口](../../docs/progress/M1-任务清单.md)、[事实/worker 契约](../../docs/contracts/README.md)、[语言与输入覆盖](../../docs/capabilities/M1-语言框架与输入覆盖清单.md)、[待决策清单](../../docs/decisions/M1-待决策清单.md)。子目录随实际交付创建，命令在运行核对后登记。
