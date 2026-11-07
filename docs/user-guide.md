# Using Murmur

Murmur is a PoC. The web UI is read-only; publishing requires access to the
server account through SSH.

## Start and read

Build and open the ports described in the [README](../README.md). Run:

```sh
./target/release/murmur --data-dir "$HOME/.local/share/murmur" serve
```

Startup waits for Veilid's public-network attachment (up to 120 seconds).
The HTTP bridge defaults to `0.0.0.0:8080`. When the ready log appears, browse
`http://<vps-ip>:8080`. Your server's feed is loaded automatically.

The directory defaults to `./murmur-data` if `--data-dir` is omitted. Always
use the same absolute directory when running commands from different SSH sessions.
Only one server may open a given directory.

## Publish over SSH

While `serve` is running, open another SSH session and run:

```sh
./target/release/murmur --data-dir "$HOME/.local/share/murmur" post "My first post"
```

Quote your message so it is one argument. Posts must contain non-whitespace
text and be at most 280 Unicode scalar values. A combined emoji can count as
multiple values. Success prints the logical post index and RecordKey.
The CLI contacts a private local Unix socket; there is no HTTP publishing API.

Reload the browser or select **Read this server's feed** to see new posts.
After 100 posts, each new post replaces the oldest slot. The browser returns at
most the newest 20; it is not an archive.

## Share and follow

Copy the complete **This server's feed key** from the UI and share it with readers.
They can paste it into the feed input on any compatible Murmur bridge and
select **Read feed**. No follower account or registration is required.
Following is an on-demand read, not a stored subscription.

The server's own key remains visible when viewing someone else's feed.
The key below the viewed author's bio identifies the currently displayed feed.
Network propagation is eventual; retry a read if a feed is temporarily unavailable.

## Profile and backups

First successful startup creates `<data-dir>/murmur_config.json`. Stop the
server, edit only `author_name` (nonblank, max 80 characters) and `bio` (max 280),
then restart. Leave `record_key` and `writer` unchanged. Never share this file:
the writer contains the secret that controls your feed.

Back up the entire data directory while the server is stopped, including the
Veilid stores, configuration, and any `pending-post.json`. Restore it privately
under the same server account. Directory permissions are 0700; generated
configuration/pending files and the publishing socket are 0600.
Do not run concurrent copies of an author's identity on different servers.

## Failures and limits

- **Cannot connect to local server:** check `serve` is ready, the SSH account,
  and the exact `--data-dir`.
- **Attachment timeout/offline:** check outbound connectivity and both TCP/UDP
  Veilid firewall rules. The bridge does not substitute an empty feed for failure.
- **Incomplete/changed feed:** DHT values may be propagating; read again.
- **Unconfirmed publish:** inspect the feed before resending. A timed-out write
  may still propagate. A pending post is recovered on restart or before the next
  publication; repeating the command can create a duplicate.
- **Recovery conflict or invalid local state:** stop and inspect/restore your
  backup. Do not delete the configuration or pending file to conceal the error.

The bridge sees your browser requests and the feeds you read. Plain HTTP provides
no browser-to-server transport privacy. RecordKeys grant reading access; posts
are not confidential, and neither the ring buffer nor the DHT guarantees
permanent deletion or retention. This is not production-hardened software.
