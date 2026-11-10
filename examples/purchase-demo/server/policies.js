import { ROLES } from '../data/fixtures.js';
import { DemoError } from './errors.js';

function requireAllowed(allowed, permission) {
  // B0：适用允许规则任一满足即允许；无匹配规则默认拒绝。
  if (!allowed) {
    throw new DemoError(403, 'FORBIDDEN', `未满足 ${permission} 的授权条件`);
  }
}

// @evidence F.policy.submit:start
export function authorizeSubmit(principal, request) {
  const allowed = principal.roles.includes(ROLES.employee)
    && principal.tenant === request.tenant
    && principal.id === request.owner;
  requireAllowed(allowed, 'request.submit');
}
// @evidence F.policy.submit:end

// @evidence F.policy.approve:start
export function authorizeApprove(principal, request) {
  const allowed = principal.roles.includes(ROLES.manager)
    && principal.tenant === request.tenant
    && principal.id !== request.owner;
  requireAllowed(allowed, 'request.approve');
}
// @evidence F.policy.approve:end

// @evidence F.policy.read:start
export function authorizeRead(principal, request) {
  const sameTenant = principal.tenant === request.tenant;
  const ownEmployeeRequest = principal.roles.includes(ROLES.employee)
    && principal.id === request.owner;
  const tenantReader = principal.roles.includes(ROLES.manager)
    || principal.roles.includes(ROLES.readonly);
  requireAllowed(sameTenant && (ownEmployeeRequest || tenantReader), 'request.read');
}
// @evidence F.policy.read:end
