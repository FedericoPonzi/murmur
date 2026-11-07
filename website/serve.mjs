import { realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function createPreviewServer({
  root = fileURLToPath(new URL('./output/', import.meta.url)), bridge,
} = {}) {
  root = realpathSync(root);
  if (bridge) {
    bridge = new URL(bridge);
    if (!['http:', 'https:'].includes(bridge.protocol) || bridge.username || bridge.password ||
        bridge.pathname !== '/' || bridge.search || bridge.hash) {
      throw new Error('Configure a read-only bridge origin without credentials, path, query, or fragment.');
    }
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const error = (status, message) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: message }));
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.setHeader('Allow', 'GET, HEAD');
      error(405, 'The local preview is read-only.');
      return;
    }
    let url;
    try { url = new URL(request.url, 'http://localhost'); }
    catch {
      error(400, 'Invalid preview path.');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        error(405, 'Bridge reads require GET.');
        return;
      }
      if (!/^\/api\/(?:me|feed\/[^/]+)$/.test(url.pathname) || url.search) {
        error(404, 'Unknown bridge read endpoint.');
        return;
      }
      if (!bridge) {
        error(503, 'Read-only bridge is not configured.');
        return;
      }
      const signal = AbortSignal.timeout(150000);
      try {
        const upstream = await fetch(new URL(url.pathname, bridge), { redirect: 'error', signal });
        if (!upstream.headers.get('content-type')?.includes('application/json')) {
          throw new Error('Bridge response is not JSON.');
        }
        let size = 0;
        const chunks = [];
        for await (const chunk of upstream.body) {
          size += chunk.byteLength;
          if (size > 65536) throw new Error('Bridge response is too large.');
          chunks.push(chunk);
        }
        const body = Buffer.concat(chunks);
        JSON.parse(body.toString('utf8'));
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        response.end(body);
      } catch {
        console.warn('Read-only bridge request failed.');
        error(signal.aborted ? 504 : 502, 'Read-only bridge request failed; retry later.');
      }
      return;
    }
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch {
      error(400, 'Invalid preview path.');
      return;
    }
    const filename = resolve(root, `.${pathname.endsWith('/') ? `${pathname}index.html` : pathname}`);
    if (!filename.startsWith(`${root}${sep}`)) {
      error(404, 'Not found.');
      return;
    }
    try {
      const canonical = await realpath(filename);
      if (!canonical.startsWith(`${root}${sep}`)) {
        error(404, 'Not found.');
        return;
      }
      const body = await readFile(canonical);
      const type = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.mjs': 'text/javascript; charset=utf-8',
        '.wasm': 'application/wasm',
        '.txt': 'text/plain; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
      }[extname(filename)] || 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': type, 'Content-Length': body.byteLength });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (failure) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(failure.code)) {
        error(404, 'Not found.');
      } else {
        console.error('Preview file read failed:', failure);
        error(500, 'Preview file read failed.');
      }
    }
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT ?? 8000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535.');
  const server = createPreviewServer({ bridge: process.env.MURMUR_BRIDGE_URL });
  server.on('error', failure => { console.error(failure); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Local preview: http://localhost:${port}/app/`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
