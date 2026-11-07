const assert = (condition, message) => { if (!condition) throw new Error(message); };
const wait = async condition => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('App state timed out.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
function installWorker() {
  window.networkReady = false;
  const identity = { record_key: 'VLD0:disposable', author_name: 'Disposable author', bio: '', probe_post: null };
  window.Worker = class {
    postMessage({ id, action }) {
      const results = {
        has_storage: false, create: { starts: 1, protected: true, identity },
        status: { ready: window.networkReady }, identity: identity.record_key,
        reconcile: identity, stop: 'Stopped.',
      };
      queueMicrotask(() => { if (!this.terminated) this.onmessage({ data: { id, result: results[action] } }); });
    }
    terminate() { this.terminated = true; }
  };
}
const frame = document.createElement('iframe');
frame.hidden = true;
try {
  const source = await (await fetch('./index.html')).text();
  const script = '<script type="module" src="./app.mjs"></script>';
  assert(source.includes(script), 'App module was not found.');
  frame.srcdoc = source.replace(script, `<script>(${installWorker.toString()})();</script>${script}`);
  document.body.append(frame);
  const element = id => frame.contentDocument.getElementById(id);
  await wait(() => element('start') && !element('start').disabled);
  element('author-name').value = 'Disposable author';
  element('passphrase').value = element('confirm-passphrase').value = 'disposable passphrase';
  element('acknowledge').checked = true;
  element('create-form').requestSubmit();
  await wait(() => !element('session').hidden);
  const draft = 'A draft typed while connecting';
  element('content').value = draft;
  frame.contentWindow.networkReady = true;
  await wait(() => !element('publish').disabled);
  assert(element('content').value === draft, 'Attachment erased the draft.');
  document.getElementById('result').textContent = 'passed';
} catch (failure) {
  document.getElementById('result').textContent = `failed: ${failure.message}`;
} finally {
  frame.remove();
  await fetch('/__check_done');
}
