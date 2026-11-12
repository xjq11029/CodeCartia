# 公共事实映射子集规格

目标字段版本为 `0.2-draft`，实验模式为 `project-loading-reference-mapping-v0.1`。本规格落实[统一图与证据契约](../../../docs/contracts/M1-统一图与证据契约.md)中的身份/版本、源码证据、静态引用和独立推导子集，不定义完整线上序列化，也不宣布公共 schema、语言、G1 或产品验收通过。

## 输入与来源

`inputs.json` 只登记 projectId、纯实际报告路径和显式源码根，不登记目标、调用答案或领域术语。报告必须来自 `project-loading/reports/raw/` 且为 `project-loading-v0.1`；拒绝包含评估层的 wrapper、其他版本及 scope/root 不符的输入。映射器不读取 expected 或评估 verdict，不导入或执行被分析项目。

核对实际报告的 producer、JS 编译器登记/版本/指纹及输出策略指纹；逐一读取原始 inputManifest 中登记的文件，复核大小与 SHA-256。项目路径限制在显式根内，语义库仅接受已登记 TypeScript 同目录的内置 lib 声明；链接路径拒绝。不把输入报告指向的任意主机路径当作许可。

## 字段与语义

| 来源 | 输出 | 必要边界 |
|---|---|---|
| 声明的文件、限定名、配置和原始范围 | EntityRef、EntityVersion | 仅在当前捕获快照内登记符号锚点；名称或行号不构成跨快照身份连续性 |
| 调用表达式的文件、配置和完整范围 | call-site EntityRef、EntityVersion | 只证明该句法调用点存在，不证明已执行、可达或参数传播 |
| 原始字节、inputManifest 与原始范围 | Evidence、SourceSpan | 字节、码点列、BOM/CRLF 都独立核对；原输入与纯报告中的具体条目分别留证 |
| 已确认静态引用或 unresolved | type=reference 的 Relation | JS 为 static-signature-reference，Python 为 lexical-declaration-reference；全部 runtimeTargetMode=unknown；未解析目标不得补造 |
| 输出的直接语义输入 | 独立 Derivation | EntityVersion 必须依赖自己的源码和报告 Evidence；Relation 必须依赖对应 source/target EntityVersion 与直接 Evidence |
| 原始版本、配置、静态来源 | 完整 FactRef、ContractEnvelope、sourceClosure | scope 四维完整保留，EntityRef 不得代替事实依赖；来源仅是自动静态分析 |

所有 FactRef 含 kind/id/revisionId/snapshotId/sourceViewId/scope/layer；不可变 payload 的规范化摘要决定 revision。关系端点使用 EntityRef，端点版本则作为推导的精确 FactRef 输入，二者不可互换。同源声明在不同编译配置下使用不同身份和版本，不跨配置串线。

Derivation 与输出事实分别保存。`derivationRefs` 只出现在 `supportIndex` 宿主查询投影，不能进入事实 payload 或造成自身因果依赖。每条推导独立记录 inputFactRefs、outputFactRefs、逐项支持证据和 sourceClosure；只引用“存在的某条事实”不足以替代必需语义输入。

## 坐标、范围与新鲜度

SourceSpan 的统一范围指原始 UTF-8 字节，列按码点，BOM 占字节不占首列，CRLF 作为一次换行。输入报告没有保留完整原始 TypeScript/Python 原生位置，因此 `nativePositions` 诚实记录 **project-loading 报告提供的字节坐标系**，不伪造编译器 UTF-16 或 AST 原生位置。虚拟片段/生成映射不在本切片内。

环境与入口没有来自静态报告的绑定信息，scope 使用明确的 `unbound:runtime-environment` 和 `unbound:entry-context`，并保留诊断；它们不是任意环境或全部入口。每个 envelope 及具备完整性字段的事实，其 completeness.complete 保持 false，bundle 的 `fullSchemaConformance=false`；局部引用仍可 confirmed。

`freshness=current` 仅限定到 `affectedScope.fieldScope` 中的已登记输入字节与本次字段映射。`snapshotDescriptor.freshnessVerification` 明确说明完整工程报告、目录集合与负查询的新鲜度均未验证。新增 include 匹配文件、缺失依赖后来出现等变化未被本映射器独立检测；不能据此声称 R02 完整失效、当前工程报告或增量/全量等价已通过。

## 独立核对

`verify.mjs` 不导入 mapper 或其 ID/摘要函数，独立读取纯实际报告与源码，复核逐项原始范围、目标、unknown、配置、精确引用、内容版本、必需语义依赖、来源闭包与查询投影。它检验的是映射忠实性，不是第二套语言语义分析器或保留测试集。

反例覆盖错/漏 revision、EntityRef 冒充证明、漏证据、错声明、同源不同配置串线、未知/运行目标升级、错误坐标/指纹、来源洗白、自支持与反向索引污染。另在删除必需 target EntityVersion 或原始 Evidence 后，重新生成合法 Derivation revision 和支持投影；这种结构自洽的错误也必须被语义依赖规则拒绝，而不是仅由旧摘要挡住。
