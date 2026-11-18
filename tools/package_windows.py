"""Build a relocatable Windows package from approved local assets.

用法（在仓库根目录）：
    .venv\\Scripts\\python.exe tools\\package_windows.py --all       # 取资产 + 暂存 + 压缩
    ... --fetch     仅下载 Python 嵌入式包与锁定依赖的 wheel
    ... --stage     仅生成 .release-build/stage/CapacitySandbox
    ... --archive   仅把已暂存目录压成 releases/算力沙盘-Windows-x64-<构建日期>.zip

包内容与 tools/verify_windows_package.py 的校验项对应：随包 Python、已构建网页、
后端源码、docs、启停脚本、部署说明（md + 由 md 生成的 html）、一致性数据库快照、
release-info.json、文件校验清单.json。
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import shutil
import sqlite3
import subprocess
import sys
import urllib.request
import zipfile
from contextlib import closing
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / ".release-build"
STAGE = BUILD / "stage" / "CapacitySandbox"
OUTPUT = ROOT / "releases"
PYTHON_VERSION = "3.13.8"
PYTHON_ZIP = BUILD / "assets" / f"python-{PYTHON_VERSION}-embed-amd64.zip"
PYTHON_URL = f"https://www.python.org/ftp/python/{PYTHON_VERSION}/python-{PYTHON_VERSION}-embed-amd64.zip"
PYTHON_MD5 = "3b57143a28118e1b58a536fe2f383fbb"
GUIDE = "部署"
STAGE_NAME = "CapacitySandbox"
EXCLUDED_PARTS = {"__pycache__", ".pytest_cache", "node_modules", "test-results",
                  "playwright-report", ".git", "screenshots", ".venv", "backups"}
EXCLUDED_NAMES = {"playwright-results.json", "backend-test-results.xml", "performance-results.json"}
# 只随包带源码与文档，开发工具脚本不进运行包
COPIED_TREES = ["backend", "frontend", "docs"]


def sha(path: Path) -> str:
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def application_version() -> str:
    return json.loads((ROOT / "frontend/package.json").read_text(encoding="utf-8"))["version"]


def engine_version() -> str:
    """从后端源码直接读引擎版本，避免打包脚本里写死版本号再次过期。"""
    sys.path.insert(0, str(ROOT / "backend"))
    try:
        from app.engine.calculator import ENGINE_VERSION
    finally:
        sys.path.pop(0)
    return ENGINE_VERSION


def commit_id() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True,
                              text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


def copy_tree(source: Path, dest: Path) -> None:
    for path in source.rglob("*"):
        relative = path.relative_to(source)
        if any(part in EXCLUDED_PARTS for part in relative.parts):
            continue
        if path.name in EXCLUDED_NAMES or path.suffix in {".pyc", ".tsbuildinfo"}:
            continue
        target = dest / relative
        if path.is_file():
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)


def render_guide(markdown: str) -> str:
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
        elif line.startswith("> "):
            result.append('<blockquote>' + inline(line[2:]) + "</blockquote>")
        elif match := re.match(r"^(#{1,3}) (.+)", line):
            level = len(match[1])
            result.append(f"<h{level}>{inline(match[2])}</h{level}>")
        elif re.match(r"^---+$", line):
            result.append("<hr>")
        elif re.match(r"^(?:- |\d+\. )", line):
            result.append('<p class="item">' + inline(line) + "</p>")
        elif line.strip():
            result.append("<p>" + inline(line) + "</p>")
        index += 1
    return """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>算力沙盘 · 部署说明</title>
