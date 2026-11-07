# Limits and privacy

Murmur is experimental software. Do not use the current probe for valuable
identities or private information.

- Posts are public to anyone with the complete RecordKey.
- Feeds retain 100 network slots and show the newest 20 posts. Neither the DHT
  nor the ring guarantees permanent storage or deletion.
- Network attachment and replication can fail or take time. An uncertain
  publication must be checked before resending.
- Current native files and browser probe storage are **not a secure identity
  vault**. Encrypted onboarding and backup/restore are planned.
- The read-only bridge sees browser requests and the feeds requested.
  Local plain HTTP does not provide browser-to-server transport privacy.
- An unlocked browser session trusts the served application code. A worker is
  not protection from malicious same-origin code.
- Closing or suspending a browser tab can stop its node. Background operation
  and simultaneous publishing from multiple devices are not promised.

See the [user guide](docs/user-guide.html) and
[browser probe guide](docs/browser-probe.html) for current operational limits.
