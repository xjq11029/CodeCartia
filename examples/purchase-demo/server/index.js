import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createPurchaseApp } from './app.js';

const app = createPurchaseApp();
const files = new Map([
  ['/', ['../web/index.html', 'text/html; charset=utf-8']],
  ['/web/PurchasePage.js', ['../web/PurchasePage.js', 'text/javascript; charset=utf-8']],
  ['/web/api.js', ['../web/api.js', 'text/javascript; charset=utf-8']],
  ['/data/fixtures.js', ['../data/fixtures.js', 'text/javascript; charset=utf-8']],
]);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const staticFile = files.get(url.pathname);
    if (req.method === 'GET' && staticFile) {
      const content = await readFile(new URL(staticFile[0], import.meta.url));
      res.writeHead(200, { 'content-type': staticFile[1], 'cache-control': 'no-store' });
      res.end(content);
      return;
    }

    // 演示动作只使用路由 ID，无需请求体；即使自报身份也不会参与授权。
    req.resume();
    const result = await app.handle({
      method: req.method,
      path: url.pathname,
      sessionToken: req.headers['x-demo-session'],
      receiptTarget: req.headers['x-demo-receipt-target'],
    });
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(result.body));
  } catch {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'DEMO_INTERNAL_ERROR', message: '合成演示处理异常' }));
  }
}).listen(4100, '127.0.0.1', () => {
  console.log('B0 合成采购工程：http://127.0.0.1:4100（重启恢复初始数据）');
});
