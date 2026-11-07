import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'murmur-site-test-'));
const output = join(fixture, 'website/output');
const read = name => readFileSync(join(output, name), 'utf8');

before(() => {
  mkdirSync(join(fixture, 'website'));
  for (const name of ['build.mjs', 'config.yml', 'content', 'templates']) {
    cpSync(join(repository, 'website', name), join(fixture, 'website', name), { recursive: true });
  }
  for (const name of ['README.md', 'LICENSE', 'docs']) {
    cpSync(join(repository, name), join(fixture, name), { recursive: true });
  }
  mkdirSync(join(fixture, 'browser/pkg'), { recursive: true });
  for (const name of ['index.html', 'worker.mjs']) {
    cpSync(join(repository, 'browser', name), join(fixture, 'browser', name));
  }
  writeFileSync(join(fixture, 'browser/pkg/murmur_browser.js'), 'export default async () => {};');
  writeFileSync(join(fixture, 'browser/pkg/murmur_browser_bg.wasm'), Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
  const source = join(fixture, 'docs/user-guide.md');
  writeFileSync(source, `${readFileSync(source, 'utf8')}\n## Source continuity\n\nA newly authored guide paragraph.\n`);
  writeFileSync(join(fixture, 'plan.md'), 'Private working direction, not site content.');
  writeFileSync(join(fixture, 'murmur_config.json'), '{"writer":"disposable-test-secret"}');
  execFileSync(process.execPath, [join(fixture, 'website/build.mjs')], { stdio: 'pipe' });
});

after(() => rmSync(fixture, { recursive: true, force: true }));

test('publishes current authored guides without exporting private working files', () => {
  assert.match(read('docs/user-guide.html'), /A newly authored guide paragraph\./);
  assert.match(read('docs/dev-guide.html'), /DHT schema/);
  assert.match(read('docs/browser-probe.html'), /developer-only experiment/);
  assert.match(read('docs/quick-start.html'), /cargo build --release/);
  assert(!existsSync(join(output, 'plan.md')));
  assert(!existsSync(join(output, 'murmur_config.json')));
});

test('every local link and asset resolves when mounted under a base path', () => {
  const base = new URL('https://preview.invalid/murmur/');
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (entry.name.endsWith('.html')) {
        const relative = file.slice(output.length + 1).replaceAll('\\', '/');
        const page = new URL(relative, base);
        for (const [, reference] of readFileSync(file, 'utf8').matchAll(/(?:href|src)="([^"]+)"/g)) {
          const target = new URL(reference, page);
          if (target.origin !== base.origin) continue;
          assert(target.pathname.startsWith(base.pathname), `${relative}: ${reference} escapes the base path`);
          let local = join(output, decodeURIComponent(target.pathname.slice(base.pathname.length)));
          if (target.pathname.endsWith('/')) local = join(local, 'index.html');
          assert(existsSync(local), `${relative}: ${reference} is missing`);
          if (target.hash) {
            const id = decodeURIComponent(target.hash.slice(1));
            assert(readFileSync(local, 'utf8').includes(`id="${id}"`), `${relative}: missing anchor ${reference}`);
          }
        }
      }
    }
  };
  visit(output);
  assert.match(read('app/index.html'), /docs\/browser-probe\.html/);
  assert.match(read('docs/user-guide.html'), /href="quick-start\.html"/);
});

test('native platforms are explicitly planned, without fake download links', () => {
  const rows = [...read('platforms.html').matchAll(/<tr>(.*?)<\/tr>/gs)].map(match => match[1]);
  for (const platform of ['Linux', 'Windows', 'macOS', 'Android', 'iOS']) {
    const row = rows.find(row => row.includes(platform));
    assert(row, `Missing platform: ${platform}`);
    assert.match(row, /Planned/);
    assert.doesNotMatch(row, /<a[\s>]/);
  }
});

test('license links use a readable text asset', () => {
  assert.match(read('LICENSE.txt'), /Permission is hereby granted/);
  assert.match(read('index.html'), /href="\.\/LICENSE\.txt"/);
  assert.match(read('docs/quick-start.html'), /href="\.\.\/LICENSE\.txt"/);
});

test('app builds include the existing probe, worker, and generated WASM with site navigation', () => {
  execFileSync(process.execPath, [join(fixture, 'website/build.mjs'), '--with-app'], { stdio: 'pipe' });
  assert.match(read('app/index.html'), /new Worker\('\.\/worker\.mjs'/);
  assert.match(read('app/index.html'), /href="\.\.\/docs\/index\.html"/);
  assert.equal(read('app/worker.mjs'), readFileSync(join(repository, 'browser/worker.mjs'), 'utf8'));
  assert.deepEqual(readFileSync(join(output, 'app/pkg/murmur_browser_bg.wasm')),
    Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]));
});

test('missing WASM bindings fail explicitly without replacing the working app', () => {
  const previous = read('app/index.html');
  rmSync(join(fixture, 'browser/pkg/murmur_browser_bg.wasm'));
  assert.throws(() => execFileSync(process.execPath, [join(fixture, 'website/build.mjs'), '--with-app'], { stdio: 'pipe' }),
    failure => {
      assert.match(failure.stderr.toString(), /WASM bindings.*browser\/pkg/);
      return true;
    });
  assert.equal(read('app/index.html'), previous);
});

test('a failed link check leaves the last successful preview intact', () => {
  const previous = read('docs/user-guide.html');
  const source = join(fixture, 'docs/user-guide.md');
  writeFileSync(source, `${readFileSync(source, 'utf8')}\n[Missing guide](missing.md)\n`);
  assert.throws(() => execFileSync(process.execPath, [join(fixture, 'website/build.mjs')], { stdio: 'pipe' }),
    failure => {
      assert.match(failure.stderr.toString(), /Broken internal link/);
      return true;
    });
  assert.equal(read('docs/user-guide.html'), previous);
});
