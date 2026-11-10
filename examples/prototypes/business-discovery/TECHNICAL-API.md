# 合成框架 API 的独立语义契约

这是随原始合成框架发布的技术接口文档，不是场景答案。两个工程均直接调用 `framework.py` 的以下 API：

- `register(method, address, handler)`：把三元组追加到模块的注册表；本实验仅发现这些模块顶层的字面量注册，不宣称实现 HTTP 分发。
- `enforce(subject, resource, predicate)`：谓词为假时抛出 `AccessRejected`，其基类为 `PermissionError`。该框架明确将此 API 定义为授权检查；主体与对象是 API 的前两个参数，不由变量名推断。
- `validate(resource, predicate)`：谓词为假时抛出 `InvalidOperation`，其基类为 `ValueError`。该框架明确将此 API 定义为业务前置校验。

提取器同时验证被登记函数及异常类的精确有限 AST 形状；仅配置相同名字、但源码行为不同，不能继续使用上述语义。源码注册、配置登记和本技术契约均进入指纹。该白名单是明确配置的合成 API 支持模式，不表示 Python 的任意 `PermissionError` 都是授权，也不表示任意 `ValueError` 都是业务校验。

配置不包含任何领域名、角色值、路由地址、场景名称或步骤清单。未登记且不能在有限模式内解释的守卫，保留 `unclassified-guard`；未知动态调用保留 `unknown-call`。不能把缺少框架契约的输入静默解释为允许。
