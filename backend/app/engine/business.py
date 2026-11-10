"""业务池：逐场景调用推理引擎，输出需求算力与卡数。

这里的职责只有三件：
1. 把方案里的场景配置（Scenario.inference）翻成引擎入参；
2. 旧方案迁移：带 components 但没有 inference 的场景，按模型名模糊匹配 + 任务模板
   推一份等价配置，并打 MIGRATED_INFERENCE 告警（不静默按默认值算）；
3. 把引擎结果折算成业务池口径：需求算力（P，BF16 基准）、物理卡数、含余量卡数、等效算力（P，BF16 基准）。

口径约定（与三池汇总一致，勿改）：
- 算力单位为 P / T（P = 10^15 FLOPS），基准是 BF16 稠密算力。需求按所选精度下的 TFLOPS 折回 BF16：demand_pf × cf / bf16_tflops。
- 卡数是物理台数，与算力（P）不同量纲。同一场景的卡数已经过引擎的三维取 max 与 SLA 回验。
- 余量只在池层乘一次（plan.headroom），场景层不再单独加 MARGIN_FACTOR，
  否则与推荐卡数口径重复计。
"""
from __future__ import annotations

import math
from decimal import Decimal

from app.engine import inference

D = lambda value: Decimal(str(value))

SCENE_BY_TEMPLATE = {
    "qa": "kb_qa",
    "extract": "kb_qa",
    "document": "long_summary",
    "report": "deep_think",
    "vision": "kb_qa",
}

DEFAULT_SPEC = {
    "model_key": "qwen3_8b",
    "chip_key": "910c",
    "scene_key": "kb_qa",
    "weight_precision": "",
    "kv_precision": "auto",
    "profile": "neutral",
    "prefix_hit": 0.0,
}


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


def resolve_spec(scenario, models: list[dict], chips: list[dict], scenes: list[dict]) -> dict:
    """把场景翻成引擎入参，返回 {spec, origin, warnings}。

    origin: "configured" 用户配置 / "migrated" 由旧字段推导 / "default" 什么也没有。
    """
    warnings: list[str] = []
    configured = getattr(scenario, "inference", None)
    if configured is not None:
        spec = configured.to_engine()
        spec["scene_key"] = configured.scene_key
        return dict(spec=spec, origin="configured", warnings=warnings)

    spec = dict(DEFAULT_SPEC)
    components = list(getattr(scenario, "components", []) or [])
    component = next((c for c in components if c.enabled), None) or (components[0] if components else None)
    if component is None:
        warnings.append("SCENARIO_NOT_CONFIGURED")
        return dict(spec=spec, origin="default", warnings=warnings)

    matched = match_model_key(component.model_id, models)
    if component.task_type in ("cv", "unit", "native"):
        raise inference.InferenceIssue(
            "UNSUPPORTED_PROFILE",
            "业务池本轮只覆盖大模型推理；视频检测、批量任务与原生存量请改用推理评估页或另行登记")
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
            "MODEL_NOT_MATCHED",
            f"清单里的模型「{component.model_id}」不在推理模型列表中；"
            "请在业务场景页重新选择模型，或先登记为自定义模型")
    spec["scene_key"] = SCENE_BY_TEMPLATE.get(component.template or "qa", "kb_qa")
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
    """单场景：跑引擎并把结果折成业务池口径。"""
    result = inference.estimate(spec, models, chips, scenes, spec.get("profile") or "neutral")
    chip = next(c for c in chips if c["key"] == result["chip_key"])
    bf16 = float(chip["bf16_tflops"]) or 1.0
    compute = float(result["precision"]["compute_tflops"]) or bf16
    demand_tflops = float(result["prefill"]["demand_tflops"])
    demand_p = D(demand_tflops) * D(compute) / D(bf16) / D(1000)
    cards = int(result["result"]["cards"])
    unit = max(1, int(result["topology"]["unit"]))
    capacity_p = D(cards) * D(bf16) / D(1000)
    return {
        "id": scenario_id,
        "name": name,
        "pool_id": "business",
        "model_id": result["model_key"],
        "model_label": result["model_label"],
        "chip_key": result["chip_key"],
        "chip_label": result["chip_label"],
        "scene_key": result["scene_key"],
        "scene_name": result["scene_name"],
        "base_p": demand_p,
        "effective_p": capacity_p,
        "cards": cards,
        "unit": unit,
        "servers": result["result"]["servers"],
        "capacity_p": capacity_p,
        "evidence_grade": "C",
        "latency_status": "PASSED" if result["sla"]["passed"] else "NOT_MET",
        "warnings": list(result["warnings"]),
        "memory": {
            "status": "COMPLETE",
            "memory_gb": D(cards) * D(chip["memory_gb"]),
            "groups": [],
        },
        "trace": {
            "formula_id": "inference-abc-v1",
            "formula": "卡数 = max(显存 A, Prefill B, Decode C) → 混部抬升 → SLA 回验加 DP",
            "variables": {
                "model_key": result["model_key"],
                "chip_key": result["chip_key"],
                "precision": result["precision"]["label"],
                "compute_tflops": compute,
                "bf16_tflops": bf16,
                "prompt_len": result["workload"]["prompt_len"],
                "output_len": result["workload"]["output_len"],
                "max_ctx": result["workload"]["max_ctx"],
                "concurrency": result["workload"]["concurrency"],
                "ttft_target_ms": result["workload"]["ttft_target_ms"],
                "tpot_target_ms": result["workload"]["tpot_target_ms"],
                "demand_tflops": demand_tflops,
                "demand_p": demand_p,
                "capacity_p": capacity_p,
                "cards": cards,
                "servers": result["result"]["servers"],
                "unit": unit,
                "topology": result["topology"]["text"],
                "ttft_ms": result["sla"]["ttft_ms"],
                "tpot_ms": result["sla"]["tpot_ms"],
                "sla_passed": result["sla"]["passed"],
                "bottleneck": result["result"]["bottleneck"],
                "dimensions": {
                    "memory": result["memory"]["n_memory"],
                    "prefill": result["prefill"]["n_pf"],
                    "decode": result["decode"]["n_dc"],
                },
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
    """业务池汇总：需求算力（P，BF16 基准）、含余量算力、物理卡数、含余量卡数。"""
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
