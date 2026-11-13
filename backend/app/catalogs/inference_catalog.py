"""推理算力评估的模板数据加载（模型结构 / 芯片规格 / 场景档位）。

v2.0.0 切换（docs/切换计划-推理评估逻辑统一-v2.0.md）：页面为唯一数据源。
- `chips()`：8 张昇腾芯片（910×3 / 950×5，含 family 分组、灵衢互联、板卡级功耗）；
- `scenes()`：29 档场景（7 分组 + 每档默认模型 default_model_key + hint）；
- `models()`：32 条模型清单（key 与数值与页面 MODELS 同源）。

数据来源：frontend/public/inference-eval.html（经 tools/gen_catalog_from_page.mjs 生成，
勿手工增删条目）。纯数据读取，不联网、不写盘，可在测试中直接替换。
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

_FILES = {
    "models": "inference_models.json",
    "chips": "inference_chips.json",
    "scenes": "inference_scenes.json",
}


def _load(files: dict[str, str]) -> dict:
    base = Path(__file__).resolve().parent
    return {key: json.loads((base / name).read_text(encoding="utf-8"))
            for key, name in files.items()}


@lru_cache(maxsize=1)
def load() -> dict:
    return _load(_FILES)


def models() -> list[dict]:
    return load()["models"]


def chips() -> list[dict]:
    """页面口径 8 卡目录（key/label/family/bf16_tflops/.../ref_price_wan/note）。"""
    return load()["chips"]


def scenes() -> list[dict]:
    """页面口径 29 档场景目录（含 group 分组与 default_model_key）。"""
    return load()["scenes"]


def find_model(key: str) -> dict | None:
    return next((m for m in models() if m["key"] == key), None)
