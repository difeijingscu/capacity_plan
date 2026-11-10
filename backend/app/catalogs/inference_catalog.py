"""推理算力评估的模板数据加载（模型结构 / 芯片规格 / 场景档位）。

数据来源：《推理算力评估工具 · 企业计算 张绍友 2609V8》内置表，
经 references/inference.original.html 逐项核对后落盘，口径见
docs/推理算力评估梳理-2609V8口径.md 第 2.1/2.3/2.4 节。

纯数据读取，不联网、不写盘，可在测试中直接替换。
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


@lru_cache(maxsize=1)
def load() -> dict:
    base = Path(__file__).resolve().parent
    return {key: json.loads((base / name).read_text(encoding="utf-8"))
            for key, name in _FILES.items()}


def models() -> list[dict]:
    return load()["models"]


def chips() -> list[dict]:
    return load()["chips"]


def scenes() -> list[dict]:
    return load()["scenes"]


def find_model(key: str) -> dict | None:
    return next((m for m in models() if m["key"] == key), None)
