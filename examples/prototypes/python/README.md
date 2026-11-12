# Python AST 与工程加载局部实验

本目录为 M1-04 的隔离实验。2026-11-10 已用本机 Python 3.14.2 标准库 `ast` 完成登记输入的提取与 131/131 检查，其中包含 8 种故意破坏报告的拒绝测试。预期与实现分开保存，额外独立快审发现的同文件目标证据互换问题已补回归；这仍是公开局部实验，不是产品分析器、完整统一 schema 或 worker 验收，不冻结 Python、类型辅助工具或框架版本。

实验只读取 `inputs.json` 登记的 `fixtures/` 原始源码，不导入或执行这些模块。源码与 `expected/` 预期分开；预期仅供验证器使用，不作为提取器输入。目录内实现采用通用的模块、函数、词法作用域与调用表达式，不固定任何业务模型。

2026-11-12 新增独立的 `project_extract.py` 工程加载切片：读取 `pyproject.toml` 的静态源码根、发现包与模块，核对包内相对导入及再导出。新开发回归已有 48/48 检查通过；独立工程输入、预期与评估器位于[工程加载实验](../project-loading/README.md)，与这里的实现回归分别报告。原 `extract.py`／`verify.py` 的扁平输入接口保持兼容，并复跑 131/131 通过。

句法事实、受限模式下的声明引用绑定与运行时调用目标分别记录。缺输入、赋值重绑、动态属性、猴子补丁、装饰器和未验证类型信息保留未知或边界诊断。AST 扫描完整不等于 Python 深度分析、类型辅助、框架分析或产品验收完成。

| 文件 | 实际用途 |
|---|---|
| [extract.py](extract.py)、[inputs.json](inputs.json) | 只读静态登记的扁平模块，生成 AST 调用、受限词法声明引用、坐标和诊断；不查系统导入路径 |
| [expected/cases.json](expected/cases.json)、[verify.py](verify.py) | 独立预期、手工核对的调用数、字节/码点坐标、拒错和读取边界检查 |
| [实际报告](reports/actual.json)、[验证报告](reports/verification.json) | 22 个语法调用记录、16 个诊断及工具/输入/脚本指纹和实际检查结果；`boundary-inputs.json` 是拒绝测试清单 |
| [project_extract.py](project_extract.py) | `analyze_project(request)` 与 CLI：静态项目配置、src-layout、包发现、相对导入／再导出和跨文件词法声明证据；返回 `project-loading-v0.1` 局部报告 |
| [project_verify.py](project_verify.py)、[工程加载开发回归](reports/project-verification.json) | 在临时合成工程上检查重绑定／装饰器未知、动态元数据、坐标、预算和读取／输出拒绝；不读取独立预期，不作为独立质量成绩 |
| [工程正例报告](reports/project-positive.json) | 4 个实际输入、1 条经包再导出的词法调用，目标为原始 `core.py` 函数声明；运行目标仍未知 |

已验证命令，均在本目录执行：

```powershell
python verify.py
python extract.py
```

`verify.py` 先重新提取，再读取独立预期。验证覆盖跨文件别名/再导出、参数遮蔽、赋值前后的局部重绑、模块属性修改、同名嵌套函数、装饰器边界、缺输入、语法错误和中文/补充平面字符/CRLF 坐标。目标证据须匹配预期限定名在原始 AST 中的完整声明范围、原生位置、原始字节和指纹；换成同文件另一函数或将声明范围移出源码也会被拒绝。错目标、漏调用、多余调用、字节偏移错误、同名作用域合并及未知升级均被拒绝；预期没有传给提取器。

原扁平实验报告中的 `confirmed` 仅表示受限模式内的**词法声明引用**，运行目标、执行可达性、类型与框架语义均未确认。例如在模块顶层异常之后定义的函数仍可作为句法声明记录，不能据此声称会执行。类、lambda、推导式、相对/动态导入、一般数据流及环境/打包加载不在原扁平实验闭环内；新工程加载切片只扩展下述已声明的静态模式。

执行哨兵 `fixtures/side_effect/entry.py` 仅被解析；构建配置 `pyproject.toml` 被源码类型校验拒绝，其 backend 未导入，两个执行标记均未产生。越界路径、非源码根和报告覆盖预期也被拒绝。提取器与验证器的报告写入都检查最终路径及父目录的链接；Windows 原生目录 junction 指向临时哨兵的拒绝测试通过，哨兵未被覆盖。这是当前只读/拒绝策略验证，不能替代真实 Python 构建环境或 MSBuild/JDT 工程加载风险验证；没有安装依赖、导入目标模块或执行目标项目。

## 静态工程加载切片

请求为 `{projectId, projectRoot, configFile?, limits?}`，API 的 `projectRoot` 必须是绝对路径，`configFile` 是项目内相对路径，默认 `pyproject.toml`；CLI 可以将相对工程根规范为绝对路径。已验证命令均在本目录执行：

```powershell
python -B project_verify.py
python -B project_extract.py --project-root ../project-loading/fixtures/python/positive --project-id python-positive --output reports/project-positive.json
```

当前使用 Python 3.14.2 的标准库 `ast`／`tomllib`。读取静态 setuptools `package-dir[""]`、`packages.find.where/include/exclude/namespaces`；无显式源码根时登记常规 `src/` 或工程根发现方式。普通包内绝对／相对导入、模块别名、有限再导出及嵌套函数的词法声明可以形成精确引用。输入清单记录实际捕获的原始字节摘要和长度，AST 与坐标均来自同一次字节捕获；UTF-8/BOM、CRLF 与 Unicode 码点列有回归检查。

动态版本属性、`setup.py`／`setup.cfg` 仅作未求值元数据，构建 backend 不导入；外部依赖（含未登记的标准库模块）只表示“缺少分析输入”，不检查机器上是否已安装，不运行安装／构建脚本。赋值重绑定、装饰器、条件声明、模块属性写入、动态命名空间、星号导入等保留未知。推导式海象赋值影响包含作用域，lambda 默认值与函数体分别处理；`global`／`nonlocal` 后的函数定义、导入等绑定会使对应共享名称失效。模块 `__dict__` 的直接下标写入／删除按键保留未知，非字面量键保守影响该模块全部导出；这些有限语法保护不构成一般别名或数据流分析。命名包目录重映射、显式 package 列表、namespace 包的无文件导入身份、类／lambda／推导式完整作用域、一般数据流、框架和运行目标尚未完成；局部 `confirmed` 不改变这些边界，`completeness.complete` 始终为 `false`。

有效探索限额记录于每份报告：最多读取 512 个配置／元数据／源码输入、单文件 2 MiB、累计 16 MiB、4096 个目录、单源码 100000 个 AST 节点、32 层导入引用。报告同时记录观察值和 `budgetSemantics`；节点限额在源码解析后、事实提取前检查，不是解析器 CPU／内存硬上限。超限产生诊断和截断，不以部分结果冒充完整分析。这些数值仅控制本实验，不是冻结的产品性能预算。

分析 API 不写目标工程；CLI 报告限于本目录 `reports/`，同时拒绝落在目标工程内、覆盖输入、路径越界、现存符号链接／目录 junction 及输出硬链接。开发回归中目录 junction 与硬链接拒绝已通过；Windows 创建文件符号链接缺少权限（WinError 1314），该项明确跳过，未计通过。并发替换路径、其他系统、真实虚拟环境／构建工具语义和完整工程深度分析仍待独立验证。

统一契约与 worker 边界见 [契约入口](../../../docs/contracts/README.md)，目标范围见 [语言清单](../../../docs/capabilities/M1-语言框架与输入覆盖清单.md)。
