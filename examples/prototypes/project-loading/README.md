# JS/TS 与 Python 完整工程加载实验

本目录是 G1 推进中的 M1-04/06 公开开发实验，验证静态工程配置、源码发现、跨文件引用、原始位置和只读边界。这里的工程是独立预期作者创建的合成完整工程，不是外部真实工程、保留测试集或产品验收。

先阅读 [SPEC.md](SPEC.md)。fixtures/js 与 fixtures/python 是分析输入；expected 是独立预期，只允许评估器读取。提取器分别由相邻 js-ts/project-extract.mjs 和 python/project_extract.py 提供。源码、配置、backend、安装脚本和应用均不得执行。

本批输入与预期先于各自提取结果建立。2026-11-12 已实际执行 11 个用例，全部通过；159 个故意损坏的报告和 33 个失效报告头均被拒绝。原始输入树未变化，执行哨兵均未产生。完整结果见 [REPORT.md](REPORT.md) 与 [机器报告](reports/verification.json)。这些数字是本目录的检查数量，不是准确率或 G1 完成率。

统一报告是 project-loading-v0.1 局部交换结构，不是完整 0.2-draft 公共 schema；两个语言均不能凭本实验声称运行目标、业务授权或全部框架语义已确认。JS/TS 的 complete 只表示配置范围内的输入及事实捕获完成，targetResolutionComplete 与 unresolvedCalls 另报；Python 保留未覆盖语义，complete=false。二者原始语义不能被一个总布尔值替代。

| 位置 | 用途 |
|---|---|
| [SPEC.md](SPEC.md) | 请求、报告、正反例和评估边界 |
| fixtures/js | 静态项目引用、别名、排除项及失败输入 |
| fixtures/python | 静态 src-layout、相对导入、再导出及失败输入 |
| [expected/cases.json](expected/cases.json) | 根据源码独立编写的目标与证据锚点 |
| [verify.py](verify.py) | 独立原始位置、目标、输入清单、拒错和报告新鲜度检查 |
| [node_bridge.mjs](node_bridge.mjs)、[python_bridge.py](python_bridge.py) | 只调用本仓库受信任提取器的子进程入口；不加载目标项目 |
| reports | 各例实际输出、输入与实现指纹、拒错明细及汇总 |
| reports/raw | 纯提取器输出；不含 expected、评估 verdict 或评估器指纹，供公共契约映射读取 |

已验证命令，均在仓库根目录执行：

    python -B examples/prototypes/project-loading/verify.py
    python -B examples/prototypes/project-loading/verify.py --check-existing

第一条重建实际输出并验证，第二条核对既有报告的输入树、实现/规格、工具链和原始证据。改变提取器、桥接脚本、预期或 SPEC 后，旧报告会被拒绝，须重新运行。报告只写本目录 reports，现存符号链接、目录 junction 与非普通文件被拒绝；普通目标采用新文件原子替换，避免原位写穿硬链接。不声称消除了所有平台的并发路径替换竞争。

目录内 11 个例子包括每语言的正常工程、缺依赖、动态配置、顶层副作用，以及 JS any 类型、Python 后置局部重绑定和动态命名空间写入。只读项目加载验证与相邻语言目录的链接/预算/CLI 边界回归分别记录；外部真实项目观察仍须单独登记输入、限制与核对依据。

首版范围依据 [D13](../../../docs/decisions/D13-初版语言验证范围.md)，阶段状态见 [M1 任务清单](../../../docs/progress/M1-任务清单.md)。
