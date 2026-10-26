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
ENGINE_VERSION = "engine-v1.0.0"
REFERENCE = "BF16_DENSE_EQUIVALENT"
TEMPLATES = {
    "qa": dict(requests_per_user_min=".5", input_tokens=2048, answer_tokens=512, reasoning_tokens=0, ttft_seconds=2, output_tokens_per_second=30),
    "extract": dict(requests_per_user_min=".5", input_tokens=1024, answer_tokens=128, reasoning_tokens=0, ttft_seconds=2, output_tokens_per_second=30),
    "document": dict(requests_per_user_min=".1", input_tokens=8192, answer_tokens=1024, reasoning_tokens=0, ttft_seconds=5, output_tokens_per_second=25),
    "report": dict(requests_per_user_min=".05", input_tokens=8192, answer_tokens=2048, reasoning_tokens=4096, ttft_seconds=10, output_tokens_per_second=25),
    "vision": dict(requests_per_user_min=".2", input_tokens=1024, answer_tokens=512, reasoning_tokens=0, ttft_seconds=3, output_tokens_per_second=25),
}
INTENSITIES = {
    "light": dict(train_data_tokens=1_000_000, epochs=1, train_deadline_hours=24, eval_samples=200, eval_deadline_hours=8, sequence_length=2048, train_slots=1, eval_slots=1, train_eval_parallel=False),
    "standard": dict(train_data_tokens=5_000_000, epochs=2, train_deadline_hours=12, eval_samples=1000, eval_deadline_hours=4, sequence_length=2048, train_slots=1, eval_slots=1, train_eval_parallel=True),
    "high": dict(train_data_tokens=20_000_000, epochs=3, train_deadline_hours=8, eval_samples=5000, eval_deadline_hours=2, sequence_length=4096, train_slots=2, eval_slots=2, train_eval_parallel=True),
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
    if task.task_type in ("text", "vlm"):
        if model is None:
            raise CalculationIssue("MISSING_BASELINE", "请选择可用模型")
        if task.task_type not in model.get("tasks", []):
            raise CalculationIssue("UNSUPPORTED_PROFILE", "所选模型不支持该任务类型")
        if rate is None:
            raise CalculationIssue("MISSING_WORKLOAD", "请填写同时在线人数或请求/秒")
        if task.task_type == "vlm":
            li += (task.images_per_request + task.extracted_frames_per_request) * task.visual_tokens_per_image
        limit = model.get("context_limit")
        if limit and li + lg > D(limit):
            raise CalculationIssue("CONTEXT_LIMIT_EXCEEDED", "请求总长度超过已确认上下文上限")
        if max(li, lg) > 32768 and not task.allow_proxy:
            raise CalculationIssue("MISSING_BASELINE", "长上下文需要专用基线或明确接受代理")
        if (model.get("requires_proxy") or (model.get("cache",{}).get("type")=="unknown" and model.get("architecture")=="MoE")) and not task.allow_proxy:
            raise CalculationIssue("MISSING_BASELINE", "特殊架构需要明确接受经验代理")
        kappa = D("1.2") if model.get("architecture") == "MoE" else D("1.1")
        kp, kd = task.kappa_prefill or kappa, task.kappa_decode or kappa
        np, nd = scalar(model, "active_parameters_prefill"), scalar(model, "active_parameters_decode")
        vision = ZERO
        if task.task_type == "vlm":
            vision = task.vision_flop_per_request
            if vision is None:
                vision = 2 * np * li * kp * task.vision_flop_ratio if task.images_per_request + task.extracted_frames_per_request > 0 else ZERO
                result["warnings"].append("VISION_PROXY")
        result.update(inference(rate, np, nd, li, lg, kp, kd, task.eta_prefill, task.eta_decode, vision))
        variables = {**cfg, "request_rate": rate, "input_tokens_total": li, "generation_tokens_total": lg, "active_parameters_prefill": np, "active_parameters_decode": nd, "kappa_prefill": kp, "kappa_decode": kd}
        formula = "llm-phases-v1"
    elif task.task_type in ("cv", "unit"):
        flop = task.flop_per_unit or (D(model["flop_per_unit"]) if model and model.get("flop_per_unit") else None)
        if task.flop_per_unit and not task.baseline_source:
            raise CalculationIssue("MISSING_BASELINE", "自定义每单位FLOP必须填写来源或代理说明")
        if task.task_type == "cv":
            if model and "cv" not in model.get("tasks", []):
                raise CalculationIssue("UNSUPPORTED_PROFILE", "所选模型不是CV检测模型")
            if model and model.get("input_size") and task.input_size != model["input_size"] and not task.allow_proxy:
                raise CalculationIssue("MISSING_BASELINE", "分辨率与基线不一致，请确认代理或提供新基线")
            if model and model.get("input_size") and task.input_size != model["input_size"]:
                flop = flop * (D(task.input_size) / D(model["input_size"])) ** 2 if flop else None
                result["warnings"].append("RESOLUTION_PROXY")
            unit_rate = task.images_per_second
            if unit_rate is None and task.streams is not None:
                unit_rate = task.streams * task.analysis_fps
            if unit_rate is None and rate is not None:
                unit_rate = rate * task.images_per_request
        else:
            unit_rate = task.units_per_second
            if unit_rate is None and task.total_units is not None and task.deadline_hours is not None:
                unit_rate = task.total_units / (task.deadline_hours * 3600)
        if unit_rate is None:
            raise CalculationIssue("MISSING_WORKLOAD", "请填写路数/帧率、处理速率或任务量与完成窗口")
        if flop is None:
            raise CalculationIssue("MISSING_BASELINE", "缺少每单位FLOP基线")
        rate = unit_rate
        result.update(base_p=rate * flop / task.eta_unit / PETA, effective_p=rate * flop / PETA)
        variables = {**cfg, "unit_rate": rate, "flop_per_unit": flop}
        li = lg = ZERO
        formula = "unit-work-v1"
    else:
        raise CalculationIssue("UNSUPPORTED_PROFILE", "未知计算任务")
    result["memory"] = memory_for(task, model, rate, li, lg, reserve)
    result["trace"] = {
        "formula_id": formula, "version": ENGINE_VERSION, "variables": variables,
        "formula": "λ × ((2×Np×Li×κp + Fvision)/ηp + 2×Nd×Lg×κd/ηd) / 10^15" if formula == "llm-phases-v1" else "单位/秒 × FLOP/单位 / η / 10^15",
        "units": {"base_p": "P16", "effective_p": "PFLOPS", "memory": "GB (10^9 bytes)"},
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


def pool_summary(pool_id, items, missing, plan, enabled=True, base_override=None, memory_override=None):
    computable = [x for x in items if x.get("base_p") is not None]
    native_missing = [dict(id=x["id"], code="PRECISION_NOT_COMPARABLE", message="原生精度无参考映射，未计入P16", pool_id=pool_id) for x in items if x.get("base_p") is None]
    missing = missing + native_missing
    status = "DISABLED" if not enabled else "PARTIAL" if missing and computable else "BLOCKED" if missing else "COMPLETE"
    base = (base_override if base_override is not None else sum((x["base_p"] for x in computable), ZERO)) if computable or not enabled or not missing else None
    return dict(id=pool_id, base_p=base, planned_p=base * (1 + plan.headroom) if base is not None else None, effective_p=sum((x.get("effective_p") or ZERO for x in computable), ZERO), completeness=status, evidence_grade="C", items=items, missing_items=missing, counted_tasks=len(computable), total_tasks=len(computable) + len(missing), memory=memory_override or summarize_memory(computable, plan.memory_reserve))


def calculate(plan: PlanInput, models: list[dict], sensitivity=False):
    started = perf_counter()
    lookup = {m["id"]: m for m in models}
    business, missing = [], []
    growth = (1 + plan.annual_growth) ** (D((plan.planning_end - plan.planning_start).days) / D("365.25")) if plan.input_time_basis == "current_growth" else D(1)

    def attempt(task, name, pool_id, target, issues, scenario_id=None):
        try:
            item = compute_task(task, lookup.get(task.model_id), plan.memory_reserve)
            item.update(name=name, pool_id=pool_id, scenario_id=scenario_id)
            if pool_id in ("innovation","development") and item.get("trace"):
                item["trace"]["variables"]["parameter_origins"]["request_rate"]={"origin":"derived","source_id":pool_id+"-v1","evidence_grade":"C"}
            target.append(item)
            return item
        except CalculationIssue as exc:
            issues.append(dict(id=task.id, name=name, pool_id=pool_id, scenario_id=scenario_id, code=exc.code, message=exc.message))
            return None

    for scenario in plan.scenarios:
        if not scenario.enabled:
            continue
        if not scenario.components:
            missing.append(dict(id=scenario.id, name=scenario.name, code="MISSING_WORKLOAD", message="场景没有计算组件", pool_id="business"))
        for component in scenario.components:
            if not component.enabled:
                continue
            task = component.model_copy(deep=True)
            for key in ("online_users", "request_rate", "streams", "images_per_second", "units_per_second", "total_units"):
                if getattr(task, key) is not None:
                    setattr(task, key, getattr(task, key) * growth)
            attempt(task, scenario.name, "business", business, missing, scenario.id)
    business_pool = pool_summary("business", business, missing, plan)
    scenario_summaries=[]
    for scenario in plan.scenarios:
        if not scenario.enabled:
            continue
        entries=[i for i in business if i.get("scenario_id")==scenario.id and i.get("base_p") is not None]
        gaps=[i for i in business_pool["missing_items"] if i.get("scenario_id")==scenario.id or i.get("id")==scenario.id]
        value=sum((i["base_p"] for i in entries),ZERO) if entries else None
        scenario_summaries.append(dict(id=scenario.id,name=scenario.name,base_p=value,planned_p=value*(1+plan.headroom) if value is not None else None,completeness="PARTIAL" if entries and gaps else "BLOCKED" if gaps or not entries else "COMPLETE",component_count=len(entries),missing_count=len(gaps)))
    business_pool["scenarios"]=sorted(scenario_summaries,key=lambda x:x["base_p"] or ZERO,reverse=True)

    innov, innov_missing = [], []
    config = plan.innovation
    monthly = None
    if config.enabled:
        if config.users is None or config.quota_per_user_month is None or not config.allocations:
            innov_missing.append(dict(id="innovation", name="创新服务", pool_id="innovation", code="MISSING_WORKLOAD", message="请填写人数、月额度并选择模型分配"))
        else:
            monthly = config.users * growth * config.quota_per_user_month * config.usage_ratio
            seconds = config.service_days * config.service_hours_per_day * 3600
            for allocation in config.allocations:
                if allocation.share == 0:
                    continue
                count = monthly * allocation.share
                rate = count / seconds * config.peak_factor / allocation.request_total_tokens
                task = Task(id=f"innovation-{allocation.model_id}", task_type="vlm" if allocation.multimodal else "text", model_id=allocation.model_id, request_rate=rate, input_tokens=allocation.request_total_tokens * allocation.input_fraction, answer_tokens=allocation.request_total_tokens * (1 - allocation.input_fraction), reasoning_tokens=ZERO, eta_prefill=config.eta_prefill, eta_decode=config.eta_decode, images_per_request=allocation.images_per_request, allow_proxy=True)
                # In multimodal quotas visual input tokens are already part of the total allowance.
                if allocation.multimodal:
                    task.visual_tokens_per_image = ZERO
                item = attempt(task, lookup.get(allocation.model_id, {}).get("display_name", allocation.model_id), "innovation", innov, innov_missing)
                if item:
                    item["monthly_tokens"] = count
                    item["trace"]["quota"] = dict(monthly_total=monthly, model_share=allocation.share, allocated=count, service_seconds=seconds, peak_factor=config.peak_factor, input_tokens_per_second=count*allocation.input_fraction/seconds*config.peak_factor, output_tokens_per_second=count*(1-allocation.input_fraction)/seconds*config.peak_factor, reasoning_already_included=True)
    innovation_pool = pool_summary("innovation", innov, innov_missing, plan, config.enabled)
    innovation_pool["monthly_tokens"] = monthly

    dev, dev_missing = [], []
    dc = plan.development
    dev_base = None
    dev_memory = None
    dev_cfg = {k: getattr(dc, k) if getattr(dc, k) is not None else v for k, v in INTENSITIES[dc.intensity].items()}
    train_caps, eval_caps, train_mems, eval_mems, eval_memory_statuses = [], [], [], [], []
    if dc.enabled:
        if not dc.models:
            dev_missing.append(dict(id="development", name="开发测试", pool_id="development", code="MISSING_WORKLOAD", message="请选择需要支持的模型"))
        for entry in dc.models:
            model = lookup.get(entry.model_id)
            label = (model or {}).get("display_name", entry.model_id)
            if not model or entry.method not in model.get("eligible_training_methods", []):
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
            eval_rate=D(dev_cfg["eval_samples"])/(D(dev_cfg["eval_deadline_hours"])*3600)
            eval_task = Task(id=f"eval-{entry.model_id}", model_id=entry.model_id, task_type=entry.eval_task_type, request_rate=eval_rate, images_per_second=eval_rate if entry.eval_task_type=="cv" else None, input_tokens=dc.eval_input_tokens, answer_tokens=dc.eval_output_tokens, reasoning_tokens=0, allow_proxy=True)
            item = attempt(eval_task, label+" · 效果评测", "development", dev, dev_missing)
            if item and item.get("base_p") is not None:
                eval_caps.append(item["base_p"])
                m = summarize_memory([item], plan.memory_reserve)
                eval_mems.append(m["memory_gb"])
                eval_memory_statuses.append(m["status"])
        if train_caps or eval_caps:
            tc = max(train_caps, default=ZERO)*dev_cfg["train_slots"]
            ec = max(eval_caps, default=ZERO)*dev_cfg["eval_slots"]
            tm = max(train_mems, default=ZERO)*dev_cfg["train_slots"]
            em = max(eval_mems, default=ZERO)*dev_cfg["eval_slots"]
            dev_base = tc+ec if dev_cfg["train_eval_parallel"] else max(tc,ec)
            dev_memory = dict(memory_gb=tm+em if dev_cfg["train_eval_parallel"] else max(tm,em), status="PROXY" if all(s in ("COMPLETE","PROXY") for s in eval_memory_statuses) and not dev_missing else "WEIGHT_LOWER_BOUND", groups=[], train_slot_gb=tm, eval_slot_gb=em)
    development_pool = pool_summary("development", dev, dev_missing, plan, dc.enabled, dev_base, dev_memory)
    development_pool["intensity_parameters"] = dev_cfg
    development_pool["aggregation_rule"] = "微调槽位×最大单任务 + 评测槽位×最大单任务" if dev_cfg["train_eval_parallel"] else "微调与评测串行，取最大容量"

    pools = [business_pool, innovation_pool, development_pool]
    missing_items = [m for p in pools for m in p["missing_items"]]
    counted = sum(p["counted_tasks"] for p in pools)
    total = sum((p["base_p"] or ZERO for p in pools), ZERO)
    complete = "PARTIAL" if missing_items and counted else "BLOCKED" if missing_items or counted == 0 else "COMPLETE"
    report = dict(engine_version=ENGINE_VERSION, defaults_version=plan.defaults_version, reference_precision=REFERENCE, completeness=complete, evidence_grade="C", latency_status="UNVERIFIED", total_base_p=total if counted else None, total_planned_p=total*(1+plan.headroom) if counted else None, headroom=plan.headroom, pools=pools, missing_items=missing_items, counted_tasks=counted, total_tasks=counted+len(missing_items), is_demo=plan.is_demo, growth_factor=growth, warnings=["HEURISTIC_EFFICIENCY", "SLA_NOT_BENCHMARKED"], duration_ms=D(str((perf_counter()-started)*1000)))
    if sensitivity and counted:
        variations = []
        for label, scale, eta_scale, train_k in (("较低负载/较高效率",D(".8"),D("1.25"),D(3)),("较高负载/较低效率",D("1.2"),D(".75"),D(6))):
            alternate = plan.model_copy(deep=True)
            for s in alternate.scenarios:
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
            alt = calculate(alternate,models,False)
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
