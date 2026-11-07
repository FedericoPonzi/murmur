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
  let node, release, running;
  let queue = Promise.resolve();
  const send = (id, result, failure) => self.postMessage({ id, result, error: failure });
  self.onmessage = ({ data }) => {
    let passphrase, backupPassphrase;
    const authenticating = ['create', 'unlock', 'restore'].includes(data.action);
    if (authenticating) {
      passphrase = data.value?.passphrase;
      if (data.value && typeof data.value === 'object') data.value.passphrase = undefined;
      if (data.action === 'restore') {
        backupPassphrase = data.value?.backup_passphrase;
        if (data.value && typeof data.value === 'object') data.value.backup_passphrase = undefined;
      }
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
        if (data.action === 'has_storage') {
          checkEnvironment(self, data.bootstrap);
          send(data.id, await hasStorage());
        } else if (data.action === 'start' || data.action === 'start_protected' || authenticating) {
          if (running) throw new Error('The probe is already running.');
          const protectedStart = data.action !== 'start';
          if (protectedStart && typeof passphrase !== 'string') throw new Error('Passphrase must be a string.');
          const bootstrap = checkEnvironment(self, data.bootstrap);
          if (data.action === 'unlock' && !await hasStorage()) throw new Error('No local identity. Create one first.');
          if (data.action === 'create' && (typeof data.value?.author_name !== 'string' || typeof data.value?.bio !== 'string')) {
            throw new Error('Profile name and bio must be text.');
          }
          if (data.action === 'restore' && (typeof data.value?.backup !== 'string' || typeof backupPassphrase !== 'string')) {
            throw new Error('Provide an encrypted backup and its passphrase.');
          }
          const started = new Promise((resolve, reject) => {
            const namespace = protectedStart ? 'murmur-browser-identity' : 'murmur-browser-probe';
            running = navigator.locks.request(namespace, { ifAvailable: true }, async lock => {
              if (!lock) throw new Error('Another tab owns the probe. Stop it before starting this tab.');
              const stopped = new Promise(done => { release = done; });
              const wasm = await import('./pkg/murmur_browser.js');
              await wasm.default();
              try {
                try {
                  if (data.action === 'create') {
                    node = await wasm.create_profile_node(bootstrap, passphrase, data.value.author_name, data.value.bio);
                  } else if (data.action === 'unlock') {
                    node = await wasm.unlock_profile_node(bootstrap, passphrase);
                  } else if (data.action === 'restore') {
                    node = await wasm.restore_profile_node(bootstrap, data.value.backup, backupPassphrase, passphrase);
                  } else {
                    node = protectedStart ? await wasm.start_protected_node(bootstrap, passphrase) : await wasm.start_node(bootstrap);
                  }
                } finally { passphrase = backupPassphrase = undefined; }
                const state = JSON.parse(await node.status());
                if (authenticating) state.identity = JSON.parse(node.local_identity());
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
        } else if (data.action === 'stop') {
          release?.();
          await running;
          send(data.id, 'Stopped.');
        } else {
          if (!node) throw new Error('Start the node first.');
          if (data.action === 'backup' && typeof passphrase !== 'string') throw new Error('Passphrase must be a string.');
          const methods = { status: 'status', profile: 'local_identity', identity: 'identity_key', reconcile: 'reconcile_pending', publish: 'publish_post', read: 'read_feed', backup: 'export_backup',
            test_seed: 'test_seed_identity', test_storage: 'test_storage' };
          const method = methods[data.action];
          if (!Object.hasOwn(methods, data.action) || typeof node[method] !== 'function') throw new Error('Unknown probe command.');
          const result = await node[method](data.action === 'backup' ? passphrase : data.value);
          send(data.id, ['status', 'profile', 'reconcile', 'publish', 'read'].includes(data.action)
            ? JSON.parse(result) : result);
        }
      } catch (failure) { send(data.id, undefined, String(failure)); }
      finally { passphrase = backupPassphrase = undefined; }
    });
  };
}
