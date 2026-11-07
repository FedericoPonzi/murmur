const $ = id => document.getElementById(id);
let worker, sequence = 0, polling, generation = 0;
let active = false, attached = false, busy = false, authenticating = true, mode = 'create';
const requests = new Map();
const clearPassphrases = () => {
  for (const id of ['passphrase', 'confirm-passphrase', 'unlock-passphrase', 'restore-passphrase',
    'restore-local-passphrase', 'restore-confirm', 'backup-passphrase', 'backup-confirm', 'verify-passphrase']) $(id).value = '';
};
const controls = () => {
  for (const id of ['create-fields', 'unlock-fields', 'restore-fields', 'start', 'unlock-start',
    'restore-start', 'show-create', 'show-unlock', 'show-restore', 'restore-back']) $(id).disabled = authenticating || active;
  for (const id of ['backup-fields', 'download-backup']) $(id).disabled = !active || !attached || busy;
  for (const id of ['verify-fields', 'verify-backup']) $(id).disabled = !active || busy;
  $('publish').disabled = $('read').disabled = !active || !attached || busy;
  $('content').disabled = busy;
  $('stop').disabled = !active || busy;
  $('bootstrap').disabled = active || authenticating;
};
const showMode = next => {
  mode = next;
  clearPassphrases();
  $('auth').hidden = active;
  $('session').hidden = !active;
  $('create-panel').hidden = mode !== 'create';
  $('unlock-panel').hidden = mode !== 'unlock';
  $('restore-panel').hidden = mode !== 'restore';
  $('show-restore').hidden = mode === 'restore';
  if (mode !== 'restore') $('restore-file').value = '';
};
const finish = message => {
  generation++;
  clearInterval(polling);
  worker?.terminate();
  worker = undefined;
  for (const request of requests.values()) {
    clearTimeout(request.timer);
    request.reject(new Error(message));
  }
  requests.clear();
  active = attached = busy = authenticating = false;
  for (const id of ['profile-name', 'profile-bio', 'own-key', 'feed', 'storage']) $(id).textContent = '';
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
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data.result);
  };
};
const call = (action, value, timeout = 180000) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => {
    finish('Operation timed out. Identity locked; a publication may be uncertain. Unlock and retry only the saved text.');
  }, timeout);
  requests.set(id, { resolve, reject, timer });
  try { worker.postMessage({ id, action, value, bootstrap: $('bootstrap').value }); }
  catch (failure) {
    clearTimeout(timer);
    requests.delete(id);
    reject(failure);
  }
});
const watchAttachment = run => {
  const deadline = Date.now() + 120000;
  let checking = false;
  polling = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const state = await call('status');
      if (run !== generation) return;
      if (state.ready) {
        clearInterval(polling);
        await call('identity');
        const identity = await call('reconcile');
        if (run !== generation) return;
        if (identity.probe_post) $('content').value = identity.probe_post.content;
        else if ($('content').readOnly) $('content').value = '';
        $('content').readOnly = !!identity.probe_post;
        attached = true;
        controls();
        $('status').textContent = 'Connected to Veilid. Ready to publish and read.';
      } else if (Date.now() > deadline) {
        clearInterval(polling);
        $('status').textContent = 'Veilid attachment timed out. Your identity is saved; lock and unlock to retry.';
      }
    } catch (failure) {
      if (run === generation) finish(failure.message);
    } finally { checking = false; }
  }, 1000);
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
    $('profile-name').textContent = state.identity.author_name;
    $('profile-bio').textContent = state.identity.bio;
    $('own-key').textContent = state.identity.record_key;
    $('key').value = state.identity.record_key;
    $('storage').textContent = String(state.starts);
    $('content').value = state.identity.probe_post?.content ?? '';
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
    const url = URL.createObjectURL(new Blob([envelope], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'murmur-identity.murmur';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
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
  clearInterval(polling);
  busy = true;
  controls();
  $('status').textContent = 'Locking identity...';
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
    try {
      const result = await call(action, $(input).value);
      if (run !== generation) return;
      $('feed').textContent = JSON.stringify(result, null, 2);
      $('status').textContent = 'Confirmed.';
      if (action === 'publish') {
        $('content').value = '';
        $('content').readOnly = false;
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
} catch (failure) { finish(`Local storage unavailable: ${failure.message}`); }
