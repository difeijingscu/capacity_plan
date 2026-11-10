"""推理引擎的可配置参数：默认值 + 运行时覆盖 + 校验。

设计约定：
1. 默认值只在 `catalogs/inference_params.json` 里，代码不重复写数字；
2. 运行时改动作为「覆盖层」存在数据库（store kind=inference_params），
   与默认值分开存放，因此升级默认值不会抹掉用户的调参；
3. 每个可改字段都在 `SPEC` 里登记类型与取值范围，越界一律拒绝（不静默截断），
   这样前端可以直接按 SPEC 渲染表单，后端也不会接受脏值。

物理量（每参数字节、GB/GiB 换算、芯片算力与显存带宽）不在参数里，
它们来自 `inference_chips.json`，改动属于换硬件而不是调经验值。
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / "catalogs" / "inference_params.json"

NUMBER = dict(type="number")
INT = dict(type="int")


def _spec(table: dict, group: str, entries: list[tuple]) -> dict:
    out = {}
    for key, meta in entries:
        out[f"{group}.{key}"] = meta
    return out


LIMIT_SPEC = [
    ("tp_intra_cap", dict(INT, min=1, max=64, label="机内张量并行上限（卡/实例）",
                          note="超过这个数就要跨机，互联代价另算；昇腾整机通常为 8。")),
    ("max_num_seqs", dict(INT, min=1, max=4096, label="连续批上限（并发槽位）",
                          note="引擎按这个上限切分有效批，超出部分排队等待。")),
    ("chunk_auto", dict(INT, min=256, max=131072, label="分块预填充粒度（token）",
                        note="长输入按块插入 Decode，块越大单次打断越久。")),
    ("kv_base_seq", dict(INT, min=512, max=65536, label="KV 带宽衰减基准长度（token）",
                         note="低于该长度不衰减。")),
    ("kv_decay_span", dict(NUMBER, min=1024, max=262144, label="KV 衰减跨度（token）",
                           note="每超出基准一个跨度，带宽效率下降一个斜率。")),
    ("sla_pass_tol", dict(NUMBER, min=0.5, max=2.0, label="SLA 判定容差",
                          note="1.0 表示严格达标；略大于 1 可容忍工程误差。")),
    ("sla_stop_tol", dict(NUMBER, min=0.5, max=3.0, label="加 DP 停止容差",
                          note="时延进入目标的这个倍数内就停止扩张。")),
    ("e2e_iterations", dict(INT, min=1, max=50, label="E2E 自洽迭代次数",
                            note="需求 QPS 依赖系统预测 E2E，迭代到收敛。")),
    ("e2e_clamp", dict(NUMBER, min=1.0, max=1000.0, label="E2E 预测夹持倍数",
                       note="防止迭代发散，预测值被夹在目标值的 1/N ~ N 倍。")),
    ("dp_step_limit", dict(INT, min=0, max=100, label="加 DP 最大轮数",
                           note="每轮只在单步时间确有下降时才继续。")),
    ("tp_escalate_limit", dict(INT, min=0, max=16, label="放大 TP 最大轮数",
                               note="DP 压不下去时改放大 TP，减少单卡权重读取。")),
]

AGG_SPEC = [
    ("margin_factor", dict(NUMBER, min=1.0, max=3.0, label="扩容余量倍数",
                           note="最终卡数按此倍数向上取整到整实例。")),
    ("mixed_threshold_high", dict(NUMBER, min=0.5, max=3.0, label="混部抬升阈值·高并发",
                                  note="并发 ≥ 高并发门限时使用的利用率阈值。")),
    ("mixed_threshold_mid", dict(NUMBER, min=0.5, max=3.0, label="混部抬升阈值·中并发")),
    ("mixed_threshold_low", dict(NUMBER, min=0.5, max=3.0, label="混部抬升阈值·低并发")),
    ("mixed_conc_high", dict(INT, min=1, max=100000, label="高并发门限（会话）")),
    ("mixed_conc_mid", dict(INT, min=1, max=100000, label="中并发门限（会话）")),
    ("mixed_scale_cap", dict(NUMBER, min=1.0, max=5.0, label="混部抬升封顶倍数")),
    ("kv_cap_floor", dict(NUMBER, min=0.0, max=64.0, label="单卡可用 KV 下限（GiB）",
                          note="低于该值视为方案不可行，向上换 TP/PP。")),
    ("topo_pp_penalty", dict(NUMBER, min=0.0, max=1.0, label="拓扑评分·PP 惩罚系数",
                             note="同等卡数下，PP>2 的方案评分上浮，避免不必要的流水线切分。")),
    ("topo_ep_penalty", dict(NUMBER, min=0.0, max=1.0, label="拓扑评分·EP 惩罚系数",
                             note="EP 越大跨机通信越多，按 log2(EP) 计惩罚。")),
    ("decode_dp_stop_ratio", dict(NUMBER, min=0.5, max=1.0, label="加 DP 改善判定比",
                                  note="单步时间下降不到这个比例就停止加 DP。")),
    ("tp_escalate_stop_ratio", dict(NUMBER, min=0.5, max=1.0, label="放大 TP 改善判定比")),
]

COEF_SPEC = [
    ("prefix_ffn_residual", dict(NUMBER, min=0.0, max=1.0, label="Prefix 命中后残余 FFN 比例",
                                 note="命中复用的前缀仍要走一部分 FFN，按这个比例计。")),
    ("moe_fill_tok", dict(NUMBER, min=16, max=20000, label="MoE FFN 填满特征长度（token）",
                          note="批量越大专家块填得越满，指数趋近上限。")),
    ("dense_fill_tok", dict(NUMBER, min=16, max=50000, label="Dense FFN 填满特征长度（token）")),
    ("moe_ffn_floor", dict(NUMBER, min=0.01, max=1.0, label="MoE FFN 填充率下限")),
    ("moe_ffn_ceil", dict(NUMBER, min=0.01, max=1.0, label="MoE FFN 填充率上限")),
    ("dense_ffn_lo", dict(NUMBER, min=0.01, max=1.0, label="Dense FFN 填充率下限")),
    ("pf_mfu_mul", dict(NUMBER, min=0.2, max=2.0, label="Prefill MFU 修正系数")),
    ("dec_mfu_mul", dict(NUMBER, min=0.2, max=2.0, label="Decode MFU 修正系数")),
    ("moe_route_skew", dict(NUMBER, min=1.0, max=2.0, label="MoE 路由倾斜系数",
                            note="专家负载不均导致实际要读的权重比理论命中率更高。")),
    ("kv_slope_moe", dict(NUMBER, min=0.0, max=0.5, label="KV 带宽衰减斜率·MoE")),
    ("kv_slope_dense", dict(NUMBER, min=0.0, max=0.5, label="KV 带宽衰减斜率·Dense")),
    ("kv_floor_moe", dict(NUMBER, min=0.1, max=1.0, label="KV 带宽效率地板·MoE")),
    ("kv_floor_dense", dict(NUMBER, min=0.1, max=1.0, label="KV 带宽效率地板·Dense")),
    ("kv_walk0", dict(NUMBER, min=0.0, max=1.0, label="KV 遍历附加耗时系数（ms/基准长度）")),
    ("batch_congestion", dict(NUMBER, min=0.0, max=0.5, label="批量拥塞系数",
                              note="Decode 算力随批量的对数增长放大。")),
    ("long_seq_discount", dict(NUMBER, min=0.0, max=0.5, label="长序列吞吐折扣",
                               note="输入越长，Prefill 有效吞吐按 log2(输入/16k) 折扣。")),
    ("rho_cap", dict(NUMBER, min=0.5, max=1.0, label="排队利用率上限")),
]

TIMING_SPEC = [
    ("prefill_engine_base_ms", dict(NUMBER, min=0.0, max=5000.0, label="Prefill 引擎固定开销（ms）")),
    ("prefill_engine_moe_tok_ms", dict(NUMBER, min=0.0, max=5000.0, label="Prefill 引擎 MoE 规模项系数")),
    ("prefill_engine_moe_act_div", dict(NUMBER, min=0.1, max=500.0, label="Prefill 引擎 MoE 规模归一化（B 激活）")),
    ("prefill_engine_dense_ms", dict(NUMBER, min=0.0, max=5000.0, label="Prefill 引擎 Dense 规模项（ms）")),
    ("prefill_engine_layer_ms_moe", dict(NUMBER, min=0.0, max=100.0, label="Prefill 每层开销·MoE（ms）")),
    ("prefill_engine_layer_ms_dense", dict(NUMBER, min=0.0, max=100.0, label="Prefill 每层开销·Dense（ms）")),
    ("prefill_engine_prompt_curve", dict(NUMBER, min=0.0, max=1.0, label="Prefill 长输入斜坡下限")),
    ("prefill_engine_prompt_scale", dict(NUMBER, min=1.0, max=262144.0, label="Prefill 长输入斜坡尺度（token）")),
    ("prefill_engine_card_pow", dict(NUMBER, min=0.0, max=1.0, label="Prefill 卡数摊薄指数")),
    ("prefill_tail_moe", dict(NUMBER, min=0.0, max=10.0, label="Prefill 尾部开销·MoE")),
    ("prefill_tail_dense", dict(NUMBER, min=0.0, max=10.0, label="Prefill 尾部开销·Dense")),
    ("prefill_tail_div", dict(NUMBER, min=1.0, max=1048576.0, label="Prefill 尾部归一化长度（token）")),
    ("prefill_tail_card_pow", dict(NUMBER, min=0.0, max=1.0, label="Prefill 尾部卡数摊薄指数")),
    ("decode_fixed_base_ms", dict(NUMBER, min=0.0, max=100.0, label="Decode 固定开销基数（ms）")),
    ("decode_fixed_layer_ms", dict(NUMBER, min=0.0, max=1.0, label="Decode 每层固定开销（ms）")),
    ("decode_fixed_tail_ms", dict(NUMBER, min=0.0, max=100.0, label="Decode 调度与采样开销（ms）")),
    ("tp_allreduce_fudge", dict(NUMBER, min=1.0, max=4.0, label="TP AllReduce 折损系数",
                                note="越大表示集合通信效率越低。")),
    ("tp_allreduce_hop_ms", dict(NUMBER, min=0.0, max=1.0, label="TP 逐层跳数开销（ms）")),
    ("pp_bubble_batch", dict(NUMBER, min=0.0, max=10.0, label="PP 气泡·批量项系数")),
    ("pp_bubble_step", dict(NUMBER, min=0.0, max=10.0, label="PP 气泡·级数项（ms）")),
    ("kv_walk_layer_div", dict(NUMBER, min=1.0, max=1000.0, label="KV 遍历层数归一化")),
    ("prefill_budget_cap_s", dict(NUMBER, min=1.0, max=300.0, label="Prefill 算力预算上限（秒）",
                                  note="常规场景按首 Token 目标折算算力预算，最多给到这个时长。")),
    ("prefill_budget_cap_long_s", dict(NUMBER, min=1.0, max=600.0, label="Prefill 算力预算上限·长首 Token（秒）")),
    ("prefill_budget_long_ttft_ms", dict(INT, min=1000, max=120000, label="长首 Token 门限（ms）",
                                         note="TTFT 目标超过该值时改用长预算上限。")),
]

CHIP_FIELDS = {
    "mfu_prefill": dict(NUMBER, min=0.05, max=0.95, label="Prefill MFU"),
    "mfu_decode_ratio": dict(NUMBER, min=0.05, max=0.95, label="Decode MFU 相对比"),
    "bw_decode": dict(NUMBER, min=0.05, max=0.98, label="Decode 带宽利用率"),
    "bw_decode_moe30": dict(NUMBER, min=0.05, max=0.98, label="Decode 带宽利用率（MoE≥30B 激活）"),
    "bw_prefill": dict(NUMBER, min=0.05, max=0.98, label="Prefill 带宽利用率"),
    "link_a2a": dict(NUMBER, min=0.05, max=0.98, label="互联 All-to-All 效率"),
}

SENS_FIELDS = {
    "label": dict(type="text", max_length=20, label="档位名称"),
    "mfu_mul": dict(NUMBER, min=0.2, max=2.0, label="MFU 乘子"),
    "decode_mul": dict(NUMBER, min=0.2, max=2.0, label="Decode 乘子"),
    "mem_fill": dict(NUMBER, min=0.5, max=0.99, label="显存利用率"),
    "bw_mul": dict(NUMBER, min=0.2, max=2.0, label="带宽乘子"),
    "kv_reserve": dict(NUMBER, min=0.5, max=2.0, label="KV 预留系数"),
    "roof_overlap": dict(NUMBER, min=0.0, max=1.0, label="Prefill 重叠系数"),
    "decode_overlap": dict(NUMBER, min=0.0, max=1.0, label="Decode 重叠惩罚"),
    "kv_walk_mul": dict(NUMBER, min=0.2, max=3.0, label="KV 遍历乘子"),
}

SPEC: dict[str, dict] = {}
SPEC.update(_spec(None, "limits", LIMIT_SPEC))
SPEC.update(_spec(None, "aggregation", AGG_SPEC))
SPEC.update(_spec(None, "coefficients", COEF_SPEC))
SPEC.update(_spec(None, "timing", TIMING_SPEC))

TABLES = {
    "chip_profiles": dict(fields=CHIP_FIELDS, label="芯片效率档",
                          note="按芯片家族登记；换硬件或改变实测效率时改这里。"),
    "sensitivity": dict(fields=SENS_FIELDS, label="敏感度三档",
                        note="同一输入的乐观/中性/保守结果通常相差 15%~30%。"),
}

_OVERRIDES: dict = {}
_DEFAULTS: dict = {}
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


def load(patch: dict | None) -> None:
    """启动时载入库里保存的覆盖层。"""
    global _OVERRIDES
    _OVERRIDES = copy.deepcopy(patch or {})


def set_overrides(patch: dict) -> dict:
    """局部覆盖；返回新的覆盖层。校验由 validate 负责。"""
    global _OVERRIDES
    _OVERRIDES = _merge(_OVERRIDES, patch)
    return overrides()


def reset() -> None:
    global _OVERRIDES
    _OVERRIDES = {}


def validate(patch: dict) -> tuple[dict, list[dict]]:
    """按 SPEC 校验并规整覆盖值，返回 (清洗后, 错误列表)。

    除逐项范围校验外，还会对「覆盖后的整体配置」做跨字段一致性检查，
    避免出现 MoE 填充率下限高于上限这类能导出结果但毫无意义的组合。
    """
    clean: dict = {}
    errors: list[dict] = []
    if not isinstance(patch, dict):
        return {}, [dict(key="", message="参数必须是对象")]
    for group, payload in patch.items():
        if group in ("version",):
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
        if group not in ("limits", "aggregation", "coefficients", "timing"):
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
    co, agg, lim = cfg["coefficients"], cfg["aggregation"], cfg["limits"]
    out: list[dict] = []

    def bad(key: str, message: str) -> None:
        out.append(dict(key=key, message=message))

    if co["moe_ffn_floor"] >= co["moe_ffn_ceil"]:
        bad("coefficients.moe_ffn_floor", "MoE 填充率下限必须小于上限")
    if co["dense_ffn_lo"] >= 1:
        bad("coefficients.dense_ffn_lo", "Dense 填充率下限必须小于 1")
    if agg["mixed_threshold_high"] > agg["mixed_threshold_mid"]:
        bad("aggregation.mixed_threshold_high", "高并发阈值不得大于中并发阈值（并发越高，允许的利用率越紧）")
    if agg["mixed_threshold_mid"] > agg["mixed_threshold_low"]:
        bad("aggregation.mixed_threshold_mid", "中并发阈值不得大于低并发阈值")
    if agg["mixed_conc_high"] <= agg["mixed_conc_mid"]:
        bad("aggregation.mixed_conc_high", "高并发门限必须大于中并发门限")
    if lim["sla_stop_tol"] < lim["sla_pass_tol"]:
        bad("limits.sla_stop_tol", "加 DP 停止容差不得小于判定容差")
    if lim["e2e_clamp"] <= 1:
        bad("limits.e2e_clamp", "夹持倍数必须大于 1")
    if lim["chunk_auto"] > lim["max_num_seqs"] * 512:
        bad("limits.chunk_auto", "分块粒度相对批上限过大，请复核")
    for key, value in cfg["sensitivity"].items():
        if value["mem_fill"] <= 0.5:
            bad(f"sensitivity.{key}.mem_fill", "显存利用率必须大于 50%")
        if value["kv_reserve"] < 1:
            bad(f"sensitivity.{key}.kv_reserve", "KV 预留系数应不小于 1")
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
    """给前端渲染表单用的元数据。"""
    groups = [
        dict(key="limits", label="规模与迭代上限",
             fields=[dict(key=k.split(".", 1)[1], **v) for k, v in SPEC.items() if k.startswith("limits.")]),
        dict(key="aggregation", label="卡数聚合与混部",
             fields=[dict(key=k.split(".", 1)[1], **v) for k, v in SPEC.items() if k.startswith("aggregation.")]),
        dict(key="coefficients", label="效率与填充率系数",
             fields=[dict(key=k.split(".", 1)[1], **v) for k, v in SPEC.items() if k.startswith("coefficients.")]),
        dict(key="timing", label="时延常数项",
             fields=[dict(key=k.split(".", 1)[1], **v) for k, v in SPEC.items() if k.startswith("timing.")]),
    ]
    tables = [
        dict(key=key, label=table["label"], note=table["note"],
             fields=[dict(key=k, **v) for k, v in table["fields"].items()])
        for key, table in TABLES.items()
    ]
    return dict(groups=groups, tables=tables)
