import { Store, ApiError } from './store.ts';

type Field = { name: string; alias: string; args: any; fields: Field[]; condition?: string; directives?: { name: string; args: any }[] };
type Operation = { name?: string; mutation: boolean; fields: Field[]; defaults: any };

class Parser {
  tokens: string[];
  at = 0;
  depth = 0;
  constructor(query: string) {
    this.tokens = query.match(/#[^\n]*|\.\.\.|"(?:\\.|[^"\\])*"|[A-Za-z_][\w]*|-?\d+(?:\.\d+)?|[!$():={}\[\]@|]/g)?.filter(t => !t.startsWith('#')) ?? [];
    if (this.tokens.length > 20000) throw new Error('Query is too large');
  }
  peek() { return this.tokens[this.at]; }
  take(expected?: string) { const t = this.tokens[this.at++]; if (!t || expected && t !== expected) throw new Error(`Expected ${expected ?? 'token'}, found ${t ?? 'end of query'}`); return t; }
  value(): any {
    const t = this.take();
    if (t === '$') return { variable: this.take() };
    if (t === '[') { const a = []; while (this.peek() !== ']') a.push(this.value()); this.take(']'); return a; }
    if (t === '{') { const o = {}; while (this.peek() !== '}') { const key = this.take(); this.take(':'); o[key] = this.value(); } this.take('}'); return o; }
    if (t[0] === '"') return JSON.parse(t);
    if (t === 'true') return true;
    if (t === 'false') return false;
    if (t === 'null') return null;
    if (/^-?\d/.test(t)) return Number(t);
    return t;
  }
  arguments() {
    const result = {};
    if (this.peek() !== '(') return result;
    this.take('(');
    while (this.peek() !== ')') { const key = this.take(); this.take(':'); result[key] = this.value(); }
    this.take(')'); return result;
  }
  fields(): Field[] {
    if (++this.depth > 64) throw new Error('Query is too deep');
    this.take('{'); const result: Field[] = [];
    while (this.peek() !== '}') {
      let name = this.take();
      if (name === '...') {
        if (this.peek() === 'on') { this.take(); const condition = this.take(); result.push({ name: '...', alias: '', args: {}, fields: this.fields(), condition }); }
        else result.push({ name: '...', alias: this.take(), args: {}, fields: [] });
        continue;
      }
      let alias = name;
      if (this.peek() === ':') { this.take(); name = this.take(); }
      const args = this.arguments(), directives: { name: string; args: any }[] = [];
      while (this.peek() === '@') { this.take(); directives.push({ name: this.take(), args: this.arguments() }); }
      const fields = this.peek() === '{' ? this.fields() : [];
      result.push({ name, alias, args, fields, directives });
    }
    this.take('}'); this.depth--; return result;
  }
  document() {
    const operations: Operation[] = [], fragments = new Map<string, Field[]>();
    while (this.peek()) {
      if (this.peek() === 'fragment') {
        this.take(); const name = this.take(); this.take('on'); this.take(); fragments.set(name, this.fields()); continue;
      }
      let name: string | undefined, mutation = false; const defaults = {};
      if (this.peek() !== '{') {
        const kind = this.take(); if (!['query', 'mutation'].includes(kind)) throw new Error(`Unknown operation ${kind}`);
        mutation = kind === 'mutation';
        if (this.peek() !== '(' && this.peek() !== '{') name = this.take();
        if (this.peek() === '(') {
          this.take();
          while (this.peek() !== ')') {
            this.take('$'); const key = this.take(); this.take(':');
            while (this.peek() && !['$', '=', ')'].includes(this.peek())) this.take();
            if (this.peek() === '=') { this.take(); defaults[key] = this.value(); }
          }
          this.take(')');
        }
      }
      operations.push({ name, mutation, defaults, fields: this.fields() });
    }
    return { operations, fragments };
  }
}

const schemas: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository', node: 'Node', __type: '__Type', __schema: '__Schema', search: 'SearchResultItemConnection' },
  Mutation: { createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload', reopenIssue: 'CloseIssuePayload', createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload', addComment: 'AddCommentPayload' },
  Repository: { id: 'ID', databaseId: 'Int', name: 'String', nameWithOwner: 'String', owner: 'User', defaultBranchRef: 'Ref', viewerPermission: 'RepositoryPermission', hasIssuesEnabled: 'Boolean', issue: 'Issue', issues: 'IssueConnection', pullRequests: 'PullRequestConnection', pullRequest: 'PullRequest', description: 'String', isPrivate: 'Boolean', url: 'String' },
  User: { id: 'ID', login: 'String', name: 'String' },
  Ref: { id: 'ID', name: 'String', target: 'Commit' },
  Commit: { oid: 'String', message: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'IssueState', comments: 'IssueCommentConnection', url: 'String', createdAt: 'String', repository: 'Repository' },
  PullRequest: { id: 'ID', number: 'Int', title: 'String', body: 'String', state: 'PullRequestState', merged: 'Boolean', headRefName: 'String', baseRefName: 'String', mergeable: 'MergeableState', files: 'PullRequestChangedFileConnection', url: 'String', repository: 'Repository' },
  IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', totalCount: 'Int', pageInfo: 'PageInfo' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', endCursor: 'String', startCursor: 'String' },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueCommentConnection: { nodes: 'IssueComment', totalCount: 'Int', pageInfo: 'PageInfo' },
  IssueComment: { id: 'ID', body: 'String' },
  __Type: { name: 'String', kind: 'String', fields: '__Field', enumValues: '__EnumValue' },
  __Field: { name: 'String', type: '__Type', isDeprecated: 'Boolean', deprecationReason: 'String', args: '__InputValue' },
  __InputValue: { name: 'String', type: '__Type' },
  __EnumValue: { name: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
  SearchResultItemConnection: { nodes: 'Issue', issueCount: 'Int', pageInfo: 'PageInfo' },
};
const enums = { SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'], IssueState: ['OPEN', 'CLOSED'], PullRequestState: ['OPEN', 'CLOSED', 'MERGED'], MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] };
const scalar = new Set(['ID', 'Int', 'String', 'Boolean', 'RepositoryPermission', 'IssueState', 'PullRequestState', 'MergeableState']);

function values(value: any, variables: any): any {
  if (Array.isArray(value)) return value.map(v => values(v, variables));
  if (value && typeof value === 'object') {
    if ('variable' in value) return variables[value.variable];
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, values(v, variables)]));
  }
  return value;
}
function connection(items: any[], args: any) {
  const offset = args.after ? Number(Buffer.from(args.after, 'base64').toString().split(':').at(-1)) : 0;
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid cursor');
  const first = Math.max(0, Math.min(100, args.first ?? 30)), nodes = items.slice(offset, offset + first);
  const cursor = (n: number) => Buffer.from(`cursor:${n}`).toString('base64');
  return { nodes, totalCount: items.length, edges: nodes.map((node, i) => ({ node, cursor: cursor(offset + i + 1) })), pageInfo: { hasNextPage: offset + nodes.length < items.length, hasPreviousPage: offset > 0, endCursor: nodes.length ? cursor(offset + nodes.length) : null, startCursor: nodes.length ? cursor(offset + 1) : null } };
}

