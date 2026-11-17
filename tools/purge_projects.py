"""清理规划项目：保留一份，删除其余项目及其方案、计算快照、任务与历史。

界面只能「归档」，无法真正删除，重复点击「载入示例项目」或临时验证会不断积累
同名项目。本脚本按项目维度级联删除，默认只预演，加 --apply 才写入。

用法（在项目根目录执行）：

    python tools/purge_projects.py --keep-demo                # 预演：保留未归档示例
    python tools/purge_projects.py --keep-demo --apply        # 真正删除
    python tools/purge_projects.py --keep 192512bd --apply    # 保留指定项目（id 前缀）
    python tools/purge_projects.py --keep-demo --apply --vacuum

删除范围：project 记录，以及这些项目下的 plan、plan_history、calculation、
cost（按 calculation_run_id 关联）与 job（按 plan_id 关联）；顺带清掉 plan_id
已不存在的孤儿 history / job / calculation / cost。目录类数据（model / card /
price / inference-* / settings）不受影响。

--apply 时先做一次 SQLite 在线备份（写进 data/backups/），再在单个事务里删除。
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "data" / "planner.db"


def load_projects(con):
    rows = con.execute(
        "select id, body, created_at, updated_at from records where kind = 'project'"
    ).fetchall()
    projects = []
    for pid, body, created, updated in rows:
        data = json.loads(body)
        projects.append({
            "id": pid,
            "name": data.get("name", ""),
            "archived": bool(data.get("archived_at")),
            "created_at": created,
            "updated_at": updated,
        })
    return projects


def pick_keeper(projects, keep_id=None, keep_demo=False):
    if keep_id:
        hits = [p for p in projects if p["id"].startswith(keep_id)]
        if len(hits) != 1:
            raise SystemExit(f"id 前缀 {keep_id!r} 匹配到 {len(hits)} 个项目，请给更长的前缀")
        return hits[0]
    if keep_demo:
        demos = [p for p in projects if not p["archived"] and p["name"].startswith("示例")]
        if not demos:
            raise SystemExit("没有未归档的示例项目，请用 --keep 指定要保留的项目")
        demos.sort(key=lambda p: p["updated_at"], reverse=True)
        return demos[0]
    raise SystemExit("请指定 --keep 或 --keep-demo")


def collect_victims(con, project_ids):
    """返回待删除的 id 集合，按 kind 分组。"""
    victims = {kind: set() for kind in ("project", "plan", "plan_history", "calculation", "cost", "job")}
    victims["project"] = set(project_ids)

    plans = con.execute("select id, body from records where kind = 'plan'").fetchall()
    for pid, body in plans:
        if json.loads(body).get("project_id") in victims["project"]:
            victims["plan"].add(pid)

    for kind in ("plan_history", "calculation", "job"):
        for rid, body in con.execute(f"select id, body from records where kind = '{kind}'"):
            data = json.loads(body)
            if data.get("plan_id") in victims["plan"] or data.get("project_id") in victims["project"]:
                victims[kind].add(rid)

    for rid, body in con.execute("select id, body from records where kind = 'cost'"):
        if json.loads(body).get("calculation_run_id") in victims["calculation"]:
            victims["cost"].add(rid)

    return victims


def collect_orphans(con):
    """指向已不存在方案的 history / job / calculation / cost，界面上无处可见。"""
    plan_ids = {rid for (rid,) in con.execute("select id from records where kind = 'plan'")}
    calc_ids = {rid for (rid,) in con.execute("select id from records where kind = 'calculation'")}
    orphans = {kind: set() for kind in ("plan_history", "job", "calculation", "cost")}
    for kind in ("plan_history", "job"):
        for rid, body in con.execute(f"select id, body from records where kind = '{kind}'"):
            if json.loads(body).get("plan_id") not in plan_ids:
                orphans[kind].add(rid)
    for rid, body in con.execute("select id, body from records where kind = 'calculation'"):
        if json.loads(body).get("plan_id") not in plan_ids:
            orphans["calculation"].add(rid)
    for rid, body in con.execute("select id, body from records where kind = 'cost'"):
        if json.loads(body).get("calculation_run_id") not in calc_ids:
            orphans["cost"].add(rid)
    return orphans


def backup(con):
    folder = ROOT / "data" / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"planner-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    with sqlite3.connect(target) as dst:
        con.backup(dst)
    return target


def main():
    parser = argparse.ArgumentParser(description="删除除指定项目外的全部规划项目")
    parser.add_argument("--keep", help="保留的项目 id（可用前缀）")
    parser.add_argument("--keep-demo", action="store_true", help="保留最近更新的未归档示例项目")
    parser.add_argument("--apply", action="store_true", help="真正删除；不加则只预演")
    parser.add_argument("--vacuum", action="store_true", help="删除后 VACUUM 收缩数据库")
    parser.add_argument("--db", default=str(DB), help="数据库路径，默认 data/planner.db")
    args = parser.parse_args()

    con = sqlite3.connect(args.db, timeout=20)
    projects = load_projects(con)
    keeper = pick_keeper(projects, args.keep, args.keep_demo)
    others = [p for p in projects if p["id"] != keeper["id"]]
    victims = collect_victims(con, [p["id"] for p in others])
    orphans = collect_orphans(con)
    for kind, ids in orphans.items():
        victims[kind] |= ids

    print(f"保留：{keeper['name']}  {keeper['id']}  （{'已归档' if keeper['archived'] else '未归档'}）")
    print(f"删除：{len(others)} 个项目，其中已归档 {sum(1 for p in others if p['archived'])} 个")
    for kind in ("plan", "plan_history", "calculation", "cost", "job"):
        extra = f"（含孤儿 {len(orphans.get(kind, ()))} 条）" if orphans.get(kind) else ""
        print(f"  连带 {kind:14s} {len(victims[kind])} 条{extra}")
    names = {}
    for p in others:
        names.setdefault(p["name"], 0)
        names[p["name"]] += 1
    for name, count in sorted(names.items(), key=lambda x: -x[1]):
        print(f"  - {name} × {count}")

    if not args.apply:
        print("\n预演结束，未做修改。确认无误后加 --apply 执行。")
        return 0

    target = backup(con)
    print(f"\n已备份：{target}")
    with con:
        for kind, ids in victims.items():
            for rid in ids:
                con.execute("delete from records where id = ? and kind = ?", (rid, kind))
    remaining = con.execute("select count(*) from records where kind = 'project'").fetchone()[0]
    print(f"已删除。剩余项目 {remaining} 个。")
    if args.vacuum:
        con.execute("vacuum")
        print("已 VACUUM。")
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
