# C# / Roslyn 隔离实验

本目录是 M1-04 的局部可行性实验，不是产品适配器、完整 worker 或全 C# 语义栈验收。正在制作原始源码、独立预期和内存语义提取器；命令与实测结果将在实际运行后补充。

使用本机捆绑 PowerShell 中已存在的 Roslyn 程序集，探索版本不冻结为产品依赖。分析器只读登记的原始 UTF-8 输入和显式元数据引用，调用 ParseText、Compilation 与 GetSemanticModel；不 Emit，不执行样例，不加载项目文件、不调用构建或下载。

原始输入放在 `fixtures/`；输入清单 `inputs.json` 仅登记文件、配置和原生坐标探针。独立判据 `expected.json` 由验证器读取，禁止作为分析器输入。报告使用 M1-02 字段子集，保留输入版本、指纹、工具/引用、原生 UTF-16 与原始字节/码点位置、诊断和未知边界；不声称完整 schema 或 worker 兼容。

范围限定为跨文件静态方法及 int/string 重载绑定、缺引用、dynamic 未知调用、UTF-8/UTF-16/码点转换和内部端点映射失败。项目加载、MSBuild、NuGet、Roslyn 项目工作区、ASP.NET、依赖注入、授权、复杂数据流及真实生成映射均待独立实验。

上级说明见 [实验入口](../README.md)；依据见 [统一图与证据草案](../../../docs/contracts/M1-统一图与证据契约.md) 与 [语言覆盖清单](../../../docs/capabilities/M1-语言框架与输入覆盖清单.md)。
