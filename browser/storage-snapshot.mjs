const bytes = value => {
  if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
  if (ArrayBuffer.isView(value)) return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
  return [...new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value))];
};
const request = operation => new Promise((resolve, reject) => {
  operation.onsuccess = () => resolve(operation.result);
  operation.onerror = () => reject(operation.error);
});
export async function storage_snapshot(namespace) {
  const rows = [];
  for (const { name } of (await indexedDB.databases()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!name.includes(namespace)) continue;
    const db = await request(indexedDB.open(name));
    try {
      for (const store of [...db.objectStoreNames].sort()) {
        const object = db.transaction(store).objectStore(store);
        const keys = request(object.getAllKeys());
        const values = request(object.getAll());
        const [foundKeys, foundValues] = await Promise.all([keys, values]);
        foundKeys.forEach((key, index) => rows.push({
          database: name, store, key: bytes(key), value: bytes(foundValues[index]),
        }));
      }
    } finally { db.close(); }
  }
  return JSON.stringify(rows);
}
export async function damage_device_key(namespace) {
  const rows = JSON.parse(await storage_snapshot(namespace));
  const row = rows.find(row => new TextDecoder().decode(new Uint8Array(row.key)) === 'device_encryption_key');
  if (!row) throw new Error('Device key was not persisted.');
  const db = await request(indexedDB.open(row.database));
  try {
    const transaction = db.transaction(row.store, 'readwrite');
    const completed = new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
    transaction.objectStore(row.store).put(new TextEncoder().encode('damaged!'), new Uint8Array(row.key));
    await completed;
  } finally { db.close(); }
}
