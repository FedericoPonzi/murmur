const STORAGE_KEY = 'murmur-follows-v1';
export const FOLLOW_LIMIT = 50;

const validate = state => {
  if (!state || state.version !== 1 || !Array.isArray(state.follows)
      || state.follows.length > FOLLOW_LIMIT
      || new Set(state.follows).size !== state.follows.length
      || Object.keys(state).some(key => !['version', 'follows'].includes(key))
      || state.follows.some(key => typeof key !== 'string' || !key || key.length > 512)) {
    throw new Error('Saved follows are invalid or incompatible. They have not been replaced.');
  }
  return state;
};
const load = storage => {
  const saved = storage.getItem(STORAGE_KEY);
  if (saved === null) return { version: 1, follows: [] };
  let state;
  try { state = JSON.parse(saved); }
  catch { throw new Error('Saved follows cannot be decoded. They have not been replaced.'); }
  return validate(state);
};
const save = (storage, state) => {
  validate(state);
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  return save(storage, state);
}
export const resetFollows = storage => save(storage, { version: 1, follows: [] });
