"""Build a relocatable Windows package from approved local assets."""
from __future__ import annotations

import hashlib
import html
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import zipfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / ".release-build"
STAGE = BUILD / "stage" / "ComputePlanner"
OUTPUT = ROOT / "releases"
PYTHON_ZIP = BUILD / "assets" / "python-3.13.8-embed-amd64.zip"
PYTHON_URL = "https://www.python.org/ftp/python/3.13.8/python-3.13.8-embed-amd64.zip"
PYTHON_MD5 = "3b57143a28118e1b58a536fe2f383fbb"
GUIDE = "项目说明与Windows部署指南"
EXCLUDED = {"__pycache__", ".pytest_cache", "node_modules", "test-results", "playwright-report", ".git"}


def sha(path):
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def copy_tree(source, dest):
    for path in source.rglob("*"):
        relative = path.relative_to(source)
        if any(part in EXCLUDED for part in relative.parts) or path.suffix in {".pyc", ".tsbuildinfo"}:
            continue
        target = dest / relative
        if path.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def render_guide(markdown):
    def inline(value):
        value = html.escape(value)
        value = re.sub(r"\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2">\1</a>', value)
        value = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", value)
        return re.sub(r"`([^`]+)`", r"<code>\1</code>", value)

    lines, result, index = markdown.splitlines(), [], 0
    while index < len(lines):
        line = lines[index]
        if line.startswith("~~~"):
            code = []
            index += 1
            while index < len(lines) and not lines[index].startswith("~~~"):
                code.append(lines[index])
                index += 1
            result.append("<pre><code>" + html.escape("\n".join(code)) + "</code></pre>")
        elif line.startswith("|"):
            rows = []
            while index < len(lines) and lines[index].startswith("|"):
                cells = [cell.strip() for cell in lines[index].strip("|").split("|")]
                if not all(re.fullmatch(r":?-+:?", cell) for cell in cells):
                    tag = "th" if not rows else "td"
                    rows.append("<tr>" + "".join(f"<{tag}>{inline(c)}</{tag}>" for c in cells) + "</tr>")
                index += 1
            result.append('<div class="table-wrap"><table>' + "".join(rows) + "</table></div>")
            continue
        elif match := re.match(r"^(#{1,3}) (.+)", line):
            level = len(match[1])
            result.append(f"<h{level}>{inline(match[2])}</h{level}>")
        elif match := re.match(r"^(?:- |\d+\. )(.+)", line):
            result.append('<p class="item">' + inline(line) + "</p>")
        elif line.strip():
            result.append("<p>" + inline(line) + "</p>")
        index += 1
    return """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>算力规划智能体 · 项目说明与Windows部署指南</title>
<style>body{margin:0;background:#f3f6f1;color:#34473c;font:15px/1.9 "Microsoft YaHei",sans-serif}
main{max-width:1020px;margin:30px auto;padding:38px 48px;background:#fff;border:1px solid #dfe6db;border-radius:12px}
h1{font-size:28px;color:#164f3c}h2{margin-top:42px;padding-top:20px;border-top:1px solid #e2e9dc;color:#245e46;font-size:22px}h3{font-size:17px;margin-top:28px}
a{color:#176658}p{overflow-wrap:anywhere}.item{margin:8px 0}pre{background:#eef4e8;border:1px solid #dce7d5;padding:18px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:Consolas,monospace}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:12px;border:1px solid #e1e7dc;text-align:left;min-width:100px}th{background:#edf3e7}
@media(max-width:700px){main{margin:0;padding:22px;border-radius:0}h1{font-size:23px}}@media print{body{background:white}main{margin:0;border:0;padding:0;max-width:none}h2,h3{break-after:avoid}tr,pre{break-inside:avoid}}</style>
<main>""" + "\n".join(result) + "</main></html>"


def stage():
    if STAGE.exists():
        raise SystemExit("Staging directory already exists; choose a fresh build directory.")
    if not PYTHON_ZIP.exists() or hashlib.md5(PYTHON_ZIP.read_bytes()).hexdigest() != PYTHON_MD5:
        raise SystemExit("Official Python asset is missing or differs from its published checksum.")
    if not (ROOT / "frontend/dist/index.html").exists():
        raise SystemExit("Build the frontend first.")
    STAGE.mkdir(parents=True)
    for name in ["backend", "frontend", "docs", "tools"]:
        copy_tree(ROOT / name, STAGE / name)
    for path in ROOT.iterdir():
        if path.is_file() and (path.suffix in {".md", ".ps1", ".bat"} or path.name == ".gitignore"):
            shutil.copy2(path, STAGE / path.name)
    for script in STAGE.glob("*.ps1"):
        script.write_text(script.read_text(encoding="utf-8-sig"), encoding="utf-8-sig")
    for script in STAGE.glob("*.bat"):
        content = script.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
        script.write_bytes(content.replace("\n", "\r\n").encode("utf-8"))
    guide_html = render_guide((ROOT / f"{GUIDE}.md").read_text(encoding="utf-8"))
    (ROOT / f"{GUIDE}.html").write_text(guide_html, encoding="utf-8")
    (STAGE / f"{GUIDE}.html").write_text(guide_html, encoding="utf-8")

    runtime = STAGE / "runtime/python"
    runtime.mkdir(parents=True)
    with zipfile.ZipFile(PYTHON_ZIP) as archive:
        archive.extractall(runtime)
    (runtime / "python313._pth").write_text("python313.zip\n.\nLib/site-packages\nimport site\n", encoding="ascii")
    subprocess.run([sys.executable, "-m", "pip", "install", "--no-index", "--find-links", str(BUILD / "wheels"),
                    "--no-compile", "--no-warn-script-location", "--target", str(runtime / "Lib/site-packages"),
                    "-r", str(ROOT / "backend/requirements.lock.txt")], check=True)
    data = STAGE / "data"
    data.mkdir()
    source = ROOT / "data/planner.db"
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original, closing(sqlite3.connect(data / "planner.db")) as backup:
        original.backup(backup)
        backup.execute("pragma wal_checkpoint(TRUNCATE)")
        if backup.execute("pragma integrity_check").fetchone()[0] != "ok":
            raise SystemExit("Database backup integrity check failed.")
        counts = dict(backup.execute("select kind,count(*) from records group by kind"))
        projects = [row[0] for row in backup.execute("select id from records where kind='project' order by id")]
    info = dict(application_version="1.0.0", engine_version="engine-v1.0.0", platform="Windows x64",
                created_at=datetime.now(timezone.utc).isoformat(), python_version="3.13.8",
                python_source=PYTHON_URL, python_asset_sha256=sha(PYTHON_ZIP),
                database_counts=counts, project_ids=projects,
                data_note="Consistent SQLite backup of committed data; no source-machine process state or API keys.")
    (STAGE / "release-info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"stage": str(STAGE), "database_counts": counts}, ensure_ascii=False))


def archive():
    def included(path):
        relative = path.relative_to(STAGE)
        return (path.is_file() and path.name != "文件校验清单.json"
                and not any(part in EXCLUDED for part in relative.parts)
                and path.suffix not in {".pyc", ".tsbuildinfo"}
                and not path.name.startswith(".env")
                and (relative.parts[0] != "data" or relative.as_posix() == "data/planner.db"))
    manifest = {p.relative_to(STAGE).as_posix(): sha(p) for p in sorted(STAGE.rglob("*")) if included(p)}
    (STAGE / "文件校验清单.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    OUTPUT.mkdir(exist_ok=True)
    target = OUTPUT / "算力规划智能体-Windows-x64-20261021.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for path in sorted(STAGE.rglob("*")):
            if included(path) or path.name == "文件校验清单.json":
                bundle.write(path, "ComputePlanner/" + path.relative_to(STAGE).as_posix())
    (OUTPUT / (target.name + ".sha256")).write_text(sha(target) + "  " + target.name + "\n", encoding="utf-8")
    print(json.dumps({"archive": str(target), "bytes": target.stat().st_size, "sha256": sha(target), "files": len(manifest) + 1}, ensure_ascii=False))


if __name__ == "__main__":
    if sys.argv[1:] == ["--stage"]:
        stage()
    elif sys.argv[1:] == ["--archive"]:
        archive()
    else:
        raise SystemExit("Usage: package_windows.py --stage | --archive. Assets and locked wheels must be prepared first.")
