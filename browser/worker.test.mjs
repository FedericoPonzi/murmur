import assert from 'node:assert/strict';
import test from 'node:test';
import { checkEnvironment } from './worker.mjs';

const environment = {
  location: { protocol: 'http:' },
  indexedDB: {},
  navigator: { locks: { request() {} } },
};

test('accepts local HTTP and a plain-WebSocket bootstrap', () => {
  assert.equal(checkEnvironment(environment, 'ws://bootstrap-v1.veilid.net:5150/ws'),
    'ws://bootstrap-v1.veilid.net:5150/ws');
});

test('rejects unsupported browser capabilities explicitly', () => {
  assert.throws(() => checkEnvironment({ ...environment, indexedDB: undefined }, 'ws://example.org/ws'),
    /IndexedDB/);
  assert.throws(() => checkEnvironment({ ...environment, navigator: {} }, 'ws://example.org/ws'),
    /Web Locks/);
});

test('rejects mixed-content hosting and non-WebSocket bootstrap URLs', () => {
  assert.throws(() => checkEnvironment({ ...environment, location: { protocol: 'https:' } }, 'ws://example.org/ws'),
    /HTTP/);
  for (const value of ['https://example.org/ws', 'wss://example.org/ws', 'invalid', 'ws://user:secret@example.org/ws']) {
    assert.throws(() => checkEnvironment(environment, value), /bootstrap/i);
  }
});
