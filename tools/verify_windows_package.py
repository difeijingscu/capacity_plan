"""Relocation smoke test using only the shipped interpreter and Windows PowerShell."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import subprocess
import threading
import time
import urllib.request
import zipfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
ARCHIVE = ROOT / "releases/算力规划智能体-Windows-x64-20261021.zip"
DEST = ROOT / ".release-build" / ("迁移 验证-" + uuid4().hex[:8])
APP = DEST / "ComputePlanner"
REPORT = ROOT / "releases/迁移验证结果.json"
PORT = 8137
ENV = dict(os.environ)
for key in ["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV", "PLANNER_DATA_DIR", "PLANNER_AI_KEY"]:
    ENV.pop(key, None)
windows = Path(os.environ["SystemRoot"])
ENV["PATH"] = os.pathsep.join([str(windows / "System32"), str(windows), str(windows / "System32/WindowsPowerShell/v1.0")])
CHECKS = []


def mark(name, details=""):
    CHECKS.append(dict(check=name, result="PASS", details=details))
    print(name + ": PASS", flush=True)


def ps(script, *args, success=True):
    log = DEST / "powershell-validation.log"
    # A file avoids waiting for inherited pipe handles of background Windows services.
    with log.open("ab") as output:
        result = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(APP / script), *args],
                                cwd=APP, env=ENV, stdout=output, stderr=subprocess.STDOUT, timeout=50)
    if success and result.returncode:
        raise RuntimeError(log.read_text(encoding="utf-8", errors="replace"))
    return result


def api(path, body=None):
    request = urllib.request.Request(f"http://127.0.0.1:{PORT}/api/v1" + path,
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.load(response)


def batch_start():
    with (DEST / "powershell-validation.log").open("ab") as output:
        result = subprocess.run(["cmd.exe", "/d", "/c", "启动.bat", "-Port", str(PORT), "-NoBrowser"],
                                cwd=APP, env=ENV, stdout=output, stderr=subprocess.STDOUT, timeout=50)
    assert result.returncode == 0


def verify():
    if DEST.exists():
        raise RuntimeError("Verification directory exists; use a fresh destination.")
    with zipfile.ZipFile(ARCHIVE) as bundle:
        assert bundle.testzip() is None
        assert not any("/node_modules/" in name or "/.venv/" in name or "/__pycache__/" in name for name in bundle.namelist())
        bundle.extractall(DEST)
    manifest = json.loads((APP / "文件校验清单.json").read_text(encoding="utf-8"))
    for name, expected in manifest.items():
        assert hashlib.sha256((APP / name).read_bytes()).hexdigest() == expected, name
    mark("ZIP与全部文件SHA256校验", f"{len(manifest)} files")
    info = json.loads((APP / "release-info.json").read_text(encoding="utf-8"))
    with sqlite3.connect(APP / "data/planner.db") as connection:
        assert connection.execute("pragma integrity_check").fetchone()[0] == "ok"
        assert dict(connection.execute("select kind,count(*) from records group by kind")) == info["database_counts"]
    mark("数据库备份完整性与迁移前统计一致")
    ps("检查环境.ps1")
    ps("安装依赖.ps1", "-SkipBrowser")
    mark("不依赖系统Python与Node的环境检查及离线准备")

    class BusyHandler(BaseHTTPRequestHandler):
        def do_GET(self):
            content = b'{"status":"ok","engine_version":"engine-v1.0.0"}'
            self.send_response(200)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        def log_message(self, *args):
            pass
    busy = HTTPServer(("127.0.0.1", 0), BusyHandler)
    threading.Thread(target=busy.serve_forever, daemon=True).start()
    try:
        conflict = ps("启动.ps1", "-Port", str(busy.server_port), "-NoBrowser", success=False)
        assert conflict.returncode != 0
    finally:
        busy.shutdown()
        busy.server_close()
    mark("端口占用及不同目录服务不被误认")

    try:
        batch_start()
        mark("Windows批处理启动入口")
        assert api("/health")["status"] == "ok"
        state = json.loads((APP / "data/server.json").read_text(encoding="utf-8-sig"))
        assert Path(state["python_path"]) == APP / "runtime/python/python.exe"
        ps("启动.ps1", "-Port", str(PORT), "-NoBrowser")
        assert json.loads((APP / "data/server.json").read_text(encoding="utf-8-sig"))["process_id"] == state["process_id"]
        mark("中文空格路径启动与重复启动复用本目录服务")
        projects = api("/projects") + api("/projects?archived=true")
        assert sorted(p["id"] for p in projects) == info["project_ids"]
        assert sum(len(p["plans"]) for p in projects) == info["database_counts"]["plan"]
        assert sum(len(api("/projects/" + p["id"] + "/calculations")) for p in projects) == info["database_counts"]["calculation"]
        mark("已有项目方案与测算历史迁移", str(info["database_counts"]))
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/") as response:
            index = response.read().decode("utf-8")
        for asset in re.findall(r'(?:src|href)="(/assets/[^"]+)"', index):
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}" + asset) as response:
                assert response.status == 200 and len(response.read()) > 0
        mark("已构建网页与静态资源加载")
        demo = api("/demo", {})
        plan = demo["plan"]
        submitted = api("/plans/" + plan["id"] + "/calculate", {"plan_revision": plan["revision"]})
        for _ in range(100):
            if "run_id" in submitted:
                break
            job = api("/jobs/" + submitted["job_id"])
            if job["status"] == "SUCCEEDED":
                submitted = job["result"]
                break
            assert job["status"] not in {"FAILED", "INTERRUPTED"}
            time.sleep(.1)
        report = api("/calculations/" + submitted["run_id"])
        assert report["result"]["completeness"] == "COMPLETE"
        assert float(report["result"]["total_planned_p"]) > 0
        mark("三资源池示例的新增保存与真实测算")
        for scope in ["total", "business", "innovation", "development"]:
            explanation = api("/calculations/" + submitted["run_id"] + "/derivation?scope=" + scope)
            expected = report["result"]["total_planned_p"] if scope == "total" else next(p["planned_p"] for p in report["result"]["pools"] if p["id"] == scope)
            assert explanation["planned_p"] == expected and explanation["run_id"] == report["id"]
            assert explanation["steps"]
        mark("四张结果卡片的快照推导接口")
        ps("停止.ps1")
        ps("启动.ps1", "-Port", str(PORT), "-NoBrowser")
        assert any(p["id"] == demo["project"]["id"] for p in api("/projects"))
        assert api("/calculations/" + submitted["run_id"])["id"] == report["id"]
        mark("停止重启后的项目与计算记录持久化")
    finally:
        ps("停止.ps1")
    REPORT.write_text(json.dumps(dict(status="PASS", archive=str(ARCHIVE), interpreter="shipped Python 3.13.8 x64",
                                     tests=CHECKS, note="Verified on this Windows host in a fresh relocated directory, not on the user's second physical machine."),
                                 ensure_ascii=False, indent=2), encoding="utf-8")
    print(str(REPORT), flush=True)


if __name__ == "__main__":
    verify()
