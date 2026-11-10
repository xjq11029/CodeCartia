# M1-04 JS/TS 逐类实验规格

日期：2026-11-10。以下是隔离可行性实验，不选择产品依赖版本，不删除首版目标，不代表深度分析、HTTP 分发或 worker 协议通过。

## 输入、真值和工具边界

`inputs/` 是最小原始源码与静态 JSON；`expected/` 是由输入语义独立编写的正反例判据，只有验证器可读。提取器只接收登记的源码根、JSON 配置、候选 TypeScript 库及其内置类型定义根。它既不按文件名/函数名猜目标，也不读取 expected 后填事实。外部库保留绝对路径、版本来源和指纹，不复制依赖，不运行输入代码。

TypeScript 原生位置是 UTF-16 字符串单元、零基、右开范围。原始字节必须从未改换行、未 Unicode 归一化的 UTF-8 文件转换；列按 Unicode 码点、从 1 开始，CRLF 视为一次换行。补充验证 BOM 和无效 UTF-8，失败时诊断，不提供伪精确映射。范围身份仅在本次不可变输入内有效：局部 ID 使用文件与原生声明锚点，不宣称实现移动/重命名稳定身份。

## 逐类规格

| ID / 追踪 | 最小原始输入 | 独立预期与负例 | 本轮可执行范围 / 后续缺口 |
|---|---|---|---|
| J01 / LC01 | `semantic/esm.js` 导入 JS 跨文件别名；`js-helper.js` 声明 | 原生别名符号解析到实际声明；同名局部声明不能合并；不运行 ESM | TypeScript `allowJs/checkJs` 的局部绑定；CommonJS、DOM、fetch/XHR/WebSocket 与部署环境后续独立补测 |
| T01 / LC02、C1/C4 | `semantic/entry.ts` → `wrapper.ts` → `transport.ts`；`tsconfig.json` 含静态 paths 别名 | 两个入口调用同一包装器时保留各自调用点、字面量实参和形参配对；两个同名局部函数解析到不同声明。不能把入口 A 的实参配到 B，不能声称已把包装器下游形参按入口展开成请求 URL | 原生 Compiler API 符号与签名绑定；多层摘要实例传播和 HTTP 目标匹配尚未实现 |
| T02 / LC02、G05 | `overload.ts` 与 `entry.ts`：重载和条件函数联合类型 | 原生合法重载选择保留签名声明；联合类型保留各类型签名声明候选，不把第一条恢复签名当运行目标；错误实参不确认 | 只处理有可见声明的普通函数、变量箭头函数签名；接口/继承/泛型实例/闭包/动态属性后续补测 |
| T03 / LC02、G08、C5 | `missing.ts` 导入未提供模块，错误调用，`entry.ts` 中未知动态函数 | 原生诊断保留范围与缺输入；恢复签名、any、不可见目标不得确认；输入根禁止越界 | 实际缺模块与错误诊断；失败查询登记为局部观察，未实现产品依赖图/恢复/增量 |
| T04 / LC02、G03 | `coordinates.ts` 含中文、补充平面字符与 CRLF | 选定 `x` 的真实原生位置换算到原始字节及码点列；BOM不占可见列；码点/CRLF内部端点拒绝伪映射 | 单文件原始位置实验；Vue虚拟片段、生成映射及非UTF-8编码后续补测 |
| X01 / LC03 | `components/Widget.tsx`、`page.tsx` 和本地 `jsx.d.ts`；`plain.jsx` | JSX/TSX 标签标识符实际引用 Widget 声明，props 中回调表达式保留原生符号；不把模块 import 自动当组件渲染 | Compiler API 标签符号与语法片段；本地 JSX 类型只是隔离输入，未加载 React，不验证 React 渲染/Hooks |
| V01 / LC06、LC15–17 | `vue/Panel.vue`、`Child.vue` 和静态登记 JSON | 对应真实版本 SFC 编译器须报告 script/template 到原始输入的映射；动态 `:is` 不确认为唯一组件，未注册对象不补造绑定 | 本轮规格/输入；没有对应 SFC 工具链前不提取 `.vue`，Vue2/3、Options/script setup、Router/Pinia/Vuex 均待版本和工具核对 |
| R01 / LC07、LC18 | `react/Page.tsx`、`Card.tsx`、`router.json` | 实际框架依赖/类型提供后核对 props/回调、Hooks 条件与路由绑定；import、组件渲染、页面入口分别保存；动态路由未知 | 本轮规格/输入；不将 X01 计为 React 分项通过，函数/类组件和 React Router 待后续 |
| N01 / LC08、LC19–21、H1/H5/H6 | `node/server.mjs` 按明确源码顺序登记两个同地址处理器，`registration.json` 记录原始入口 | 原生模块事实可局部核对；真实框架版本语义确认后，地址候选与有序可达路径分开；只换顺序需重算；缺挂载/分发依据不能确认授权 | 本轮规格/输入；未安装 Express/Fastify/Nest，源码注册存在不代表真实处理链已经验过 |
| NX01 / LC09 | `next/app/page.tsx`、`client.tsx`、`actions.ts`、`api/route.ts`；静态环境登记 JSON | 对应 Next 版本核对 Server/Client、Actions 和 route handler；不能给 Server Action 编造普通 HTTP 地址，不能由模块相连推出跨环境调用完整 | 本轮规格/输入；App/Pages、Server/Client/Actions 各自待真实版本/输入，TSAPI不承担框架约定证明 |
| H01 / LC04–05 | `html/index.html` 引用外部和内联脚本，静态 JSON 别名/注册清单 | HTML 脚本真实位置与外部路径单独保存；内联映射失败诊断；JSON 不执行；JS 配置绝不 require 求值 | 本轮规格/输入；HTML/配置适配与展示只读边界后续补测 |

