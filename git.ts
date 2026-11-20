import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO = '0'.repeat(40);
export type GitObject = { type: string; data: Buffer; oid: string; packed?: Buffer };
export const hash = (data: Buffer) => createHash('sha1').update(data).digest('hex');
export function object(type: string, data: Buffer | string): GitObject {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { type, data: bytes, oid: hash(Buffer.concat([Buffer.from(`${type} ${bytes.length}\0`), bytes])) };
}
export function pkt(data: string | Buffer): Buffer {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (b.length > 65516) throw new Error('Packet too large');
  return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0')), b]);
}
export const FLUSH = Buffer.from('0000');
export const DELIM = Buffer.from('0001');
const V2_ADVERTISEMENT = Buffer.concat(['version 2\n', 'agent=mimi-forge/1.0\n', 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'].map(pkt).concat([FLUSH]));
export function packets(body: Buffer): { lines: string[]; offset: number } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const hex = body.subarray(offset, offset + 4).toString();
    if (!/^[0-9a-f]{4}$/i.test(hex)) throw new Error('Invalid packet length');
    const n = parseInt(hex, 16);
    offset += 4;
    if (n === 0) break;
    if (n === 1 || n === 2) continue;
    if (n < 4 || offset + n - 4 > body.length) throw new Error('Truncated packet');
    lines.push(body.subarray(offset, offset + n - 4).toString().replace(/\n$/, ''));
    offset += n - 4;
  }
  return { lines, offset };
}
export function allPackets(body: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset < body.length) {
    const part = packets(body.subarray(offset));
    lines.push(...part.lines);
    if (!part.offset) break;
    offset += part.offset;
  }
  return lines;
}
export function sideband(body: Buffer): Buffer {
  const out: Buffer[] = [];
  for (let at = 0; at < body.length; at += 65500) out.push(pkt(Buffer.concat([Buffer.from([1]), body.subarray(at, at + 65500)])));
  return Buffer.concat([...out, FLUSH]);
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  function size() {
    let n = 0, scale = 1, b;
    do {
      if (at >= delta.length) throw new Error('Truncated delta');
      b = delta[at++]; n += (b & 127) * scale; scale *= 128;
    } while (b & 128);
    return n;
  }
  if (size() !== base.length) throw new Error('Delta base size mismatch');
  const length = size();
  if (length > 64 * 1024 * 1024) throw new Error('Delta too large');
  const result = Buffer.allocUnsafe(length);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++];
    if (op & 128) {
      let from = 0, count = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) from += delta[at++] * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (16 << i)) count += delta[at++] * 2 ** (8 * i);
      if (!count) count = 65536;
      if (from + count > base.length || written + count > length) throw new Error('Invalid delta copy');
      base.copy(result, written, from, from + count); written += count;
    } else {
      if (!op || at + op > delta.length || written + op > length) throw new Error('Invalid delta insert');
      delta.copy(result, written, at, at + op); at += op; written += op;
    }
  }
  if (written !== length) throw new Error('Delta result size mismatch');
  return result;
}

