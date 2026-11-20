import { object, commitInfo, treeEntries, ancestor, ZERO, type GitObject } from './git.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export const requireValue = (value: any, name: string) => {
  if (typeof value !== 'string' || !value.trim()) throw new ApiError(422, `${name} is required`);
  return value;
};
export const gid = (type: string, id: number) => Buffer.from(`${type}:${id}`).toString('base64');
const FIXED_DATE = '2000-01-01T00:00:00Z';

export class Store {
  repos = new Map<string, any>();
  nodes = new Map<string, any>();
  sequence = 1;
  login = process.env.MAKEFUN_LOGIN ?? '';
  origin = '';
  user() { return { login: this.login || 'forge-user', id: 1, node_id: gid('User', 1), type: 'User' }; }
  bindOwner(owner: string, name: string) {
    // Opaque tokens may be paired with MAKEFUN_LOGIN. Without it the first repository
    // address establishes the single account identity; subsequent owners are rejected.
    if (!this.login && this.repos.has(name.toLowerCase())) {
      this.login = owner;
      for (const r of this.repos.values()) { r.owner = this.user(); r.full_name = `${owner}/${r.name}`; }
    }
  }
  get(owner: string, name: string) {
    this.bindOwner(owner, name);
    const repo = this.repos.get(name.toLowerCase());
    if (!repo || owner.toLowerCase() !== this.user().login.toLowerCase()) throw new ApiError(404, 'Not Found');
    return repo;
  }
  addNode(type: string, value: any) {
    value.id = this.sequence++; value.node_id = gid(type, value.id); value._type = type;
    this.nodes.set(value.node_id, value); return value;
  }
  createRepo(input: any) {
    const name = requireValue(input.name, 'name');
    if (!/^[\w.-]{1,100}$/.test(name)) throw new ApiError(422, 'Invalid repository name');
    if (this.repos.has(name.toLowerCase())) throw new ApiError(422, 'Repository already exists');
    const repo = this.addNode('Repository', {
      name, full_name: `${this.user().login}/${name}`, owner: this.user(), description: input.description ?? '',
      private: Boolean(input.private), default_branch: input.default_branch || 'main', has_issues: true,
      refs: new Map(), objects: new Map<string, GitObject>(), issues: new Map(), pulls: new Map(), labels: new Map(),
      comments: new Map(), nextNumber: 1, fetchCache: new Map(),
    });
    this.repos.set(name.toLowerCase(), repo);
    if (input.auto_init) this.commitFiles(repo, new Map([['README.md', { mode: '100644', oid: this.putObject(repo, 'blob', `# ${name}\n`) }]]), 'Initial commit', repo.default_branch);
    return repo;
  }
  repoJson(r: any) {
    const path = `${this.origin}/api/v3/repos/${r.full_name}`;
    return {
      id: r.id, node_id: r.node_id, name: r.name, full_name: r.full_name, owner: r.owner,
      private: r.private, description: r.description, default_branch: r.default_branch, has_issues: r.has_issues,
      url: path, html_url: `${this.origin}/${r.full_name}`, clone_url: `${this.origin}/${r.full_name}.git`,
      git_url: `${this.origin}/${r.full_name}.git`, archived: false, fork: false,
      open_issues_count: [...r.issues.values()].filter(i => i.state === 'open').length,
      created_at: FIXED_DATE, updated_at: FIXED_DATE, permissions: { admin: true, push: true, pull: true },
    };
  }
  putObject(r: any, type: string, data: string | Buffer) {
    const obj = object(type, data); r.objects.set(obj.oid, obj); return obj.oid;
  }
  ref(r: any, ref?: string) {
    const name = ref ?? r.default_branch;
    return r.refs.get(name) ?? r.refs.get(`refs/heads/${name}`) ?? r.refs.get(`refs/tags/${name}`) ?? (r.objects.has(name) ? name : undefined);
  }
  files(r: any, ref?: string): Map<string, any> {
    const root = commitInfo(r.objects.get(this.ref(r, ref))).tree;
    const result = new Map();
    const walk = (id: string, prefix: string) => {
      for (const entry of treeEntries(r.objects.get(id))) {
        const path = prefix + entry.name;
        if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, path + '/');
        else result.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(root, ''); return result;
  }
  buildTree(r: any, files: Map<string, any>) {
    const root = new Map();
    for (const [path, value] of files) {
      const parts = path.split('/'); let dir = root;
      for (const name of parts.slice(0, -1)) { if (!dir.has(name)) dir.set(name, new Map()); dir = dir.get(name); }
      dir.set(parts.at(-1), value);
    }
    const build = (dir: Map<string, any>): string => {
      const entries = [...dir].map(([name, value]) => value instanceof Map ? { name, mode: '40000', oid: build(value) } : { name, ...value });
      entries.sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.mode === '40000' ? '/' : '')), Buffer.from(b.name + (b.mode === '40000' ? '/' : ''))));
      return this.putObject(r, 'tree', Buffer.concat(entries.map(e => Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, 'hex')]))));
    };
    return build(root);
  }
  commitFiles(r: any, files: Map<string, any>, message: string, branch: string, parents?: string[], identity?: any) {
    const current = this.ref(r, branch);
    const tree = this.buildTree(r, files);
    const ancestors = parents ?? (current ? [current] : []);
    const who = identity ?? { name: this.user().login, email: `${this.user().login}@users.noreply.github.com` };
    const stamp = `${who.name} <${who.email}> 946684800 +0000`;
    const data = `tree ${tree}\n${ancestors.map(id => `parent ${id}\n`).join('')}author ${stamp}\ncommitter ${stamp}\n\n${message.replace(/\n?$/, '\n')}`;
    const sha = this.putObject(r, 'commit', data);
    r.refs.set(`refs/heads/${branch}`, sha); r.fetchCache.clear(); return sha;
  }
  contentJson(r: any, path: string, file: any, full = true) {
    const data = r.objects.get(file.oid)?.data ?? Buffer.alloc(0);
    return {
      type: 'file', name: path.split('/').at(-1), path, sha: file.oid, size: data.length,
      ...(full ? { content: data.toString('base64'), encoding: 'base64' } : {}),
      url: `${this.origin}/api/v3/repos/${r.full_name}/contents/${path}`, html_url: `${this.origin}/${r.full_name}/blob/${r.default_branch}/${path}`,
      download_url: `${this.origin}/api/v3/repos/${r.full_name}/contents/${path}`,
    };
  }
  getContent(r: any, path: string, ref?: string) {
    if (ref && !this.ref(r, ref)) throw new ApiError(404, 'Unknown ref');
    const files = this.files(r, ref), file = files.get(path);
    if (file) return this.contentJson(r, path, file);
    const prefix = path ? path.replace(/\/$/, '') + '/' : '';
    const entries = new Map();
    for (const [p, f] of files) {
      if (!p.startsWith(prefix)) continue;
      const suffix = p.slice(prefix.length), name = suffix.split('/')[0];
      if (suffix.includes('/')) entries.set(name, { type: 'dir', name, path: prefix + name, sha: commitInfo(r.objects.get(this.ref(r, ref))).tree, size: 0 });
      else entries.set(name, this.contentJson(r, p, f, false));
    }
    if (!entries.size) throw new ApiError(404, 'Not Found');
    return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  writeContent(r: any, path: string, input: any, remove = false) {
    if (!path || path.split('/').some(p => !p || p === '.' || p === '..' || p.includes('\0'))) throw new ApiError(422, 'Invalid path');
    const branch = input.branch ?? r.default_branch;
    if (branch !== r.default_branch && !this.ref(r, branch)) throw new ApiError(404, 'Unknown branch');
    const files = this.files(r, branch), old = files.get(path);
    if (remove && !old) throw new ApiError(404, 'Not Found');
    if (old && input.sha !== old.oid || !old && input.sha) throw new ApiError(409, 'SHA does not match');
    requireValue(input.message, 'message');
    if (remove) files.delete(path);
    else {
      if (typeof input.content !== 'string') throw new ApiError(422, 'content is required');
      files.set(path, { mode: old?.mode ?? '100644', oid: this.putObject(r, 'blob', Buffer.from(input.content, 'base64')) });
    }
    const sha = this.commitFiles(r, files, input.message, branch, undefined, input.committer ?? input.author);
    return { status: remove || old ? 200 : 201, data: { content: remove ? null : this.contentJson(r, path, files.get(path)), commit: this.commitJson(r, sha) } };
  }
  commitJson(r: any, sha: string) {
    const c = commitInfo(r.objects.get(sha));
    const person = (s: string) => { const m = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(s ?? ''); return { name: m?.[1] ?? this.user().login, email: m?.[2] ?? '', date: m ? new Date(Number(m[3]) * 1000).toISOString() : FIXED_DATE }; };
    return { sha, node_id: Buffer.from(`Commit:${sha}`).toString('base64'), url: `${this.origin}/api/v3/repos/${r.full_name}/commits/${sha}`,
      commit: { message: c.message.replace(/\n$/, ''), author: person(c.author), committer: person(c.committer), tree: { sha: c.tree } },
      message: c.message.replace(/\n$/, ''), tree: { sha: c.tree }, parents: c.parents.map(id => ({ sha: id })), author: this.user(), committer: this.user() };
  }
  commits(r: any, ref?: string) {
    const result = [], stack = [this.ref(r, ref)], seen = new Set();
    while (stack.length) { const id = stack.pop(); if (!id || seen.has(id)) continue; seen.add(id); const obj = r.objects.get(id); if (obj?.type !== 'commit') continue; result.push(this.commitJson(r, id)); stack.push(...commitInfo(obj).parents); }
    return result;
  }
  createIssue(r: any, input: any) {
    requireValue(input.title, 'title');
    const labels = (input.labels ?? []).map(l => typeof l === 'string' ? l : l.name);
    for (const name of labels) if (!r.labels.has(name)) throw new ApiError(422, `Label ${name} does not exist`);
    const issue = this.addNode('Issue', { number: r.nextNumber++, title: input.title, body: input.body ?? '', state: 'open', labels: labels.map(n => r.labels.get(n)), user: this.user(), comments: 0, _repo: r, _comments: [], created_at: FIXED_DATE, updated_at: FIXED_DATE, closed_at: null });
    r.issues.set(issue.number, issue); return issue;
  }
  issueJson(i: any) {
    if (i._json) return i._json;
    const { _repo, _comments, _type, _json, _buffer, ...data } = i;
    i._json = { ...data, url: `${this.origin}/api/v3/repos/${_repo.full_name}/issues/${i.number}`, html_url: `${this.origin}/${_repo.full_name}/issues/${i.number}` };
    return i._json;
  }
  patchIssue(r: any, i: any, input: any) {
    if (input.labels) for (const l of input.labels) if (!r.labels.has(typeof l === 'string' ? l : l.name)) throw new ApiError(422, 'Unknown label');
    i._json = undefined; i._buffer = undefined;
    for (const key of ['title', 'body']) if (input[key] !== undefined) i[key] = input[key];
    if (input.state !== undefined) { if (!['open', 'closed'].includes(input.state)) throw new ApiError(422, 'Invalid state'); i.state = input.state; i.closed_at = i.state === 'closed' ? FIXED_DATE : null; }
    if (input.labels) i.labels = input.labels.map(l => r.labels.get(typeof l === 'string' ? l : l.name));
    return i;
  }
  comment(r: any, issue: any, body: string) {
    requireValue(body, 'body');
    const c = this.addNode('IssueComment', { body, user: this.user(), created_at: FIXED_DATE, updated_at: FIXED_DATE, _repo: r, _issue: issue });
    issue._comments.push(c); issue.comments++; issue._json = undefined; issue._buffer = undefined; r.comments.set(c.id, c); return c;
  }
  commentJson(c: any) { return { id: c.id, node_id: c.node_id, body: c.body, user: c.user, created_at: c.created_at, updated_at: c.updated_at }; }
  listIssues(r: any, query: any) {
    const state = query.state ?? 'open', labels = (query.labels ?? '').split(',').filter(Boolean);
    return [...r.issues.values()].filter(i => (state === 'all' || i.state === state) && labels.every(l => i.labels.some(label => label.name === l))).sort((a, b) => query.direction === 'asc' ? a.number - b.number : b.number - a.number);
  }
  commonAncestor(r: any, a: string, b: string) {
    const seen = new Set(), stack = [a];
    while (stack.length) { const id = stack.pop(); if (!id || seen.has(id)) continue; seen.add(id); stack.push(...commitInfo(r.objects.get(id)).parents); }
    const queue = [b], visited = new Set();
    while (queue.length) { const id = queue.shift(); if (!id || visited.has(id)) continue; if (seen.has(id)) return id; visited.add(id); queue.push(...commitInfo(r.objects.get(id)).parents); }
    return undefined;
  }
  pullChanges(r: any, p: any) {
    const head = this.ref(r, p.head.ref), base = this.ref(r, p.base.ref);
    const common = this.commonAncestor(r, head, base), before = this.files(r, common ?? base), after = this.files(r, head);
    return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path)?.oid !== after.get(path)?.oid).sort().map(path => {
      const old = before.get(path), next = after.get(path);
      const a = r.objects.get(old?.oid)?.data.toString() ?? '', b = r.objects.get(next?.oid)?.data.toString() ?? '';
      const count = (s: string) => s ? s.split('\n').length - (s.endsWith('\n') ? 1 : 0) : 0;
      return { filename: path, path, sha: next?.oid ?? old?.oid, status: !old ? 'added' : !next ? 'removed' : 'modified', additions: count(b), deletions: count(a), changes: count(a) + count(b), patch: `@@ -1,${count(a)} +1,${count(b)} @@\n${a.split('\n').filter(Boolean).map(s => '-' + s).join('\n')}\n${b.split('\n').filter(Boolean).map(s => '+' + s).join('\n')}` };
    });
  }
  mergeTree(r: any, p: any) {
    const head = this.ref(r, p.head.ref), base = this.ref(r, p.base.ref), common = this.commonAncestor(r, head, base);
    const original = common ? this.files(r, common) : new Map(), a = this.files(r, base), b = this.files(r, head), merged = new Map(a);
    let conflict = false;
    for (const path of new Set([...original.keys(), ...a.keys(), ...b.keys()])) {
      const old = original.get(path)?.oid, av = a.get(path)?.oid, bv = b.get(path)?.oid;
      if (bv === old || av === bv) continue;
      if (av !== old) { conflict = true; continue; }
      if (b.has(path)) merged.set(path, b.get(path)); else merged.delete(path);
    }
    return { files: merged, conflict };
  }
  createPull(r: any, input: any) {
    requireValue(input.title, 'title'); const head = requireValue(input.head, 'head').split(':').at(-1), base = input.base ?? r.default_branch;
    if (!this.ref(r, head) || !this.ref(r, base)) throw new ApiError(422, 'Head or base ref does not exist');
    const p = this.addNode('PullRequest', { number: r.nextNumber++, title: input.title, body: input.body ?? '', state: 'open', merged: false, head: { ref: head, sha: this.ref(r, head) }, base: { ref: base, sha: this.ref(r, base) }, user: this.user(), _repo: r, created_at: FIXED_DATE, updated_at: FIXED_DATE, merged_at: null });
    r.pulls.set(p.number, p); return p;
  }
  pullJson(p: any) {
    const { _repo, _type, ...data } = p;
    return { ...data, mergeable: !this.mergeTree(_repo, p).conflict, mergeable_state: this.mergeTree(_repo, p).conflict ? 'dirty' : 'clean', url: `${this.origin}/api/v3/repos/${_repo.full_name}/pulls/${p.number}`, html_url: `${this.origin}/${_repo.full_name}/pull/${p.number}` };
  }
  mergePull(r: any, p: any, input: any = {}) {
    if (p.merged) return { sha: p.merge_commit_sha, merged: true, message: 'Already merged' };
    const tree = this.mergeTree(r, p);
    if (tree.conflict || p.state !== 'open') throw new ApiError(405, 'Pull request cannot be merged');
    if (input.sha && input.sha !== this.ref(r, p.head.ref)) throw new ApiError(409, 'Head SHA changed');
    const message = input.commit_title ?? `${p.title} (#${p.number})`;
    const sha = this.commitFiles(r, tree.files, message, p.base.ref, [this.ref(r, p.base.ref)]);
    p.merged = true; p.state = 'closed'; p.merged_at = FIXED_DATE; p.merge_commit_sha = sha;
    return { sha, merged: true, message: 'Pull Request successfully merged' };
  }
}

