const assert = (condition, message) => { if (!condition) throw new Error(message); };
try {
  const { rememberSession, loadSession, forgetSession, hasSession } = await import('./device-session.mjs');
  assert(await loadSession() === null, 'A fresh device already has remembered access.');
  await rememberSession('disposable remembered passphrase', 'VLD0:disposable');
  assert(await hasSession(), 'Remembered access was not persisted.');
  const restored = await loadSession();
  assert(restored.passphrase === 'disposable remembered passphrase' && restored.recordKey === 'VLD0:disposable',
    'Reload lost the passphrase or identity binding.');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('murmur-device-session', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const entry = await new Promise(resolve => {
    db.transaction('access').objectStore('access').get('current').onsuccess = event => resolve(event.target.result);
  });
  assert(entry.key.extractable === false && entry.ciphertext instanceof ArrayBuffer && !JSON.stringify(entry).includes('passphrase'),
    'Remembered material is not wrapped with a non-extractable device key.');
  entry.version = 2;
  await new Promise((resolve, reject) => {
    const transaction = db.transaction('access', 'readwrite');
    transaction.objectStore('access').put(entry, 'current');
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  for (const operation of [loadSession, () => rememberSession('replacement passphrase', 'VLD0:other')]) {
    let failed = false;
    try { await operation(); } catch (failure) { failed = /version/i.test(failure.message); }
    assert(failed, 'Unknown remembered-access version was read or overwritten.');
  }
  db.close();
  await forgetSession();
  assert(!await hasSession() && await loadSession() === null, 'Logout did not revoke remembered access.');
  document.getElementById('result').textContent = 'passed';
} catch (failure) {
  document.getElementById('result').textContent = `failed: ${failure.stack ?? failure.message}`;
} finally { await fetch('/__check_done'); }
