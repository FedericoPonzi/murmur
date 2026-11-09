# Murmur

Murmur is a peer-to-peer microblogging proof of concept built with Rust and
[Veilid](https://veilid.com/). Publish short posts and follow feeds by their
RecordKey, without a central account service.

The browser app runs its own Veilid node through WebAssembly. Identities and
author credentials stay in the browser; the website serves only static files.

## Getting started

From a successful **Actions > CI** run, download the **murmur-local-preview**
artifact and extract its inner ZIP. In the extracted `murmur-local-preview`
directory, run:

```sh
python3 serve.py
```

Open `http://localhost:8000/app/`. Python 3.10+ is required; the prebuilt preview
needs no Rust installation.

To build from source, follow the [browser build instructions](docs/browser-probe.md#build-and-open),
then [assemble the website with the app](docs/dev-guide.md#website-preview).

The native CLI and read-only HTTP bridge remain available as an alternative
(`cargo build --release`); see the [native user guide](docs/user-guide.md).

## Known limitation

The browser app currently uses plain WebSockets and does not support HTTPS
deployment. Upstream Veilid's
[HTTPS browser support and outbound relays remain unfinished](https://gitlab.com/veilid/veilid/-/blob/main/veilid-wasm/README.md#running-wasm-on-https-sites-not-currently-implemented);
see the related open issue [veilid/veilid#430](https://gitlab.com/veilid/veilid/-/issues/430).

## License

Murmur is [MIT licensed](LICENSE). Dependencies retain their own licenses,
including Veilid's MPL-2.0.
