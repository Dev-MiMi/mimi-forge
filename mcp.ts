import { Store, ApiError } from './store.ts';

const definitions = [
  ['create_repo', 'Create a repository owned by the authenticated user.', { name: 'string', description: 'string', private: 'boolean' }, ['name']],
  ['get_repo', 'Read a repository and its stable identifiers.', { owner: 'string', repo: 'string' }, ['owner', 'repo']],
  ['create_issue', 'Create an open issue in a repository.', { owner: 'string', repo: 'string', title: 'string', body: 'string' }, ['owner', 'repo', 'title']],
  ['list_issues', 'List repository issues filtered by open, closed or all states.', { owner: 'string', repo: 'string', state: 'string' }, ['owner', 'repo']],
  ['create_pull_request', 'Open a pull request from an existing head branch into a base branch.', { owner: 'string', repo: 'string', title: 'string', head: 'string', base: 'string', body: 'string' }, ['owner', 'repo', 'title', 'head', 'base']],
  ['merge_pull_request', 'Squash a mergeable pull request into its base branch.', { owner: 'string', repo: 'string', pull_number: 'integer' }, ['owner', 'repo', 'pull_number']],
] as const;
const tools = definitions.map(([name, description, props, required]) => ({ name, description, inputSchema: { type: 'object', properties: Object.fromEntries(Object.entries(props).map(([name, type]) => [name, { type, description: name.replace(/_/g, ' ') }])), required: [...required] } }));

export function mcp(store: Store, request: any): any {
  if (Array.isArray(request)) return request.map(r => mcp(store, r)).filter(Boolean);
  const id = request?.id ?? null;
  const result = (value: any) => ({ jsonrpc: '2.0', id, result: value });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (request?.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(-32600, 'Invalid Request');
  const params = request.params ?? {};
  if (request.method.startsWith('notifications/')) return null;
  if (request.method === 'server/discover') return result({ supportedVersions: ['2026-07-28', '2025-11-25', '2025-03-26'], serverInfo: { name: 'mimi-forge', version: '1.0.0' }, capabilities: { tools: { listChanged: false } } });
  if (request.method === 'initialize') return result({ protocolVersion: ['2026-07-28', '2025-11-25', '2025-03-26', '2024-11-05'].includes(params.protocolVersion) ? params.protocolVersion : '2026-07-28', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'mimi-forge', version: '1.0.0' }, instructions: 'Git, REST and these tools share one repository store.' });
  if (request.method === 'ping') return result({});
  if (request.method === 'tools/list') return result({ tools });
  if (request.method !== 'tools/call') return error(-32601, 'Method not found');
  const def = tools.find(t => t.name === params.name);
  if (!def) return error(-32602, 'Unknown tool');
  const args = params.arguments ?? {};
  for (const name of def.inputSchema.required) {
    const type = def.inputSchema.properties[name].type;
    if (type === 'integer' ? !Number.isInteger(args[name]) || args[name] < 1 : typeof args[name] !== type || type === 'string' && !args[name].trim()) return error(-32602, `Missing or invalid argument: ${name}`);
  }
  try {
    let data: any;
    if (params.name === 'create_repo') data = store.repoJson(store.createRepo(args));
    else {
      const r = store.get(args.owner, args.repo);
      if (params.name === 'get_repo') data = store.repoJson(r);
      if (params.name === 'create_issue') data = store.issueJson(store.createIssue(r, args));
      if (params.name === 'list_issues') data = store.listIssues(r, args).map(i => store.issueJson(i));
      if (params.name === 'create_pull_request') data = store.pullJson(store.createPull(r, args));
      if (params.name === 'merge_pull_request') { const p = r.pulls.get(args.pull_number); if (!p) throw new ApiError(404, 'Unknown pull request'); data = store.mergePull(r, p); }
    }
    return result({ content: [{ type: 'text', text: JSON.stringify(data) }], isError: false });
  } catch (e: any) { return result({ content: [{ type: 'text', text: e.message }], isError: true }); }
}
