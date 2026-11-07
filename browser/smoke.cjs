const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'murmur-browser-check-'));
  const log = message => {
    fs.appendFileSync(path.join(artifacts, 'run.log'), `${message}\n`);
    console.log(message);
  };
  const server = http.createServer((request, response) => {
    const name = new URL(request.url, 'http://localhost').pathname;
    const file = path.resolve(__dirname, `.${name === '/' ? '/index.html' : name}`);
    if (!file.startsWith(`${__dirname}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    const type = file.endsWith('.wasm') ? 'application/wasm' :
      file.endsWith('.html') ? 'text/html' : 'text/javascript';
    response.writeHead(200, { 'Content-Type': type });
    fs.createReadStream(file).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser, page;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();
    page.on('pageerror', error => log(`pageerror: ${error.message}`));
    page.on('console', message => {
      if (message.type() === 'error') log(`console: ${message.text()}`);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    await page.locator('#start').click();
    const waitForStorage = async expected => {
      await page.waitForFunction(() => {
        const status = document.getElementById('status').textContent;
        return document.getElementById('storage').textContent !== '' ||
          !/Starting|Attaching|Worker\/storage ready/.test(status);
      }, undefined, { timeout: 60000 });
      assert.equal(await page.locator('#storage').textContent(), String(expected),
        await page.locator('#status').textContent());
    };
    await waitForStorage(1);
    if (process.argv.includes('--storage-only')) {
      await page.locator('#stop').click();
      await page.getByText('Stopped.', { exact: true }).waitFor();
      await page.reload();
      await page.locator('#start').click();
      await waitForStorage(2);
      log('PASS: Rust WASM node starts in a dedicated worker and IndexedDB survives reload. Network participation not checked.');
    } else {
      await page.locator('#own-key').filter({ hasText: /^VLD0:/ }).waitFor({ timeout: 150000 });
      const key = await page.locator('#own-key').textContent();
      await page.locator('#read').click();
      await page.locator('#feed').filter({ hasText: key }).waitFor({ timeout: 90000 });
      assert.deepEqual(JSON.parse(await page.locator('#feed').textContent()).posts, []);
      const other = await context.newPage();
      await other.goto(origin);
      await other.locator('#start').click();
      await other.locator('#status').filter({ hasText: 'Another tab' }).waitFor();
      await other.close();
      const content = 'Murmur disposable browser test <b>literal text</b>';
      await page.locator('#content').fill(content);
      await page.locator('#publish').click();
      await page.locator('#feed').filter({ hasText: content }).waitFor({ timeout: 200000 });
      assert.equal(await page.locator('#feed b').count(), 0);
      await page.locator('#key').fill('invalid-key');
      await page.locator('#read').click();
      await page.locator('#status').filter({ hasText: 'Invalid Veilid RecordKey' }).waitFor();
      assert.equal(await page.locator('#feed').textContent(), '');
      await page.locator('#stop').click();
      await page.getByText('Stopped.', { exact: true }).waitFor();
      await page.reload();
      await page.locator('#start').click();
      await page.locator('#own-key').filter({ hasText: key }).waitFor({ timeout: 150000 });
      await page.locator('#key').fill(key);
      await page.locator('#read').click();
      await page.locator('#feed').filter({ hasText: content }).waitFor({ timeout: 90000 });
      assert.equal(await page.locator('#own-key').textContent(), key);
      if (!process.env.MURMUR_BRIDGE_URL) throw new Error('Set MURMUR_BRIDGE_URL to verify native/browser cross-reads.');
      const bridge = process.env.MURMUR_BRIDGE_URL.replace(/\/$/, '');
      const me = await (await fetch(`${bridge}/api/me`)).json();
      await page.locator('#key').fill(me.record_key);
      await page.locator('#read').click();
      await page.locator('#feed').filter({ hasText: me.record_key }).waitFor({ timeout: 90000 });
      const deadline = Date.now() + 90000;
      let confirmed = false;
      while (Date.now() < deadline) {
        const response = await fetch(`${bridge}/api/feed/${encodeURIComponent(key)}`,
          { signal: AbortSignal.timeout(65000) });
        const feed = await response.json();
        if (response.status === 200 && feed.posts?.[0]?.content === content) {
          confirmed = true;
          break;
        }
        if (![200, 404, 502, 503, 504].includes(response.status)) {
          throw new Error(`Native cross-read failed: HTTP ${response.status}`);
        }
        log(`Waiting for DHT propagation: HTTP ${response.status}`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      assert(confirmed, 'Native node did not confirm the browser post before the deadline.');
      log('PASS: browser/native cross-reads, one confirmed browser post, and stable identity/feed after reload.');
    }
    await page.screenshot({ path: path.join(artifacts, 'result.png') });
  } catch (error) {
    log(`FAIL: ${error.stack}`);
    if (page && !page.isClosed()) {
      try {
        log(`UI status: ${await page.locator('#status').textContent()}`);
        await page.screenshot({ path: path.join(artifacts, 'failure.png') });
      } catch (capture) { log(`Failure capture failed: ${capture.message}`); }
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
    console.log(`Artifacts: ${artifacts}`);
  }
})().catch(() => { process.exitCode = 1; });
