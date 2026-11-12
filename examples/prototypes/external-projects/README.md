# 真实工程只读观察

本目录登记用户提供的本机工程 `D:/Server-side/platform-server`，以及其中 `inference-sidecar/` 的 Python 侧车。外部工程只读；规格、独立短锚点、原始提取报告与核对结果仅保存在本目录。

先读 [SPEC.md](SPEC.md)。本批在调用提取器前，根据原始源码选择 JS 与 Python 各一处声明、一处可证静态调用引用和一处未解析调用，冻结输入哈希与短锚点。预期不来自提取结果，不复制完整私有源码；少量手选锚点不是完整项目真值、独立家族保留集、框架验收或产品准确率。

不修改外部 README、AGENTS、配置或源码，不安装依赖、不运行服务、应用、目标测试或构建；不读取 `.env`、模型权重、DLL、数据库、日志及其他运行数据。分析器仍保留各自的配置缺失、依赖与语义不完整原因，不为外部项目补造 tsconfig 或 pyproject。

2026-11-12 已完成两条语言的只读观察、6/6 手选锚点核对和无扩展名 Node 入口 `bin/www` 的技术输入验证。333/333 结构、输入和新鲜度检查通过；允许读取的 174 个静态文件前后哈希与 mtime 未变化。结果仍不完整，详见 [REPORT.md](REPORT.md) 与[机器报告](reports/verification.json)。

| 文件 | 用途 |
|---|---|
| [expected/platform-server.json](expected/platform-server.json) | 提取前冻结的六个源码短锚点、范围与哈希；从未用提取输出反改答案 |
| [expected/entry-input.json](expected/entry-input.json) | `bin/www` 的 package 元数据、Node shebang、哈希及独立声明/调用范围；与六个语义锚点分开 |
| [policy.py](policy.py)、[node_bridge.mjs](node_bridge.mjs)、[python_bridge.py](python_bridge.py) | 只读输入策略、读取账本及可信 API 桥接；目标写入与对应模块执行防护 |
| [verify.py](verify.py) | 原始输入、既定锚点、技术入口、前后变化和报告摘要核对 |
| [reports/raw/js-ts.json](reports/raw/js-ts.json)、[reports/raw/python.json](reports/raw/python.json) | 现有 API 的原始局部报告；不混入 expected 或评估结论 |
| [读取审计](reports/access-audit.json)、[输入快照](reports/input-snapshots.json) | 允许读取路径、排除项、拒绝尝试，以及静态输入的前后哈希/mtime |

已验证命令，在本目录执行：

```powershell
python -B verify.py
python -B verify.py --check-existing
```

第一条重建原始结果与观察证据；第二条只复核已有结果，精确检查 raw、审计、快照及工具/脚本/预期指纹。外部源码或元数据变化时先报告差异，不能沿用旧预期宣称当前通过。

JS 使用显式 `additionalEntryFiles` 将有真实 Node shebang 的 `bin/www` 纳入 Program，不运行其启动命令；根仍缺 tsconfig/jsconfig。Python 侧车仍缺 pyproject，`requirements.txt` 仅作依赖声明观察。CommonJS `require()` 尚未形成单独导入事实，Express/FastAPI、HTTP、FFI、模型运行、业务/授权及完整项目质量继续未验证。
