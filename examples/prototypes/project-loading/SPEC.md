# 工程加载与独立核对规格

版本：project-loading-v0.1；日期：2026-11-12；状态：探索规格，不冻结框架、预算或产品门槛。

## 1. 输入与调用

JS/TS 入口为相邻 js-ts/project-extract.mjs 的 analyzeProject(request)；Python 入口为 python/project_extract.py 的 analyze_project(request)。request 包含 projectId、projectRoot、可选 configFile 和 limits。configFile 仅接受项目根内的相对路径；根和真实读取路径不得借助链接越界。默认配置分别为 tsconfig.json 与 pyproject.toml。

项目根不包含 expected。提取器不得读预期、评估器或历史报告，不执行目标源码、动态配置、backend、setup.py、安装脚本或构建。setup.py 等构建脚本可作为 metadata 捕获原始字节与诊断，但不可当作所选 src 根下的分析源码、产生调用事实或求值。工程配置不可静态取得时保留诊断；不退化为普通显式文件清单后宣称项目加载通过。

探索上限用于限制实验资源，并记录有效值、观察值和截断。它们不是 D04/D08 已冻结的产品预算。

## 2. 局部报告接口

- reportVersion 固定 project-loading-v0.1；language 为 js-ts 或 python；projectId 保留请求身份。
- toolchain 记录实际工具版本；inputManifest 逐项记录 path、kind、sha256、sizeBytes。项目内 path 使用相对路径与正斜杠；sha256 使用 sha256: 加原始字节摘要。TypeScript 内置类型可用 kind=toolchain 和受控工具链路径独立登记。
- declarations 包含 file、name、qualifiedName、kind、span；qualifiedName 使用适配器的词法限定命名，不能以简单同名代替身份。
- imports 包含 file、moduleSpecifier、resolution、targetFile（已解析时）、span；resolution 为 resolved 或 unresolved。
- calls 包含 file、callee、span、bindingKind、resolution、target、runtimeTargetMode。resolution 为 confirmed 或 unresolved；未解析 target 为 null。JS/TS 的 bindingKind 为 static-signature-reference，Python 为 lexical-declaration-reference；runtimeTargetMode 始终为 unknown。这里的 confirmed 只确认对应静态引用语义，不确认执行。
- target 包含 file、qualifiedName、span；span 必须指向该实际目标的完整声明，不可替换为同文件另一函数或仅复用文件指纹。
- diagnostics 包含 code、可选 file、message；completeness 包含 complete、missingInputs、unsupportedModes、truncations。正例允许保留明确未支持模式而 complete=false；缺依赖、动态配置或截断不得为完整结果。

span 为原始字节范围 startByte/endByte（零基左闭右开），以及 startLine/startColumn/endLine/endColumn（一基、码点列）。CRLF 是一个换行，BOM 占字节但不占第一列。完整调用表达式和函数声明必须与独立源码锚点一致；可额外保存工具原生位置。同文件在不同项目编译配置下的记录须有 configFile 等上下文，不以去重合并编译条件。

此结构用于核对跨语言事实与后续公共契约映射，不代表已实现全部 FactRef、派生、身份连续性、统一图或 worker 协议。

## 3. 独立用例

| ID | 输入与唯一重点 | 独立预期 |
|---|---|---|
| js-positive | package 元数据、tsconfig extends/include/exclude/references、paths 别名及 barrel 再导出 | main 的 describe(value) 指向 core/labels.ts 的 formatLabel；被排除文件不读取、不出事实；登记实际配置/源码 |
| js-missing | bare import 指向缺失依赖 | 保留调用及精确证据，target=null、明确缺依赖诊断和不完整性 |
| js-dynamic | 显式选择 project.config.mjs | DYNAMIC_CONFIG_UNSUPPORTED；不求值，不产生 EXECUTED_CONFIG |
| js-side-effect | package scripts、源模块和 hook 含文件写入哨兵 | 只解析配置/源码，模块/构建标记均不产生；保留语法事实及外部依赖未知 |
| python-positive | pyproject 静态 src-layout、包内相对导入、__init__ 再导出 | service 的 describe(value) 引用 core.py 的 render_label；原始声明范围和输入指纹一致 |
| python-missing | 包中导入未提供依赖 | MODULE_INPUT_MISSING；调用 unresolved、target=null，保留精确位置 |
| python-dynamic | pyproject dynamic version attr、local backend 和 setup.py | DYNAMIC_PROJECT_CONFIG；不导入模块/求值动态属性/运行 backend，全部标记缺席 |
| python-side-effect | 静态配置、源码顶层文件写入、构建哨兵 | 读取并分析真实语法结构，模块/backend/setup 标记均不产生 |
| js-unknown-type | 调用对象类型为 any，另有同签名候选声明 | 不能挑选 candidate 冒充确定目标，保留 unresolved |
| python-late-rebinding | 调用之后才出现同名局部赋值；另一个函数含合法局部导入 | 后置局部绑定阻止错误的外层目标确认；独立局部导入仍指向有据声明 |
| python-binding-boundaries | 推导式 walrus、global 定义、nonlocal 导入、模块 __dict__ 写入及未污染函数 | 受影响的四个目标未知；未污染的 stable 引用仍正确，不能以全部降级通过 |

两种语言正例至少核对正常跨文件目标、同文件另一个函数不能替代、Unicode 原始坐标。失败输入与正常输入分别统计。完整工程结构仍是公开合成开发验证；外部项目观察、框架原生语义、独立家族泛化与最终质量分数分别报告。

## 4. 评估与拒错

expected/cases.json 在实际提取前根据输入源码编写。评估器独立从锚点在原始字节中计算范围、读取实际输入指纹，并核对声明、导入、调用目标与未知状态。错目标、遗漏调用、额外调用、改坐标、改输入指纹、未知升级或删除不完整原因必须失败。空结果不能通过。

接口复核时澄清了构建脚本边界：原先输入清单将 setup.py/backend 一概禁止读取，现改为禁止纳入 source；允许原始字节作为元数据。该修改依据只读约束本身，不改变调用目标、源码锚点或未知结果预期，也不放宽禁止执行的要求。

评估器同时核对提取前后的输入树与执行标记。报告只能写入本目录 reports；不得覆盖输入、预期、提取器或链接目标。报告须绑定 SPEC、expected、评估器、提取器和输入指纹。纯实际输出另存 reports/raw，不含独立预期、评估结论或评估器指纹；后续公共契约映射只读取纯实际输出与登记源码，评估侧保存的 expected 不进入自动来源链。公开预期可见，不自称保留集。运行命令只有实际执行成功后才记为已验证。
