const assert = (condition, message) => { if (!condition) throw new Error(message); };
const wait = async condition => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('App state timed out.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
function installWorker(existing = false) {
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
      if (['create', 'unlock', 'restore'].includes(action)) window.rememberChoice = value.remember;
      if (action === 'logout') window.loggedOut = true;
      if (['create', 'unlock', 'restore'].includes(action)) window.authorStarts++;
      if (action === 'publish') window.publishCalls = (window.publishCalls ?? 0) + 1;
      if (action === 'read') (window.feedReads ??= []).push(value);
      if (action === 'draft' && !window.failDraft) {
        identity.draft = window.lastSavedDraft = value;
      }
      if (action === 'update_profile') Object.assign(identity, value);
      const results = {
        has_storage: existing, has_remembered: false, create: { starts: 1, protected: true, identity },
        unlock: { starts: 1, protected: true, identity },
        restore: { starts: 2, protected: true, identity },
        status: { ready: window.networkReady, attachment: window.networkReady ? 'AttachedStrong' : 'Attaching',
          live_peers: '7', reliable_peers: '4', download_bps: '1200', upload_bps: '32' }, identity: identity.record_key,
        reconcile: identity, stop: 'Stopped.', logout: 'Logged out.',
        backup: '{"header":{"version":1},"ciphertext":[1]}',
        verify_backup: identity.record_key,
        profile: window.pendingPost ? { ...identity, probe_post: window.pendingPost } : identity, update_profile: identity,
        publish: { index: 1, timestamp: 2, content: value },
        read_only: { starts: 1, reader: true, protected: false, identity: null },
        check_key: value,
        read: { record_key: 'VLD0:remote', metadata: { author_name: 'Remote <b>author</b>', bio: '' },
          posts: [{ index: 0, timestamp: 1, content: 'A guest-readable <b>post</b>' }] },
      };
      if (action === 'read_page') {
        results.read_page = { ...results.read, metadata: { ...results.read.metadata, latest_post_index: 0 }, next: null };
        if (value.key === identity.record_key) {
          results.read_page = { record_key: identity.record_key,
            metadata: { author_name: identity.author_name, bio: identity.bio, latest_post_index: 0 },
            posts: identity.history, next: null };
        }
        if (value.key === 'VLD0:paged') {
          const before = value.cursor?.before ?? 106, bottom = Math.max(6, before - 20);
          results.read_page = { record_key: value.key,
            metadata: { author_name: 'Paged <b>author</b>', bio: '', latest_post_index: 105 },
            posts: Array.from({ length: before - bottom }, (_, offset) => ({ index: before - offset - 1,
              timestamp: 1, content: `Older <b>post</b> ${before - offset - 1}` })),
            next: bottom > 6 ? { anchor: 105, before: bottom } : null };
        }
      }
      if (action === 'read' && value === 'VLD0:offline-follow') {
        results.read = { record_key: value,
          metadata: { author_name: 'Offline-followed author', bio: '', latest_post_index: 0 },
          posts: [{ index: 0, timestamp: 2, content: 'Post loaded after connecting' }] };
      }
      const error = action === 'unlock' && window.failUnlock ? 'This identity is active in another tab. Choose Logout there, then retry here.'
        : action === 'restore' && value.backup_passphrase !== 'disposable backup passphrase'
        ? 'Wrong passphrase or damaged credential envelope'
        : action === 'draft' && window.failDraft ? 'Storage unavailable'
        : action === 'publish' && !window.publishSuccess ? 'Network temporarily unavailable'
        : (action === 'read' && value === 'VLD0:existing') || (action === 'read_page' && value.key === 'VLD0:existing') ? 'This feed is unavailable'
        : action === 'read_page' && value.cursor && window.failOlder
          ? window.failOlder === 'expired' ? 'Retained feed window changed; refresh the feed.' : 'Older page unavailable; retry' : undefined;
      if (action === 'read' && value !== 'VLD0:existing') results.read.metadata.latest_post_index = 0;
      const respond = () => { if (!this.terminated) this.onmessage({ data: { id, result: results[action], error } }); };
      if (action === 'has_remembered' && existing) window.resolveRemember = respond;
      else if (action === 'publish' && window.deferPublish) window.resolvePublish = respond;
      else if (action === 'read' && window.deferFollowRead) window.resolveFollowRead = respond;
      else if (action === 'read_page' && value.cursor && window.deferOlder) window.resolveOlder = respond;
      else queueMicrotask(respond);
    }
    terminate() { this.terminated = true; }
  };
  URL.createObjectURL = blob => { window.downloadedBlob = blob; return 'blob:disposable-test'; };
  URL.revokeObjectURL = () => {};
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) window.downloadName = this.download;
    else click.call(this);
  };
}
const frame = document.createElement('iframe');
frame.title = 'Application behavior checks';
try {
  const source = (await (await fetch('./index.html')).text())
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]+>/, '');
  const script = '<script type="module" src="./app.mjs"></script>';
  assert(source.includes(script), 'App module was not found.');
  frame.srcdoc = source.replace(script, `<script>(${installWorker.toString()})();</script>${script}`);
  document.body.append(frame);
  const element = id => frame.contentDocument.getElementById(id);
  await wait(() => element('start') && !element('start').disabled);
  const checkRememberChoice = (form, submit) => {
    const choice = element('remember-device');
    assert(choice.form === element(form) && choice.checkVisibility()
      && choice.getBoundingClientRect().top < element(submit).getBoundingClientRect().top,
    'Staying logged in is not offered before submitting the active identity form.');
  };
  checkRememberChoice('create-form', 'start');
  assert(element('remember-device').checked, 'Staying logged in is not selected by default.');
  frame.contentWindow.failUnlock = true;
  element('show-unlock').click();
  checkRememberChoice('unlock-form', 'unlock-start');
  element('remember-device').checked = false;
  element('unlock-passphrase').value = 'disposable passphrase';
  element('unlock-form').requestSubmit();
  await wait(() => element('status').textContent.startsWith('Unlock failed'));
  assert(element('auth-error')?.textContent.includes('another tab'), 'Unlock failure is not beside the form.');
  assert(!element('unlock-start').disabled, 'Unlock cannot be retried after a tab conflict.');
  assert(frame.contentWindow.rememberChoice === false, 'Authentication ignored the explicit remember-device opt-out.');
  frame.contentWindow.failUnlock = false;
  frame.contentWindow.authorStarts = 0;
  element('show-create').click();
  element('author-name').value = 'Disposable author';
  element('passphrase').value = element('confirm-passphrase').value = 'disposable passphrase';
  element('acknowledge').checked = true;
  assert(!element('remember-device').checked, 'Switching forms discarded the explicit remember-device opt-out.');
  element('remember-device').checked = true;
  element('create-form').requestSubmit();
  await wait(() => !element('session').hidden);
  assert(frame.contentWindow.rememberChoice === true, 'Remember choice did not reach authentication.');
  assert(element('stop').textContent === 'Logout', 'Session action is still labelled Lock identity.');
  assert(element('view-home').contains(element('content')), 'Composer is not above the Home feed.');
  assert(element('view-settings').contains(element('session-diagnostics')), 'Settings omit node diagnostics.');
  assert(!element('app-header').hidden, 'Active sessions have no compact app navigation.');
  for (const width of [1280, 760, 390, 320]) {
    frame.width = width;
    frame.height = 900;
    const rect = id => element(id).getBoundingClientRect();
    const field = rect('content'), avatar = rect('composer-avatar');
    const counter = rect('content-count'), button = rect('publish');
    assert(Math.abs(field.top - avatar.top) < 1, `Composer input and avatar are misaligned at ${width}px.`);
    assert(Math.abs(field.right - button.right) < 1 && button.left - counter.right <= 20,
      `Character counter is not beside Post at ${width}px.`);
    assert(Math.abs(counter.top + counter.height / 2 - button.top - button.height / 2) < 1,
      `Character counter and Post are not vertically aligned at ${width}px.`);
    assert(button.top >= field.bottom && button.top - field.bottom <= 8,
      `Post is too far below the writing box at ${width}px.`);
    assert(rect('draft-status').top - field.bottom <= (width > 600 ? 36 : 80),
      `Draft feedback is too far below the writing box at ${width}px.`);
    assert(field.height <= 72 && rect('author-tools').height <= (width > 600 ? 170 : 235),
      `The empty composer takes too much vertical space at ${width}px.`);
    const label = frame.contentDocument.createRange();
    label.selectNodeContents(element('mark-read'));
    const text = label.getBoundingClientRect(), action = rect('mark-read');
    assert(text.left - action.left >= 8 && action.right - text.right >= 8,
      `Mark as read has no horizontal breathing room at ${width}px.`);
  }
  assert(element('follow-list').textContent.includes('VLD0:existing'), 'Author session did not load saved follows.');
  frame.contentWindow.failDraft = true;
  element('content').value = 'An unsaved draft before connecting';
  element('content').dispatchEvent(new Event('input'));
  const unsavedClose = new Event('beforeunload', { cancelable: true });
  frame.contentWindow.dispatchEvent(unsavedClose);
  assert(unsavedClose.defaultPrevented, 'Reload can discard an unsaved draft without a warning.');
  element('stop').click();
  await wait(() => element('status').textContent.startsWith('Logout cancelled'));
  frame.contentWindow.failDraft = false;
  const draft = 'A draft typed while connecting';
  element('content').value = draft;
  element('content').dispatchEvent(new Event('input'));
  await wait(() => element('draft-status').textContent === 'Draft saved on this browser.');
  const savedClose = new Event('beforeunload', { cancelable: true });
  frame.contentWindow.dispatchEvent(savedClose);
  assert(!savedClose.defaultPrevented, 'Saved work still blocks reload.');
  await wait(() => element('draft-status')?.textContent === 'Draft saved on this browser.');
  element('nav-profile').click();
  assert(!element('view-profile').hidden && element('view-home').hidden, 'Profile navigation did not change views.');
  element('new-post').click();
  assert(!element('view-home').hidden && frame.contentDocument.activeElement === element('content'),
    'New post did not open and focus the inline composer.');
  assert(element('content').value === draft, 'New post cleared the existing draft.');
  element('nav-following').click();
  assert(!element('view-following').hidden && frame.contentDocument.activeElement === element('key'), 'Add feed did not focus the key input.');
  element('nav-settings').click();
  assert(!element('view-settings').hidden, 'Settings navigation did not change views.');
  element('nav-home').click();
  assert(element('content').value === draft, 'Navigation erased the composer.');
  assert(element('timeline').textContent.includes('Existing <b>literal</b> post'), 'Home omitted locally confirmed posts.');
  frame.contentWindow.networkReady = true;
  await wait(() => !element('publish').disabled);
  assert(element('debug-session').textContent === 'Author', 'Diagnostics misidentified the session.');
  assert(element('debug-attachment').textContent === 'AttachedStrong', 'SDK attachment was not displayed.');
  assert(element('debug-peers').textContent.includes('7'), 'Routing peer counts were not displayed.');
  assert(element('content').value === draft, 'Attachment erased the draft.');
  assert(element('read-own'), 'Profile has no route to its retained network posts.');
  const ownAuthor = element('timeline').querySelector('a');
  assert(ownAuthor?.textContent === 'Disposable author', 'Home author name is not a feed link.');
  assert(new URL(ownAuthor.href).searchParams.get('feed') === 'VLD0:disposable', 'Author link points at the wrong feed.');
  assert(!element('timeline').querySelector('button'), 'Home still has a separate read-feed button.');
  ownAuthor.click();
  await wait(() => element('feed-cards').textContent.includes('Existing <b>literal</b> post'));
  assert(frame.contentDocument.activeElement === element('feed-cards').querySelector('h3'),
    'Author navigation did not move keyboard focus to the opened feed.');
  assert(!element('view-feed').hidden && frame.contentWindow.authorStarts === 1,
    'Author navigation restarted the node or did not open the feed.');
  assert(element('content').value === draft, 'Reading retained posts erased the draft.');
  element('new-post').click();
  const latest = 'Text typed immediately before a failed publish';
  element('content').value = latest;
  element('content').dispatchEvent(new Event('input'));
  frame.contentWindow.deferPublish = true;
  element('publish').click();
  await wait(() => frame.contentWindow.resolvePublish);
  assert(element('publish').textContent === 'Posting...' && element('publish').getAttribute('aria-busy') === 'true',
    'Pending publication has no busy button state.');
  assert(element('publish-status')?.textContent.includes('confirmation') && element('publish-status').checkVisibility(),
    'Pending publication has no visible inline feedback.');
  assert(frame.contentDocument.documentElement.scrollWidth <= frame.contentDocument.documentElement.clientWidth,
    'Posting controls overflow the narrow composer.');
  frame.contentWindow.dispatchEvent(new frame.contentWindow.StorageEvent('storage',
    { key: 'murmur-follows-v1', storageArea: frame.contentWindow.localStorage }));
  assert(element('publish').textContent === 'Posting...', 'Preference updates erased publication progress.');
  frame.contentWindow.resolvePublish();
  await wait(() => frame.contentWindow.lastSavedDraft === latest);
  await wait(() => !element('content').disabled);
  assert(!element('content').readOnly, 'A pre-publication failure froze the draft.');
  assert(element('publish-status').textContent.includes('Network temporarily unavailable'),
    'Publication failure is not visible beside the composer.');
  assert(element('publish').getAttribute('aria-busy') === 'false', 'Failed publication left the button busy.');
  frame.contentWindow.networkReady = false;
  await wait(() => element('read').disabled);
  assert(element('content').value === latest, 'Going offline erased the draft.');
  frame.contentWindow.networkReady = true;
  await wait(() => !element('read').disabled);
  assert(frame.contentWindow.publishCalls === 1, 'Reconnection resent the post automatically.');
  frame.contentWindow.deferPublish = false;
  const pendingText = 'x'.repeat(280);
  frame.contentWindow.pendingPost = { index: 1, timestamp: 2, content: pendingText };
  element('content').value = pendingText;
  element('content').dispatchEvent(new Event('input'));
  element('publish').click();
  await wait(() => element('content').readOnly && !element('content').disabled);
  assert(element('content').value === pendingText && element('publish').textContent === 'Retry saved post',
    'An uncertain publication lost its immutable retry text or action.');
  assert(frame.contentDocument.documentElement.scrollWidth <= frame.contentDocument.documentElement.clientWidth,
    'Saved-post retry controls overflow the narrow composer.');
  frame.contentWindow.pendingPost = undefined;
  frame.contentWindow.publishSuccess = true;
  element('publish').click();
  await wait(() => element('content').value === '' && !element('content').disabled);
  assert(!element('content').readOnly, 'Confirmed retry did not release the composer.');
  const nextPost = 'Another post without waiting for draft storage';
  element('content').value = nextPost;
  element('content').dispatchEvent(new Event('input'));
  assert(element('publish-status').textContent === '', 'An old publication outcome follows the next draft.');
  element('publish').click();
  await wait(() => element('content').value === '' && !element('content').disabled);
  assert(element('publish-status').textContent === 'Post confirmed.', 'Successful publication has no inline confirmation.');
  assert(element('timeline').textContent.includes(nextPost), 'Confirmed publication is missing from Home.');
  assert(element('publish').textContent === 'Post' && element('publish').getAttribute('aria-busy') === 'false',
    'Successful publication did not release its busy state.');
  const publishedClose = new Event('beforeunload', { cancelable: true });
  frame.contentWindow.dispatchEvent(publishedClose);
  assert(!publishedClose.defaultPrevented, 'Confirmed publication still warns that its draft is unsaved.');
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
  assert(element('remember-device').checked, 'Logout did not restore the next sign-in default.');
  element('show-restore').click();
  checkRememberChoice('restore-form', 'restore-start');
  element('remember-device').checked = true;
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
  assert(frame.contentWindow.rememberChoice === true, 'Restore lost the stay-logged-in choice.');
  element('stop').click();
  await wait(() => !element('auth').hidden);
  assert(element('browse-start'), 'Missing identity-free reading.');
  const authorStarts = frame.contentWindow.authorStarts;
  element('browse-start').click();
  await wait(() => !element('session').hidden);
  assert(element('identity-panel').hidden && element('author-tools').hidden, 'Guest was shown publishing tools.');
  assert(element('nav-profile').hidden && element('backup-settings').hidden, 'Guest navigation exposed author-only views.');
  assert(element('debug-session').textContent === 'Read-only reader', 'Guest diagnostics claim author access.');
  await wait(() => !element('read').disabled);
  element('key').value = 'VLD0:remote';
  element('read').click();
  await wait(() => element('feed-cards').textContent.includes('guest-readable'));
  assert(!element('feed-cards').querySelector('b'), 'Guest content was interpreted as markup.');
  assert(element('load-older'), 'Missing older-post navigation.');
  element('key').value = 'VLD0:paged';
  element('read').click();
  await wait(() => element('feed-cards').querySelectorAll('article').length === 20);
  frame.contentWindow.failOlder = true;
  element('load-older').click();
  await wait(() => element('paging-status').textContent.includes('retry'));
  assert(element('feed-cards').querySelectorAll('article').length === 20, 'Failed page erased existing posts.');
  frame.contentWindow.failOlder = false;
  for (const count of [40, 60, 80, 100]) {
    element('load-older').click();
    await wait(() => element('feed-cards').querySelectorAll('article').length === count);
    await wait(() => !element('read').disabled);
  }
  assert(element('load-older').hidden && !element('feed-cards').querySelector('b'), 'Pagination exceeded the window or interpreted HTML.');
  const keptPage = element('feed').textContent;
  element('key').value = 'VLD0:existing';
  element('read').click();
  await wait(() => !element('read').disabled);
  assert(element('feed').textContent === keptPage && element('status').textContent.includes('Previous feed snapshot kept'),
    'Failed feed switch erased the current snapshot or hid its provenance.');
  element('refresh-selected').click();
  await wait(() => element('feed-cards').querySelectorAll('article').length === 20);
  frame.contentWindow.failOlder = 'expired';
  element('load-older').click();
  await wait(() => element('paging-status').textContent.includes('window changed'));
  assert(element('feed-cards').querySelectorAll('article').length === 20, 'Expired cursor erased the snapshot.');
  frame.contentWindow.failOlder = false;
  frame.contentWindow.deferOlder = true;
  element('load-older').click();
  await wait(() => frame.contentWindow.resolveOlder);
  element('nav-home').click();
  frame.contentWindow.resolveOlder();
  await wait(() => !element('read').disabled);
  assert(!element('view-home').hidden && element('feed-cards').querySelectorAll('article').length === 40,
    'Late page response changed navigation or lost the selected-feed cache.');
  frame.contentWindow.deferOlder = false;
  element('key').value = 'VLD0:remote';
  element('read').click();
  await wait(() => element('feed-cards').textContent.includes('guest-readable'));
  assert(frame.contentWindow.authorStarts === authorStarts, 'Guest started an author session.');
  assert(element('follow'), 'Missing saved follows.');
  frame.contentWindow.deferFollowRead = true;
  element('follow').click();
  await wait(() => frame.contentWindow.resolveFollowRead);
  assert(element('follow-list').textContent.includes('VLD0:remote'), 'Follow was not saved before loading posts.');
  assert(frame.contentWindow.feedReads.join(',') === 'VLD0:remote', 'Following refreshed unrelated feeds.');
  element('nav-home').click();
  frame.contentWindow.resolveFollowRead();
  await wait(() => element('timeline').textContent.includes('guest-readable') && !element('follow').disabled);
  frame.contentWindow.deferFollowRead = false;
  assert(!element('view-home').hidden, 'Automatic follow loading changed navigation.');
  element('follow').click();
  await wait(() => !element('follow').disabled);
  assert(element('follow-list').querySelectorAll('li').length === 2, 'Duplicate follow was saved.');
  element('key').value = 'VLD0:existing';
  element('follow').click();
  await wait(() => !element('follow').disabled && /saved.*could not.*load/i.test(element('follow-status').textContent));
  assert(element('follow-list').querySelectorAll('li').length === 2, 'Read failure removed a saved follow.');
  assert(element('timeline').textContent.includes('guest-readable'), 'Follow read failure erased other cached posts.');
  assert(element('refresh-timeline'), 'Missing merged timeline.');
  element('refresh-timeline').click();
  await wait(() => !element('refresh-timeline').disabled);
  assert(element('timeline').textContent.includes('guest-readable'), 'One failed feed hid successful posts.');
  assert(element('feed-status').textContent.includes('This feed is unavailable'), 'Per-feed failure was hidden.');
  assert(!element('timeline').querySelector('b'), 'Timeline interpreted text as HTML.');
  const remoteAuthor = element('timeline').querySelector('a');
  assert(remoteAuthor?.textContent === 'Remote <b>author</b>', 'Remote author name is not a literal feed link.');
  assert(new URL(remoteAuthor.href).searchParams.get('feed') === 'VLD0:remote', 'Remote author link is misbound.');
  element('key').value = 'VLD0:unrelated-input';
  remoteAuthor.click();
  await wait(() => !element('read').disabled);
  assert(element('key').value === 'VLD0:remote' && !element('view-feed').hidden, 'Author link used the editable key instead of its feed.');
  const followedAuthor = [...element('follow-list').querySelectorAll('a')].find(link => link.textContent === 'Remote <b>author</b>');
  assert(followedAuthor, 'Following still requires a separate read button.');
  frame.contentWindow.networkReady = false;
  await wait(() => element('read').disabled);
  element('key').value = 'Offline input';
  followedAuthor.click();
  assert(element('key').value === 'Offline input', 'Offline author link started a feed read.');
  const readsBeforeOfflineFollow = frame.contentWindow.feedReads.length;
  element('key').value = 'VLD0:offline-follow';
  element('follow').click();
  await wait(() => element('follow-list').textContent.includes('VLD0:offline-follow') && !element('follow').disabled);
  assert(frame.contentWindow.feedReads.length === readsBeforeOfflineFollow, 'Offline follow tried to read before attachment.');
  assert(/connect/i.test(element('follow-status').textContent), 'Offline follow did not explain deferred loading.');
  element('key').value = 'VLD0:removed-offline';
  element('follow').click();
  await wait(() => element('follow-list').textContent.includes('VLD0:removed-offline') && !element('follow').disabled);
  [...element('follow-list').querySelectorAll('li')].find(item => item.textContent.includes('VLD0:removed-offline'))
    .querySelector('button:last-child').click();
  await wait(() => !element('follow-list').textContent.includes('VLD0:removed-offline') && !element('follow').disabled);
  element('key').value = 'VLD0:remote';
  frame.contentWindow.networkReady = true;
  await wait(() => element('timeline').textContent.includes('Post loaded after connecting') && !element('read').disabled);
  assert(!frame.contentWindow.feedReads.includes('VLD0:removed-offline'), 'Unfollowed feed was still automatically read.');
  [...element('follow-list').querySelectorAll('li')].find(item => item.textContent.includes('VLD0:offline-follow'))
    .querySelector('button:last-child').click();
  await wait(() => !element('follow-list').textContent.includes('VLD0:offline-follow') && !element('follow').disabled);
  element('refresh-timeline').click();
  await wait(() => !element('refresh-timeline').disabled);
  assert(element('timeline').querySelectorAll('article').length === 1, 'Refresh duplicated cached posts.');
  assert(element('unread-count')?.textContent.includes('1 unread'), 'Unread posts were not counted.');
  element('mark-read').click();
  await wait(() => element('unread-count').textContent.includes('0 unread'));
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
  await wait(() => !element('read').disabled);
  await wait(() => element('feed-cards').textContent.includes('guest-readable'));
  remoteItem().querySelector('[data-action="mute"]').click();
  await wait(() => element('timeline').textContent.includes('guest-readable'));
  let releaseMute, muteLocked = false;
  const muteLock = navigator.locks.request('murmur-reading-list', async () => {
    muteLocked = true;
    await new Promise(resolve => { releaseMute = resolve; });
  });
  await wait(() => muteLocked);
  const { muteFeed } = await import('./feeds.mjs');
  const otherMute = navigator.locks.request('murmur-reading-list', () => muteFeed(localStorage, 'VLD0:remote', true));
  remoteItem().querySelector('[data-action="mute"]').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  releaseMute();
  await Promise.all([muteLock, otherMute]);
  await wait(() => !element('follow').disabled);
  assert(remoteItem().textContent.includes('Unmute'), 'Two queued Mute actions undid each other.');
  remoteItem().querySelector('[data-action="mute"]').click();
  await wait(() => element('timeline').textContent.includes('guest-readable'));
  const acrossTabs = JSON.parse(frame.contentWindow.localStorage.getItem('murmur-follows-v1'));
  acrossTabs.follows.push('VLD0:other-tab');
  localStorage.setItem('murmur-follows-v1', JSON.stringify(acrossTabs));
  await wait(() => element('follow-list').textContent.includes('VLD0:other-tab'));
  let release, locked = false;
  const held = navigator.locks.request('murmur-reading-list', async () => {
    locked = true;
    await new Promise(resolve => { release = resolve; });
  });
  await wait(() => locked);
  element('key').value = 'VLD0:queued';
  element('follow').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  try {
    assert(!JSON.parse(localStorage.getItem('murmur-follows-v1')).follows.includes('VLD0:queued'),
      'Preference mutation ignored another tab lock.');
  } finally { release(); await held; }
  await wait(() => element('follow-list').textContent.includes('VLD0:queued'));
  Array.from(element('follow-list').querySelectorAll('li')).find(item => item.textContent.includes('VLD0:remote'))
    .querySelector('button:last-child').click();
  await wait(() => !element('follow-list').textContent.includes('VLD0:remote'));
  let releaseCancelled, cancellationLocked = false;
  const cancelledLock = navigator.locks.request('murmur-reading-list', async () => {
    cancellationLocked = true;
    await new Promise(resolve => { releaseCancelled = resolve; });
  });
  await wait(() => cancellationLocked);
  element('key').value = 'VLD0:cancelled';
  element('follow').click();
  await new Promise(resolve => setTimeout(resolve, 50));
  element('stop-reader').click();
  await wait(() => !element('auth').hidden);
  releaseCancelled();
  await cancelledLock;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert(!JSON.parse(localStorage.getItem('murmur-follows-v1')).follows.includes('VLD0:cancelled'),
    'A stopped session still changed reading preferences.');
  frame.contentWindow.localStorage.setItem('murmur-follows-v1', '{');
  element('browse-start').click();
  await wait(() => !element('session').hidden);
  assert(element('follow-list').children.length === 0, 'Unreadable follows left an old list visible.');
  assert(!element('reset-follows').hidden, 'Unreadable follows cannot be reset explicitly.');
  frame.srcdoc = source.replace(script, `<script>(${installWorker.toString()})(true);</script>${script}`);
  await wait(() => frame.contentWindow.resolveRemember);
  assert(element('unlock-start').disabled && element('browse-start').disabled,
    'Manual startup can race automatic remembered-access discovery.');
  frame.contentWindow.resolveRemember();
  await wait(() => !element('unlock-start').disabled);
  checkRememberChoice('unlock-form', 'unlock-start');
  assert(element('remember-device').checked, 'Returning manual sign-in does not default to staying logged in.');
  element('remember-device').checked = false;
  element('unlock-passphrase').value = 'disposable passphrase';
  element('unlock-form').requestSubmit();
  await wait(() => !element('session').hidden);
  assert(frame.contentWindow.rememberChoice === false, 'Unlock ignored the stay-logged-in opt-out.');
  document.getElementById('result').textContent = 'passed';
} catch (failure) {
  document.getElementById('result').textContent = `failed: ${failure.stack ?? failure.message}`;
} finally {
  frame.remove();
  await fetch('/__check_done');
}
