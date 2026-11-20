import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { object, hash, readPack, writePack, gitRequest, pkt, FLUSH, ZERO, commitInfo } from '../git.ts';
import { Store, rest } from '../store.ts';
import { graphql } from '../graphql.ts';
import { mcp } from '../mcp.ts';

function fixture() {
  const store = new Store(); store.login = 'mimi'; store.origin = 'http://localhost';
  const repo = store.createRepo({ name: 'example', auto_init: true });
  return { store, repo };
}
function put(store: Store, repo: any, path: string, content: string, branch = 'main') {
  const old = store.files(repo, branch).get(path);
  return store.writeContent(repo, path, { content: Buffer.from(content).toString('base64'), message: 'Update content', branch, sha: old?.oid });
}

test('packs preserve exact binary bytes and reject corrupt checksums', () => {
  const blob = object('blob', Buffer.from([0, 255, 13, 10, 128]));
  const pack = writePack([blob]);
  assert.deepEqual(readPack(pack, new Map())[0].data, blob.data);
  const corrupt = Buffer.from(pack); corrupt[15] ^= 1;
  assert.throws(() => readPack(corrupt, new Map()), /checksum/);
});

test('receive-pack resolves a REF_DELTA from an existing base', () => {
  const base = object('blob', 'hello world\n');
  const delta = Buffer.from([12, 13, 0x90, 6, 7, ...Buffer.from('planet\n')]);
  const h = Buffer.alloc(12); h.write('PACK'); h.writeUInt32BE(2, 4); h.writeUInt32BE(1, 8);
  const payload = Buffer.concat([h, Buffer.from([0x70 | delta.length]), Buffer.from(base.oid, 'hex'), deflateSync(delta)]);
  const pack = Buffer.concat([payload, Buffer.from(hash(payload), 'hex')]);
  const decoded = readPack(pack, new Map([[base.oid, base]]));
  assert.equal(decoded[0].type, 'blob');
  assert.equal(decoded[0].data.toString(), 'hello planet\n');
});

test('stale contents writes leave branch state unchanged and encoded slash stays in branch name', () => {
  const { store, repo } = fixture();
  put(store, repo, 'nested/file.bin', 'hello');
  const tip = store.ref(repo), sha = store.files(repo).get('nested/file.bin').oid;
  assert.throws(() => store.writeContent(repo, 'nested/file.bin', { sha: ZERO, message: 'stale', content: 'YQ==' }), /SHA/);
  assert.equal(store.ref(repo), tip);
  rest(store, 'POST', '/repos/mimi/example/git/refs', {}, { ref: 'refs/heads/feature/test', sha: tip });
  assert.equal(rest(store, 'GET', '/repos/mimi/example/git/ref/heads/feature%2Ftest', {}, {}).data.object.sha, tip);
  assert.throws(() => store.get('other', 'example'), /Not Found/);
  assert.equal(store.getContent(repo, 'nested/file.bin').sha, sha);
});

test('squash merges preserve changes made on both branches and detect conflicts', () => {
  const { store, repo } = fixture();
  const root = store.ref(repo);
  repo.refs.set('refs/heads/feature', root);
  put(store, repo, 'feature.txt', 'feature\n', 'feature');
  put(store, repo, 'base.txt', 'base\n');
  const prior = store.ref(repo);
  const pull = store.createPull(repo, { title: 'Feature', head: 'feature', base: 'main' });
  const result = store.mergePull(repo, pull);
  assert.deepEqual([...store.files(repo).keys()].sort(), ['README.md', 'base.txt', 'feature.txt']);
  assert.deepEqual(commitInfo(repo.objects.get(result.sha)).parents, [prior]);
  assert.equal(pull.state, 'closed');
  repo.refs.set('refs/heads/conflict', result.sha);
  put(store, repo, 'base.txt', 'head change\n', 'conflict');
  put(store, repo, 'base.txt', 'base change\n');
  const conflicting = store.createPull(repo, { title: 'Conflict', head: 'conflict', base: 'main' });
  const before = store.ref(repo);
  assert.throws(() => store.mergePull(repo, conflicting), /cannot be merged/);
  assert.equal(store.ref(repo), before);
});

test('mixed pushes report each ref independently without moving a refused branch', () => {
  const { store, repo } = fixture();
  const root = store.ref(repo);
  repo.refs.set('refs/heads/side', root);
  put(store, repo, 'one', '1'); const second = store.ref(repo);
  repo.refs.set('refs/heads/side', second);
  put(store, repo, 'two', '2'); const forward = store.ref(repo);
  repo.refs.set('refs/heads/branch', root); put(store, repo, 'sibling', '3', 'branch'); const sibling = store.ref(repo, 'branch');
  repo.refs.set('refs/heads/main', second);
  const body = Buffer.concat([pkt(`${second} ${forward} refs/heads/main\0report-status\n`), pkt(`${second} ${sibling} refs/heads/side\n`), FLUSH, writePack([])]);
  const result = gitRequest(repo, 'POST', 'git-receive-pack', false, body).toString();
  assert.match(result, /ok refs\/heads\/main/);
  assert.match(result, /ng refs\/heads\/side non-fast-forward/);
  assert.equal(store.ref(repo), forward); assert.equal(store.ref(repo, 'side'), second);
});

