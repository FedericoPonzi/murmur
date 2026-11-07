# Browser feasibility probe

This is a developer-only experiment, not the alpha application. Use disposable
test identities and harmless public text. The native CLI and read-only bridge
are unchanged.

## Build and open

From the repository root, using current Rust stable:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
CARGO_BUILD_JOBS=1 cargo build -p murmur-browser --target wasm32-unknown-unknown --release --locked
wasm-bindgen --target web --out-dir browser/pkg target/wasm32-unknown-unknown/release/murmur_browser.wasm
python3 -m http.server 8000 --bind 127.0.0.1 --directory browser
```

Open `http://localhost:8000`. Start the node and wait for **Attached**, not merely
the worker/storage message. Publish one test post; read another RecordKey, or
share the test RecordKey with the native bridge. Stop/reload/start and verify
the same key and post. Retries must use the original text: this probe deliberately
does not append posts or implement a second general-purpose publication engine.

## Combined site and app preview

After building the bindings above, install Genereto as described in the
[developer guide](dev-guide.md#website-preview), then:

```sh
node website/build.mjs --with-app
node website/serve.mjs
```

Open `http://localhost:8000/app/`. The landing page and hosted docs are on the
same origin. The standalone server above remains available; use one server per
port. Keeping the same origin preserves probe storage when moving from `/`
to `/app/`; changing the hostname or port does not.

The page uses HTTP; its embedded Veilid node connects directly over plain
WebSockets, initially to `ws://bootstrap-v1.veilid.net:5150/ws`. The preview
server does not sign or publish for the browser.
Network attachment or DHT failures are explicit and are not proof of success.
Closing the tab stops its worker; background operation is not promised.

## Phone testing without public hosting

The probe requires IndexedDB, module workers, and Web Locks for exclusive access
to its storage. Desktop localhost provides the necessary browser context.
Plain LAN HTTP often lacks Web Locks and is rejected explicitly.

On an Android phone connected by USB with debugging enabled:

```sh
adb reverse tcp:8000 tcp:8000
```

Open `http://localhost:8000` in phone Chrome (`/app/` for the combined preview).
This uses the laptop's HTTP server
without public hosting, certificates, or bypassing browser protections.
HTTPS/WSS connectivity is a separate, deferred deployment test.

## Storage and limits

The worker explicitly selects Veilid's IndexedDB protected-store backend and
disables automatic table deletion on a bad device key. The application table
holds the writer, RecordKey, and immutable test post before publication.
Only public status, keys, and feeds cross the worker boundary.

Veilid encrypts its table values, but this probe does **not** password-protect
the device key held in the protected store. IndexedDB is not a secure vault.
Do not import real credentials, deploy this as public onboarding, or use it
for valuable identities. Clearing this origin's browser data removes ownership.
Device/origin changes do not migrate the identity. One tab may run the probe;
the browser lock lasts until shutdown or worker termination.

## Checks

```sh
node --test browser/worker.test.mjs
cargo clippy -p murmur-browser --target wasm32-unknown-unknown --release --locked -- -D warnings
```

`browser/smoke.cjs` is an opt-in Chromium check using Playwright, not a required
network CI gate. Install Playwright in an external temporary directory and set
`NODE_PATH` to its `node_modules`. Run `node browser/smoke.cjs --storage-only`
to check worker startup and IndexedDB reload without asserting attachment.
For full cross-reads, run the native server with disposable storage, publish
a test post through its CLI, and set `MURMUR_BRIDGE_URL` to that server before
running `node browser/smoke.cjs`. Each run preserves its log/screenshot in a
separate temporary artifacts directory; test browser credentials are discarded.
Set `MURMUR_PREVIEW_URL=http://localhost:8000/app/` to exercise the combined
preview instead of the standalone page. The preview server must already run.
