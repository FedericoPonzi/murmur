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
    let passphrase;
    if (data.action === 'start_protected') {
      passphrase = data.value;
      data.value = undefined;
    }
    queue = queue.then(async () => {
      try {
        if (data.action === 'start' || data.action === 'start_protected') {
          if (running) throw new Error('The probe is already running.');
          const protectedStart = data.action === 'start_protected';
          if (protectedStart && typeof passphrase !== 'string') throw new Error('Passphrase must be a string.');
          const bootstrap = checkEnvironment(self, data.bootstrap);
          const started = new Promise((resolve, reject) => {
            const namespace = protectedStart ? 'murmur-browser-identity' : 'murmur-browser-probe';
            running = navigator.locks.request(namespace, { ifAvailable: true }, async lock => {
              if (!lock) throw new Error('Another tab owns the probe. Stop it before starting this tab.');
              const stopped = new Promise(done => { release = done; });
              const wasm = await import('./pkg/murmur_browser.js');
              await wasm.default();
              try {
                try {
                  node = protectedStart
                    ? await wasm.start_protected_node(bootstrap, passphrase)
                    : await wasm.start_node(bootstrap);
                } finally { passphrase = undefined; }
                resolve(JSON.parse(await node.status()));
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
          const methods = { status: 'status', identity: 'identity_key', publish: 'publish_probe', read: 'read_feed',
            test_seed: 'test_seed_identity', test_storage: 'test_storage' };
          const method = methods[data.action];
          if (!Object.hasOwn(methods, data.action) || typeof node[method] !== 'function') throw new Error('Unknown probe command.');
          const result = await node[method](data.value);
          send(data.id, data.action === 'status' || data.action === 'publish' || data.action === 'read'
            ? JSON.parse(result) : result);
        }
      } catch (failure) { send(data.id, undefined, String(failure)); }
      finally { passphrase = undefined; }
    });
  };
}
