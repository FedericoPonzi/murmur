import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
import threading

from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "website"))
from build import APP_ASSETS, publish, release_id
from serve import create_preview_server


def check():
    artifacts = Path(tempfile.mkdtemp(prefix="murmur-upgrade-check-"))
    repository = Path(__file__).resolve().parent.parent
    site = artifacts / "site"
    shutil.copytree(repository / "website/output", site)
    server = create_preview_server(site, port=0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://localhost:{server.server_port}/app/"
    driver = None

    def log(message):
        with (artifacts / "run.log").open("a") as output:
            output.write(message + "\n")
        print(message, flush=True)

    def launch():
        options = webdriver.ChromeOptions()
        for argument in ("--headless=new", "--no-sandbox", "--disable-dev-shm-usage",
                         "--force-prefers-reduced-motion", f"--user-data-dir={artifacts / 'profile'}"):
            options.add_argument(argument)
        if os.environ.get("CHROME"):
            options.binary_location = os.environ["CHROME"]
        browser = webdriver.Chrome(service=Service(os.environ.get("CHROMEDRIVER")), options=options)
        browser.set_window_size(1280, 900)
        return browser

    def element(identity):
        return driver.find_element(By.ID, identity)

    def text(identity):
        return element(identity).get_attribute("textContent")

    def click(identity):
        view = driver.execute_script("return arguments[0].closest('section[id^=\"view-\"]')?.id", element(identity))
        if view in ("view-home", "view-profile", "view-following", "view-settings") and not element(view).is_displayed():
            click(view.replace("view-", "nav-"))
        driver.execute_script("arguments[0].scrollIntoView({block: 'center', behavior: 'instant'})", element(identity))
        element(identity).click()

    def ready(starts):
        WebDriverWait(driver, 60).until(lambda _: element("session").is_displayed() and text("storage") == str(starts))

    try:
        driver = launch()
        driver.get(origin)
        WebDriverWait(driver, 30).until(lambda _: element("start").is_enabled())
        passphrase = "disposable upgrade check passphrase"
        element("author-name").send_keys("Disposable upgrade author")
        for identity in ("passphrase", "confirm-passphrase"):
            element(identity).send_keys(passphrase)
        click("acknowledge")
        assert element("remember-device").is_selected()
        click("start")
        ready(1)
        key = text("own-key")
        draft = "Keep this encrypted draft through updates and browser restarts."
        element("content").send_keys(draft)
        WebDriverWait(driver, 30).until(lambda _: text("draft-status") == "Draft saved on this browser.")
        click("nav-profile")
        click("new-post")
        assert driver.execute_script("return document.activeElement === document.getElementById('content')")
        assert element("content").get_attribute("value") == draft
        for width in (1280, 760, 390, 320):
            driver.set_window_size(width, 900)
            click("new-post")
            assert driver.execute_script("""
                const byId = id => document.getElementById(id);
                const header = byId('app-header').getBoundingClientRect();
                const field = byId('content').getBoundingClientRect();
                const sidebar = byId('session-sidebar').getBoundingClientRect();
                const feed = byId('session-content').getBoundingClientRect();
                const nav = byId('app-navigation').getBoundingClientRect();
                return document.documentElement.scrollWidth <= innerWidth
                    && byId('session-sidebar').scrollWidth <= byId('session-sidebar').clientWidth
                    && header.height <= 64 && field.top >= header.bottom && field.bottom <= innerHeight
                    && (innerWidth > 760 ? sidebar.right <= feed.left : nav.bottom <= innerHeight && nav.top > field.bottom);
            """), f"Feed-first layout is unusable at {width}px."
            driver.save_screenshot(str(artifacts / f"home-{width}.png"))
        driver.set_window_size(1280, 900)
        original_tab = driver.current_window_handle
        driver.switch_to.new_window("tab")
        driver.get(origin)
        WebDriverWait(driver, 30).until(lambda _: "another tab" in text("auth-error"))
        assert element("resume-session").is_enabled()
        driver.close()
        driver.switch_to.window(original_tab)
        assert element("content").get_attribute("value") == draft

        page = (site / "app/index.html").read_text()
        previous = re.search(r'releases/([a-f0-9]{64})/app.mjs', page)[1]
        files = {name: (site / "app/releases" / previous / name).read_bytes() for name in APP_ASSETS}
        files["app.mjs"] += b"\n"
        version = release_id(files)
        staged = artifacts / "staged"
        for name, body in files.items():
            path = staged / "app/releases" / version / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
        (staged / "app/index.html").write_text(page.replace(previous, version))
        publish(staged, site)
        assert text("storage") == "1" and text("own-key") == key
        assert element("content").get_attribute("value") == draft
        driver.refresh()
        ready(2)
        assert text("storage") == "2" and text("own-key") == key
        assert element("content").get_attribute("value") == draft
        assert driver.execute_script("return [...document.scripts].some(s => s.src.includes(arguments[0]))", version)
        driver.find_element(By.CSS_SELECTOR, "#app-header .brand").click()
        WebDriverWait(driver, 30).until(lambda _: driver.find_element(By.CSS_SELECTOR, ".nav-cta").is_displayed())
        driver.find_element(By.CSS_SELECTOR, ".nav-cta").click()
        ready(3)
        assert driver.current_url == origin + "index.html"
        assert text("own-key") == key and element("content").get_attribute("value") == draft
        driver.quit()
        driver = None
        driver = launch()
        driver.get(origin + "index.html")
        ready(4)
        assert text("storage") == "4" and text("own-key") == key
        assert element("content").get_attribute("value") == draft
        click("stop")
        WebDriverWait(driver, 30).until(lambda _: text("status").startswith("Logged out."))
        driver.refresh()
        WebDriverWait(driver, 30).until(lambda _: element("unlock-start").is_enabled())
        assert not element("session").is_displayed()
        assert not element("resume-session").is_displayed()
        assert element("remember-device").is_selected()
        element("unlock-passphrase").send_keys(passphrase)
        click("remember-device")
        click("unlock-start")
        ready(5)
        assert text("own-key") == key and element("content").get_attribute("value") == draft
        driver.refresh()
        WebDriverWait(driver, 30).until(lambda _: element("unlock-start").is_enabled())
        assert not element("session").is_displayed()
        assert not element("resume-session").is_displayed()
        assert element("remember-device").is_selected()
        element("unlock-passphrase").send_keys(passphrase)
        click("unlock-start")
        ready(6)
        driver.refresh()
        ready(7)
        assert text("own-key") == key and element("content").get_attribute("value") == draft
        driver.save_screenshot(str(artifacts / "result.png"))
        click("stop")
        WebDriverWait(driver, 30).until(lambda _: text("status").startswith("Logged out."))
        log("PASS: default remembered access, explicit opt-out, tab conflict, live rollout, reload, homepage Open app, /app/index.html, browser restart, Logout revocation and manual recovery.")
    except Exception:
        if driver:
            log(f"UI: {text('status')}")
            driver.save_screenshot(str(artifacts / "failure.png"))
        raise
    finally:
        if driver:
            driver.quit()
        server.shutdown()
        server.server_close()
        log(f"Artifacts: {artifacts}")


if __name__ == "__main__":
    check()
