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
    postMessage({ id, action, value }) {
      value = structuredClone(value);
      const results = {
        has_storage: false, create: { starts: 1, protected: true, identity },
        restore: { starts: 2, protected: true, identity },
        status: { ready: window.networkReady }, identity: identity.record_key,
        reconcile: identity, stop: 'Stopped.',
        backup: '{"header":{"version":1},"ciphertext":[1]}',
        verify_backup: identity.record_key,
      };
      const error = action === 'restore' && value.backup_passphrase !== 'disposable backup passphrase'
        ? 'Wrong passphrase or damaged credential envelope' : undefined;
      queueMicrotask(() => { if (!this.terminated) this.onmessage({ data: { id, result: results[action], error } }); });
    }
    terminate() { this.terminated = true; }
  };
  URL.createObjectURL = blob => { window.downloadedBlob = blob; return 'blob:disposable-test'; };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () { window.downloadName = this.download; };
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
  assert(element('backup-form'), 'Missing encrypted backup form.');
  element('backup-settings').open = true;
  element('backup-passphrase').value = element('backup-confirm').value = 'disposable backup passphrase';
  element('backup-form').requestSubmit();
  await wait(() => frame.contentWindow.downloadedBlob);
  assert(JSON.parse(await frame.contentWindow.downloadedBlob.text()).ciphertext, 'Download is not the encrypted envelope.');
  assert(frame.contentWindow.downloadName.endsWith('.murmur'), 'Backup filename is missing.');
  assert(element('backup-passphrase').value === '' && element('backup-confirm').value === '', 'Backup passwords were retained.');
  const saved = new DataTransfer();
  saved.items.add(new File([await frame.contentWindow.downloadedBlob.text()], 'saved.murmur'));
  element('verify-file').files = saved.files;
  element('verify-passphrase').value = 'disposable backup passphrase';
  element('verify-form').requestSubmit();
  await wait(() => element('status').textContent.startsWith('Verified:'));
  assert(element('verify-passphrase').value === '', 'Verification retained its password.');
  element('stop').click();
  await wait(() => !element('auth').hidden);
  element('show-restore').click();
  const files = new DataTransfer();
  files.items.add(new File(['{"header":{},"ciphertext":[]}'], 'identity.murmur'));
  element('restore-file').files = files.files;
  const fillRestore = passphrase => {
    element('restore-passphrase').value = passphrase;
    element('restore-local-passphrase').value = element('restore-confirm').value = 'new disposable local passphrase';
    element('restore-acknowledge').checked = true;
    element('restore-form').requestSubmit();
  };
  fillRestore('wrong passphrase');
  await wait(() => element('status').textContent.includes('Restore failed'));
  assert(element('session').hidden, 'Failed restore unlocked the identity.');
  assert(element('restore-passphrase').value === '', 'Failed restore retained its password.');
  fillRestore('disposable backup passphrase');
  await wait(() => !element('session').hidden);
  assert(element('own-key').textContent === 'VLD0:disposable', 'Restore changed the identity key.');
  document.getElementById('result').textContent = 'passed';
} catch (failure) {
  document.getElementById('result').textContent = `failed: ${failure.message}`;
} finally {
  frame.remove();
  await fetch('/__check_done');
}
