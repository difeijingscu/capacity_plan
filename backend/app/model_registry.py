"""模型基线库 → 三池页面模型清单的唯一出口。

口径（2026-11-17 起）：
- 「模型基线库」（store 里 kind=model 的记录）是业务场景、创新服务、开发测试三页与
  推理评估页共用的**唯一**模型数据源；
- `catalogs/inference_models.json` 只是基线库的种子文件，启动时写入记录后不再直接
  参与计算；增删模型改基线库即可，三页与推理评估同步生效；
- 基线记录用 `inference` 字段保存完整页面口径条目（total_b / layers / latent_dim 等），
  这里只做「记录 → 页面结构」还原，不重新推导任何数值，避免与引擎口径漂移；
- 参与规划的只有 `status=PUBLISHED` 且非演示（`is_demo`）的模型：合成验收模型只在
  测试与基线核验里用；`DRAFT` 未发布、`RETIRED` 已退役，都不进三池下拉；
- 缺少结构字段的记录（例如只登记了参数量、没有层数/头数的手工草稿）无法参与 A/B/C
  折算，直接跳过，不按默认档硬算。
"""
from __future__ import annotations

from typing import Iterable

# 页面口径必需的结构字段：缺任一项就无法算显存 / Prefill / Decode
REQUIRED = ("total_b", "active_b", "hid", "layers", "heads")


def page_model(record: dict) -> dict | None:
    """基线记录 → 页面模型条目；结构不全时返回 None。"""
    block = record.get("inference")
    if not isinstance(block, dict):
        return None
    if any(block.get(key) is None for key in REQUIRED):
        return None
    # 名称以基线库的 display_name 为准：设置页改名后三页立刻跟着变
    return {**block, "key": record["id"],
            "label": record.get("display_name") or block.get("label") or record["id"]}


def page_models(records: Iterable[dict]) -> list[dict]:
    """全部可用模型，按基线库登记顺序（order）返回。"""
    usable = [r for r in records
              if r.get("status") == "PUBLISHED" and not r.get("is_demo")]
    usable.sort(key=lambda r: (r.get("order") if r.get("order") is not None else 9999,
                               str(r.get("id"))))
    return [m for r in usable if (m := page_model(r))]


def find(records: Iterable[dict], key: str) -> dict | None:
    return next((m for m in page_models(records) if m["key"] == key), None)
