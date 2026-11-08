import http.client
import json
from pathlib import Path
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urljoin, urlsplit

from serve import create_preview_server

REPOSITORY = Path(__file__).resolve().parent.parent
WASM = b"\0asm\1\0\0\0"


class Links(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.links, self.ids, self.stylesheets = [], set(), []
        self.navigation, self.in_navigation = [], False
        self.descriptions = []
        self.feed(source)

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        if tag == "nav" and attributes.get("aria-label") == "Primary":
            self.in_navigation = True
        if tag == "a" and self.in_navigation:
            self.navigation.append(attributes["href"])
        self.links.extend(attributes[key] for key in ("href", "src") if key in attributes)
        if "id" in attributes:
            self.ids.add(attributes["id"])
        if tag == "link" and attributes.get("rel") == "stylesheet":
            self.stylesheets.append(attributes["href"])
        if tag == "meta" and attributes.get("name") == "description":
            self.descriptions.append(attributes.get("content", ""))

    def handle_endtag(self, tag):
        if tag == "nav":
            self.in_navigation = False


class BuildTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="murmur-site-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.output = self.root / "website/output"
        (self.root / "website").mkdir()
        for name in ("build.py", "config.yml", "content", "templates"):
            source, target = REPOSITORY / "website" / name, self.root / "website" / name
            shutil.copytree(source, target) if source.is_dir() else shutil.copy2(source, target)
        for name in ("README.md", "LICENSE", "docs"):
            source, target = REPOSITORY / name, self.root / name
            shutil.copytree(source, target) if source.is_dir() else shutil.copy2(source, target)
        (self.root / "browser/pkg").mkdir(parents=True)
        for name in ("index.html", "app.mjs", "worker.mjs", "feeds.mjs", "device-session.mjs", "style.css", "favicon.svg"):
            shutil.copy2(REPOSITORY / "browser" / name, self.root / "browser" / name)
        (self.root / "browser/pkg/murmur_browser.js").write_text("export default async () => {};")
        (self.root / "browser/pkg/murmur_browser_bg.wasm").write_bytes(WASM)
        guide = self.root / "docs/user-guide.md"
        guide.write_text(guide.read_text() + "\n## Source continuity\n\nA newly authored guide paragraph.\n")
        (self.root / "plan.md").write_text("Private working direction.")
        (self.root / "murmur_config.json").write_text('{"writer":"disposable-test-secret"}')
        self.build()

    def build(self, *arguments):
        return subprocess.run(
            [sys.executable, str(self.root / "website/build.py"), *arguments],
            check=True, capture_output=True, text=True,
        )

    def read(self, name):
        return (self.output / name).read_text()

    def test_current_guides_and_license_without_private_files(self):
        self.assertIn("A newly authored guide paragraph.", self.read("docs/user-guide.html"))
        self.assertIn("DHT schema", self.read("docs/dev-guide.html"))
        self.assertIn("cargo build --release", self.read("docs/quick-start.html"))
        self.assertIn("Permission is hereby granted", self.read("LICENSE.txt"))
        self.assertFalse((self.output / "plan.md").exists())
        self.assertFalse((self.output / "murmur_config.json").exists())

    def test_app_assets_and_shared_stylesheet_work_under_a_base_path(self):
        self.build("--with-app")
        base = "https://preview.invalid/murmur/"
        for file in self.output.rglob("*.html"):
            page = urljoin(base, file.relative_to(self.output).as_posix())
            for reference in Links(file.read_text()).links:
                target = urlsplit(urljoin(page, reference))
                if target.netloc != "preview.invalid":
                    continue
                self.assertTrue(target.path.startswith("/murmur/"), reference)
                local = self.output / unquote(target.path.removeprefix("/murmur/"))
                if target.path.endswith("/"):
                    local /= "index.html"
                self.assertTrue(local.is_file(), reference)
                if target.fragment:
                    self.assertIn(unquote(target.fragment), Links(local.read_text()).ids)
        doc_css = urljoin(base + "docs/index.html", Links(self.read("docs/index.html")).stylesheets[0])
        app_css = urljoin(base + "app/index.html", Links(self.read("app/index.html")).stylesheets[0])
        self.assertNotEqual(doc_css, app_css)
        self.assertEqual((self.output / urlsplit(app_css).path.removeprefix("/murmur/")).read_bytes(),
                         (self.output / "style.css").read_bytes())
        self.assertEqual((self.output / "style.css").read_bytes(), (REPOSITORY / "browser/style.css").read_bytes())
        self.assertEqual((self.output / "app/pkg/murmur_browser_bg.wasm").read_bytes(), WASM)
        self.assertEqual(self.read("app/worker.mjs"), (REPOSITORY / "browser/worker.mjs").read_text())
        self.assertEqual(self.read("app/app.mjs"), (REPOSITORY / "browser/app.mjs").read_text())
        self.assertEqual(self.read("app/feeds.mjs"), (REPOSITORY / "browser/feeds.mjs").read_text())
        self.assertIn("new Worker(new URL('./worker.mjs', import.meta.url)", self.read("app/app.mjs"))

    def test_application_pins_worker_modules_wasm_and_styles_to_one_release(self):
        self.build("--with-app")
        page = self.read("app/index.html")
        script = re.search(r'src="(\./releases/[a-f0-9]{64}/app.mjs)"', page)
        self.assertIsNotNone(script, "App entrypoint is not release-pinned.")
        release = self.output / "app" / Path(script[1]).parent
        for name in ("app.mjs", "worker.mjs", "feeds.mjs", "device-session.mjs",
                     "pkg/murmur_browser.js", "pkg/murmur_browser_bg.wasm", "style.css"):
            self.assertEqual((release / name).read_bytes(), (self.root / "browser" / name).read_bytes())
        self.assertIn(f'href="./{Path(script[1]).parent.as_posix()}/style.css"', page)

    def test_platforms_are_planned_without_fake_downloads(self):
        rows = re.findall(r"<tr>(.*?)</tr>", self.read("platforms.html"), re.S)
        for platform in ("Linux", "Windows", "macOS", "Android", "iOS"):
            row = next(row for row in rows if platform in row)
            self.assertIn("Planned", row)
            self.assertNotRegex(row, r"<a[\s>]")

    def test_only_runtime_bindings_are_published(self):
        private = self.root / "browser/pkg/private.json"
        private.write_text('{"writer":"must-not-be-published"}')
        self.build("--with-app")
        self.assertFalse((self.output / "app/pkg/private.json").exists())

    def test_primary_navigation_reaches_landing_sections_and_app_from_docs(self):
        base = "https://preview.invalid/murmur/"
        navigation = Links(self.read("docs/index.html")).navigation
        sections = [urlsplit(urljoin(base + "docs/index.html", link))
                    for link in navigation if urlsplit(link).fragment]
        self.assertTrue(sections, "Primary navigation needs a landing-page section.")
        for section in sections:
            self.assertEqual(section.path, "/murmur/index.html")
            self.assertIn(section.fragment, Links(self.read("index.html")).ids)
        self.assertIn(base + "app/index.html",
                      [urljoin(base + "docs/index.html", link) for link in navigation])

    def test_landing_html_is_not_interpreted_as_page_metadata(self):
        descriptions = Links(self.read("index.html")).descriptions
        self.assertEqual(len(descriptions), 1)
        self.assertTrue(descriptions[0])
        self.assertNotRegex(descriptions[0], r"[<>]")

    def test_failed_build_preserves_working_output(self):
        self.build("--with-app")
        previous = self.read("app/index.html")
        (self.root / "browser/pkg/murmur_browser_bg.wasm").unlink()
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            self.build("--with-app")
        self.assertIn("WASM bindings", failure.exception.stderr)
        self.assertEqual(self.read("app/index.html"), previous)
        guide = self.root / "docs/user-guide.md"
        guide.write_text(guide.read_text() + "\n[Missing guide](missing.md)\n")
        with self.assertRaises(subprocess.CalledProcessError) as failure:
            self.build()
        self.assertIn("Broken internal link", failure.exception.stderr)
        self.assertEqual(self.read("app/index.html"), previous)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="murmur-preview-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name) / "output"
        (cls.root / "app/pkg").mkdir(parents=True)
        (cls.root / "index.html").write_text("<h1>Murmur</h1>")
        (cls.root / "app/index.html").write_text("<h1>Probe</h1>")
        (cls.root / "app/worker.mjs").write_text("export const worker = true;")
        (cls.root / "app/pkg/node.wasm").write_bytes(WASM)
        private = cls.root.parent / "murmur_config.json"
        private.write_text('{"writer":"must-not-be-served"}')
        (cls.root / "private-link").symlink_to(private)
        cls.requests = []

        class Bridge(BaseHTTPRequestHandler):
            def do_GET(self):
                cls.requests.append((self.command, self.path, self.headers.get("Cookie")))
                if self.path.endswith("/redirect"):
                    self.send_response(302)
                    self.send_header("Location", "/api/post")
                    self.end_headers()
                    return
                body = b'{"source":"bridge"}'
                if self.path.endswith("/invalid"):
                    body = b"not JSON"
                if self.path.endswith("/large"):
                    body = json.dumps({"text": "x" * 65536}).encode()
                if self.path.endswith("/nonfinite"):
                    body = b'{"value":NaN}'
                self.send_response(503 if self.path.endswith("/unavailable") else 200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body) + (1 if self.path.endswith("/truncated") else 0)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *arguments):
                pass

        cls.bridge = cls.start(ThreadingHTTPServer(("127.0.0.1", 0), Bridge))
        cls.preview = cls.start(create_preview_server(
            cls.root, f"http://127.0.0.1:{cls.bridge.server_port}", port=0,
        ))

    @classmethod
    def start(cls, server):
        threading.Thread(target=server.serve_forever, daemon=True).start()
        cls.addClassCleanup(server.server_close)
        cls.addClassCleanup(server.shutdown)
        return server

    def request(self, path, method="GET", headers=None, server=None):
        connection = http.client.HTTPConnection("127.0.0.1", (server or self.preview).server_port, timeout=3)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def test_indexes_modules_and_wasm_mime(self):
        self.assertIn(b"Probe", self.request("/app/")[2])
        self.assertIn("javascript", self.request("/app/worker.mjs")[1]["Content-Type"])
        status, headers, body = self.request("/app/pkg/node.wasm")
        self.assertEqual((status, headers["Content-Type"], body), (200, "application/wasm", WASM))
        self.assertEqual(self.request("/app/pkg/node.wasm", "HEAD")[2], b"")

    def test_private_and_malformed_paths(self):
        for path in ("/..%2fmurmur_config.json", "/private-link", "/missing"):
            status, _, body = self.request(path)
            self.assertEqual(status, 404)
            self.assertNotIn(b"must-not-be-served", body)
        self.assertEqual(self.request("/bad%xx")[0], 400)
        with socket.create_connection(("127.0.0.1", self.preview.server_port), timeout=3) as connection:
            connection.sendall(b"GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            response = http.client.HTTPResponse(connection)
            response.begin()
            self.assertEqual(response.status, 400)
            response.read()
        self.assertEqual(self.request("/")[0], 200)

    def test_proxy_only_forwards_supported_gets(self):
        self.requests.clear()
        self.assertEqual(json.loads(self.request("/api/me", headers={"Cookie": "private-test-cookie"})[2]), {"source": "bridge"})
        self.assertEqual(self.request("/api/feed/unavailable")[0], 503)
        self.assertEqual(self.request("/api/post", "POST")[0], 405)
        self.assertEqual(self.request("/api/post")[0], 404)
        self.assertEqual(self.request("/api/me", "HEAD")[0], 405)
        self.assertEqual(self.request("/api/feed/redirect")[0], 502)
        self.assertEqual(self.requests, [
            ("GET", "/api/me", None), ("GET", "/api/feed/unavailable", None),
            ("GET", "/api/feed/redirect", None),
        ])

    def test_proxy_forwards_only_bounded_page_queries(self):
        self.requests.clear()
        for path in ("/api/feed/key/page", "/api/feed/key/page?anchor=105&before=86"):
            self.assertEqual(self.request(path)[0], 200)
            self.assertEqual(self.requests[-1][1], path)
        count = len(self.requests)
        for query in ("anchor=105", "before=86", "anchor=x&before=86", "anchor=105&before=0",
                      "anchor=105&before=86&extra=1", "anchor=105&anchor=105&before=86"):
            self.assertEqual(self.request("/api/feed/key/page?" + query)[0], 404)
        self.assertEqual(len(self.requests), count)

    def test_proxy_errors_and_invalid_configuration(self):
        unconfigured = self.start(create_preview_server(self.root, port=0))
        self.assertEqual(self.request("/api/me", server=unconfigured)[0], 503)
        disconnected = self.start(create_preview_server(self.root, "http://127.0.0.1:0", port=0))
        self.assertEqual(self.request("/api/me", server=disconnected)[0], 502)
        for key in ("invalid", "large", "truncated", "nonfinite"):
            self.assertEqual(self.request(f"/api/feed/{key}")[0], 502)
        for bridge in ("http://user:password@localhost:8080", "http://localhost:8080/private"):
            with self.assertRaisesRegex(ValueError, "bridge origin"):
                create_preview_server(self.root, bridge, port=0)
