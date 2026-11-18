"""目录种子：模型基线库与参考卡都由业务场景页的目录派生。

口径（2026-11-17 起）：
- 「模型基线库」= `inference_models.json` 的 32 条模型（业务场景 / 创新 / 研发三页
  实际使用的那一份），参数量、层数、注意力结构与页面逐字段同源；
- 「参考卡与报价」= `inference_chips.json` 的 8 张昇腾卡，BF16 由页面 T 值折算为 P，
  参考单价取页面登记的 `ref_price_wan`（万元/卡）；
- 旧的 NVIDIA 卡目录与 Qwen/DeepSeek/YOLO 训练基线目录已停用，启动时按
  `SUPERSEDED` 清理，避免目录里同时存在两套互不相干的硬件与模型。

`SYNTHETIC` 是验收专用合成模型，不参与页面目录同步。
"""
from __future__ import annotations

from app.catalogs import inference_catalog

# 与业务场景页同步的日期，写进 checked_at，便于和页面数据对账
SYNC_DATE = "2026-11-17"
SYNC_SOURCE = "frontend/public/inference-eval.html"

SYNTHETIC = {
    "id": "synthetic-dense-8b",
    "display_name": "合成 8B · 验收专用",
    "publisher": "本项目",
    "revision": "synthetic-v1",
    "source_url": "docs/计算验收样例.json",
    "checked_at": "2026-10-20",
    "license": "Synthetic",
    "modalities": ["text"], "tasks": ["text"],
    "architecture": "Dense", "resident_parameters": 8000000000,
    "active_parameters_prefill": 8000000000, "active_parameters_decode": 8000000000,
    "context_limit": 32768,
    "cache": {"type": "standard_gqa", "layers": 36, "kv_heads": 8, "head_dim": 128},
    "eligible_training_methods": ["lora"],
    "evidence_grade": "C", "is_demo": True,
    "notes": "仅用于复核设计的合成算例，不代表真实模型性能。"
}

# 旧目录（NVIDIA 卡 / 训练基线模型）已由业务场景页目录取代，启动时删除这些种子记录。
# 只删种子记录，不动用户自己新增的模型与卡片；历史计算快照里已保存目录副本，不受影响。
SUPERSEDED = {
    "models": [
        "qwen3-8b", "qwen3.6-35b-a3b", "qwen3.6-27b", "deepseek-r1",
        "deepseek-v4-flash", "deepseek-v4.1-flash", "yolo26n", "yolo26s", "yolo26m",
    ],
    "cards": ["l40s", "h100-sxm", "h200-sxm"],
}

_PUBLISHERS = ("DeepSeek", "Qwen", "GLM", "Kimi", "MiniMax", "Llama", "Gemma")


def _publisher(label: str) -> str:
    base = label.split("（")[0]
    return next((name for name in _PUBLISHERS if base.startswith(name)), "未登记")


def _cache(model: dict) -> dict:
    """页面结构 → 目录 cache 字段：MLA 记低秩维，GQA/MHA 记 KV 头数。"""
    if model.get("latent_dim"):
        kind = "mla"
    elif model.get("kv_heads"):
        kind = "standard_gqa"
    else:
        kind = "unknown"
    return {
        "type": kind,
        "layers": model.get("layers"),
        "kv_heads": model.get("kv_heads"),
        "head_dim": model.get("head_dim"),
        "latent_dim": model.get("latent_dim"),
        "rope_dim": model.get("rope_dim"),
    }


def _model(model: dict, order: int) -> dict:
    """把业务场景页模型条目翻成模型基线库条目（结构字段直接透传）。"""
    total = float(model["total_b"])
    active = float(model["active_b"])
    arch = model.get("arch") or ("MoE" if model.get("experts") else "Dense")
    attn = model.get("attn_span") or None
    return {
        "id": model["key"],
        "order": order,
        "display_name": model.get("label") or model["key"],
        "publisher": _publisher(model.get("label") or ""),
        "revision": "page-sync-v1",
        "source_url": SYNC_SOURCE,
        "checked_at": SYNC_DATE,
        "license": "未登记",
        "modalities": ["text"],
        "tasks": ["text"],
        "architecture": arch,
        "resident_parameters": int(total * 1e9),
        "active_parameters_prefill": int(active * 1e9),
        "active_parameters_decode": int(active * 1e9),
        "context_limit": attn,
        "cache": _cache(model),
        # 结构字段：显存折算按页面同式推导 KV cache（MLA 走低秩维、GQA 走 KV 头数）
        "layers": model.get("layers"), "hid": model.get("hid"),
        "heads": model.get("heads"), "kv_heads": model.get("kv_heads"),
        "head_dim": model.get("head_dim"), "kv_head_dim": model.get("kv_head_dim"),
        "latent_dim": model.get("latent_dim"), "rope_dim": model.get("rope_dim"),
        "experts": model.get("experts"), "top_k": model.get("top_k"),
        "gqa_kv_fraction": model.get("gqa_kv_fraction"),
        "flop_per_unit": None,
        "input_size": None,
        "eligible_training_methods": ["lora", "qlora"],
        "evidence_grade": "C",
        "notes": (
            f"来自业务场景页模型清单（{model['key']}）：驻留 {total:g}B、激活 {active:g}B、{arch}；"
            "参数与结构字段与页面同源，未单独核验许可证与权重来源。"
        ),
    }


def _card(chip: dict, order: int) -> dict:
    """把业务场景页芯片条目翻成参考卡条目：BF16 折算 P，报价取登记参考价。"""
    bf16 = float(chip["bf16_tflops"])
    link = chip.get("link_gbs")
    return {
        "id": chip["key"],
        "order": order,
        "name": chip["label"],
        "dense_p16": round(bf16 / 1000, 5),
        "memory_gb": chip.get("memory_gb"),
        "source_url": SYNC_SOURCE,
        "checked_at": SYNC_DATE,
        "interconnect": f"HCCS/灵衢 {link} GB/s（页面登记单向带宽）" if link else "未登记",
        "ref_price_wan": chip.get("ref_price_wan"),
        "power_kw": chip.get("power_kw"),
        "family": chip.get("family"),
        "price_low": None,
        "price_high": None,
        "notes": (
            f"{chip.get('note') or ''} 数据与业务场景页算力服务器清单同源；"
            "参考单价为页面登记值，不是正式报价，费用附录仍以录入的报价为准。"
        ).strip(),
    }


def seeds(name: str) -> list[dict]:
    """模型基线库 / 参考卡种子，全部由业务场景页目录派生。

    order 保留页面清单顺序：存储层按登记时间倒序返回，前端据此还原为页面的
    910 → 950、由小到大的排列，合成验收模型排在最后。
    """
    if name == "models":
        return ([_model(m, i) for i, m in enumerate(inference_catalog.models())]
                + [{**SYNTHETIC, "order": 999}])
    if name == "cards":
        return [_card(c, i) for i, c in enumerate(inference_catalog.chips())]
    return []


def superseded(name: str) -> list[str]:
    return list(SUPERSEDED.get(name, []))
