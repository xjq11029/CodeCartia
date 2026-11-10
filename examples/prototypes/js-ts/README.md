# JS/TS 与前端、全栈局部实验

本目录承载 M1-04 的局部 JS/TS 实验。2026-11-10 已用本机 TypeScript Compiler API 6.0.3、Node 24.11.0 实际提取并验证：134/134 检查通过，包括 15 种被故意破坏的报告必须被验证器拒绝。这是静态符号、调用签名和坐标子集的实验结果，不代表语言深度、框架、worker 或完整公共 schema 通过；产品版本、支持范围及预算均未冻结。

原始源码和静态配置保存于 `inputs/`，独立预期保存于 `expected/`，提取器不得读取预期。Vue、React、Node.js、Next.js 的独立框架行为不能由 TypeScript 基础符号实验推断通过。任何 `.js/.ts/.jsx/.tsx/.vue` 输入均只作为文本读取，不执行模块、配置脚本、构建或应用。

| 文件或目录 | 实际用途 |
|---|---|
| [SPEC.md](SPEC.md)、`inputs/`、`expected/checks.json` | 输入规格与独立判据；保留局部语义、JSX、BOM/CRLF、无效 UTF-8、读取边界与执行哨兵 |
| [extract.mjs](extract.mjs) | 只读登记源码与内置类型根，保存 Compiler API 实际事实、诊断、失败查询及指纹 |
| [run.mjs](run.mjs)、[verify.mjs](verify.mjs) | 重新提取五份报告，独立核验、报告新鲜度检查和拒错测试 |
| [io-policy.mjs](io-policy.mjs) | 提取器、运行器和验证器共用的报告写入边界；拒绝最终路径及父目录符号链接/目录 junction，其指纹进入报告 |
| [toolchain.windows-observed.json](toolchain.windows-observed.json) | 本机已装工具的显式路径与观察版本；未安装项目依赖，不是发布选型 |
| [验证报告](reports/verification.json)、[边界策略报告](reports/boundary-policy.json) | 当前检查结果、预期/验证器/事实报告指纹；原始报告分别为 semantic、components、encoding、boundary、truncated |

已验证命令，均在本目录执行：

```powershell
pnpm test
pnpm extract --case semantic
pnpm verify
```

`pnpm test` 完整重建并验证；`pnpm verify` 只复核已有报告，源码、查询结果、提取器或工具改变后会拒绝旧报告。测试在同一个可信 Node 进程调用提取器，内存高水位属于该进程观察，不是独立 worker 峰值或产品性能验收。

提取器仅接受静态 JSON 的显式 `files`，不展开 `include`、`extends` 或项目引用；框架输入继续保持规格状态。输入插件和执行哨兵不被加载，越出当前样例根的导入被拒绝，报告只能写在 `reports/`，不能覆盖源码或预期。无效编码和节点预算截断均有明确不完整状态。BOM 样例含实际 BOM 和 CRLF，无效 UTF-8 样例含原始非法字节，不能由编辑器静默重编码。

拒错验证覆盖实参串线、同名目标/上下文合并、恢复签名被升级、UTF-16 冒充字节、漏调用、额外/遗漏候选与多余调用，并新增调用/目标声明字节越界、调用/签名证据指纹错误、调用列偏移及参数源码范围错误。逐项核对调用、声明、参数、签名及诊断证据与原始字节、UTF-16 和行列的一致性；调用表达式由独立预期直接声明，不从提取报告生成答案。

提取器与辅助报告写入口均使用同一输出边界，实际测试了最终路径和父目录 junction 拒绝，测试保护目标未变化。本机创建文件符号链接返回 `EPERM`，因此最终路径使用真实目录 junction 验证同一重解析点拒绝逻辑；[边界报告](reports/boundary-policy.json)明确记录此替代，**文件符号链接创建用例未实际完成**。未验证恶意并发替换文件系统路径的竞争情形。

`components.complete=true` 仅表示登记 JSX 局部扫描无编译诊断，不表示 React/Vue 框架通过。多层数据流、HTTP 分发、业务/授权、模板映射、完整项目加载、产品协议与增量恢复仍未验证；本实验的拒绝策略不能替代真实项目加载安全验证。

依据：[统一契约](../../../docs/contracts/README.md)、[语言与输入覆盖](../../../docs/capabilities/M1-语言框架与输入覆盖清单.md)、[M1 任务](../../../docs/progress/M1-任务清单.md)。
