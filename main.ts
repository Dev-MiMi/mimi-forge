import { Store, ApiError, rest } from './store.ts';
import { gitRequest } from './git.ts';
import { graphql } from './graphql.ts';
import { mcp } from './mcp.ts';
import { serve, type Request, type Response } from './http.ts';

const store = new Store();
const token = process.env.MAKEFUN_SHOP_TOKEN ?? 'local-test-token';
function handle(request: Request): Response {
  const { method, path: rawPath, headers, body: raw } = request;
  const answer = (status: number, data: any, headers?: Record<string, string>) => ({ status, data, headers });
  try {
    if (rawPath === '/healthz' && method === 'GET') return answer(200, { ok: true });
    const auth = headers.authorization;
    const basic = auth?.startsWith('Basic ') ? Buffer.from(auth.slice(6), 'base64').toString().split(':').slice(1).join(':') : '';
    if (auth !== `Bearer ${token}` && basic !== token) return answer(401, { message: 'Requires authentication' });
    const issueRead = method === 'GET' && /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)(?:\?.*)?$/.exec(rawPath);
    if (issueRead) {
      const repo = store.get(decodeURIComponent(issueRead[1]), decodeURIComponent(issueRead[2]));
      const issue = repo.issues.get(Number(issueRead[3]));
      if (!issue) throw new ApiError(404, 'Not Found');
      issue._buffer ??= Buffer.from(JSON.stringify(store.issueJson(issue)));
      return answer(200, issue._buffer);
    }
    const url = new URL(rawPath, store.origin), path = url.pathname;
    const git = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (git) {
      const repo = store.get(decodeURIComponent(git[1]), decodeURIComponent(git[2]));
      const service = git[3] === 'info/refs' ? url.searchParams.get('service') : git[3];
      if (!['git-upload-pack', 'git-receive-pack'].includes(service ?? '')) throw new ApiError(404, 'Unknown git service');
      if (git[3] === 'info/refs' ? method !== 'GET' : method !== 'POST') throw new ApiError(405, 'Method Not Allowed');
      return answer(200, gitRequest(repo, method, service!, String(headers['git-protocol'] ?? '').split(':').includes('version=2'), raw), { 'Content-Type': `application/x-${service}-${method === 'GET' ? 'advertisement' : 'result'}`, 'Cache-Control': 'no-cache' });
    }
    let body: any = {};
    if (raw.length) {
      try { body = JSON.parse(raw.toString()); }
      catch { return answer(400, path === '/mcp' ? { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } : { message: 'Malformed JSON' }); }
    }
    if (path === '/api/graphql' && method === 'POST') return answer(200, graphql(store, body));
    if (path === '/mcp' && method === 'POST') { const data = mcp(store, body); return answer(data === null ? 202 : 200, data); }
    if (path === '/mcp' && method === 'DELETE') return answer(204, null);
    if (path.startsWith('/api/v3/') || path === '/api/v3') {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'JSON body must be an object');
      const result = rest(store, method, path.slice(7), Object.fromEntries(url.searchParams), body);
      const responseHeaders: Record<string, string> = { 'X-OAuth-Scopes': 'repo, read:org' };
      if (Array.isArray(result.data)) {
        const query = url.searchParams, size = Number(query.get('per_page') ?? 30), number = Number(query.get('page') ?? 1);
        if (!Number.isInteger(size) || !Number.isInteger(number) || size < 1 || number < 1) throw new ApiError(422, 'Invalid pagination');
        const perPage = Math.min(100, size), page = number, count = result.data.length;
        result.data = result.data.slice((page - 1) * perPage, page * perPage);
        if (page * perPage < count) { const next = new URL(url); next.searchParams.set('page', String(page + 1)); next.searchParams.set('per_page', String(perPage)); responseHeaders.Link = `<${next}>; rel="next"`; }
      }
      return answer(result.status, result.data, responseHeaders);
    }
    return answer(404, { message: 'Not Found' });
  } catch (e: any) { return answer(e instanceof ApiError ? e.status : 400, { message: e.message || 'Bad Request' }); }
}

const transport = serve(handle, process.env.FORGE_HTTP_DRIVER ?? 'native');
transport.server.listen(0, '0.0.0.0', async () => {
  const port = (transport.server.address() as any).port;
  store.origin = `http://127.0.0.1:${port}`;
  console.log(`mimi-forge listening ${store.origin}`);
  const env = process.env.MAKEFUN_ENV_URL;
  if (!env) return;
  try {
    const registration = await fetch(`${env}/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ port }), signal: AbortSignal.timeout(10000) });
    if (!registration.ok) throw new Error(`Registration failed: ${registration.status}`);
    for (;;) {
      try { const response = await fetch(`${env}/done`, { signal: AbortSignal.timeout(30000) }); const result: any = await response.json(); if (result.done === true) { transport.close(() => process.exit(0)); return; } }
      catch (e: any) { console.error(`Done poll: ${e.message}`); }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  } catch (e: any) { console.error(e.message); transport.close(() => process.exit(1)); }
});
process.on('SIGTERM', () => transport.close(() => process.exit(0)));
