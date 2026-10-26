from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Annotated, Literal
from uuid import uuid4

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
    components: list[Task] = Field(default_factory=lambda: [Task()], max_length=20)


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


class DevModel(StrictModel):
    model_id: str
    method: Literal["lora", "qlora"] = "lora"
    eval_task_type: Literal["text", "vlm", "cv"] = "text"


class Development(StrictModel):
    enabled: bool = False
    intensity: Literal["light", "standard", "high"] = "standard"
    models: list[DevModel] = Field(default_factory=list)
    train_data_tokens: Positive | None = None
    epochs: Positive | None = None
    train_deadline_hours: Positive | None = None
    eval_samples: Positive | None = None
    eval_deadline_hours: Positive | None = None
    sequence_length: int | None = Field(default=None, gt=0)
    micro_batch: int = Field(default=1, ge=1)
    train_slots: int | None = Field(default=None, ge=1, le=100)
    eval_slots: int | None = Field(default=None, ge=1, le=100)
    train_eval_parallel: bool | None = None
    train_k: Positive = Decimal(4)
    train_eta: Efficiency = Decimal(".25")
    adapter_fraction: Ratio = Decimal(".005")
    eval_input_tokens: NonNeg = Decimal(2048)
    eval_output_tokens: NonNeg = Decimal(512)


class PlanInput(StrictModel):
    planning_start: date = date(2026, 10, 20)
    planning_end: date = date(2029, 10, 20)
    input_time_basis: Literal["endpoint", "current_growth"] = "endpoint"
    annual_growth: Annotated[Decimal, Field(ge=0, le=10)] = Decimal(0)
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
        if self.planning_end < self.planning_start:
            raise ValueError("规划结束时间必须不早于开始时间")
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
