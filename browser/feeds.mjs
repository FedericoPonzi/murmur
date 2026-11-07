const STORAGE_KEY = 'murmur-follows-v1';
export const FOLLOW_LIMIT = 50;
const MAX_SAVED = 2 * 1024 * 1024;
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fields = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const validFeed = (key, feed) => {
  if (!fields(feed, ['record_key', 'metadata', 'posts']) || feed.record_key !== key
      || !fields(feed.metadata, ['author_name', 'bio', 'latest_post_index'])) return false;
  const { author_name: name, bio, latest_post_index: latest } = feed.metadata;
  return typeof name === 'string' && !!name.trim() && Array.from(name).length <= 80
    && typeof bio === 'string' && Array.from(bio).length <= 280
    && (latest === null || integer(latest)) && Array.isArray(feed.posts)
    && feed.posts.length === (latest === null ? 0 : Math.min(latest + 1, 20))
    && feed.posts.every((post, position) => fields(post, ['index', 'timestamp', 'content'])
      && integer(post.index) && post.index === latest - position && integer(post.timestamp)
      && typeof post.content === 'string' && !!post.content.trim() && Array.from(post.content).length <= 280);
};

const validate = state => {
  if (!state || state.version !== 1 || !Array.isArray(state.follows)
      || state.follows.length > FOLLOW_LIMIT
      || new Set(state.follows).size !== state.follows.length
      || Object.keys(state).some(key => !['version', 'follows', 'cache', 'seen'].includes(key))
      || state.follows.some(key => typeof key !== 'string' || !key.startsWith('VLD0:') || key.length > 512)) {
    throw new Error('Saved follows are invalid or incompatible. They have not been replaced.');
  }
  if (state.cache !== undefined && (!state.cache || typeof state.cache !== 'object' || Array.isArray(state.cache)
      || Object.entries(state.cache).some(([key, entry]) => !state.follows.includes(key)
        || !fields(entry, ['feed', 'read_at']) || !integer(entry.read_at) || !validFeed(key, entry.feed)))) {
    throw new Error('Saved feed cache is invalid or incompatible. It has not been replaced.');
  }
  if (state.seen !== undefined && (!state.seen || typeof state.seen !== 'object' || Array.isArray(state.seen)
      || Object.entries(state.seen).some(([key, index]) => !state.follows.includes(key) || !integer(index)))) {
    throw new Error('Saved unread state is invalid or incompatible. It has not been replaced.');
  }
  return state;
};
const load = storage => {
  const saved = storage.getItem(STORAGE_KEY);
  if (saved === null) return { version: 1, follows: [] };
  if (saved.length > MAX_SAVED) throw new Error('Saved feed data exceeds the local size limit.');
  let state;
  try { state = JSON.parse(saved); }
  catch { throw new Error('Saved follows cannot be decoded. They have not been replaced.'); }
  return validate(state);
};
const save = (storage, state) => {
  validate(state);
  const encoded = JSON.stringify(state);
  if (encoded.length > MAX_SAVED) throw new Error('Saved feed data exceeds the local size limit.');
  storage.setItem(STORAGE_KEY, encoded);
  return state.follows;
};
export const loadFollows = storage => load(storage).follows;
export function addFollow(storage, key) {
  const state = load(storage);
  if (state.follows.includes(key)) return state.follows;
  if (state.follows.length === FOLLOW_LIMIT) throw new Error(`At most ${FOLLOW_LIMIT} feeds can be followed.`);
  state.follows.push(key);
  return save(storage, state);
}
export function removeFollow(storage, key) {
  const state = load(storage);
  if (!state.follows.includes(key)) throw new Error('This feed is no longer followed.');
  state.follows = state.follows.filter(existing => existing !== key);
  if (state.cache) delete state.cache[key];
  if (state.seen) delete state.seen[key];
  return save(storage, state);
}
export const resetFollows = storage => save(storage, { version: 1, follows: [] });
export function saveFeed(storage, key, feed, read_at) {
  const state = load(storage);
  if (!state.follows.includes(key)) throw new Error('This feed is no longer followed.');
  if (!integer(read_at) || !validFeed(key, feed)) throw new Error('Invalid or incompatible feed response.');
  const previous = Object.hasOwn(state.cache ?? {}, key) ? state.cache[key].feed.metadata.latest_post_index : null;
  if (previous !== null && (feed.metadata.latest_post_index === null || feed.metadata.latest_post_index < previous)) {
    throw new Error('Feed returned an older snapshot; keeping the newer cached read.');
  }
  state.cache = { ...state.cache, [key]: { feed, read_at } };
  save(storage, state);
}
export function cachedFeeds(storage) {
  const state = load(storage);
  return state.follows.flatMap(key => Object.hasOwn(state.cache ?? {}, key)
    ? [{ key, ...state.cache[key] }] : []);
}
export function timeline(storage) {
  const state = load(storage);
  return cachedFeeds(storage).flatMap(({ key, feed, read_at }) =>
    feed.posts.map(post => ({ key, metadata: feed.metadata, post, read_at,
      unread: !Object.hasOwn(state.seen ?? {}, key) || post.index > state.seen[key] })))
    .sort((a, b) => b.post.timestamp - a.post.timestamp
      || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || b.post.index - a.post.index);
}
export function markRead(storage) {
  const state = load(storage);
  const seen = { ...state.seen };
  for (const [key, entry] of Object.entries(state.cache ?? {})) {
    const index = entry.feed.metadata.latest_post_index;
    if (index !== null) seen[key] = Math.max(Object.hasOwn(seen, key) ? seen[key] : 0, index);
  }
  state.seen = seen;
  save(storage, state);
}
export function feedLink(base, key) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Feed links require an HTTP address.');
  url.search = '';
  url.hash = '';
  url.searchParams.set('feed', key);
  return url.href;
}
export function sharedFeed(address) {
  const keys = new URL(address).searchParams.getAll('feed');
  if (!keys.length) return null;
  if (keys.length !== 1 || !keys[0].trim() || keys[0].length > 512) throw new Error('Use exactly one complete feed key.');
  return keys[0];
}
