"""推理算力评估引擎：还原《推理算力评估工具 · 2609V8》的 A/B/C 四约束链路。

链路：显存(A) → Prefill(B) → Decode(C) → 混部利用率抬升 → SLA 回验加 DP → 对齐扩容。

不可破坏的口径（改动前先读 docs/推理算力评估梳理-2609V8口径.md）：
1. 显存路径统一 GiB（÷1024³），带宽路径统一十进制 GB（÷1e9），两者不交叉。
2. 算力看激活参数，显存看总参数。
3. 卡数是三维取 max，不是相加；不设额外余量，只按 SLA 加 DP。
4. 需求 QPS 用「系统预测 E2E」自洽迭代，不是固定用目标 E2E。
5. 有效生成占比固定 100%，即所有在线会话同时出字。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.engine import params as _params

GIB = 1024.0 ** 3
GB = 1e9
N_CONV = GB / GIB

# 物理量：由精度决定，不属于可调参数
WEIGHT_BYTES = {"bf16": 2.0, "fp16": 2.0, "fp8": 1.0, "int8": 1.0, "int4": 0.5}
COMPUTE_BYTES = {"bf16": 2.0, "fp8": 1.0, "int8": 1.0, "int4": 0.5}
KV_BYTES = {"bf16": 2.0, "fp8": 1.0, "int8": 1.0}
PREC_NAMES = {"bf16": "BF16", "fp16": "FP16", "fp8": "FP8", "int8": "INT8", "int4": "INT4"}

# ------------------------------------------------------------------ 可配置常量
# 全部来自 catalogs/inference_params.json（可被运行时覆盖层替换，见 params.py）。
# 这里只做声明，具体值由下方 reload() 注入；改值不要改这个文件，改参数配置。

TP_INTRA_CAP = 8
MAX_NUM_SEQS = 256
CHUNK_AUTO = 4096
KV_BASE_SEQ = 4096
KV_DECAY_SPAN = 12288.0
SLA_PASS_TOL = 1.0
SLA_STOP_TOL = 1.10
E2E_ITERATIONS = 8
E2E_CLAMP = 100.0
DP_STEP_LIMIT = 12
TP_ESCALATE_LIMIT = 4

MARGIN_FACTOR = 1.20
MIXED_THR_HIGH = 1.03
MIXED_THR_MID = 1.05
MIXED_THR_LOW = 1.10
MIXED_CONC_HIGH = 256
MIXED_CONC_MID = 16
MIXED_SCALE_CAP = 1.5
KV_CAP_FLOOR = 0.5
TOPO_PP_PENALTY = 0.06
TOPO_EP_PENALTY = 0.08
DECODE_DP_STOP_RATIO = 0.995
TP_ESCALATE_STOP_RATIO = 0.995

CHIP_PROFILE: dict = {}
SENSITIVITY: dict = {}

K_PREFIX_FFN_RESIDUAL = 0.10
K_MOE_FILL_TOK = 800.0
K_DENSE_FILL_TOK = 5500.0
K_MOE_FFN_FLOOR = 0.07
K_MOE_FFN_CEIL = 0.50
K_DENSE_FFN_LO = 0.42
K_PF_MFU_MUL = 0.72
K_DEC_MFU_MUL = 1.25
K_MOE_ROUTE_SKEW = 1.08
K_KV_SLOPE = {True: 0.16, False: 0.12}
K_KV_FLOOR = {True: 0.70, False: 0.82}
K_KV_WALK0 = 0.08
K_BATCH_CONGESTION = 0.07
K_LONG_SEQ_DISCOUNT = 0.12
K_RHO_CAP = 0.95

PF_BASE_MS = 260.0
PF_MOE_TOK_MS = 140.0
PF_MOE_ACT_DIV = 13.0
PF_DENSE_MS = 70.0
PF_LAYER_MS_MOE = 3.0
PF_LAYER_MS_DENSE = 1.8
PF_PROMPT_CURVE = 0.85
PF_PROMPT_SCALE = 2048.0
PF_CARD_POW = 0.22
PF_TAIL_MOE = 1.2
PF_TAIL_DENSE = 0.45
PF_TAIL_DIV = 16384.0
PF_TAIL_CARD_POW = 0.2
DC_FIXED_BASE_MS = 0.6
DC_FIXED_LAYER_MS = 0.012
DC_FIXED_TAIL_MS = 0.75
TP_AR_FUDGE = 1.48
TP_AR_HOP_MS = 0.02
PP_BUBBLE_BATCH = 1.0
PP_BUBBLE_STEP = 0.24
KV_WALK_LAYER_DIV = 60.0
PF_BUDGET_CAP_S = 10.0
PF_BUDGET_CAP_LONG_S = 60.0
PF_BUDGET_LONG_TTFT_MS = 15000.0


def reload(config: dict | None = None) -> dict:
    """把参数配置刷进模块常量。config 为空时取 params.current()。"""
    global TP_INTRA_CAP, MAX_NUM_SEQS, CHUNK_AUTO, KV_BASE_SEQ, KV_DECAY_SPAN
    global SLA_PASS_TOL, SLA_STOP_TOL, E2E_ITERATIONS, E2E_CLAMP
    global DP_STEP_LIMIT, TP_ESCALATE_LIMIT
    global MARGIN_FACTOR, MIXED_THR_HIGH, MIXED_THR_MID, MIXED_THR_LOW
    global MIXED_CONC_HIGH, MIXED_CONC_MID, MIXED_SCALE_CAP, KV_CAP_FLOOR
    global TOPO_PP_PENALTY, TOPO_EP_PENALTY, DECODE_DP_STOP_RATIO, TP_ESCALATE_STOP_RATIO
    global K_PREFIX_FFN_RESIDUAL, K_MOE_FILL_TOK, K_DENSE_FILL_TOK
    global K_MOE_FFN_FLOOR, K_MOE_FFN_CEIL, K_DENSE_FFN_LO
    global K_PF_MFU_MUL, K_DEC_MFU_MUL, K_MOE_ROUTE_SKEW, K_KV_SLOPE, K_KV_FLOOR
    global K_KV_WALK0, K_BATCH_CONGESTION, K_LONG_SEQ_DISCOUNT, K_RHO_CAP
    global PF_BASE_MS, PF_MOE_TOK_MS, PF_MOE_ACT_DIV, PF_DENSE_MS
    global PF_LAYER_MS_MOE, PF_LAYER_MS_DENSE, PF_PROMPT_CURVE, PF_PROMPT_SCALE
    global PF_CARD_POW, PF_TAIL_MOE, PF_TAIL_DENSE, PF_TAIL_DIV, PF_TAIL_CARD_POW
    global DC_FIXED_BASE_MS, DC_FIXED_LAYER_MS, DC_FIXED_TAIL_MS
    global TP_AR_FUDGE, TP_AR_HOP_MS, PP_BUBBLE_BATCH, PP_BUBBLE_STEP, KV_WALK_LAYER_DIV
    global PF_BUDGET_CAP_S, PF_BUDGET_CAP_LONG_S, PF_BUDGET_LONG_TTFT_MS

    cfg = config if config is not None else _params.current()
    lim, agg, co, ti = cfg["limits"], cfg["aggregation"], cfg["coefficients"], cfg["timing"]

    TP_INTRA_CAP = int(lim["tp_intra_cap"])
    MAX_NUM_SEQS = int(lim["max_num_seqs"])
    CHUNK_AUTO = int(lim["chunk_auto"])
    KV_BASE_SEQ = float(lim["kv_base_seq"])
    KV_DECAY_SPAN = float(lim["kv_decay_span"])
    SLA_PASS_TOL = float(lim["sla_pass_tol"])
    SLA_STOP_TOL = float(lim["sla_stop_tol"])
    E2E_ITERATIONS = int(lim["e2e_iterations"])
    E2E_CLAMP = float(lim["e2e_clamp"])
    DP_STEP_LIMIT = int(lim["dp_step_limit"])
    TP_ESCALATE_LIMIT = int(lim["tp_escalate_limit"])

    MARGIN_FACTOR = float(agg["margin_factor"])
    MIXED_THR_HIGH = float(agg["mixed_threshold_high"])
    MIXED_THR_MID = float(agg["mixed_threshold_mid"])
    MIXED_THR_LOW = float(agg["mixed_threshold_low"])
    MIXED_CONC_HIGH = int(agg["mixed_conc_high"])
    MIXED_CONC_MID = int(agg["mixed_conc_mid"])
    MIXED_SCALE_CAP = float(agg["mixed_scale_cap"])
    KV_CAP_FLOOR = float(agg["kv_cap_floor"])
    TOPO_PP_PENALTY = float(agg["topo_pp_penalty"])
    TOPO_EP_PENALTY = float(agg["topo_ep_penalty"])
    DECODE_DP_STOP_RATIO = float(agg["decode_dp_stop_ratio"])
    TP_ESCALATE_STOP_RATIO = float(agg["tp_escalate_stop_ratio"])

    K_PREFIX_FFN_RESIDUAL = float(co["prefix_ffn_residual"])
    K_MOE_FILL_TOK = float(co["moe_fill_tok"])
    K_DENSE_FILL_TOK = float(co["dense_fill_tok"])
    K_MOE_FFN_FLOOR = float(co["moe_ffn_floor"])
    K_MOE_FFN_CEIL = float(co["moe_ffn_ceil"])
    K_DENSE_FFN_LO = float(co["dense_ffn_lo"])
    K_PF_MFU_MUL = float(co["pf_mfu_mul"])
    K_DEC_MFU_MUL = float(co["dec_mfu_mul"])
    K_MOE_ROUTE_SKEW = float(co["moe_route_skew"])
    K_KV_SLOPE = {True: float(co["kv_slope_moe"]), False: float(co["kv_slope_dense"])}
    K_KV_FLOOR = {True: float(co["kv_floor_moe"]), False: float(co["kv_floor_dense"])}
    K_KV_WALK0 = float(co["kv_walk0"])
    K_BATCH_CONGESTION = float(co["batch_congestion"])
    K_LONG_SEQ_DISCOUNT = float(co["long_seq_discount"])
    K_RHO_CAP = float(co["rho_cap"])

    PF_BASE_MS = float(ti["prefill_engine_base_ms"])
    PF_MOE_TOK_MS = float(ti["prefill_engine_moe_tok_ms"])
    PF_MOE_ACT_DIV = float(ti["prefill_engine_moe_act_div"])
    PF_DENSE_MS = float(ti["prefill_engine_dense_ms"])
    PF_LAYER_MS_MOE = float(ti["prefill_engine_layer_ms_moe"])
    PF_LAYER_MS_DENSE = float(ti["prefill_engine_layer_ms_dense"])
    PF_PROMPT_CURVE = float(ti["prefill_engine_prompt_curve"])
    PF_PROMPT_SCALE = float(ti["prefill_engine_prompt_scale"])
    PF_CARD_POW = float(ti["prefill_engine_card_pow"])
    PF_TAIL_MOE = float(ti["prefill_tail_moe"])
    PF_TAIL_DENSE = float(ti["prefill_tail_dense"])
    PF_TAIL_DIV = float(ti["prefill_tail_div"])
    PF_TAIL_CARD_POW = float(ti["prefill_tail_card_pow"])
    DC_FIXED_BASE_MS = float(ti["decode_fixed_base_ms"])
    DC_FIXED_LAYER_MS = float(ti["decode_fixed_layer_ms"])
    DC_FIXED_TAIL_MS = float(ti["decode_fixed_tail_ms"])
    TP_AR_FUDGE = float(ti["tp_allreduce_fudge"])
    TP_AR_HOP_MS = float(ti["tp_allreduce_hop_ms"])
    PP_BUBBLE_BATCH = float(ti["pp_bubble_batch"])
    PP_BUBBLE_STEP = float(ti["pp_bubble_step"])
    KV_WALK_LAYER_DIV = float(ti["kv_walk_layer_div"])
    PF_BUDGET_CAP_S = float(ti["prefill_budget_cap_s"])
    PF_BUDGET_CAP_LONG_S = float(ti["prefill_budget_cap_long_s"])
    PF_BUDGET_LONG_TTFT_MS = float(ti["prefill_budget_long_ttft_ms"])

    CHIP_PROFILE.clear()
    CHIP_PROFILE.update({k: dict(v) for k, v in cfg["chip_profiles"].items()})
    SENSITIVITY.clear()
    SENSITIVITY.update({k: dict(v) for k, v in cfg["sensitivity"].items()})
    return cfg


reload()


class InferenceIssue(Exception):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


# ---------------------------------------------------------------- 基础

def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _ceil(v):
    return max(1, math.ceil(v - 1e-9))


def _pow2_le(v):
    n = 1
    while 2 * n <= v:
        n *= 2
    return n


def _is_moe(model: dict) -> bool:
    return bool(model.get("experts")) and (model["total_b"] or 0) > (model["active_b"] or 0) + 0.5


def _arch(model: dict) -> str:
    if (model.get("latent_dim") or 0) > 0 or (model.get("rope_dim") or 0) > 0:
        return "mla"
    if (model.get("kv_heads") or 0) < (model.get("heads") or 1):
        return "gqa"
    return "mha"


def _attn_dim(model: dict) -> float:
    if _arch(model) == "mla":
        return float((model.get("qk_head_dim") or 0) + (model.get("v_head_dim") or 0))
    return float(model["head_dim"])


def _eff_layers(model: dict) -> float:
    return model["layers"] * _clamp(float(model.get("gqa_kv_fraction", 1) or 1), 0.0, 1.0)


def _model_gib(model: dict, weight_bytes: float) -> float:
    """权重显存（GiB）：总参 × 字节 ÷ 1024³。"""
    return model["total_b"] * GB * weight_bytes / GIB


def _traffic_gb(model: dict, weight_bytes: float) -> float:
    """权重搬运量（十进制 GB）：总参 × 字节。带宽路径专用，勿与 GiB 混用。"""
    return model["total_b"] * weight_bytes


def kv_bytes_per_token(model: dict, kv_bytes: float) -> float:
    """每 token KV 字节（十进制 GB）。源码口径：先 ÷1e9 得 GB。"""
    eff = _eff_layers(model)
    if _arch(model) == "mla":
        latent = model.get("latent_dim") or max(64, round(0.42 * model["hid"]))
        rope = max(0, int(model.get("rope_dim") or 64))
        return eff * (float(latent) + rope) * kv_bytes / GB
    kv_heads = float(model["kv_heads"])
    head_dim = float(model.get("kv_head_dim") or model["head_dim"])
    return 2 * eff * kv_heads * head_dim * kv_bytes / GB


def _seq_alloc(prompt: int, output: int, max_ctx: int) -> float:
    """每会话 KV 分配 token：窗口明显大于本轮占用时按窗口写满。"""
    raw = float(max_ctx) if max_ctx > prompt + output + 4096 else prompt + output / 2
    return _clamp(raw, 1.0, float(max(1, max_ctx)))


def _batched_cap(prompt: int) -> float:
    return 8192 if prompt <= 4096 else 16384 if prompt <= 32768 else 32768


def _moe_split(model: dict) -> dict:
    """把总参拆成共享专家 / 路由专家（按 active/total 反解共享比例）。"""
    total, active = float(model["total_b"]), float(model["active_b"])
    experts, top_k = model.get("experts") or 1, model.get("top_k") or 1
    if not experts or experts <= 1 or total <= 1.05 * active:
        return dict(shared=total, routed=0.0)
    e, k = max(2, int(experts)), max(1, min(int(top_k), max(2, int(experts)) - 1))
    raw = (active * e - k * total) / (e - k)
    cap = min(total, active)
    shared = 0.0 if not math.isfinite(raw) else _clamp(raw, 0.0, cap)
    return dict(shared=max(0.0, shared), routed=max(0.0, total - shared))


def _moe_hit(model: dict, batch: float) -> float:
    e = max(2, int(model.get("experts") or 2))
    k = max(1, min(int(model.get("top_k") or 8), e - 1))
    uniform = 1 - (1 - k / e) ** max(1.0, batch)
    return min(1.0, max(k / e, uniform) * K_MOE_ROUTE_SKEW)


def _moe_traffic(model: dict, weight_bytes: float, batch: float) -> dict:
    split, hit = _moe_split(model), _moe_hit(model, batch)
    shared_gb = split["shared"] * weight_bytes
    routed_gb = split["routed"] * weight_bytes
    return dict(gb=shared_gb + routed_gb * hit, hit=hit,
                shared_gb=shared_gb, routed_gb=routed_gb)


def _weight_per_card_gib(model, weight_bytes, tp, pp, ep, batch) -> float:
    if not _is_moe(model) or ep <= 1:
        return _model_gib(model, weight_bytes) / max(1, tp * pp)
    split = _moe_split(model)
    denom = max(1, tp * pp)
    return (split["shared"] * weight_bytes / GIB / denom
            + split["routed"] * weight_bytes / GIB * _moe_hit(model, batch) / (denom * ep))


def _activation_gib(model, conc, prompt, act_bytes, pp) -> dict:
    eff_bsz = max(1.0, min(conc, conc, MAX_NUM_SEQS))
    batch_tok = min(eff_bsz * min(max(1, prompt), CHUNK_AUTO), _batched_cap(prompt))
    ffn_width = max(float(model.get("ffn_mul") or 0) * 2, 3.0)
    ffn = batch_tok * model["hid"] * ffn_width * act_bytes / GIB
    base = batch_tok * model["hid"] * 3 * act_bytes / GIB
    amp = 1.0 if pp <= 1 else (1.15 if pp == 2 else 1.25 if pp == 3
                              else min(1.5, 1.2 + 0.05 * (pp - 4)))
    return dict(gib=max(ffn, base) * amp, batch_tok=batch_tok)


def _kv_cap_gib(tp, pp, ep, model, weight_bytes, act_gib, mem_fill, cm, batch) -> float:
    cards = max(1, tp) * max(1, pp) * max(1, ep)
    weight = _weight_per_card_gib(model, weight_bytes, tp, pp, ep, batch) * cards
    return max(0.0, cards * cm * mem_fill - weight - act_gib)


def _ep_candidates(model: dict) -> list[int]:
    if not _is_moe(model):
        return [1]
    e = int(model.get("experts") or 1)
    return [1] + [c for c in (2, 4, 8, 16, 32, 64) if c <= e and e % c == 0]


def _enumerate_memory(model, weight_bytes, cm, act_gib, kv_need_gib,
                      weight_min_cards, mem_fill, batch) -> dict:
    """枚举 EP×TP，取「总卡数×PP惩罚×EP惩罚」最小的显存方案。

    返回值额外带 `min_total`：全部可行拓扑的「总卡数最小值」（不带惩罚分）。
    惩罚分偏好 PP 小的部署方案，但在档位边界会让 best 在两个 total 不同
    的方案间切换（如 48 卡与 40 卡互换），把部署偏好泄漏进卡数下界会造成
    并发-卡数非单调。下界类结论（n_memory）必须用 min_total。
    """
    best = None
    min_total = None
    for ep in _ep_candidates(model):
        tp = 1
        while tp <= TP_INTRA_CAP:
            pp = max(1, math.ceil(weight_min_cards / tp))
            unit = tp * pp * ep
            cap = _kv_cap_gib(tp, pp, ep, model, weight_bytes, act_gib, mem_fill, cm, batch)
            if cap > KV_CAP_FLOOR:
                inst = _ceil(kv_need_gib / cap)
                total = inst * unit
                if min_total is None or total < min_total:
                    min_total = total
                score = total * (1 + TOPO_PP_PENALTY * (pp - 2) if pp > 2 else 1.0)
                if ep > 1:
                    score *= 1 + TOPO_EP_PENALTY * math.log2(ep)
                if (best is None or score < best["score"] - 1e-12
                        or (abs(score - best["score"]) <= 1e-12 and ep < best["ep"])):
                    best = dict(tp=tp, pp=pp, ep=ep, dp=inst, unit=unit,
                                kv_cap=cap, total=total)
                    best["score"] = score
            tp *= 2
    if best is None:
        tp = _pow2_le(max(1, min(TP_INTRA_CAP, weight_min_cards)))
        pp = max(1, math.ceil(weight_min_cards / tp))
        unit = tp * pp
        cap = max(0.1, _kv_cap_gib(tp, pp, 1, model, weight_bytes, act_gib, mem_fill, cm, batch))
        dp = _ceil(kv_need_gib / cap)
        best = dict(tp=tp, pp=pp, ep=1, dp=dp, unit=unit, kv_cap=cap,
                    total=dp * unit, score=0.0)
        min_total = best["total"]
    best["weight_min_cards"] = weight_min_cards
    best["min_total"] = min_total if min_total is not None else best["total"]
    return best


def _ffn_fill(model, moe, new_tok, rl, cards) -> float:
    if moe:
        e = max(2, int(model.get("experts") or 2))
        k = max(1, min(int(model.get("top_k") or 8), e - 1))
        load = max(1.0, new_tok) * k / e
        r = 1 - math.exp(-load / K_MOE_FILL_TOK)
        fill = K_MOE_FFN_FLOOR + (K_MOE_FFN_CEIL - K_MOE_FFN_FLOOR) * r
        return _clamp(fill * min(1.15, 1 + 0.05 * math.log2(max(1, cards))),
                      K_MOE_FFN_FLOOR, 0.70)
    r = 1 - math.exp(-max(1.0, rl) / K_DENSE_FILL_TOK)
    return K_DENSE_FFN_LO + (1 - K_DENSE_FFN_LO) * r


def _prefill_mfu(base_mfu, rl) -> float:
    curve = 1 - math.exp(-max(1.0, rl) / 512)
    gain = math.sqrt(min(1.0, max(1.0, rl) / 128))
    return max(0.05, base_mfu * max(0.45, min(1.0, 0.45 + 0.55 * curve * gain)) * K_PF_MFU_MUL)


def _decode_mfu(base_mfu, ratio, batch) -> float:
    sat = 1 - math.exp(-max(1.0, batch) / 4)
    return max(0.05, base_mfu * ratio * max(0.6, min(1.0, 0.6 + 0.4 * sat)) * K_DEC_MFU_MUL)


def _kv_decay(seq, moe) -> float:
    t = max(0.0, (max(1.0, seq) - KV_BASE_SEQ) / KV_DECAY_SPAN)
    return max(K_KV_FLOOR[moe], 1 - K_KV_SLOPE[moe] * min(1.35, t))


def _prefill_engine_ms(model, moe, cards, active_b, prompt) -> float:
    layers, cards = max(1, int(model["layers"])), max(1, cards)
    core = (PF_BASE_MS
            + (PF_MOE_TOK_MS * _clamp(active_b / PF_MOE_ACT_DIV, 0.75, 1.8) if moe else PF_DENSE_MS)
            + (PF_LAYER_MS_MOE if moe else PF_LAYER_MS_DENSE) * layers)
    ramp = PF_PROMPT_CURVE + (1 - PF_PROMPT_CURVE) * (1 - math.exp(-prompt / PF_PROMPT_SCALE))
    core *= ramp / (cards ** PF_CARD_POW)
    tail = (PF_TAIL_MOE if moe else PF_TAIL_DENSE) * layers * (prompt / PF_TAIL_DIV) / (cards ** PF_TAIL_CARD_POW)
    return core + tail


def _roofline(t_comp, t_hbm, t_comm, overlap, engine) -> dict:
    k = max(t_comp, t_hbm, t_comm)
    total = t_comp + t_hbm + t_comm
    return dict(t_comp=t_comp, t_hbm=t_hbm, t_comm=t_comm, ideal=k,
                roof=k + overlap * max(0.0, total - k) + engine)


def _a2a_ms(model, ep, batch, act_bytes, link_gbs, util) -> float:
    if ep <= 1:
        return 0.0
    layers = max(1, int(model.get("layers") or 1))
    payload = (batch * model["hid"] * (model.get("top_k") or 8) * act_bytes
               * 2 * (ep - 1) / ep * layers / GB)
    return payload / max(1e-9, link_gbs * util) * 1000


def _hop_ms(model, ep, link_gbs) -> float:
    if ep <= 1:
        return 0.0
    per_hop = _clamp(0.08 * (56 / max(1.0, link_gbs)), 0.03, 0.12)
    return per_hop * max(1, int(model.get("layers") or 1)) * math.log2(max(2, ep))


def _tp_allreduce_ms(model, tp: int, pp: int, batch: float, link_gbs: float,
                     fudge: float | None = None) -> float:
    """TP 张量并行的 AllReduce 时延。

    单步搬运 = 2 × batch × PP × hid × 2 字节；按环形 AllReduce 的 2(TP−1)/TP 折减，
    再除以「互联带宽 × 集合通信效率」。TP>2 时追加逐层跳数时延。
    """
    if tp <= 1:
        return 0.0
    layers = max(1, int(model["layers"]))
    payload = 2 * max(1.0, batch) * max(1, pp) * model["hid"] * 2
    efficiency = max(0.15, 1.0 / max(1.0, TP_AR_FUDGE if fudge is None else fudge))
    ring = payload * layers * (2 * (tp - 1) / tp)
    value = ring / (GB * max(1e-9, link_gbs) * efficiency) * 1000
    if tp > 2:
        value += TP_AR_HOP_MS * layers * math.log2(tp)
    return value


def _pp_bubble_ms(model, pp: int, batch: float) -> float:
    """PP 流水线气泡：每级一批的填充/排空代价。"""
    if pp <= 1:
        return 0.0
    return PP_BUBBLE_BATCH * (pp - 1) / max(1.0, batch) + PP_BUBBLE_STEP * (pp - 1)


def _decode_fixed_ms(model) -> float:
    return DC_FIXED_BASE_MS + DC_FIXED_LAYER_MS * max(1, int(model["layers"])) + DC_FIXED_TAIL_MS


def _kv_walk_ms(model, seq, moe, walk_mul) -> float:
    if not moe or (model.get("active_b") or 0) < 15:
        return 0.0
    return (K_KV_WALK0 * max(0.4, walk_mul) * (seq / KV_BASE_SEQ)
            * (max(1, int(model["layers"])) / KV_WALK_LAYER_DIV))


def _decode_cards(st: _State, tp: int, pp: int, ep: int, unit: int,
                  e2e_target: float, mem_min_cards: int) -> dict:
    """Decode 约束卡数：带宽约束与吞吐约束取大。

    - 带宽约束：按 TPOT 剩余预算反解单副本可承载会话数，再取整成副本数；
    - 吞吐约束：目标 token 吞吐 ÷ 单实例算力上限。
    权重地板已超 TPOT 时，加 DP 摊不薄单步权重读取，故不再按会话数放大副本，
    只保留显存方案要求的最小卡数，并标记为不可达（应改 TP 或换芯片）。
    """
    batch = st.eff_bsz_all
    step = _decode_step(st, tp, pp, ep, batch)
    unreachable = step["floor_ms"] > 1.001 * st.tpot_target
    if unreachable:
        # 带宽地板已超目标：DP 无助于缩短单步，按显存最小规模报，并等待拓扑择优
        n_bw = max(unit, mem_min_cards)
        n_thr = max(unit, _ceil(batch * st.output
                                / max(1e-6, e2e_target / 1000.0)
                                / max(1e-9, step["ceiling"])) * unit)
        return dict(n_dc=n_bw, n_bw=n_bw, n_thr=n_thr, step=step, unreachable=True)

    kv_budget = max(0.0, (st.tpot_target - step["floor_ms"]) / 1000.0
                    * _clamp(st.u_kv_dc, 0.12, 0.8)
                    * _kv_decay(st.kv_seq_len, st.moe) * st.bw_gbs)
    per_req = st.kv_bpt * st.kv_seq_len
    max_per_rep = kv_budget * max(1, tp * pp) / per_req if per_req > 0 else batch
    if max_per_rep <= 0:
        reps = max(1, int(round(batch)))
    else:
        reps = max(1, min(int(batch), math.ceil(batch / max(1e-9, max_per_rep))))
    n_bw = reps * unit
    target_tps = batch * st.output / max(1e-6, e2e_target / 1000.0)
    n_thr = max(unit, _ceil(target_tps / max(1e-9, step["ceiling"])) * unit)
    return dict(n_dc=max(n_bw, n_thr), n_bw=n_bw, n_thr=n_thr,
                step=step, unreachable=False)


def _tp_candidates(model: dict) -> list[int]:
    """TP 候选集：2 的幂；非 MoE 额外允许 3 与 6（源工具同口径，可减少卡数）。"""
    out = [1, 2, 4, 8]
    if not _is_moe(model):
        out = [1, 2, 3, 4, 6, 8]
    return [t for t in out if t <= TP_INTRA_CAP]


def _select_topology(st: _State, target_cards: int, floor_cards: int,
                     allow_scale: bool = False, cap_cards: int | None = None) -> dict:
    """在给定卡数下选 TP×PP×EP×DP。

    默认策略（卡数优先）：只保留卡数最小的方案，再用单步时延打破平局。
    allow_scale=True 时（SLA 不达标场景）放宽到 cap_cards 以内，
    优先找单步时延可达标的方案——即「宁可多加卡，也要把 TPOT 压下来」。
    物理依据：TP 越大，单卡需读的权重越少，Decode 带宽时间越短；
    代价是 TP AllReduce 跳数增加，两者在某个 TP 处达到平衡。
    """
    cap = cap_cards if cap_cards else max(target_cards, floor_cards)
    ep_options = _ep_candidates(st.model) if st.moe else [1]
    candidates = []
    for ep in ep_options:
        for tp in _tp_candidates(st.model):
            pp = max(1, math.ceil(st.weight_min_cards / tp))
            unit = tp * pp * ep
            if _kv_cap_gib(tp, pp, ep, st.model, st.prec["w_bytes"], 0.0,
                           st.p["mem_fill"], st.cm, st.eff_bsz_all) <= KV_CAP_FLOOR:
                continue
            for dp in range(1, max(2, math.ceil(cap / unit)) + 1):
                cards = unit * dp
                if cards < max(target_cards, floor_cards) or cards > cap:
                    continue
                batch = max(1.0, st.eff_bsz_all / dp)
                step = _decode_step(st, tp, pp, ep, batch)
                candidates.append(dict(tp=tp, pp=pp, ep=ep, dp=dp, unit=unit,
                                       cards=cards, step=step, batch=batch))
    if not candidates:
        unit = st.unit
        dp = max(1, math.ceil(max(target_cards, floor_cards) / unit))
        return dict(tp=1, pp=1, ep=1, dp=dp, unit=unit, cards=unit * dp,
                    batch=max(1.0, st.eff_bsz_all / dp),
                    step=_decode_step(st, 1, 1, 1, max(1.0, st.eff_bsz_all / dp)))

    if allow_scale:
        # 先找能同时满足 TTFT/TPOT 的最小卡数方案；找不到则取单步最快的
        ok = [c for c in candidates if c["step"]["ms"] <= st.tpot_target]
        pool = ok or candidates
        pool.sort(key=lambda c: (c["cards"], round(c["step"]["ms"], 3), c["ep"], c["tp"]))
        return pool[0]

    min_cards = min(c["cards"] for c in candidates)
    pool = [c for c in candidates if c["cards"] == min_cards]
    pool.sort(key=lambda c: (round(c["step"]["ms"], 3), c["ep"], c["tp"]))
    return pool[0]


def _resolve_precision(model, chip, weight_prec, kv_prec) -> dict:
    """W/A/C 三轴；910B/910C 无原生 INT4，A 轴强制降为 INT8。"""
    recommended = "int8" if (model["total_b"] > 14
                             or _model_gib(model, 2.0) > 0.85 * chip["memory_gb"]) else "bf16"
    weight = weight_prec if weight_prec in WEIGHT_BYTES else recommended
    compute, forced = weight, False
    if compute == "int4" and not chip.get("native_int4"):
        compute, forced = "int8", True
    kv = kv_prec if kv_prec in KV_BYTES else ("bf16" if weight in ("bf16", "fp16") else "fp8")
    dequant = (1.04 if chip.get("native_int4") else 1.06) if weight == "int4" else 1.0
    return dict(weight=weight, compute=compute, kv=kv,
                w_bytes=WEIGHT_BYTES[weight], a_bytes=COMPUTE_BYTES[compute],
                kv_bytes=KV_BYTES[kv], recommended=recommended,
                int4_forced_to_int8=forced, dequant=dequant)


# ---------------------------------------------------------------- 状态

@dataclass
class _State:
    model: dict
    prec: dict
    p: dict
    prof: dict
    moe: bool
    prompt: int
    output: int
    max_ctx: int
    conc: float
    ttft_target: float
    tpot_target: float
    prefix_hit: float
    cf: float
    bw_gbs: float
    cm: float
    link: float
    kv_bpt: float
    kv_seq_len: float
    new_tok: int
    chunks: int
    raw_flops: float
    attn_flops: float
    ffn_flops: float
    dec_attn: float
    dec_linear: float
    mfu_pf: float
    mfu_dc: float
    u_weight_dc: float
    u_kv_dc: float
    u_moe_dc: float
    u_weight_pf: float
    u_kv_pf: float
    weight_gib: float
    weight_min_cards: int
    unit: int
    batch_tok: float
    eff_bsz_all: float
    extras: dict = field(default_factory=dict)


def _decode_step(st: _State, tp: int, pp: int, ep: int, batch: float) -> dict:
    """Decode 单步：带宽 / 算力 / 通信取 max，加重叠惩罚与固定开销。"""
    shard_w = max(1, tp * ep)
    if st.moe and ep > 1:
        info = _moe_traffic(st.model, st.prec["w_bytes"], batch)
        weight_ms = (info["shared_gb"] / shard_w / max(1e-9, st.bw_gbs * st.u_weight_dc) * 1000
                     + info["routed_gb"] * info["hit"] / shard_w
                     / max(1e-9, st.bw_gbs * st.u_moe_dc) * 1000)
    else:
        weight_ms = (_traffic_gb(st.model, st.prec["w_bytes"])
                     / max(1, tp * (ep if st.moe else 1))
                     / max(1e-9, st.bw_gbs * st.u_weight_dc) * 1000)
    eff_kv = _clamp(st.u_kv_dc * _kv_decay(st.kv_seq_len, st.moe), 0.1, 0.8)
    kv_gb = st.kv_bpt * st.kv_seq_len * max(1.0, batch) / max(1, tp * pp)
    kv_ms = kv_gb / max(1e-9, st.bw_gbs * eff_kv) * 1000
    t_bw = weight_ms + kv_ms

    congest = 1 + K_BATCH_CONGESTION * math.log2(max(1.0, batch))
    t_comp = ((st.dec_attn / (1e12 * st.cf * max(1, tp) * st.mfu_dc)
               + st.dec_linear / (1e12 * st.cf * max(1, tp * ep) * st.mfu_dc))
              * 1000 * congest)
    comm = 0.0
    if st.moe and ep > 1:
        comm = max(_a2a_ms(st.model, ep, batch, st.prec["a_bytes"], st.link,
                           st.prof["link_a2a"]), _hop_ms(st.model, ep, st.link))
    step = max(t_bw, t_comp, comm)
    total = t_bw + t_comp + comm
    tp_ar = _tp_allreduce_ms(st.model, tp, pp, batch, st.link)
    pp_bubble = _pp_bubble_ms(st.model, pp, batch)
    fixed = _decode_fixed_ms(st.model) + _kv_walk_ms(st.model, st.kv_seq_len, st.moe,
                                                    st.p["kv_walk_mul"])
    floor_ms = weight_ms + (st.kv_bpt / max(1, tp * pp)) / max(1e-9, st.bw_gbs * eff_kv) * 1000
    return dict(ms=(step + st.p["decode_overlap"] * max(0.0, total - step)
                    + tp_ar + pp_bubble + fixed),
                bw=t_bw, comp=t_comp, comm=comm, fixed=fixed,
                tp_allreduce=tp_ar, pp_bubble=pp_bubble,
                ceiling=1e12 * st.cf * max(1, tp) * st.mfu_dc
                        / max(1e-9, st.dec_attn + st.dec_linear),
                floor_ms=floor_ms, weight_ms=weight_ms)


def _ttft(st: _State, tp: int, pp: int, ep: int, dp: int, step_ms: float,
          conc: float, e2e_pred: float) -> dict:
    """TTFT = Prefill 服务时间 + max(排队残余, 槽位等待) + 分块插入等待。"""
    cards = max(1, tp * pp * ep * dp)
    t_comp = ((st.attn_flops / (1e12 * st.cf * max(1, tp) * st.mfu_pf)
               + st.ffn_flops / (1e12 * st.cf * max(1, tp * ep) * st.mfu_pf)) * 1000)
    t_hbm = 1000 * (_traffic_gb(st.model, st.prec["w_bytes"])
                    / max(1e-9, st.bw_gbs * st.u_weight_pf)
                    + st.kv_bpt * st.prompt / max(1e-9, st.bw_gbs * st.u_kv_pf))
    t_comm = 0.0
    if st.moe and ep > 1:
        t_comm = max(_a2a_ms(st.model, ep, 1.0, st.prec["a_bytes"], st.link,
                             st.prof["link_a2a"]), _hop_ms(st.model, ep, st.link))
    engine = _prefill_engine_ms(st.model, st.moe, cards, st.model["active_b"], st.prompt)
    roof = _roofline(t_comp, t_hbm, t_comm, st.p["roof_overlap"], engine)

    eff_bsz = max(1.0, st.eff_bsz_all / max(1, dp))
    arrival = conc / max(1e-6, e2e_pred / 1000.0)
    service = roof["roof"] / 1000.0
    decode_hold = max(0.0, st.tpot_target * max(0, st.output - 1) / 1000.0)
    rho = min(K_RHO_CAP, arrival * service / max(1e-9, service + decode_hold))
    residual = 0.5 * service * rho * 1000
    slot_share = max(1.0, eff_bsz / MAX_NUM_SEQS)
    slot_wait = (slot_share - 1) * step_ms if slot_share > 1 else 0.0
    chunks = max(1, math.ceil(st.new_tok / CHUNK_AUTO))
    return dict(ms=roof["roof"] + max(residual, slot_wait) + chunks * step_ms,
                roof=roof, residual=residual, slot_wait=slot_wait,
                engine=engine, chunks=chunks)


def _mixed_floor(floor, n_memory, n_pf, n_dc, demand_pf, ql, conc, cf, moe,
                 model, weight_min_cards, dec_attn, dec_linear, excess,
                 eff_bsz, mfu_dc):
    """混部利用率抬升：Prefill 与 Decode 抢同一批卡时上调下界。"""
    u_pf = demand_pf / max(1e-9, floor * ql)
    dec_tflops = (dec_attn + dec_linear) * max(1.0, eff_bsz) / 1e12
    u_dc = max(dec_tflops / max(1e-9, floor * cf * mfu_dc),
               min(MIXED_SCALE_CAP, 0.7 * n_dc / max(1, floor)))
    threshold = (MIXED_THR_HIGH if conc >= MIXED_CONC_HIGH
                 else MIXED_THR_MID if conc >= MIXED_CONC_MID else MIXED_THR_LOW)
    exempt = (not moe) and weight_min_cards == 1 and (model.get("active_b") or 0) < 30
    lifted = (u_pf + u_dc) > threshold and not exempt
    mixed = max(n_memory, math.ceil(max(n_pf, n_dc) * (u_pf + u_dc))) if lifted else floor
    return mixed, u_pf, u_dc, threshold, lifted


# ---------------------------------------------------------------- 主链路

def estimate(request: dict, models: list[dict], chips: list[dict], scenes: list[dict],
             profile: str = "neutral") -> dict:
    """单场景推理算力与卡数评估。

    request: model_key / chip_key / weight_precision / kv_precision / scene_key /
             concurrency / prompt_len / output_len / ttft_target_ms / tpot_target_ms / prefix_hit
    """
    p = SENSITIVITY.get(profile) or SENSITIVITY["neutral"]
    model = next((m for m in models if m["key"] == request.get("model_key")), None)
    if model is None:
        raise InferenceIssue("MISSING_MODEL", "请选择可用模型")
    chip = next((c for c in chips if c["key"] == request.get("chip_key")), None)
    if chip is None:
        raise InferenceIssue("MISSING_CHIP", "请选择算力服务器")
    scene = next((s for s in scenes if s["key"] == request.get("scene_key")), None)
    if scene is None:
        scene = next((s for s in scenes if s["key"] == "custom"), None)
    if scene is None:
        raise InferenceIssue("MISSING_SCENE", "请选择业务场景类型")

    prompt = int(request.get("prompt_len") or scene["prompt_len"])
    output = int(request.get("output_len") or scene["output_len"])
    max_ctx = max(prompt + output, int(request.get("max_ctx") or scene["max_ctx"]))
    conc = float(request.get("concurrency") or scene["concurrency"])
    ttft_target = float(request.get("ttft_target_ms") or scene["ttft_ms"])
    tpot_target = float(request.get("tpot_target_ms") or scene["tpot_ms"])
    prefix_hit = _clamp(float(request.get("prefix_hit") or 0), 0.0, 0.9)
    if prompt < 100 or output < 100:
        raise InferenceIssue("INVALID_SCENE", "输入与输出长度均不得小于 100 token")
    if conc < 1:
        raise InferenceIssue("INVALID_SCENE", "并发会话数至少为 1")
    if ttft_target < 50 or tpot_target < 1:
        raise InferenceIssue("INVALID_SLA", "TTFT 目标至少 50ms，TPOT 目标至少 1ms")

    prec = _resolve_precision(model, chip, request.get("weight_precision") or "",
                              request.get("kv_precision") or "auto")
    prof = CHIP_PROFILE.get(chip.get("family") or "950", CHIP_PROFILE["950"])
    moe = _is_moe(model)
    warnings: list[str] = []

    mem_fill, kv_reserve = p["mem_fill"], p["kv_reserve"]
    base_mfu = _clamp(prof["mfu_prefill"] * p["mfu_mul"], 0.1, 0.7)
    dec_ratio = _clamp(prof["mfu_decode_ratio"] * p["decode_mul"], 0.2, 0.95)
    bw_decode = _clamp(prof["bw_decode"] * p["bw_mul"], 0.2, 0.92)
    if moe and (model["active_b"] or 0) >= 30:
        bw_decode = _clamp(prof["bw_decode_moe30"] * p["bw_mul"], 0.2, 0.92)
    bw_prefill = _clamp(prof["bw_prefill"] * p["bw_mul"], 0.2, 0.95)

    if prec["compute"] == "int4":
        cf = float(chip.get("int4_tflops") or chip["int8_tflops"])
    elif prec["compute"] in ("int8", "fp8"):
        cf = float(chip["int8_tflops"])
    else:
        cf = float(chip["bf16_tflops"])
    bw_gbs = chip["hbm_tbs"] * 1000.0
    cm, link = float(chip["memory_gb"]), float(chip["link_gbs"])

    # ---------------- 显存（A）
    weight_gib = _model_gib(model, prec["w_bytes"])
    weight_min_cards = _ceil(weight_gib / max(0.1, cm * mem_fill))
    kv_bpt = kv_bytes_per_token(model, prec["kv_bytes"])
    kv_alloc_len = _seq_alloc(prompt, output, max_ctx)
    kv_seq_len = prompt + output / 2
    if model.get("attn_span"):
        kv_seq_len = min(kv_seq_len, model["attn_span"])
    kv_seq_len = _clamp(kv_seq_len, 1.0, float(max_ctx))
    kv_need_gib = kv_bpt * N_CONV * kv_alloc_len * conc * kv_reserve
    # 有效批（全量口径）：所有在线会话同时出字（生成占比 100%），聚合批就是
    # 并发本身，与 kv_need_gib 的全量 conc 口径一致（min(conc, 256×⌈conc/256⌉)）。
    # 单实例槽位上限由 _ttft 的 slot_wait 与 SLA 段的 dp 下限约束，不在批口径截断。
    # 旧实现 min(conc, MAX_NUM_SEQS) 会在并发跨 256 后低估单步 KV 搬运与
    # Decode 副本需求，与显存维度的全量口径相互矛盾。
    eff_bsz_all = max(1.0, conc)
    act = _activation_gib(model, conc, prompt, prec["a_bytes"], 1)
    mem_plan = _enumerate_memory(model, prec["w_bytes"], cm, act["gib"], kv_need_gib,
                                 weight_min_cards, mem_fill, eff_bsz_all)
    # 卡数下界用 min_total（全部可行拓扑的最小总卡数，不带部署惩罚分）：
    # 惩罚分只决定「选哪个拓扑部署」，档位边界会引导 best 在 total 不同的
    # 方案间切换，若用它当下界会把部署偏好泄漏成卡数非单调。
    n_memory = max(weight_min_cards, mem_plan["min_total"])
    tp, pp, ep = max(1, mem_plan["tp"]), max(1, mem_plan["pp"]), max(1, mem_plan["ep"])
    unit = max(1, tp * pp * ep)
    if _arch(model) == "mla":
        warnings.append("MLA_KV_PROXY")
    if model.get("attn_span"):
        warnings.append("ATTN_SPAN_CAPPED")

    # ---------------- Prefill 单请求计算量
    new_tok = max(1, round(prompt * (1 - prefix_hit)))
    prefix_tok = max(0, prompt - new_tok)
    rl = new_tok + K_PREFIX_FFN_RESIDUAL * prefix_tok
    span = prefix_tok + (new_tok + 1) / 2
    if model.get("attn_span"):
        span = min(span, model["attn_span"])
    fill = _ffn_fill(model, moe, new_tok, rl, n_memory)
    ffn_flops = 2 * model["active_b"] * GB * rl / max(0.08, fill)
    attn_coef = 2 if _arch(model) == "mla" else 4
    attn_flops = attn_coef * _eff_layers(model) * model["heads"] * _attn_dim(model) * new_tok * span
    raw_flops = ffn_flops + attn_flops
    overhead = prec["dequant"]
    mfu_pf = _prefill_mfu(base_mfu, rl)

    chunks = max(1, math.ceil(new_tok / CHUNK_AUTO))
    weight_read = _traffic_gb(model, prec["w_bytes"]) * (new_tok / max(1.0, act["batch_tok"])) * chunks
    kv_read = kv_bpt * prompt
    total_read = max(1e-9, weight_read + kv_read)
    intensity = raw_flops / (GB * total_read)
    weighted = total_read / max(1e-9, weight_read / _clamp(bw_prefill * 1.05, 0.15, 0.9)
                                + kv_read / _clamp(bw_prefill * 0.85, 0.12, 0.8))
    bw_ceiling = GB * bw_gbs * intensity * weighted / 1e12
    ql = min(cf * mfu_pf, bw_ceiling)
    bw_limited = bw_ceiling < cf * mfu_pf

    dec_attn = attn_coef * _eff_layers(model) * model["heads"] * _attn_dim(model) * kv_seq_len
    dec_linear = 2 * model["active_b"] * GB
    mfu_dc = _decode_mfu(base_mfu, dec_ratio, eff_bsz_all)

    st = _State(
        model=model, prec=prec, p=p, prof=prof, moe=moe, prompt=prompt, output=output,
        max_ctx=max_ctx, conc=conc, ttft_target=ttft_target, tpot_target=tpot_target,
        prefix_hit=prefix_hit, cf=cf, bw_gbs=bw_gbs, cm=cm, link=link,
        kv_bpt=kv_bpt, kv_seq_len=kv_seq_len, new_tok=new_tok, chunks=chunks,
        raw_flops=raw_flops, attn_flops=attn_flops, ffn_flops=ffn_flops,
        dec_attn=dec_attn, dec_linear=dec_linear, mfu_pf=mfu_pf, mfu_dc=mfu_dc,
        u_weight_dc=_clamp(bw_decode * 1.05, 0.15, 0.9),
        u_kv_dc=_clamp(bw_decode * 0.82, 0.12, 0.8),
        u_moe_dc=_clamp(bw_decode * 0.72, 0.1, 0.75),
        u_weight_pf=_clamp(bw_prefill * 1.05, 0.15, 0.9),
        u_kv_pf=_clamp(bw_prefill * 0.85, 0.12, 0.8),
        weight_gib=weight_gib, weight_min_cards=weight_min_cards, unit=unit,
        batch_tok=act["batch_tok"], eff_bsz_all=eff_bsz_all)

    # ---------------- 闭环：需求 QPS 依赖系统预测 E2E
    e2e_target = ttft_target + tpot_target * max(0, output - 1)
    e2e_pred = e2e_target
    flops_per_req = raw_flops * overhead
    # A/B/C 三维都在显存方案给定的拓扑上算（与源工具一致），
    # 最终交给 _select_topology 在目标卡数下重选 TP/PP/EP。
    mem_tp, mem_pp, mem_ep, mem_unit = tp, pp, ep, unit
    n_pf = n_pf_thr = n_pf_lat = 1
    n_dc = n_dc_bw = n_dc_thr = 1
    dp = max(1, mem_plan["dp"])
    step = _decode_step(st, mem_tp, mem_pp, mem_ep, eff_bsz_all)
    sim = _ttft(st, mem_tp, mem_pp, mem_ep, dp, step["ms"], conc, e2e_pred)
    ttft_ms, tpot_ms = sim["ms"], step["ms"]
    mixed = float(max(n_memory, 1))
    u_pf = u_dc = 0.0
    threshold, lifted = 1.10, False

    for _ in range(E2E_ITERATIONS):
        qps_pf = conc / max(1e-6, e2e_pred / 1000.0)
        demand_pf = flops_per_req * qps_pf / 1e12

        # ---- B：Prefill 吞吐约束与时延约束取大
        n_pf_thr = _ceil((demand_pf / max(1e-9, ql))
                         / (1 + K_LONG_SEQ_DISCOUNT * math.log2(max(1, prompt / 16384))))
        cap_budget = (PF_BUDGET_CAP_LONG_S if ttft_target > PF_BUDGET_LONG_TTFT_MS
                      else PF_BUDGET_CAP_S)
        jl = _ceil(raw_flops / (1e12 * ql * min(max(0.001, ttft_target / 1000), cap_budget)))
        engine_z = _prefill_engine_ms(model, moe,
                                      max(1, weight_min_cards, min(TP_INTRA_CAP, jl)),
                                      model["active_b"], prompt)
        budget = min(max(0.001, (ttft_target - engine_z) / 1000), cap_budget)
        n_pf_lat = _ceil(raw_flops / (1e12 * ql * max(0.001, budget)))
        n_pf = max(n_pf_thr, min(n_pf_lat, TP_INTRA_CAP))

        # ---- C：Decode 约束（带宽反解副本数 + 吞吐约束）
        dec = _decode_cards(st, mem_tp, mem_pp, mem_ep, mem_unit, e2e_target, n_memory)
        n_dc, n_dc_bw, n_dc_thr = dec["n_dc"], dec["n_bw"], dec["n_thr"]

        # ---- 三维取 max + 混部利用率抬升
        floor = max(n_memory, n_pf, n_dc)
        mixed, u_pf, u_dc, threshold, lifted = _mixed_floor(
            floor, n_memory, n_pf, n_dc, demand_pf, ql, conc, cf, moe, model,
            weight_min_cards, dec_attn, dec_linear, 0, eff_bsz_all, mfu_dc)

        # ---- 在目标卡数下重选拓扑，再回算 TTFT/TPOT
        topo = _select_topology(st, mixed, weight_min_cards)
        tp, pp, ep, dp, unit = topo["tp"], topo["pp"], topo["ep"], topo["dp"], topo["unit"]
        st.unit = unit
        step = topo["step"]
        sim = _ttft(st, tp, pp, ep, dp, step["ms"], conc, e2e_pred)
        ttft_ms, tpot_ms = sim["ms"], step["ms"]
        # 预测 E2E 取「本轮实测 TTFT + TPOT×(输出−1)」，并夹在目标值的 1/100 ~ 100 倍
        predicted = ttft_ms + tpot_ms * max(0, output - 1)
        new_pred = _clamp(predicted, e2e_target / E2E_CLAMP, e2e_target * E2E_CLAMP)
        if abs(new_pred - e2e_pred) <= max(1.0, 0.001 * e2e_target):
            e2e_pred = new_pred
            break
        # 阻尼迭代：避免在自洽点附近来回震荡
        e2e_pred = 0.5 * e2e_pred + 0.5 * new_pred

    qps_pf = conc / max(1e-6, e2e_pred / 1000.0)
    demand_pf = flops_per_req * qps_pf / 1e12

    # ---------------- SLA 回验
    # 对每个可行拓扑（TP×PP×EP）求「满足 TTFT/TPOT 的最小 dp」，再取全局卡数最小者。
    # dp 下限是拓扑无关的卡数下界 n_memory（随并发单调不减），不由 mem_plan["dp"]
    # 决定——显存枚举器在总卡数相同的方案间（如 TP1×dp2 与 TP2×dp1）切换时
    # dp 会翻转，把它设为全局下限会让卡数随并发非单调。
    # n_pf/n_dc 不进下限：n_pf 依赖 e2e_pred 自洽迭代的收敛点，档位边界有
    # ±1 档离散噪声；吞吐不足由 SLA 时延判定兜底（ttft/tpot 达标才入选）。
    # TTFT 机内不可达（ttft_infeasible）时 SLA 必不达标，与「全拓扑搜索无解」
    # 走同一兜底：取各拓扑 dp 下限的最小卡方案并如实报 SLA_NOT_MET。
    ttft_infeasible = n_pf_lat > TP_INTRA_CAP
    if ttft_infeasible:
        warnings.append("TTFT_NOT_REACHABLE_IN_NODE")
    best = None  # (cards, tp, pp, ep, dp, unit, step, sim)
    fallback = None
    dp_cap = max(1, min(int(math.floor(eff_bsz_all)),
                        max(1, n_memory) + DP_STEP_LIMIT * max(1, TP_ESCALATE_LIMIT)))
    for ep_opt in (_ep_candidates(model) if moe else [1]):
        for tp_opt in _tp_candidates(model):
            pp_opt = max(1, math.ceil(weight_min_cards / tp_opt))
            unit_opt = tp_opt * pp_opt * ep_opt
            cap_opt = _kv_cap_gib(tp_opt, pp_opt, ep_opt, model, prec["w_bytes"],
                                  0.0, st.p["mem_fill"], st.cm, eff_bsz_all)
            if cap_opt <= KV_CAP_FLOOR:
                continue
            # 该拓扑的显存下限：总卡数不低于 n_memory，且 dp 个副本的
            # 总 KV 容量装下全部并发。
            dp_floor_opt = max(1, _ceil(n_memory / unit_opt),
                               _ceil(kv_need_gib / cap_opt))
            for dp_opt in range(dp_floor_opt, dp_cap + 1):
                batch = max(1.0, eff_bsz_all / dp_opt)
                step_opt = _decode_step(st, tp_opt, pp_opt, ep_opt, batch)
                if step_opt["floor_ms"] > 1.001 * tpot_target:
                    break  # 权重地板超预算，加 DP 无济于事
                sim_opt = _ttft(st, tp_opt, pp_opt, ep_opt, dp_opt,
                                step_opt["ms"], conc, e2e_pred)
                cand = (unit_opt * dp_opt, tp_opt, pp_opt, ep_opt, dp_opt,
                        unit_opt, step_opt, sim_opt)
                if (fallback is None or cand[0] < fallback[0]
                        or (cand[0] == fallback[0]
                            and step_opt["ms"] < fallback[6]["ms"])):
                    fallback = cand
                if (not ttft_infeasible
                        and sim_opt["ms"] <= ttft_target * SLA_STOP_TOL
                        and step_opt["ms"] <= tpot_target * SLA_STOP_TOL):
                    if (best is None or cand[0] < best[0]
                            or (cand[0] == best[0]
                                and step_opt["ms"] < best[6]["ms"])):
                        best = cand
                    break  # 该拓扑最小满足 dp 已找到，更大 dp 只会多卡
    if best is None:
        # SLA 不可达：按显存下限给最小卡方案并如实报告
        best = fallback
    _, tp, pp, ep, dp, unit, step, sim = best
    ttft_ms, tpot_ms = sim["ms"], step["ms"]

    cards = max(1, dp * unit)
    passed = ttft_ms <= ttft_target * SLA_PASS_TOL and tpot_ms <= tpot_target * SLA_PASS_TOL
    floor = max(n_memory, n_pf, n_dc)
    if ttft_infeasible:
        warnings.append("TTFT_NOT_REACHABLE_IN_NODE")
    if not passed:
        warnings.append("SLA_NOT_MET")
    # 带宽地板：SLA 未达标且选中方案的权重地板已吃掉绝大部分 TPOT 预算
    # （即使机内最大 TP/EP 分摊也压不下去），说明卡数不是瓶颈、带宽才是，
    # 加卡无效。占比判定而非超限判定：地板占预算 98% 以上时，其余固定
    # 开销（通信、逐层固定项）必然把单步推过目标，结论同样是加卡无效。
    if not passed and step["floor_ms"] >= 0.98 * tpot_target:
        warnings.append("BANDWIDTH_FLOOR")
    if sim["slot_wait"] > 0:
        warnings.append("SLOT_OVERSOLD")
    if bw_limited:
        warnings.append("PREFILL_BANDWIDTH_LIMITED")
    if lifted:
        warnings.append("MIXED_UTIL_LIFTED")

    bottleneck = ("显存" if n_memory >= max(n_pf, n_dc) - 0.5
                  else "Prefill" if n_pf >= n_dc - 0.5 else "Decode")
    margin = max(cards + unit, math.ceil(MARGIN_FACTOR * cards / unit) * unit)
    micro = dec_attn + dec_linear
    instance_tps = 1e12 * cf * max(1, tp) * mfu_dc / max(1e-9, micro)

    return {
        "model_key": model["key"], "model_label": model.get("label") or model["key"],
        "chip_key": chip["key"], "chip_label": chip.get("label") or chip["key"],
        "scene_key": scene["key"], "scene_name": scene.get("name") or scene["key"],
        "profile": profile, "profile_label": p["label"],
        "arch": "MoE" if moe else "Dense", "moe": moe,
        "precision": {**prec, "compute_tflops": cf,
                      "label": f"W{PREC_NAMES[prec['weight']]}/A{PREC_NAMES[prec['compute']]}"
                               f"/KV{PREC_NAMES[prec['kv']]}"},
        "workload": dict(prompt_len=prompt, output_len=output, max_ctx=max_ctx,
                         concurrency=conc, ttft_target_ms=ttft_target,
                         tpot_target_ms=tpot_target, prefix_hit=prefix_hit,
                         e2e_target_ms=e2e_target, e2e_predicted_ms=e2e_pred,
                         qps_demand=qps_pf),
        "memory": dict(n_memory=n_memory, weight_gib=weight_gib,
                       weight_min_cards=weight_min_cards, kv_bytes_per_token=kv_bpt,
                       kv_need_gib=kv_need_gib, kv_alloc_len=kv_alloc_len,
                       kv_decode_len=kv_seq_len, activation_gib=act["gib"],
                       kv_reserve=kv_reserve, mem_fill=mem_fill,
                       kv_cap_gib=mem_plan["kv_cap"], status="COMPLETE"),
        "prefill": dict(n_pf=n_pf, n_pf_throughput=n_pf_thr, n_pf_latency=n_pf_lat,
                        flops_per_request=flops_per_req, ffn_flops=ffn_flops,
                        attn_flops=attn_flops, ffn_fill=fill, mfu=mfu_pf,
                        effective_tflops=ql, bandwidth_limited=bw_limited,
                        engine_ms=sim["engine"], roof_ms=sim["roof"]["roof"],
                        demand_tflops=demand_pf),
        "decode": dict(n_dc=n_dc, n_dc_bw=n_dc_bw, n_dc_thr=n_dc_thr, tpot_ms=tpot_ms,
                       mfu=mfu_dc, step_bw_ms=step["bw"], step_compute_ms=step["comp"],
                       step_comm_ms=step["comm"], step_fixed_ms=step["fixed"],
                       instance_tps=instance_tps,
                       eff_batch=max(1.0, eff_bsz_all / max(1, dp)),
                       weight_floor_ms=step["floor_ms"],
                       bandwidth_floor_blocked=("BANDWIDTH_FLOOR" in warnings)),
        "mixed": dict(floor=floor, mixed_floor=mixed, u_prefill=u_pf, u_decode=u_dc,
                      threshold=threshold, lifted=lifted),
        "sla": dict(ttft_ms=ttft_ms, tpot_ms=tpot_ms, ttft_target=ttft_target,
                    tpot_target=tpot_target, passed=passed, dp=dp,
                    queue_ms=sim["residual"], slot_wait_ms=sim["slot_wait"]),
        "topology": dict(tp=tp, pp=pp, ep=ep, dp=dp, unit=unit, cards=cards,
                         text=f"TP{tp}×PP{pp}" + (f"×EP{ep}" if moe else "") + f"×DP{dp}"),
        "result": dict(cards=cards, floor=floor, mixed_floor=mixed, margin_cards=margin,
                       cards_per_server=TP_INTRA_CAP,
                       servers=max(1, math.ceil(cards / TP_INTRA_CAP)),
                       capacity_tflops=cards * cf, capacity_p=cards * cf / 1000,
                       demand_p=demand_pf / 1000,
                       bottleneck=bottleneck, bandwidth_limited=bw_limited),
        "warnings": warnings,
    }