## 实际实验和判据

只有原生 TypeScript `createProgram/getTypeChecker/getSymbolAtLocation/getAliasedSymbol/getResolvedSignature/getPreEmitDiagnostics` 的实际结果才计为局部语义实验。每项报告要列输入 SHA-256/字节数/编码、工具版本/路径/来源、配置和脚本指纹、实际命令、耗时及可取得资源观察、预期检查、事实/诊断、失败与未覆盖范围。

映射仅核对 M1-02 的 SourceSpan、符号、静态调用候选、局部 InvocationBinding 和 Completeness 的子集：不使用完整 `schemaVersion` 声称兼容，不实现公共实体身份登记、来源闭包或主题全部必需字段，也没有 worker 握手、批次、取消/恢复、持久化或产品发布。

调用候选来自 Compiler API 中被调用表达式的实际符号/类型签名声明。重载恢复签名仅保存为原生观察，诊断影响的调用不可 confirmed。联合函数类型若有两个实际声明则 `candidateSet`；无可见声明、`any/unknown`、缺类型输入保持 `unknown`。普通调用的语法实参和被选签名的形参可成对保存，但不证明运行发生、不展开另一调用上下文。示例输入里的名称、URL 和数字不进入通用提取规则。

预算只作为本实验显式传入的节点上限故障注入：达到上限应记录访问量、截断位置、剩余范围和 `complete=false`；不把该数值当 D04/D08 产品预算。只执行独立验证器与可信实验脚本，不执行 fixtures。必要工具不可用时记录 `blocked` 并继续规格准备，不自动下载安装。

2026-11-10 执行补充：`pnpm test` 已完成登记子集的 100 项检查；独立调用清单同时限制遗漏、额外调用和额外/遗漏候选。`boundary/` 的越界导入、输入脚本及编译器插件哨兵验证当前提取器的拒绝/不执行策略，输出路径拒绝覆盖 `expected/`。当前只解析显式 `files` JSON，不加载真实构建项目；这些检查不关闭真实项目加载风险。具体实测产物和限制见本目录 README。
