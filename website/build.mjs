import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const website = join(repository, 'website');
const generator = process.env.GENERETO || 'genereto';
const withApp = process.argv.includes('--with-app');
if (process.argv.slice(2).some(argument => argument !== '--with-app')) {
  throw new Error('Usage: node website/build.mjs [--with-app]');
}
const browser = join(repository, 'browser');
if (withApp && ['murmur_browser.js', 'murmur_browser_bg.wasm'].some(name => !existsSync(join(browser, 'pkg', name)))) {
  throw new Error('WASM bindings missing in browser/pkg; build murmur-browser and run wasm-bindgen first.');
}
if (execFileSync(generator, ['--version'], { encoding: 'utf8' }).trim() !== 'genereto 0.4.4') {
  throw new Error('Use Genereto 0.4.4 to build this site.');
}
const run = args => execFileSync(generator, args, {
  stdio: 'inherit', env: { ...process.env, RUST_LOG: 'warn' },
});
const destinations = new Map([
  ...[
    ['index', 'index.html'],
    ['participate', 'participate.html'],
    ['platforms', 'platforms.html'],
    ['limitations', 'limitations.html'],
    ['app', 'app/index.html'],
    ['documentation', 'docs/index.html'],
  ].map(([name, destination]) => [join(website, 'content', `${name}.md`), destination]),
  [join(repository, 'README.md'), 'docs/quick-start.html'],
  ...readdirSync(join(repository, 'docs')).filter(name => name.endsWith('.md'))
    .map(name => [join(repository, 'docs', name), `docs/${basename(name, '.md')}.html`]),
  [join(repository, 'LICENSE'), 'LICENSE.txt'],
]);
const work = mkdtempSync(join(tmpdir(), 'murmur-site-build-'));

try {
  mkdirSync(join(work, 'content'));
  cpSync(join(website, 'templates'), join(work, 'templates'), { recursive: true });
  cpSync(join(website, 'config.yml'), join(work, 'config.yml'));
  const pages = [...destinations].filter(([source]) => source.endsWith('.md'))
    .map(([source, destination]) => ({
      source, destination, filename: destination.replaceAll('/', '-').replace(/\.html$/, '.md'),
    }));
  for (const page of pages) {
    const markdown = readFileSync(page.source, 'utf8');
    const title = markdown.match(/^# (.+)$/m)?.[1];
    if (!title) throw new Error(`Missing page heading: ${page.source}`);
    const root = relative(dirname(page.destination), '.').replaceAll('\\', '/') || '.';
    writeFileSync(join(work, 'content', page.filename),
      `---\ntitle: ${JSON.stringify(title)}\nroot: ${JSON.stringify(root)}\n---\n${markdown}`);
  }
  run(['--project-path', work]);
  const assembled = join(work, 'assembled');
  mkdirSync(assembled);
  for (const page of pages) {
    const html = readFileSync(join(work, 'output', page.filename.replace(/\.md$/, '.html')), 'utf8')
      .replace(/href="([^"]+)"/g, (attribute, reference) => {
        const [, path, suffix] = reference.match(/^([^?#]*)(.*)$/);
        const linked = destinations.get(resolve(dirname(page.source), path));
        if (!linked) return attribute;
        const target = relative(dirname(page.destination), linked).replaceAll('\\', '/');
        return `href="${target}${suffix}"`;
      });
    const destination = join(assembled, page.destination);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, html);
  }
  cpSync(join(repository, 'LICENSE'), join(assembled, 'LICENSE.txt'));
  if (withApp) {
    const probe = readFileSync(join(browser, 'index.html'), 'utf8');
    if (!probe.includes('<!-- site_header -->')) throw new Error('Browser probe is missing its site header marker.');
    const header = readFileSync(join(website, 'templates/main/header.html'), 'utf8')
      .replaceAll("$GENERETO['root']", '..');
    writeFileSync(join(assembled, 'app/index.html'), probe.replace('<!-- site_header -->', header));
    cpSync(join(browser, 'worker.mjs'), join(assembled, 'app/worker.mjs'));
    cpSync(join(browser, 'pkg'), join(assembled, 'app/pkg'), { recursive: true });
  }
  renameSync(join(work, 'output'), join(work, 'flat'));
  renameSync(assembled, join(work, 'output'));
  run(['verify', '--project-path', work, 'assets', 'cover-image', 'date-mismatch',
    'empty-links', 'internal-links', 'unresolved-placeholders']);
  const output = join(website, 'output');
  rmSync(output, { recursive: true, force: true });
  cpSync(join(work, 'output'), output, { recursive: true });
  console.log(`Site ready: ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
