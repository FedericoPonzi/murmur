# Murmur development

## Architecture

One Rust/Tokio process runs `veilid-core` and Axum:

```text
Browser -> HTTP GET :8080 -> shared Node/RoutingContext -> Veilid DHT
SSH -> murmur post -> private Unix socket -> same Node -> Veilid DHT
```

`main.rs` handles CLI arguments, process/storage locking, local IPC, and lifecycle.
`veilid.rs` handles identity, attachment, DHT I/O, and recovery.
`web.rs` serves GET handlers and embeds `index.html` with `include_str!`.
The workspace's `murmur-model` crate owns public feed types, validation,
ring indexing, and owner-only schema counts. It depends only on Serde, not on
Veilid, Tokio, Axum, or native storage; transport-specific errors stay native.
The frontend uses plain JavaScript and renders untrusted text with `textContent`.
Small `RecordIo`/`FeedSource` seams allow behavior tests without Internet access;
there is no external Veilid daemon, database server, or JavaScript framework.
The separate [browser probe](browser-probe.md) tests a worker-hosted WASM node
without changing the native application or exposing its writer over HTTP.

## Build and checks

Use current Rust stable. Veilid 0.5.8 declares Rust >= 1.89, but the locked
transitive dependencies may require newer Rust; standard-library file locking
is also used. Application source is Rust 2021.
Debug symbols are disabled for the large `veilid-core` dependency to reduce
development/test compiler memory. On memory-constrained hosts, build with
`CARGO_BUILD_JOBS=1`; release compilation still needs substantial RAM.

```sh
cargo fmt --all --check
cargo test --workspace --locked
cargo clippy --workspace --locked --all-targets -- -D warnings
cargo build --release
```

Ubuntu needs a native C build toolchain (`build-essential`) and `pkg-config`.
SQLite and D-Bus are bundled by the selected dependencies; TLS uses Rustls,
so `libssl-dev` is not needed for this dependency set. Veilid ships generated
Cap'n Proto source. If changing its schemas or building an upstream checkout,
regeneration requires Cap'n Proto major version 1 (upstream prefers 1.1.0);
an older Ubuntu `capnproto` package is not a compatible substitute.

Dependency versions are resolved in `Cargo.lock`; `veilid-core` is pinned to
0.5.8 with only `rt-tokio` and `enable-crypto-vld0`. Older Veilid examples use
different startup and DHT method signatures.

## Identity and embedded node

`murmur [--data-dir PATH] serve` acquires an OS file lock before opening stores.
It calls `api_startup` with `VeilidConfig`, calls `attach`, then waits for
`VeilidUpdate::Attachment.public_internet_ready`. The 120-second wait is bounded;
attachment loss subsequently produces explicit network errors.

The first run creates an owner-only `DHTSchema::smpl(101, vec![])` record and
atomically persists its typed RecordKey and generated owner KeyPair before
initial metadata publication. Restart opens the record with the saved writer
and verifies the schema and ownership. Malformed identity is never regenerated
silently. Author name/bio changes are picked up on restart.

All stores are under the private data directory. Headless file-based protected
storage is explicitly selected, avoiding a desktop keyring dependency at runtime.
This does not provide a secure vault or protection from the server account/root.
The writer never crosses HTTP or appears in normal application logs.

SIGINT/SIGTERM stops accepting work, drains handlers, closes the owner record,
shuts down Veilid, and removes the owned socket. The persistent lock file can
remain; the OS releases its lock when the process exits.

## DHT schema

| Subkey | JSON fields |
| --- | --- |
| 0 | `author_name`, `bio`, `latest_post_index` |
| 1-100 | `index`, `timestamp`, `content` |

An empty feed has `latest_post_index: null`. Logical indexes start at zero;
physical subkey is `1 + (index % 100)`. Timestamps are Unix seconds.
Readers return indexes from latest down to `max(0, latest - 19)`, newest first.
Index arithmetic is checked. The accepted schema is exactly 101 owner-only
SMPL subkeys; unrelated Veilid records are not assumed to be feeds.

