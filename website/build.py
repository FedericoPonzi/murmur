import argparse
import html
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import subprocess
import tempfile
from urllib.parse import unquote

# Changing this order would invalidate already-published release IDs.
RELEASE_V1_ORDER = ("app.mjs", "worker.mjs", "feeds.mjs", "device-session.mjs",
                    "pkg/murmur_browser.js", "pkg/murmur_browser_bg.wasm", "style.css")
APP_ASSETS = RELEASE_V1_ORDER


def release_id(files):
    digest = hashlib.sha256()
    for name in (*RELEASE_V1_ORDER, *sorted(set(files) - set(RELEASE_V1_ORDER))):
        if name not in files:
            continue
        body = files[name]
        digest.update(name.encode() + b"\0" + len(body).to_bytes(8, "big") + body)
    return digest.hexdigest()


def validate_release(directory):
    paths = list(directory.rglob("*"))
    if directory.is_symlink() or any(path.is_symlink() for path in paths):
        raise ValueError("Release assets must not contain symlinks.")
    files = {path.relative_to(directory).as_posix(): path.read_bytes() for path in paths if path.is_file()}
    required = {"app.mjs", "worker.mjs", "pkg/murmur_browser.js", "pkg/murmur_browser_bg.wasm", "style.css"}
    if not required <= files.keys() or any(Path(name).suffix not in {".mjs", ".js", ".wasm", ".css", ".svg"} for name in files):
        raise ValueError("Release assets are missing or unexpected.")
    if directory.name != release_id(files):
        raise ValueError("Release assets do not match their immutable version.")
    return files.keys()


def publish(source, output):
    if output.is_symlink() or any(path.is_symlink() for path in output.rglob("*")):
        raise ValueError("Site output must not contain symlinks.")
    releases = output / "app/releases"
    if releases.exists():
        for directory in releases.iterdir():
            validate_release(directory)
    source_releases = source / "app/releases"
    if source_releases.exists():
        releases.mkdir(parents=True, exist_ok=True)
        for directory in source_releases.iterdir():
            validate_release(directory)
            target = releases / directory.name
            if target.exists():
                continue
            with tempfile.TemporaryDirectory(prefix=".murmur-release-", dir=releases.parent) as temporary:
                complete = Path(temporary) / directory.name
                shutil.copytree(directory, complete)
                validate_release(complete)
                os.replace(complete, target)
    paths = [path for path in source.rglob("*") if path.is_file() and not path.is_relative_to(source_releases)]
    # Keep entrypoints on the previous release until every new asset is available.
    paths.sort(key=lambda path: (path.relative_to(source).as_posix() == "app/index.html",
                                 path.suffix == ".html"))
    for path in paths:
        target = output / path.relative_to(source)
        if target.is_file() and target.read_bytes() == path.read_bytes():
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".murmur-", delete=False) as temporary:
            staging = Path(temporary.name)
        try:
            shutil.copyfile(path, staging)
            staging.chmod(0o644)
            os.replace(staging, target)
        finally:
            staging.unlink(missing_ok=True)


