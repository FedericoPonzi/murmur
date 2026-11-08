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
    origin = f"http://127.0.0.1:{server.server_port}/app/"
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
        click("remember-device")
        click("start")
        ready(1)
        key = text("own-key")
        draft = "Keep this encrypted draft through updates and browser restarts."
        element("content").send_keys(draft)
        WebDriverWait(driver, 30).until(lambda _: text("draft-status") == "Draft saved on this browser.")
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
        driver.quit()
        driver = None
        driver = launch()
        driver.get(origin)
        ready(3)
        assert text("storage") == "3" and text("own-key") == key
        assert element("content").get_attribute("value") == draft
        click("stop")
        WebDriverWait(driver, 30).until(lambda _: text("status").startswith("Logged out."))
        driver.refresh()
        WebDriverWait(driver, 30).until(lambda _: element("unlock-start").is_enabled())
        assert not element("session").is_displayed()
        assert not element("resume-session").is_displayed()
        element("unlock-passphrase").send_keys(passphrase)
        click("unlock-start")
        ready(4)
        assert text("own-key") == key and element("content").get_attribute("value") == draft
        driver.save_screenshot(str(artifacts / "result.png"))
        click("stop")
        WebDriverWait(driver, 30).until(lambda _: text("status").startswith("Logged out."))
        log("PASS: tab conflict, live rollout, reload, browser restart, Logout revocation and manual recovery.")
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
