import { rememberSession, loadSession, hasSession, forgetSession } from './device-session.mjs';

export function checkEnvironment(scope, bootstrap) {
  if (scope.location.protocol !== 'http:') throw new Error('This local probe requires HTTP hosting; HTTPS/WSS is deferred.');
  if (!scope.indexedDB) throw new Error('IndexedDB is unavailable.');
  if (typeof scope.navigator?.locks?.request !== 'function') {
    throw new Error('Web Locks are unavailable. Use localhost (Android: USB port forwarding), not an insecure LAN origin.');
  }
  let url;
  try { url = new URL(bootstrap); }
  catch { throw new Error('Invalid WebSocket bootstrap URL.'); }
  if (url.protocol !== 'ws:' || url.username || url.password || url.hash) {
    throw new Error('Use a plain ws:// bootstrap URL without credentials or a fragment.');
  }
  return url.href;
}

if (typeof self !== 'undefined') {
  let node, release, running, readOnly = false;
  let queue = Promise.resolve();
  const send = (id, result, failure) => self.postMessage({ id, result, error: failure });
  self.onmessage = ({ data }) => {
    let passphrase, backupPassphrase;
    const authenticating = ['create', 'unlock', 'restore', 'resume'].includes(data.action);
    if (authenticating) {
      passphrase = data.value?.passphrase;
      if (data.value && typeof data.value === 'object') data.value.passphrase = undefined;
      if (data.action === 'restore') {
        backupPassphrase = data.value?.backup_passphrase;
        if (data.value && typeof data.value === 'object') data.value.backup_passphrase = undefined;
      }
    } else if (data.action === 'verify_backup') {
      passphrase = data.value?.passphrase;
      if (data.value && typeof data.value === 'object') data.value.passphrase = undefined;
    } else if (data.action === 'start_protected' || data.action === 'backup') {
      passphrase = data.value;
      data.value = undefined;
    }
    queue = queue.then(async () => {
      try {
        const hasStorage = async () => {
          if (typeof indexedDB.databases !== 'function') throw new Error('This browser cannot inspect local identity storage.');
          return (await indexedDB.databases()).some(database => database.name.includes('murmur-browser-identity'));
        };
        if (data.action === 'has_remembered') {
          send(data.id, await hasSession());
        } else if (data.action === 'forget_session') {
          await forgetSession();
          send(data.id, 'Remembered access removed.');
        } else if (data.action === 'check_key' && !node) {
          if (typeof data.value !== 'string') throw new Error('Feed key must be text.');
          const wasm = await import('./pkg/murmur_browser.js');
          await wasm.default();
          send(data.id, wasm.check_feed_key(data.value));
        } else if (data.action === 'has_storage') {
          checkEnvironment(self, data.bootstrap);
          send(data.id, await hasStorage());
        } else if (['start', 'start_protected', 'read_only'].includes(data.action) || authenticating) {
          if (running) throw new Error('The probe is already running.');
          const readerStart = data.action === 'read_only';
          const protectedStart = data.action !== 'start' && !readerStart;
          if (protectedStart && data.action !== 'resume' && typeof passphrase !== 'string') throw new Error('Passphrase must be a string.');
          const bootstrap = checkEnvironment(self, data.bootstrap);
          if (['unlock', 'resume'].includes(data.action) && !await hasStorage()) throw new Error('No local identity. Create one first.');
          if (data.action === 'create' && (typeof data.value?.author_name !== 'string' || typeof data.value?.bio !== 'string')) {
            throw new Error('Profile name and bio must be text.');
          }
          if (data.action === 'restore' && (typeof data.value?.backup !== 'string' || typeof backupPassphrase !== 'string')) {
            throw new Error('Provide an encrypted backup and its passphrase.');
          }
          const started = new Promise((resolve, reject) => {
            const namespace = readerStart ? 'murmur-browser-reader'
              : protectedStart ? 'murmur-browser-identity' : 'murmur-browser-probe';
            running = navigator.locks.request(namespace, { ifAvailable: true }, async lock => {
              if (!lock) throw new Error(readerStart
                ? 'A reader is active in another tab. Choose Stop reading there, or close that tab, then retry here.'
                : 'This identity is active in another tab. Choose Logout there, or close that tab, then retry here. Your identity is unchanged.');
              const stopped = new Promise(done => { release = done; });
              const wasm = await import('./pkg/murmur_browser.js');
              await wasm.default();
              try {
                try {
                  let remembered;
                  if (data.action === 'resume') {
                    remembered = await loadSession();
                    if (!remembered) throw new Error('No remembered access. Enter your passphrase to unlock.');
                    passphrase = remembered.passphrase;
                    remembered.passphrase = undefined;
                  }
                  if (readerStart) {
                    node = await wasm.start_reader_node(bootstrap);
                  } else if (data.action === 'create') {
                    node = await wasm.create_profile_node(bootstrap, passphrase, data.value.author_name, data.value.bio);
                  } else if (['unlock', 'resume'].includes(data.action)) {
                    node = await wasm.unlock_profile_node(bootstrap, passphrase);
                  } else if (data.action === 'restore') {
                    node = await wasm.restore_profile_node(bootstrap, data.value.backup, backupPassphrase, passphrase);
                  } else {
                    node = protectedStart ? await wasm.start_protected_node(bootstrap, passphrase) : await wasm.start_node(bootstrap);
                  }
                  if (authenticating) {
                    const identity = JSON.parse(node.local_identity());
                    if (remembered && remembered.recordKey !== identity?.record_key) {
                      throw new Error('Remembered access belongs to a different identity. Forget this device and unlock manually.');
                    }
                    if (data.action !== 'resume') {
                      if (data.value.remember) await rememberSession(passphrase, identity.record_key);
                      else await forgetSession();
                    }
                  }
                } finally { passphrase = backupPassphrase = undefined; }
                readOnly = readerStart;
                const state = JSON.parse(await node.status());
                if (authenticating || readerStart) state.identity = JSON.parse(node.local_identity());
                resolve(state);
                await stopped;
              } finally {
                const stopping = node;
                node = undefined;
                if (stopping) await stopping.shutdown();
              }
            }).catch(failure => {
              reject(failure);
              send(0, undefined, String(failure));
            }).finally(() => { running = undefined; release = undefined; });
          });
          send(data.id, await started);
        } else if (['stop', 'logout'].includes(data.action)) {
          if (data.action === 'logout') await forgetSession();
          release?.();
          await running;
          send(data.id, 'Stopped.');
        } else {
          if (!node) throw new Error('Start the node first.');
          if (readOnly && !['status', 'profile', 'read', 'read_page', 'reconnect', 'check_key'].includes(data.action)) {
            throw new Error('Guest readers cannot use author operations.');
          }
          if (['backup', 'verify_backup'].includes(data.action) && typeof passphrase !== 'string') throw new Error('Passphrase must be a string.');
          if (data.action === 'verify_backup' && typeof data.value?.backup !== 'string') throw new Error('Provide an encrypted backup.');
          const methods = { status: 'status', profile: 'local_identity', identity: 'identity_key', reconcile: 'reconcile_pending', publish: 'publish_post', read: 'read_feed', read_page: 'read_page', backup: 'export_backup', verify_backup: 'verify_backup', draft: 'save_draft', update_profile: 'update_profile', reconnect: 'reconnect', check_key: 'check_key',
            test_seed: 'test_seed_identity', test_storage: 'test_storage' };
          const method = methods[data.action];
          if (!Object.hasOwn(methods, data.action) || typeof node[method] !== 'function') throw new Error('Unknown probe command.');
          const result = data.action === 'verify_backup'
            ? node.verify_backup(data.value.backup, passphrase)
            : await node[method](data.action === 'backup' ? passphrase
              : ['update_profile', 'read_page'].includes(data.action) ? JSON.stringify(data.value) : data.value);
          send(data.id, ['status', 'profile', 'reconcile', 'publish', 'read', 'read_page', 'update_profile'].includes(data.action)
            ? JSON.parse(result) : result);
        }
      } catch (failure) { send(data.id, undefined, String(failure)); }
      finally { passphrase = backupPassphrase = undefined; }
    });
  };
}
