import { controller } from './test-worker.mjs';
import { storage_snapshot } from './storage-snapshot.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const rejects = async operation => {
  try { await operation(); } catch { return; }
  throw new Error('Read-only operation unexpectedly succeeded.');
};
const node = controller();
try {
  const credentials = { passphrase: 'disposable reader isolation passphrase',
    author_name: 'Disposable author', bio: '' };
  const author = await node.call('create', credentials);
  await node.call('stop');
  const saved = await storage_snapshot('murmur-browser-identity');
  const state = await node.call('read_only');
  assert(state.reader === true && !state.protected && state.identity === null, 'Guest loaded an author.');
  assert(await node.call('profile') === null, 'An author escaped into guest mode.');
  for (const action of ['identity', 'publish', 'draft', 'update_profile', 'backup', 'test_seed']) {
    await rejects(() => node.call(action, 'Must not create or use a writer.'));
  }
  assert(await storage_snapshot('murmur-browser-identity') === saved, 'Guest modified author storage.');
  await node.call('stop');
  const reopened = await node.call('read_only');
  assert(reopened.identity === null && reopened.starts === 2, 'Guest restart created an author.');
  await node.call('stop');
  const unlocked = await node.call('unlock', { passphrase: credentials.passphrase });
  assert(unlocked.identity.record_key === author.identity.record_key, 'Guest changed the stored author.');
  await node.call('stop');
  document.getElementById('result').textContent = 'passed';
} catch (failure) {
  document.getElementById('result').textContent = `failed: ${failure.message}`;
} finally {
  node.terminate();
  await fetch('/__check_done');
}
