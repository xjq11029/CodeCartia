# JS/TS 与前端、全栈局部实验

本目录承载 M1-04 的局部 JS/TS 实验。2026-11-10 已用本机 TypeScript Compiler API 6.0.3、Node 24.11.0 实际提取并验证：134/134 检查通过，包括 15 种被故意破坏的报告必须被验证器拒绝。这是静态符号、调用签名和坐标子集的实验结果，不代表语言深度、框架、worker 或完整公共 schema 通过；产品版本、支持范围及预算均未冻结。

2026-11-12 新增静态项目加载入口 `project-extract.mjs`：按真实 tsconfig 的 `include/exclude/extends/references`、模块/路径别名与每份配置的作用域取得输入，并保留跨文件静态签名及原始字节/码点坐标。独立作者先行建立的完整工程输入与评估入口见 [project-loading](../project-loading/README.md)；这些输入是公开合成开发工程。该入口输出 `project-loading-v0.1` 局部交换报告，仍不是完整公共 schema、真实 worker 或产品验收。

原始源码和静态配置保存于 `inputs/`，独立预期保存于 `expected/`，提取器不得读取预期。Vue、React、Node.js、Next.js 的独立框架行为不能由 TypeScript 基础符号实验推断通过。任何 `.js/.ts/.jsx/.tsx/.vue` 输入均只作为文本读取，不执行模块、配置脚本、构建或应用。

| 文件或目录 | 实际用途 |
|---|---|
| [SPEC.md](SPEC.md)、`inputs/`、`expected/checks.json` | 输入规格与独立判据；保留局部语义、JSX、BOM/CRLF、无效 UTF-8、读取边界与执行哨兵 |
| [extract.mjs](extract.mjs) | 只读登记源码与内置类型根，保存 Compiler API 实际事实、诊断、失败查询及指纹 |
| [run.mjs](run.mjs)、[verify.mjs](verify.mjs) | 重新提取五份报告，独立核验、报告新鲜度检查和拒错测试 |
| [io-policy.mjs](io-policy.mjs) | 提取器、运行器和验证器共用的报告写入边界；拒绝最终路径及父目录符号链接/目录 junction，其指纹进入报告 |
| [toolchain.windows-observed.json](toolchain.windows-observed.json) | 本机已装工具的显式路径与观察版本；未安装项目依赖，不是发布选型 |
| [验证报告](reports/verification.json)、[边界策略报告](reports/boundary-policy.json) | 当前检查结果、预期/验证器/事实报告指纹；原始报告分别为 semantic、components、encoding、boundary、truncated |
| [project-extract.mjs](project-extract.mjs) | `analyzeProject(request)` 静态项目加载与事实入口；`writeProjectReport` 与 CLI 共用报告写入边界；只加载登记的可信 TypeScript 库 |
| [project-boundary.test.mjs](project-boundary.test.mjs)、[项目边界报告](reports/project-boundary-verification.json) | 同源不同配置、越界/链接/覆盖拒绝、配置及读取/提取预算和坏编码回归；独立于中央语义评分 |
| [采购示例观察](reports/purchase-demo-project-observation.json) | 对可运行采购示例源码的只读静态观察；没有独立真值，不计为识别率或产品通过 |

已验证命令，均在本目录执行：

```powershell
pnpm test
pnpm extract --case semantic
pnpm verify
pnpm test:project
pnpm extract:project --project-root ../../purchase-demo --project-id purchase-demo-observation --output reports/purchase-demo-project-observation.json
```

`pnpm test` 完整重建并验证；`pnpm verify` 只复核已有报告，源码、查询结果、提取器或工具改变后会拒绝旧报告。测试在同一个可信 Node 进程调用提取器，内存高水位属于该进程观察，不是独立 worker 峰值或产品性能验收。

原 `extract.mjs` 仅接受静态 JSON 的显式 `files`，不展开 `include`、`extends` 或项目引用；旧实验与测试保持兼容，框架输入继续保持规格状态。输入插件和执行哨兵不被加载，越出当前样例根的导入被拒绝，报告只能写在 `reports/`，不能覆盖源码或预期。无效编码和节点预算截断均有明确不完整状态。BOM 样例含实际 BOM 和 CRLF，无效 UTF-8 样例含原始非法字节，不能由编辑器静默重编码。

新项目入口接受 `{projectId, projectRoot, configFile?, limits?, additionalEntryFiles?}`；`projectRoot` 必须为绝对目录，`configFile` 仅允许根内相对路径。默认读取 tsconfig/jsconfig；显式动态配置仅登记原始字节并诊断，不求值。无静态配置时，使用报告列明的探索默认扫描，并以 `CONFIG_INFERRED` 和不完整状态标记。每份引用配置分别建立 Compiler Program，同一文件在不同配置下的调用保留各自 `configFile`，不会合并别名和编译条件。报告登记规范根身份、原始输入指纹、工具/提取器指纹、配置和读取观察；公共字段的局部转换由相邻 [fact-mapping](../fact-mapping/README.md) 核对，本入口仍输出局部报告，身份连续性未实现。

