import { storage_snapshot, damage_device_key } from './storage-snapshot.mjs';

const passphrase = 'disposable protected storage passphrase';
const namespace = 'murmur-browser-identity';
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const rejects = async operation => {
  let rejected = false;
  try { await operation(); } catch { rejected = true; }
  assert(rejected, 'Operation unexpectedly succeeded.');
};
const controller = () => {
  const worker = new Worker('./worker.mjs', { type: 'module' });
  let sequence = 0;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    const call = pending.get(data.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(data.id);
    data.error ? call.reject(new Error(data.error)) : call.resolve(data.result);
  };
  worker.onerror = event => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(event.message));
    }
    pending.clear();
  };
  return {
    async call(action, value) {
      if (action === 'test_storage') value = await storage_snapshot(namespace);
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Storage check timed out.')); }, 20000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, action, value, bootstrap: 'ws://127.0.0.1:9/ws' });
      });
    },
    terminate() {
      worker.terminate();
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('Worker terminated.'));
      }
      pending.clear();
    },
  };
};

let node;
try {
  assert((await indexedDB.databases()).length === 0, 'Checks require a disposable browser profile.');
  node = controller();
  await node.call('start');
  await rejects(() => node.call('test_seed'));
  await node.call('stop');
  node.terminate();
  const legacy = await storage_snapshot('murmur-browser-probe');

  for (const invalid of ['', '\u00e9'.repeat(513), {}]) {
    node = controller();
    await rejects(() => node.call('start_protected', invalid));
    node.terminate();
  }
  assert(JSON.parse(await storage_snapshot(namespace)).length === 0, 'Invalid passwords created storage.');

  node = controller();
  const state = await node.call('start_protected', passphrase);
  assert(state.protected && state.starts === 1, 'Protected startup was not established.');
  const key = await node.call('test_seed');
  await rejects(() => node.call('test_seed'));
  assert(await node.call('test_storage') === key, 'Saved identity was not verified.');
  await node.call('stop');
  await rejects(() => node.call('identity'));
  node.terminate();

  const saved = await storage_snapshot(namespace);
  node = controller();
  await rejects(() => node.call('start_protected', 'wrong passphrase'));
  assert(await storage_snapshot(namespace) === saved, 'Wrong password modified persisted storage.');

  const restarted = await node.call('start_protected', passphrase);
  assert(restarted.starts === 2, 'Storage did not survive restart.');
  assert(await node.call('test_storage') === key, 'Writer or pending post changed after restart.');
  await node.call('stop');
  await rejects(() => node.call('identity'));
  assert((await node.call('start_protected', passphrase)).starts === 3, 'Stopped worker did not restart.');
  assert(await node.call('test_storage') === key, 'Same-worker restart lost its identity.');
  const competing = controller();
  try { await rejects(() => competing.call('start_protected', passphrase)); }
  finally { competing.terminate(); }
  node.terminate();

  node = controller();
  assert((await node.call('start_protected', passphrase)).starts === 4, 'Interrupted node did not recover.');
  assert(await node.call('test_storage') === key, 'Interrupted node lost its writer or pending post.');
  await node.call('stop');
  node.terminate();
  assert(await storage_snapshot('murmur-browser-probe') === legacy, 'Protected startup modified the legacy probe.');

  await damage_device_key(namespace);
  const damaged = await storage_snapshot(namespace);
  node = controller();
  await rejects(() => node.call('start_protected', passphrase));
  node.terminate();
  assert(await storage_snapshot(namespace) === damaged, 'Damaged storage was wiped or replaced.');
  document.getElementById('result').textContent = 'passed';
} catch (failure) {
  document.getElementById('result').textContent = `failed: ${failure.message}`;
} finally {
  node?.terminate();
  await fetch('/__check_done');
}
