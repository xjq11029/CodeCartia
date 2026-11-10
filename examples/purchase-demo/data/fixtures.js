export const REALM = 'realm-purchase';

// @evidence F.roles:start
export const ROLES = Object.freeze({
  employee: `${REALM}:employee`,
  manager: `${REALM}:manager`,
  readonly: `${REALM}:readonly`,
});

// 无角色继承；租户不是角色 ID 的组成部分。
export const USERS = Object.freeze([
  { id: 'u1', realm: REALM, tenant: 'T1', roles: [ROLES.employee] },
  { id: 'u2', realm: REALM, tenant: 'T1', roles: [ROLES.manager] },
  { id: 'u3', realm: REALM, tenant: 'T1', roles: [ROLES.readonly] },
  { id: 'u4', realm: REALM, tenant: 'T2', roles: [ROLES.manager] },
].map(user => Object.freeze({ ...user, roles: Object.freeze(user.roles) })));
// @evidence F.roles:end

// @evidence F.objects:start
export const REQUESTS = Object.freeze([
  { id: 'r1', owner: 'u1', tenant: 'T1', state: 'DRAFT', amount: 1000 },
  { id: 'r2', owner: 'u1', tenant: 'T1', state: 'SUBMITTED', amount: 1000 },
  { id: 'r3', owner: 'u1', tenant: 'T1', state: 'SUBMITTED', amount: 6000 },
  { id: 'r4', owner: 'u4', tenant: 'T2', state: 'SUBMITTED', amount: 1000 },
].map(Object.freeze));
// @evidence F.objects:end
