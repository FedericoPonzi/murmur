import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError
from urllib.parse import quote, urljoin
from urllib.request import urlopen

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from website.serve import create_preview_server


def check(storage_only=False):
    artifacts = Path(tempfile.mkdtemp(prefix="murmur-browser-check-"))

    def log(message):
        with (artifacts / "run.log").open("a") as file:
            file.write(message + "\n")
        print(message, flush=True)

    server = restore_server = driver = None
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
        options.add_experimental_option("prefs", {
            "download.default_directory": str(artifacts),
            "download.prompt_for_download": False,
        })
        driver = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER")), options=options)
        driver.set_window_size(1280, 900)
        wait = WebDriverWait(driver, 180)
        element = lambda id: driver.find_element(By.ID, id)
        text = lambda id: element(id).get_attribute("textContent") if id in ("feed", "own-key", "profile-name", "profile-bio") else element(id).text

        def reveal_view(id):
            view = driver.execute_script("return arguments[0].closest('section[id^=\"view-\"]')?.id", element(id))
            if view in ("view-home", "view-profile", "view-following", "view-settings") and not element(view).is_displayed():
                click(view.replace("view-", "nav-"))

        def click(id):
            reveal_view(id)
            driver.execute_script("arguments[0].scrollIntoView({block: 'center', behavior: 'instant'})", element(id))
            element(id).click()

        def open_details(id):
            reveal_view(id)
            summary = element(id).find_element(By.TAG_NAME, "summary")
            driver.execute_script("arguments[0].scrollIntoView({block: 'center', behavior: 'instant'})", summary)
            summary.click()

        def storage(expected):
            wait.until(lambda _: element("storage").get_attribute("textContent") or element("start").is_enabled() or element("unlock-start").is_enabled())
            if element("storage").get_attribute("textContent") != str(expected):
                raise AssertionError(text("status"))

        def visit():
            if os.environ.get("MURMUR_PREVIEW_URL"):
                driver.get(urljoin(origin, "../index.html"))
                for width in (1280, 390, 320):
                    driver.set_window_size(width, 900)
                    assert driver.execute_script("""
                        const cards = [...document.querySelectorAll('.feed-preview .post-card')];
                        return cards.length > 0 && cards.every(card => {
                            const bounds = card.getBoundingClientRect();
                            const labels = [...card.querySelectorAll('.post-detail span')];
                            return labels.length === 2 && labels.every(label => {
                                const text = label.getBoundingClientRect();
                                return text.left - bounds.left >= 12 && bounds.right - text.right >= 12;
                            });
                        });
                    """), f"Landing post details touch the card edges at {width}px."
                    assert driver.execute_script("return document.documentElement.scrollWidth <= innerWidth")
                driver.set_window_size(1280, 900)
                driver.find_element(By.LINK_TEXT, "Docs").click()
                wait.until(lambda _: driver.find_element(By.TAG_NAME, "h1").text == "Documentation")
                driver.find_element(By.LINK_TEXT, "Open app").click()
            else:
                driver.get(origin)

        passphrase = "disposable browser identity passphrase"
        author = "Disposable <b>author</b>"
        visit()
        wait.until(lambda _: element("start").is_enabled())
        skip = driver.find_element(By.CSS_SELECTOR, 'a[href="#main-content"]')
        driver.find_element(By.TAG_NAME, "body").send_keys(Keys.TAB)
        assert driver.execute_script("return document.activeElement === arguments[0]", skip)
        skip.send_keys(Keys.ENTER)
        assert driver.current_url.endswith("#main-content")
        assert not driver.execute_script("""
            const script = document.createElement('script');
            script.textContent = 'window.inlineScriptRan = true';
            document.body.append(script);
            return window.inlineScriptRan === true;
        """), "The app must block injected inline scripts."
        element("author-name").send_keys(author)
        element("bio").send_keys("A public disposable profile.")
        element("passphrase").send_keys(passphrase)
        element("confirm-passphrase").send_keys(passphrase + " mismatch")
        click("acknowledge")
        click("start")
        wait.until(lambda _: "do not match" in text("status"))
        element("confirm-passphrase").clear()
        element("confirm-passphrase").send_keys(passphrase)
        click("start")
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
            assert driver.execute_script("""
                const sidebar = document.getElementById('session-sidebar');
                const content = document.getElementById('session-content');
                const left = sidebar.getBoundingClientRect(), right = content.getBoundingClientRect();
                return document.getElementById('view-home').contains(document.getElementById('author-tools'))
                    && document.getElementById('view-settings').contains(document.getElementById('session-diagnostics'))
                    && sidebar.contains(document.getElementById('status'))
                    && (innerWidth > 760 ? left.right <= right.left : left.bottom <= right.top);
            """), f"Social sidebar/feed layout is not usable at {width}px."
        if not storage_only:
            wait.until(lambda _: element("read").is_enabled())
            click("read")
            wait.until(lambda _: key in text("feed"))
            initial = json.loads(text("feed"))
            assert initial["posts"] == []
            assert initial["metadata"]["author_name"] == author
            assert initial["metadata"]["bio"] == "A public disposable profile."
            bridge_url = os.environ.get("MURMUR_BRIDGE_URL")
            if bridge_url:
                with urlopen(bridge_url + "/api/me", timeout=150) as response:
                    bridge_key = json.load(response)["record_key"]
                path = bridge_url + "/api/feed/" + quote(bridge_key, safe="")
                with urlopen(path, timeout=150) as response:
                    recent = json.load(response)
                with urlopen(path + "/page", timeout=150) as response:
                    page = json.load(response)
                assert {name: page[name] for name in ("record_key", "metadata", "posts")} == recent
                assert "next" in page
                try:
                    urlopen(path + "/page?anchor=105&before=0", timeout=150)
                    raise AssertionError("Invalid bridge page cursor was accepted.")
                except HTTPError as failure:
                    assert failure.code == 400 and json.load(failure)["error"]
            first = driver.current_window_handle
            driver.switch_to.new_window("tab")
            visit()
            wait.until(lambda _: element("unlock-start").is_enabled())
            element("unlock-passphrase").send_keys(passphrase)
            click("unlock-start")
            wait.until(lambda _: "Another tab" in text("status"))
            driver.close()
            driver.switch_to.window(first)
            content = "Murmur disposable browser test <b>literal text</b>"
            click("new-post")
            element("content").send_keys(content)
            click("publish")
            wait.until(lambda _: content in text("feed"))
            assert not element("feed").find_elements(By.TAG_NAME, "b")
            assert json.loads(text("feed"))["index"] == 0
            assert element("content").get_attribute("value") == ""
            assert not element("content").get_attribute("readonly")
            content = "A second disposable browser post"
            element("content").send_keys(content)
            click("publish")
            wait.until(lambda _: content in text("feed"))
            assert json.loads(text("feed"))["index"] == 1
            assert element("content").get_attribute("value") == ""
            click("nav-home")
            author_link = element("timeline").find_element(By.TAG_NAME, "a")
            driver.execute_script("arguments[0].scrollIntoView({block: 'center', behavior: 'instant'})", author_link)
            author_link.send_keys(Keys.ENTER)
            wait.until(lambda _: len(element("feed-cards").find_elements(By.TAG_NAME, "article")) == 2)
            assert json.loads(text("feed"))["next"] is None
            assert not element("load-older").is_displayed()
            click("refresh-selected")
            wait.until(lambda _: not element("read").get_attribute("disabled"))
            assert len(element("feed-cards").find_elements(By.TAG_NAME, "article")) == 2
            open_details("profile-settings")
            author = "Updated <b>author</b>"
            element("edit-name").clear()
            element("edit-name").send_keys(author)
            click("save-profile")
            wait.until(lambda _: text("status") == "Public profile updated.")
            assert text("own-key") == key
            assert text("profile-name") == author
            click("nav-following")
            previous_feed = text("feed")
            assert previous_feed
            element("key").clear()
            element("key").send_keys("invalid-key")
            click("read")
            wait.until(lambda _: "Invalid Veilid RecordKey" in text("status"))
            assert text("feed") == previous_feed
        draft = "An unpublished encrypted draft"
        click("new-post")
        element("content").send_keys(draft)
        wait.until(lambda _: text("draft-status") == "Draft saved on this browser.")
        click("stop")
        wait.until(lambda _: text("status").startswith("Logged out."))
        assert text("own-key") == text("profile-name") == text("feed") == ""
        assert element("publish").is_enabled() is False
        driver.refresh()
        wait.until(lambda _: element("unlock-start").is_enabled())
        assert element("unlock-passphrase").get_attribute("value") == ""
        assert not element("session").is_displayed()
        element("unlock-passphrase").send_keys("incorrect passphrase")
        click("unlock-start")
        wait.until(lambda _: "Unlock failed" in text("status"))
        assert not element("session").is_displayed()
        assert element("unlock-passphrase").get_attribute("value") == ""
        element("unlock-passphrase").send_keys(passphrase)
        click("unlock-start")
        storage(2)
        assert text("own-key") == key
        assert text("profile-name") == author
        assert element("content").get_attribute("value") == draft
        if storage_only:
            log("PASS: identity creation, literal profile display, locking, password rejection, and reload/unlock.")
        else:
            wait.until(lambda _: element("read").is_enabled())
            assert element("content").get_attribute("value") == draft
            assert not element("content").get_attribute("readonly")
            click("read")
            wait.until(lambda _: content in text("feed"))
            bridge = os.environ.get("MURMUR_BRIDGE_URL", "").rstrip("/")
            if not bridge:
                raise ValueError("Set MURMUR_BRIDGE_URL to verify native/browser cross-reads.")
            with urlopen(bridge + "/api/me", timeout=65) as response:
                me = json.load(response)
            click("nav-following")
            element("key").clear()
            element("key").send_keys(me["record_key"])
            click("read")
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
            open_details("backup-settings")
            backup_passphrase = "disposable saved backup passphrase"
            element("backup-passphrase").send_keys(backup_passphrase)
            element("backup-confirm").send_keys(backup_passphrase)
            click("download-backup")
            backup_file = artifacts / "murmur-identity.murmur"
            wait.until(lambda _: backup_file.is_file())
            wait.until(lambda _: text("status").startswith("Backup prepared"))
            assert set(json.loads(backup_file.read_text())) == {"header", "ciphertext"}
            element("verify-file").send_keys(str(backup_file))
            element("verify-passphrase").send_keys(backup_passphrase)
            click("verify-backup")
            wait.until(lambda _: text("status").startswith("Verified:") or "verification failed" in text("status"))
            assert text("status").startswith("Verified:"), text("status")
            click("stop")
            wait.until(lambda _: text("status").startswith("Logged out."))
            root = Path(__file__).resolve().parent.parent
            combined = bool(os.environ.get("MURMUR_PREVIEW_URL"))
            restore_server = create_preview_server(root / ("website/output" if combined else "browser"), port=0)
            threading.Thread(target=restore_server.serve_forever, daemon=True).start()
            driver.get(f"http://127.0.0.1:{restore_server.server_port}/" + ("app/" if combined else ""))
            wait.until(lambda _: element("show-restore").is_enabled())
            click("show-restore")
            element("restore-file").send_keys(str(backup_file))
            element("restore-passphrase").send_keys(backup_passphrase)
            element("restore-local-passphrase").send_keys(passphrase)
            element("restore-confirm").send_keys(passphrase)
            click("restore-acknowledge")
            click("restore-start")
            storage(1)
            assert text("own-key") == key
            wait.until(lambda _: element("read").is_enabled())
            content = "Disposable post from the restored browser"
            click("new-post")
            element("content").send_keys(content)
            click("publish")
            wait.until(lambda _: content in text("feed"))
            assert json.loads(text("feed"))["index"] == 2
            click("read")
            wait.until(lambda _: '"posts"' in text("feed"))
            assert [post["index"] for post in json.loads(text("feed"))["posts"]] == [2, 1, 0]
            log("PASS: downloaded backup verification, fresh-origin UI restore, and continued publication.")
            click("stop")
            wait.until(lambda _: text("status").startswith("Logged out."))
            click("browse-start")
            storage(1)
            assert not element("identity-panel").is_displayed()
            assert not element("author-tools").is_displayed()
            wait.until(lambda _: element("read").is_enabled())
            click("nav-following")
            element("key").send_keys(key)
            click("read")
            wait.until(lambda _: '"posts"' in text("feed"))
            assert [post["index"] for post in json.loads(text("feed"))["posts"]] == [2, 1, 0]
            assert not element("publish").is_enabled()
            click("follow")
            wait.until(lambda _: key in text("follow-list"))
            click("refresh-timeline")
            wait.until(lambda _: content in text("timeline") and element("refresh-timeline").is_enabled())
            assert len(element("timeline").find_elements(By.TAG_NAME, "article")) == 3
            assert text("unread-count").startswith("3 unread")
            click("mark-read")
            wait.until(lambda _: text("unread-count").startswith("0 unread"))
            for width in (390, 320, 1280):
                driver.set_window_size(width, 900)
                assert driver.execute_script("return document.documentElement.scrollWidth <= innerWidth")
            guest_url = driver.current_url.split("#")[0].split("?")[0]
            click("stop-reader")
            wait.until(lambda _: text("status") == "Reader stopped.")
            driver.get(guest_url + "?feed=" + quote(key, safe=""))
            wait.until(lambda _: '"posts"' in text("feed"))
            assert not element("identity-panel").is_displayed()
            assert not element("author-tools").is_displayed()
            assert not element("publish").is_enabled()
            assert [post["index"] for post in json.loads(text("feed"))["posts"]] == [2, 1, 0]
            click("nav-home")
            assert text("unread-count").startswith("0 unread")
            log("PASS: shared links open a guest, preserve cached reads and unread markers, and do not unlock an author.")
            click("stop-reader")
            wait.until(lambda _: text("status") == "Reader stopped.")
            driver.get(guest_url + "?feed=" + quote(key, safe="") + "&feed=" + quote(key, safe=""))
            wait.until(lambda _: text("status").startswith("Invalid shared feed link:"))
            assert not element("session").is_displayed()
            assert element("unlock-start").is_enabled()
            driver.get(guest_url)
            wait.until(lambda _: element("browse-start").is_enabled())
            click("browse-start")
            storage(3)
            click("nav-following")
            assert key in text("follow-list")
            click("nav-home")
            assert content in text("timeline")
            click("stop-reader")
            wait.until(lambda _: text("status") == "Reader stopped.")
            element("unlock-passphrase").send_keys(passphrase)
            click("unlock-start")
            storage(2)
            assert text("own-key") == key
            log("PASS: guest reads with a locked local author, then unlock preserves the same identity.")
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
        if restore_server:
            restore_server.shutdown()
            restore_server.server_close()
        log(f"Artifacts: {artifacts}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Opt-in browser/network check using Selenium Python.")
    parser.add_argument("--storage-only", action="store_true")
    check(parser.parse_args().storage_only)
