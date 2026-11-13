"""推理引擎的可配置参数（v2 结构，与推理评估页 inference-eval.html 口径一致）。

设计约定：
1. 默认值只在 `catalogs/inference_params.json` 里，代码不重复写数字；
2. 运行时改动作为「覆盖层」存在数据库（store kind=inference-params），
   与默认值分开存放，因此升级默认值不会抹掉用户的调参；
3. 每个可改字段都在 SPEC/TABLES 里登记类型与取值范围，越界一律拒绝（不静默截断），
   前端按 describe() 的 schema 渲染表单。

v2 结构（对应页面 ENG_DEFAULTS / ENG_CONST / TIERS 三套口径）：
- chip_profiles：按芯片 8 条效率系数（mfu_prefill / mfu_decode_ratio / bw_decode /
  kv_reserve / mem_util），可覆盖；
- constants：全局工程口径常数 12 项，可覆盖；
- tiers：三档统一缩放（保守 0.8 / 均衡 1.0 / 激进 1.2），可覆盖；
- tier_exponents：档位缩放指数规则——效率类（mfu_prefill / bw_decode）全额跟随，
  mem_util 半幅跟随（约一半是 CANN runtime / 通信 buffer 的固定占用），
  mfu_decode_ratio（比值）与 kv_reserve（结构性开销）不缩放。只读，来自 catalog。

旧结构兼容：v1 的覆盖层（limits/aggregation/coefficients/timing/sensitivity）
在启动 load() 时被检测——可映射字段迁移进新结构（chip 效率三字段、FFN 填充与
排队常数、档位系数），其余清空并记日志，用户需在 v2 参数页重新调参。
物理量（每参数字节、GB/GiB 换算、芯片算力与显存带宽）不在参数里，
它们来自 `inference_chips.json`，改动属于换硬件而不是调经验值。
"""
from __future__ import annotations

import copy
import json
import logging
from pathlib import Path

logger = logging.getLogger("planner.params")

PATH = Path(__file__).resolve().parent.parent / "catalogs" / "inference_params.json"

NUMBER = dict(type="number")
TEXT = dict(type="text")

# ---------- 可覆盖常数（页面 ENG_RANGES.const 口径 + 引擎常数） ----------
CONSTANTS_SPEC = [
    ("prefill_budget", dict(NUMBER, min=0.50, max=1.00, label="Prefill 计算预算占比",
                            note="吞吐下限 N1 与时延判据各留 (1-预算) 的余量；页面默认 0.85。")),
    ("decode_fixed_ms", dict(NUMBER, min=0.0, max=10.0, label="Decode 每步固定开销（ms）",
                             note="调度 + 内核启动，与分片/批量无关。")),
    ("roofline_overlap", dict(NUMBER, min=0.0, max=1.0, label="Decode 步长重叠惩罚",
                              note="步长 = max(带宽时间, 计算时间) + 重叠 × min：两条管线未完全重叠的惩罚。")),
    ("queue_coef", dict(NUMBER, min=0.0, max=2.0, label="M/G/1 排队系数",
                        note="TTFT = 服务时间 × (1 + ρ/(2(1−ρ))) 中的排队强度系数，页面默认 0.5。")),
    ("moe_skew", dict(NUMBER, min=1.00, max=1.50, label="MoE 权重装载偏斜",
                      note="专家分布不均与对齐填充，显存按总参 +8% 预留。")),
    ("moe_hit_inflate", dict(NUMBER, min=1.00, max=1.50, label="MoE Decode 专家命中膨胀",
                             note="每步实际读到的专家略多于理论期望值。")),
    ("moe_fill_tok", dict(NUMBER, min=16.0, max=20000.0, label="MoE FFN 填满特征长度（token）",
                          note="每专家平均 token 数越大专家矩阵乘越满，有效率指数爬升。")),
    ("dense_fill_tok", dict(NUMBER, min=16.0, max=50000.0, label="Dense FFN 填满特征长度（token）")),
    ("moe_ffn_floor", dict(NUMBER, min=0.01, max=0.50, label="MoE FFN 有效利用率下限",
                           note="小批量专家填不满时的下限，页面默认 0.07。")),
    ("moe_ffn_ceil", dict(NUMBER, min=0.30, max=1.00, label="MoE FFN 有效利用率上限",
                          note="页面口径 floor + 0.43 幅度 → 上限 0.5（下限 0.07）。")),
    ("dense_ffn_lo", dict(NUMBER, min=0.01, max=0.90, label="Dense FFN 有效利用率下限",
                          note="小 prompt 时 FFN 只跑出四成效率，页面默认 0.42。")),
    ("rho_cap", dict(NUMBER, min=0.50, max=1.00, label="排队利用率上限",
                     note="ρ 压到该值即视为饱和（页面 0.95），防止 M/G/1 在 ρ→1 时发散。")),
]

