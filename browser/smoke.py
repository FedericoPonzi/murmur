import argparse
import json
import os
from pathlib import Path
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
        for argument in ("--headless=new", "--no-sandbox", "--disable-dev-shm-usage", "--force-prefers-reduced-motion"):
            options.add_argument(argument)
        if os.environ.get("CHROME"):
            options.binary_location = os.environ["CHROME"]
        driver = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER")), options=options)
        driver.set_window_size(1280, 900)
        wait = WebDriverWait(driver, 180)
        element = lambda id: driver.find_element(By.ID, id)
        text = lambda id: element(id).text

        def storage(expected):
            wait.until(lambda _: element("storage").get_attribute("textContent") or element("start").is_enabled() or element("unlock-start").is_enabled())
            if element("storage").get_attribute("textContent") != str(expected):
                raise AssertionError(text("status"))

        def visit():
            driver.get(origin)
            if os.environ.get("MURMUR_PREVIEW_URL"):
                driver.find_element(By.LINK_TEXT, "Docs").click()
                wait.until(lambda _: driver.find_element(By.TAG_NAME, "h1").text == "Documentation")
                driver.find_element(By.LINK_TEXT, "Open app").click()

        passphrase = "disposable browser identity passphrase"
        author = "Disposable <b>author</b>"
        visit()
        wait.until(lambda _: element("start").is_enabled())
        element("author-name").send_keys(author)
        element("bio").send_keys("A public disposable profile.")
        element("passphrase").send_keys(passphrase)
        element("confirm-passphrase").send_keys(passphrase + " mismatch")
        element("acknowledge").click()
        element("start").click()
        wait.until(lambda _: "do not match" in text("status"))
        element("confirm-passphrase").clear()
        element("confirm-passphrase").send_keys(passphrase)
        element("start").click()
        storage(1)
        key = text("own-key")
        assert key.startswith("VLD0:")
        assert text("profile-name") == author
        assert not element("profile-name").find_elements(By.TAG_NAME, "b")
        assert element("passphrase").get_attribute("value") == ""
        assert element("confirm-passphrase").get_attribute("value") == ""
        for width in (390, 320, 1280):
            driver.set_window_size(width, 900)
            assert driver.execute_script("return document.documentElement.scrollWidth <= innerWidth")
        if not storage_only:
            wait.until(lambda _: element("publish").is_enabled())
            element("read").click()
            wait.until(lambda _: key in text("feed"))
            initial = json.loads(text("feed"))
            assert initial["posts"] == []
            assert initial["metadata"]["author_name"] == author
            assert initial["metadata"]["bio"] == "A public disposable profile."
            first = driver.current_window_handle
            driver.switch_to.new_window("tab")
            visit()
            wait.until(lambda _: element("unlock-start").is_enabled())
            element("unlock-passphrase").send_keys(passphrase)
            element("unlock-start").click()
            wait.until(lambda _: "Another tab" in text("status"))
            driver.close()
            driver.switch_to.window(first)
            content = "Murmur disposable browser test <b>literal text</b>"
            element("content").send_keys(content)
            element("publish").click()
            wait.until(lambda _: content in text("feed"))
            assert not element("feed").find_elements(By.TAG_NAME, "b")
            assert json.loads(text("feed"))["index"] == 0
            assert element("content").get_attribute("value") == ""
            assert not element("content").get_attribute("readonly")
            content = "A second disposable browser post"
            element("content").send_keys(content)
            element("publish").click()
            wait.until(lambda _: content in text("feed"))
            assert json.loads(text("feed"))["index"] == 1
            assert element("content").get_attribute("value") == ""
            element("key").clear()
            element("key").send_keys("invalid-key")
            element("read").click()
            wait.until(lambda _: "Invalid Veilid RecordKey" in text("status"))
            assert text("feed") == ""
        element("stop").click()
        wait.until(lambda _: text("status") == "Identity locked.")
        assert text("own-key") == text("profile-name") == text("feed") == ""
        assert element("publish").is_enabled() is False
        driver.refresh()
        wait.until(lambda _: element("unlock-start").is_enabled())
        assert element("unlock-passphrase").get_attribute("value") == ""
        assert not element("session").is_displayed()
        element("unlock-passphrase").send_keys("incorrect passphrase")
        element("unlock-start").click()
        wait.until(lambda _: "Unlock failed" in text("status"))
        assert not element("session").is_displayed()
        assert element("unlock-passphrase").get_attribute("value") == ""
        element("unlock-passphrase").send_keys(passphrase)
        element("unlock-start").click()
        storage(2)
        assert text("own-key") == key
        assert text("profile-name") == author
        if storage_only:
            log("PASS: identity creation, literal profile display, locking, password rejection, and reload/unlock.")
        else:
            wait.until(lambda _: element("read").is_enabled())
            assert element("content").get_attribute("value") == ""
            assert not element("content").get_attribute("readonly")
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
                    assert feed["metadata"]["author_name"] == author
                    assert [post["index"] for post in feed["posts"]] == [1, 0]
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