A shared async mutex serializes DHT operations and local publishers. The owner
record stays open, avoiding read-only reopens that would replace its default
writer. Keys with the same opaque owner identity but a different/missing
encryption key are rejected. Remote records open with no writer and close after
reading, including failures and open timeouts. Tracked workers finish cleanup
even when a browser disconnects; shutdown drains them before stopping Veilid.
Eight admitted HTTP feed requests bound the DHT queue.
Individual network operations have 30-second deadlines and the feed read
phase has a 60-second deadline.

Metadata and posts are force-refreshed. Missing, malformed, or mismatched
ring-slot values fail explicitly instead of showing the wrong post or an empty
feed. There is no claim of atomic snapshots across subkeys.

## Publication and recovery

Before writing, validate nonblank content and the 280-Unicode-scalar limit.
Persist the selected index/timestamp/content to private `pending-post.json`,
write its slot, then advance subkey 0. DHT writes explicitly disable offline
acceptance and use the owner writer. A returned conflicting `ValueData` is an
error unless it matches the attempted value.

Post and metadata writes are not atomic. On failure or crash, retain the pending
file. Recovery compares the same pending post with the slot and latest metadata,
completes the missing metadata update, or reports a conflict. It does not
silently create a new index or overwrite a differing newer post.
Remove the pending file only after confirmed metadata completion. File updates
use private temporary files, sync, rename, and parent-directory sync.

The design assumes one active author process; it is not a multi-writer
coordination protocol. DHT writes are eventually replicated, not durable global
transactions. Timeout/disconnection can leave an uncertain outcome; do not
automatically resend messages.

## HTTP and local IPC

| Endpoint | Response |
| --- | --- |
| `GET /` | Embedded HTML |
| `GET /api/me` | `{record_key, author_name, bio}` |
| `GET /api/feed/{dht_key}` | `{record_key, metadata, posts}` |

There are no HTTP mutation endpoints; `POST /api/post` returns 404.
Errors are JSON `{"error":"..."}`: 400 invalid input, 404 established missing
record, 502 incompatible/corrupt/upstream failure, 503 offline/busy, 504 timeout,
and 500 local failure. A failed network lookup is not proof of a nonexistent
record. Requests are same-origin; there is no CORS publishing surface.

`murmur [--data-dir PATH] post "message"` sends one bounded JSON line
`{"content":"..."}` to `<data-dir>/murmur.sock` (0600 under a 0700 directory).
Replies use Serde's Result format:
`{"Ok":{"record_key":"...","index":0}}` or
`{"Err":{"status":503,"error":"..."}}`.
IPC lines are limited to 8192 bytes, input/reply I/O to 10 seconds, and server
publication work to 180 seconds. The client waits up to 200 seconds for a reply.
At most eight IPC handlers are active. CLI errors exit nonzero.

The public HTTP address defaults to `0.0.0.0:8080`; Veilid UDP/TCP to port 5150.
For isolated development only, `MURMUR_HTTP_ADDR` and `MURMUR_P2P_PORT`
can override those binds. Inbound Veilid WebSocket listening is disabled.
Open both configured P2P protocols in host/cloud firewalls, and allow outbound
Internet/DNS. The HTTP port alone is not P2P connectivity.

## Real-network smoke test

Ordinary unit/router/socket tests are deterministic and do not require peers.
To test actual propagation, use two VPS hosts, or two processes with distinct
data directories and nonconflicting addresses:

```sh
MURMUR_HTTP_ADDR=127.0.0.1:18080 MURMUR_P2P_PORT=15150 \
  ./target/release/murmur --data-dir /tmp/murmur-a serve
MURMUR_HTTP_ADDR=127.0.0.1:18081 MURMUR_P2P_PORT=15151 \
  ./target/release/murmur --data-dir /tmp/murmur-b serve
```

Run each in its own terminal; open the corresponding P2P ports if needed.
After both are ready, publish through A's CLI, obtain A's RecordKey from
`http://127.0.0.1:18080/api/me`, and read it using B's UI/API. Restart A and
verify its key is unchanged and the next publication increments the index.
Verify literal rendering of HTML-like content in a real browser, empty-feed and
error states, and the absence of browser publishing.

Stop both processes and remove only their specifically created temporary
directories after the test. Do not run these fixed example ports/paths on a
shared machine without first checking they are unused. Mocked tests cannot
prove network attachment or global retention. The 100-post rollover belongs
in deterministic tests, not a public-network spam exercise.
