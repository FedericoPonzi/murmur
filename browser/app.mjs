import { loadFollows, addFollow, removeFollow, resetFollows, saveFeed, cachedFeeds, timeline, markRead, feedLink, sharedFeed,
  exportReadingList, decodeReadingList, importReadingList, READING_LIST_LIMIT, muteFeed, mutedFeeds, STORAGE_KEY } from './feeds.mjs';

const $ = id => document.getElementById(id);
let worker, sequence = 0, polling, generation = 0;
let active = false, attached = false, busy = false, authenticating = true, mode = 'create';
let publicIdentity, draftTimer, draftVersion = 0, guest = false;
let refreshTask;
let pendingFeed, unreadCount = 0;
let lastNodeState, lastChecked;
const feedProgress = new Map();
const requests = new Map();
const renderDiagnostics = () => {
  $('debug-session').textContent = active ? guest ? 'Read-only reader' : 'Author' : authenticating ? 'Starting' : 'Stopped';
  $('debug-connection').textContent = active ? attached ? 'Online' : 'Connecting / offline' : 'Stopped';
  $('debug-attachment').textContent = lastNodeState?.attachment ?? 'Not reported';
  $('debug-peers').textContent = lastNodeState ? `${lastNodeState.reliable_peers} / ${lastNodeState.live_peers}` : 'Not reported';
  $('debug-traffic').textContent = lastNodeState ? `${lastNodeState.download_bps} / ${lastNodeState.upload_bps} B/s` : 'Not reported';
  $('debug-checked').textContent = lastChecked ? lastChecked.toLocaleTimeString() : 'Not yet checked';
  $('debug-requests').textContent = String(requests.size);
};
const mutateReading = operation => {
  const run = generation;
  return navigator.locks.request('murmur-reading-list', () => {
    if (run !== generation || !active) throw new Error('Session ended before preferences could be saved.');
    return operation(localStorage);
  });
};
const downloadFile = (name, text) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};
const clearPassphrases = () => {
  for (const id of ['passphrase', 'confirm-passphrase', 'unlock-passphrase', 'restore-passphrase',
    'restore-local-passphrase', 'restore-confirm', 'backup-passphrase', 'backup-confirm', 'verify-passphrase']) $(id).value = '';
};
const postCard = (post, author) => {
  const article = document.createElement('article');
  article.className = 'post-card';
  const name = document.createElement('strong');
  name.textContent = author;
  const timestamp = document.createElement('time');
  const date = new Date(post.timestamp * 1000);
  timestamp.textContent = Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Timestamp unavailable';
  if (Number.isFinite(date.getTime())) timestamp.dateTime = date.toISOString();
  const content = document.createElement('p');
  content.textContent = post.content;
  article.append(name, timestamp, content);
  return article;
};
const showIdentity = identity => {
  const previous = publicIdentity;
  if (!previous || $('edit-name').value === previous.author_name) $('edit-name').value = identity.author_name;
  if (!previous || $('edit-bio').value === previous.bio) $('edit-bio').value = identity.bio;
  publicIdentity = identity;
  $('profile-name').textContent = identity.author_name;
  $('profile-bio').textContent = identity.bio;
  $('own-key').textContent = identity.record_key;
  const posts = [...(identity.history ?? [])].reverse();
  $('authored-history').replaceChildren(...posts.map(post => postCard(post, identity.author_name)));
  if (!posts.length) $('authored-history').textContent = 'No locally saved posts yet.';
};
const showFeed = result => {
  $('feed').textContent = JSON.stringify(result, null, 2);
  const posts = result.posts ?? [result];
  const author = result.metadata?.author_name ?? publicIdentity.author_name;
  const heading = document.createElement('h3');
  heading.textContent = author;
  const bio = document.createElement('p');
  bio.textContent = result.metadata?.bio ?? '';
  $('feed-cards').replaceChildren(heading, bio, ...posts.map(post => postCard(post, author)));
  if (!posts.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No posts yet.';
    $('feed-cards').append(empty);
  }
};
const controls = () => {
  renderDiagnostics();
  $('follow').disabled = !active || busy;
  $('export-reading').disabled = $('import-reading').disabled = !active || busy;
  $('share-feed').disabled = !active || busy;
  $('share-own').disabled = !active || guest || busy;
  $('mark-read').disabled = !active || busy || !unreadCount;
  $('refresh-timeline').disabled = !active || !attached || busy || !$('follow-list').children.length;
  $('cancel-timeline').disabled = !refreshTask || refreshTask.cancelled;
  for (const button of $('timeline').querySelectorAll('button')) button.disabled = !active || !attached || busy;
  $('reset-follows').disabled = busy;
  for (const button of $('follow-list').querySelectorAll('button')) {
    button.disabled = !active || busy || (button.dataset.action === 'read' && !attached);
  }
  for (const id of ['create-fields', 'unlock-fields', 'restore-fields', 'start', 'unlock-start',
    'restore-start', 'show-create', 'show-unlock', 'show-restore', 'restore-back', 'browse-start']) $(id).disabled = authenticating || active;
  for (const id of ['backup-fields', 'download-backup']) $(id).disabled = !active || guest || !attached || busy;
  for (const id of ['verify-fields', 'verify-backup']) $(id).disabled = !active || guest || busy;
  for (const id of ['profile-fields', 'save-profile']) $(id).disabled = !active || guest || !attached || busy;
  $('copy-key').disabled = !active || guest;
  $('reconnect').disabled = !active || attached || busy;
  $('retry-reader').disabled = !active || attached || busy;
  $('stop-reader').disabled = !active;
  $('publish').textContent = $('content').readOnly ? 'Retry saved post' : 'Publish post';
  $('publish').disabled = $('read').disabled = !active || !attached || busy;
  const length = Array.from($('content').value).length;
  $('content-count').textContent = `${length} / 280`;
  $('publish').disabled ||= guest || !length || length > 280 || !$('content').value.trim();
  $('content').disabled = busy || guest;
  $('stop').disabled = !active || busy;
  $('bootstrap').disabled = active || authenticating;
};
const renderFollows = follows => {
  const muted = mutedFeeds(localStorage);
  $('follow-list').replaceChildren(...follows.map(key => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = key;
    const read = document.createElement('button');
    read.type = 'button';
    read.textContent = 'Read';
    read.dataset.action = 'read';
    read.setAttribute('aria-label', `Read feed ${key}`);
    read.onclick = () => { $('key').value = key; $('read').click(); };
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.dataset.action = 'mute';
    mute.textContent = muted.includes(key) ? 'Unmute' : 'Mute';
    mute.setAttribute('aria-label', `${mute.textContent} ${key}`);
    mute.onclick = () => changeReading(storage => muteFeed(storage, key, !muted.includes(key)),
      'Home preferences saved. Muted feeds can still be read directly.');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Unfollow';
    remove.setAttribute('aria-label', `Unfollow ${key}`);
    remove.onclick = () => changeReading(storage => removeFollow(storage, key), 'Feed removed from your follows.');
    item.append(label, read, mute, remove);
    return item;
  }));
  $('reset-follows').hidden = true;
  renderTimeline();
  controls();
};
const renderTimeline = () => {
  const snapshots = new Map(cachedFeeds(localStorage).map(entry => [entry.key, entry]));
  const entries = timeline(localStorage);
  unreadCount = entries.filter(entry => entry.unread).length;
  $('unread-count').textContent = `${unreadCount} unread cached posts`;
  $('timeline').replaceChildren(...entries.map(entry => {
    const article = postCard(entry.post, entry.metadata.author_name);
    if (entry.unread) {
      const badge = document.createElement('small');
      badge.textContent = 'Unread';
      article.prepend(badge);
    }
    const read = document.createElement('button');
    read.type = 'button';
    read.className = 'quiet-button';
    read.textContent = `Read feed ${entry.key.slice(0, 20)}...`;
    read.title = entry.key;
    read.disabled = !active || !attached || busy;
    read.onclick = () => { $('key').value = entry.key; $('read').click(); };
    article.append(read);
    return article;
  }));
  if (!entries.length) $('timeline').textContent = 'No cached posts yet. Follow a feed and refresh.';
  $('feed-status').replaceChildren(...loadFollows(localStorage).map(key => {
    const item = document.createElement('li');
    const cached = snapshots.get(key), progress = feedProgress.get(key);
    const label = cached?.feed.metadata.author_name ?? key;
    const freshness = cached ? `Cached read: ${new Date(cached.read_at).toLocaleString()}.` : 'No cached read.';
    item.textContent = `${label}: ${progress?.loading ? 'Reading... ' : ''}${progress?.error ? `Read failed: ${progress.error}. ` : ''}${freshness}`;
    return item;
  }));
};
const loadFollowView = () => {
  unreadCount = 0;
  $('unread-count').textContent = '0 unread cached posts';
  $('follow-list').replaceChildren();
  $('timeline').replaceChildren();
  $('feed-status').replaceChildren();
  $('follow-status').textContent = '';
  $('reset-follows').hidden = true;
  try { renderFollows(loadFollows(localStorage)); }
  catch (failure) {
    $('follow-status').textContent = failure.message;
    $('reset-follows').hidden = false;
  }
};
window.addEventListener('storage', event => {
  if (active && event.storageArea === localStorage && (event.key === STORAGE_KEY || event.key === null)) loadFollowView();
});
const changeReading = async (operation, success) => {
  if (!active || busy) return;
  const run = generation;
  busy = true;
  controls();
  try {
    await mutateReading(operation);
    if (run !== generation) return;
    renderFollows(loadFollows(localStorage));
    $('follow-status').textContent = success;
  } catch (failure) {
    if (run === generation) {
      loadFollowView();
      $('follow-status').textContent = `Reading preferences not saved: ${failure.message}`;
    }
  } finally { if (run === generation) { busy = false; controls(); } }
};
$('mark-read').onclick = () => changeReading(markRead, 'Visible cached posts marked as read.');
const copyFeedLink = async key => {
  const run = generation;
  try {
    const canonical = await call('check_key', key);
    if (run !== generation) return;
    await navigator.clipboard.writeText(feedLink(new URL('./index.html', import.meta.url), canonical));
    if (run === generation) $('status').textContent = 'Feed link copied. Anyone with it can read this feed.';
  } catch (failure) {
    if (run === generation) $('status').textContent = `Could not copy feed link: ${failure.message}`;
  }
};
$('share-feed').onclick = () => copyFeedLink($('key').value);
$('share-own').onclick = () => copyFeedLink($('own-key').textContent);
$('export-reading').onclick = () => {
  try {
    downloadFile('murmur-reading-list.json', exportReadingList(localStorage));
    $('follow-status').textContent = 'Reading list prepared. This file is not encrypted and cannot recover your author identity.';
  } catch (failure) { $('follow-status').textContent = `Reading list export failed: ${failure.message}`; }
};
$('reading-form').onsubmit = async event => {
  event.preventDefault();
  if (!active || busy) return;
  const run = generation;
  busy = true;
  controls();
  try {
    const file = $('reading-file').files[0];
    if (!file) throw new Error('Select a reading list file.');
    if (file.size > READING_LIST_LIMIT) throw new Error('Reading list file is too large.');
    const text = await file.text(), incoming = decodeReadingList(text);
    for (const key of incoming.follows) {
      if (run !== generation) return;
      if (await call('check_key', key) !== key) throw new Error('Reading list contains a noncanonical feed key.');
    }
    if (run !== generation) return;
    const follows = await mutateReading(storage => importReadingList(storage, text));
    if (run !== generation) return;
    renderFollows(follows);
    $('follow-status').textContent = 'Reading list merged. Existing follows and cached reads were kept.';
    $('reading-file').value = '';
  } catch (failure) {
    if (run === generation) $('follow-status').textContent = `Reading list import failed: ${failure.message}`;
  } finally { if (run === generation) { busy = false; controls(); } }
};
$('follow').onclick = async () => {
  if (!active || busy) return;
  const run = generation;
  busy = true;
  controls();
  try {
    const key = await call('check_key', $('key').value);
    if (run !== generation) return;
    const follows = await mutateReading(storage => addFollow(storage, key));
    if (run !== generation) return;
    renderFollows(follows);
    $('key').value = key;
    $('follow-status').textContent = 'Feed is in your follows.';
  } catch (failure) {
    if (run === generation) {
      loadFollowView();
      $('follow-status').textContent = `Could not save follow: ${failure.message}`;
    }
  } finally { if (run === generation) { busy = false; controls(); } }
};
$('reset-follows').onclick = () => {
  if (!window.confirm('Reset follows and cached public feeds on this browser? Your author identity will not be changed.')) return;
  changeReading(resetFollows, 'Saved follows reset. Your author identity is unchanged.');
};
$('refresh-timeline').onclick = async () => {
  if (!active || !attached || busy) return;
  const run = generation, task = { cancelled: false };
  refreshTask = task;
  busy = true;
  controls();
  let succeeded = 0, failed = 0;
  try {
    const keys = loadFollows(localStorage);
    for (const key of keys) {
      if (task.cancelled || run !== generation) break;
      feedProgress.set(key, { loading: true });
      renderTimeline();
      $('status').textContent = `Reading followed feed ${succeeded + failed + 1} of ${keys.length}...`;
      try {
        const feed = await call('read', key);
        if (run !== generation) return;
        await mutateReading(storage => saveFeed(storage, key, feed, Date.now()));
        if (run !== generation) return;
        feedProgress.delete(key);
        succeeded++;
      } catch (failure) {
        if (run !== generation) return;
        feedProgress.set(key, { error: failure.message });
        failed++;
      }
      renderTimeline();
    }
    if (run === generation) $('status').textContent = `${task.cancelled ? 'Refresh stopped' : 'Refresh finished'}: ${succeeded} updated, ${failed} failed.`;
  } catch (failure) {
    if (run === generation) {
      loadFollowView();
      $('follow-status').textContent = `Timeline refresh failed: ${failure.message}`;
    }
  } finally {
    if (run === generation) { refreshTask = undefined; busy = false; controls(); }
  }
};
$('cancel-timeline').onclick = () => {
  if (refreshTask) {
    refreshTask.cancelled = true;
    controls();
    $('status').textContent = 'Stopping refresh after the current bounded read finishes...';
  }
};
const showMode = next => {
  mode = next;
  clearPassphrases();
  $('auth').hidden = active;
  $('session').hidden = !active;
  $('session').classList.toggle('reader-session', guest);
  for (const id of ['identity-panel', 'author-tools', 'history-tools']) $(id).hidden = guest;
  $('reader-tools').hidden = !guest;
  if (active) loadFollowView();
  $('create-panel').hidden = mode !== 'create';
  $('unlock-panel').hidden = mode !== 'unlock';
  $('restore-panel').hidden = mode !== 'restore';
  $('show-restore').hidden = mode === 'restore';
  if (mode !== 'restore') $('restore-file').value = '';
};
const finish = message => {
  generation++;
  clearInterval(polling);
  clearTimeout(draftTimer);
  draftVersion++;
  if (refreshTask) refreshTask.cancelled = true;
  refreshTask = undefined;
  feedProgress.clear();
  pendingFeed = undefined;
  unreadCount = 0;
  $('unread-count').textContent = '0 unread cached posts';
  worker?.terminate();
  worker = undefined;
  for (const request of requests.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(message));
  }
  requests.clear();
  lastNodeState = lastChecked = undefined;
  active = attached = busy = authenticating = false;
  guest = false;
  for (const id of ['profile-name', 'profile-bio', 'own-key', 'feed', 'feed-cards', 'authored-history', 'draft-status', 'storage', 'follow-list', 'follow-status', 'timeline', 'feed-status']) $(id).textContent = '';
  $('reset-follows').hidden = true;
  publicIdentity = undefined;
  $('key').value = $('content').value = '';
  $('content').readOnly = false;
  showMode(mode);
  controls();
  $('status').textContent = message;
};
const makeWorker = () => {
  if (worker) return;
  const current = new Worker('./worker.mjs', { type: 'module' });
  worker = current;
  current.onerror = event => {
    if (worker === current) finish(`Worker failed: ${event.message}`);
  };
  current.onmessage = ({ data }) => {
    if (worker !== current) return;
    const request = requests.get(data.id);
    if (!request) {
      if (data.error && active) finish(data.error);
      return;
    }
    clearTimeout(request.timer);
    requests.delete(data.id);
    renderDiagnostics();
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
};
const call = (action, value, timeout = 180000) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    finish(guest ? 'Read operation timed out. Reader stopped; start reading again to retry.'
      : action === 'publish'
      ? 'Publication confirmation timed out. Identity locked; unlock and retry only the saved text.'
      : 'Operation timed out. Identity locked; unlock to retry.');
  }, timeout);
  requests.set(id, { resolve, reject, timer });
  renderDiagnostics();
  try { worker.postMessage({ id, action, value, bootstrap: $('bootstrap').value }); }
  catch (failure) {
    clearTimeout(timer);
    requests.delete(id);
    renderDiagnostics();
    reject(failure);
  }
});
const watchAttachment = run => {
  clearInterval(polling);
  let deadline = Date.now() + 120000, checking = false, paused = false, expired = false;
  polling = setInterval(async () => {
    if (checking || paused || busy || !active) return;
    checking = true;
    try {
      const state = await call('status');
      if (run !== generation || busy) return;
      lastNodeState = state;
      lastChecked = new Date();
      renderDiagnostics();
      if (state.ready && !attached) {
        let identity;
        if (!guest) {
          await call('identity');
          identity = await call('reconcile');
        }
        if (run !== generation || busy) return;
        if (identity) {
          if (identity.probe_post) $('content').value = identity.probe_post.content;
          else if ($('content').readOnly) $('content').value = '';
          $('content').readOnly = !!identity.probe_post;
          showIdentity(identity);
        }
        attached = true;
        expired = false;
        controls();
        $('status').textContent = guest ? 'Connected to Veilid. Read-only session ready.'
          : identity.probe_post
          ? 'Connected. A publication needs confirmation; retry only its saved text.'
          : 'Connected to Veilid. Ready to publish and read.';
        if (guest && pendingFeed) {
          $('key').value = pendingFeed;
          pendingFeed = undefined;
          $('read').click();
        }
      } else if (!state.ready) {
        if (attached) {
          attached = false;
          deadline = Date.now() + 120000;
          expired = false;
          controls();
          $('status').textContent = 'Offline. Your saved work stays local; waiting to reconnect.';
        }
        if (!expired && Date.now() > deadline) {
          expired = true;
          $('status').textContent = 'Still offline. Saved work stays local. Use Retry connection to restart networking.';
        }
      }
    } catch (failure) {
      if (run === generation) {
        paused = true;
        attached = false;
        controls();
        $('status').textContent = `Connection check failed: ${failure.message}. Use Retry connection.`;
      }
    } finally { checking = false; }
  }, 1000);
};
$('browse-start').onclick = async () => {
  const run = ++generation;
  guest = true;
  authenticating = true;
  clearPassphrases();
  controls();
  $('status').textContent = 'Starting read-only Veilid node...';
  try {
    makeWorker();
    const state = await call('read_only');
    if (run !== generation) return;
    if (!state.reader || state.identity !== null) throw new Error('Reader did not return an author-free session.');
    active = true;
    authenticating = false;
    $('storage').textContent = String(state.starts);
    showMode(mode);
    controls();
    $('status').textContent = 'Reader started. Connecting to Veilid...';
    watchAttachment(run);
  } catch (failure) { if (run === generation) finish(`Reader failed: ${failure.message}`); }
};
const authenticate = async (action, value) => {
  const run = ++generation;
  authenticating = true;
  controls();
  const label = { create: 'Creation', unlock: 'Unlock', restore: 'Restore' }[action];
  $('status').textContent = action === 'restore'
    ? 'Restoring identity. Connecting to verify feed ownership...'
    : action === 'create' ? 'Creating your identity...' : 'Unlocking your identity...';
  try {
    makeWorker();
    const pending = call(action, value);
    value.passphrase = undefined;
    value.backup_passphrase = undefined;
    clearPassphrases();
    const state = await pending;
    if (run !== generation) return;
    if (!state.identity) throw new Error('No local author identity was returned.');
    active = true;
    authenticating = false;
    mode = 'unlock';
    showIdentity(state.identity);
    $('key').value = state.identity.record_key;
    $('storage').textContent = String(state.starts);
    $('content').value = state.identity.probe_post?.content ?? state.identity.draft ?? '';
    $('draft-status').textContent = state.identity.draft ? 'Draft restored from encrypted storage.' : 'Unpublished drafts stay in this browser, not in backups.';
    $('content').readOnly = !!state.identity.probe_post;
    showMode(mode);
    controls();
    $('status').textContent = 'Identity unlocked. Connecting to Veilid...';
    watchAttachment(run);
  } catch (failure) {
    if (run === generation) finish(`${label} failed: ${failure.message}`);
  } finally {
    value.passphrase = undefined;
    value.backup_passphrase = undefined;
    clearPassphrases();
  }
};
$('create-form').onsubmit = event => {
  event.preventDefault();
  if ($('passphrase').value !== $('confirm-passphrase').value) {
    $('status').textContent = 'Passphrases do not match.';
    return;
  }
  authenticate('create', {
    passphrase: $('passphrase').value,
    author_name: $('author-name').value,
    bio: $('bio').value,
  });
};
$('unlock-form').onsubmit = event => {
  event.preventDefault();
  authenticate('unlock', { passphrase: $('unlock-passphrase').value });
};
$('show-create').onclick = () => showMode('create');
$('show-unlock').onclick = () => showMode('unlock');
$('show-restore').onclick = () => showMode('restore');
$('restore-back').onclick = () => showMode('create');
const saveDraft = async () => {
  if (!active || guest || $('content').readOnly) return true;
  const run = generation, version = ++draftVersion;
  $('draft-status').textContent = 'Saving draft...';
  try {
    await call('draft', $('content').value);
    if (run === generation && version === draftVersion) $('draft-status').textContent = 'Draft saved on this browser.';
    return true;
  } catch (failure) {
    if (run === generation && version === draftVersion) $('draft-status').textContent = `Draft not saved: ${failure.message}`;
    return false;
  }
};
$('content').oninput = () => {
  controls();
  draftVersion++;
  clearTimeout(draftTimer);
  $('draft-status').textContent = 'Draft has unsaved changes.';
  draftTimer = setTimeout(saveDraft, 300);
};
$('profile-form').onsubmit = async event => {
  event.preventDefault();
  if (busy || !attached) return;
  const run = generation;
  busy = true;
  controls();
  $('status').textContent = 'Updating public profile...';
  try {
    const identity = await call('update_profile', { author_name: $('edit-name').value, bio: $('edit-bio').value });
    if (run === generation) { showIdentity(identity); $('status').textContent = 'Public profile updated.'; }
  } catch (failure) {
    if (run === generation) $('status').textContent = `Profile update not confirmed: ${failure.message}`;
  } finally { if (run === generation) { busy = false; controls(); } }
};
$('copy-key').onclick = async () => {
  const run = generation;
  try {
    await navigator.clipboard.writeText($('own-key').textContent);
    if (run === generation) $('status').textContent = 'RecordKey copied.';
  } catch (failure) {
    if (run === generation) $('status').textContent = `Copy failed: ${failure.message}. Select the RecordKey to copy it manually.`;
  }
};
$('reconnect').onclick = async () => {
  if (!active || busy) return;
  const run = generation;
  busy = true;
  attached = false;
  controls();
  $('status').textContent = 'Restarting network connection. Saved work is unchanged.';
  try {
    await call('reconnect');
    if (run === generation) watchAttachment(run);
  } catch (failure) {
    if (run === generation) $('status').textContent = `Reconnect failed: ${failure.message}`;
  } finally { if (run === generation) { busy = false; controls(); } }
};
$('retry-reader').onclick = () => $('reconnect').onclick();
$('stop-reader').onclick = () => finish('Reader stopped.');
const readBackup = async id => {
  const file = $(id).files[0];
  if (!file) throw new Error('Select an encrypted backup.');
  if (file.size > 8 * 1024 * 1024 + 2048) throw new Error('Backup file is too large.');
  return file.text();
};
$('restore-form').onsubmit = async event => {
  event.preventDefault();
  if (authenticating) return;
  if ($('restore-local-passphrase').value !== $('restore-confirm').value) {
    $('status').textContent = 'Browser passphrases do not match.';
    return;
  }
  authenticating = true;
  controls();
  try {
    const backup = await readBackup('restore-file');
    await authenticate('restore', {
      backup, backup_passphrase: $('restore-passphrase').value,
      passphrase: $('restore-local-passphrase').value,
    });
  } catch (failure) { finish(`Restore failed: ${failure.message}`); }
};
$('backup-form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  if ($('backup-passphrase').value !== $('backup-confirm').value) {
    $('status').textContent = 'Backup passphrases do not match.';
    return;
  }
  const run = generation;
  busy = true;
  controls();
  $('status').textContent = 'Encrypting backup...';
  try {
    const pending = call('backup', $('backup-passphrase').value);
    clearPassphrases();
    const envelope = await pending;
    if (run !== generation) return;
    downloadFile('murmur-identity.murmur', envelope);
    $('status').textContent = 'Backup prepared. Save the file, then verify the saved copy below.';
  } catch (failure) {
    if (run === generation) $('status').textContent = `Backup failed: ${failure.message}`;
  } finally {
    clearPassphrases();
    if (run === generation) { busy = false; controls(); }
  }
};
$('verify-form').onsubmit = async event => {
  event.preventDefault();
  if (busy) return;
  const run = generation;
  busy = true;
  controls();
  try {
    const backup = await readBackup('verify-file');
    if (run !== generation) return;
    const pending = call('verify_backup', { backup, passphrase: $('verify-passphrase').value });
    clearPassphrases();
    await pending;
    if (run === generation) $('status').textContent = 'Verified: this saved backup recovers your identity. Keep its passphrase safe.';
  } catch (failure) {
    if (run === generation) $('status').textContent = `Backup verification failed: ${failure.message}`;
  } finally {
    clearPassphrases();
    if (run === generation) { busy = false; controls(); }
  }
};
$('stop').onclick = async () => {
  const run = generation;
  busy = true;
  controls();
  $('status').textContent = 'Locking identity...';
  clearTimeout(draftTimer);
  const saved = await saveDraft();
  if (run !== generation) return;
  if (!saved) {
    if (!window.confirm(`${$('draft-status').textContent}. Lock anyway and discard the unsaved draft?`)) {
      busy = false;
      controls();
      $('status').textContent = 'Lock cancelled. Copy your unsaved draft before closing the page.';
      return;
    }
  }
  clearInterval(polling);
  try { await call('stop'); finish('Identity locked.'); }
  catch (failure) { finish(`Lock failed: ${failure.message}`); }
};
for (const [button, action, input] of [['publish', 'publish', 'content'], ['read', 'read', 'key']]) {
  $(button).onclick = async () => {
    const run = generation;
    busy = true;
    controls();
    $('status').textContent = action === 'publish' ? 'Publishing; do not resend different text.' : 'Reading...';
    $('feed').textContent = '';
    $('feed-cards').replaceChildren();
    if (action === 'publish') { clearTimeout(draftTimer); draftVersion++; }
    try {
      const result = await call(action, $(input).value);
      if (run !== generation) return;
      showFeed(result);
      $('status').textContent = 'Confirmed.';
      if (action === 'publish') {
        $('content').value = '';
        $('content').readOnly = false;
        $('draft-status').textContent = 'Published. Your next draft will be saved here.';
        showIdentity({ ...publicIdentity, probe_post: null, draft: '',
          history: [...(publicIdentity.history ?? []).filter(post => post.index !== result.index), result]
            .sort((a, b) => a.index - b.index).slice(-1000) });
      }
    } catch (failure) {
      if (run !== generation) return;
      $('status').textContent = failure.message;
      if (action === 'publish') {
        try {
          const identity = await call('profile');
          if (run !== generation) return;
          if (identity?.probe_post) {
            $('content').value = identity.probe_post.content;
            $('content').readOnly = true;
          } else {
            $('content').readOnly = false;
            await saveDraft();
          }
        } catch (profileFailure) {
          if (run === generation) finish(profileFailure.message);
        }
      }
    } finally {
      if (run === generation) { busy = false; controls(); }
    }
  };
}
try {
  makeWorker();
  const exists = await call('has_storage', undefined, 10000);
  authenticating = false;
  showMode(exists ? 'unlock' : 'create');
  controls();
  $('status').textContent = exists ? 'Your identity is locked.' : 'Create a local identity to get started.';
  try {
    const requested = sharedFeed(location.href);
    if (requested !== null) {
      pendingFeed = await call('check_key', requested, 30000);
      $('key').value = pendingFeed;
      $('browse-start').click();
    }
  } catch (failure) { $('status').textContent = `Invalid shared feed link: ${failure.message}`; }
} catch (failure) { finish(`Local storage unavailable: ${failure.message}`); }
