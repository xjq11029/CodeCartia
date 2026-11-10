import { ROLES, USERS, REQUESTS } from '../data/fixtures.js';
import { selectDemoSession, submitRequest, approveRequest, readRequest } from './api.js';

const userSelect = document.querySelector('#user');
const requestSelect = document.querySelector('#request');
const output = document.querySelector('#output');
const approveButton = document.querySelector('#approve');

for (const user of USERS) {
  userSelect.add(new Option(`${user.id} · ${user.roles[0]} · ${user.tenant}`, user.id));
}
for (const request of REQUESTS) {
  requestSelect.add(new Option(
    `${request.id} · ${request.state} · ${request.amount} 元 · ${request.tenant}`, request.id,
  ));
}

// @evidence F.ui.approve:start
function refreshApprovalVisibility() {
  const user = USERS.find(candidate => candidate.id === userSelect.value);
  // 可见性只看 manager；租户、所有者、状态、金额全部由后端另行检查。
  approveButton.hidden = !user.roles.includes(ROLES.manager);
}
// @evidence F.ui.approve:end

userSelect.addEventListener('change', () => {
  selectDemoSession(userSelect.value);
  refreshApprovalVisibility();
});

async function run(action) {
  try {
    output.textContent = JSON.stringify(await action(requestSelect.value), null, 2);
  } catch (error) {
    output.textContent = `本地演示请求失败：${error.message}`;
  }
}

// @evidence F.ui.actions:start
document.querySelector('#submit').addEventListener('click', () => run(submitRequest));
document.querySelector('#read').addEventListener('click', () => run(readRequest));
approveButton.addEventListener('click', () => run(approveRequest));
// @evidence F.ui.actions:end
refreshApprovalVisibility();