export function readPack(pack: Buffer, existing: Map<string, GitObject>): GitObject[] {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('Invalid pack');
  if (![2, 3].includes(pack.readUInt32BE(4))) throw new Error('Unsupported pack version');
  if (hash(pack.subarray(0, -20)) !== pack.subarray(-20).toString('hex')) throw new Error('Pack checksum mismatch');
  const count = pack.readUInt32BE(8);
  if (count > 1000000) throw new Error('Pack object limit');
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const pending: any[] = [];
  const result: GitObject[] = [];
  let at = 12;
  for (let i = 0; i < count; i++) {
    const start = at;
    let b = pack[at++], type = (b >> 4) & 7, size = b & 15, shift = 4;
    while (b & 128) { b = pack[at++]; size += (b & 127) * 2 ** shift; shift += 7; if (shift > 49) throw new Error('Invalid object size'); }
    let baseOffset: number | undefined, baseOid: string | undefined;
    if (type === 6) {
      b = pack[at++]; let distance = b & 127;
      while (b & 128) { b = pack[at++]; distance = (distance + 1) * 128 + (b & 127); }
      baseOffset = start - distance;
    } else if (type === 7) { baseOid = pack.subarray(at, at + 20).toString('hex'); at += 20; }
    const inflated: any = inflateSync(pack.subarray(at, pack.length - 20), { info: true, maxOutputLength: 64 * 1024 * 1024 });
    const data: Buffer = inflated.buffer;
    at += inflated.engine.bytesWritten;
    if (data.length !== size) throw new Error('Pack object size mismatch');
    if (type === 6 || type === 7) { pending.push({ start, data, baseOffset, baseOid }); continue; }
    const name = ['', 'commit', 'tree', 'blob', 'tag'][type];
    if (!name) throw new Error('Invalid pack object type');
    const obj = object(name, data);
    byOffset.set(start, obj); byOid.set(obj.oid, obj); result.push(obj);
  }
  if (at !== pack.length - 20) throw new Error('Trailing pack data');
  while (pending.length) {
    let progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const base = p.baseOid ? byOid.get(p.baseOid) ?? existing.get(p.baseOid) : byOffset.get(p.baseOffset);
      if (!base) continue;
      const obj = object(base.type, applyDelta(base.data, p.data));
      byOffset.set(p.start, obj); byOid.set(obj.oid, obj); result.push(obj);
      pending.splice(i, 1); progress = true;
    }
    if (!progress) throw new Error('Unresolved delta base');
  }
  return result;
}

export function writePack(objects: GitObject[]): Buffer {
  const header = Buffer.alloc(12); header.write('PACK'); header.writeUInt32BE(2, 4); header.writeUInt32BE(objects.length, 8);
  const parts = [header];
  for (const obj of objects) {
    if (!obj.packed) {
      const type = { commit: 1, tree: 2, blob: 3, tag: 4 }[obj.type];
      let size = obj.data.length;
      const h = [(type << 4) | (size & 15)]; size = Math.floor(size / 16);
      while (size) { h[h.length - 1] |= 128; h.push(size & 127); size = Math.floor(size / 128); }
      obj.packed = Buffer.concat([Buffer.from(h), deflateSync(obj.data, { level: 1 })]);
    }
    parts.push(obj.packed);
  }
  const payload = Buffer.concat(parts);
  return Buffer.concat([payload, Buffer.from(hash(payload), 'hex')]);
}

export function commitInfo(obj: GitObject | undefined): any {
  if (!obj || obj.type !== 'commit') return { parents: [], tree: '', message: '' };
  const text = obj.data.toString(), split = text.indexOf('\n\n'), headers = text.slice(0, split).split('\n');
  return {
    tree: headers.find(s => s.startsWith('tree '))?.slice(5) ?? '',
    parents: headers.filter(s => s.startsWith('parent ')).map(s => s.slice(7)),
    message: text.slice(split + 2),
    author: headers.find(s => s.startsWith('author '))?.slice(7),
    committer: headers.find(s => s.startsWith('committer '))?.slice(10),
  };
}
export function treeEntries(obj: GitObject | undefined): any[] {
  if (!obj || obj.type !== 'tree') return [];
  const b = obj.data, entries = []; let at = 0;
  while (at < b.length) {
    const space = b.indexOf(32, at), zero = b.indexOf(0, space);
    if (space < 0 || zero < 0 || zero + 21 > b.length) throw new Error('Invalid tree');
    entries.push({ mode: b.toString('ascii', at, space), name: b.toString('utf8', space + 1, zero), oid: b.subarray(zero + 1, zero + 21).toString('hex') });
    at = zero + 21;
  }
  return entries;
}
export function links(obj: GitObject | undefined): string[] {
  if (!obj) return [];
  if (obj.type === 'commit') { const c = commitInfo(obj); return [c.tree, ...c.parents]; }
  if (obj.type === 'tree') return treeEntries(obj).filter(e => e.mode !== '160000').map(e => e.oid);
  if (obj.type === 'tag') return [obj.data.toString().match(/^object ([0-9a-f]{40})/)?.[1]].filter(Boolean) as string[];
  return [];
}
export function ancestor(objects: Map<string, GitObject>, old: string, tip: string): boolean {
  const stack = [tip], seen = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!; if (id === old) return true;
    if (seen.has(id)) continue; seen.add(id); stack.push(...commitInfo(objects.get(id)).parents);
  }
  return false;
}
export function peel(objects: Map<string, GitObject>, oid: string): string {
  const seen = new Set<string>();
  while (objects.get(oid)?.type === 'tag' && !seen.has(oid)) { seen.add(oid); oid = links(objects.get(oid))[0] ?? oid; }
  return oid;
}

