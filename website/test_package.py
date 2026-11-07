import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.request import urlopen
import zipfile

from package import make_bundle


class BundleTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="murmur-bundle-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.repository = self.root / "repository"
        self.output = self.repository / "website/output"
        for name, body in {
            "index.html": "<h1>Murmur</h1>",
            "participate.html": "Participate",
            "platforms.html": "Platforms",
            "limitations.html": "Limits",
            "docs/index.html": "Docs",
            "docs/quick-start.html": "Quick start",
            "style.css": "body {color: black}",
            "favicon.svg": "<svg/>",
            "LICENSE.txt": "Murmur MIT license",
            "app/index.html": "<h1>Local alpha</h1>",
            "app/app.mjs": "export const app = true;",
            "app/worker.mjs": "export const worker = true;",
            "app/feeds.mjs": "export const follows = true;",
            "app/pkg/murmur_browser.js": "export default async () => {};",
            "app/pkg/murmur_browser_bg.wasm": b"\0asm\1\0\0\0",
        }.items():
            path = self.output / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body.encode() if isinstance(body, str) else body)
        (self.repository / "website/serve.py").write_text("print('preview')")
        (self.repository / "LICENSE").write_text("Murmur MIT license")
        (self.repository / "Cargo.lock").write_text("locked sources")
        (self.repository / "plan.md").write_text("private plan")
        (self.repository / "murmur_config.json").write_text("private credentials")
        dependency = self.root / "dependency"
        dependency.mkdir()
        (dependency / "Cargo.toml").write_text("")
        (dependency / "LICENSE-MIT").write_text("Upstream copyright and permission")
        self.metadata = {
            "packages": [
                {"id": "browser", "name": "murmur-browser", "version": "0.1.0", "source": None,
                 "license": "MIT", "manifest_path": str(self.repository / "Cargo.toml"), "license_file": None},
                {"id": "dependency", "name": "dependency", "version": "1.0.0", "source": "registry+https://github.com/rust-lang/crates.io-index",
                 "license": "MIT", "manifest_path": str(dependency / "Cargo.toml"), "license_file": None},
                {"id": "unused", "name": "unused", "version": "1.0.0", "source": "registry+https://github.com/rust-lang/crates.io-index",
                 "license": None, "manifest_path": "not available", "license_file": None},
            ],
            "resolve": {"nodes": [
                {"id": "browser", "deps": [
                    {"pkg": "dependency", "dep_kinds": [{"kind": None}]},
                    {"pkg": "unused", "dep_kinds": [{"kind": "dev"}, {"kind": "build"}]},
                ]},
                {"id": "dependency", "deps": []},
            ]},
        }
        self.rust = self.root / "rust"
        (self.rust / "licenses").mkdir(parents=True)
        (self.rust / "COPYRIGHT-library.html").write_text("Rust library notices")
        (self.rust / "licenses/MIT.txt").write_text("Rust license")
        self.bundle = self.root / "preview.zip"
        self.provenance = {"revision": "a" * 40, "dirty": True, "rustc": "test compiler"}

    def build(self):
        make_bundle(self.repository, self.bundle, self.metadata, self.provenance, self.rust)

    def test_bundle_is_self_contained_with_notices_sources_and_verifiable_checksums(self):
        self.build()
        with zipfile.ZipFile(self.bundle) as archive:
            files = {name: archive.read(name) for name in archive.namelist()}
        self.assertIn(b"python3 serve.py", files["murmur-local-preview/README.txt"])
        self.assertIn(b"localhost:8000", files["murmur-local-preview/README.txt"])
        self.assertEqual(files["murmur-local-preview/serve.py"], b"print('preview')")
        self.assertEqual(files["murmur-local-preview/licenses/dependency-1.0.0/LICENSE-MIT"], b"Upstream copyright and permission")
        dependencies = json.loads(files["murmur-local-preview/THIRD-PARTY.json"])
        self.assertEqual([entry["name"] for entry in dependencies], ["dependency", "murmur-browser"])
        self.assertEqual(dependencies[0]["source_url"], "https://static.crates.io/crates/dependency/dependency-1.0.0.crate")
        build = json.loads(files["murmur-local-preview/BUILD.json"])
        self.assertEqual(build["revision"], "a" * 40)
        self.assertTrue(build["dirty"])
        self.assertEqual(build["cargo_lock_sha256"], hashlib.sha256(b"locked sources").hexdigest())
        self.assertFalse(any("private" in value.decode(errors="replace") for value in files.values()))
        checksums = files.pop("murmur-local-preview/SHA256SUMS").decode().splitlines()
        self.assertEqual(len(checksums), len(files))
        for line in checksums:
            digest, name = line.split("  ", 1)
            self.assertEqual(digest, hashlib.sha256(files[f"murmur-local-preview/{name}"]).hexdigest())

    def test_missing_licenses_or_runtime_assets_preserve_previous_bundle(self):
        self.build()
        previous = self.bundle.read_bytes()
        (self.root / "dependency/LICENSE-MIT").unlink()
        with self.assertRaisesRegex(ValueError, "license"):
            self.build()
        self.assertEqual(self.bundle.read_bytes(), previous)
        (self.root / "dependency/LICENSE-MIT").write_text("Upstream copyright and permission")
        (self.output / "app/worker.mjs").unlink()
        with self.assertRaisesRegex(ValueError, "assets"):
            self.build()
        self.assertEqual(self.bundle.read_bytes(), previous)

    def test_extracted_bundle_serves_application_and_wasm(self):
        source = Path(__file__).with_name("serve.py")
        (self.repository / "website/serve.py").write_bytes(source.read_bytes())
        self.build()
        extracted = self.root / "extracted"
        with zipfile.ZipFile(self.bundle) as archive:
            archive.extractall(extracted)
        path = extracted / "murmur-local-preview/serve.py"
        spec = importlib.util.spec_from_file_location("packaged_preview", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        server = module.create_preview_server(port=0)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        with urlopen(f"http://127.0.0.1:{server.server_port}/app/", timeout=3) as response:
            self.assertIn(b"Local alpha", response.read())
        with urlopen(f"http://127.0.0.1:{server.server_port}/app/pkg/murmur_browser_bg.wasm", timeout=3) as response:
            self.assertEqual(response.headers["Content-Type"], "application/wasm")
            self.assertEqual(response.read(), b"\0asm\1\0\0\0")

    def test_refuses_private_extra_files_symlinks_and_test_enabled_bindings(self):
        cases = [
            ("murmur_config.json", b"private credentials"),
            ("app/pkg/murmur_browser_bg.wasm", b"\0asm\1\0\0\0check_vault_format"),
        ]
        for name, data in cases:
            with self.subTest(name=name):
                path = self.output / name
                previous = path.read_bytes() if path.exists() else None
                path.write_bytes(data)
                with self.assertRaises(ValueError):
                    self.build()
                path.unlink()
                if previous is not None:
                    path.write_bytes(previous)
        path = self.output / "index.html"
        path.unlink()
        path.symlink_to(self.repository / "murmur_config.json")
        with self.assertRaisesRegex(ValueError, "symlink"):
            self.build()

    def test_dependency_license_path_cannot_copy_private_host_files(self):
        self.metadata["packages"][1]["license_file"] = str(self.repository / "murmur_config.json")
        with self.assertRaisesRegex(ValueError, "license path"):
            self.build()
