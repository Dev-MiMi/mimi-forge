import { createServer } from 'node:http';
import { Store, ApiError, rest } from './store.ts';
import { gitRequest } from './git.ts';
import { graphql } from './graphql.ts';
import { mcp } from './mcp.ts';

const store = new Store();
const token = process.env.MAKEFUN_SHOP_TOKEN ?? 'local-test-token';
const server = createServer(async (req, res) => {
  res.setHeader('X-GitHub-Request-Id', 'MIMI-FORGE');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (status: number, data: any) => { res.statusCode = status; res.end(status === 204 ? undefined : Buffer.isBuffer(data) ? data : JSON.stringify(data)); };
  try {
    const method = req.method ?? 'GET';
    const rawPath = req.url ?? '/';
    if (rawPath === '/healthz' && method === 'GET') { send(200, { ok: true }); return; }
    const auth = req.headers.authorization;
    const basic = auth?.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
    if (auth !== `Bearer ${token}` && basic !== token) { send(401, { message: 'Requires authentication' }); return; }
    const readIssue = method === 'GET' && /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\?.*)?$/.exec(rawPath);
    if (readIssue) {
      const repo = store.get(decodeURIComponent(readIssue[1]), decodeURIComponent(readIssue[2]));
      const issue = repo.issues.get(Number(readIssue[3]));
      if (!issue) throw new ApiError(404, 'Not Found');
      issue._buffer ??= Buffer.from(JSON.stringify(store.issueJson(issue)));
      send(200, issue._buffer); return;
    }
    const url = new URL(rawPath, store.origin || 'http://localhost');
    // Decode each URL component without letting an encoded slash change the API route.
    const path = url.pathname;
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024 * 1024) throw new ApiError(413, 'Request too large'); chunks.push(chunk); }
    const raw = Buffer.concat(chunks);
    const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (git) {
      const repo = store.get(decodeURIComponent(git[1]), decodeURIComponent(git[2])), service = git[3] === 'info/refs' ? url.searchParams.get('service') : git[3];
      if (!['git-upload-pack', 'git-receive-pack'].includes(service ?? '')) throw new ApiError(404, 'Unknown git service');
      const version2 = String(req.headers['git-protocol'] ?? '').split(':').includes('version=2');
      const data = gitRequest(repo, method, service!, version2, raw);
      res.setHeader('Content-Type', `application/x-${service}-${method === 'GET' ? 'advertisement' : 'result'}`);
      res.setHeader('Cache-Control', 'no-cache'); send(200, data); return;
    }
    let body: any = {};
    if (raw.length) {
      try { body = JSON.parse(raw.toString()); }
      catch { send(400, path === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : { message: 'Malformed JSON' }); return; }
    }
    if (path === '/api/graphql' && method === 'POST') { send(200, graphql(store, body)); return; }
    if (path === '/mcp' && method === 'POST') { const data = mcp(store, body); send(data === null ? 202 : 200, data); return; }
    if (path === '/mcp' && method === 'DELETE') { send(204, null); return; }
    if (path.startsWith('/api/v3/') || path === '/api/v3') {
      res.setHeader('X-OAuth-Scopes', 'repo, read:org');
      const query = Object.fromEntries(url.searchParams), result = rest(store, method, path.slice(7), query, body);
      if (Array.isArray(result.data)) {
        const perPage = Math.max(1, Math.min(100, Number(query.per_page) || 30)), page = Math.max(1, Number(query.page) || 1), count = result.data.length;
        result.data = result.data.slice((page - 1) * perPage, page * perPage);
        if (page * perPage < count) { const next = new URL(url); next.searchParams.set('page', String(page + 1)); next.searchParams.set('per_page', String(perPage)); res.setHeader('Link', `<${next}>; rel="next"`); }
      }
      send(result.status, result.data); return;
    }
    send(404, { message: 'Not Found' });
  } catch (e: any) {
    if (!res.headersSent) { res.setHeader('Content-Type', 'application/json; charset=utf-8'); send(e instanceof ApiError ? e.status : 400, { message: e.message || 'Bad Request' }); }
    else res.end();
  }
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;
server.on('clientError', (_err, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
server.listen(0, '0.0.0.0', async () => {
  const port = (server.address() as any).port;
  store.origin = `http://127.0.0.1:${port}`;
  console.log(`mimi-forge listening ${store.origin}`);
  const env = process.env.MAKEFUN_ENV_URL;
  if (!env) return;
  try {
    const registration = await fetch(`${env}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }), signal: AbortSignal.timeout(10000) });
    if (!registration.ok) throw new Error(`Registration failed: ${registration.status}`);
    for (;;) {
      try { const response = await fetch(`${env}/done`, { signal: AbortSignal.timeout(30000) }); const result: any = await response.json(); if (result.done === true) { server.closeAllConnections(); server.close(() => process.exit(0)); return; } }
      catch (e: any) { console.error(`Done poll: ${e.message}`); }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (e: any) { console.error(e.message); server.closeAllConnections(); server.close(() => process.exit(1)); }
});
process.on('SIGTERM', () => { server.closeAllConnections(); server.close(() => process.exit(0)); });
