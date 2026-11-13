"""Deterministic planning engine. No network, persistence, clocks or AI imports."""
from __future__ import annotations

from copy import deepcopy
from decimal import Decimal, ROUND_CEILING
from time import perf_counter

from app.schemas import PlanInput, Task

D = lambda value: Decimal(str(value))
ZERO = D(0)
PETA = D("1e15")
GIGA = D("1e9")
ENGINE_VERSION = "engine-v2.0.0"
REFERENCE = "BF16_DENSE_EQUIVALENT"
# QLoRA 权重量化元数据开销的全局默认（4-bit 权重 + 量化参数的工程经验值）。
# v2.0.0 起模型清单不再逐模型登记该字段，统一取此常量。
QLORA_METADATA_FRACTION = D("0.05")
TEMPLATES = {
    "qa": dict(requests_per_user_min=".5", input_tokens=2048, answer_tokens=512, reasoning_tokens=0, ttft_seconds=2, output_tokens_per_second=30),
    "extract": dict(requests_per_user_min=".5", input_tokens=1024, answer_tokens=128, reasoning_tokens=0, ttft_seconds=2, output_tokens_per_second=30),
    "document": dict(requests_per_user_min=".1", input_tokens=8192, answer_tokens=1024, reasoning_tokens=0, ttft_seconds=5, output_tokens_per_second=25),
    "report": dict(requests_per_user_min=".05", input_tokens=8192, answer_tokens=2048, reasoning_tokens=4096, ttft_seconds=10, output_tokens_per_second=25),
    "vision": dict(requests_per_user_min=".2", input_tokens=1024, answer_tokens=512, reasoning_tokens=0, ttft_seconds=3, output_tokens_per_second=25),
}
INTENSITIES = {
    "light": dict(train_data_tokens=1_000_000, epochs=1, train_deadline_hours=24, sequence_length=2048, train_slots=1),
    "standard": dict(train_data_tokens=5_000_000, epochs=2, train_deadline_hours=12, sequence_length=2048, train_slots=1),
    "high": dict(train_data_tokens=20_000_000, epochs=3, train_deadline_hours=8, sequence_length=4096, train_slots=2),
}


