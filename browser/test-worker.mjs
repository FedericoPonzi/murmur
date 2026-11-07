import { storage_snapshot } from './storage-snapshot.mjs';

export function controller() {
  const worker = new Worker('./worker.mjs', { type: 'module' });
  let sequence = 0;
  const pending = new Map();
  worker.onmessage = ({ data }) => {
    const call = pending.get(data.id);
    if (!call) return;
    clearTimeout(call.timer);
    pending.delete(data.id);
    data.error ? call.reject(new Error(data.error)) : call.resolve(data.result);
  };
  worker.onerror = event => {
    for (const call of pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error(event.message));
    }
    pending.clear();
  };
  return {
    async call(action, value) {
      if (action === 'test_storage') value = await storage_snapshot('murmur-browser-identity');
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Worker check timed out.')); }, 20000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, action, value, bootstrap: 'ws://127.0.0.1:9/ws' });
      });
    },
    terminate() {
      worker.terminate();
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(new Error('Worker terminated.'));
      }
      pending.clear();
    },
  };
}
