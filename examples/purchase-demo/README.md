# B0 合成采购示例工程

这是供 CodeCartia HTML 体验原型嵌入、阅读和定位的**真实示例源码**，也可独立运行。它是被阅读的目标工程，不是 CodeCartia 分析器；目录内的原生 JavaScript 技术选择不代表 CodeCartia 产品选型。没有第三方依赖、真实账号、邮件发送或外部请求。

示例实现 `docs/CodeCartia-业务场景与权限验收样例.md` v0.3 中 B0 的三条路径，并执行下面列出的公开功能测试。**没有执行 CodeCartia 自动静态分析，没有取得 BS01–BS05 / AP01–AP07 的完整验收结果，也不是独立保留测试集。** HTML 体验原型只嵌入源码，不调用这个示例服务。

## 运行与验证

在本目录 `examples/purchase-demo/` 执行，需要 Node.js 20 或更新版本和 pnpm：

```powershell
pnpm test
pnpm evidence
pnpm start
```

无需安装依赖。`pnpm test` 在同一 Node 进程直接执行 `test/purchase.test.js`，使用内置 `node:test`，无需派生隔离子进程；`pnpm evidence` 生成 `evidence-map.json`，登记逻辑证据标签、精确源码行范围和文件 SHA-256；它只按开发者声明的标签生成位置索引，不进行代码分析，也不是验收真值。

`pnpm start` 将简易采购运行页面开放在 `http://127.0.0.1:4100/`，可选择 u1–u4 和 r1–r4 后读取、提交或审批。审批按钮只按 `manager` 显示，操作是否允许仍取决于后端策略及业务条件。对象选择框显示初始值，当前状态以读取结果为准。数据仅在内存中保存，刷新浏览器保留当前服务进程的状态，重启服务恢复 B0。测试也可调用 `app.reset()` 独立重置。

## 合成身份、业务路径与边界

<!-- @evidence F.doc.flow:start -->
提交采购申请由同租户且为申请所有者的 employee 发起；只有 DRAFT 且金额大于 0 的申请可转为 SUBMITTED，并通过共享审计函数记录提交。

审批采购申请要求同租户、非申请所有者的 manager。通过授权后，只有 SUBMITTED 且金额不超过 5000 元的申请可审批。APPROVED 状态与审批审计在同一个同步内存事务中提交；审计写入或事务提交失败则整个副本丢弃，不留下成功状态或审计。事务成功后调用回执：回执失败仅记录错误，已提交审批不回滚。

读取采购申请允许 employee 读取同租户自己的申请，manager 与 readonly 读取同租户申请。共享仓储和审计函数不会自动把这三个动作串成必然执行的完整流程。
<!-- @evidence F.doc.flow:end -->

身份域为 `realm-purchase`，角色 ID 带该域，租户另行检查，没有默认角色继承。宿主预先建立 `demo-u1` 至 `demo-u4` 固定合成会话；本地页面通过 `x-demo-session` 选择会话，路由从已绑定的会话上下文取得主体。请求体中的 userId、roles、tenant、owner、amount 不参与身份或资源绑定。**这些可任意选择的演示 token 不能用于生产认证。**

| 主体 | 角色 | 租户 |
|---|---|---|
| u1 | employee | T1 |
| u2 | manager | T1 |
| u3 | readonly | T1 |
| u4 | manager | T2 |

| 申请 | 所有者 | 租户 | 初始状态 | 金额（测试指定元） |
|---|---|---|---|---|
| r1 | u1 | T1 | DRAFT | 1000 |
| r2 | u1 | T1 | SUBMITTED | 1000 |
| r3 | u1 | T1 | SUBMITTED | 6000 |
| r4 | u4 | T2 | SUBMITTED | 1000 |

工作流实际读取 `config/workflow.json`：申请人候选映射 employee，审批人候选映射 manager，观察者候选映射 manager/readonly。处理器调用候选人选择器生成响应中的候选列表；候选人配置不授予操作权限。审批候选即使包含申请所有者，也仍受后端禁止自审的授权约束。

仓储的“提交”只指当前进程内的原子状态替换，不提供数据库或磁盘耐久性。事务回调是同步的，回执才是异步调用。回执“sent”只说明内存模拟记录写入成功，不能证明邮件或其他外部通知送达。故障注入仅供测试编排，未挂载为 HTTP 接口。

