# Browser preview

This is an experimental local browser alpha, not a public production release.
Use disposable identities and harmless public text. The native CLI is unchanged.
The read-only bridge additionally offers pagination; its existing endpoints and
publishing behavior remain compatible.

## Build and open

From the repository root, using current Rust stable:

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
CARGO_BUILD_JOBS=1 cargo build -p murmur-browser --target wasm32-unknown-unknown --release --locked
wasm-bindgen --target web --out-dir browser/pkg target/wasm32-unknown-unknown/release/murmur_browser.wasm
python3 -m http.server 8000 --bind 127.0.0.1 --directory browser
```

Open `http://localhost:8000`. Create a profile with a passphrase, then wait for
**Connected to Veilid** before publishing or reading. Publish one test post; read
another RecordKey, or share your public RecordKey with the native bridge.
After confirmation, the composer clears so you can publish another post.
While waiting, **Posting...** and inline feedback show that confirmation is in
progress. Failures keep the text and show the error beside the composer.
Drafts are saved in encrypted browser storage. Wait for **Draft saved on this
browser** before reloading. Unpublished drafts are not included in portable
backups; interrupted publications are. **Your saved posts** shows up to 1000
locally confirmed posts, including those recovered from a backup.
Use **Edit public profile** to change your name or bio without changing your
RecordKey. **Copy RecordKey** lets another reader find the same feed.
Log out or reload the page, then unlock with the same passphrase to restore the
same key and posts. An uncertain publication keeps its original text for retry;
confirmation releases the composer without advancing the index twice.
To read without creating or unlocking an author, choose **Read without an
identity** and paste a complete RecordKey. This uses a separate read-only node;
it cannot initialize a feed or publish. **Stop reading** ends that session.
Click an author's name on a post to open their feed without restarting your
session or clearing your draft. Names are links, so opening one in a new tab
uses the guest shared-feed path. In **Following**, click the author's name
(or their RecordKey if no profile is cached). **Open feed** accepts a pasted key.
Use **Follow this feed** to save a complete RecordKey; **Unfollow** removes it.
Up to 50 follows survive reload on this
origin. The list is not passphrase-protected or included in identity backups.
**Refresh followed feeds** merges their newest posts. Each feed reports its own
read failure and last successful cached read; an unavailable feed does not erase
other results. **Stop refresh** stops after the current bounded read completes.
Cached public snapshots retain at most 20 posts per followed feed. They remain
visible offline but may be stale. Ordering uses authors' reported times, so
different clocks can put posts out of real-world order.
**Copy feed link** shares the entered feed; **Copy your feed link** shares your
own. Opening a link starts only the read-only reader, even if an author is saved
on that browser. It never unlocks the author. A complete feed link lets its
recipient read that feed; share only what you intend to make public.
Unread badges count cached posts, not all posts on the network. **Mark cached
posts as read** saves your place; later logical post indices appear unread.
Read markers, follows, and public cache stay on this browser and are not
included in encrypted identity backups. Older remote snapshots do not replace
newer cached reads.
Use **Back up your reading list** to export followed keys and read markers as
unencrypted JSON. Keep this file private if your follows are sensitive.
**Merge reading list** validates the keys and adds them without removing current
follows or cached posts; the 50-feed limit still applies. This file contains no
author credentials, drafts or cached posts and cannot replace an identity backup.
**Mute** hides a followed feed from Home without deleting its cache or preventing
direct reads. **Unmute** shows it again. Muted posts are not marked read by the
Home read-marker button. Mutes are unencrypted local preferences and travel in
reading-list exports; importing keeps existing mutes too.
Reading-list changes are serialized across tabs on this origin. Other active
tabs update their follows, mute preferences and cached timeline when these
preferences change. This does not synchronize different devices or publishers.
**Node diagnostics** reports the session role, application readiness, last
reported SDK attachment, reliable/live routing peers, traffic and pending
requests. Peer counts are not a list of active socket connections. The timestamp
marks the last successful sample; diagnostics never imply a feed is reachable.
Use **Home** for recent followed posts and your latest 20 locally confirmed
posts. Self-following does not duplicate them. **My profile** shows your public
key, profile editing and saved history; guests do not get an author profile.
**Add feed / Following** manages reading, follows and mutes. Reading opens that
feed with its own Follow and Share actions. **Settings & backups** separates
encrypted identity backups from public reading-list files. Navigation does not
restart the node or clear the composer.
In an opened feed, **Load older posts** fetches another 20 posts, up to that
feed's retained 100-post window. **Read my retained feed** in your profile opens
the same network reader for your own posts. **Refresh from newest** starts a
fresh window; if an older page fails, already loaded posts remain visible.
If new publications overwrite a requested page, refresh rather than expecting
an archive. Only one selected feed's pages are kept in memory (at most 100);
switching feeds, locking, stopping or reloading discards them. These snapshots
can become stale. Home and its persistent followed-feed cache still use the
newest 20, and locally saved author history is separate from network retention.
The active app uses a compact header and navigation rail, with a composer above
the Home feed. **New post** returns to Home and focuses that same composer,
preserving an existing draft. Narrow screens use bottom navigation and a
floating **New post** button. Guest sessions have reading navigation but no
composer or author tools. **Settings** contains Logout, reconnect, backups,
node diagnostics and the last raw response. **Feed details** holds freshness
information and read errors. Homepage, documentation and sign-in screens keep
the product-site layout.
The app monitors attachment after connecting. Going offline disables network
actions without discarding saved work. **Retry connection** restarts networking;
reconnecting checks an interrupted publication but never sends it automatically.
If it is not already confirmed, retry only the preserved text.

