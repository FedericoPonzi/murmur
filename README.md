# Murmur

**Proof of Concept, not production software.** A minimal Rust micro-blog using
an embedded Veilid node, a read-only Axum browser bridge, and local CLI publishing.
No external `veilid-server`, JavaScript build step, or browser extension is needed.

## Ubuntu VPS quick start

Install a current stable Rust toolchain with [rustup](https://rustup.rs), then:

```sh
sudo apt-get update
sudo apt-get install -y build-essential pkg-config ca-certificates
cargo build --release
./target/release/murmur --data-dir "$HOME/.local/share/murmur" serve
```

Allow `8080/tcp` for the web UI and `5150/tcp` + `5150/udp` for Veilid in your
VPS/cloud firewall. If UFW is already enabled:

```sh
sudo ufw allow 8080/tcp
sudo ufw allow 5150/tcp
sudo ufw allow 5150/udp
```

Preserve your SSH firewall rule. Outbound DNS and Internet access are required.
Wait for the `Murmur ready` log, then open `http://<vps-ip>:8080`. From another
SSH session, publish with the same data directory:

```sh
./target/release/murmur --data-dir "$HOME/.local/share/murmur" post "Hello from Murmur"
```

Share the RecordKey displayed in the UI; paste another author's key to read
their feed. HTTP cannot publish. Keep `serve` running (use your usual terminal
multiplexer or service manager); Ctrl+C/SIGTERM shuts it down gracefully.

The PoC retains 100 posts and displays the newest 20. Posts are public to anyone
with the RecordKey; HTTP is unencrypted. Local writer keys are stored in private
files, **not a secure vault**. Back up the entire data directory and never share
`murmur_config.json`. Network availability and permanent DHT retention are
not guaranteed.

The pinned dependencies use Rustls and bundled native libraries: `libssl-dev`
and a Cap'n Proto compiler are not required for the normal locked build.
See [user guide](docs/user-guide.md) and [developer guide](docs/dev-guide.md)
for profile configuration, API details, testing, and build troubleshooting.
