import { REALM, USERS } from '../data/fixtures.js';
import { DemoError } from './errors.js';

// @evidence F.identity:start
// 合成认证：本地宿主预先建立演示会话。固定 token 可任意选择，不能用于生产。
export function createDemoSessions(users = USERS) {
  return new Map(users.map(user => {
    const principal = Object.freeze({
      id: user.id,
      realm: user.realm,
      tenant: user.tenant,
      roles: Object.freeze([...user.roles]),
      authenticated: true,
    });
    return [`demo-${user.id}`, Object.freeze({ principal, mode: 'synthetic-demo' })];
  }));
}

export function establishDemoContext(sessions, sessionToken) {
  return Object.freeze({ session: sessions.get(sessionToken) ?? null });
}

export function authenticate(context) {
  // 只读取宿主绑定的 session；不接收 body.userId/body.roles/body.tenant。
  const principal = context.session?.principal;
  if (!principal?.authenticated || principal.realm !== REALM) {
    throw new DemoError(401, 'AUTHENTICATION_REQUIRED', '需要有效的合成演示会话');
  }
  return principal;
}
// @evidence F.identity:end