def build(repository, with_app=False):
    website, browser = repository / "website", repository / "browser"
    generator = os.environ.get("GENERETO", "genereto")
    if with_app and not all((browser / "pkg" / name).is_file() for name in (
        "murmur_browser.js", "murmur_browser_bg.wasm",
    )):
        raise ValueError("WASM bindings missing in browser/pkg; build murmur-browser and run wasm-bindgen first.")
    if subprocess.check_output([generator, "--version"], text=True).strip() != "genereto 0.4.4":
        raise ValueError("Use Genereto 0.4.4 to build this site.")
    destinations = {
        website / "content" / f"{name}.md": destination
        for name, destination in (
            ("index", "index.html"), ("participate", "participate.html"),
            ("platforms", "platforms.html"), ("limitations", "limitations.html"),
            ("app", "app/index.html"), ("documentation", "docs/index.html"),
        )
    }
    destinations[repository / "README.md"] = "docs/quick-start.html"
    destinations.update((source, f"docs/{source.stem}.html") for source in sorted((repository / "docs").glob("*.md")))
    destinations[repository / "LICENSE"] = "LICENSE.txt"
    environment = {**os.environ, "RUST_LOG": "warn"}
    with tempfile.TemporaryDirectory(prefix="murmur-site-build-") as temporary:
        work = Path(temporary)
        (work / "content").mkdir()
        shutil.copytree(website / "templates", work / "templates")
        shutil.copy2(website / "config.yml", work / "config.yml")
        pages = []
        for source, destination in destinations.items():
            if source.suffix != ".md":
                continue
            filename = destination.replace("/", "-").removesuffix(".html") + ".md"
            markdown = source.read_text(encoding="utf-8")
            heading = re.search(r"^# (.+)$", markdown, re.M)
            if not heading:
                raise ValueError(f"Missing page heading: {source}")
            root = posixpath.relpath(".", posixpath.dirname(destination) or ".")
            (work / "content" / filename).write_text(
                f"---\ntitle: {json.dumps(heading[1])}\nroot: {json.dumps(root)}\n---\n{markdown}",
                encoding="utf-8",
            )
            pages.append((source, destination, filename))
        subprocess.run([generator, "--project-path", str(work)], check=True, env=environment)
        assembled = work / "assembled"
        assembled.mkdir()
        for source, destination, filename in pages:
            def rewrite(match):
                reference = html.unescape(match[1])
                path, suffix = re.match(r"([^?#]*)(.*)", reference).groups()
                linked = destinations.get((source.parent / unquote(path)).resolve())
                if linked is None:
                    return match[0]
                target = posixpath.relpath(linked, posixpath.dirname(destination) or ".") + suffix
                return f'href="{html.escape(target, quote=True)}"'

            page = (work / "output" / filename.replace(".md", ".html")).read_text(encoding="utf-8")
            target = assembled / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(re.sub(r'href="([^"]+)"', rewrite, page), encoding="utf-8")
        shutil.copy2(repository / "LICENSE", assembled / "LICENSE.txt")
        for asset in ("style.css", "favicon.svg"):
            shutil.copy2(browser / asset, assembled / asset)
        if with_app:
            files = {name: (browser / name).read_bytes() for name in APP_ASSETS}
            files["style.css"] = files["style.css"].replace(b'url("./favicon.svg")', b'url("../../../favicon.svg")')
            version = release_id(files)
            for name, body in files.items():
                target = assembled / "app/releases" / version / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(body)
            probe = (browser / "index.html").read_text(encoding="utf-8")
            if "<!-- site_header -->" not in probe or 'href="./style.css"' not in probe:
                raise ValueError("Browser probe is missing its site header or stylesheet marker.")
            header = (website / "templates/main/header.html").read_text(encoding="utf-8")
            probe = probe.replace("<!-- site_header -->", header.replace("$GENERETO['root']", ".."))
            (assembled / "app/index.html").write_text(
                probe.replace('href="./style.css"', f'href="./releases/{version}/style.css"')
                     .replace('src="./app.mjs"', f'src="./releases/{version}/app.mjs"')
                     .replace('href="./favicon.svg"', 'href="../favicon.svg"'), encoding="utf-8",
            )
            for asset in ("worker.mjs", "app.mjs", "feeds.mjs", "device-session.mjs"):
                shutil.copy2(browser / asset, assembled / "app" / asset)
            (assembled / "app/pkg").mkdir()
            for asset in ("murmur_browser.js", "murmur_browser_bg.wasm"):
                shutil.copy2(browser / "pkg" / asset, assembled / "app/pkg" / asset)
        (work / "output").rename(work / "flat")
        assembled.rename(work / "output")
        subprocess.run([
            generator, "verify", "--project-path", str(work), "assets", "cover-image",
            "date-mismatch", "empty-links", "internal-links", "unresolved-placeholders",
        ], check=True, env=environment)
        output = website / "output"
        publish(work / "output", output)
        print(f"Site ready: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build the Genereto site and optional browser probe.")
    parser.add_argument("--with-app", action="store_true")
    build(Path(__file__).resolve().parent.parent, parser.parse_args().with_app)
