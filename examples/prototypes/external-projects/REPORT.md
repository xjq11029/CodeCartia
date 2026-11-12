# platform-server 真实工程只读观察结果

日期：2026-11-12；范围：一个用户提供的真实项目家族中的 JS 服务与 Python 侧车。结果来自既有静态分析 API，不运行外部模块、服务、目标测试、安装脚本或构建。

## 输入与实际执行

JS 分析根为 `D:/Server-side/platform-server`；Python 分析根为 `inference-sidecar`。此前按源码独立冻结了[六个短锚点](expected/platform-server.json)，另由独立复核者直接读取原始字节与语法树核对范围；所有预期均未从提取结果反推。这是少量开发核对，不能作为完整项目真值或隔离保留集。

根缺 tsconfig/jsconfig，侧车缺 pyproject。分析保留缺元数据诊断；未向目标工程添加配置。Express `~4.16.0`、FastAPI `>=0.110` 等只是 package/requirements 中的声明范围，不代表已安装版本或本轮通过的框架版本。实际分析工具为 Node 24.11.0、TypeScript Compiler API 6.0.3 与 Python 3.14.2，完整指纹见机器报告。

在本目录执行 `python -B verify.py` 与 `python -B verify.py --check-existing` 均通过。原始 API 报告、审计账本、输入快照、实现/工具和预期分别绑定摘要；检查已有结果时核对原始报告及审计/快照字节，不能只凭仍能匹配六个锚点而接受被改动的报告。

## 记录数量与局部核对

| 观察项 | JS/TS | Python |
|---|---|---|
| 源码输入 | 115 | 2 |
| 其他分析输入 | 1 份 package 元数据、63 份编译器内置类型 | 无项目配置；requirements 由观察器单独记录 |
| 声明记录 | 2110（含静态签名目标声明） | 11 |
| 调用记录 | 4380 | 147 |
| 静态引用确认 / 未解析 | 2042 / 2338 | 7 / 140 |
| 诊断记录 | 1783 | 167 |
| complete / 资源截断 | false / 无 | false / 无 |

六个手选锚点全部符合：两个真实声明、两个可证静态引用、两个必须保持未知的调用。333/333 检查还包含输入摘要、原始位置、技术入口及新鲜度；不能把这些次数当作语义样本量或正确率。JS confirmed 只表示静态签名引用，Python confirmed 只表示词法声明引用；所有运行目标和执行可达性仍未知。

首次观察发现无扩展名 `bin/www` 没有进入 JS 自动发现。按实际 package 元数据及 `#!/usr/bin/env node`，通过通用 `additionalEntryFiles=[{path:"bin/www",language:"javascript"}]` 显式登记。最终该文件以原始 SHA-256、JavaScript ScriptKind 进入 Program，产生 18 个声明记录和 30 个调用记录；独立指定的 normalizePort 声明 `[1710,1924)` 与调用 `[378,419)` 范围均匹配。这是技术输入覆盖检查，不增加六个语义样本，也不证明入口中的 HTTP/WS 分发正确。

## 读取与输入变化

JS 桥接记录 116 个项目静态读取路径（115 个源码＋1 个元数据），Python 记录 2 个；逐项与项目内 inputManifest 对齐，编译器内置类型另行登记。没有 `.env`、模型/DLL、数据库、媒体或日志内容进入读取清单；明确运行目录由桥接发现策略排除。拒绝的禁读、目标写入、对应模块加载/执行尝试均为零。

JS 的执行审计明确限于目标根的 CommonJS `Module._load` 防护，Python 使用目标源码 exec 审计；这不是对任意原生程序行为的完整操作系统审计。目标代码只交给可信解析/Compiler API，不调用其业务函数或启动命令。

前后哈希与 mtime 比较覆盖 174 个允许读取的静态源码、配置、README 和依赖声明文件，未发现内容、增删或 mtime 变化。node_modules 和运行数据不在这个全树比较范围，不为证明只读而读取它们；实际捕获的工具/语义输入另核对摘要。不将此结果解释为原子文件系统快照或对并发路径替换的完整防护。

## 仍未覆盖的语义

- JS 缺项目配置和完整 Node/第三方类型上下文；大量原生类型/模块诊断保留。CommonJS `require()` 调用存在于 calls，但尚未生成专门的导入事实；`imports=[]` 或 `missingInputs=[]` 不代表项目没有依赖或依赖齐备。
- Python 的 missingInputs 包含 pyproject 及未登记的 FastAPI、numpy、cv2 等分析输入；标准库模块也不会通过查询本机安装环境自动取得。装饰器、推导式、属性/动态调用和一般数据流继续保留限制。
- Express/FastAPI 路由注册及可达 HTTP 链、异步调度、koffi/SDK 的 FFI、模型推理、跨服务身份、业务步骤和授权判定均未验收。

本批增加真实工程读取与少量静态事实证据，不关闭完整 M1-04/07/10、框架深度或 G1。完整结果：[verification.json](reports/verification.json)、[读取审计](reports/access-audit.json)、[输入快照](reports/input-snapshots.json)及 [JS](reports/raw/js-ts.json)／[Python](reports/raw/python.json) 原始报告。
