const assert = (condition, message) => { if (!condition) throw new Error(message); };
const rejects = operation => {
  try { operation(); } catch { return; }
  throw new Error('Invalid follow state was accepted.');
};
try {
  const { loadFollows, addFollow, removeFollow, resetFollows } = await import('./feeds.mjs');
  const values = new Map();
  let quota = false;
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { if (quota) throw new Error('Quota exceeded'); values.set(key, value); },
  };
  assert(loadFollows(storage).length === 0, 'New follows were not empty.');
  addFollow(storage, 'VLD0:first');
  addFollow(storage, 'VLD0:first');
  addFollow(storage, 'VLD0:second');
  assert(loadFollows(storage).join(',') === 'VLD0:first,VLD0:second', 'Follows did not persist or duplicate was added.');
  removeFollow(storage, 'VLD0:first');
  assert(loadFollows(storage).join(',') === 'VLD0:second', 'Removed follow came back.');
  const saved = [...values];
  quota = true;
  rejects(() => addFollow(storage, 'VLD0:third'));
  assert(JSON.stringify([...values]) === JSON.stringify(saved), 'Failed save destroyed follows.');
  quota = false;
  resetFollows(storage);
  for (let index = 0; index < 50; index++) addFollow(storage, `VLD0:feed-${index}`);
  rejects(() => addFollow(storage, 'VLD0:overflow'));
  assert(loadFollows(storage).length === 50, 'Limit failure changed existing follows.');
  const key = [...values.keys()][0];
  for (const corrupt of ['{', '{"version":99,"follows":[]}', '{"version":1,"follows":[1]}']) {
    values.set(key, corrupt);
    rejects(() => addFollow(storage, 'VLD0:replacement'));
    assert(values.get(key) === corrupt, 'Unreadable saved state was overwritten.');
  }
  resetFollows(storage);
  assert(loadFollows(storage).length === 0, 'Explicit follow reset failed.');
  document.getElementById('result').textContent = 'passed';
} catch (failure) {
  document.getElementById('result').textContent = `failed: ${failure.message}`;
} finally {
  await fetch('/__check_done');
}
