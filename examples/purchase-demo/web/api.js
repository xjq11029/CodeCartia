let demoSessionToken = 'demo-u1';

export function selectDemoSession(userId) {
  demoSessionToken = `demo-${userId}`;
}

async function request(method, path) {
  const response = await fetch(path, {
    method,
    headers: { 'x-demo-session': demoSessionToken },
  });
  const payload = await response.json();
  return { status: response.status, ...payload };
}

// @evidence F.client.submit:start
export function submitRequest(id) {
  return request('POST', `/requests/${encodeURIComponent(id)}/submit`);
}
// @evidence F.client.submit:end

// @evidence F.client.approve:start
export function approveRequest(id) {
  return request('POST', `/requests/${encodeURIComponent(id)}/approve`);
}
// @evidence F.client.approve:end

// @evidence F.client.read:start
export function readRequest(id) {
  return request('GET', `/requests/${encodeURIComponent(id)}`);
}
// @evidence F.client.read:end
