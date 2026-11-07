import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from website.serve import create_preview_server


if __name__ == "__main__":
    chrome = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium")
    if not chrome:
        raise SystemExit("Install Chromium/Chrome or set CHROME to its executable.")
    with tempfile.TemporaryDirectory(prefix="murmur-worker-check-") as profile:
        with create_preview_server(Path(__file__).resolve().parent, port=0) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            try:
                result = subprocess.run([
                    chrome, "--headless", "--no-sandbox", "--disable-gpu", "--dump-dom",
                    "--virtual-time-budget=3000", f"--user-data-dir={profile}",
                    f"http://127.0.0.1:{server.server_port}/worker-tests.html",
                ], capture_output=True, text=True, timeout=30)
                if result.returncode or '<output id="result">passed</output>' not in result.stdout:
                    raise SystemExit(f"Worker checks failed:\n{result.stdout}\n{result.stderr}")
                print("Browser worker checks passed.")
            finally:
                server.shutdown()