export function fetchPack(repo: any, lines: string[]): Buffer {
  const wants = lines.filter(s => s.startsWith('want ')).map(s => s.split(' ')[1]);
  const haves = lines.filter(s => s.startsWith('have ')).map(s => s.split(' ')[1]);
  const oldShallow = new Set(lines.filter(s => s.startsWith('shallow ')).map(s => s.split(' ')[1]));
  const depth = Number(lines.find(s => s.startsWith('deepen '))?.split(' ')[1] ?? 0);
  const relative = lines.includes('deepen-relative');
  const done = lines.includes('done');
  const key = JSON.stringify([wants, haves, [...oldShallow], depth, relative, done]);
  if (repo.fetchCache.has(key)) return repo.fetchCache.get(key);
  const exclude = new Set<string>();
  const mark = (oid: string) => {
    if (exclude.has(oid)) return; exclude.add(oid);
    const obj = repo.objects.get(oid);
    let next = links(obj);
    if (obj?.type === 'commit' && oldShallow.has(oid)) next = [commitInfo(obj).tree];
    for (const id of next) mark(id);
  };
  for (const id of haves) mark(id);
  const selected = new Map<string, GitObject>(), shallow = new Set<string>();
  const visited = new Map<string, number>();
  const visit = (id: string, generation: number) => {
    const obj = repo.objects.get(id); if (!obj) return;
    if ((visited.get(id) ?? Infinity) <= generation) return; visited.set(id, generation);
    if (!exclude.has(id)) selected.set(id, obj);
    if (obj.type === 'commit') {
      const c = commitInfo(obj); visit(c.tree, generation);
      if ((depth && generation >= depth) || (!depth && oldShallow.has(id))) { if (c.parents.length) shallow.add(id); return; }
      if (exclude.has(id) && !oldShallow.has(id)) return;
      for (const parent of c.parents) visit(parent, generation + 1);
    } else for (const link of links(obj)) visit(link, generation);
  };
  for (const id of wants) visit(id, relative && oldShallow.has(id) ? 0 : 1);
  const output: Buffer[] = [];
  if (!done && haves.length) {
    output.push(pkt('acknowledgments\n'));
    const known = haves.filter(id => repo.objects.has(id));
    if (known.length) { for (const id of known) output.push(pkt(`ACK ${id}\n`)); output.push(pkt('ready\n')); }
    else output.push(pkt('NAK\n'));
    output.push(DELIM);
  }
  if (depth || oldShallow.size) {
    output.push(pkt('shallow-info\n'));
    for (const id of shallow) output.push(pkt(`shallow ${id}\n`));
    for (const id of oldShallow) if (visited.has(id) && !shallow.has(id)) output.push(pkt(`unshallow ${id}\n`));
    output.push(DELIM);
  }
  output.push(pkt('packfile\n'), sideband(writePack([...selected.values()])));
  const result = Buffer.concat(output);
  if (repo.fetchCache.size >= 16) repo.fetchCache.delete(repo.fetchCache.keys().next().value);
  repo.fetchCache.set(key, result);
  return result;
}

