import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile
from build import validate_release


SITE_FILES = {
    "index.html", "participate.html", "platforms.html", "limitations.html",
    "app/index.html", "docs/index.html", "docs/quick-start.html",
    "style.css", "favicon.svg", "LICENSE.txt",
}
APP_FILES = {
    "app/app.mjs", "app/worker.mjs", "app/feeds.mjs", "app/device-session.mjs",
    "app/pkg/murmur_browser.js", "app/pkg/murmur_browser_bg.wasm",
}
FALLBACKS = {
    ("gloo-events", "0.3.0"): "gloo-MIT.txt",
    ("gloo-timers", "0.4.0"): "gloo-MIT.txt",
    ("gloo-utils", "0.2.0"): "gloo-MIT.txt",
    ("keyvaluedb", "0.2.6"): "keyvaluedb-MIT.txt",
    ("keyvaluedb-memorydb", "0.2.6"): "keyvaluedb-MIT.txt",
    ("keyvaluedb-web", "0.2.6"): "keyvaluedb-MIT.txt",
    ("tsify-macros", "0.5.7"): "tsify-MIT.txt",
}
README = """Murmur local browser alpha (experimental)

Extract this directory, open a terminal here, then run:
    python3 serve.py
Open http://localhost:8000/app/ (Python 3.10+; no Rust or Node install needed).
Stop with Ctrl+C. The server binds only to localhost. Keep this origin/port to
preserve browser storage; changing them does not transfer your identity.

Use disposable identities and harmless public text. Download AND verify an
encrypted identity backup. There is no password reset. This is a recent-post
feed, not permanent archival storage. The worker connects directly to Veilid;
the Python server does not hold credentials, sign, or publish for you.

Chromium on Linux has been exercised. Physical phones, Safari, and public
HTTPS/WSS hosting are unverified. Do not deploy this as a production service.
Documentation is included at http://localhost:8000/docs/.

BUILD.json identifies the build, including whether the source tree was dirty.
SHA256SUMS covers every other file; from this directory run sha256sum -c SHA256SUMS.
Checksums detect file changes, not authenticity. This bundle is not signed.

Murmur is MIT licensed (LICENSE.txt). THIRD-PARTY.json lists conservative WASM
build dependencies, their licenses, notices, and exact upstream source downloads.
No upstream crate source was modified. MPL-covered source is available through
those downloads; see licenses/ for license terms. The included Rust library
notices may also list components not linked into this WASM build.
"""


def dependencies(metadata):
    packages = {package["id"]: package for package in metadata["packages"]}
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    pending = [next(package["id"] for package in packages.values() if package["name"] == "murmur-browser")]
    seen = set()
    while pending:
        identity = pending.pop()
        if identity in seen:
            continue
        seen.add(identity)
        pending.extend(dependency["pkg"] for dependency in nodes[identity]["deps"]
                       if any(kind["kind"] is None for kind in dependency["dep_kinds"]))
    return sorted((packages[identity] for identity in seen), key=lambda package: (package["name"], package["version"]))


