# platform-server 只读外部工程核对规格

版本：external-project-observation-v0.1；日期：2026-11-12。用户提供的分析根为 `D:/Server-side/platform-server`；Python 分析根为其中 `inference-sidecar`。这两个根属于同一个真实项目家族。

## 先行预期

预期作者先阅读外部 README/AGENTS、package.json、侧车 README/requirements 及所选源码，再冻结 [expected/platform-server.json](expected/platform-server.json)。文件只保存原路径、原始哈希、短锚点、坐标和指定结论，不保存完整源码，也不读取中央合成项目的 expected 作为外部答案。

| 语言 | 选定证据 | 指定结论 |
|---|---|---|
| JS | utils/queryHelper.js 的 buildWhere 完整声明 | 保留真实声明与原始范围 |
| JS | paginate 内 buildWhere(query, { fuzzy, range }) | static-signature-reference 指向上述声明，runtimeTargetMode=unknown |
| JS | model.findAndCountAll(...) | 参数仅有 Object 上下文，没有可证方法目标；保留 unresolved、target=null |
| Python | main.py 的 _decode_image_b64 完整声明 | 保留真实声明与原始范围 |
| Python | infer 内 _decode_image_b64(image_b64) | lexical-declaration-reference 指向上述声明，runtimeTargetMode=unknown |
| Python | _thermal_to_image 内 np.frombuffer(raw[:expected], dtype="<i2") | 未登记 numpy 源码/类型输入，保留 unresolved、target=null |

声明和调用范围由手选原始标记及文件字节独立计算，不从分析器结果复制。只核对这六个锚点；不要求所有未选取调用都匹配某个人工答案，也不据此计算整个项目的正确率。

首次观察发现无扩展名 Node 入口 `bin/www` 未进入 JS 自动发现。后续按 `package.json` 的 `scripts.start` 文本与入口首行 `#!/usr/bin/env node`，显式登记 `additionalEntryFiles=[{path:"bin/www",language:"javascript"}]`。来源、字节哈希与请求保存在 [entry-input.json](expected/entry-input.json)；不解析或执行启动命令，不改目标配置。新增技术输入检查要求该文件进入 inputManifest 并产生源码事实，原六个语义预期保持不变。

## 输入与读取边界

- JS 根现无 tsconfig/jsconfig；按现有 API 的探索默认发现，保留 CONFIG_INFERRED 和不完整状态。Python 根现无 pyproject.toml；保留 INPUT_MISSING，不执行打包配置或搜索安装环境。
- package.json 和 requirements 只提供声明的依赖版本范围；不等于已安装版本或框架语义通过。
- 只读取静态源码与必要配置/包元数据。读取防护在桥接层拒绝 `.env`、模型/DLL、数据库、媒体、日志等运行数据；发现遍历排除明确的运行输出目录。防护策略与被排除目录分别记录，不写进目标工程配置。
- Node 的 TypeScript 库仅来自本仓库登记的可信工具链；Python 只使用已有标准库。禁止目标模块导入、安装/启动/测试/构建、插件执行、编译器 emit 及外部工程写入。
- 原始 API 报告保存到 reports/raw；读取防护观察、配置缺失、版本/输入哈希、预期核对及源码/配置前后变化另存 reports。现存链接及输出硬链接不允许作为写入目标。
- 前后哈希只覆盖允许读取的静态源码/配置；不为证明只读而读取敏感运行数据。若内容或 mtime 在窗口内变化，报告实际差异，不能宣称固定快照或擅自改写预期。

## 验收边界

核对输入清单/原始摘要、指定声明与调用范围、静态引用/未知状态、缺配置诊断、运行目标未知，以及允许读取输入的前后变化。报告必须保存工具、提取器、桥接/核对器和预期的指纹。

即使六个锚点全部符合，仍不证明 Express/FastAPI 路由注册与可达 HTTP 链、异步调度、koffi/SDK FFI、跨服务身份、业务步骤或授权判定通过。Python 类型/推导式/动态调用及 JS 缺失类型/模块边界按原报告保留。目标项目测试和服务不运行；本批仅增加真实工程的有限证据，不关闭完整 M1-04、M1-07、M1-10 或 G1。
