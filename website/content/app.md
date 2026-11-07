# Browser application

This docs-only build does not include the interactive probe.
The full browser alpha remains in development.

## Try the current probe locally

Follow the [browser probe guide](../docs/browser-probe.html) to build its WASM
bindings, then build the site with `python3 website/build.py --with-app`.
That includes the current preview at `/app/`: create a passphrase-protected
identity, publish posts, and read other feeds by RecordKey.
Choose **Read without an identity** to read public feeds while your author
stays locked. Paste a complete RecordKey after the read-only node connects.
Lock or reload the page to end the session; unlock to use the same identity.
Download and verify an encrypted backup before valuable use. Restore only after
stopping the old publisher.
Drafts stay encrypted in this browser. You can update your public profile
without changing your RecordKey and revisit locally saved posts.

The [native read-only bridge](../docs/quick-start.html) remains available
separately. Save up to 50 follows on this browser; a combined timeline is planned.
