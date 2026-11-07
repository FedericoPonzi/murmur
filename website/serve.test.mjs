import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createPreviewServer } from './serve.mjs';

const directory = mkdtempSync(join(tmpdir(), 'murmur-preview-test-'));
const root = join(directory, 'output');
const requests = [];
let upstream, preview, origin, bridge;
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => {
  server.close(resolve);
  server.closeAllConnections();
});

before(async () => {
  mkdirSync(join(root, 'app/pkg'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<h1>Murmur</h1>');
  writeFileSync(join(root, 'app/index.html'), '<h1>Probe</h1>');
  writeFileSync(join(root, 'app/worker.mjs'), 'export const worker = true;');
  writeFileSync(join(root, 'app/pkg/node.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  writeFileSync(join(directory, 'murmur_config.json'), '{"writer":"must-not-be-served"}');
  symlinkSync(join(directory, 'murmur_config.json'), join(root, 'private-link'));
  upstream = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, cookie: request.headers.cookie });
    if (request.url.endsWith('/redirect')) {
      response.writeHead(302, { Location: '/api/post' }).end();
    } else if (request.url.endsWith('/invalid')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end('not JSON');
    } else if (request.url.endsWith('/large')) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ text: 'x'.repeat(65536) }));
    } else {
      const status = request.url.endsWith('/unavailable') ? 503 : 200;
      response.writeHead(status, { 'Content-Type': 'application/json' }).end('{"source":"bridge"}');
    }
  });
  await listen(upstream);
  bridge = `http://127.0.0.1:${upstream.address().port}`;
  preview = createPreviewServer({ root, bridge });
  await listen(preview);
  origin = `http://127.0.0.1:${preview.address().port}`;
});

after(async () => {
  if (preview) await close(preview);
  if (upstream) await close(upstream);
  rmSync(directory, { recursive: true, force: true });
});

test('serves directory indexes, worker modules, and WASM with the required MIME types', async () => {
  const app = await fetch(`${origin}/app/`);
  assert.equal(app.status, 200);
  assert.match(await app.text(), /Probe/);
  const module = await fetch(`${origin}/app/worker.mjs`);
  assert.match(module.headers.get('content-type'), /javascript/);
  const wasm = await fetch(`${origin}/app/pkg/node.wasm`);
  assert.equal(wasm.headers.get('content-type'), 'application/wasm');
  assert.deepEqual(Buffer.from(await wasm.arrayBuffer()), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const head = await fetch(`${origin}/app/pkg/node.wasm`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
});

test('does not serve paths or symlinks outside the generated site', async () => {
  for (const path of ['/..%2fmurmur_config.json', '/private-link', '/missing']) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /must-not-be-served/);
  }
});

test('malformed request targets fail without stopping the preview', async () => {
  for (const path of ['http://[', '/bad%xx']) {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest({ hostname: '127.0.0.1', port: preview.address().port, path }, response => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1000, () => request.destroy(new Error('Preview did not reply.')));
      request.end();
    });
    assert.equal(status, 400);
  }
  assert.equal((await fetch(origin)).status, 200);
});

test('proxies only supported GET reads, without cookies or redirects', async () => {
  requests.length = 0;
  const me = await fetch(`${origin}/api/me`, { headers: { Cookie: 'writer=private-test-value' } });
  assert.deepEqual(await me.json(), { source: 'bridge' });
  const feed = await fetch(`${origin}/api/feed/unavailable`);
  assert.equal(feed.status, 503);
  assert.deepEqual(await feed.json(), { source: 'bridge' });
  assert.equal((await fetch(`${origin}/api/post`, { method: 'POST', body: 'must not publish' })).status, 405);
  assert.equal((await fetch(`${origin}/api/post`)).status, 404);
  assert.equal((await fetch(`${origin}/api/me`, { method: 'HEAD' })).status, 405);
  assert.equal((await fetch(`${origin}/api/feed/redirect`)).status, 502);
  assert.deepEqual(requests, [
    { method: 'GET', url: '/api/me', cookie: undefined },
    { method: 'GET', url: '/api/feed/unavailable', cookie: undefined },
    { method: 'GET', url: '/api/feed/redirect', cookie: undefined },
  ]);
});

test('an unconfigured or unavailable bridge produces an explicit error', async () => {
  const unconfigured = createPreviewServer({ root });
  await listen(unconfigured);
  try {
    const response = await fetch(`http://127.0.0.1:${unconfigured.address().port}/api/me`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /not configured/);
  } finally { await close(unconfigured); }
  const disconnected = createPreviewServer({ root, bridge: 'http://127.0.0.1:0' });
  await listen(disconnected);
  try {
    const response = await fetch(`http://127.0.0.1:${disconnected.address().port}/api/me`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /bridge/);
  } finally { await close(disconnected); }
});

test('invalid or oversized bridge results are errors, not successful responses', async () => {
  for (const key of ['invalid', 'large']) {
    const response = await fetch(`${origin}/api/feed/${key}`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /bridge request failed/);
  }
});

test('rejects credential-bearing or path-bearing bridge configuration', () => {
  assert.throws(() => createPreviewServer({ root, bridge: 'http://user:password@localhost:8080' }), /bridge origin/);
  assert.throws(() => createPreviewServer({ root, bridge: 'http://localhost:8080/private' }), /bridge origin/);
});
