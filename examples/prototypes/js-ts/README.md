# JS/TS 与前端、全栈局部实验

本目录承载 M1-04 的 JS/TS 语义栈实验。当前先准备逐类规格和隔离输入；实际工具可用后，只用真实 TypeScript Compiler API 执行登记范围内的静态符号、调用签名和原始坐标核对。框架版本、产品选型、支持范围及预算均未冻结。

原始源码和静态配置保存于 `inputs/`，独立预期保存于 `expected/`，提取器不得读取预期。Vue、React、Node.js、Next.js 的独立框架行为不能由 TypeScript 基础符号实验推断通过。任何 `.js/.ts/.jsx/.tsx/.vue` 输入均只作为文本读取，不执行模块、配置脚本、构建或应用。

实验范围和判据见 [SPEC.md](SPEC.md)。工具配置、脚本、实际报告及已验证命令随真实交付登记；当前没有安装依赖，没有产品 worker 或完整 M1-02 schema 校验器，不将手写规格当作真实分析事实。

依据：[统一契约](../../../docs/contracts/README.md)、[语言与输入覆盖](../../../docs/capabilities/M1-语言框架与输入覆盖清单.md)、[M1 任务](../../../docs/progress/M1-任务清单.md)。
