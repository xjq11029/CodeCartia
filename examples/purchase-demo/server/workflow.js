import { readFileSync } from 'node:fs';
import { USERS } from '../data/fixtures.js';

// @evidence F.workflow.load:start
export function loadWorkflow() {
  const config = JSON.parse(readFileSync(
    new URL('../config/workflow.json', import.meta.url), 'utf8',
  ));
  return createWorkflow(config);
}
// @evidence F.workflow.load:end

export function createWorkflow(config, users = USERS) {
  // @evidence F.workflow.candidates:start
  // 配置参与实际候选人选择；候选身份不额外授予任何后端操作权限。
  // 原始配置证据还包含 config/workflow.json 全文件。
  function candidatesFor(actor, request) {
    const mappedRoles = config.actorBindings[actor] ?? [];
    return users.filter(user => user.realm === config.realm
      && user.tenant === request.tenant
      && user.roles.some(role => mappedRoles.includes(role)))
      .map(user => user.id);
  }
  // @evidence F.workflow.candidates:end
  return { candidatesFor };
}
