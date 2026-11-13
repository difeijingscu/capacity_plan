"""业务池：逐场景调用推理引擎，输出需求算力与卡数。

这里的职责只有三件：
1. 把方案里的场景配置（Scenario.inference）翻成引擎入参；
2. 旧方案迁移：旧场景档 / 旧精度 / 旧芯片 key 的映射（全部打 MIGRATED_* 告警，不静默）；
   带 components 但没有 inference 的场景，按模型名模糊匹配 + 任务模板推一份等价配置；
3. 把引擎结果折算成业务池口径：等效算力（P，BF16 基准）、物理卡数、含余量卡数。

口径约定（v2.0.0，与推理评估页一致）：
- 场景层输出「恰好满足 SLA 的最小卡数」，不含任何余量；
- base_p（等效算力）= 卡数 × chip.bf16_tflops ÷ 1000（BF16 基准）；
- 余量只在池层乘一次（plan.headroom），planned_cards 按 headroom 放大 + 8 卡/台对齐；
- 卡数（物理台数）与算力（P）不同量纲，不能相加比较。
"""
from __future__ import annotations

import math
from decimal import Decimal

from app.engine import inference

D = lambda value: Decimal(str(value))

# 旧任务模板 → 新场景档（v2.0.0 29 档口径）
SCENE_BY_TEMPLATE = {
    "qa": "rag",
    "extract": "rag",
    "document": "gen_summary",
    "report": "think",
    "vision": "rag",
}

# 旧场景 key → 新场景 key（v2.0.0 迁移映射，全部打 MIGRATED_SCENE 告警）
SCENE_ALIASES = {
    "long_gen": "code",
    "kb_qa": "rag",
    "deep_think": "think",
    "long_summary": "gen_summary",
    "ultra_long": "long64k",
    "custom": "custom",
}

# 旧精度值 → 新精度档（引擎别名层也认旧值，这里显式迁移并告警）
PRECISION_ALIASES = {"fp16": "bf16", "fp8": "w8a8", "int8": "w8a8", "int4": "w4a8"}

# 旧芯片 key → 新 8 卡 key（v2.0.0 迁移映射）
CHIP_KEY_ALIASES = {
    "950(425T)": "950dt",
    "950(486T)": "950dt32",
    "950(547T)": "950dt36",
    "950(547T-96G)": "950dt36",  # 无精确对应，额外打 CHIP_SUBSTITUTED 告警
}
CHIP_SUBSTITUTED = {"950(547T-96G)"}

# 池层对齐粒度：8 卡/台（不同芯片不混机，与引擎 aggregate 同口径）
CARDS_PER_SERVER = 8

DEFAULT_SPEC = {
    "model_key": "qwen3_8b",
    "chip_key": "910c",
    "scene_key": "rag",
    "weight_precision": "auto",
    "kv_precision": "auto",
    "profile": "neutral",
    "prefix_hit": 0.0,
}

# 引擎告警里属于 SLA 未达标的类型（决定 latency_status）
_SLA_WARNING_TYPES = {"ttft", "tpotShort", "bandLimited"}


def _norm(value: str) -> str:
    return "".join(ch for ch in str(value).lower() if ch.isalnum())


def match_model_key(model_id: str | None, models: list[dict]) -> str | None:
    """把旧方案的模型标识匹配到推理模型清单：去符号后模糊比对。

    qwen3.6-35b-a3b → qwen33635ba3b，qwen36_35b_a3b 同样归一，因而可以命中。
    """
    if not model_id:
        return None
    target = _norm(model_id)
    if not target:
        return None
    for model in models:
        if _norm(model["key"]) == target:
            return model["key"]
        if _norm(model.get("label") or "") == target:
            return model["key"]
    for model in models:
        key = _norm(model["key"])
        if key and (key in target or target in key):
            return model["key"]
    return None


def _migrate_spec(spec: dict) -> list[str]:
    """就地迁移旧场景档 / 旧精度 / 旧芯片 key；返回告警码列表（不静默）。"""
    warnings: list[str] = []
    scene_key = str(spec.get("scene_key") or "")
    if scene_key in SCENE_ALIASES:
        spec["scene_key"] = SCENE_ALIASES[scene_key]
        warnings.append("MIGRATED_SCENE")
    precision = str(spec.get("weight_precision") or "")
    if precision in PRECISION_ALIASES:
        spec["weight_precision"] = PRECISION_ALIASES[precision]
        warnings.append("MIGRATED_PRECISION")
    chip_key = str(spec.get("chip_key") or "")
    if chip_key in CHIP_KEY_ALIASES:
        spec["chip_key"] = CHIP_KEY_ALIASES[chip_key]
        warnings.append("CHIP_SUBSTITUTED" if chip_key in CHIP_SUBSTITUTED else "CHIP_MIGRATED")
    return warnings


