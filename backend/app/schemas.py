from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Literal, Union, get_args, get_origin
from uuid import uuid4
import types

from pydantic import BaseModel, ConfigDict, Field, model_validator

NonNeg = Annotated[Decimal, Field(ge=0, allow_inf_nan=False)]
Positive = Annotated[Decimal, Field(gt=0, allow_inf_nan=False)]
Ratio = Annotated[Decimal, Field(ge=0, le=1, allow_inf_nan=False)]
Efficiency = Annotated[Decimal, Field(gt=0, le=1, allow_inf_nan=False)]


def uid() -> str:
    return uuid4().hex


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_default=True)


class Task(StrictModel):
    id: str = Field(default_factory=uid)
    task_type: Literal["text", "vlm", "cv", "unit", "native"] = "text"
    model_id: str | None = None
    template: Literal["qa", "extract", "document", "report", "vision"] = "qa"
    enabled: bool = True
    online_users: NonNeg | None = None
    request_rate: NonNeg | None = None
    requests_per_user_min: NonNeg | None = None
    calls_per_request: Positive = Decimal(1)
    input_tokens: NonNeg | None = None
    answer_tokens: NonNeg | None = None
    reasoning_tokens: NonNeg | None = None
    eta_prefill: Efficiency = Decimal(".35")
    eta_decode: Efficiency = Decimal(".15")
    eta_unit: Efficiency = Decimal(".30")
    kappa_prefill: Positive | None = None
    kappa_decode: Positive | None = None
    ttft_seconds: NonNeg | None = None
    output_tokens_per_second: Positive | None = None
    images_per_request: NonNeg = Decimal(1)
    visual_tokens_per_image: NonNeg = Decimal(1024)
    extracted_frames_per_request: NonNeg = Decimal(0)
    vision_flop_ratio: NonNeg = Decimal(".20")
    vision_flop_per_request: NonNeg | None = None
    streams: NonNeg | None = None
    analysis_fps: NonNeg = Decimal(5)
    images_per_second: NonNeg | None = None
    input_size: int = Field(default=640, gt=0, le=16384)
    units_per_second: NonNeg | None = None
    total_units: NonNeg | None = None
    deadline_hours: Positive | None = None
    flop_per_unit: Positive | None = None
    unit_name: str = Field(default="任务", max_length=40)
    baseline_source: str | None = None
    serving_profile: str = "default"
    independent: bool = False
    deployment_group: str = "shared"
    weight_bits: Literal[4, 8, 16, 32] = 16
    kv_bytes: Literal[1, 2, 4] = 2
    quantization_metadata_fraction: NonNeg | None = None
    replicas: int = Field(default=1, ge=1, le=100)
    prewarm: bool = False
    allow_proxy: bool = False
    native_precision: str | None = None
    native_capacity: NonNeg | None = None
    reference_mapping: Positive | None = None
    confirmed: bool = False
    provenance: dict = Field(default_factory=dict)

    @model_validator(mode="after")
    def parameter_sources(self):
        explicit = self.model_fields_set
        for key in type(self).model_fields:
            if key in ("id","provenance"):
                continue
            if key not in self.provenance:
                self.provenance[key] = {
                    "origin": "user_input" if key in explicit and getattr(self,key) is not None else "template_default",
                    "source_id": None if key in explicit and getattr(self,key) is not None else "defaults-v1",
                    "evidence_grade": "C",
                }
        return self


class Scenario(StrictModel):
    id: str = Field(default_factory=uid)
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10000)
    enabled: bool = True
    source_reference: dict = Field(default_factory=dict)
    # 业务池的唯一计算入口：模型 / 精度 / 场景档位 / 芯片 / 并发与时延目标。
    inference: InferenceRequest | None = None
    # 已停用：仅为旧方案与导入清单保留的原始任务字段，不参与业务池计算。
    # 历史方案（无 inference）由 engine/business.py 的 resolve_spec 推导并告警。
    components: list[Task] = Field(default_factory=list, max_length=20)


class Allocation(StrictModel):
    model_id: str
    share: Ratio
    input_fraction: Ratio = Decimal(".8")
    request_total_tokens: Positive = Decimal(2560)
    multimodal: bool = False
    images_per_request: NonNeg = Decimal(1)


class Innovation(StrictModel):
    enabled: bool = False
    users: NonNeg | None = None
    quota_per_user_month: NonNeg | None = None
    usage_ratio: Ratio = Decimal(1)
    service_days: Annotated[Decimal, Field(gt=0, le=31)] = Decimal(22)
    service_hours_per_day: Annotated[Decimal, Field(gt=0, le=24)] = Decimal(8)
    representative_month: str | None = None
    peak_factor: Positive = Decimal(3)
    allocations: list[Allocation] = Field(default_factory=list)
    eta_prefill: Efficiency = Decimal(".35")
    eta_decode: Efficiency = Decimal(".15")
    # 折算卡数用的算力芯片（catalogs/inference_chips.json 的 key）。
    # 与业务池共用同一套芯片规格，两池卡数才可比；None 表示本方案不出卡数。
    chip_key: str | None = "910c"