# ---------- 芯片效率档（页面 ENG_RANGES.chip 口径） ----------
CHIP_FIELDS = {
    "mfu_prefill": dict(NUMBER, min=0.05, max=0.60, label="Prefill MFU",
                        note="Prefill 有效 MFU（长序列大 GEMM 的实际达峰比例）。",
                        why="按芯片标定的经验中位数；910C 的大 GEMM 达峰口径为 0.26。"),
    "mfu_decode_ratio": dict(NUMBER, min=0.20, max=1.50, label="Decode MFU ÷ Prefill MFU",
                             note="比值不随档位缩放：若把比值也乘档位，Decode 会被扣两次。"),
    "bw_decode": dict(NUMBER, min=0.30, max=0.95, label="Decode HBM 带宽利用率"),
    "kv_reserve": dict(NUMBER, min=1.00, max=1.50, label="KV 预留系数",
                       note="PagedAttention 块对齐等结构性开销，不随档位缩放。"),
    "mem_util": dict(NUMBER, min=0.50, max=0.95, label="显存容量利用率",
                     note="约一半是 CANN runtime / 通信 buffer 的固定占用，档位只跟半幅。"),
}

# ---------- 档位缩放 ----------
TIER_FIELDS = {
    "label": dict(TEXT, max_length=12, label="档位名称"),
    "coef": dict(NUMBER, min=0.50, max=1.50, label="档位缩放系数",
                 note="作用于效率类系数（mfu_prefill/bw_decode 全额、mem_util 半幅），见 tier_exponents。"),
}

SPEC: dict[str, dict] = {f"constants.{k}": meta for k, meta in CONSTANTS_SPEC}

TABLES = {
    "chip_profiles": dict(fields=CHIP_FIELDS, label="芯片效率档",
                          note="按芯片 8 条登记（910×3 / 950×5）；换硬件或改变实测效率时改这里。"),
    "tiers": dict(fields=TIER_FIELDS, label="档位缩放",
                  note="保守 0.8 / 均衡 1.0 / 激进 1.2；只作用于效率类系数，指数规则见 tier_exponents。"),
}

_OVERRIDES: dict = {}
_DEFAULTS: dict = {}
_LEGACY_OVERRIDES: dict = {}
_MIGRATION_NOTES: list[str] = []
_LOADED = False


def defaults() -> dict:
    global _DEFAULTS, _LOADED
    if not _LOADED:
        _DEFAULTS = json.loads(PATH.read_text(encoding="utf-8"))
        _LOADED = True
    return copy.deepcopy(_DEFAULTS)