def model_needs_migration(model_id: str | None, key: str) -> bool:
    """旧 model_id 与匹配到的目录 key 是否不同（决定 MIGRATED_MODEL 告警）。"""
    return bool(model_id) and _norm(model_id) != _norm(key)


def resolve_spec(scenario, models: list[dict], chips: list[dict], scenes: list[dict],
                 defaults: dict | None = None) -> dict:
    """把场景翻成引擎入参，返回 {spec, origin, warnings}。

    origin: "configured" 用户配置 / "migrated" 由旧字段推导 / "default" 什么也没有。
    defaults：方案级全局硬件默认（business_defaults），只作用于未配置场景推导时的
    芯片与工程档位，不影响已配置场景。
    """
    warnings: list[str] = []
    configured = getattr(scenario, "inference", None)
    if configured is not None:
        spec = configured.to_engine()
        spec["scene_key"] = configured.scene_key
        warnings.extend(_migrate_spec(spec))
        return dict(spec=spec, origin="configured", warnings=warnings)

    spec = dict(DEFAULT_SPEC)
    if defaults:
        for key in ("chip_key", "profile"):
            if defaults.get(key):
                spec[key] = defaults[key]
    components = list(getattr(scenario, "components", []) or [])
    component = next((c for c in components if c.enabled), None) or (components[0] if components else None)
    if component is None:
        warnings.append("SCENARIO_NOT_CONFIGURED")
        return dict(spec=spec, origin="default", warnings=warnings)

    if component.task_type in ("cv", "unit", "native"):
        raise inference.InferenceIssue(
            "MODEL_RETIRED",
            "CV 检测、批量任务与原生存量已在 v2.0.0 移除；请改用大模型推理评估或重新登记模型")
    matched = match_model_key(component.model_id, models)
    if not component.model_id:
        # 旧清单里常见「只写了场景和人数、没填模型」。这里不按默认模型硬算，
        # 否则会给出一个看起来成立、实际换了模型的结果。
        raise inference.InferenceIssue(
            "MISSING_MODEL",
            "该场景没有指定模型，也没有推理配置；请在业务场景页选择模型与算力服务器")
    if not matched:
        # 模型名对不上推理清单时也不能落到默认模型上硬算：那会给出一个
        # 看起来成立、实际换了模型的结果。宁可报待补，让用户在页面上重选。
        raise inference.InferenceIssue(
            "MODEL_RETIRED",
            f"清单里的模型「{component.model_id}」不在 v2.0 模型列表中；"
            "请在业务场景页重新选择模型，或先登记为自定义模型")
    if _norm(matched) != _norm(component.model_id):
        warnings.append("MIGRATED_MODEL")
    spec["scene_key"] = SCENE_BY_TEMPLATE.get(component.template or "qa", "rag")
    spec["model_key"] = matched
    if component.online_users is not None:
        spec["concurrency"] = max(1.0, float(component.online_users))
    prompt = component.input_tokens
    output = None
    if component.answer_tokens is not None:
        output = float(component.answer_tokens) + float(component.reasoning_tokens or 0)
    if prompt is not None:
        spec["prompt_len"] = int(max(100, float(prompt)))
    if output is not None:
        spec["output_len"] = int(max(100, output))
    if component.ttft_seconds is not None:
        spec["ttft_target_ms"] = float(component.ttft_seconds) * 1000
    if component.output_tokens_per_second:
        spec["tpot_target_ms"] = 1000.0 / float(component.output_tokens_per_second)
    warnings.append("MIGRATED_INFERENCE")
    return dict(spec=spec, origin="migrated", warnings=warnings)