class CalculationIssue(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def clean(value):
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    return value


def ceil(value):
    return int(D(value).to_integral_value(rounding=ROUND_CEILING))


def scalar(model, key):
    value = model.get(key) if model else None
    if value is None:
        raise CalculationIssue("MISSING_BASELINE", f"模型缺少 {key} 基线")
    return D(value)


def resolved(task):
    values = task.model_dump()
    defaults = TEMPLATES[task.template]
    origins = deepcopy(task.provenance)
    for key, default in defaults.items():
        if values[key] is None:
            values[key] = D(default)
            origins[key] = {"origin": "template_default", "source_id": f"{task.template}-defaults-v1", "evidence_grade": "C"}
        else:
            origins[key] = task.provenance.get(key, {"origin": "user_input", "evidence_grade": "C"})
    values["parameter_origins"] = origins
    return values


def inference(rate, np, nd, li, lg, kp=D("1.1"), kd=D("1.1"), ep=D(".35"), ed=D(".15"), vision=ZERO):
    rate, np, nd, li, lg, kp, kd, ep, ed, vision = map(D, (rate, np, nd, li, lg, kp, kd, ep, ed, vision))
    fp = 2 * np * li * kp
    fd = 2 * nd * lg * kd
    return {
        "base_p": rate * ((fp + vision) / ep + fd / ed) / PETA,
        "effective_p": rate * (fp + vision + fd) / PETA,
        "prefill_flop_per_request": fp,
        "decode_flop_per_request": fd,
        "vision_flop_per_request": vision,
    }


def inference_model_view(m: dict) -> dict:
    """把 v2 推理模型清单（inference_models.json 条目）适配成计算器所需的基线字段。

    - 激活/驻留参数从模型结构推导：active_b × 1e9 / total_b × 1e9；
    - KV cache 每序列字节在 memory_for 里按页面 kvPerTokenGB 同式推导；
    - 微调方法一律支持 lora/qlora；QLoRA 量化元数据取全局默认常量。
    """
    experts = m.get("experts") or 0
    active = D(m["active_b"]) * D("1e9")
    return {
        "id": m["key"], "key": m["key"],
        "display_name": m.get("label") or m["key"],
        "architecture": m.get("arch") or ("MoE" if experts > 0 else "Dense"),
        "active_parameters_prefill": active,
        "active_parameters_decode": active,
        "active_parameters_train": active,
        "resident_parameters": D(m["total_b"]) * D("1e9"),
        "context_limit": D(m["attn_span"]) if m.get("attn_span") else None,
        # 结构字段：供 memory_for 按页面公式推导 KV cache
        "layers": m.get("layers"), "hid": m.get("hid"), "heads": m.get("heads"),
        "kv_heads": m.get("kv_heads"), "head_dim": m.get("head_dim"),
        "kv_head_dim": m.get("kv_head_dim"),
        "latent_dim": m.get("latent_dim"), "rope_dim": m.get("rope_dim"),
        "gqa_kv_fraction": m.get("gqa_kv_fraction"),
        "eligible_training_methods": ["lora", "qlora"],
        "qlora_metadata_fraction": QLORA_METADATA_FRACTION,
        "requires_proxy": False,
        "source_url": None, "revision": None,
    }


def memory_for(task, model, rate, li, lg, reserve):
    """Return unreserved components; reserve applied once at serving-group aggregation."""
    if rate == 0 and not task.prewarm:
        return dict(weight_gb=ZERO, cache_gb=ZERO, runtime_gb=ZERO, status="COMPLETE", allocated_sequences=0)
    resident = model.get("resident_parameters") if model else None
    if resident is None:
        return dict(weight_gb=None, cache_gb=None, runtime_gb=None, status="UNKNOWN")
    quant_extra = ZERO
    if task.weight_bits < 16:
        if task.quantization_metadata_fraction is None:
            raise CalculationIssue("UNSUPPORTED_PROFILE", "量化权重需要匹配基线或明确填写量化元数据比例")
        quant_extra = task.quantization_metadata_fraction
    weight = D(resident) * D(task.weight_bits) / 8 / GIGA * (1 + quant_extra)
    if model.get("weight_bytes_override") and task.weight_bits == 16:
        weight = D(model["weight_bytes_override"]) / GIGA
    weight *= task.replicas
    runtime = max(D(2), weight / task.replicas * D(".1")) * task.replicas
    profile = model.get("cache") or {}
    cfg = resolved(task)
    expected = rate * (cfg["ttft_seconds"] + lg / cfg["output_tokens_per_second"])
    sequences = max(1, ceil(expected)) if rate > 0 else 0
    status = "PROXY" if model.get("memory_status") == "PROXY" or task.weight_bits < 16 else "COMPLETE"
    if task.task_type == "cv":
        return dict(weight_gb=weight, cache_gb=ZERO, runtime_gb=runtime, status="PROXY", allocated_sequences=sequences)
    # v2.0.0：KV cache 每序列字节按模型结构推导（与推理评估页 kvPerTokenGB 同式）：
    # MLA → 层数 × (低秩维 + rope维) × KV字节；GQA/MHA → 2 × 层数 × KV头数 × 头维 × KV字节；
    # 混合注意力（gqa_kv_fraction < 1）再乘全注意力层占比，按代理口径标注。
    if model.get("layers") and (model.get("latent_dim") or model.get("kv_heads") or model.get("heads")):
        layers = D(model["layers"])
        if model.get("latent_dim"):
            bpt = layers * D(model["latent_dim"]) * D(model.get("rope_dim") or 64) * task.kv_bytes
        else:
            head_dim = model.get("kv_head_dim") or model.get("head_dim") or 0
            bpt = 2 * layers * D(model.get("kv_heads") or model.get("heads")) * D(head_dim) * task.kv_bytes
        status = "COMPLETE"
        frac = model.get("gqa_kv_fraction")
        if frac is not None and D(frac) < 1:
            bpt *= D(frac)
            status = "PROXY"
        cache = sequences * (li + lg) * bpt / GIGA
        return dict(weight_gb=weight, cache_gb=cache, runtime_gb=runtime, status=status, expected_concurrent=expected, allocated_sequences=sequences)
    if profile.get("type") in ("standard_gqa", "hybrid") and all(profile.get(k) is not None for k in ("layers", "kv_heads", "head_dim")):
        proxy_layers = D(profile["layers"]) + (D(profile.get("linear_layers",0)) if profile["type"] == "hybrid" else ZERO)
        bpt = 2 * proxy_layers * D(profile["kv_heads"]) * D(profile["head_dim"]) * task.kv_bytes
        cache = sequences * (li + lg) * bpt / GIGA
        if profile["type"] == "hybrid":
            cache += sequences * D(profile.get("linear_layers", 0)) * 4 * D(1024**2) / GIGA
            status = "PROXY"
        return dict(weight_gb=weight, cache_gb=cache, runtime_gb=runtime, status=status, expected_concurrent=expected, allocated_sequences=sequences)
    return dict(weight_gb=weight, cache_gb=None, runtime_gb=runtime, status="WEIGHT_LOWER_BOUND", allocated_sequences=sequences)


def compute_task(task, model, reserve=D(".15")):
    cfg = resolved(task)
    group = "|".join((task.model_id or task.id, task.serving_profile, str(task.weight_bits), str(task.kv_bytes), task.deployment_group, task.id if task.independent else "shared"))
    result = dict(id=task.id, model_id=task.model_id, task_type=task.task_type, group_key=group, evidence_grade="C", latency_status="UNVERIFIED", warnings=["HEURISTIC_EFFICIENCY"], native_capacity_by_precision={})
    rate = task.request_rate
    if rate is None and task.online_users is not None:
        rate = task.online_users * cfg["requests_per_user_min"] * task.calls_per_request / 60
        cfg["parameter_origins"]["request_rate"]={"origin":"derived","source_id":"online-load-v1","formula":"U × r × calls / 60","evidence_grade":"C"}
    li, lg = cfg["input_tokens"], cfg["answer_tokens"] + cfg["reasoning_tokens"]
    if task.task_type == "native":
        if task.native_capacity is None or not task.native_precision:
            raise CalculationIssue("MISSING_WORKLOAD", "请填写原生精度和容量")
        result["native_capacity_by_precision"] = {task.native_precision: task.native_capacity}
        if task.reference_mapping is None:
            result.update(base_p=None, effective_p=None, memory=dict(status="UNKNOWN"), warning_code="PRECISION_NOT_COMPARABLE")
            return result
        result.update(base_p=task.native_capacity * task.reference_mapping, effective_p=None, memory=dict(status="UNKNOWN"), trace={"formula_id": "native-mapping-v1", "mapping": task.reference_mapping, "source": task.baseline_source})
        if not task.baseline_source:
            raise CalculationIssue("MISSING_BASELINE", "精度映射需要来源")
        return result
    if task.task_type in ("cv", "unit"):
        raise CalculationIssue("MODEL_RETIRED", "CV 检测与批量单位任务已在 v2.0.0 移除；请改用大模型推理评估或原生精度映射")
    if task.task_type in ("text", "vlm"):
        if model is None:
            raise CalculationIssue("MISSING_BASELINE", "请选择可用模型")
        if rate is None:
            raise CalculationIssue("MISSING_WORKLOAD", "请填写同时在线人数或请求/秒")
        # v2.0.0：图文/多模态列已移除，vlm 与 text 同口径（输入 Token 已含视觉部分）
        limit = model.get("context_limit")
        if limit and li + lg > D(limit):
            raise CalculationIssue("CONTEXT_LIMIT_EXCEEDED", "请求总长度超过已确认上下文上限")
        if max(li, lg) > 32768 and not task.allow_proxy:
            raise CalculationIssue("MISSING_BASELINE", "长上下文需要专用基线或明确接受代理")
        kappa = D("1.2") if model.get("architecture") == "MoE" else D("1.1")
        kp, kd = task.kappa_prefill or kappa, task.kappa_decode or kappa
        np, nd = scalar(model, "active_parameters_prefill"), scalar(model, "active_parameters_decode")
        result.update(inference(rate, np, nd, li, lg, kp, kd, task.eta_prefill, task.eta_decode))
        variables = {**cfg, "request_rate": rate, "input_tokens_total": li, "generation_tokens_total": lg, "active_parameters_prefill": np, "active_parameters_decode": nd, "kappa_prefill": kp, "kappa_decode": kd}
        formula = "llm-phases-v1"
    else:
        raise CalculationIssue("UNSUPPORTED_PROFILE", "未知计算任务")
    result["memory"] = memory_for(task, model, rate, li, lg, reserve)
    result["trace"] = {
        "formula_id": formula, "version": ENGINE_VERSION, "variables": variables,
        "formula": "λ × ((2×Np×Li×κp + Fvision)/ηp + 2×Nd×Lg×κd/ηd) / 10^15" if formula == "llm-phases-v1" else "单位/秒 × FLOP/单位 / η / 10^15",
        "units": {"base_p": "P (BF16)", "effective_p": "P (BF16)", "memory": "GB (10^9 bytes)"},
        "model_source": model.get("source_url") if model else task.baseline_source,
        "model_revision": model.get("revision") if model else None,
        "memory_rule": "组内共享权重；每个负载档缓存分别向上取整；无缓存descriptor只提供下界",
    }
    return result


def summarize_memory(items, reserve):
    groups = {}
    for item in items:
        mem = item.get("memory", {})
        group = groups.setdefault(item.get("group_key", item["id"]), dict(model_id=item.get("model_id"), weight_gb=ZERO, cache_gb=ZERO, runtime_gb=ZERO, status="COMPLETE", item_ids=[]))
        group["item_ids"].append(item["id"])
        for key in ("weight_gb", "runtime_gb"):
            value = mem.get(key)
            if value is not None:
                group[key] = max(group[key], value)
        if mem.get("cache_gb") is not None:
            group["cache_gb"] += mem["cache_gb"]
        status = mem.get("status", "UNKNOWN")
        severity = {"COMPLETE": 0, "PROXY": 1, "WEIGHT_LOWER_BOUND": 2, "UNKNOWN": 3}
        if severity[status] > severity[group["status"]]:
            group["status"] = status
    for key, group in groups.items():
        group["id"] = key
        group["memory_gb"] = (group["weight_gb"] + group["cache_gb"] + group["runtime_gb"]) / (1 - reserve)
    total = sum((g["memory_gb"] for g in groups.values()), ZERO)
    status = "UNKNOWN" if any(g["status"] == "UNKNOWN" for g in groups.values()) else "WEIGHT_LOWER_BOUND" if any(g["status"] == "WEIGHT_LOWER_BOUND" for g in groups.values()) else "PROXY" if any(g["status"] == "PROXY" for g in groups.values()) else "COMPLETE"
    return dict(memory_gb=total, status=status, groups=list(groups.values()))


def cards_for_pool(pool, chip, headroom):
    """把池的需求算力（P，BF16 基准）折算成物理卡数：算力约束与显存约束取大。

    口径与业务池 `business.planned_cards` 对齐：
    - `cards` / `cards_planned` / `servers` 与业务池同名字段，前端可直接复用；
    - `cards_detail` 保留推导过程，供抽屉与审计；
    - 芯片缺失或规格不全时返回 None，宁可报待补也不按默认芯片硬算。

    chip: {key,label,bf16_tflops,memory_gb}，来自 catalogs/inference_chips.json。
    """
    if pool is None or pool.get("planned_p") is None or not chip:
        return None
    bf16 = D(chip.get("bf16_tflops") or 0)
    mem = D(chip.get("memory_gb") or 0)
    if bf16 <= 0 or mem <= 0:
        return None
    memory_gb = D((pool.get("memory") or {}).get("memory_gb") or 0)

    def _split(amount_p, mem_gb):
        compute = max(1, ceil(D(amount_p) * D(1000) / bf16))
        memory = max(1, ceil(mem_gb / mem)) if mem_gb > 0 else 0
        return compute, memory, max(compute, memory)

    compute, memory, cards = _split(pool["planned_p"], memory_gb)
    unit = 8
    planned_p = D(pool["planned_p"]) * (D(1) + D(headroom))
    c2, m2, _raw = _split(planned_p, memory_gb * (D(1) + D(headroom)))
    # 池层不对齐整机：池内可混机型，按整机对齐会让「1 卡」变成「9 卡」。
    # 只保证「按余量放大」且「至少多一张」——后者是冗余，不是扩容位。
    cards_planned = max(cards + 1, max(c2, m2))
    servers = max(1, ceil(cards / unit))
    servers_planned = max(1, ceil(cards_planned / unit))
    return dict(
        cards=cards, cards_planned=cards_planned,
        servers=servers, servers_planned=servers_planned,
        capacity_p=D(cards) * bf16 / D(1000),
        capacity_planned_p=D(cards_planned) * bf16 / D(1000),
        cards_detail=dict(
            chip_key=chip.get("key"), chip_label=chip.get("label"),
            bf16_tflops=bf16, memory_gb_per_card=mem, memory_gb=memory_gb,
            compute_cards=compute, memory_cards=memory,
            planned_compute_cards=c2, planned_memory_cards=m2,
            bottleneck="显存" if memory > compute else "算力" if compute > memory else "持平",
            cards_per_server=unit,
            rule="max(算力卡数, 显存卡数)；含余量卡数按余量放大且至少多一张，不按整机对齐",
        ),
    )


def _attach_cards(pool, chip, headroom):
    """把卡数结果平铺到池对象上，字段名与业务池一致（cards / cards_planned / servers）。

    在池上直接加字段而不是嵌套一层，是因为前端与费用附录都按扁平字段读；
    芯片缺失时显式写 None 并留 reason，避免「没有这个字段」和「算不出来」被混淆。
    """
    detail = cards_for_pool(pool, chip, headroom)
    if detail is None:
        pool.update(cards=None, cards_planned=None, servers=None,
                    servers_planned=None, capacity_planned_p=None,
                    cards_detail=dict(reason="未选择算力芯片或芯片规格不全，本池不出卡数"))
        return pool
    pool.update(detail)
    return pool


def pool_summary(pool_id, items, missing, plan, enabled=True, base_override=None, memory_override=None):
    computable = [x for x in items if x.get("base_p") is not None]
    native_missing = [dict(id=x["id"], code="PRECISION_NOT_COMPARABLE", message="原生精度无参考映射，未计入合计算力", pool_id=pool_id) for x in items if x.get("base_p") is None]
    missing = missing + native_missing
    status = "DISABLED" if not enabled else "PARTIAL" if missing and computable else "BLOCKED" if missing else "COMPLETE"
    base = (base_override if base_override is not None else sum((x["base_p"] for x in computable), ZERO)) if computable or not enabled or not missing else None
    return dict(id=pool_id, base_p=base, planned_p=base * (1 + plan.headroom) if base is not None else None, effective_p=sum((x.get("effective_p") or ZERO for x in computable), ZERO), completeness=status, evidence_grade="C", items=items, missing_items=missing, counted_tasks=len(computable), total_tasks=len(computable) + len(missing), memory=memory_override or summarize_memory(computable, plan.memory_reserve))


def calculate(plan: PlanInput, models: list[dict], sensitivity=False,
              inference_models: list[dict] | None = None,
              inference_chips: list[dict] | None = None,
              inference_scenes: list[dict] | None = None,
              custom_inference_models: list[dict] | None = None,
              custom_inference_chips: list[dict] | None = None):
    """三池汇总。业务池走推理评估页引擎（A/B/C 三维约束），创新与开发池沿用工作量口径。

    v2.0.0：创新/研发池的模型 lookup 切到推理模型清单（32 条 LLM + 自定义模型），
    `models`（旧训练模型库）仅保留给模型基线库页，三池不再消费。
    custom_inference_models / custom_inference_chips：store 里登记的自定义
    推理模型（kind=inference-model）与自定义算力卡（kind=inference-chip）。
    """
    from app.catalogs import inference_catalog
    from app.engine import business

    started = perf_counter()
    inf_models = inference_models if inference_models is not None else inference_catalog.models()
    inf_chips = list(inference_chips if inference_chips is not None else inference_catalog.chips())
    inf_chips += list(custom_inference_chips or [])
    inf_scenes = inference_scenes if inference_scenes is not None else inference_catalog.scenes()
    headroom = float(plan.headroom)
    all_inf_models = list(inf_models) + list(custom_inference_models or [])
    lookup = {m["key"]: inference_model_view(m) for m in all_inf_models}
    missing = []

    def find_model(model_id):
        """按新 key 直查，失败时按归一化匹配旧 model_id；返回 (model, 是否迁移)。"""
        if model_id and model_id in lookup:
            return lookup[model_id], False
        key = business.match_model_key(model_id, all_inf_models)
        if key and key in lookup:
            return lookup[key], business.model_needs_migration(model_id, key)
        return None, False

    def attempt(task, name, pool_id, target, issues, scenario_id=None):
        try:
            model, migrated = find_model(task.model_id)
            if model is None:
                raise CalculationIssue(
                    "MODEL_RETIRED",
                    f"模型「{task.model_id or task.id}」不在 v2.0 模型清单"
                    "（CV 与多模态已移除，请在页面上重新选择模型）")
            item = compute_task(task, model, plan.memory_reserve)
            if migrated:
                item["warnings"].append("MIGRATED_MODEL")
            item.update(name=name, pool_id=pool_id, scenario_id=scenario_id)
            if pool_id in ("innovation","development") and item.get("trace"):
                item["trace"]["variables"]["parameter_origins"]["request_rate"]={"origin":"derived","source_id":pool_id+"-v1","evidence_grade":"C"}
            target.append(item)
            return item
        except CalculationIssue as exc:
            issues.append(dict(id=task.id, name=name, pool_id=pool_id, scenario_id=scenario_id, code=exc.code, message=exc.message))
            return None

    business_items = []
    enabled_scenarios = 0
    for scenario in plan.scenarios:
        if not scenario.enabled:
            continue
        enabled_scenarios += 1
        try:
            resolved = business.resolve_spec(scenario, inf_models, inf_chips, inf_scenes,
                                             defaults=plan.business_defaults.model_dump())
            item = business.estimate_scenario(scenario.id, scenario.name, resolved["spec"],
                                              inf_models, inf_chips, inf_scenes)
        except business.inference.InferenceIssue as exc:
            missing.append(dict(id=scenario.id, name=scenario.name, pool_id="business",
                                code=exc.code, message=exc.message))
            continue
        per_card = item["capacity_p"] / max(1, item["cards"])
        item["cards_planned"] = business.planned_cards(item["cards"], item["unit"], headroom)
        item["capacity_planned"] = item["cards_planned"] * per_card
        item["inference_spec"] = resolved["spec"]
        item["inference_origin"] = resolved["origin"]
        item["warnings"] = resolved["warnings"] + item["warnings"]
        business_items.append(item)

    business_pool = business.pool_summary(business_items, missing, headroom, enabled_scenarios)
    scenario_summaries = []
    for item in business_items:
        scenario_summaries.append(dict(
            id=item["id"], name=item["name"], base_p=item["base_p"],
            planned_p=item["base_p"] * (D(1) + D(headroom)),
            cards=item["cards"], cards_planned=item["cards_planned"],
            chip_key=item["chip_key"], chip_label=item["chip_label"],
            model_key=item["model_id"], model_label=item["model_label"],
            scene_name=item["scene_name"], sla_passed=item["trace"]["variables"]["sla_passed"],
            completeness="PARTIAL" if item["warnings"] else "COMPLETE",
            component_count=1, missing_count=len([m for m in missing if m["id"] == item["id"]])))
    for gap in missing:
        if not any(s["id"] == gap["id"] for s in scenario_summaries):
            scenario_summaries.append(dict(id=gap["id"], name=gap.get("name", gap["id"]),
                                           base_p=None, planned_p=None, cards=None,
                                           cards_planned=None, completeness="BLOCKED",
                                           component_count=0, missing_count=1))
    business_pool["scenarios"] = sorted(scenario_summaries,
                                        key=lambda x: x["base_p"] or 0, reverse=True)

    innov, innov_missing = [], []
    config = plan.innovation
    monthly = None
    if config.enabled:
        if config.users is None or config.quota_per_user_month is None or not config.allocations:
            innov_missing.append(dict(id="innovation", name="创新服务", pool_id="innovation", code="MISSING_WORKLOAD", message="请填写人数、月额度并选择模型分配"))
        else:
            monthly = config.users * config.quota_per_user_month * config.usage_ratio
            seconds = config.service_days * config.service_hours_per_day * 3600
            for allocation in config.allocations:
                if allocation.share == 0:
                    continue
                count = monthly * allocation.share
                rate = count / seconds * config.peak_factor / allocation.request_total_tokens
                task = Task(id=f"innovation-{allocation.model_id}", task_type="text", model_id=allocation.model_id, request_rate=rate, input_tokens=allocation.request_total_tokens * allocation.input_fraction, answer_tokens=allocation.request_total_tokens * (1 - allocation.input_fraction), reasoning_tokens=ZERO, eta_prefill=config.eta_prefill, eta_decode=config.eta_decode, allow_proxy=True)
                found, _ = find_model(allocation.model_id)
                item = attempt(task, (found or {}).get("display_name", allocation.model_id), "innovation", innov, innov_missing)
                if item:
                    item["monthly_tokens"] = count
                    item["trace"]["quota"] = dict(monthly_total=monthly, model_share=allocation.share, allocated=count, service_seconds=seconds, peak_factor=config.peak_factor, input_tokens_per_second=count*allocation.input_fraction/seconds*config.peak_factor, output_tokens_per_second=count*(1-allocation.input_fraction)/seconds*config.peak_factor, reasoning_already_included=True)
    innovation_pool = pool_summary("innovation", innov, innov_missing, plan, config.enabled)
    innovation_pool["monthly_tokens"] = monthly
    _attach_cards(innovation_pool, next((c for c in inf_chips if c.get("key") == config.chip_key), None),
                  plan.headroom)

    dev, dev_missing = [], []
    dc = plan.development
    dev_base = None
    dev_memory = None
    dev_cfg = {k: getattr(dc, k) if getattr(dc, k) is not None else v for k, v in INTENSITIES[dc.intensity].items()}
    train_caps, train_mems = [], []
    if dc.enabled:
        if not dc.models:
            dev_missing.append(dict(id="development", name="开发测试", pool_id="development", code="MISSING_WORKLOAD", message="请选择需要支持的模型"))
        for entry in dc.models:
            model, _migrated = find_model(entry.model_id)
            label = (model or {}).get("display_name", entry.model_id)
            if model is None:
                dev_missing.append(dict(id=f"train-{entry.model_id}", name=label+"微调", pool_id="development",
                                        code="MODEL_RETIRED",
                                        message=f"模型「{entry.model_id}」不在 v2.0 模型清单（CV 与多模态已移除，请重新选择模型）"))
            elif entry.method not in model.get("eligible_training_methods", []):
                dev_missing.append(dict(id=f"train-{entry.model_id}", name=label+"微调", pool_id="development", code="UNSUPPORTED_PROFILE", message="该模型没有所选微调方法的可用基线"))
            else:
                try:
                    active = scalar(model, "active_parameters_train") if model.get("active_parameters_train") is not None else scalar(model, "active_parameters_decode")
                    ft = dc.train_k * active * D(dev_cfg["train_data_tokens"]) * D(dev_cfg["epochs"])
                    capacity = ft / (D(dev_cfg["train_deadline_hours"]) * 3600 * dc.train_eta) / PETA
                    train_caps.append(capacity)
                    resident = scalar(model, "resident_parameters")
                    base_weight = resident * (D(".5") if entry.method == "qlora" else 2) / GIGA
                    if entry.method == "qlora":
                        # Only allow a catalog-provided quantization metadata budget.
                        if model.get("qlora_metadata_fraction") is None:
                            raise CalculationIssue("MISSING_BASELINE", "QLoRA缺量化元数据基线")
                        base_weight *= 1 + D(model["qlora_metadata_fraction"])
                    adapter = resident * dc.adapter_fraction * 16 / GIGA
                    activation = max(D(8), base_weight * D(".2")) * D(dev_cfg["sequence_length"]) / 2048 * dc.micro_batch
                    workspace = max(D(2), base_weight * D(".1"))
                    mem = (base_weight + adapter + activation + workspace) / (1 - plan.memory_reserve)
                    train_mems.append(mem)
                    dev.append(dict(id=f"train-{entry.model_id}", model_id=entry.model_id, name=label+" · "+entry.method.upper(), pool_id="development", base_p=capacity, effective_p=ft/(D(dev_cfg["train_deadline_hours"])*3600)/PETA, memory=dict(status="PROXY", memory_gb=mem), evidence_grade="C", trace=dict(formula_id="lora-work-v1", formula="k × N_active × D × E / (H × 3600 × ηtrain × 10^15)", variables={**dev_cfg, "active_parameters_train": active, "train_k": dc.train_k, "train_eta": dc.train_eta, "flop_total": ft, "base_weight_gb": base_weight, "adapter_state_gb": adapter, "activation_gb": activation, "workspace_gb": workspace}, model_source=model.get("source_url"))))
                except CalculationIssue as exc:
                    if train_caps and len(train_caps) > len(train_mems):
                        train_caps.pop()
                    dev_missing.append(dict(id=f"train-{entry.model_id}", name=label+"微调", pool_id="development", code=exc.code, message=exc.message))
        if train_caps:
            slots = dev_cfg["train_slots"]
            lane = max(train_mems, default=ZERO) * slots
            dev_base = max(train_caps) * slots
            dev_memory = dict(memory_gb=lane, status="PROXY" if not dev_missing else "WEIGHT_LOWER_BOUND", groups=[], train_slot_gb=lane)
    development_pool = pool_summary("development", dev, dev_missing, plan, dc.enabled, dev_base, dev_memory)
    development_pool["intensity_parameters"] = dev_cfg
    development_pool["aggregation_rule"] = "微调槽位数 × 最大单任务容量（只含微调，不含评测）"
    _attach_cards(development_pool, next((c for c in inf_chips if c.get("key") == dc.chip_key), None),
                  plan.headroom)

    pools = [business_pool, innovation_pool, development_pool]
    missing_items = [m for p in pools for m in p["missing_items"]]
    counted = sum(p["counted_tasks"] for p in pools)
    total = sum((p["base_p"] or ZERO for p in pools), ZERO)
    complete = "PARTIAL" if missing_items and counted else "BLOCKED" if missing_items or counted == 0 else "COMPLETE"
    report = dict(engine_version=ENGINE_VERSION, defaults_version=plan.defaults_version, reference_precision=REFERENCE, completeness=complete, evidence_grade="C", latency_status="UNVERIFIED", total_base_p=total if counted else None, total_planned_p=total*(1+plan.headroom) if counted else None, headroom=plan.headroom, pools=pools, missing_items=missing_items, counted_tasks=counted, total_tasks=counted+len(missing_items), is_demo=plan.is_demo, warnings=["HEURISTIC_EFFICIENCY", "SLA_NOT_BENCHMARKED"], duration_ms=D(str((perf_counter()-started)*1000)))
    if sensitivity and counted:
        variations = []
        scene_default = {s["key"]: s for s in inf_scenes}
        for label, scale, eta_scale, train_k in (("较低负载/较高效率",D(".8"),D("1.25"),D(3)),("较高负载/较低效率",D("1.2"),D(".75"),D(6))):
            alternate = plan.model_copy(deep=True)
            for s in alternate.scenarios:
                spec = s.inference
                if spec is not None:
                    # 业务池改按并发缩放：模型与芯片不动，需求侧变
                    base = float(spec.concurrency or 0) or float(
                        (scene_default.get(spec.scene_key) or {}).get("concurrency") or 1)
                    spec.concurrency = D(str(max(1.0, base * float(scale))))
                for t in s.components:
                    for key in ("online_users","request_rate","streams","images_per_second","units_per_second","total_units"):
                        if getattr(t,key) is not None:
                            setattr(t,key,getattr(t,key)*scale)
                    t.eta_prefill=min(D(1),t.eta_prefill*eta_scale)
                    t.eta_decode=min(D(1),t.eta_decode*eta_scale)
                    t.eta_unit=min(D(1),t.eta_unit*eta_scale)
            if alternate.innovation.users is not None:
                alternate.innovation.users*=scale
            alternate.innovation.eta_prefill=min(D(1),alternate.innovation.eta_prefill*eta_scale)
            alternate.innovation.eta_decode=min(D(1),alternate.innovation.eta_decode*eta_scale)
            alternate.development.train_k=train_k
            alt = calculate(alternate, models, False, inf_models, inf_chips, inf_scenes)
            variations.append(dict(name=label, total_planned_p=alt["total_planned_p"], changes=dict(load_scale=str(scale),efficiency_scale=str(eta_scale),train_k=str(train_k))))
        report["sensitivity"] = variations
    return clean(report)


def cost_estimate(report, cards, prices):
    outputs = []
    for card in cards:
        pool_lines, amount_low, amount_high, status = [], ZERO, ZERO, "COMPLETE"
        price = prices.get(card["id"])
        for pool in report["pools"]:
            if pool["completeness"] == "DISABLED":
                continue
            if pool["planned_p"] is None:
                status = "PARTIAL"
                continue
            if not card.get("dense_p16") or not card.get("memory_gb"):
                status = "MISSING_SPEC"
                continue
            compute_cards = ceil(D(pool["planned_p"])/D(card["dense_p16"]))
            mem = pool["memory"]
            memory_complete = mem["status"] in ("COMPLETE","PROXY")
            memory_cards = ceil(D(mem["memory_gb"])/D(card["memory_gb"])) if memory_complete else None
            count = max(compute_cards, memory_cards or 0)
            if not memory_complete:
                status = "COMPUTE_LOWER_BOUND_ONLY"
            pool_lines.append(dict(pool_id=pool["id"],compute_cards=compute_cards,memory_cards=memory_cards,reference_cards=count,memory_status=mem["status"]))
            if price and price.get("price_low") is not None and price.get("price_high") is not None:
                amount_low += count*D(price["price_low"])
                amount_high += count*D(price["price_high"])
        has_price = price and price.get("price_low") is not None and price.get("price_high") is not None
        if report["completeness"] != "COMPLETE":
            status = "PARTIAL"
        if not has_price and status == "COMPLETE":
            status = "PRICE_MISSING"
        outputs.append(dict(card=card,pools=pool_lines,reference_cards=sum(p["reference_cards"] for p in pool_lines),amount_low=amount_low if has_price else None,amount_high=amount_high if has_price else None,status=status,price=price,topology_status="UNVERIFIED",is_demo=bool(price and price.get("is_demo"))))
    return clean(dict(items=outputs,scope="仅加速卡购置费用，不含服务器、网络、存储、软件和运维；规格折算为下界参考，互联与拓扑尚未验证。"))