export function gitRequest(repo: any, method: string, service: string, version2: boolean, body: Buffer): Buffer {
  if (method === 'GET' && service === 'git-upload-pack' && version2) return V2_ADVERTISEMENT;
  const advertiseKey = `advertise:${service}:${version2}`;
  if (method === 'GET' && repo.fetchCache.has(advertiseKey)) return repo.fetchCache.get(advertiseKey);
  const refs = [...repo.refs.entries()] as [string, string][];
  const head = repo.refs.get(`refs/heads/${repo.default_branch}`);
  if (method === 'GET') {
    const caps = service === 'git-receive-pack' ? 'report-status side-band-64k delete-refs ofs-delta' : `multi_ack_detailed side-band-64k shallow ofs-delta symref=HEAD:refs/heads/${repo.default_branch}`;
    const advertised = head ? [['HEAD', head], ...refs] : refs;
    if (!advertised.length) advertised.push(['capabilities^{}', ZERO]);
    const data = Buffer.concat([pkt(`# service=${service}\n`), FLUSH, ...advertised.map(([name, id], i) => pkt(`${id} ${name}${i === 0 ? '\0' + caps : ''}\n`)), FLUSH]);
    repo.fetchCache.set(advertiseKey, data); return data;
  }
  if (service === 'git-receive-pack') {
    const { lines, offset } = packets(body);
    const staged = repo.objects, report = ['unpack ok\n'];
    try {
      if (body.length > offset) for (const obj of readPack(body.subarray(offset), repo.objects)) staged.set(obj.oid, obj);
    } catch (e: any) {
      return sideband(Buffer.concat([pkt(`unpack ${e.message}\n`), FLUSH]));
    }
    for (const line of lines) {
      const [old, next, ref] = line.split('\0')[0].split(' ');
      const current = repo.refs.get(ref) ?? ZERO;
      let reason = '';
      if (!/^refs\/(heads|tags)\/[^\s\0]+$/.test(ref ?? '') || !/^[0-9a-f]{40}$/.test(next ?? '')) reason = 'invalid ref';
      else if (current !== old) reason = 'stale ref';
      else if (next !== ZERO && !staged.has(next)) reason = 'missing object';
      else if (next !== ZERO && old !== ZERO && !ancestor(staged, old, next)) reason = 'non-fast-forward';
      if (reason) report.push(`ng ${ref} ${reason}\n`);
      else {
        if (next === ZERO) repo.refs.delete(ref); else repo.refs.set(ref, next);
        report.push(`ok ${ref}\n`);
      }
    }
    repo.objects = staged; repo.fetchCache.clear();
    const status = Buffer.concat([...report.map(pkt), FLUSH]);
    return lines[0]?.includes('side-band-64k') ? sideband(status) : status;
  }
  const lines = allPackets(body);
  if (lines.includes('command=ls-refs')) {
    const prefixes = lines.filter(s => s.startsWith('ref-prefix ')).map(s => s.slice(11));
    const all = head ? [['HEAD', head], ...refs] : refs;
    const out = all.filter(([name]) => !prefixes.length || prefixes.some(p => name.startsWith(p))).map(([name, id]) => {
      let attributes = name === 'HEAD' && lines.includes('symrefs') ? ` symref-target:refs/heads/${repo.default_branch}` : '';
      const peeled = peel(repo.objects, id);
      if (lines.includes('peel') && peeled !== id) attributes += ` peeled:${peeled}`;
      return pkt(`${id} ${name}${attributes}\n`);
    });
    return Buffer.concat([...out, FLUSH]);
  }
  if (version2) return fetchPack(repo, lines);
  const v2 = fetchPack(repo, lines);
  const start = v2.indexOf(pkt('packfile\n'));
  return Buffer.concat([pkt('NAK\n'), v2.subarray(start + pkt('packfile\n').length)]);
}
