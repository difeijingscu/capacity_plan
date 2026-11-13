import json
from pathlib import Path

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


def seeds(name):
    path = Path(__file__).with_name(f"{name}.json")
    values = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
    return values + ([SYNTHETIC] if name == "models" else [])