export function rest(store: Store, method: string, path: string, query: any, body: any): any {
  const parts = path.split('/').filter(Boolean).map(p => decodeURIComponent(p));
  const ok = (data: any, status = 200) => ({ status, data });
  if (!parts.length) return ok({ current_user_url: `${store.origin}/api/v3/user`, repository_url: `${store.origin}/api/v3/repos/{owner}/{repo}` });
  if (parts[0] === 'meta') return ok({ installed_version: 'mimi-forge-1.0' });
  if (parts[0] === 'user' && parts.length === 1 && method === 'GET') return ok(store.user());
  if (parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'POST') return ok(store.repoJson(store.createRepo(body)), 201);
    if (method === 'GET') return ok([...store.repos.values()].map(r => store.repoJson(r)));
  }
  if (parts[0] !== 'repos' || parts.length < 3) throw new ApiError(404, 'Not Found');
  const r = store.get(parts[1], parts[2]), route = parts[3], n = Number(parts[4]);
  if (!route) {
    if (method === 'GET') return ok(store.repoJson(r));
    if (method === 'PATCH') { for (const k of ['description', 'private', 'default_branch', 'has_issues']) if (body[k] !== undefined) r[k] = body[k]; return ok(store.repoJson(r)); }
    if (method === 'DELETE') { store.repos.delete(r.name.toLowerCase()); return ok(null, 204); }
  }
  if (route === 'contents') {
    const file = parts.slice(4).join('/');
    if (method === 'GET') return ok(store.getContent(r, file, query.ref));
    if (method === 'PUT' || method === 'DELETE') return store.writeContent(r, file, body, method === 'DELETE');
  }
  if (route === 'branches' && method === 'GET') {
    const branches = [...r.refs].filter(([ref]) => ref.startsWith('refs/heads/')).map(([ref, sha]) => ({ name: ref.slice(11), commit: { sha, url: `${store.origin}/api/v3/repos/${r.full_name}/commits/${sha}` }, protected: false }));
    if (parts[4]) { const branch = branches.find(b => b.name === parts.slice(4).join('/')); if (!branch) throw new ApiError(404, 'Not Found'); return ok(branch); }
    return ok(branches);
  }
  if (route === 'commits' && method === 'GET') {
    if (parts[4]) { const id = store.ref(r, parts.slice(4).join('/')); if (!id) throw new ApiError(404, 'Not Found'); return ok(store.commitJson(r, id)); }
    return ok(store.commits(r, query.sha));
  }
  if (route === 'git') {
    const sub = parts[4], ref = parts.slice(5).join('/');
    if ((sub === 'refs' || sub === 'ref') && method === 'POST') {
      if (!/^refs\/(heads|tags)\/[^\s]+$/.test(body.ref ?? '') || !r.objects.has(body.sha)) throw new ApiError(422, 'Invalid ref or SHA');
      if (r.refs.has(body.ref)) throw new ApiError(422, 'Reference already exists');
      r.refs.set(body.ref, body.sha); r.fetchCache.clear(); return ok({ ref: body.ref, object: { type: r.objects.get(body.sha).type, sha: body.sha } }, 201);
    }
    if (sub === 'refs' || sub === 'ref') {
      const key = `refs/${ref}`, sha = r.refs.get(key);
      if (!sha) throw new ApiError(404, 'Not Found');
      if (method === 'GET') return ok({ ref: key, object: { type: r.objects.get(sha).type, sha } });
      if (method === 'PATCH') { if (!r.objects.has(body.sha)) throw new ApiError(422, 'Unknown SHA'); if (!ancestor(r.objects, sha, body.sha)) throw new ApiError(422, 'Non-fast-forward'); r.refs.set(key, body.sha); r.fetchCache.clear(); return ok({ ref: key, object: { sha: body.sha, type: r.objects.get(body.sha).type } }); }
      if (method === 'DELETE') { r.refs.delete(key); r.fetchCache.clear(); return ok(null, 204); }
    }
    if (sub === 'commits' && method === 'GET' && r.objects.has(ref)) return ok(store.commitJson(r, ref));
  }
  if (route === 'labels') {
    if (method === 'POST') { const name = requireValue(body.name, 'name'); const l = { id: store.sequence++, name, color: body.color ?? 'ededed', description: body.description ?? '' }; r.labels.set(name, l); return ok(l, 201); }
    if (method === 'GET') return ok([...r.labels.values()]);
  }
  if (route === 'issues') {
    if (!parts[4]) {
      if (method === 'POST') return ok(store.issueJson(store.createIssue(r, body)), 201);
      if (method === 'GET') return ok(store.listIssues(r, query).map(i => store.issueJson(i)));
    }
    if (parts[4] === 'comments') {
      const c = r.comments.get(Number(parts[5])); if (!c) throw new ApiError(404, 'Not Found');
      if (method === 'PATCH') { c.body = requireValue(body.body, 'body'); return ok(store.commentJson(c)); }
      if (method === 'DELETE') { c._issue._comments = c._issue._comments.filter(v => v.id !== c.id); c._issue.comments--; c._issue._json = undefined; c._issue._buffer = undefined; r.comments.delete(c.id); return ok(null, 204); }
      if (method === 'GET') return ok(store.commentJson(c));
    }
    const i = r.issues.get(n); if (!i) throw new ApiError(404, 'Not Found');
    if (parts[5] === 'comments') {
      if (method === 'POST') return ok(store.commentJson(store.comment(r, i, body.body)), 201);
      if (method === 'GET') return ok(i._comments.map(c => store.commentJson(c)));
    }
    if (!parts[5]) {
      if (method === 'GET') return ok(store.issueJson(i));
      if (method === 'PATCH') return ok(store.issueJson(store.patchIssue(r, i, body)));
    }
  }
  if (route === 'pulls') {
    if (!parts[4]) {
      if (method === 'POST') return ok(store.pullJson(store.createPull(r, body)), 201);
      if (method === 'GET') return ok([...r.pulls.values()].filter(p => query.state === 'all' || p.state === (query.state ?? 'open')).sort((a, b) => b.number - a.number).map(p => store.pullJson(p)));
    }
    const p = r.pulls.get(n); if (!p) throw new ApiError(404, 'Not Found');
    if (parts[5] === 'merge') {
      if (method === 'PUT') return ok(store.mergePull(r, p, body));
      if (method === 'GET') return ok(null, p.merged ? 204 : 404);
    }
    if (parts[5] === 'files' && method === 'GET') return ok(store.pullChanges(r, p));
    if (!parts[5] && method === 'GET') return ok(store.pullJson(p));
  }
  throw new ApiError(404, 'Not Found');
}