<style>body{margin:0;background:#f3f6f1;color:#34473c;font:15px/1.9 "Microsoft YaHei",sans-serif}
main{max-width:1020px;margin:30px auto;padding:38px 48px;background:#fff;border:1px solid #dfe6db;border-radius:12px}
h1{font-size:28px;color:#164f3c}h2{margin-top:42px;padding-top:20px;border-top:1px solid #e2e9dc;color:#245e46;font-size:22px}h3{font-size:17px;margin-top:28px}
a{color:#176658}p{overflow-wrap:anywhere}.item{margin:8px 0}pre{background:#eef4e8;border:1px solid #dce7d5;padding:18px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
code{font-family:Consolas,monospace}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:12px;border:1px solid #e1e7dc;text-align:left;min-width:100px}th{background:#edf3e7}
blockquote{margin:14px 0;padding:10px 16px;background:#f0f6ea;border-left:4px solid #8fb98a;color:#3c5a43}hr{border:0;border-top:1px solid #e2e9dc;margin:28px 0}
@media(max-width:700px){main{margin:0;padding:22px;border-radius:0}h1{font-size:23px}}@media print{body{background:white}main{margin:0;border:0;padding:0;max-width:none}h2,h3{break-after:avoid}tr,pre{break-inside:avoid}}</style>
<main>""" + "\n".join(result) + "</main></html>"


def fetch_assets() -> None:
    """下载官方 Python 嵌入式包并核对 MD5；再取锁定依赖的 wheel。"""
    PYTHON_ZIP.parent.mkdir(parents=True, exist_ok=True)
    if not PYTHON_ZIP.exists() or hashlib.md5(PYTHON_ZIP.read_bytes()).hexdigest() != PYTHON_MD5:
        print(f"downloading {PYTHON_URL}", flush=True)
        urllib.request.urlretrieve(PYTHON_URL, PYTHON_ZIP)
        if hashlib.md5(PYTHON_ZIP.read_bytes()).hexdigest() != PYTHON_MD5:
            raise SystemExit("Python embeddable asset failed its published MD5 check.")
    wheels = BUILD / "wheels"
    wheels.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, "-m", "pip", "download", "-r", str(ROOT / "backend/requirements.lock.txt"),
                    "--dest", str(wheels), "--only-binary", ":all:",
                    "--python-version", PYTHON_VERSION.rsplit(".", 1)[0], "--implementation", "cp",
                    "--abi", "cp313", "--platform", "win_amd64"], check=True)
    print(json.dumps({"python_zip": str(PYTHON_ZIP), "wheels": len(list(wheels.glob("*.whl")))}, ensure_ascii=False))


def stage() -> None:
    if STAGE.exists():
        raise SystemExit("Staging directory already exists; use --all or remove .release-build/stage first.")
    if not PYTHON_ZIP.exists() or hashlib.md5(PYTHON_ZIP.read_bytes()).hexdigest() != PYTHON_MD5:
        raise SystemExit("Official Python asset is missing or differs from its published checksum.")
    if not (ROOT / "frontend/dist/index.html").exists():
        raise SystemExit("Build the frontend first (npm run build).")
    if not (ROOT / f"{GUIDE}.md").exists():
        raise SystemExit(f"Missing deployment guide: {GUIDE}.md")
    STAGE.mkdir(parents=True)
    for name in COPIED_TREES:
        copy_tree(ROOT / name, STAGE / name)
    for path in ROOT.iterdir():
        if path.is_file() and path.suffix in {".md", ".ps1", ".bat"}:
            shutil.copy2(path, STAGE / path.name)
    # PowerShell 5.1 对无 BOM 的 .ps1 按 ANSI 解码，中文会乱码；统一写回 UTF-8 BOM。
    for script in STAGE.glob("*.ps1"):
        script.write_text(script.read_text(encoding="utf-8-sig"), encoding="utf-8-sig")
    for script in STAGE.glob("*.bat"):
        content = script.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
        script.write_bytes(content.replace("\n", "\r\n").encode("utf-8"))

    guide_markdown = (ROOT / f"{GUIDE}.md").read_text(encoding="utf-8")
    (STAGE / f"{GUIDE}.html").write_text(render_guide(guide_markdown), encoding="utf-8")
    (ROOT / f"{GUIDE}.html").write_text(render_guide(guide_markdown), encoding="utf-8")

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
    with closing(sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)) as original, \
            closing(sqlite3.connect(data / "planner.db")) as backup:
        original.backup(backup)
        backup.execute("pragma wal_checkpoint(TRUNCATE)")
        if backup.execute("pragma integrity_check").fetchone()[0] != "ok":
            raise SystemExit("Database backup integrity check failed.")
        counts = dict(backup.execute("select kind,count(*) from records group by kind"))
        projects = [row[0] for row in backup.execute("select id from records where kind='project' order by id")]

    for leftover in list(data.glob("*")):
        if leftover.name != "planner.db":
            leftover.unlink()
    info = dict(application_version=application_version(), engine_version=engine_version(),
                platform="Windows x64", created_at=datetime.now(timezone.utc).isoformat(),
                source_commit=commit_id(), python_version=PYTHON_VERSION,
                python_source=PYTHON_URL, python_asset_sha256=sha(PYTHON_ZIP),
                guide=[f"{GUIDE}.md", f"{GUIDE}.html"],
                database_counts=counts, project_ids=projects,
                data_note="Consistent SQLite backup of committed data; no source-machine process state or API keys.")
    (STAGE / "release-info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"stage": str(STAGE), "application_version": info["application_version"],
                      "engine_version": info["engine_version"], "database_counts": counts}, ensure_ascii=False))


def archive() -> None:
    if not STAGE.exists():
        raise SystemExit("Nothing staged; run --stage first.")
    stamp = date.today().strftime("%Y%m%d")

    def included(path: Path) -> bool:
        relative = path.relative_to(STAGE)
        return (path.is_file() and path.name != "文件校验清单.json"
                and not any(part in EXCLUDED_PARTS for part in relative.parts)
                and path.name not in EXCLUDED_NAMES
                and path.suffix not in {".pyc", ".tsbuildinfo"}
                and not path.name.startswith(".env")
                and (relative.parts[0] != "data" or relative.as_posix() == "data/planner.db"))

    manifest = {p.relative_to(STAGE).as_posix(): sha(p) for p in sorted(STAGE.rglob("*")) if included(p)}
    (STAGE / "文件校验清单.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    OUTPUT.mkdir(exist_ok=True)
    target = OUTPUT / f"算力沙盘-Windows-x64-{stamp}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for path in sorted(STAGE.rglob("*")):
            if included(path) or path.name == "文件校验清单.json":
                bundle.write(path, f"{STAGE_NAME}/" + path.relative_to(STAGE).as_posix())
    digest = sha(target)
    (OUTPUT / (target.name + ".sha256")).write_text(f"{digest}  {target.name}\n", encoding="utf-8")
    print(json.dumps({"archive": str(target), "bytes": target.stat().st_size, "sha256": digest,
                      "files": len(manifest) + 1}, ensure_ascii=False))


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "--fetch":
        fetch_assets()
    elif mode == "--stage":
        stage()
    elif mode == "--archive":
        archive()
    elif mode == "--all":
        if STAGE.parent.exists():
            shutil.rmtree(STAGE.parent)
        fetch_assets()
        stage()
        archive()
    else:
        raise SystemExit("Usage: package_windows.py --all | --fetch | --stage | --archive")
