// @evidence F.declaration.unassociated:start
// 原型诊断扩展：该声明没有被入口、策略、候选配置或处理器引用。
// 声明本身不建立导出业务，也不授予 B0 中任何主体操作权限。
export const UNASSOCIATED_DECLARATION = Object.freeze({
  role: 'realm-purchase:auditor',
  permission: 'request.export',
  effect: 'allow',
});
// @evidence F.declaration.unassociated:end
