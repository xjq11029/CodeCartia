# C# / Roslyn 隔离实验

> 当前范围（2026-11-12）：用户通过 [D13](../../../docs/decisions/D13-初版语言验证范围.md) 确认 C# 整体延后，初版只验证 JS/TS 与 Python。以下保留已执行实验、命令和限制，后续 C# 验证不阻塞初版，也不因局部实验已通过而声明产品支持。

本目录是 M1-04 的局部可行性实验，不是产品适配器、完整 worker 或全 C# 语义栈验收。2026-11-10 已运行内存 Roslyn 提取器，并完成 53/53 检查，其中包含 8 种错误报告的拒绝测试。额外独立快审发现的目标声明越界校验缺口已补回归。实际工具为本机 PowerShell 7.6.9、.NET 10.0.14、Roslyn 5.0.0.0；仅作为观察环境，不冻结产品版本。

使用本机捆绑 PowerShell 中已存在的 Roslyn 程序集，探索版本不冻结为产品依赖。分析器只读登记的原始 UTF-8 输入和显式元数据引用，调用 ParseText、Compilation 与 GetSemanticModel；不 Emit，不执行样例，不加载项目文件、不调用构建或下载。

原始输入放在 `fixtures/`；输入清单 `inputs.json` 仅登记文件、配置和原生坐标探针。独立判据 `expected.json` 由验证器读取，禁止作为分析器输入。报告使用 M1-02 字段子集，保留输入版本、指纹、工具/引用、原生 UTF-16 与原始字节/码点位置、诊断和未知边界；不声称完整 schema 或 worker 兼容。

| 文件 | 实际用途 |
|---|---|
| [analyze.ps1](analyze.ps1)、[inputs.json](inputs.json) | 读取已登记 UTF-8 源码和运行时核心库元数据，保存真实声明、调用、诊断及坐标 |
| [expected.json](expected.json)、[verify.py](verify.py) | 独立预期与标准库验证器，核对声明行、源码字节、诊断、来源和报告指纹 |
| [test.ps1](test.ps1) | 重建报告，验证项目文件/路径越界/覆盖预期被拒绝，然后运行独立核验 |
| [实际报告](reports/actual.json)、[验证报告](reports/verification.json)、[边界报告](reports/boundary-policy.json) | 实际工具/引用指纹、耗时和进程内存观察、正反例结果；`boundary-inputs.json` 是拒绝测试生成的清单 |

已验证命令，均在本目录执行：

```powershell
./test.ps1
./analyze.ps1
python verify.py
```

检查覆盖两种重载的正确声明、缺失名称的 CS0103、dynamic 未知、UTF-16/字节/码点坐标及代理对/CRLF 内部端点拒绝。目标声明须核对指定重载的精确标识符范围、完整声明行、原始指纹与 UTF-16 范围；同文件其他重载的证据和越界声明均被拒绝。故意破坏重载、漏调用、额外候选、字节位置、动态状态或映射状态的报告也被拒绝。缺失输入说明由实际编译诊断产生，不按样例名称填答案。报告使用 `contractReference` 标明局部字段参考，不声明完整 schema 兼容。

`fixtures/rejected.csproj` 含写文件哨兵，当前提取器在源码类型校验时拒绝该文件，哨兵未产生；提取器、测试脚本和验证器仅向 `reports/` 写报告，并检查最终路径及父目录的链接。测试脚本与验证器各自通过 Windows 原生目录 junction 拒绝测试，临时哨兵未被覆盖。这证明的是当前“拒绝项目文件、只读解析”的策略，**真实 MSBuild/JDT 项目加载仍未验证，不能据此关闭项目加载风险**。项目加载、MSBuild、NuGet、Roslyn 项目工作区、ASP.NET、依赖注入、授权、复杂数据流及真实生成映射均待独立实验。没有执行、构建样例或安装/下载依赖。

上级说明见 [实验入口](../README.md)；依据见 [统一图与证据草案](../../../docs/contracts/M1-统一图与证据契约.md) 与 [语言覆盖清单](../../../docs/capabilities/M1-语言框架与输入覆盖清单.md)。