def make_bundle(repository, destination, metadata, provenance, rust_notices):
    site = repository / "website/output"
    expected = SITE_FILES | APP_FILES | {f"docs/{path.stem}.html" for path in (repository / "docs").glob("*.md")}
    paths = list(site.rglob("*"))
    if site.is_symlink() or any(path.is_symlink() for path in paths):
        raise ValueError("Preview assets must not contain symlinks.")
    releases = site / "app/releases"
    if releases.exists():
        for directory in releases.iterdir():
            expected.update(f"app/releases/{directory.name}/{name}" for name in validate_release(directory))
    actual = {path.relative_to(site).as_posix() for path in paths if path.is_file()}
    if actual != expected:
        raise ValueError(f"Unexpected or missing preview assets: {sorted(actual ^ expected)}")
    files = {f"output/{name}": (site / name).read_bytes() for name in sorted(expected)}
    wasm = files["output/app/pkg/murmur_browser_bg.wasm"]
    if not wasm.startswith(b"\0asm\1\0\0\0"):
        raise ValueError("Invalid browser WASM assets.")
    for symbol in (b"check_vault_format", b"test_seed_identity", b"test_storage"):
        if any(symbol in body for name, body in files.items() if name.endswith((".wasm", ".js"))):
            raise ValueError("Test-enabled bindings must not be distributed; rebuild without vault-tests.")
    files["serve.py"] = (repository / "website/serve.py").read_bytes()
    files["LICENSE.txt"] = (repository / "LICENSE").read_bytes()
    files["README.txt"] = README.encode()
    files["Cargo.lock"] = (repository / "Cargo.lock").read_bytes()
    files["BUILD.json"] = json.dumps({
        **provenance, "format_version": 1, "target": "wasm32-unknown-unknown",
        "cargo_lock_sha256": hashlib.sha256(files["Cargo.lock"]).hexdigest(),
    }, indent=2).encode()
    inventory = []
    packages = dependencies(metadata)
    for package in packages:
        name, version = package["name"], package["version"]
        if not package["license"]:
            raise ValueError(f"Missing dependency license: {name}-{version}")
        notices = []
        if package["source"] is None:
            notices = ["LICENSE.txt"]
        else:
            if not package["source"].startswith("registry+https://github.com/rust-lang/crates.io-index"):
                raise ValueError(f"Unsupported dependency source: {name}-{version}")
            directory = Path(package["manifest_path"]).parent
            notice_root = directory
            sources = []
            for path in directory.iterdir():
                if re.match(r"(?i)^(licen[cs]es?|copying|notice|copyright)([._-].*)?$", path.name):
                    sources.extend(path.rglob("*") if path.is_dir() else [path])
            if package.get("license_file"):
                sources.append(directory / package["license_file"])
            if not sources:
                fallback = FALLBACKS.get((name, version))
                if fallback:
                    sources = [repository / "website/license-notices" / fallback]
                elif (name, version) in {("indent", "0.1.1"), ("veilid-core-optimized", "0.5.8")}:
                    upstream = next(item for item in packages if item["name"] == "veilid-core" and item["version"] == "0.5.8")
                    sources = [Path(upstream["manifest_path"]).parent / "LICENSE.md"]
                elif (name, version) == ("pharos", "0.5.3"):
                    upstream = next(item for item in packages if item["name"] == "async_executors" and item["license"] == "Unlicense")
                    sources = [Path(upstream["manifest_path"]).parent / "LICENSE"]
                else:
                    raise ValueError(f"Missing dependency license notices: {name}-{version}")
                notice_root = sources[0].parent
            for path in sorted(set(sources)):
                if path.is_symlink():
                    raise ValueError(f"Dependency license must not be a symlink: {path}")
                if not path.is_file():
                    continue
                if not path.resolve().is_relative_to(notice_root.resolve()):
                    raise ValueError(f"Invalid dependency license path: {name}-{version}")
                relative = path.resolve().relative_to(notice_root.resolve()).as_posix()
                target = f"licenses/{name}-{version}/{relative}"
                files[target] = path.read_bytes()
                notices.append(target)
            if not notices:
                raise ValueError(f"Empty dependency license notices: {name}-{version}")
        inventory.append({
            "name": name, "version": version, "license": package["license"], "notices": notices,
            "source_url": f"https://static.crates.io/crates/{name}/{name}-{version}.crate" if package["source"] else None,
        })
    files["THIRD-PARTY.json"] = json.dumps(inventory, indent=2).encode()
    files["licenses/rust/COPYRIGHT-library.html"] = (rust_notices / "COPYRIGHT-library.html").read_bytes()
    for path in sorted((rust_notices / "licenses").glob("*.txt")):
        files[f"licenses/rust/licenses/{path.name}"] = path.read_bytes()
    if not any(name.startswith("licenses/rust/licenses/") for name in files):
        raise ValueError("Missing Rust library license texts.")
    files["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(files.items())
    ).encode()
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="murmur-package-", dir=destination.parent) as temporary:
        archive = Path(temporary) / "preview.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for name, data in sorted(files.items()):
                bundle.writestr(f"murmur-local-preview/{name}", data)
        archive.replace(destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Package the assembled local preview without private source or credentials.")
    parser.add_argument("--output", required=True, type=Path)
    destination = parser.parse_args().output.resolve()
    repository = Path(__file__).resolve().parent.parent

    def command(*arguments):
        return subprocess.check_output(arguments, cwd=repository, text=True).strip()

    metadata = json.loads(command("cargo", "metadata", "--offline", "--locked", "--format-version", "1",
                                  "--filter-platform", "wasm32-unknown-unknown"))
    make_bundle(repository, destination, metadata, {
        "revision": command("git", "rev-parse", "HEAD"),
        "dirty": bool(command("git", "status", "--porcelain", "--untracked-files=normal")),
        "rustc": command("rustc", "--version", "--verbose"),
        "wasm_bindgen": command("wasm-bindgen", "--version"),
    }, Path(command("rustc", "--print", "sysroot")) / "share/doc/rust")
    print(f"Local preview bundle: {destination}")