def estimate_scenario(scenario_id: str, name: str, spec: dict, models: list[dict],
                      chips: list[dict], scenes: list[dict]) -> dict:
    """单场景：跑引擎并把结果折成业务池口径（最小卡数，不含余量）。"""
    result = inference.estimate(spec, models, chips, scenes, spec.get("profile") or "neutral")
    chip = next(c for c in chips if c["key"] == result["chipKey"])
    bf16 = D(chip["bf16_tflops"])
    cards = int(result["cards"])
    base_p = D(cards) * bf16 / D(1000)
    servers = int(result["servers"])
    warning_types = [w["type"] for w in result["warnings"]]
    sla_passed = not any(t in _SLA_WARNING_TYPES for t in warning_types)
    return {
        "id": scenario_id,
        "name": name,
        "pool_id": "business",
        "model_id": result["modelKey"],
        "model_label": result["model_label"],
        "chip_key": result["chipKey"],
        "chip_label": result["chip_label"],
        "scene_key": result["scene_key"],
        "scene_name": result["scene_name"],
        "tier": result["tier"],
        "base_p": base_p,
        "effective_p": base_p,
        "cards": cards,
        "unit": CARDS_PER_SERVER,
        "servers": servers,
        "capacity_p": base_p,
        "bottleneck": result["bottleneck"],
        "bottleneck_label": result["bottleneckLabel"],
        "evidence_grade": "C",
        "latency_status": "PASSED" if sla_passed else "NOT_MET",
        "warnings": warning_types,
        "memory": {
            "status": "COMPLETE",
            "memory_gb": D(cards) * D(chip["memory_gb"]),
            "groups": [],
        },
        "trace": {
            "formula_id": "inference-abc-v2",
            "formula": "卡数 = max(显存 A, Prefill B, Decode C) → 奇数补偶（最小卡数，余量在池层）",
            "variables": {
                "model_key": result["modelKey"],
                "chip_key": result["chipKey"],
                "scene_key": result["scene_key"],
                "precision": result["precision"]["label"],
                "precision_key": result["precKey"],
                "tier": result["tier"],
                "bf16_tflops": float(bf16),
                "compute_tflops": float(result["precision"]["compute_tflops"]),
                "prompt_len": result["workload"]["prompt_len"],
                "output_len": result["workload"]["output_len"],
                "concurrency": result["workload"]["concurrency"],
                "ttft_target_ms": result["workload"]["ttft_target_ms"],
                "tpot_target_ms": result["workload"]["tpot_target_ms"],
                "cards": cards,
                "raw_cards": int(result["rawCards"]),
                "a": int(result["a"]), "b": int(result["b"]), "c": int(result["c"]),
                "servers": servers,
                "unit": CARDS_PER_SERVER,
                "bottleneck": result["bottleneck"],
                "bottleneck_label": result["bottleneckLabel"],
                "base_p": base_p,
                "effective_p": base_p,
                "ttft_pred_ms": result["B"].get("ttftPredMs"),
                "tpot_step_ms": result["C"].get("stepMs"),
                "decode_floor_ms": result["C"].get("floorMs"),
                "sla_passed": sla_passed,
                "warning_types": warning_types,
            },
            "detail": result,
        },
    }


def planned_cards(cards: int, unit: int, headroom: float) -> int:
    """含余量卡数：按 headroom 放大后对齐到整实例，且至少多一个实例。"""
    unit = max(1, unit)
    scaled = math.ceil(max(1, cards) * (1 + headroom) / unit) * unit
    return max(cards + unit, scaled)


def pool_summary(scenario_items: list[dict], missing: list[dict], headroom: float,
                 enabled_scenarios: int) -> dict:
    """业务池汇总：等效算力（P，BF16 基准）、含余量算力、物理卡数、含余量卡数。"""
    counted = [x for x in scenario_items if x.get("base_p") is not None]
    base = sum((x["base_p"] for x in counted), D(0))
    planned = base * (D(1) + D(headroom))
    cards = sum(x["cards"] for x in counted)
    cards_planned = sum(x["cards_planned"] for x in counted)
    capacity = sum((x["capacity_p"] for x in counted), D(0))
    capacity_planned = sum((x["capacity_planned"] for x in counted), D(0))
    completeness = ("DISABLED" if enabled_scenarios == 0 else
                    "PARTIAL" if missing and counted else
                    "BLOCKED" if missing else "COMPLETE")
    return {
        "id": "business",
        "base_p": base if counted or enabled_scenarios == 0 else None,
        "planned_p": planned if counted or enabled_scenarios == 0 else None,
        "effective_p": capacity,
        "cards": cards,
        "cards_planned": cards_planned,
        "servers": sum(x["servers"] for x in counted),
        "capacity_p": capacity,
        "capacity_planned_p": capacity_planned,
        "completeness": completeness,
        "evidence_grade": "C",
        "items": scenario_items,
        "missing_items": missing,
        "counted_tasks": len(counted),
        "total_tasks": len(counted) + len(missing),
        "memory": {
            "memory_gb": sum((x["memory"]["memory_gb"] for x in counted), D(0)),
            "status": "COMPLETE" if counted else "UNKNOWN",
            "groups": [],
        },
    }
