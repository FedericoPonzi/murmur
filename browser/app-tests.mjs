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
  localStorage.setItem('murmur-follows-v1', JSON.stringify({ version: 1, follows: ['VLD0:existing'] }));
  window.authorStarts = 0;
  window.confirm = () => false;
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.copiedText = value; } } });
  const identity = { record_key: 'VLD0:disposable', author_name: 'Disposable author', bio: '', probe_post: null,
    draft: '', history: [{ index: 0, timestamp: 1, content: 'Existing <b>literal</b> post' }] };
  window.Worker = class {
    postMessage({ id, action, value }) {
      value = structuredClone(value);
      if (['create', 'unlock', 'restore'].includes(action)) window.authorStarts++;
      if (action === 'publish') window.publishCalls = (window.publishCalls ?? 0) + 1;
      if (action === 'draft' && !window.failDraft) {
        identity.draft = window.lastSavedDraft = value;
      }
      if (action === 'update_profile') Object.assign(identity, value);
      const results = {
        has_storage: false, create: { starts: 1, protected: true, identity },
        restore: { starts: 2, protected: true, identity },
        status: { ready: window.networkReady }, identity: identity.record_key,
        reconcile: identity, stop: 'Stopped.',
        backup: '{"header":{"version":1},"ciphertext":[1]}',
        verify_backup: identity.record_key,
        profile: identity, update_profile: identity,
        read_only: { starts: 1, reader: true, protected: false, identity: null },
        check_key: value,
        read: { record_key: 'VLD0:remote', metadata: { author_name: 'Remote <b>author</b>', bio: '' },
          posts: [{ index: 0, timestamp: 1, content: 'A guest-readable <b>post</b>' }] },
      };
      const error = action === 'restore' && value.backup_passphrase !== 'disposable backup passphrase'
        ? 'Wrong passphrase or damaged credential envelope'
        : action === 'draft' && window.failDraft ? 'Storage unavailable'
        : action === 'publish' ? 'Network temporarily unavailable'
        : action === 'read' && value === 'VLD0:existing' ? 'This feed is unavailable' : undefined;
      if (action === 'read' && value !== 'VLD0:existing') results.read.metadata.latest_post_index = 0;
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
  const source = (await (await fetch('./index.html')).text())
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '');
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
  assert(element('follow-list').textContent.includes('VLD0:existing'), 'Author session did not load saved follows.');
  frame.contentWindow.failDraft = true;
  element('content').value = 'An unsaved draft before connecting';
  element('content').dispatchEvent(new Event('input'));
  element('stop').click();
  await wait(() => element('status').textContent.startsWith('Lock cancelled'));
  frame.contentWindow.failDraft = false;
  const draft = 'A draft typed while connecting';
  element('content').value = draft;
  element('content').dispatchEvent(new Event('input'));
  await wait(() => element('draft-status')?.textContent === 'Draft saved on this browser.');
  frame.contentWindow.networkReady = true;
  await wait(() => !element('publish').disabled);
  assert(element('content').value === draft, 'Attachment erased the draft.');
  const latest = 'Text typed immediately before a failed publish';
  element('content').value = latest;
  element('content').dispatchEvent(new Event('input'));
  element('publish').click();
  await wait(() => frame.contentWindow.lastSavedDraft === latest);
  assert(!element('content').readOnly, 'A pre-publication failure froze the draft.');
  frame.contentWindow.networkReady = false;
  await wait(() => element('read').disabled);
  assert(element('content').value === latest, 'Going offline erased the draft.');
  frame.contentWindow.networkReady = true;
  await wait(() => !element('read').disabled);
  assert(frame.contentWindow.publishCalls === 1, 'Reconnection resent the post automatically.');
  assert(element('authored-history').textContent.includes('Existing <b>literal</b> post'), 'Local history was not rendered.');
  assert(!element('authored-history').querySelector('b'), 'Post text was interpreted as markup.');
  element('profile-settings').open = true;
  element('edit-name').value = 'New <b>author</b>';
  element('edit-bio').value = 'Updated bio';
  element('profile-form').requestSubmit();
  await wait(() => element('profile-name').textContent === 'New <b>author</b>');
  assert(element('own-key').textContent === 'VLD0:disposable', 'Profile editing changed the feed key.');
  assert(!element('profile-name').querySelector('b'), 'Profile name was interpreted as markup.');
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
  element('stop').click();
  await wait(() => !element('auth').hidden);
  assert(element('browse-start'), 'Missing identity-free reading.');
  const authorStarts = frame.contentWindow.authorStarts;
  element('browse-start').click();
  await wait(() => !element('session').hidden);
  assert(element('identity-panel').hidden && element('author-tools').hidden, 'Guest was shown publishing tools.');
  await wait(() => !element('read').disabled);
  element('key').value = 'VLD0:remote';
  element('read').click();
  await wait(() => element('feed-cards').textContent.includes('guest-readable'));
  assert(!element('feed-cards').querySelector('b'), 'Guest content was interpreted as markup.');
  assert(frame.contentWindow.authorStarts === authorStarts, 'Guest started an author session.');
  assert(element('follow'), 'Missing saved follows.');
  element('follow').click();
  await wait(() => element('follow-list').textContent.includes('VLD0:remote'));
  element('follow').click();
  await wait(() => !element('follow').disabled);
  assert(element('follow-list').querySelectorAll('li').length === 2, 'Duplicate follow was saved.');
  assert(element('refresh-timeline'), 'Missing merged timeline.');
  element('refresh-timeline').click();
  await wait(() => !element('refresh-timeline').disabled);
  assert(element('timeline').textContent.includes('guest-readable'), 'One failed feed hid successful posts.');
  assert(element('feed-status').textContent.includes('This feed is unavailable'), 'Per-feed failure was hidden.');
  assert(!element('timeline').querySelector('b'), 'Timeline interpreted text as HTML.');
  element('refresh-timeline').click();
  await wait(() => !element('refresh-timeline').disabled);
  assert(element('timeline').querySelectorAll('article').length === 1, 'Refresh duplicated cached posts.');
  assert(element('unread-count')?.textContent.includes('1 unread'), 'Unread posts were not counted.');
  element('mark-read').click();
  assert(element('unread-count').textContent.includes('0 unread'), 'Explicit read marker did not clear the badge.');
  element('share-feed').click();
  await wait(() => frame.contentWindow.copiedText);
  assert(new URL(frame.contentWindow.copiedText).searchParams.get('feed') === 'VLD0:remote', 'Copied link points to a different feed.');
  element('export-reading').click();
  await wait(() => frame.contentWindow.downloadName === 'murmur-reading-list.json');
  const reading = await frame.contentWindow.downloadedBlob.text();
  assert(JSON.parse(reading).follows.includes('VLD0:remote'), 'Reading list download lost follows.');
  assert(!reading.includes('guest-readable'), 'Reading list download included cached posts.');
  const readingFiles = new DataTransfer();
  readingFiles.items.add(new File([JSON.stringify({ ...JSON.parse(reading), follows: ['VLD0:imported'], seen: {} })], 'reading.json'));
  element('reading-file').files = readingFiles.files;
  element('reading-form').requestSubmit();
  await wait(() => element('follow-list').textContent.includes('VLD0:imported'));
  assert(element('follow-list').textContent.includes('VLD0:remote'), 'Import replaced the existing list.');
  const remoteItem = () => Array.from(element('follow-list').querySelectorAll('li')).find(item => item.textContent.includes('VLD0:remote'));
  remoteItem().querySelector('[data-action="mute"]').click();
  await wait(() => !element('timeline').textContent.includes('guest-readable'));
  assert(remoteItem().textContent.includes('Unmute'), 'Muted follow disappeared instead of offering unmute.');
  element('key').value = 'VLD0:remote';
  element('read').click();
  await wait(() => element('feed-cards').textContent.includes('guest-readable'));
  remoteItem().querySelector('[data-action="mute"]').click();
  await wait(() => element('timeline').textContent.includes('guest-readable'));
  Array.from(element('follow-list').querySelectorAll('li')).find(item => item.textContent.includes('VLD0:remote'))
    .querySelector('button:last-child').click();
  await wait(() => !element('follow-list').textContent.includes('VLD0:remote'));
  element('stop-reader').click();
  await wait(() => !element('auth').hidden);
  frame.contentWindow.localStorage.setItem('murmur-follows-v1', '{');
  element('browse-start').click();
  await wait(() => !element('session').hidden);
  assert(element('follow-list').children.length === 0, 'Unreadable follows left an old list visible.');
  assert(!element('reset-follows').hidden, 'Unreadable follows cannot be reset explicitly.');
  document.getElementById('result').textContent = 'passed';
} catch (failure) {
  document.getElementById('result').textContent = `failed: ${failure.message}`;
} finally {
  frame.remove();
  await fetch('/__check_done');
}
