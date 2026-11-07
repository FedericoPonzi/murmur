import argparse
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import urlopen

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from website.serve import create_preview_server


def check(storage_only=False):
    artifacts = Path(tempfile.mkdtemp(prefix="murmur-browser-check-"))

    def log(message):
        with (artifacts / "run.log").open("a") as file:
            file.write(message + "\n")
        print(message, flush=True)

    server = driver = None
    try:
        origin = os.environ.get("MURMUR_PREVIEW_URL")
        if not origin:
            server = create_preview_server(Path(__file__).resolve().parent, port=0)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            origin = f"http://127.0.0.1:{server.server_port}/"
        options = webdriver.ChromeOptions()
        for argument in ("--headless=new", "--no-sandbox", "--disable-dev-shm-usage"):
            options.add_argument(argument)
        if os.environ.get("CHROME"):
            options.binary_location = os.environ["CHROME"]
        driver = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER")), options=options)
        driver.set_window_size(1280, 900)
        wait = WebDriverWait(driver, 180)
        element = lambda id: driver.find_element(By.ID, id)
        text = lambda id: element(id).text

        def storage(expected):
            wait.until(lambda _: text("storage") or not re.search("Starting|Attaching|Worker/storage ready", text("status")))
            if text("storage") != str(expected):
                raise AssertionError(text("status"))

        driver.get(origin)
        if os.environ.get("MURMUR_PREVIEW_URL"):
            driver.find_element(By.LINK_TEXT, "Docs").click()
            wait.until(lambda _: driver.find_element(By.TAG_NAME, "h1").text == "Documentation")
            driver.find_element(By.LINK_TEXT, "Current app").click()
        element("start").click()
        storage(1)
        if not storage_only:
            wait.until(lambda _: text("own-key").startswith("VLD0:"))
            key = text("own-key")
            element("read").click()
            wait.until(lambda _: key in text("feed"))
            assert json.loads(text("feed"))["posts"] == []
            first = driver.current_window_handle
            driver.switch_to.new_window("tab")
            driver.get(origin)
            element("start").click()
            wait.until(lambda _: "Another tab" in text("status"))
            driver.close()
            driver.switch_to.window(first)
            content = "Murmur disposable browser test <b>literal text</b>"
            element("content").send_keys(content)
            element("publish").click()
            wait.until(lambda _: content in text("feed"))
            assert not element("feed").find_elements(By.TAG_NAME, "b")
            element("key").clear()
            element("key").send_keys("invalid-key")
            element("read").click()
            wait.until(lambda _: "Invalid Veilid RecordKey" in text("status"))
            assert text("feed") == ""
        element("stop").click()
        wait.until(lambda _: text("status") == "Stopped.")
        driver.refresh()
        element("start").click()
        storage(2)
        if storage_only:
            log("PASS: worker startup and IndexedDB continuity. Network participation not checked.")
        else:
            wait.until(lambda _: text("own-key") == key)
            element("read").click()
            wait.until(lambda _: content in text("feed"))
            bridge = os.environ.get("MURMUR_BRIDGE_URL", "").rstrip("/")
            if not bridge:
                raise ValueError("Set MURMUR_BRIDGE_URL to verify native/browser cross-reads.")
            with urlopen(bridge + "/api/me", timeout=65) as response:
                me = json.load(response)
            element("key").clear()
            element("key").send_keys(me["record_key"])
            element("read").click()
            wait.until(lambda _: me["record_key"] in text("feed"))
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                try:
                    response = urlopen(bridge + "/api/feed/" + quote(key, safe=""), timeout=65)
                except HTTPError as failure:
                    response = failure
                with response:
                    status, feed = response.status, json.load(response)
                if status == 200 and feed.get("posts") and feed["posts"][0]["content"] == content:
                    break
                if status not in (200, 404, 502, 503, 504):
                    raise AssertionError(f"Native cross-read failed: HTTP {status}")
                log(f"Waiting for DHT propagation: HTTP {status}")
                time.sleep(2)
            else:
                raise AssertionError("Native node did not confirm the browser post.")
            log("PASS: browser/native cross-reads, publication, and stable identity/feed after reload.")
        driver.save_screenshot(str(artifacts / "result.png"))
    except Exception as failure:
        log(f"FAIL: {type(failure).__name__}: {failure}")
        if driver:
            status = driver.find_elements(By.ID, "status")
            log(f"UI: {status[0].text if status else driver.current_url}")
            driver.save_screenshot(str(artifacts / "failure.png"))
        raise
    finally:
        if driver:
            driver.quit()
        if server:
            server.shutdown()
            server.server_close()
        log(f"Artifacts: {artifacts}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Opt-in browser/network check using Selenium Python.")
    parser.add_argument("--storage-only", action="store_true")
    check(parser.parse_args().storage_only)
