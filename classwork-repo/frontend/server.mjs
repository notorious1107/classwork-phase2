import { createServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function createWebServer({ apiPort = 3001 } = {}) {
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'],
    '/student-roster-template.xlsx': ['student-roster-template.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] };
  return createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const upstream = request({ hostname: '127.0.0.1', port: apiPort, path: req.url,
        method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '作业服务未连接，请确认 API 已启动后重试' }));
      });
      req.on('aborted', () => upstream.destroy());
      req.pipe(upstream); return;
    }
    const entry = assets[req.url.split('?')[0]];
    if (!entry || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end('Not found'); return; }
    try {
      const data = await readFile(new URL(entry[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(500); res.end('无法读取页面'); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WEB_PORT || 5173);
  const server = createWebServer({ apiPort: Number(process.env.API_PORT || 3001) });
  server.listen(port, '127.0.0.1', () => console.log(`数学作业网站: http://127.0.0.1:${port}`));
  server.on('error', e => { console.error(e.message); process.exit(1); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
