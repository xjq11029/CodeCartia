# 完整工程加载实验实际报告

日期：2026-11-12；规格：project-loading-v0.1；独立预期：project-loading-expected-v0.1。

## 本次结果

在 Windows、现有 TypeScript Compiler API 6.0.3、Python 3.14.2 环境下，11 个公开合成完整工程用例通过。159 个错误报告变异被拒绝；每例另核对 3 类失效头（输入树指纹、输入账本、实现/规格指纹），共 33 项均被拒绝。实际原始输出、输入树、实现指纹、用例耗时与详细拒绝原因保存于 reports，汇总见 [verification.json](reports/verification.json)。

| 用例 | 核对的实际行为 | 语法调用 / 已确认静态引用 | 错误报告拒绝 |
|---|---|---:|---:|
| js-positive | 读取 7 个项目输入及声明的内置类型；extends/include/exclude/references、路径别名与 barrel 后的目标声明正确 | 1 / 1 | 15 |
| js-missing | 缺失外部依赖，保留调用位置、未解析目标及诊断 | 1 / 0 | 16 |
| js-dynamic | 动态配置按明确诊断拒绝，不加载其中的模块 | 0 / 0 | 7 |
| js-side-effect | 源码只解析；包的安装/构建脚本未触发 | 1 / 0 | 15 |
| python-positive | pyproject 静态 src-layout、包内相对导入和再导出映射到正确函数 | 1 / 1 | 15 |
| python-missing | 不查询或安装缺失依赖；目标未知有诊断 | 1 / 0 | 15 |
| python-dynamic | 动态 version attr 不求值，backend/setup.py 不执行 | 3 / 0 | 14 |
| python-side-effect | 顶层 Path 写入表达式只作为语法记录，未产生文件 | 3 / 0 | 14 |
| js-unknown-type | any 类型调用不猜测同签名函数为目标 | 1 / 0 | 13 |
| python-late-rebinding | 后置局部赋值阻止错误外层绑定；另一函数的合法局部导入仍正确 | 2 / 1 | 17 |
| python-binding-boundaries | 推导式 walrus、global 定义、nonlocal 导入及模块字典写入后的内外引用均保留未知；未污染函数仍正确 | 6 / 1 | 18 |

JS/TS 的 confirmed 是静态签名引用，Python 的 confirmed 是有限词法声明引用；上述数量不表示这些调用已执行。JS 的 complete=true 也不证明所有目标已解析：unknown-type 用例仍含一个 unresolved 调用，targetResolutionComplete=false；Python 保守保留运行、类型、框架和一般数据流未覆盖状态。

## 独立检查依据

expected/cases.json 按输入源码单独编写，提取器不以该文件为输入。评估器使用源代码字节锚点计算期望位置，逐项核对调用及目标完整声明、Unicode 码点列、文件内容指纹和必要输入；跨文件路径和同文件另一函数不能互换。它拒绝空输出、漏调用、额外非调用事实、重复记录、错编译配置、错误目标、字节/列偏移、运行目标升级、未知升级及删除不完整原因。

所有用例的分析前后输入树完全相同，动态配置、源模块、构建 backend 和安装脚本的 EXECUTED_* 标记均未出现。Python setup.py 可作为 metadata 保存原始字节以解释构建边界，但没有作为 src 源码产生事实；此边界澄清记录于 SPEC，不改变语义预期。

报告绑定当前 SPEC、独立预期、评估器、桥接入口、语言实现和原始输入。--check-existing 还核对当前 Python/TypeScript 版本、工具模块字节和原始证据，拒绝旧输入或旧实现的报告。各语言的链接、预算和 CLI 写入边界报告单独管理，不把它们并入本表的语义用例数量。

纯实际输出另存 reports/raw，仅包含桥接进程返回的自动事实与工具/输入信息，不含预期、评估结果或评估器指纹。公共契约映射消费纯实际输出；独立评估 wrapper 留在评估侧。新鲜度检查同时核对纯输出和已评估的 actual 一致，防止下游读取另一份未核对结果。

## 复现与仍未证明的事项

仓库根目录执行：

    python -B examples/prototypes/project-loading/verify.py
    python -B examples/prototypes/project-loading/verify.py --check-existing

这些是公开合成完整工程，不是独立项目家族保留集，也不是外部真实工程全面验证。真实框架行为、类型辅助、一般数据流、场景/授权判定、跨工程完整链路、全量公共 schema、目标平台和产品级性能/质量门槛仍需对应工作包。坐标核对不证明所有编码或生成源码映射已覆盖；路径保护不证明恶意并发替换在所有平台均安全。本次结果只推进 M1-04/06 的声明子集，G1 状态由主任务清单统一复核。