test('GraphQL aliases, fragments, variables, batch order and shared MCP identities', () => {
  const { store, repo } = fixture();
  const response = mcp(store, { jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'mimi', repo: 'example', title: 'From MCP', body: 'body' } } });
  const issue = JSON.parse(response.result.content[0].text);
  const query = 'query Read($owner: String!, $name: String!) { r: repository(owner:$owner,name:$name) { ...R issue(number:1) { id title } } } fragment R on Repository { name nameWithOwner }';
  const result = graphql(store, { query, variables: { owner: 'mimi', name: 'example' } });
  assert.equal(result.data.r.name, repo.name);
  assert.equal(result.data.r.issue.id, issue.node_id);
  assert.equal(result.data.r.issue.title, 'From MCP');
  const invalid = graphql(store, { query: 'mutation { createIssue(input:{repositoryId:"bad",title:"bad"}) { issue { nonexistent } } }' });
  assert.match(invalid.errors[0].message, /nonexistent/);
  const batched = graphql(store, [{ query: '{ viewer { login } }' }, { query: '{ repository(owner:"missing",name:"no") { name } }' }]);
  assert.equal(batched[0].data.viewer.login, 'mimi'); assert.equal(batched[1].data.repository, null);
  assert.equal(mcp(store, { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'get_repo', arguments: {} } }).error.code, -32602);
});

test('identical sequences generate identical content and global ids', () => {
  const run = () => {
    const { store, repo } = fixture();
    put(store, repo, 'file', 'replay\n');
    const issue = store.createIssue(repo, { title: 'Replay' });
    return JSON.stringify({ repo: store.repoJson(repo), issue: store.issueJson(issue), tip: store.ref(repo), pack: writePack([...repo.objects.values()]).toString('base64') });
  };
  assert.equal(run(), run());
});

test('incomplete commit graphs are refused without moving an existing branch', () => {
  const { store, repo } = fixture();
  const root = store.ref(repo);
  const commit = object('commit', `tree ${ZERO}\nparent ${root}\nauthor mimi <mimi@example.invalid> 0 +0000\ncommitter mimi <mimi@example.invalid> 0 +0000\n\nMissing tree\n`);
  const body = Buffer.concat([pkt(`${root} ${commit.oid} refs/heads/main\0report-status\n`), FLUSH, writePack([commit])]);
  const result = gitRequest(repo, 'POST', 'git-receive-pack', false, body).toString();
  assert.match(result, /ng refs\/heads\/main incomplete object graph/);
  assert.equal(store.ref(repo), root);
});

test('deleting a repository removes GraphQL nodes, and invalid base64 cannot mutate files', () => {
  const { store, repo } = fixture();
  const issue = store.createIssue(repo, { title: 'delete me' });
  const before = store.ref(repo);
  assert.throws(() => store.writeContent(repo, 'invalid', { message: 'bad', content: '%%%!' }), /valid base64/);
  assert.equal(store.ref(repo), before);
  rest(store, 'DELETE', '/repos/mimi/example', {}, {});
  assert.equal(store.nodes.has(repo.node_id), false);
  assert.equal(store.nodes.has(issue.node_id), false);
  const result = graphql(store, { query: '{ node(id:"' + issue.node_id + '") { id } }' });
  assert.equal(result.data.node, null);
});

test('GraphQL preserves hashes in strings, handles directives, and rejects cyclic fragments', () => {
  const { store, repo } = fixture();
  const mutation = `mutation { createIssue(input:{repositoryId:"${repo.node_id}",title:"Fix #123",body:"# heading"}) { issue { title body } } }`;
  assert.deepEqual(graphql(store, { query: mutation }).data.createIssue.issue, { title: 'Fix #123', body: '# heading' });
  const query = 'query($skip:Boolean!) { viewer { login name @skip(if:$skip) } }';
  assert.deepEqual(graphql(store, { query, variables: { skip: true } }).data.viewer, { login: 'mimi' });
  const cyclic = graphql(store, { query: '{ viewer { ...A } } fragment A on User { ...A }' });
  assert.match(cyclic.errors[0].message, /cycle/);
  const missing = graphql(store, { query: '{ viewer { ...Missing } }' });
  assert.match(missing.errors[0].message, /Unknown fragment/);
});
