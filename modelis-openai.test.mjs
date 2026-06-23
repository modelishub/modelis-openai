// Unit tests for the pure helpers + an in-process server smoke test.
// Run: node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  extractKey,
  rewriteBody,
  upstreamHeaders,
  modelsPayload,
  filterResponseHeaders,
  isOpenRelay,
  createServer,
} from './modelis-openai.mjs';

test('extractKey parses Bearer token', () => {
  assert.equal(extractKey('Bearer abc123'), 'abc123');
  assert.equal(extractKey('bearer   spaced  '), 'spaced');
});

test('extractKey accepts a raw token without Bearer', () => {
  assert.equal(extractKey('rawkey'), 'rawkey');
});

test('extractKey falls back to env key, else null', () => {
  assert.equal(extractKey(undefined, 'envkey'), 'envkey');
  assert.equal(extractKey('', 'envkey'), 'envkey');
  assert.equal(extractKey(undefined, ''), null);
  assert.equal(extractKey('Bearer    ', ''), null);
});

test('rewriteBody overrides model when forceModel set', () => {
  const out = rewriteBody(Buffer.from(JSON.stringify({ model: 'gpt-4o', messages: [] })), 'modelis-auto');
  assert.equal(JSON.parse(out.toString()).model, 'modelis-auto');
});

test('rewriteBody preserves other fields', () => {
  const out = rewriteBody(
    Buffer.from(JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }], stream: true })),
    'modelis-auto',
  );
  const o = JSON.parse(out.toString());
  assert.equal(o.stream, true);
  assert.deepEqual(o.messages, [{ role: 'user', content: 'hi' }]);
});

test('rewriteBody is a no-op when forceModel empty', () => {
  const original = Buffer.from(JSON.stringify({ model: 'gpt-4o' }));
  assert.equal(rewriteBody(original, '').toString(), original.toString());
});

test('rewriteBody returns original bytes on non-JSON', () => {
  const junk = Buffer.from('not json');
  assert.equal(rewriteBody(junk, 'modelis-auto').toString(), 'not json');
});

test('upstreamHeaders maps key + host correctly', () => {
  const h = upstreamHeaders('K', 'modelis-auto-chat.p.rapidapi.com', 42);
  assert.equal(h['x-rapidapi-key'], 'K');
  assert.equal(h['x-rapidapi-host'], 'modelis-auto-chat.p.rapidapi.com');
  assert.equal(h['content-length'], '42');
  assert.equal(h['content-type'], 'application/json');
});

test('modelsPayload lists modelis-auto', () => {
  const p = modelsPayload();
  assert.equal(p.object, 'list');
  assert.ok(p.data.some((m) => m.id === 'modelis-auto'));
});

test('upstreamHeaders does not force an Accept header', () => {
  assert.equal('accept' in upstreamHeaders('K', 'h', 1), false);
});

test('filterResponseHeaders keeps useful headers, strips hop-by-hop', () => {
  const out = filterResponseHeaders({
    'content-type': 'text/event-stream',
    'x-ratelimit-requests-remaining': '99',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
  });
  assert.equal(out['content-type'], 'text/event-stream');
  assert.equal(out['x-ratelimit-requests-remaining'], '99');
  assert.equal(out['cache-control'], 'no-cache');
  assert.equal('connection' in out, false);
  assert.equal('transfer-encoding' in out, false);
});

test('isOpenRelay flags env key on non-loopback bind only', () => {
  assert.equal(isOpenRelay({ envKey: 'k', listenHost: '0.0.0.0' }), true);
  assert.equal(isOpenRelay({ envKey: 'k', listenHost: '127.0.0.1' }), false);
  assert.equal(isOpenRelay({ envKey: '', listenHost: '0.0.0.0' }), false);
});

// --- in-process integration: real server, fake RapidAPI upstream -------------

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('routing: 401 without key, /models, /health, 404', async () => {
  const proxy = createServer({
    rapidHost: '127.0.0.1', upstreamPath: '/unused', upstreamProtocol: 'http',
    listenHost: '127.0.0.1', listenPort: 0, envKey: '', forceModel: 'modelis-auto',
  });
  const port = await listen(proxy);

  const r401 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
  });
  assert.equal(r401.status, 401);

  const rm = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(rm.status, 200);
  assert.ok((await rm.json()).data.some((m) => m.id === 'modelis-auto'));

  const rh = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal((await rh.json()).status, 'ok');

  const r404 = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(r404.status, 404);

  await new Promise((r) => proxy.close(r));
});

test('forwards to upstream with translated headers + rewritten model, streams response back', async () => {
  let received = null;
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = { headers: req.headers, body: Buffer.concat(chunks).toString() };
      // Emulate an SSE stream so we exercise the streaming pipe path,
      // including a rate-limit header that should be relayed to the client.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-ratelimit-requests-remaining': '42' });
      res.write('data: {"choices":[{"delta":{"content":"po"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"ng"}}]}\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  const fakePort = await listen(fake);

  const proxy = createServer({
    rapidHost: '127.0.0.1', upstreamPort: fakePort, upstreamPath: '/v1/chat/completions',
    upstreamProtocol: 'http', listenHost: '127.0.0.1', listenPort: 0,
    envKey: '', forceModel: 'modelis-auto',
  });
  const proxyPort = await listen(proxy);

  const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer my-rapid-key' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], stream: true }),
  });
  const text = await r.text();

  // Upstream got translated auth + correct host header.
  assert.equal(received.headers['x-rapidapi-key'], 'my-rapid-key');
  assert.equal(received.headers['x-rapidapi-host'], '127.0.0.1');
  // Model was rewritten before forwarding.
  assert.equal(JSON.parse(received.body).model, 'modelis-auto');
  // Streamed body relayed intact.
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  assert.equal(r.headers.get('x-ratelimit-requests-remaining'), '42'); // relayed
  assert.ok(text.includes('"po"') && text.includes('"ng"') && text.includes('[DONE]'));

  await new Promise((res) => proxy.close(res));
  await new Promise((res) => fake.close(res));
});
