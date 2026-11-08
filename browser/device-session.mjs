const database = 'murmur-device-session';
const context = new TextEncoder().encode('murmur-device-session-v1');
const open = () => new Promise((resolve, reject) => {
  const request = indexedDB.open(database, 1);
  let blocked = false;
  request.onupgradeneeded = () => request.result.createObjectStore('access');
  request.onblocked = () => {
    blocked = true;
    reject(new Error('Remembered access storage is busy in another tab. Close that tab and retry.'));
  };
  request.onerror = () => reject(new Error(`Remembered access storage unavailable: ${request.error?.message}`));
  request.onsuccess = () => {
    if (blocked) request.result.close();
    else resolve(request.result);
  };
});
const access = async (mode, operation) => {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('access', mode);
      const request = operation(transaction.objectStore('access'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(new Error(`Remembered access could not be saved or read: ${transaction.error?.message}`));
    });
  } finally { db.close(); }
};
const check = entry => {
  if (entry === undefined) return null;
  if (entry?.version !== 1) throw new Error('Unsupported remembered-access version. Use a compatible app or explicitly forget this device.');
  if (!(entry.key instanceof CryptoKey) || entry.key.extractable || entry.key.algorithm.name !== 'AES-GCM'
    || !(entry.iv instanceof Uint8Array) || entry.iv.length !== 12
    || !(entry.ciphertext instanceof ArrayBuffer) || entry.ciphertext.byteLength > 16384) {
    throw new Error('Damaged remembered access. Forget this device, then unlock with your passphrase.');
  }
  return entry;
};
const read = async () => check(await access('readonly', store => store.get('current')));
export const hasSession = async () => (await read()) !== null;
export const loadSession = async () => {
  const entry = await read();
  if (!entry) return null;
  let bytes;
  try {
    bytes = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: entry.iv, additionalData: context }, entry.key, entry.ciphertext));
    const result = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof result.passphrase !== 'string' || typeof result.recordKey !== 'string') throw new Error('Invalid remembered access.');
    return result;
  } catch (failure) {
    throw new Error('Remembered access cannot be opened. Forget this device, then unlock with your passphrase.', { cause: failure });
  } finally { bytes?.fill(0); }
};
export const rememberSession = async (passphrase, recordKey) => {
  if (typeof passphrase !== 'string' || typeof recordKey !== 'string' || passphrase.length > 4096) {
    throw new Error('Invalid remembered access.');
  }
  await read();
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify({ passphrase, recordKey }));
  try {
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: context }, key, bytes);
    await access('readwrite', store => store.put({ version: 1, key, iv, ciphertext }, 'current'));
  } finally { bytes.fill(0); }
};
export const forgetSession = () => access('readwrite', store => store.delete('current'));
