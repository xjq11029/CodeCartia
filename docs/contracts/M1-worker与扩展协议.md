# M1 worker 与扩展协议

> 草案版本：0.2｜`protocolVersion: 0.2-draft`｜`schemaVersion: 0.2-draft`｜日期：2026-11-10｜工作包：M1-03
>
> 状态：协议文档草案。R11/R12 的引用和发布状态转换已有可执行参考实验，尚无完整 worker 接入、传输协议执行或真实跨进程恢复结果；未冻结传输实现、工具链、资源预算或首版支持清单。

依据：[设计 §4.2](../CodeCartia-设计方案.md#42-适配器与-worker)、[推进 §4](../CodeCartia-推进方案.md#4-m1契约基准与验证原型)、[需求追踪](../acceptance/M1-需求与验收追踪.md) REQ20/21/22/47。事实模型与来源遵循 [统一图与证据](M1-统一图与证据契约.md)，冻结输入及发布遵循 [资源、快照与规则组合](M1-资源快照与规则组合契约.md)，调用/HTTP 与业务步骤引用另见同目录契约。独立正反例、消息序列与实验规格见 [协议正反例与实验规格](M1-worker协议正反例与实验规格.md)。

## 1. 先核对最小正反例

下表规定后续实验的指定输入和预期，尚无实际执行结果。WP 编号仅为本文定位，不新增产品验收组；它们不作为分析器输入或产品真值。空消息样例与手写图记录也不能证明语言深度分析。

| 例号 / 来源 | 最小输入或变化 | 应有结果 | 必须避免的结果 |
|---|---|---|---|
| WP01 / REQ21 | 宿主与 worker 显式提供共同协议/schema 配对；另有只共同协议但无共同 schema 的变体 | 前者精确选定配对并确认 ready；后者拒绝会话，保留双方版本依据 | 自动把更高次版本认作兼容，或未协商就接收事实 |
| WP02 / REQ21、S01 | worker 声明基础索引，任务要求调用传播/步骤授权；另有工具缺失变体 | 必需执行模式不满足则拒绝；允许的局部实验独立报告未覆盖需求 | 基础索引冒充深度支持，协商时静默删首版目标 |
| WP03 / R02、REQ20 | 相同逻辑任务重试为新 attempt；旧 attempt 的批次和 finished 延迟到达 | 旧消息仅审计，不进入新暂存或发布；新 attempt 重新登记冻结引用 | 用 taskId 相同合并两个尝试，或沿用旧配置/输入 |
| WP04 / REQ20、AP07 | 第一批关系引用第二批的实体/证据；另有先索引角色、后绑定场景的变体 | 前向引用仅暂存；全部所需输出到齐后统一闭合，角色与场景语义不随到达顺序变化 | batch.ack 就把悬空关系放入当前确认图，或丢弃先到声明 |
| WP05 / REQ21、R07 | 同一批次相同指纹重发；独立变体同批次 ID 不同内容 | 重发幂等确认；冲突重复使 attempt 协议失败，双方载荷保留诊断 | 重复计数，或以先到/后到载荷静默覆盖 |
| WP06 / REQ21 | finished 清单缺一批、序号有缺口、条数不符或引用终未解析 | 协议完整性失败，不能发布完整结果；结构有效局部材料可隔离供诊断 | 只改 outcome=partial 就宣布传输完整或填造缺失目标 |
| WP07 / R02、REQ21 | 已收 finished 正在校验时宿主接收取消；另有完成裁决已封存后才取消 | 前者取消封存赢得裁决，后到完成不能发布；后者返回 already_terminal，不回滚已发布版本 | 收到 finished 就假定已完成，让未校验结果绕过取消 |
| WP08 / REQ21 | cancel.ack 已返回，worker 仍运行；另有超时/崩溃无终结消息 | ACK 仅收妥请求；宿主封存并记录进程清理状态，保留旧完整快照 | 将 ACK 当成 worker 已停止，或等待永不返回的 finished 才隔离旧结果 |
| WP09 / S01、REQ21 | 已支持传播预算截断；独立变体输出不遵守协商流控上限 | 前者合法 partial 带原截断/范围；后者协议失败/资源失败 | 丢批次却报 completed，或把违约流控等同正常语义截断 |
| WP10 / REQ21 | 事实流被背压暂停，随后取消/超时；日志含看似 facts.batch 的文本 | 控制处理仍可推进；日志始终进入独立日志通道 | 事实 credit 阻塞取消，或从日志解析出事实 |
| WP11 / R05、Q01 | 自动 task 接到依赖人工边的派生事实，声称 analysisMode=static | 来源闭包校验识别不匹配，拒绝自动结果视图中的伪自动事实 | 只信最终枚举，洗掉辅助来源 |
| WP12 / R06、REQ47 | 适配器扩展携带未登记根、构建命令或覆盖公共字段；另有未知必要扩展 | 不执行/不扩大输入；必要扩展不兼容明确拒绝 | 插件以私有字段绕过来源/完整性，或未知字段静默丢失后声称完整 |
| WP13 / REQ21、S01 | allowPartial=false，运行后才发现必要输入/传播缺口，消息结构与批次均有效 | 协议完整性通过与语义完整性失败分开；宿主 sealed_failed，局部材料隔离 | 忽略 false 返回正常受许可 partial，或将有效消息误记为坏协议 |
| WP14 / R02、REQ21 | 宿主完成裁决已封存，但发布前输入变化或持久化失败 | 保留 sealed_completed 的执行裁决，撤销 publication 资格并记录失败/隔离及重试 | 逆转单一终态、继续发布过期结果或把存储失败记为分析成功发布 |
| WP15 / R11 | 同 id 两个 revision 与不同来源/层的事实乱序传输；消费者精确引用其中一个 | 按完整 FactRef 闭合，ID-only、缺版本及错层引用失败；同结论独立推导保留 | 用同 id 的任意版本补引用，或将反向支持索引算成事实输入 |
| WP16 / R12 | 相同槽位 A/B 先后发起但 B 先完成；另在 A 预检后登记 B，或 B 随后失败/取消 | 最新请求世代才可原子切换，A 的合法结果保留历史，失败/取消不恢复 A 资格 | 用 attempt 内完成锁代替跨任务发布顺序，或恢复后遗忘 B |

## 2. 边界与两个版本

宿主负责选择并启动已登记 worker、冻结任务输入、接收/校验事实、裁决尝试终态及发布快照。worker 按协商能力只读取证、输出事实和诊断；不能修改目标工程、自行构建/下载输入、选择另一快照或直接更新当前查询图。宿主为缺工具、拒绝、失败提供结构化诊断，不让一个进程失效无提示地删除整个工作区结果。

`protocolVersion` 规定消息、状态与传输行为；`schemaVersion` 规定 Entity/Relation/Evidence 等记录语义。两个版本独立协商，当前都为 `0.2-draft`，不表示可以互换。0.2 增加精确事实引用及宿主发布请求/世代，不能与 0.1 自动兼容；本协议仅接受显式提供且验证过的 `(0.2-draft, 0.2-draft)` 配对，不接受旧字段补默认版本或删除发布世代。历史 0.1 记录保留原版本及审计，须经明确迁移与重验才能输入 0.2；不能改标签继续执行。独立 bootstrap 的 `codecartia-worker-bootstrap-v0.1-draft` 不变，它只负责读取所提供配对。

此处描述**逻辑消息**，不以 JSON 示例选定线上字节格式。设计候选可采用独立协议输出通道与日志通道，例如受控 stdio 的分帧消息/JSONL 与独立日志流；帧编码、边界、最大长度、摘要算法及恢复方式须在 M1-08 实测后冻结。无论候选格式为何，解析器均不把普通日志、源码文本或目标工程打印当成协议。原生字段和数据不是可执行代码。

## 3. 引导、协商与能力

### 3.1 尚未协商时的最小引导

为避免使用未知协议解析自身版本，启动配置明确指定共同引导描述 `bootstrapProfile=codecartia-worker-bootstrap-v0.1-draft` 及其候选帧解释器。下列引导记录不要求已选择的 protocolVersion/schemaVersion；宿主无法解析引导或引导描述不匹配时立即拒绝该会话，保留可取得原始错误信息，不尝试从任意 stdout 猜格式。

| 消息 / 方向 | 字段与约束 |
|---|---|
| `hello` / worker→宿主 | `bootstrapProfile/kind/messageId/workerId/workerBuild/bootId/offeredPairs/capabilities/requiredBootstrapFeatures/optionalBootstrapFeatures`；offeredPairs 每项显式列 protocolVersion+schemaVersion 配对 |
| `initialize` / 宿主→worker | 相同引导描述、`messageId/replyTo/sessionId/selectedPair/selectedCapabilities/requiredFeatures/optionalFeatures/transportProfileId/flowControlProfileId`；sessionId 为本次宿主连接的新身份，不复用已关闭会话 |
| `ready` / worker→宿主 | `replyTo/sessionId/bootId`、精确 selectedPair、已接受能力与运行可用性、配置指纹；worker 验证选择属于 offeredPairs，宿主再次核对，不一致则拒绝 |
| `session.rejected` / 任一方向 | 引导描述、可取得的 messageId/replyTo、`code/reason/offeredPairs/unsupportedFeatures`；尚无 sessionId 时明确处于引导阶段，不伪造已建立会话 |

引导必要特性不识别或未协商配对的 ready 均不进入会话 ready 状态。optional 特性只有不影响消息解释、事实含义或完整性时才可忽略；影响语义的字段不得靠标记 optional 绕过兼容。协商记录和启动配置指纹纳入会话审计及后续复现。

### 3.2 CapabilityAdvertisement

| 字段 | 语义与限制 |
|---|---|
| `adapterId/adapterKind/adapterVersion` | kind 为语言/框架/协议；扩展由明确命名空间区分，名称不等于已加载或已验证 |
| `languageIds/frameworkProfiles/protocolProfiles` | 具体语言及框架/协议版本配置、依赖语言输入；不以通用版本范围代替真实适配边界 |
| `recordKinds/modeProfiles` | 可输出公共类型、传播/业务/授权模式 ID、版本、前提与未知边界；基础索引与深度模式分别声明 |
| `requiredInputKinds/toolRequirements/availability` | 必要输入、工具及版本条件；可用、缺工具、不兼容、未知分别记录，未验证组合不得标为支持 |
| `validationStatus/validationReportRefs` | 自报能力与实测状态分开；未验证、原型验证、产品验证需对应报告和适用范围，宿主不把自报当验收证明 |
| `coordinatePolicyIds/sourceViews/extensions` | 原生/统一坐标、来源视图和命名空间扩展版本；公共字段语义必须可核对 |
| `executionFeatures` | 支持取消、部分结果、并发和流控等特性；并发容量和上限来源另记录，不假定无限 |

CLI 仅根据当前工程/实验配置检查和启用相关 worker，不要求预装全部工具链。缺工具或模式时记录未覆盖范围并保留其他有据结果；首版全部必需语言与分项准入仍保留，不能通过协商把困难项变成“不适用”。

## 4. 协商后的消息与任务

### 4.1 MessageEnvelope

| 字段 | 约束 |
|---|---|
| `protocolVersion/schemaVersion/kind/messageId` | 精确协商版本与消息身份；messageId 不等于事实 ID 或批次 ID |
| `sessionId/workerId/bootId` | 当前会话、worker 实例与启动身份；新进程或连接重新引导，旧实例消息不能接续新会话 |
| `taskId/attemptId` | 任务消息必需；taskId 是逻辑任务，attemptId 是本次独立执行。隔离键为 sessionId+taskId+attemptId |
| `replyTo/requiredFeatures/optionalFeatures` | 响应关联与必要解释能力；未知必要消息/特性拒绝并给诊断；纯展示 optional 信息可忽略但保留审计 |
| `payload` | 按 kind 的结构化内容；任意正文文本/字段不能提升读取或执行权限 |

全局会话消息不填虚构 taskId/attemptId；缺失任务必需身份、错会话或错尝试的消息不得进入当前暂存结果。宿主记录未识别任务的消息原因，不能把它归到“最近一个任务”。

### 4.2 AnalyzeRequest 与接受

`analyze` 使用 MessageEnvelope，并包含下列冻结任务记录。`snapshotId` 是宿主为本次冻结输入保留的**待构建快照身份**，不表示已发布；`previousPublishedSnapshotId` 仅明确引用历史完整版本。

| 字段 | 内容与约束 |
|---|---|
| `snapshotId/scope` | 目标快照、选定 projectId/environmentId/configId/entryContextId；涉及多工程的 scope 集合与映射显式登记，不用缺字段作为全局通配 |
| `publicationSlotId/requestId/requestGeneration` | 宿主在发起任何 worker 前登记的发布请求；同一次请求的所有 worker/组合阶段共享，同槽位最新世代才可发布。worker 必须回传核对，不能自行选择或递增 |
| `inputManifestRef/inputRegistrations/configId` | 原始/外部/生成输入及缺失观察的版本/指纹，已登记只读根与读取策略；configId 与 scope.configId 一致 |
| `identityRegistryRef/analysisProfileId/effectiveRuleSetId` | 同版本身份登记/自动匹配历史、分析器/模式/预算/来源视图及有效识别规则组合引用；不得换成另一任务的最新版本 |
| `sourceViewId/previousPublishedSnapshotId` | 请求的自动/辅助/人工/运行视图与历史基线；辅助事实不能未经来源核验进入自动任务 |
| `requiredExecutionModes/requestedCoverage/allowPartial` | 必须执行的模式、完整需求覆盖和是否允许该探索任务返回语义部分结果；requiredExecutionModes 不满足则拒绝，requestedCoverage 未覆盖仍保留缺口，不删除首版要求 |
| `declaredExternalProviders` | 同快照且同发布请求内的精确 `sessionId/taskId/attemptId`、输出范围和 FactRef 键；完成后钉住 output manifest 指纹，不以 taskId 或“最新 attempt”补引用。提供者重试须显式重绑并重验消费者，旧 attempt 暂存不能沿用 |
| `transportProfileId/flowControlProfileId/deadlineProfileId` | 协商传输/流控及期限规则引用；不提供默认预算或将未知值写为无限，控制资源与语义传播预算分开 |

宿主发送前核验引用；worker 验证任务字段、版本/指纹、能力、只读范围及模式。通过才回 `task.accepted`，包含 `requestFingerprint/acceptedScope/executionModes/coverageGaps`；不通过回 `task.rejected`，包含 code/reason、缺失输入或不支持模式及影响范围，不开始产出事实。allowPartial=false 时，预先可知的必需输入/覆盖缺口使请求被拒绝；运行中才发现缺口的处理见第 6 节。accepted 不表示输入全部齐备、分析已完成或结果可发布。

宿主收到与已登记请求/attempt 匹配的 task.rejected 后，立即封存该开放记录 sealed_failed、reasonClass=request_rejected，不等待从未开始任务的 finished。启动/握手拒绝尚无任务时只保留会话拒绝；若坏请求缺少足以定位 attempt 的身份，错误通过可解析的会话 protocol.error/replyTo 关联原消息，不伪造 taskId/attemptId，也不改动其他开放任务。

同一 attempt 对相同 analyze 重发必须返回同一接受/拒绝记录；同 attempt 不同 requestFingerprint 为协议失败，不能重新初始化并沿用已收批次。重试使用新 attemptId，输入变化另登记快照/配置引用；本草案不支持把旧未终结流续到新 attempt。会话内并发只按显式接受的 capacity 与隔离键执行，不能把批次完成顺序作为规则优先级。

本版本规定 worker 输出**当前请求 scope 的结果集合**，允许有据的语义 partial；尚未定义差量编码，不把未发送旧实体/关系解释为“保持不变”。previousPublishedSnapshotId 仅历史/缓存依据，不是自动拼接底层事实的许可。宿主如采用增量计算，仍按同输入/身份历史核验完整新结果或有据重算未覆盖范围，必要时扩大全量重建；删除、撤销、旧依赖失效不能被批次齐备代替。

### 4.3 输出与控制词表

| 消息 / 方向 | 必要主题字段 | 对结果的影响 |
|---|---|---|
| `facts.batch` / worker→宿主 | batchId、sequence、payloadFingerprint、recordCount、records、snapshotId、scope、publicationSlotId/requestId/requestGeneration、completeness | 结构核验后仅进入该 attempt 暂存；见第 5 节 |
| `batch.ack` / 宿主→worker | replyTo、batchId、sequence、payloadFingerprint、status、可用 credit | status=staged/duplicate，表示接收或已暂存，不证明全部引用闭合、语义正确或发布 |
| `task.diagnostics` / worker→宿主 | 结构化 Diagnostic、scope、依赖与 completeness | 属受审计任务诊断，不能当普通日志；记录计数/引用需进入终结清单 |
| `task.progress` / worker→宿主 | phase、已观察工作量/声明总量或未知、资源观察 | 仅进度；正常进度/100% 不证明完成或分析正确，不以日志估算事实数 |
| `task.finished` / worker→宿主 | outcome、finalSequence、batchManifest、totalRecordCount、recordCounts、diagnosticManifest、completeness、冻结引用指纹及 publicationSlotId/requestId/requestGeneration | worker 的终结申请；宿主仍须校验与裁决，见第 6 节 |
| `task.cancel` / 宿主→worker | cancelRequestId、原因/作用 attempt、裁决引用 | 封存该 attempt 的发布资格后请求停止；不得改写其他任务 |
| `cancel.ack` / worker→宿主 | replyTo/cancelRequestId、status=accepted/already_terminal/unknown_attempt、workerObservedState | 仅说明请求观察；不证明终结、资源释放或进程已停止 |
| `session.shutdown` / 宿主→worker | 关闭原因、剩余任务处理、deadlineProfileId | 阻止接受新任务；运行中尝试依取消/失败规则封存，不把会话关闭当成功 |
| `protocol.error` / 宿主↔worker | code/reason、当前可核对 sessionId、可取得 offendingMessageId/replyTo、rawFrameRef、affectedScope/affectedAttemptKeys | 会话级控制错误，不要求虚构 taskId/attemptId；只能列已确定受影响的尝试。原消息可解析时关联其身份，否则关联受控原始帧审计引用；必需帧无法解析时关闭受影响连接并记录宿主诊断 |

消息 kind、序列以及枚举均为本草案提议，未形成实际接口。工作日志使用独立 LogRecord，至少带会话/worker、可取得任务/尝试、level、文本和记录时间；日志不计事实条数、不参与 sourceClosure，也不替代 Diagnostic。诊断和日志文本均按不可信数据展示。

## 5. 分批、引用与背压

### 5.1 暂存、幂等与终结清单

每个 attempt 的事实批次 sequence 从 1 开始连续编号；batchId 不重复。宿主允许因候选传输实现暂存先到批次，但不能跳过最终连续性校验；该序列只说明协议批次顺序，不能代替源码注册顺序、检查链或规则阶段。零输出技术任务使用 finalSequence=0、空清单与零计数，不构成产品分项空验收通过。

`payloadFingerprint` 覆盖精确协商的载荷表示、batchId/sequence、范围/快照、records 及完整性；不包含摘要字段自身或重发的 messageId/replyTo。其编码与算法由 transportProfile 指定并进入复现，未定义时不能假装完整性已验证。相同批次身份/指纹重发只产生 duplicate ACK，不重复追加记录或计数；相同身份不同内容、不同 batchId 争用同 sequence 均为协议失败，保留双方依据。

批次重复与记录重复分开核验。`wireRecordKey` 与公共 FactRef 的完整键一致：`kind/id/revisionId/snapshotId/sourceViewId/scope/layer`，不允许缺 revision 后回退到逻辑 ID。相同键跨批重现可去重，同键异内容协议失败；不同 revision、来源视图、scope 或 layer 是独立记录。逻辑 EntityRef 端点在身份登记中核验，不能替代版本事实依赖。宿主按精确版本保留独立规则产物，并创建有自身 revision 的 merged 记录；语义兼容或冲突由冻结规则组合处理，不使用 last-wins。

records 含具有完整 FactRef 的公共版本记录及主题记录，不丢失 evidenceRefs/conditionRefs、独立 Derivation、scope、来源闭包和完整性。derivationRefs 是宿主从独立推导生成的查询投影，不接受 worker 在不可变输出事实 payload 中更新此反向索引。所有推导 inputFactRefs/outputFactRefs、主题语义依赖及 sourceClosure 必须精确引用；ID-only 或引用键字段缺失为 schema 失败，不自动补当前/首个版本。冻结输入和精确 declaredExternalProviders 的暂存记录可作为依赖；前向引用等待确切键，不把同逻辑 ID 的其他 revision 当作满足。宿主按公共 §2.1 检查因果图，支持反向索引不算输入，不允许自支持。其他版本/来源的合法记录不因存在而改变现有引用。

finished.batchManifest 逐项给 `batchId/sequence/payloadFingerprint/recordCount`；recordCount 是该载荷中的记录出现条数，totalRecordCount 与 recordCounts 按类型汇总等于唯一批次载荷的实际出现计数，排除整批重发，但不排除不同批次重复记录。物化后的唯一记录数另报告，不拿语义合并条数核对传输完整性。Diagnostic 可在 records 或 task.diagnostics 传输；同身份同内容幂等去重，diagnosticManifest 记录唯一诊断身份/指纹及其发送位置，避免遗漏或双计。

宿主先校验生产者最终批次清单/连续性/指纹/计数及必需字段，并封存其清单内容，记录 outputSetState=sealed_manifest；不得因此发布或把 HostAttemptRecord 改为完成。内部引用缺失、未声明的跨 worker 引用、错快照引用立即失败；合法外部生产者尚未提供输出时记录 waiting_external_refs，继续收集其已登记清单。所有必需生产者输出到齐后统一核验同快照引用、输入/配置一致性、来源视图与必要覆盖，再参与终态裁决；不要求某生产者先发布才能提供引用。

坏载荷、批次缺口、冲突重复、未知必要记录与来源伪装是协议完整性失败，不能只改 outcome 为 partial 就宣布协议通过。外部生产者终结后仍缺承诺目标或其失败造成必要依赖缺口时，阻断相应完成/发布并给出具体生产者及目标诊断，不填造实体；结构有效、引用闭合且来源可核验的局部材料仍可在失败隔离区诊断，不进入当前确认结果。

waiting_external_refs 仅等待 declaredExternalProviders 的固定任务集合，期限来自 deadlineProfile。提供者被拒绝、失败、取消，终结但缺承诺目标，或期限到达时，宿主封存受影响尝试 failed 并记录 producer/target/受影响 scope 的依赖失败，不无限维持 open。无依赖的独立任务/scope 可在自己的冻结输入和完整性条件下完成；同尝试的有效局部材料保留隔离诊断，不能据此声称整工作区完整。

partial 来自已声明模式的缺输入/未支持/预算截断等语义缺口，并保留原始原因及受影响范围；局部有据 confirmed 与完整性 false 可以并存。依赖缺口的完整链路或确定 allow/deny 受限。传输故障与语义完整性各自记录，不互相抵消。

### 5.2 流控与资源预算

flowControlProfile 明确批次载荷上限、在途批数/字节、暂存/前向引用额度、ACK/等待与恢复策略；均是待测配置，不在草案填默认数字。发送者只在协商 credit 内产出事实；credit 归还的语义为接收资源释放/可继续，不等于发布。

取消、终结、错误、诊断与会话控制使用独立、受界限的控制处理额度，不能被 facts.batch 的零 credit 卡住；它们也不能绕过控制通道上限无限占内存。日志有独立预算及丢弃/截断诊断，不能无提示丢结构化错误。ACK 缺失可在同 attempt 内按协商策略重发精确批次，不推测对端已经发布。

控制通路自身超限、必需控制帧无法解析或连接失效时，宿主记录独立控制/传输诊断并按已登记停止权限封存受影响尝试，关闭其发布资格；取消/超时处理不等待数据 credit 恢复。期限或必要控制能力无法提供时拒绝相应任务配置，不能默认为无限等待。

支持模式的传播/迭代/候选/路径预算从 analysisProfile/budgetProfile 取得；超限按公共 truncations 记录并返回合法 partial。违反协商载荷/队列上限、必要帧不可解析或资源失败则封存 failed，并隔离数据；不把协议违约改名为正常分析截断。timeout/deadline 以宿主选定期限规则和观察记录判定，不比较 worker 壁钟来排序取消/完成。

## 6. 终态、取消、失败与发布

### 6.1 三种状态分别记录

| 状态记录 | 提议状态 | 含义 |
|---|---|---|
| worker 会话 | starting/negotiating/ready/closing/closed/rejected | 是否可接受任务；不代替任务结果 |
| worker task outcome | completed/partial/cancelled/timed_out/failed | task.finished 的执行观察；completed 也须完整性及清单核验 |
| HostAttemptRecord.decision | open/sealed_completed/sealed_partial/sealed_cancelled/sealed_timed_out/sealed_failed | 宿主唯一有效裁决；收到 finished 先进入校验，未封存仍可取消 |
| publicationState | staged/eligible/published/historical/isolated | historical 为被较新请求取代的合法完成结果，保留查询；isolated 为失败/非法/受限结果；ACK/worker outcome 不等于 published |

HostAttemptRecord 至少保存隔离键、冻结 requestFingerprint、publicationSlotId/requestId/requestGeneration、outputSetState、收到批次/终结申请、protocolIntegrity、semanticCompleteness、reasonClass、取消/超时/失败记录、裁决顺序及进程清理状态。同 attempt 完成与取消使用原子裁决；这不代替跨请求的最新世代比较，也不意味着 sealed_completed 必定能成为当前版本。

相同 task.finished 的 outcome/清单/计数/冻结引用重发幂等，仅留审计；后续终结变更这些内容属于矛盾终结，未封存尝试失败并保留双方，已封存尝试不重新打开或逆转裁决，另记协议诊断及重验需求。生产者清单已封存后不得追加新批次；已列精确批次的重发仍可幂等核对，未列批次报告越界输出。

收到 finished 后仍是 open/validating；校验失败封存 sealed_failed。校验通过后，宿主原子竞争 open→sealed_completed 或受许可的 sealed_partial：只有仍开放且冻结输入一致时成功。取消先被宿主接受，则 open→sealed_cancelled 并撤销本次发布资格；其后批次/finished 仅审计/隔离，不可能重新打开。若完成裁决已先封存，宿主取消结果为 already_terminal，不能回滚已发布完整版本。尚在 validating 的 finished 不能被当作已完成。

`HostCancelResult` 是宿主对用户/上层取消的裁决记录，至少含隔离键、cancelRequestId、status=accepted/already_terminal/unknown_attempt 和宿主 decision；它不是 W→H 的 cancel.ack。宿主已有封存完成裁决时可本地返回 already_terminal，无需再发 task.cancel。worker 的 cancel.ack=already_terminal 只说明 worker 已输出终结；宿主尚在 validating 时仍可接受取消并封存 sealed_cancelled。两者不能互相代用。

`task.cancel` 发送失败、cancel.ack 缺失或 worker 声称已完成都不撤销宿主封存。cancel.ack accepted 仅确认收到停止请求；worker 后续退出/终结及资源释放由宿主分别观察。超过停止期限时，宿主仅按已登记 worker 启停权限清理所属进程/任务资源，记录强制结束与剩余不确定状态；不操作目标工程或其他 worker。当前未验证具体跨平台进程清理实现。

若一个 worker 会话按协商并发承载多个活动 attempt，进程级强制结束影响全部同进程任务：取消者保留取消裁决，其他未封存尝试封存 failed 并记录关联进程/取消原因和结果隔离；依赖这些输出的快照完成受限。不能只报告一个任务已取消，同时让同进程其余任务继续假装运行或已完整。精确任务级停止只有实际执行模型能隔离并有证据时适用。

### 6.2 发布条件与恢复

| 情况 | 宿主结果处理 |
|---|---|
| 合法 completed，全部必需输出和引用闭合、Completeness.complete=true 且 current | 取得该快照范围完整发布资格；实际持久化/原子切换仍由快照事务实现验证，不由 worker 自动执行 |
| 合法 partial，allowPartial=true，所有传输/结构校验通过，存在明确语义缺口 | 封存 sealed_partial，标注未知/截断/未覆盖，仅用于明确部分视图与诊断，不替换原完整快照 |
| 传输/结构有效，但 allowPartial=false 且运行后出现语义缺口 | 保留 protocolIntegrity=valid、semanticCompleteness=incomplete，宿主 sealed_failed、reasonClass=semantic_incomplete；结构有效局部材料可独立隔离诊断，不作为受许可 partial 或完整结果 |
| 请求被拒绝、协议失败、取消、超时、崩溃/EOF 无有效终结 | 提供拒绝/失败诊断与有效局部隔离材料，保留上一个已发布完整快照；旧输入已变化时标 stale |
| open/validating 期间必要输入或配置变化 | 封存 sealed_failed 并记录输入变化原因，重新冻结后使用新 attempt；不得发布混合版本，不只更换标签 |
| sealed_completed 后、发布前输入变化或持久化/原子切换失败 | 执行裁决保持 sealed_completed，publicationState=isolated 并撤销 eligibility，记录输入变化/发布失败；保留旧已发布快照并重试，不逆转唯一终态或声称本次已发布 |
| 同一 publicationSlot 有较新的已登记请求，即使新请求后来失败/取消 | 执行裁决保留，旧请求合法结果改 historical/superseded_request；不得替换 current，最新世代不回退；历史结果及其精确证据仍可查 |
| 重启 worker / 重试任务 | 新会话或新 attempt 明确分配；旧消息不复用，新尝试重新发送完整冻结请求。缓存只按相同输入/身份登记/配置/组合/模式/预算及来源视图验证后复用 |

单 worker 的 completed 只覆盖它声明的输出范围；跨语言/跨工程快照还须核验所有必需 worker 和组合阶段及引用闭合，不能让先完成者发布整个工作区。部分模式、缺工具或零输出不算各语言深度准入。主视图、步骤绑定、矩阵、反查和诊断仍按相同快照原子发布，不根据消息分别更新互相矛盾的投影。

跨请求发布遵循[资源/快照契约 §6.2](M1-资源快照与规则组合契约.md#62-最后发起请求的发布资格r12)：同 workspace/发布 scope/来源视图共享槽位，不因规则组合或 profile 不同拆槽；宿主先持久登记最新发起世代，最终事务原子比较世代并切换指针。最新请求取消/拒绝/失败不授权旧请求补位。恢复必须保存最新发起世代和终态，不能只恢复最大已完成世代。自动重试保持原发布请求世代、新用户请求另增世代；每个 task 的旧 attempt 仍被隔离，不能借同一世代重新发布。

## 7. 读取、来源与扩展约束

任务只读取 inputRegistrations 明确登记且解析后仍在许可范围内的原始/语义输入；缺失输入输出 Diagnostic 和失败查询依赖，不启动构建、配置求值、目标进程、下载或云端调用来补齐。扩展启用也不能自行登记外部根；Web 证据展示范围仍独立核验，不因 worker 可读取就开放任意文件。

不同 sourceViewId 的结果独立暂存、校验与合并，完整 sourceClosure 随每条推导传递。自动任务不接受含分析时 AI/人工依赖的事实伪装为纯自动；运行观察单独视图。已独立验证固化的规则可在不调用 AI 的自动分析使用，但生成来源与验证报告仍留存。日志或进度不能成为源码/配置证据，独立评估答案不能进入 inputManifest 或身份登记。

扩展注册至少有 adapterId/namespace/version、所需协议/schema 配对、依赖模式和输入、声明输出类型、必要特性、验证报告/来源与启用配置指纹。语言/框架/协议适配器按设计分工，业务语义层由有据技术事实组织场景和步骤授权，不按扩展名称或文案授予权限。

`extensions[adapterNamespace]` 保存原生版本化信息；不得覆盖公共 scope、身份、resolution、条件、完整性或来源。宿主不识别的**必要**扩展/记录类型导致拒绝或失败；纯展示 optional 扩展可保存为不透明材料并给诊断，但不能参与确认推导或替代必需事实。扩展变化、停用及回退改变有效配置/规则组合指纹，按依赖重算；共享事实保留其他独立支持。

## 8. 后续实验与未决边界

| 工作包 | 尚须验证的内容 |
|---|---|
| M1-04 | 各语义栈真实 worker 的握手、必要输入/模式、原生/统一位置、调用/对象/身份事实及失败输出；不能用手写批次证明工具链可行 |
| M1-05/10 | 逐语言传播及业务/授权模式、必要条件、语义预算与超限规则；能力广告与真实输出核对 |
| M1-06/07 | 独立协议序列/真值、缺批/冲突/悬空引用/来源伪装/取消竞态等反例执行；协议控制序列不作为分析真值 |
| M1-08 | 候选分帧/序列化、进程启动/日志分离、控制通道背压、超时/崩溃清理、存储原子发布及恢复、平台/编码边界 |
| M1-09 | 据真实结果冻结版本配对、兼容/迁移、能力/支持单元、传输与预算、必要范围/选型决定及 G1 |

D02/D04/D06/D08/D10 等事项仍由 [待决策清单](../decisions/M1-待决策清单.md)准备实测依据；具体配置数字和依赖版本不由本文替用户决定。本轮可完成的是协议结构、正反例和文档复核，尚不能标 M1-03 的跨进程可复现验证或 G1 已通过。
