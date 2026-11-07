import argparse
from functools import partial
from http.server import ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from website.serve import PreviewHandler


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument("--page", default="worker-tests.html")
    arguments = parser.parse_args()
    chrome = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium")
    if not chrome:
        raise SystemExit("Install Chromium/Chrome or set CHROME to its executable.")
    completed = threading.Event()

    class CheckHandler(PreviewHandler):
        def do_GET(self):
            if self.path == "/__check_done":
                completed.set()
            elif self.path == "/__check_wait":
                completed.wait(60)
            else:
                return super().do_GET()
            self.send_response(204)
            self.end_headers()

    with tempfile.TemporaryDirectory(prefix="murmur-worker-check-") as profile:
        root = arguments.root.resolve(strict=True)
        with ThreadingHTTPServer(("127.0.0.1", 0), partial(CheckHandler, directory=str(root))) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                with tempfile.NamedTemporaryFile(mode="w+", prefix="murmur-browser-check-", suffix=".log", delete=False) as log:
                    try:
                        result = subprocess.run([
                            chrome, "--headless", "--no-sandbox", "--disable-gpu", "--dump-dom",
                            "--virtual-time-budget=3000", f"--user-data-dir={profile}",
                            f"http://127.0.0.1:{server.server_port}/{arguments.page}",
                        ], stdout=log, stderr=subprocess.STDOUT, text=True, timeout=75)
                    except subprocess.TimeoutExpired as failure:
                        raise SystemExit(f"Browser checks timed out; log: {log.name}") from failure
                    log.seek(0)
                    output = log.read()
                    if result.returncode or '<output id="result">passed</output>' not in output:
                        detail = output.partition('<output id="result">')[2].partition('</output>')[0]
                        raise SystemExit(f"Browser checks failed: {detail or 'no result'}; log: {log.name}")
                print(f"Browser checks passed: {arguments.page}")
            finally:
                completed.set()
                server.shutdown()
