import { controller } from './test-worker.mjs';
import { storage_snapshot } from './storage-snapshot.mjs';

const assert = (condition, message) => { if (!condition) throw new Error(message); };
const rejects = async operation => {
  let rejected = false;
  try { await operation(); } catch { rejected = true; }
  assert(rejected, 'Operation unexpectedly succeeded.');
};
const namespace = 'murmur-browser-identity';
const credentials = { passphrase: 'disposable identity test passphrase',
  author_name: 'Disposable <b>author</b>', bio: 'A public test profile.' };
let node;
try {
  node = controller();
  assert(await node.call('has_storage') === false, 'Disposable origin already has protected storage.');
  await rejects(() => node.call('unlock', { passphrase: credentials.passphrase }));
  for (const author_name of [' ', '\u732b'.repeat(81)]) {
    await rejects(() => node.call('create', { ...credentials, author_name }));
  }
  await rejects(() => node.call('create', { ...credentials, bio: '\u732b'.repeat(281) }));
  await rejects(() => node.call('create', { ...credentials, passphrase: '' }));
  await rejects(() => node.call('create', { ...credentials, passphrase: '\u732b'.repeat(342) }));
  assert(await node.call('has_storage') === false, 'Rejected setup created protected storage.');

  await node.call('start_protected', credentials.passphrase);
  await node.call('stop');
  await rejects(() => node.call('unlock', { passphrase: credentials.passphrase }));
  const created = await node.call('create', credentials);
  const identity = created.identity;
  assert(created.protected && identity.record_key.startsWith('VLD0:'), 'Protected identity was not created.');
  assert(identity.author_name === credentials.author_name && identity.bio === credentials.bio, 'Profile was not preserved.');
  assert(!/"(?:writer|secret|passphrase)"/.test(JSON.stringify(created)), 'Credentials escaped the worker.');
  assert(JSON.stringify(await node.call('profile')) === JSON.stringify(identity), 'Public identity differs.');
  const draft = 'A disposable encrypted draft';
  await node.call('draft', draft);
  identity.draft = draft;
  assert((await node.call('profile')).draft === draft, 'Draft was not saved.');
  const rows = JSON.parse(await storage_snapshot(namespace));
  assert(!rows.some(row => [row.key, row.value].some(bytes =>
    new TextDecoder().decode(new Uint8Array(bytes)).includes(draft))), 'Draft appeared in plaintext storage.');
  await rejects(() => node.call('publish', 'Must not publish while offline.'));
  await node.call('stop');
  for (const action of ['profile', 'publish', 'identity']) {
    await rejects(() => node.call(action, 'Must stay locked.'));
  }
  const saved = await storage_snapshot(namespace);
  await rejects(() => node.call('unlock', { passphrase: 'wrong passphrase' }));
  assert(await storage_snapshot(namespace) === saved, 'Wrong unlock modified storage.');
  const unlocked = await node.call('unlock', { passphrase: credentials.passphrase });
  assert(JSON.stringify(unlocked.identity) === JSON.stringify(identity), 'Unlock changed the author.');
  await node.call('stop');
  await rejects(() => node.call('create', { ...credentials, author_name: 'Replacement' }));
  assert((await node.call('unlock', { passphrase: credentials.passphrase })).identity.record_key === identity.record_key,
    'Duplicate creation replaced the identity.');
  const competing = controller();
  try { await rejects(() => competing.call('unlock', { passphrase: credentials.passphrase })); }
  finally { competing.terminate(); }
  node.terminate();

  node = controller();
  assert(await node.call('has_storage') === true, 'Stored identity was not detected.');
  assert(JSON.stringify((await node.call('unlock', { passphrase: credentials.passphrase })).identity) === JSON.stringify(identity),
    'Interrupted session did not restore its identity.');
  await node.call('draft', '');
  await node.call('stop');
  assert((await node.call('unlock', { passphrase: credentials.passphrase })).identity.draft === '', 'Cleared draft came back.');
  await node.call('stop');
  document.getElementById('result').textContent = 'passed';
} catch (failure) {
  document.getElementById('result').textContent = `failed: ${failure.message}`;
} finally {
  node?.terminate();
  await fetch('/__check_done');
}