无扩展名入口通过 API 的 `additionalEntryFiles: [{ path: "tools/launch", language: "javascript" }]` 显式登记。该选项只接受根内的无扩展名常规文件，拒绝越界/链接、其他语言或带任意扩展名的文件；原始字节仍须通过 UTF-8 与读取预算。存在 shebang 时仅接受本切片能确认的 Node 声明，不求值命令。登记可以来自项目元数据及原始 Node shebang，来源由调用方披露，不包含业务或调用目标答案。

补充入口仅加入本请求的主配置，通过 `ScriptKind.JS`、`allowJs` 和 `allowNonTsExtensions` 进入真实 Compiler Program；引用子项目不会被自动复制这些入口。报告的 `additionalEntryFiles` 保存原始登记、shebang 观察、输入指纹、所属配置、`programIncluded` 与 `nativeScriptKind`，manifest 另记显式 sourceKind。独立回归已核对其跨文件 import 和局部调用的真实声明、完整原始范围；其他未登记的无扩展名输入仍被拒绝。既有 CLI 参数保持原样，补充入口由 API 请求传入。

`calls.resolution=confirmed` 仅确认 `static-signature-reference`，`runtimeTargetMode` 始终为 `unknown`；类型恢复、`any/unknown`、受错误影响的调用及多签名联合候选不升级为唯一目标。项目根之外仅允许登记编译器同目录的内置 `lib*.d.ts`。链接依赖、动态配置、插件语义和未取得的类型输入保持拒绝或未知；没有执行模块、安装脚本、构建、插件、下载或 emit。读取按首次捕获的字节复用，后续元数据变化产生诊断；尚未保证对抗并发文件系统替换或取得原子文件系统快照。

`completeness.scope` 明确为 `static-project-loading-and-fact-capture`：完成输入发现和事实捕获后，含 `any` 的调用仍可保持未解析。调用目标的静态完整性由 `targetResolutionComplete` 与 `unresolvedCalls` 单独表达；上层映射不能仅由 `complete=true` 推断调用图、运行目标或业务语义完整。

`pnpm test:project` 本轮 29 项检查中 28 项通过，真实文件 symlink 因 `EPERM` 无法创建而跳过 1 项；实际目录 junction 的项目根、配置路径、导入源码、补充入口及报告父路径/最终路径均被拒绝，保护目标未变化。补充入口同时覆盖跨文件绑定、主配置隔离、未登记类型拒绝、非 Node shebang、坏编码与预算。交叉复核新增真实输出硬链接对照：共享 `io-policy.mjs` 拒绝现存多链接文件，CLI 共用入口和原报告入口均不能写穿硬链接，原始输入指纹保持不变。节点、文件数/大小/总字节、目录/条目/查询和项目引用上限均有显式不完整结果。节点上限约束 Compiler API 建立程序之后的事实遍历，不是类型检查的 CPU/内存硬上限或独立 worker 峰值；这些探索值不冻结 D04/D08 产品预算。

采购示例观察登记了 17 个源码文件、1 份 package 元数据及 63 份内置类型输入，保存 390 个静态调用记录与 137 项诊断；由于没有 tsconfig 和 Node 类型上下文，并保留其他原生诊断，`complete=false`。该观察没有执行示例，也没有独立目标真值；调用数量和静态绑定不能作为正确率、业务理解或框架通过证明。2026-11-12 重跑旧 `pnpm verify` 仍为 134/134 通过。

拒错验证覆盖实参串线、同名目标/上下文合并、恢复签名被升级、UTF-16 冒充字节、漏调用、额外/遗漏候选与多余调用，并新增调用/目标声明字节越界、调用/签名证据指纹错误、调用列偏移及参数源码范围错误。逐项核对调用、声明、参数、签名及诊断证据与原始字节、UTF-16 和行列的一致性；调用表达式由独立预期直接声明，不从提取报告生成答案。

提取器与辅助报告写入口均使用同一输出边界，实际测试了最终路径和父目录 junction 拒绝，测试保护目标未变化。本机创建文件符号链接返回 `EPERM`，因此最终路径使用真实目录 junction 验证同一重解析点拒绝逻辑；[边界报告](reports/boundary-policy.json)明确记录此替代，**文件符号链接创建用例未实际完成**。未验证恶意并发替换文件系统路径的竞争情形。

`components.complete=true` 仅表示登记 JSX 局部扫描无编译诊断，不表示 React/Vue 框架通过。新入口只补齐已声明的静态项目加载切片；框架/包管理器全部输入、外部独立工程、跨平台及并发读取风险仍需后续验证。多层数据流、HTTP 分发、业务/授权、模板映射、产品协议与增量恢复尚未通过；本目录结果不关闭整个 M1-04/08 或 G1。

`imports` 目前登记 ES module 的 import/re-export 等已实现语法形式，尚未生成 CommonJS `require/module.exports` 的模块依赖关系。CommonJS 工程的 `imports=[]` 表示该事实类型未覆盖，不能解释为没有依赖；其调用仍按静态签名观察记录，HTTP/Express 等框架语义不由本入口确认。

依据：[统一契约](../../../docs/contracts/README.md)、[语言与输入覆盖](../../../docs/capabilities/M1-语言框架与输入覆盖清单.md)、[M1 任务](../../../docs/progress/M1-任务清单.md)。
