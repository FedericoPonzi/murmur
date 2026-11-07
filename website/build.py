import argparse
import html
import json
import os
from pathlib import Path
import posixpath
import re
import shutil
import subprocess
import tempfile
from urllib.parse import unquote


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
            probe = (browser / "index.html").read_text(encoding="utf-8")
            if "<!-- site_header -->" not in probe or 'href="./style.css"' not in probe:
                raise ValueError("Browser probe is missing its site header or stylesheet marker.")
            header = (website / "templates/main/header.html").read_text(encoding="utf-8")
            probe = probe.replace("<!-- site_header -->", header.replace("$GENERETO['root']", ".."))
            (assembled / "app/index.html").write_text(
                probe.replace('href="./style.css"', 'href="../style.css"')
                     .replace('href="./favicon.svg"', 'href="../favicon.svg"'), encoding="utf-8",
            )
            for asset in ("worker.mjs", "app.mjs", "feeds.mjs"):
                shutil.copy2(browser / asset, assembled / "app" / asset)
            shutil.copytree(browser / "pkg", assembled / "app/pkg")
        (work / "output").rename(work / "flat")
        assembled.rename(work / "output")
        subprocess.run([
            generator, "verify", "--project-path", str(work), "assets", "cover-image",
            "date-mismatch", "empty-links", "internal-links", "unresolved-placeholders",
        ], check=True, env=environment)
        output = website / "output"
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(work / "output", output)
        print(f"Site ready: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build the Genereto site and optional browser probe.")
    parser.add_argument("--with-app", action="store_true")
    build(Path(__file__).resolve().parent.parent, parser.parse_args().with_app)
