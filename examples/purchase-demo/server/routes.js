import { authenticate } from './auth.js';
import { authorizeSubmit, authorizeApprove, authorizeRead } from './policies.js';
import { DemoError } from './errors.js';

export function createRoutes({ repository, handlers }) {
  const routes = [
    // @evidence F.route.submit:start
    {
      method: 'POST', pattern: /^\/requests\/([^/]+)\/submit$/,
      execute(id, context) {
        const principal = authenticate(context);
        const request = repository.get(id);
        authorizeSubmit(principal, request);
        return handlers.submit(principal, request);
      },
    },
    // @evidence F.route.submit:end
    // @evidence F.route.approve:start
    {
      method: 'POST', pattern: /^\/requests\/([^/]+)\/approve$/,
      execute(id, context) {
        const principal = authenticate(context);
        const request = repository.get(id);
        authorizeApprove(principal, request);
        return handlers.approve(principal, request, context.receiptTarget);
      },
    },
    // @evidence F.route.approve:end
    // @evidence F.route.read:start
    {
      method: 'GET', pattern: /^\/requests\/([^/]+)$/,
      execute(id, context) {
        const principal = authenticate(context);
        const request = repository.get(id);
        authorizeRead(principal, request);
        return handlers.read(principal, request);
      },
    },
    // @evidence F.route.read:end
  ];

  return async function dispatch({ method, path, context }) {
    const route = routes.find(candidate => candidate.method === method && candidate.pattern.test(path));
    if (!route) throw new DemoError(404, 'ROUTE_NOT_FOUND', '入口不存在');
    const id = decodeURIComponent(path.match(route.pattern)[1]);
    return route.execute(id, context);
  };
}