## Combined site and app preview

The GitHub Actions **CI** workflow produces a **murmur-local-preview** artifact
after its WASM checks pass. Download it from a successful run, extract the inner
ZIP, open a terminal in `murmur-local-preview`, and run `python3 serve.py`
(Python 3.10+). Open `http://localhost:8000/app/`; no Rust build is needed.
This is the same experimental local preview, not public hosting or a signed
release. `BUILD.json` identifies the source/toolchain and `SHA256SUMS` detects
changed files; included checksums do not prove authenticity.

After building the bindings above, install Genereto as described in the
[developer guide](dev-guide.md#website-preview), then:

```sh
python3 website/build.py --with-app
python3 website/serve.py
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
The page permits only same-origin scripts and blocks inline scripts. This does
not protect against a malicious application served from the same origin.

The assembled preview is exercised in headless Chromium on Linux, including
keyboard entry, narrow desktop viewports, publishing, backup recovery, guest
links, follows, cached timeline, and persisted read markers. Narrow viewports
are not physical phone tests. Android, iOS, Safari, and public HTTPS/WSS hosting
remain unverified release gates; do not treat them as supported deployments.
Each author's feed retains a 100-slot recent-post ring; pagination browses
that window, not a permanent archive. There is no 100-post network-wide cap.

## Phone testing without public hosting

The probe requires IndexedDB, module workers, and Web Locks for exclusive access
to its storage. Desktop localhost provides the necessary browser context.
`python3 website/serve.py` (or packaged `python3 serve.py`) listens on
`0.0.0.0:8000`. On the same Wi-Fi, open
`http://<your-computer-LAN-IP>:8000/app/` to check layout; allow inbound TCP 8000
on your trusted LAN if your firewall blocks it. Do not expose this development
server to the public Internet. Plain LAN HTTP lacks the secure context needed
for identity/node features and is rejected explicitly. Use USB localhost below
or a correctly configured HTTPS/WSS deployment for those features.

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

New browser identities use passphrase-protected device keys and encrypted table
values. The earlier unpassworded developer namespace is left untouched, not
imported into the new identity. By default, reloading starts locked.
**Stay logged in on this device** is selected by default when unlocking,
creating or restoring an identity. Uncheck it on shared or untrusted devices
to require your passphrase when returning.
Then **Open app**, `/app/` and `/app/index.html` on the same origin restore access
after reloads and browser restarts without asking for the passphrase. Use the
same browser profile, scheme, hostname and port: `localhost` and `127.0.0.1` do
not share storage. It stores the unlocking passphrase and bound RecordKey wrapped
with AES-GCM under a non-extractable Web Crypto key in a separate IndexedDB
database, never as plaintext or in localStorage. This is browser-profile
convenience, not an OS login, hardware-backed vault, or protection against
same-origin scripts. Anyone with access to that browser profile may publish.
Keep your passphrase and verified backup even on a remembered device.

**Logout** stops the author node and removes remembered access without deleting
the identity, saved draft, posts, or follows. It does not revoke restored copies
on other devices. **Forget remembered access** on the unlock screen removes
only that device convenience; your passphrase still works. Damaged or unknown
remembered-access versions fail explicitly rather than overwriting them.
Unlocking still trusts the served application code.
Before using valuable data, open **Back up your identity**, download an encrypted
backup, and select the saved file under **Check the saved backup** to verify it.
Keep the backup passphrase separately. Forgetting the browser passphrase or
clearing its data without a usable backup loses ownership.
To recover, choose **Restore from encrypted backup**, select the file, enter
its passphrase, and choose a passphrase for the destination browser. Existing
identities are never replaced. Stop the old publisher before restoring;
copies are not synchronized and must not publish concurrently.
Restore needs network access and available feed metadata. A credential backup
does not guarantee permanent network retention. It includes pending work and
up to 1000 locally confirmed posts, not a complete remote archive.
Device/origin changes do not migrate the identity. One tab may unlock an identity;
the browser lock lasts until shutdown or worker termination.
If another tab owns it, the unlock form explains how to release it: choose
**Logout** in that tab, or close it, then retry. **Retry remembered session**
does not need the passphrase again. No tab silently takes over the publisher.

## Updating the local preview

Keep the same origin (scheme, hostname and port) and browser profile.
`python3 website/build.py --with-app` publishes new assets before replacing the
app entrypoint. Runtime modules, worker, WASM and app CSS use a content-addressed
release directory. Existing tabs keep their loaded session and old release;
updates never force reload or Logout. Returning to the new version restores a
remembered identity, or asks for the passphrase when remembering was not enabled.
Wait for **Draft saved on this browser** before refreshing; the app warns when
an unsaved draft would be discarded, subject to browser confirmation rules.

Retain `app/releases/` from earlier builds when updating the served directory.
Do not delete those files while old pages may still start or restart a worker.
The builder preserves them, rejects modified immutable releases, and packages
all retained releases. Roll back by rebuilding the earlier compatible source
and publishing its entrypoint while keeping both release directories.
Storage namespaces and the identity/backup formats are unchanged by this batch.
Future format changes require their own migration and rollback checks; this
is not permission to downgrade across arbitrary incompatible storage formats.
Pages opened before version-pinned assets were introduced should save work
and reload once to acquire this protection. Browser shutdown/suspension still
stops or pauses networking; a remembered identity is not a background publisher.

Run `python3 browser/upgrade-smoke.py` after assembling the app for an opt-in
real-node check of tab conflicts, live updates, reload, homepage Open app,
`/app/index.html`, browser restart, Logout and manual recovery with remembering.
It uses a disposable browser profile/site and preserves
logs/screenshots under `/tmp/murmur-upgrade-check-*`.

## Checks

```sh
python3 browser/check.py
cargo clippy -p murmur-browser --target wasm32-unknown-unknown --release --locked -- -D warnings
```

The worker checks need Chrome/Chromium; set `CHROME` if it is not on `PATH`.
`browser/smoke.py` is an opt-in Chromium check using Selenium Python, not a required
network CI gate. Install `selenium` in a temporary Python virtual environment.
Run `python3 browser/smoke.py --storage-only`
to check creation, locking, password rejection, and reload/unlock without asserting attachment.
For full cross-reads, run the native server with disposable storage, publish
a test post through its CLI, and set `MURMUR_BRIDGE_URL` to that server before
running `python3 browser/smoke.py`. Each run preserves its log/screenshot in a
separate temporary artifacts directory; test browser credentials are discarded.
Set `MURMUR_PREVIEW_URL=http://localhost:8000/app/` to exercise the combined
preview instead of the standalone page. The preview server must already run.
Selenium manages ChromeDriver, or use `CHROMEDRIVER` for an existing executable.