class DevModel(StrictModel):
    model_id: str
    method: Literal["lora", "qlora"] = "lora"


class Development(StrictModel):
    enabled: bool = False
    intensity: Literal["light", "standard", "high"] = "standard"
    models: list[DevModel] = Field(default_factory=list)
    train_data_tokens: Positive | None = None
    epochs: Positive | None = None
    train_deadline_hours: Positive | None = None
    sequence_length: int | None = Field(default=None, gt=0)
    micro_batch: int = Field(default=1, ge=1)
    train_slots: int | None = Field(default=None, ge=1, le=100)
    train_k: Positive = Decimal(4)
    train_eta: Efficiency = Decimal(".25")
    adapter_fraction: Ratio = Decimal(".005")
    # 折算卡数用的算力芯片；训练与推理吃同一张卡的算力与显存，口径统一。
    chip_key: str | None = "910c"


class PlanInput(StrictModel):
    headroom: Annotated[Decimal, Field(ge=0, le=5)] = Decimal(".20")
    memory_reserve: Annotated[Decimal, Field(ge=0, lt=1)] = Decimal(".15")
    defaults_version: str = "defaults-v1"
    notes: str = ""
    is_demo: bool = False
    scenarios: list[Scenario] = Field(default_factory=list, max_length=1000)
    innovation: Innovation = Field(default_factory=Innovation)
    development: Development = Field(default_factory=Development)

    @model_validator(mode="after")
    def coherent(self):
        ids = [s.id for s in self.scenarios]
        if len(ids) != len(set(ids)):
            raise ValueError("场景ID重复")
        task_ids = [t.id for s in self.scenarios for t in s.components]
        if len(task_ids) != len(set(task_ids)):
            raise ValueError("组件ID重复")
        if self.innovation.enabled and self.innovation.allocations:
            shares = sum((a.share for a in self.innovation.allocations), Decimal(0))
            if abs(shares - 1) > Decimal(".000001"):
                raise ValueError("INVALID_SHARE: 模型Token份额合计必须为100%")
            models = [a.model_id for a in self.innovation.allocations]
            if len(models) != len(set(models)):
                raise ValueError("同一模型不能重复分配，请合并其份额")
        if len({m.model_id for m in self.development.models}) != len(self.development.models):
            raise ValueError("开发测试模型重复")
        return self


# ---------------------------------------------------------------- 推理算力评估
# 口径见 docs/推理算力评估梳理-2609V8口径.md，引擎实现在 engine/inference.py

Precision = Literal["auto", "bf16", "fp16", "fp8", "int8", "int4"]
Sensitivity = Literal["optimistic", "neutral", "conservative"]
DeploymentMode = Literal["mixed", "split"]


class InferenceRequest(StrictModel):
    """单场景推理算力评估输入。留空字段取所选场景档位的默认值。"""
    model_key: str = Field(min_length=1, max_length=64)
    chip_key: str = Field(min_length=1, max_length=64)
    scene_key: Literal[
        "long_gen", "kb_qa", "deep_think", "long_summary", "ultra_long", "custom"
    ] = "long_gen"
    weight_precision: Precision = "auto"
    kv_precision: Literal["auto", "bf16", "fp8", "int8"] = "auto"
    profile: Sensitivity = "neutral"
    deployment: DeploymentMode = "mixed"
    concurrency: Positive | None = None
    prompt_len: Annotated[int, Field(ge=100, le=1048576)] | None = None
    output_len: Annotated[int, Field(ge=100, le=131072)] | None = None
    max_ctx: Annotated[int, Field(ge=512, le=1048576)] | None = None
    ttft_target_ms: Positive | None = None
    tpot_target_ms: Positive | None = None
    prefix_hit: Annotated[Decimal, Field(ge=0, le=0.9)] = Decimal(0)

    @model_validator(mode="after")
    def valid_sla(self):
        if self.ttft_target_ms is not None and not (50 <= self.ttft_target_ms <= 120000):
            raise ValueError("TTFT 目标须介于 50 与 120000 ms")
        if self.tpot_target_ms is not None and not (1 <= self.tpot_target_ms <= 500):
            raise ValueError("TPOT 目标须介于 1 与 500 ms")
        if self.max_ctx is not None and self.prompt_len is not None and self.output_len is not None:
            if self.max_ctx < self.prompt_len + self.output_len:
                raise ValueError("最大上下文不得小于输入与输出长度之和")
        return self

    def to_engine(self) -> dict:
        """转成引擎入参，Decimal 统一转 float。"""
        return {
            "model_key": self.model_key, "chip_key": self.chip_key,
            "scene_key": self.scene_key,
            "weight_precision": "" if self.weight_precision == "auto" else self.weight_precision,
            "kv_precision": self.kv_precision,
            "concurrency": float(self.concurrency) if self.concurrency is not None else None,
            "prompt_len": self.prompt_len, "output_len": self.output_len,
            "max_ctx": self.max_ctx,
            "ttft_target_ms": float(self.ttft_target_ms) if self.ttft_target_ms is not None else None,
            "tpot_target_ms": float(self.tpot_target_ms) if self.tpot_target_ms is not None else None,
            "prefix_hit": float(self.prefix_hit),
        }


