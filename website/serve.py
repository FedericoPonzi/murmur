from functools import partial
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import re
import signal
import time
from urllib.parse import parse_qsl, unquote, urlsplit


class PreviewHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".mjs": "text/javascript", ".js": "text/javascript",
        ".wasm": "application/wasm", ".css": "text/css", ".txt": "text/plain",
    }

    def __init__(self, *arguments, bridge=None, **keywords):
        self.bridge = bridge
        super().__init__(*arguments, **keywords)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def error(self, status, message):
        body = json.dumps({"error": message}).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def request_url(self):
        try:
            url = urlsplit(self.path)
            if re.search(r"%(?![0-9a-fA-F]{2})", url.path):
                raise ValueError("Invalid encoding")
            unquote(url.path, errors="strict")
            return url
        except (ValueError, UnicodeError):
            self.error(400, "Invalid preview path.")

    def do_GET(self):
        url = self.request_url()
        if url is None:
            return
        if not url.path.startswith("/api/"):
            super().do_GET()
            return
        page = re.fullmatch(r"/api/feed/[^/]+/page", url.path)
        valid = not url.query
        if page and url.query:
            pairs = parse_qsl(url.query, keep_blank_values=True)
            parameters = dict(pairs)
            valid = len(pairs) == 2 and set(parameters) == {"anchor", "before"} \
                and all(re.fullmatch(r"[0-9]{1,20}", value) for value in parameters.values())
            if valid:
                anchor, before = int(parameters["anchor"]), int(parameters["before"])
                valid = anchor <= 2**64 - 1 and max(0, anchor - 99) < before <= anchor
        if not (page or re.fullmatch(r"/api/(?:me|feed/[^/]+)", url.path)) or not valid:
            self.error(404, "Unknown bridge read endpoint.")
        elif self.bridge is None:
            self.error(503, "Read-only bridge is not configured.")
        else:
            self.proxy(url.path + ("?" + url.query if url.query else ""))

    def do_HEAD(self):
        url = self.request_url()
        if url is None:
            return
        if url.path.startswith("/api/"):
            self.send_response(405)
            self.send_header("Allow", "GET")
            self.end_headers()
        else:
            super().do_HEAD()

    def reject(self):
        self.send_response(405)
        self.send_header("Allow", "GET, HEAD")
        self.end_headers()

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = reject

    def send_head(self):
        url = self.request_url()
        if url is None:
            return None
        try:
            root = Path(self.directory)
            path = unquote(url.path).lstrip("/")
            target = (root / (path + "index.html" if url.path.endswith("/") else path)).resolve()
            if not target.is_relative_to(root):
                self.error(404, "Not found.")
                return None
            file = target.open("rb")
        except (FileNotFoundError, NotADirectoryError, IsADirectoryError):
            self.error(404, "Not found.")
            return None
        except ValueError:
            self.error(400, "Invalid preview path.")
            return None
        except OSError:
            logging.exception("Preview file read failed.")
            self.error(500, "Preview file read failed.")
            return None
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(str(target)))
        self.send_header("Content-Length", str(os.fstat(file.fileno()).st_size))
        self.end_headers()
        return file

    def proxy(self, path):
        deadline = time.monotonic() + 150
        response = None

        def remaining():
            seconds = deadline - time.monotonic()
            if seconds <= 0:
                raise TimeoutError("Bridge deadline exceeded.")
            return seconds

        def invalid_constant(value):
            raise ValueError("Invalid JSON constant.")

        connection_type = http.client.HTTPSConnection if self.bridge.scheme == "https" else http.client.HTTPConnection
        connection = connection_type(self.bridge.hostname, self.bridge.port, timeout=150)
        try:
            connection.connect()
            socket = connection.sock
            socket.settimeout(remaining())
            connection.request("GET", path)
            socket.settimeout(remaining())
            response = connection.getresponse()
            if 300 <= response.status < 400 or response.headers.get_content_type() != "application/json":
                raise ValueError("Unexpected bridge response.")
            body = bytearray()
            while not response.isclosed():
                socket.settimeout(remaining())
                chunk = response.read1(min(8192, 65537 - len(body)))
                if not chunk:
                    break
                body.extend(chunk)
                if len(body) > 65536:
                    raise ValueError("Bridge response is too large.")
            if response.length not in (None, 0):
                raise ValueError("Incomplete bridge response.")
            json.loads(body, parse_constant=invalid_constant)
            self.send_response(response.status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (OSError, http.client.HTTPException, ValueError) as failure:
            logging.warning("Read-only bridge request failed.")
            self.error(504 if isinstance(failure, TimeoutError) else 502, "Read-only bridge request failed; retry later.")
        finally:
            if response is not None:
                response.close()
            connection.close()


def create_preview_server(root=None, bridge=None, port=8000):
    root = Path(root or Path(__file__).parent / "output").resolve(strict=True)
    if bridge:
        bridge = urlsplit(bridge)
        if bridge.scheme not in ("http", "https") or not bridge.hostname or bridge.username or bridge.password \
                or bridge.path not in ("", "/") or bridge.query or bridge.fragment:
            raise ValueError("Configure a read-only bridge origin without credentials, path, query, or fragment.")
        bridge.port
    return ThreadingHTTPServer(("127.0.0.1", port), partial(PreviewHandler, directory=str(root), bridge=bridge or None))


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    if not 1 <= port <= 65535:
        raise ValueError("PORT must be between 1 and 65535.")

    def stop(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    with create_preview_server(bridge=os.environ.get("MURMUR_BRIDGE_URL"), port=port) as server:
        print(f"Local preview: http://localhost:{port}/app/", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
