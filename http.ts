import { createServer as createNetServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';

export type Request = { method: string; path: string; headers: Record<string, string>; body: Buffer };
export type Response = { status: number; data: any; headers?: Record<string, string> };
export type Handler = (request: Request) => Response;
const EMPTY = Buffer.alloc(0);
const MAX_BODY = 64 * 1024 * 1024;
const MAX_HEADERS = 32 * 1024;
const reasons: Record<number, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict', 413: 'Content Too Large', 422: 'Unprocessable Entity', 431: 'Request Header Fields Too Large', 500: 'Internal Server Error' };
const JSON_TYPE = 'application/json; charset=utf-8';
const EMPTY_HEADERS: Record<string, string> = Object.freeze({});
const wireCache = new WeakMap<Buffer, { status: number; close: boolean; head: boolean; headers: Record<string, string>; wire: Buffer }>();
function wire(response: Response, close: boolean, head: boolean): Buffer {
  const { status, headers = EMPTY_HEADERS } = response;
  const body = status === 204 ? EMPTY : Buffer.isBuffer(response.data) ? response.data : Buffer.from(JSON.stringify(response.data));
  const cacheable = Object.isFrozen(headers);
  const cached = cacheable ? wireCache.get(body) : undefined;
  if (cached?.status === status && cached.close === close && cached.head === head && cached.headers === headers) return cached.wire;
  let header = `HTTP/1.1 ${status} ${reasons[status] ?? 'Response'}\r\nContent-Type: ${headers['Content-Type'] ?? JSON_TYPE}\r\nX-GitHub-Request-Id: MIMI-FORGE\r\nContent-Length: ${body.length}\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type') continue;
    if (/[\r\n]/.test(name + value)) throw new Error('Invalid response header');
    header += `${name}: ${value}\r\n`;
  }
  header += `Connection: ${close ? 'close' : 'keep-alive'}\r\n\r\n`;
  const result = Buffer.concat([Buffer.from(header), head ? EMPTY : body]);
  if (cacheable && Buffer.isBuffer(response.data)) wireCache.set(body, { status, close, head, headers, wire: result });
  return result;
}

export function serve(handler: Handler, driver = 'native') {
  const sockets = new Set<Socket>();
  type ParsedHead = { method: string; path: string; headers: Record<string, string>; length: number; chunked: boolean; close: boolean };
  // Parsing is independent of store state. A small cache reuses common keep-alive
  // requests while every request still dispatches against the current repository.
  const parsedHeads = new Map<string, ParsedHead>();
  const node = driver === 'node';
  const server = node ? createHttpServer((req, res) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { res.writeHead(413, { 'Content-Type': JSON_TYPE }); res.end(JSON.stringify({ message: 'Request too large' })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v ?? '']));
      try {
        const result = handler({ method: req.method ?? 'GET', path: req.url ?? '/', headers, body: chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size) });
        const body = result.status === 204 ? EMPTY : Buffer.isBuffer(result.data) ? result.data : Buffer.from(JSON.stringify(result.data));
        res.writeHead(result.status, { 'Content-Type': JSON_TYPE, 'X-GitHub-Request-Id': 'MIMI-FORGE', 'Content-Length': body.length, ...result.headers });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch { res.writeHead(500, { 'Content-Type': JSON_TYPE }); res.end('{"message":"Internal server error"}'); }
    });
    req.on('error', () => res.destroy());
  }) : createNetServer(socket => {
    socket.setNoDelay(true);
    socket.setTimeout(65000, () => socket.destroy());
    let buffer = EMPTY;
    let pending: ParsedHead | undefined;
    let chunkRemaining: number | undefined, chunkTotal = 0, chunkParts: Buffer[] = [], trailers = false;
    let closing = false, deadline: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = () => { if (deadline) clearTimeout(deadline); deadline = undefined; };
    const fail = (status: number, message: string) => { closing = true; clearDeadline(); socket.end(wire({ status, data: { message } }, true, false)); };
    socket.on('close', clearDeadline);
    socket.on('data', bytes => {
      if (closing) return;
      buffer = buffer.length ? Buffer.concat([buffer, bytes]) : bytes;
      try {
        for (;;) {
          if (!pending) {
            const end = buffer.indexOf('\r\n\r\n');
            if (end < 0) { if (buffer.length > MAX_HEADERS) fail(431, 'Headers too large'); break; }
            if (end > MAX_HEADERS) { fail(431, 'Headers too large'); break; }
            const headerText = buffer.toString('latin1', 0, end);
            const cached = parsedHeads.get(headerText);
            if (cached) {
              pending = cached;
              buffer = buffer.subarray(end + 4);
              if (pending.headers.expect?.toLowerCase() === '100-continue') socket.write('HTTP/1.1 100 Continue\r\n\r\n');
            } else {
            const lines = headerText.split('\r\n');
            const first = /^([A-Z]+) ([^\s]+) HTTP\/(1\.[01])$/.exec(lines[0]);
            if (!first) { fail(400, 'Invalid request line'); break; }
            const headers: Record<string, string> = Object.create(null);
            for (const line of lines.slice(1)) {
              const colon = line.indexOf(':');
              if (colon <= 0 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(line.slice(0, colon))) throw new Error('Invalid request header');
              const name = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
              if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error('Invalid header value');
              if (headers[name] !== undefined) {
                if (['content-length', 'transfer-encoding', 'authorization', 'host'].includes(name)) throw new Error('Duplicate request header');
                headers[name] += ', ' + value;
              } else headers[name] = value;
            }
            const te = headers['transfer-encoding'];
            if (te && (te.toLowerCase() !== 'chunked' || headers['content-length'] !== undefined)) throw new Error('Ambiguous body framing');
            const cl = headers['content-length'];
            if (cl !== undefined && !/^\d+$/.test(cl)) throw new Error('Invalid Content-Length');
            const length = cl === undefined ? 0 : Number(cl);
            if (!Number.isSafeInteger(length) || length > MAX_BODY) { fail(413, 'Request too large'); break; }
            const connections = (headers.connection ?? '').toLowerCase().split(',').map(s => s.trim());
            pending = { method: first[1], path: first[2], headers, length, chunked: !!te, close: connections.includes('close') || first[3] === '1.0' && !connections.includes('keep-alive') };
            if (parsedHeads.size >= 128) parsedHeads.delete(parsedHeads.keys().next().value);
            if (headerText.length <= 4096) parsedHeads.set(headerText, pending);
            buffer = buffer.subarray(end + 4);
            if (headers.expect?.toLowerCase() === '100-continue') socket.write('HTTP/1.1 100 Continue\r\n\r\n');
            }
          }
          let body: Buffer;
          if (pending.chunked) {
            let complete = false;
            for (;;) {
              if (trailers) {
                if (buffer.length < 2) break;
                if (buffer[0] === 13 && buffer[1] === 10) { buffer = buffer.subarray(2); complete = true; break; }
                const end = buffer.indexOf('\r\n\r\n');
                if (end < 0) { if (buffer.length > MAX_HEADERS) throw new Error('Trailers too large'); break; }
                buffer = buffer.subarray(end + 4); complete = true; break;
              }
              if (chunkRemaining === undefined) {
                const end = buffer.indexOf('\r\n');
                if (end < 0) { if (buffer.length > 128) throw new Error('Chunk header too large'); break; }
                const size = buffer.toString('ascii', 0, end).split(';')[0];
                if (!/^[0-9a-f]{1,8}$/i.test(size)) throw new Error('Invalid chunk length');
                chunkRemaining = parseInt(size, 16); buffer = buffer.subarray(end + 2);
                if (chunkTotal + chunkRemaining > MAX_BODY) { fail(413, 'Request too large'); return; }
                if (chunkRemaining === 0) { trailers = true; continue; }
              }
              if (buffer.length < chunkRemaining + 2) break;
              if (buffer[chunkRemaining] !== 13 || buffer[chunkRemaining + 1] !== 10) throw new Error('Invalid chunk ending');
              chunkParts.push(buffer.subarray(0, chunkRemaining)); chunkTotal += chunkRemaining;
              buffer = buffer.subarray(chunkRemaining + 2); chunkRemaining = undefined;
            }
            if (!complete) break;
            body = Buffer.concat(chunkParts, chunkTotal); chunkParts = []; chunkTotal = 0; chunkRemaining = undefined; trailers = false;
          } else {
            if (buffer.length < pending.length) break;
            body = buffer.subarray(0, pending.length); buffer = buffer.subarray(pending.length);
          }
          const request = pending; pending = undefined; clearDeadline();
          const response = handler({ method: request.method, path: request.path, headers: request.headers, body });
          const output = wire(response, request.close, request.method === 'HEAD');
          if (request.close) { closing = true; socket.end(output); break; }
          if (!socket.write(output)) { socket.pause(); socket.once('drain', () => socket.resume()); }
          if (!buffer.length) break;
        }
        if (!closing && !deadline && (pending || buffer.length)) deadline = setTimeout(() => fail(400, 'Request timeout'), 15000);
      } catch (e: any) { if (!closing) fail(400, e.message || 'Bad Request'); }
    });
  });
  server.on('connection', (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  if (node) { (server as any).keepAliveTimeout = 65000; (server as any).headersTimeout = 70000; }
  return { server, close(callback: () => void) { for (const socket of sockets) socket.destroy(); server.close(callback); } };
}