class InferenceModelInput(StrictModel):
    """自定义模型结构：用于清单外的自研或未收录模型。"""
    key: str = Field(min_length=1, max_length=64)
    label: str = Field(default="", max_length=120)
    total_b: Positive
    active_b: Positive
    hid: Annotated[int, Field(ge=128, le=131072)]
    layers: Annotated[int, Field(ge=1, le=512)]
    heads: Annotated[int, Field(ge=1, le=1024)]
    kv_heads: Annotated[int, Field(ge=1, le=1024)] = 1
    head_dim: Annotated[int, Field(ge=8, le=1024)] = 128
    kv_head_dim: Annotated[int, Field(ge=8, le=1024)] | None = None
    attn_span: Annotated[int, Field(ge=0, le=1048576)] = 0
    gqa_kv_fraction: Ratio = Decimal(1)
    ffn_mul: Positive = Decimal("2.5")
    experts: Annotated[int, Field(ge=0, le=4096)] | None = None
    top_k: Annotated[int, Field(ge=1, le=512)] | None = None
    latent_dim: Annotated[int, Field(ge=0, le=4096)] | None = None
    rope_dim: Annotated[int, Field(ge=0, le=1024)] | None = None
    qk_head_dim: Annotated[int, Field(ge=0, le=4096)] | None = None
    v_head_dim: Annotated[int, Field(ge=0, le=4096)] | None = None

    @model_validator(mode="after")
    def coherent(self):
        if self.active_b > self.total_b + Decimal("0.001"):
            raise ValueError("激活参数量不能大于总参数量")
        if self.kv_heads > self.heads:
            raise ValueError("KV 头数不能大于 Q 头数")
        if self.experts and self.top_k and self.top_k > self.experts:
            raise ValueError("Top-K 不能大于专家总数")
        return self

    def to_engine(self) -> dict:
        return {
            "key": self.key, "label": self.label or self.key,
            "total_b": float(self.total_b), "active_b": float(self.active_b),
            "hid": self.hid, "layers": self.layers, "heads": self.heads,
            "kv_heads": self.kv_heads, "head_dim": self.head_dim,
            "kv_head_dim": self.kv_head_dim, "attn_span": self.attn_span,
            "gqa_kv_fraction": float(self.gqa_kv_fraction),
            "ffn_mul": float(self.ffn_mul), "experts": self.experts,
            "top_k": self.top_k, "latent_dim": self.latent_dim,
            "rope_dim": self.rope_dim, "qk_head_dim": self.qk_head_dim,
            "v_head_dim": self.v_head_dim,
            "arch": "MoE" if (self.experts or 0) > 1 else "Dense",
            "custom": True,
        }


# Scenario 定义在 InferenceRequest 之前，这里显式完成前向引用解析。
Scenario.model_rebuild()


def _model_type(annotation):
    """从注解里取出 BaseModel 子类，支持 Annotated[X]、X | None、list[X]。"""
    origin = get_origin(annotation)
    if origin is Annotated:
        return _model_type(get_args(annotation)[0])
    if origin in (list, tuple, set):
        args = get_args(annotation)
        return _model_type(args[0]) if args else None
    if origin in (Union, types.UnionType):
        for arg in get_args(annotation):
            if arg is type(None):
                continue
            found = _model_type(arg)
            if found is not None:
                return found
        return None
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return annotation
    return None


def prune_payload(model, value):
    """按模型字段递归剔除已下线字段。

    历史方案里可能留着当前 schema 不认识的键（例如早期的 planning_start、
    development.eval_*）。读取时先剪掉这些键，旧方案才能被当前版本打开；
    写入仍然走严格校验，字段名写错不会被静默吞掉。
    """
    if isinstance(value, list):
        return [prune_payload(model, item) for item in value]
    if not isinstance(value, dict):
        return value
    out = {}
    for key, val in value.items():
        field = model.model_fields.get(key)
        if field is None:
            continue
        nested = _model_type(field.annotation)
        out[key] = prune_payload(nested, val) if nested is not None else val
    return out