def _merge(base: dict, patch: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in patch.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = _merge(out[key], value)
        else:
            out[key] = copy.deepcopy(value)
    return out


def current() -> dict:
    return _merge(defaults(), _OVERRIDES)


def overrides() -> dict:
    return copy.deepcopy(_OVERRIDES)


def migration_notes() -> list[str]:
    """启动时旧覆盖层的迁移记录（给 health/日志用）。"""
    return list(_MIGRATION_NOTES)


# 旧 chip 键 → 新 chip 键的效率档映射：旧 950 家族档作用于全部 5 张 950 卡
_LEGACY_CHIP_MAP = {
    "910b": ["910b"],
    "910c": ["910c"],
    "950": ["950pr32", "950pr", "950dt36", "950dt32", "950dt"],
}
# 旧 sensitivity 三档 → 新 tiers（乐观/中性/保守 → 激进/均衡/保守，系数取旧 mfu_mul）
_LEGACY_TIER_MAP = {"optimistic": "aggressive", "neutral": "standard", "conservative": "conservative"}
# 旧 coefficients → 新 constants 的同义字段
_LEGACY_CONST_MAP = ["moe_fill_tok", "dense_fill_tok", "moe_ffn_floor", "moe_ffn_ceil", "dense_ffn_lo", "rho_cap"]


def _looks_legacy(patch: dict) -> bool:
    return any(k in patch for k in ("limits", "aggregation", "coefficients", "timing", "sensitivity")) or (
        isinstance(patch.get("chip_profiles"), dict)
        and any(k in v for v in patch["chip_profiles"].values() if isinstance(v, dict)
                for k in ("bw_decode_moe30", "bw_prefill", "link_a2a"))
    )


def _migrate_legacy(patch: dict) -> tuple[dict, list[str]]:
    """把 v1 覆盖层里可映射的字段迁进 v2 结构；返回 (新覆盖层, 迁移记录)。"""
    out: dict = {}
    notes: list[str] = []

    for old_key, new_keys in _LEGACY_CHIP_MAP.items():
        prof = (patch.get("chip_profiles") or {}).get(old_key)
        if not isinstance(prof, dict):
            continue
        for field in ("mfu_prefill", "mfu_decode_ratio", "bw_decode"):
            if field in prof:
                for nk in new_keys:
                    out.setdefault("chip_profiles", {}).setdefault(nk, {})[field] = prof[field]
                notes.append(f"chip_profiles.{old_key}.{field} → {','.join(new_keys)}")
        dropped = [f for f in prof if f not in ("mfu_prefill", "mfu_decode_ratio", "bw_decode")]
        if dropped:
            notes.append(f"chip_profiles.{old_key}.{'/'.join(dropped)} 未映射，已丢弃")

    co = patch.get("coefficients") or {}
    for field in _LEGACY_CONST_MAP:
        if field in co:
            out.setdefault("constants", {})[field] = co[field]
            notes.append(f"coefficients.{field} → constants.{field}")

    sens = patch.get("sensitivity") or {}
    for old_tier, new_tier in _LEGACY_TIER_MAP.items():
        t = sens.get(old_tier)
        if isinstance(t, dict) and "mfu_mul" in t:
            out.setdefault("tiers", {}).setdefault(new_tier, {})["coef"] = t["mfu_mul"]
            notes.append(f"sensitivity.{old_tier}.mfu_mul → tiers.{new_tier}.coef")

    for group in ("limits", "aggregation", "timing"):
        if patch.get(group):
            notes.append(f"{group}.* 为旧引擎独有概念，未映射，已丢弃")
    return out, notes


def load(patch: dict | None) -> None:
    """启动时载入库里保存的覆盖层；旧结构自动迁移并记日志。"""
    global _OVERRIDES, _LEGACY_OVERRIDES, _MIGRATION_NOTES
    patch = copy.deepcopy(patch or {})
    _LEGACY_OVERRIDES = {}
    _MIGRATION_NOTES = []
    if _looks_legacy(patch):
        _LEGACY_OVERRIDES = patch  # 过渡期旧引擎（params_legacy）仍按原口径生效
        migrated, notes = _migrate_legacy(patch)
        _OVERRIDES = migrated
        _MIGRATION_NOTES = notes
        logger.warning(
            "检测到旧结构参数覆盖层（kind=inference-params）：已迁移 %d 项到 v2 结构，"
            "其余丢弃（用户需在 v2 参数页重新调参）。明细：%s",
            len(notes), "；".join(notes) or "无",
        )
    else:
        clean, errors = validate(patch)
        if errors:
            logger.warning("参数覆盖层含 %d 个非法项，已忽略：%s", len(errors),
                           "；".join(e.get("key", "") + " " + e["message"] for e in errors))
        _OVERRIDES = clean


def set_overrides(patch: dict) -> dict:
    """局部覆盖；返回新的覆盖层。校验由 validate 负责。"""
    global _OVERRIDES
    _OVERRIDES = _merge(_OVERRIDES, patch)
    return overrides()


def reset() -> None:
    global _OVERRIDES, _LEGACY_OVERRIDES
    _OVERRIDES = {}
    _LEGACY_OVERRIDES = {}


def validate(patch: dict) -> tuple[dict, list[dict]]:
    """按 SPEC 校验并规整覆盖值，返回 (清洗后, 错误列表)。

    除逐项范围校验外，还对「覆盖后的整体配置」做跨字段一致性检查。
    """
    clean: dict = {}
    errors: list[dict] = []
    if not isinstance(patch, dict):
        return {}, [dict(key="", message="参数必须是对象")]
    for group, payload in patch.items():
        if group in ("version", "updated", "notes", "tier_exponents"):
            continue
        if group in TABLES:
            table = TABLES[group]
            if not isinstance(payload, dict):
                errors.append(dict(key=group, message="必须是按档位分组的对象"))
                continue
            for name, fields in payload.items():
                if not isinstance(fields, dict):
                    errors.append(dict(key=f"{group}.{name}", message="必须是对象"))
                    continue
                for field, value in fields.items():
                    meta = table["fields"].get(field)
                    if meta is None:
                        errors.append(dict(key=f"{group}.{name}.{field}", message="未知参数"))
                        continue
                    parsed, message = _coerce(value, meta)
                    if message:
                        errors.append(dict(key=f"{group}.{name}.{field}", message=message))
                    else:
                        clean.setdefault(group, {}).setdefault(name, {})[field] = parsed
            continue
        if group != "constants":
            errors.append(dict(key=group, message="未知参数分组"))
            continue
        if not isinstance(payload, dict):
            errors.append(dict(key=group, message="必须是对象"))
            continue
        for field, value in payload.items():
            meta = SPEC.get(f"{group}.{field}")
            if meta is None:
                errors.append(dict(key=f"{group}.{field}", message="未知参数"))
                continue
            parsed, message = _coerce(value, meta)
            if message:
                errors.append(dict(key=f"{group}.{field}", message=message))
            else:
                clean.setdefault(group, {})[field] = parsed
    if not errors:
        effective = _merge(current(), clean)
        errors.extend(_coherence(effective))
    return clean, errors


def _coherence(cfg: dict) -> list[dict]:
    co = cfg["constants"]
    out: list[dict] = []

    def bad(key: str, message: str) -> None:
        out.append(dict(key=key, message=message))

    if co["moe_ffn_floor"] >= co["moe_ffn_ceil"]:
        bad("constants.moe_ffn_floor", "MoE FFN 利用率下限必须小于上限")
    if co["dense_ffn_lo"] >= 1:
        bad("constants.dense_ffn_lo", "Dense FFN 利用率下限必须小于 1")
    for key, tier in cfg["tiers"].items():
        if tier["coef"] <= 0:
            bad(f"tiers.{key}.coef", "档位缩放系数必须大于 0")
    return out


def _coerce(value, meta) -> tuple[float | int | str | None, str | None]:
    if meta["type"] == "text":
        if not isinstance(value, str) or not value.strip():
            return None, "必须是非空文本"
        if len(value) > meta.get("max_length", 40):
            return None, "文本过长"
        return value.strip(), None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None, "必须是数值"
    if meta["type"] == "int":
        if abs(value - round(value)) > 1e-9:
            return None, "必须是整数"
        value = int(round(value))
    else:
        value = float(value)
    if "min" in meta and value < meta["min"]:
        return None, f"不得小于 {meta['min']}"
    if "max" in meta and value > meta["max"]:
        return None, f"不得大于 {meta['max']}"
    return value, None


def describe() -> dict:
    """给前端渲染表单用的元数据（schema 驱动）。"""
    groups = [
        dict(key="constants", label="工程口径常数",
             fields=[dict(key=k.split(".", 1)[1], **v) for k, v in SPEC.items() if k.startswith("constants.")]),
    ]
    tables = [
        dict(key=key, label=table["label"], note=table["note"],
             fields=[dict(key=k, **v) for k, v in table["fields"].items()])
        for key, table in TABLES.items()
    ]
    readonly = dict(
        tier_exponents=defaults().get("tier_exponents", {}),
        note="tier_exponents 为档位缩放指数规则（效率类全额、mem_util 半幅），只读；"
             "mfu_decode_ratio 与 kv_reserve 不随档位缩放。",
    )
    return dict(groups=groups, tables=tables, readonly=readonly)
