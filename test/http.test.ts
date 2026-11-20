import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { serve } from '../http.ts';

async function server() {
  const instance = serve(request => ({ status: 200, data: { method: request.method, path: request.path, body: request.body.toString() } }));
  await new Promise<void>(resolve => instance.server.listen(0, '127.0.0.1', resolve));
  return { instance, port: (instance.server.address() as any).port };
}
async function exchange(port: number, parts: string[]) {
  return await new Promise<Buffer>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('HTTP exchange timeout')); });
    socket.on('data', b => chunks.push(b)); socket.on('error', reject);
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('connect', async () => { for (const part of parts) { socket.write(part); await new Promise(r => setTimeout(r, 2)); } });
  });
}
test('fragmented HTTP headers and body parse exactly once', async () => {
  const { instance, port } = await server();
  try {
    const result = (await exchange(port, ['POST /test HTTP/1.1\r\nHost: local\r\nContent-Len', 'gth: 5\r\nConnection: close\r\n\r\nhe', 'llo'])).toString();
    assert.match(result, /200 OK/); assert.match(result, /"body":"hello"/);
    assert.equal(result.match(/HTTP\/1.1 200/g)?.length, 1);
  } finally { await new Promise<void>(resolve => instance.close(resolve)); }
});
test('chunked input and pipelined requests keep independent bodies', async () => {
  const { instance, port } = await server();
  try {
    const result = (await exchange(port, ['POST /one HTTP/1.1\r\nHost: local\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nhe', '\r\n3\r\nllo\r\n0\r\n\r\nGET /two HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n'])).toString();
    assert.equal(result.match(/HTTP\/1.1 200/g)?.length, 2);
    assert.match(result, /"path":"\/one","body":"hello"/);
    assert.match(result, /"path":"\/two","body":""/);
  } finally { await new Promise<void>(resolve => instance.close(resolve)); }
});
test('ambiguous and oversized HTTP framing is rejected before dispatch', async () => {
  const { instance, port } = await server();
  try {
    for (const headers of ['Content-Length: 1\r\nContent-Length: 1', 'Content-Length: 1\r\nTransfer-Encoding: chunked', 'Content-Length: -1']) {
      const result = (await exchange(port, [`POST /bad HTTP/1.1\r\nHost: local\r\n${headers}\r\n\r\nx`])).toString();
      assert.match(result, /400 Bad Request/); assert.doesNotMatch(result, /"path":"\/bad"/);
    }
    const result = (await exchange(port, ['POST /big HTTP/1.1\r\nHost: local\r\nContent-Length: 999999999\r\n\r\n'])).toString();
    assert.match(result, /413 Content Too Large/);
  } finally { await new Promise<void>(resolve => instance.close(resolve)); }
});
test('Expect continue and HEAD use correct response framing', async () => {
  const { instance, port } = await server();
  try {
    const result = (await exchange(port, ['POST /expect HTTP/1.1\r\nHost: local\r\nContent-Length: 1\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n', 'x'])).toString();
    assert.match(result, /^HTTP\/1.1 100 Continue/); assert.match(result, /"body":"x"/);
    const head = (await exchange(port, ['HEAD /head HTTP/1.1\r\nHost: local\r\nConnection: close\r\n\r\n'])).toString();
    assert.equal(head.split('\r\n\r\n')[1], ''); assert.match(head, /Content-Length: [1-9]/);
  } finally { await new Promise<void>(resolve => instance.close(resolve)); }
});
