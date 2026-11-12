# 项目事实到公共契约的局部映射

本目录用于 M1-02/07 的字段核对：将项目加载实验的纯实际报告及其已登记原始输入，转换为声明、调用点和静态引用关系的公共事实子集。以 `schemaVersion=0.2-draft` 标识目标字段版本，不宣称完整 schema、语言深度、运行调用、身份连续性或 G1 已通过。

依据：[统一图与证据契约](../../../docs/contracts/M1-统一图与证据契约.md)。输入只允许来自登记的纯实际报告和源码；不读取 expected，也不把评估 verdict 转为事实。跨快照稳定身份、条件/数据流、HTTP、业务/授权、规则组合、worker 与存储均不在本切片内。

先读 [SPEC.md](SPEC.md)。输入规格和报告边界均为探索子集；详细字段映射及未覆盖项也写入每个 bundle。

| 文件 | 实际用途 |
|---|---|
| [inputs.json](inputs.json) | 7 份纯实际报告及显式源码根的技术登记，不含语义答案 |
| [mapping.mjs](mapping.mjs)、[build.mjs](build.mjs) | 读取原始输入、校验版本/范围、产生公共记录子集 |
| [io.mjs](io.mjs) | 有界只读输入和独立报告写入；拒绝链接/输出硬链接，使用临时文件替换报告 |
| [verify.mjs](verify.mjs) | 不复用 mapper/ID函数的引用、源码、语义依赖和拒错核对 |
| [映射结果](reports/bundles.json)、[核对结果](reports/verification.json) | 实际 records、独立检查及变异结果；包含输入、生成器和验证器指纹 |

已验证命令，执行目录为仓库根目录：

```powershell
node examples/prototypes/fact-mapping/build.mjs
node examples/prototypes/fact-mapping/verify.mjs
```

2026-11-12 已将 JS/TS、Python 的 7 份纯实际报告映射为 210 条版本记录；独立核对基线通过，28 个错误变异全部被拒绝。其中包含相同声明跨配置串线、来源路径伪标签，以及重算合法 revision/支持投影后删除必需语义输入的对照；独立只读审查发现的上述缺口均已补回归。

位置证据同时绑定原始源码与实际报告中的具体条目；所有运行目标仍为 unknown。`nativePositions` 是源报告真实提供的字节坐标系，原编译器/AST 原生位置没有被该格式保留，不伪造填充。身份只在当前捕获快照内有效，未验证移动/重命名连续性。

bundle 的 `fullSchemaConformance=false`，每个 envelope 及具备完整性字段的事实均为 `complete=false`，明确保留局部边界。`freshness=current` 只表示本次已登记输入的版本相符；新增源码、目录集合及负查询变化未独立复核，完整工程报告新鲜度未验证。机器字段 `snapshotDescriptor.freshnessVerification` 与 `completeness.affectedScope.fieldScope` 明确限定范围，不关闭 R02、完整 M1-02/07 或 G1。

这些输入是公开开发工程，原始语义成绩仍以 [project-loading 独立评估](../project-loading/README.md) 为准；本目录只核对映射忠实性，不增加语言/框架/业务准确率结论。
