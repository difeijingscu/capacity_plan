"""给存量示例方案显式补 cache_hit_rate（engine-v2.1.0 新增字段）。

背景：缓存命中率是 engine-v2.1.0 才引入的。此前保存的方案 payload 里没有这个键，
新引擎的缺省值是 30%，而 P2-6 修复后「键不存在」被判定为 0（当时确实没有缓存折算），
这样老方案重算不会静默比历史快照少算输入工作量。

已存在的示例方案因此会从「当时按 30% 算出的 0.4333 P」变成「按 0 算的 0.5346 P」。
示例是演示资产，口径应当与「新建示例」一致（新建走 PlanInput 缺省值 = 30%），
所以这里把它显式写成 0.30，与 `/api/v1/demo` 新建出来的一致，避免
「存量示例 0、新建示例 30%」两份示例数字不同的局面。

用户自己的方案不动：它们要么已经显式写了值，要么本来就没有缓存折算。

默认只预演，`--apply` 才写入，写入前用 SQLite 在线备份。
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime
from decimal import Decimal
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.schemas import PlanInput  # noqa: E402
from app.store import Store  # noqa: E402

TARGET = Decimal(".30")


def backup(directory: Path) -> Path:
    backups = directory / "backups"
    backups.mkdir(parents=True, exist_ok=True)
    dest = backups / f"planner-{datetime.now():%Y%m%d-%H%M%S}.db"
    src = sqlite3.connect(str(directory / "planner.db"))
    dst = sqlite3.connect(str(dest))
    with dst:
        src.backup(dst)
    src.close()
    dst.close()
    return dest


def main() -> int:
    parser = argparse.ArgumentParser(description="给存量示例方案补 cache_hit_rate")
    parser.add_argument("--apply", action="store_true", help="写入数据库（默认只预演）")
    parser.add_argument("--data", default=None, help="数据目录，默认 <repo>/data")
    args = parser.parse_args()

    directory = Path(args.data) if args.data else Path(__file__).resolve().parents[1] / "data"
    store = Store(directory)

    targets = []
    for record in store.list("plan"):
        payload = record.get("payload") or {}
        if not payload.get("is_demo"):
            continue
        innovation = payload.get("innovation")
        if not isinstance(innovation, dict) or "cache_hit_rate" in innovation:
            continue
        # 只补能被当前 schema 正常接受的方案
        PlanInput.model_validate(payload)
        targets.append(record)

    if not targets:
        print("没有需要处理的示例方案。")
        return 0

    print(f"待处理示例方案 {len(targets)} 条：")
    for record in targets:
        plan = PlanInput.model_validate(record["payload"])
        print(f"  {record['id']} 修订 {record['revision']}  当前按缺键→{plan.innovation.cache_hit_rate}  将显式写 {TARGET}")

    if not args.apply:
        print("\n预演结束。加 --apply 才会写入。")
        return 0

    saved = backup(directory)
    print(f"\n已备份：{saved}")

    for record in targets:
        payload = dict(record["payload"])
        payload["innovation"] = {**payload["innovation"], "cache_hit_rate": str(TARGET)}
        validated = PlanInput.model_validate(payload).model_dump(mode="json")
        store.insert("plan_history", {"plan_id": record["id"], "revision_number": record["revision"],
                                      "payload": record["payload"]})
        store.replace(record["id"], {**record, "payload": validated, "status": "DRAFT",
                                     "previous_payload": record["payload"]}, record["record_revision"])
        print(f"  已更新 {record['id']}：修订 {record['revision']} → {record['revision'] + 1}")

    print("\n完成。回滚：停服务后把上面那份备份覆盖回 data/planner.db。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
