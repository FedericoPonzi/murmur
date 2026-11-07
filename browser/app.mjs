const $ = id => document.getElementById(id);
let worker, sequence = 0, polling, generation = 0;
let active = false, attached = false, busy = false, authenticating = true, mode = 'create';
const requests = new Map();
const clearPassphrases = () => {
  for (const id of ['passphrase', 'confirm-passphrase', 'unlock-passphrase']) $(id).value = '';
};
const controls = () => {
  $('create-fields').disabled = $('unlock-fields').disabled = authenticating || active;
  $('start').disabled = $('unlock-start').disabled = authenticating || active;
  $('show-create').disabled = $('show-unlock').disabled = authenticating || active;
  $('publish').disabled = $('read').disabled = !active || !attached || busy;
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
        if (run !== generation) return;
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
  $('status').textContent = action === 'create' ? 'Creating your identity...' : 'Unlocking your identity...';
  try {
    makeWorker();
    const pending = call(action, value);
    value.passphrase = undefined;
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
    if (run === generation) finish(`${action === 'create' ? 'Creation' : 'Unlock'} failed: ${failure.message}`);
  } finally {
    value.passphrase = undefined;
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
      if (action === 'publish') $('content').readOnly = true;
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