## 源码入口和证据

```text
purchase-demo/
├─ package.json
├─ README.md
├─ evidence-map.json              # pnpm evidence 生成的位置和指纹索引
├─ data/fixtures.js               # F.roles、F.objects：B0 合成输入
├─ config/
│  ├─ workflow.json               # 真实参与者角色映射配置
│  └─ declarations.js             # 独立未引用声明，原型诊断扩展
├─ web/
│  ├─ index.html                  # 简易运行页面
│  ├─ PurchasePage.js             # F.ui.approve：只看 manager 的按钮可见性
│  └─ api.js                      # F.client.submit / approve / read
├─ server/
│  ├─ index.js                    # 本地 HTTP 宿主与静态页面入口
│  ├─ app.js                      # 内存实例、会话上下文、路由装配与重置
│  ├─ routes.js                   # F.route.*：认证 → 资源绑定 → 授权 → 处理器
│  ├─ auth.js                     # F.identity：合成会话与认证上下文
│  ├─ policies.js                 # F.policy.submit / approve / read
│  ├─ handlers.js                 # F.handler.*、F.commit.submit、F.tx.approve
│  ├─ repository.js               # 同步副本事务，原子替换已提交状态
│  ├─ audit.js                    # F.audit：提交与审批共用的事务内审计
│  ├─ receipt.js                  # F.receipt：合成发送、失败记录、重置
│  ├─ workflow.js                 # F.workflow.load、F.workflow.candidates
│  └─ errors.js                   # 授权、业务与事务错误的状态/代码
├─ scripts/build-evidence.mjs     # 标签 → 行范围/文件 SHA-256
└─ test/purchase.test.js          # 内置测试器的公开功能用例
```

每个逻辑段使用成对 `// @evidence F.xxx:start` / `// @evidence F.xxx:end` 注释，可用于 HTML 原型定位。工作流 JSON 全文件使用唯一位置映射 `F.workflow.actor-bindings`，索引另提供同位置的 `F.workflow.config` 别名；实际候选选择对应 loader 中 `F.workflow.candidates`。业务描述 `F.doc.flow` 使用本 README 中的成对 HTML 注释；它是文档解释，需与源码事实分开呈现。

## 原型诊断扩展

除 B0 运行路径外，本目录有两个供体验原型展示边界的独立扩展，均不改变 B0 的角色、授权与业务条件：

- `config/declarations.js` 的 `F.declaration.unassociated` 仅导出孤立的 `auditor` / `request.export` 允许声明，没有被入口、策略、工作流或处理器引用。它不证明存在导出业务，也不授予 u1–u4 新权限。
- `server/receipt.js` 的 `F.receipt.target` 接收运行时目的地标签，只将标签记入内存。宿主通过 `app.handle({ receiptTarget })` 或 `x-demo-receipt-target` 传入，缺省标签为 `demo-memory-inbox`。原型未静态求取所有可能的运行时目的地，不能从这个参数推断外部收件人、邮件系统或真实送达。该扩展不添加网络请求。

## 已覆盖的功能验证范围

测试覆盖 B0 的 u1–u4 × r1–r4 在三个动作中的 48 个结果组合、三个入口的认证拒绝、请求体伪造不改变身份或资源、提交状态/金额规则、审批状态/金额规则、共享审计、禁止自审、同租户他人数据限制、事务提交/审计失败、回执失败不回滚、重复操作、配置候选不授予权限、实例隔离与重置。

已在 Node.js v24.11.0、pnpm 10.20.0 上执行 `pnpm test`，24 项测试全部通过；`pnpm evidence` 成功生成 31 个证据标签。`pnpm start` 的本地 HTTP 冒烟已验证 HTML、三个浏览器模块、r2 从 SUBMITTED 审批为 APPROVED 后的读取，以及跨租户审批返回 403。示例服务在验证后已停止，需自行执行 `pnpm start` 启动。

额外的 r5 自审、r6 employee 读取他人申请、金额边界和候选配置替换属于本示例功能测试的独立局部变体，不与 B0 原始源码快照合并。未实现 BS/AP 中的消息入口、角色继承、有序策略、外部策略、完整未关联诊断验收、增量分析、AI/人工覆盖或导出评估；上文的孤立权限声明扩展仅提供原始输入。
