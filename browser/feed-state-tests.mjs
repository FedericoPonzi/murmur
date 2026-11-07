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
  const { saveFeed, cachedFeeds, timeline } = await import('./feeds.mjs');
  addFollow(storage, 'VLD0:first');
  addFollow(storage, 'VLD0:second');
  const feed = (key, posts) => ({ record_key: key,
    metadata: { author_name: 'Literal <b>author</b>', bio: '', latest_post_index: posts.length - 1 },
    posts: posts.map((timestamp, index) => ({ index, timestamp, content: `Post ${index}` })).reverse() });
  const first = feed('VLD0:first', [10, 5]);
  saveFeed(storage, 'VLD0:first', first, 100);
  saveFeed(storage, 'VLD0:first', first, 101);
  saveFeed(storage, 'VLD0:second', feed('VLD0:second', [20]), 102);
  assert(timeline(storage).map(entry => `${entry.key}/${entry.post.index}`).join(',') ===
    'VLD0:second/0,VLD0:first/0,VLD0:first/1', 'Timeline ordering or deduplication failed.');
  assert(cachedFeeds(storage).find(entry => entry.key === 'VLD0:first').read_at === 101, 'Read freshness was lost.');
  const before = JSON.stringify([...values]);
  rejects(() => saveFeed(storage, 'VLD0:first', { ...first, record_key: 'VLD0:other' }, 103));
  rejects(() => saveFeed(storage, 'VLD0:first', { ...first,
    posts: [{ ...first.posts[0], index: Number.MAX_SAFE_INTEGER + 1 }] }, 103));
  quota = true;
  rejects(() => saveFeed(storage, 'VLD0:first', first, 103));
  assert(JSON.stringify([...values]) === before, 'Bad response or quota failure destroyed cached reads.');
  quota = false;
  removeFollow(storage, 'VLD0:first');
  assert(timeline(storage).length === 1, 'Unfollow left old posts in the timeline.');
  document.getElementById('result').textContent = 'passed';
} catch (failure) {
  document.getElementById('result').textContent = `failed: ${failure.message}`;
} finally {
  await fetch('/__check_done');
}