export function graphql(store: Store, request: any): any {
  if (Array.isArray(request)) return request.map(r => graphql(store, r));
  try {
    if (typeof request.query !== 'string') throw new Error('query must be a string');
    const { operations, fragments } = new Parser(request.query).document();
    const op = request.operationName ? operations.find(o => o.name === request.operationName) : operations.length === 1 ? operations[0] : undefined;
    if (!op) throw new Error('An operation name is required');
    const vars = { ...op.defaults, ...request.variables };
    const errors: any[] = [];
    function validate(fields: Field[], type: string, active = new Set<string>()) {
      for (const f of fields) {
        if (f.name === '...') {
          if (f.condition) validate(f.fields, f.condition, active);
          else {
            if (!fragments.has(f.alias)) { errors.push({ message: `Unknown fragment "${f.alias}".` }); continue; }
            if (active.has(f.alias)) { errors.push({ message: `Fragment cycle at "${f.alias}".` }); continue; }
            const next = new Set(active); next.add(f.alias); validate(fragments.get(f.alias)!, type, next);
          }
          continue;
        }
        for (const d of f.directives ?? []) if (!['skip', 'include'].includes(d.name)) errors.push({ message: `Unknown directive "${d.name}".` });
        if (f.name === '__typename') continue;
        const child = schemas[type]?.[f.name];
        if (!child && type !== 'Node') errors.push({ message: `Cannot query field "${f.name}" on type "${type}".` });
        if (child && !scalar.has(child)) validate(f.fields, child, active);
        if (type === 'Node' && f.name !== 'id') errors.push({ message: `Cannot query field "${f.name}" on type "Node".` });
      }
    }
    validate(op.fields, op.mutation ? 'Mutation' : 'Query');
    if (errors.length) return { errors };
    const typeInfo = (name: string) => ({ name, kind: enums[name] ? 'ENUM' : 'OBJECT', fields: Object.entries(schemas[name] ?? {}).map(([name, type]) => ({ name, type: { name: type, kind: scalar.has(type) ? 'SCALAR' : 'OBJECT' }, isDeprecated: false, deprecationReason: null, args: [] })), enumValues: (enums[name] ?? []).map(name => ({ name, isDeprecated: false, deprecationReason: null })) });
    function resolve(type: string, parent: any, name: string, a: any): any {
      if (name === '__typename') return parent?._type ?? type;
      if (type === 'Query') {
        if (name === 'viewer') return store.user();
        if (name === 'repository') { try { return store.get(a.owner, a.name); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; } }
        if (name === 'node') return store.nodes.get(a.id) ?? null;
        if (name === '__type') return schemas[a.name] || enums[a.name] ? typeInfo(a.name) : null;
        if (name === '__schema') return { queryType: typeInfo('Query'), mutationType: typeInfo('Mutation'), types: Object.keys(schemas).map(typeInfo) };
        if (name === 'search') { const items = [...store.repos.values()].flatMap(r => [...r.issues.values()]).filter(i => i.title.includes(a.query ?? '')); return { ...connection(items, a), issueCount: items.length }; }
      }
      if (type === 'Mutation') {
        const i = a.input ?? {}, r = store.nodes.get(i.repositoryId);
        if (name === 'createIssue') { if (!r || r._type !== 'Repository') throw new Error('Unknown repository'); return { issue: store.createIssue(r, i), clientMutationId: i.clientMutationId }; }
        if (name === 'closeIssue' || name === 'reopenIssue') { const issue = store.nodes.get(i.issueId); if (!issue || issue._type !== 'Issue') throw new Error('Unknown issue'); store.patchIssue(issue._repo, issue, { state: name === 'closeIssue' ? 'closed' : 'open' }); return { issue, clientMutationId: i.clientMutationId }; }
        if (name === 'createPullRequest') { if (!r || r._type !== 'Repository') throw new Error('Unknown repository'); return { pullRequest: store.createPull(r, { ...i, head: i.headRefName, base: i.baseRefName }), clientMutationId: i.clientMutationId }; }
        if (name === 'mergePullRequest') { const p = store.nodes.get(i.pullRequestId); if (!p || p._type !== 'PullRequest') throw new Error('Unknown pull request'); store.mergePull(p._repo, p, i); return { pullRequest: p, clientMutationId: i.clientMutationId }; }
        if (name === 'addComment') { const issue = store.nodes.get(i.subjectId); if (!issue || issue._type !== 'Issue') throw new Error('Unknown subject'); return { commentEdge: { node: store.comment(issue._repo, issue, i.body) }, clientMutationId: i.clientMutationId }; }
      }
      if (name === 'id' && parent?.node_id) return parent.node_id;
      if (type === 'Repository') {
        if (name === 'databaseId') return parent.id;
        if (name === 'nameWithOwner') return parent.full_name;
        if (name === 'defaultBranchRef') return store.ref(parent) ? { name: parent.default_branch, target: { oid: store.ref(parent) } } : null;
        if (name === 'viewerPermission') return 'ADMIN';
        if (name === 'hasIssuesEnabled') return parent.has_issues;
        if (name === 'isPrivate') return parent.private;
        if (name === 'url') return `${store.origin}/${parent.full_name}`;
        if (name === 'issue') return parent.issues.get(a.number) ?? null;
        if (name === 'pullRequest') return parent.pulls.get(a.number) ?? null;
        if (name === 'issues' || name === 'pullRequests') {
          let items = [...(name === 'issues' ? parent.issues : parent.pulls).values()];
          if (a.states) items = items.filter(i => a.states.includes(i.merged ? 'MERGED' : i.state.toUpperCase()));
          items.sort((x, y) => a.orderBy?.direction === 'ASC' ? x.number - y.number : y.number - x.number);
          return connection(items, a);
        }
      }
      if (type === 'Issue' || type === 'PullRequest') {
        if (name === 'state') return parent.merged ? 'MERGED' : parent.state.toUpperCase();
        if (name === 'repository') return parent._repo;
        if (name === 'url') return `${store.origin}/${parent._repo.full_name}/${type === 'Issue' ? 'issues' : 'pull'}/${parent.number}`;
        if (name === 'createdAt') return parent.created_at;
        if (name === 'comments') return connection(parent._comments, a);
        if (name === 'headRefName') return parent.head.ref;
        if (name === 'baseRefName') return parent.base.ref;
        if (name === 'mergeable') return store.mergeTree(parent._repo, parent).conflict ? 'CONFLICTING' : 'MERGEABLE';
        if (name === 'files') return connection(store.pullChanges(parent._repo, parent), a);
      }
      return parent?.[name] ?? null;
    }
    function project(parent: any, type: string, fields: Field[]): any {
      if (parent === null || parent === undefined) return null;
      if (Array.isArray(parent)) return parent.map(p => project(p, p?._type ?? type, fields));
      const result = {};
      for (const f of fields) {
        if ((f.directives ?? []).some(d => d.name === 'skip' ? values(d.args, vars).if === true : values(d.args, vars).if === false)) continue;
        if (f.name === '...') { if (!f.condition || f.condition === parent._type || f.condition === type) Object.assign(result, project(parent, f.condition ?? type, f.fields.length ? f.fields : fragments.get(f.alias) ?? [])); continue; }
        const v = resolve(type, parent, f.name, values(f.args, vars));
        const next = v?._type ?? schemas[type]?.[f.name] ?? (f.name === 'id' ? 'ID' : 'String');
        result[f.alias] = f.fields.length ? project(v, next, f.fields) : v;
      }
      return result;
    }
    return { data: project({}, op.mutation ? 'Mutation' : 'Query', op.fields) };
  } catch (e: any) { return { data: null, errors: [{ message: e.message }] }; }
}
