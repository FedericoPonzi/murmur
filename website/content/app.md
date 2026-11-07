# Browser application

This docs-only build does not include the interactive probe.
The full browser alpha remains in development.

## Try the current probe locally

Follow the [browser probe guide](../docs/browser-probe.html) to build its WASM
bindings, then build the site with `node website/build.mjs --with-app`.
That includes the current probe at `/app/`: start a node, publish one disposable
test post, and read other feeds by RecordKey.

The [native read-only bridge](../docs/quick-start.html) remains available
separately. A full composer and encrypted identity management are planned.
