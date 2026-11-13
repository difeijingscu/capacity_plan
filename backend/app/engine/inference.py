"""推理算力评估引擎 v2.0.0：忠实移植推理评估页（inference-eval.html）的 A/B/C 三维约束引擎。

移植来源：frontend/public/inference-eval.html script#2 纯函数引擎
（与 tools/eval_engine.mjs 逐字对应，黄金值基准见 backend/tests/golden_eval_engine.json）。

链路（页面口径）：
- A 显存约束 = 权重装载宽度（TP 对齐）× 副本数（KV 容量）；
- B Prefill 约束（TTFT）：吞吐下限 N1 与 M/G/1 排队时延下限 N2 取 max；
- C Decode 约束（TPOT）：枚举 分片宽度 × 副本数，取满足步长目标的最小卡数；
- 单场景卡数 = max(A, B, C)，奇数补偶；瓶颈 = 主导约束；不设任何余量。

与旧引擎（v1.0.0）的差异（切换计划 docs/切换计划-推理评估逻辑统一-v2.0.md）：
- 删除：混部利用率抬升、SLA 回验加 DP、TP×PP×EP×DP 拓扑枚举、margin_factor 1.2；
- 新口径 = 恰好满足 SLA 的最小卡数，余量由池层 headroom 表达（余量只在池层乘一次）。

口径约定（延续既有铁律）：
- 卡数（物理台数）与算力（P，BF16 基准）不同量纲，不能相加比较；
- 三维约束取 max 不相加；
- 显存/带宽数值均为十进制 GB 口径（与页面一致，不再区分 GiB）；
- 引擎全部常数经 engine/params.py（v2 结构）注入，芯片/模型/场景从 catalog 读。

低层函数（mem_constraint / prefill_constraint / decode_constraint / evaluate / aggregate）
接收页面形态的入参（见 _model_view / _chip_view / _precision_of），
与黄金值逐项比对；`estimate()` 是面向 catalog 与 API 请求的高层入口。
"""
from __future__ import annotations

import math

from app.engine import params as _params

# ---------------------------------------------------------------- 精度档（页面 PRECISIONS）
PRECISIONS: dict[str, dict] = {
    "bf16": dict(label="BF16 · W16A16", w=2.0, a_key="cf_fp16", a_label="BF16/FP16 峰值", kv=2.0, need_native_int4=False),
    "w8a8": dict(label="W8A8 · INT8/FP8", w=1.0, a_key="cf_int8", a_label="INT8/FP8 峰值", kv=1.0, need_native_int4=False),
    "w4a8": dict(label="W4A8 · INT4 权重", w=0.5, a_key="cf_int8", a_label="INT8 激活峰值", kv=1.0, need_native_int4=True),
}
# 旧精度值迁移映射（兼容读；schema 保留旧枚举，resolve 层映射，前端只展示新 4 项）
PRECISION_ALIASES = {"fp16": "bf16", "fp8": "w8a8", "int8": "w8a8", "int4": "w4a8",
                     "": "bf16", "auto": "bf16"}

# 档位：schema 的 profile（乐观/中性/保守）映射到页面 tier（激进/均衡/保守）
PROFILE_TIER = {"optimistic": "aggressive", "neutral": "standard", "conservative": "conservative"}
TIERS = {"conservative": "保守", "standard": "均衡", "aggressive": "激进"}

BOTTLENECK_LABEL = {"mem": "显存", "prefill": "Prefill", "decode": "Decode"}

# 芯片效率系数的合法区间（页面 ENG_RANGES.chip；档位缩放后夹取）
_CHIP_RANGES = {
    "mfuP": (0.05, 0.60),
    "mfuDRatio": (0.20, 1.50),
    "bwUtilD": (0.30, 0.95),
    "kvReserve": (1.00, 1.50),
    "memUtil": (0.50, 0.95),
}
# 档位缩放指数（页面 TIER_EXP）：效率类全额、mem_util 半幅；比值与结构开销不缩放。
# 指数规则本体在 catalogs/inference_params.json 的 tier_exponents（只读），这里做键名适配。
_TIER_EXP_KEYS = {"mfuP": "mfu_prefill", "bwUtilD": "bw_decode", "memUtil": "mem_util"}


class InferenceIssue(Exception):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


# ---------------------------------------------------------------- 目录视图适配
# catalog（snake_case）→ 页面引擎（camelCase）。只做键名转换，不改任何数值。

def _model_view(m: dict) -> dict:
    return {
        "key": m["key"],
        "total": float(m["total_b"]),
        "active": float(m["active_b"]),
        "hid": float(m["hid"]),
        "lay": float(m["layers"]),
        "heads": float(m["heads"]),
        "kvh": m.get("kv_heads"),
        "experts": m.get("experts") or 0,
        "topK": m.get("top_k"),
        "ffn": m.get("ffn_mul"),
        "headDim": m.get("head_dim"),
        "kvHeadDim": m.get("kv_head_dim"),
        "attnSpan": m.get("attn_span") or 0,
        "latentDim": m.get("latent_dim") or 0,
        "ropeDim": m.get("rope_dim") or 0,
        "qkHeadDim": m.get("qk_head_dim"),
        "vHeadDim": m.get("v_head_dim"),
        "gqaKvFraction": m.get("gqa_kv_fraction") or 0,
        "arch": m.get("arch"),
    }


def _chip_view(c: dict) -> dict:
    return {
        "key": c["key"],
        "label": c.get("label") or c["key"],
        "cf_fp16": float(c["bf16_tflops"]),
        "cf_int8": float(c["int8_tflops"]),
        "cf_int4": float(c.get("int4_tflops") or 0),
        "cm": float(c["memory_gb"]),
        "bw": float(c["hbm_tbs"]),
        "ibw": float(c["link_gbs"]),
        "nativeInt4": bool(c.get("native_int4")),
        "powerKW": float(c.get("power_kw") or 0),
    }


def _scene_view(s: dict) -> dict:
    return {
        "key": s["key"],
        "name": s.get("name") or s["key"],
        "promptLen": int(s["prompt_len"]),
        "outputLen": int(s["output_len"]),
        "conc": float(s["concurrency"]),
        "ttft": float(s["ttft_ms"]),
        "tpot": float(s["tpot_ms"]),
    }


def _precision_of(key: str | None) -> dict:
    key = str(key or "").strip()
    key = PRECISION_ALIASES.get(key, key) or "bf16"
    if key not in PRECISIONS:
        raise InferenceIssue("UNSUPPORTED_PRECISION", f"未知精度档：{key}")
    prec = PRECISIONS[key]
    return {"key": key, "label": prec["label"], "w": prec["w"], "aKey": prec["a_key"],
            "aLabel": prec["a_label"],
            "kv": prec["kv"], "needNativeInt4": prec["need_native_int4"]}


def _constants() -> dict:
    """页面 ENG_CONST + FFN 有效利用率常数，全部来自 params（v2 结构）。"""
    c = _params.current()["constants"]
    return {
        "prefillBudget": float(c["prefill_budget"]),
        "decodeFixedMs": float(c["decode_fixed_ms"]),
        "rooflineOverlap": float(c["roofline_overlap"]),
        "queueCoef": float(c["queue_coef"]),
        "moeSkew": float(c["moe_skew"]),
        "moeHitInflate": float(c["moe_hit_inflate"]),
        "moeFillTok": float(c["moe_fill_tok"]),
        "denseFillTok": float(c["dense_fill_tok"]),
        "moeFfnFloor": float(c["moe_ffn_floor"]),
        "moeFfnCeil": float(c["moe_ffn_ceil"]),
        "denseFfnLo": float(c["dense_ffn_lo"]),
    }


# 自定义算力卡的默认工程系数（页面 CUSTOM_ENG_BASE 口径）：
# 未在 chip_profiles 登记的芯片（用户自填规格的自定义卡）按通用经验值计算，
# 也可在参数页对自定义芯片 key 单独覆盖。
CUSTOM_CHIP_PROFILE = {
    "mfu_prefill": 0.38, "mfu_decode_ratio": 0.62, "bw_decode": 0.66,
    "kv_reserve": 1.10, "mem_util": 0.90,
}


def eng_at(chip_key: str, tier: str) -> dict:
    """档位作用后的生效系数（页面 engAt 同口径）。

    基准 = params 默认值 + 用户覆盖（chip_profiles），档位系数只作用于
    效率类（指数规则见 tier_exponents），缩放后按页面区间夹取。
    未登记的芯片 key（自定义算力卡）回退到 CUSTOM_CHIP_PROFILE 通用经验值。
    """
    cfg = _params.current()
    # 部分字段覆盖（尤其自定义芯片只调了一两项）时，缺省字段回退到通用经验值
    base = {**CUSTOM_CHIP_PROFILE, **(cfg["chip_profiles"].get(chip_key) or {})}
    tiers = cfg["tiers"]
    t = tiers.get(tier) or tiers["standard"]
    coef = float(t["coef"])
    exps = cfg.get("tier_exponents") or {}

    def scaled(field_key: str, eng_key: str) -> float:
        exp = float(exps.get(_TIER_EXP_KEYS[eng_key], 1.0))
        lo, hi = _CHIP_RANGES[eng_key]
        return min(hi, max(lo, float(base[field_key]) * coef ** exp))

    return {
        "mfuP": scaled("mfu_prefill", "mfuP"),
        "mfuDRatio": float(base["mfu_decode_ratio"]),  # 比值，不缩放
        "bwUtilD": scaled("bw_decode", "bwUtilD"),
        "memUtil": scaled("mem_util", "memUtil"),
        "kvReserve": float(base["kv_reserve"]),        # 结构性开销，不缩放
    }


# ---------------------------------------------------------------- 工具（页面逐字移植）

def _clamp(v, lo, hi):
    return min(hi, max(lo, v))


def _is_moe(m: dict) -> bool:
    return (m.get("experts") or 0) > 0


def _kv_head_dim(m: dict) -> float:
    return float(m.get("kvHeadDim") or m.get("headDim") or 0)


def _eff_span(m: dict, seq_len: float) -> float:
    span = m.get("attnSpan") or 0
    return min(seq_len, span) if span > 0 else seq_len


def kv_per_token_gb(m: dict, kv_bytes: float) -> float:
    """每 token KV 字节数（GB/token）。

    GQA/MHA：2 × 层数 × KV头数 × KV头维 × KV精度字节；
    MLA：层数 × (低秩维 + rope维) × KV精度字节（rope 缺省 64）；
    混合注意力（gqaKvFraction）再乘全注意力层占比。
    """
    if m.get("latentDim"):
        g = m["lay"] * (m["latentDim"] + (m.get("ropeDim") or 64)) * kv_bytes
    else:
        g = 2 * m["lay"] * (m.get("kvh") or m["heads"]) * _kv_head_dim(m) * kv_bytes
    if m.get("gqaKvFraction"):
        g *= m["gqaKvFraction"]
    return g / 1e9


def _attn_frac(m: dict) -> float:
    return m["gqaKvFraction"] if m.get("gqaKvFraction") else 1.0


def attn_width(m: dict) -> float:
    """注意力算力宽度（每个 Q 头在 QK/AV 两个矩阵乘里要过的隐藏维）。

    MLA：头数 × (QK头维 + V头维) ÷ 2 —— KV 侧低秩压缩只压缩缓存，不压缩计算。
    """
    if m.get("latentDim"):
        qk = float(m.get("qkHeadDim") or m.get("headDim") or 0)
        v = float(m.get("vHeadDim") or m.get("headDim") or 0)
        return m["heads"] * ((qk + v) / 2)
    return m["heads"] * float(m.get("headDim") or 0)


def ffn_eff(m: dict, tokens: float, const: dict) -> float:
    """FFN 有效利用率：小批量下专家/行填不满，矩阵乘效率按 token 规模爬升。

    MoE：每专家平均 token = token × TopK ÷ 专家数，
         有效率 = floor + (ceil−floor) × (1 − e^(−每专家token/fill_tok))；
    Dense：lo + (1−lo) × (1 − e^(−token/dense_fill_tok))。
    """
    tok = max(1.0, float(tokens or 1.0))
    if _is_moe(m):
        experts = max(2, int(m.get("experts") or 2))
        top_k = max(1, min(int(m.get("topK") or 8), experts - 1))
        per_expert = (tok * top_k) / experts
        fill = 1 - math.exp(-per_expert / const["moeFillTok"])
        return _clamp(const["moeFfnFloor"] + (const["moeFfnCeil"] - const["moeFfnFloor"]) * fill,
                      0.05, const["moeFfnCeil"])
    return const["denseFfnLo"] + (1 - const["denseFfnLo"]) * (1 - math.exp(-tok / const["denseFillTok"]))


def align_weight_cards(raw: int) -> int:
    """权重装载宽度（卡数）：≤8 按 2 的幂（机内 TP），>8 按 8 的倍数（跨机 EP）。"""
    if raw <= 1:
        return 1
    if raw <= 2:
        return 2
    if raw <= 4:
        return 4
    if raw <= 8:
        return 8
    return math.ceil(raw / 8) * 8


# ---------------------------------------------------------------- 杜邦式拆解树（页面 mkNode 同口径）
# 节点 = { label, relation(关系式), expr(代入), value(数值), note(来源), tag, highlight, children[] }
# 树随 evaluate 输出进入 trace.detail，前端按通用递归组件渲染成可逐层展开的分解图。

def _jnum(v) -> str:
    """JS 风格的数字直排：整数值不带小数点（671 而非 671.0），其余原样保留有效数字。"""
    if isinstance(v, bool):
        return str(v)
    f = float(v)
    if math.isfinite(f) and f == int(f) and abs(f) < 1e15:
        return str(int(f))
    return repr(f)


def _jexp(v: float, digits: int = 3) -> str:
    """JS Number.toExponential(digits) 口径：指数不带前导零（3.514e-5 而非 3.514e-05）。"""
    s = f"{v:.{digits}e}"
    mantissa, exp = s.split("e")
    sign = ""
    if exp.startswith(("+", "-")):
        sign, exp = exp[0], exp[1:]
    exp = exp.lstrip("0") or "0"
    return f"{mantissa}e{sign}{exp}"


def _mk_node(label, relation="", expr="", value="", note="", tag="",
             highlight=False, children=None) -> dict:
    return {
        "label": label, "relation": relation or "", "expr": expr or "",
        "value": value or "", "note": note or "", "tag": tag or "",
        "highlight": bool(highlight), "children": [c for c in (children or []) if c],
    }


def _kv_source_node(m: dict, kv_bytes: float, prec_label: str) -> dict:
    """每 token KV 的来源代入式（页面 kvSourceNode 同口径）：还原成「架构参数 × 精度字节」。"""
    rope = m.get("ropeDim") or 64
    frac = m.get("gqaKvFraction") or 0
    if m.get("latentDim"):
        byte_count = m["lay"] * (m["latentDim"] + rope) * kv_bytes
        relation = "MLA 低秩压缩：层数 × (低秩维 + RoPE维) × KV精度字节"
        expr = f"{_jnum(m['lay'])} 层 × ({_jnum(m['latentDim'])} 低秩 + {_jnum(rope)} RoPE) × {_jnum(kv_bytes)}B"
        arch_fields = "层数、低秩维与 RoPE 维"
    else:
        byte_count = 2 * m["lay"] * (m.get("kvh") or m["heads"]) * _kv_head_dim(m) * kv_bytes
        relation = "GQA/MHA：2(K+V) × 层数 × KV头数 × KV头维 × KV精度字节"
        expr = (f"2 × {_jnum(m['lay'])} 层 × {_jnum(m.get('kvh') or m['heads'])} KV头 × "
                f"{_jnum(_kv_head_dim(m))} 头维 × {_jnum(kv_bytes)}B")
        arch_fields = "层数、KV 头数与头维"
    if frac:
        byte_count *= frac
        relation += " × 全注意力层占比"
        expr += f" × {_jnum(round(frac, 3))}（全注意力层占比）"
    kv_tok_gb = byte_count / 1e9
    return _mk_node(
        "每token KV · 来源", relation,
        expr + f" = {round(byte_count)} B/tok",
        _jexp(kv_tok_gb, 3) + " GB/tok",
        note=(f"以上{arch_fields}取自模型公开架构配置；KV 精度 {_jnum(kv_bytes)}B/元素由「"
              f"{prec_label or '当前量化档'}」自动跟随（BF16 2B / W8A8、W4A8 1B）。"
              "结构与显存口径见底部「延伸阅读」：GQA 2305.13245、DeepSeek-V3 2412.19437、PagedAttention 2309.06180。"))


# ---------------------------------------------------------------- A 显存约束

def mem_constraint(m: dict, scen: dict, chip: dict, prec: dict, eng: dict, const: dict) -> dict:
    """A 显存约束 = 权重装载宽度 × 副本数。

    ① 权重 = 总参 × W字节 ×(MoE 1.08 偏斜)（显存装全部专家）
    ② 单卡可用 = 显存 × 容量利用率
    ③ 装载宽度 = ⌈权重/单卡可用⌉ 对齐（TP 2的幂 / 跨机 8倍数）；恰好装满再抬宽
    ④ 连续批均长 = 输入 + 输出/2（KV 按均值预留，不按每路写满）
    ⑤ KV 需求 = 并发 × 均长 × 每token KV × 预留系数
    ⑥ 房间不足加副本；卡数 = 宽度 × max(1, 副本数)
    """
    skew = const["moeSkew"] if _is_moe(m) else 1.0
    weights_gb = m["total"] * prec["w"] * skew
    usable_gb = chip["cm"] * eng["memUtil"]
    raw_cards = math.ceil(weights_gb / usable_gb)
    weight_cards = align_weight_cards(raw_cards)
    # 权重恰好装满（KV 房间为 0）时提升装载宽度，保证每副本至少留得出 KV 房间
    while weight_cards * usable_gb - weights_gb <= 0:
        weight_cards = weight_cards * 2 if weight_cards <= 8 else weight_cards + 8
    tp = min(8, weight_cards)
    kv_tok_gb = kv_per_token_gb(m, prec["kv"])
    avg_len = scen["promptLen"] + scen["outputLen"] / 2
    kv_need_gb = scen["conc"] * avg_len * kv_tok_gb * eng["kvReserve"]
    room_per_replica = max(0.0, weight_cards * usable_gb - weights_gb)
    replicas = max(1, math.ceil(kv_need_gb / room_per_replica)) if kv_need_gb > 0 else 1
    cards = weight_cards * replicas

    # ---- 杜邦树（页面 memConstraint 节点同口径）----
    weights_node = _mk_node(
        "模型权重", f"总参 × 权重字节 × MoE 偏斜({_jnum(skew)})",
        f"{_jnum(m['total'])}B × {_jnum(prec['w'])}B" + (f" × {_jnum(const['moeSkew'])}" if skew != 1 else ""),
        f"{weights_gb:.1f} GB")
    usable_node = _mk_node(
        "单卡可用显存", "标称显存 × 容量利用率",
        f"{_jnum(chip['cm'])}GB × {_jnum(eng['memUtil'])}", f"{usable_gb:.1f} GB")
    width_node = _mk_node(
        "① 权重装载宽度", "⌈权重 ÷ 单卡可用⌉ → TP 对齐（≤8 取 2 的幂，>8 取 8 的倍数）",
        f"⌈{weights_gb:.1f} ÷ {usable_gb:.1f}⌉ = {raw_cards} → {weight_cards}",
        f"{weight_cards} 卡", children=[weights_node, usable_node])
    kv_need_node = _mk_node(
        "KV 需求", "并发 × 连续批均长 × 每token KV × 预留系数",
        f"{_jnum(scen['conc'])} × {_jnum(avg_len)} × {_jexp(kv_tok_gb)} × {_jnum(eng['kvReserve'])}",
        f"{kv_need_gb:.2f} GB", children=[
            _kv_source_node(m, prec["kv"], prec["label"]),
            _mk_node("并发", "场景输入：同时在生成中的请求数", "—", f"{_jnum(scen['conc'])} 路"),
            _mk_node("连续批均长", "输入 + 输出 ÷ 2（按均值预留，不按每路写满窗口）",
                     f"{_jnum(scen['promptLen'])} + {_jnum(scen['outputLen'])} ÷ 2", f"{_jnum(avg_len)} tok"),
        ])
    replica_node = _mk_node(
        "② 副本数", "⌈KV 需求 ÷ 每副本 KV 房间⌉，至少 1",
        f"⌈{kv_need_gb:.2f} ÷ {room_per_replica:.1f}⌉", f"{replicas} 副本", children=[
            kv_need_node,
            _mk_node("每副本 KV 房间", "装载宽度 × 单卡可用 − 权重",
                     f"{weight_cards} × {usable_gb:.1f} − {weights_gb:.1f}", f"{room_per_replica:.1f} GB"),
        ])
    node = _mk_node(
        "A · 显存约束", "权重装载宽度 × 副本数（权重 + KV 容量）",
        f"{weight_cards} × {replicas}", f"{cards} 卡", children=[width_node, replica_node])

    return {
        "cards": cards, "weightCards": weight_cards, "tp": tp, "replicas": replicas,
        "weightsGB": weights_gb, "usableGB": usable_gb, "kvTokGB": kv_tok_gb,
        "avgLen": avg_len, "kvNeedGB": kv_need_gb, "node": node,
    }


# ---------------------------------------------------------------- B Prefill 约束

def prefill_flops_per_req(m: dict, scen: dict, const: dict) -> dict:
    """单请求 Prefill FLOPs = 2×激活参×新token ÷ FFN利用率 + 注意力项。

    显存看总参、算力看激活参：MoE 只计算激活专家；小批量专家填不满，按利用率放大。
    """
    new_tok = scen["promptLen"]
    avg_span = _eff_span(m, new_tok / 2 + 1)
    fill = ffn_eff(m, new_tok, const)
    gemm = (2 * m["active"] * 1e9 * new_tok) / fill
    attn = 4 * m["lay"] * attn_width(m) * new_tok * avg_span * _attn_frac(m)
    return {"total": gemm + attn, "gemm": gemm, "attn": attn, "fill": fill,
            "avgSpan": avg_span, "attnWidth": attn_width(m)}


def prefill_constraint(m: dict, scen: dict, chip: dict, prec: dict, eng: dict, const: dict) -> dict:
    """B Prefill 约束（TTFT）：max(吞吐下限 N1, 时延下限 N2)。

    ② 稳态到达率 λ = 并发 ÷ 请求时长（时长 = TTFT + 输出×TPOT）；
    ③ N1 = ⌈λ×单请求FLOPs ÷ (有效算力 × prefillBudget)⌉；
    ④ 时延：服务时间 = FLOPs÷(N×有效算力) + 引擎固定开销(5 + 输入/500 ms)；
       排队按 M/G/1 近似 TTFT ≈ 服务时间 × (1 + queueCoef·ρ/(1−ρ))，ρ ≥ 1 饱和不可行，
       ρ 上限 0.95；N2 枚举 1..1024 取 TTFT ≤ 目标×预算 的最小 N。
    """
    fl = prefill_flops_per_req(m, scen, const)
    flops_per_req = fl["total"]
    eff_per_card = chip[prec["aKey"]] * 1e12 * eng["mfuP"]
    req_dur_s = (scen["ttft"] + scen["outputLen"] * scen["tpot"]) / 1000
    lam = scen["conc"] / req_dur_s
    fixed_ms = 5 + scen["promptLen"] / 500

    def ttft_at(n: int) -> dict:
        compute_ms = flops_per_req / (n * eff_per_card) * 1000
        service_ms = compute_ms + fixed_ms
        rho_raw = lam * compute_ms / 1000
        if rho_raw >= 1:
            return {"ttft": math.inf, "rho": 1.0, "serviceMs": service_ms}
        rho = min(0.95, rho_raw)
        return {"ttft": service_ms * (1 + (const["queueCoef"] * rho) / (1 - rho)),
                "rho": rho, "serviceMs": service_ms}

    n1 = max(1, math.ceil((lam * flops_per_req) / (eff_per_card * const["prefillBudget"])))
    n2 = n1
    for n in range(1, 1025):
        if ttft_at(n)["ttft"] <= scen["ttft"] * const["prefillBudget"]:
            n2 = n
            break
    n2_found = ttft_at(n2)["ttft"] <= scen["ttft"] * const["prefillBudget"]
    cards = max(n1, n2)
    at = ttft_at(cards)

    # ---- 杜邦树（页面 prefillConstraint 节点同口径）----
    q_factor = at["ttft"] / at["serviceMs"] if math.isfinite(at["ttft"]) else math.inf
    gemm_node = _mk_node(
        "GEMM 项", "2 × 激活参 × 输入 ÷ FFN 有效利用率",
        f"2 × {_jnum(m['active'])}B × {_jnum(scen['promptLen'])} ÷ {fl['fill']:.2f}",
        f"{fl['gemm'] / 1e12:.2f} TFLOP")
    attn_note = ""
    if m.get("latentDim"):
        attn_note = (f"MLA 的低秩压缩只作用在 KV 缓存（{_jnum(m['latentDim'])} 维），计算仍按 QK/V 的完整头维走："
                     f"{_jnum(m['heads'])} 头 × ({_jnum(m.get('qkHeadDim') or m.get('headDim'))} + "
                     f"{_jnum(m.get('vHeadDim') or m.get('headDim'))}) ÷ 2 = {round(fl['attnWidth'])}。")
    attn_node = _mk_node(
        "注意力项",
        ("MLA：4 × 层数 × 头数 × (QK头维+V头维)/2" if m.get("latentDim")
         else "GQA/MHA：4 × 层数 × 头数 × 头维") + " × 输入 × 有效跨度",
        f"4 × {_jnum(m['lay'])} × {round(fl['attnWidth'])} × {_jnum(scen['promptLen'])} × {round(fl['avgSpan'])}",
        f"{fl['attn'] / 1e12:.2f} TFLOP", note=attn_note)
    flops_node = _mk_node(
        "单请求 FLOPs", "2×激活参×输入 ÷ FFN利用率 + 4×层×注意力宽×输入×跨度",
        "GEMM + 注意力（见下）", f"{flops_per_req / 1e12:.2f} TFLOP",
        children=[gemm_node, attn_node])
    eff_node = _mk_node(
        "有效算力/卡", f"峰值({prec['aLabel']}) × Prefill MFU",
        f"{_jnum(chip[prec['aKey']])}T × {eng['mfuP']:.2f}", f"{eff_per_card / 1e12:.1f} TFLOPS")
    lambda_node = _mk_node(
        "稳态到达率 λ", "并发 ÷ (TTFT 目标 + 输出 × TPOT)",
        f"{_jnum(scen['conc'])} ÷ {req_dur_s:.2f}s", f"{lam:.2f} 请求/s")
    budget = const["prefillBudget"]
    n1_node = _mk_node(
        "① 吞吐下限 N1", f"⌈λ × 单请求 FLOPs ÷ (有效算力 × {_jnum(budget)})⌉",
        f"⌈{lam:.2f} × {flops_per_req / 1e12:.2f}T ÷ ({eff_per_card / 1e12:.1f}T × {_jnum(budget)})⌉",
        f"{n1} 卡", children=[flops_node, eff_node, lambda_node])
    service_node = _mk_node(
        f"N={cards} 时服务时间", f"FLOPs ÷ (N × 有效算力) + 引擎固定开销 {fixed_ms:.1f}ms",
        f"{flops_per_req / 1e12:.0f}T ÷ ({cards} × {eff_per_card / 1e12:.1f}T) × 1000 + {fixed_ms:.1f}ms",
        (f"{at['serviceMs']:.1f}" if math.isfinite(at["serviceMs"]) else "∞") + " ms")
    queue_node = _mk_node(
        "M/G/1 排队放大", "TTFT = 服务时间 × (1 + ρ / 2(1−ρ))，ρ = λ × 计算时间",
        f"ρ={at['rho']:.2f} → ×" + (f"{q_factor:.2f}" if math.isfinite(q_factor) else "∞"),
        f"{at['ttft']:.1f} ms" if math.isfinite(at["ttft"]) else "饱和不可行")
    n2_node = _mk_node(
        "② 时延下限 N2", f"枚举 N：TTFT(N) ≤ TTFT 目标 × {_jnum(budget)}",
        f"目标 {scen['ttft'] * budget:.0f}ms", f"{n2 if n2_found else '不可达'} 卡",
        children=[service_node, queue_node])
    node = _mk_node(
        "B · Prefill 约束", "max(吞吐下限 N1, 时延下限 N2)",
        f"max({n1}, {n2})", f"{cards} 卡", children=[n1_node, n2_node])

    return {
        "cards": cards, "n1": n1, "n2": n2, "n2Found": n2_found,
        "flopsPerReq": flops_per_req, "lambda": lam,
        "serviceMs": at["serviceMs"], "ttftPredMs": at["ttft"],
        "rho": at["rho"], "ttftOk": n2_found, "node": node,
    }


# ---------------------------------------------------------------- C Decode 约束

def decode_constraint(m: dict, scen: dict, chip: dict, prec: dict, eng: dict, const: dict) -> dict:
    """C Decode 约束（TPOT，带宽游戏）。

    ① 每步每卡读取 = 权重分片 + 批量 KV 读取；MoE 只读命中专家
       hit = (1−(1−TopK/专家数)^批) × moeHitInflate，非专家部分常驻读取；
    ② 步长 = max(带宽时间, 计算时间) + overlap×min + TP AllReduce 通信 + 调度固定开销；
    ③ 理论下限 = 最宽分片 + 最小批的权重读取 ÷ 带宽 + 调度（TPOT 低于此值加卡无效）；
    ④ 枚举 分片宽度×副本数，取「达标组合里卡数最小」；都压不到时退化为最小卡数并告警。
       分片：≤8 机内 TP，并发 ≥64 放开到 16、≥256 放开到 32；
       副本：1 ~ clamp(⌈并发/8⌉, 16, 256)。
    """
    usable_gb = chip["cm"] * eng["memUtil"]
    skew = const["moeSkew"] if _is_moe(m) else 1.0
    weights_gb = m["total"] * prec["w"] * skew
    raw_cards = math.ceil(weights_gb / usable_gb)
    aligned_cards = align_weight_cards(raw_cards)

    shard_cap = 32 if scen["conc"] >= 256 else (16 if scen["conc"] >= 64 else 8)
    shards = [s for s in (1, 2, 4, 8, 16, 32) if s <= shard_cap and s * usable_gb >= weights_gb]
    # 权重装不下时必须补到「权重对齐卡数」及其 2 倍，否则无解
    if aligned_cards not in shards:
        shards.append(aligned_cards)
    if aligned_cards * 2 not in shards:
        shards.append(aligned_cards * 2)
    shards.sort()

    kv_tok_gb = kv_per_token_gb(m, prec["kv"])
    avg_len = scen["promptLen"] + scen["outputLen"] / 2
    attn_span_eff = _eff_span(m, avg_len)

    routed_frac = 0.0
    if _is_moe(m):
        non_expert = (2 * m["lay"] * m["hid"] * m["hid"]
                      + 3 * min(m["lay"], 3) * (m.get("ffn") or 1) * m["hid"] * m["hid"]) / 1e9
        routed_frac = _clamp(1 - non_expert / m["total"], 0.05, 0.99)

    def hit_frac_of(batch: float) -> float:
        if not _is_moe(m):
            return 1.0
        top_k = m.get("topK") or 8
        return min(1.0, (1 - (1 - top_k / m["experts"]) ** batch) * const["moeHitInflate"])

    bw_gbs = chip["bw"] * 1000 * eng["bwUtilD"]
    mfu_d = eng["mfuP"] * eng["mfuDRatio"]
    eff_per_card = chip[prec["aKey"]] * 1e12 * mfu_d

    def step_ms_at(shard: int, rep: int) -> dict:
        batch = max(1.0, math.ceil(scen["conc"] / rep))
        hit = hit_frac_of(batch)
        read_weights = (((1 - routed_frac) + hit * routed_frac) * weights_gb
                        if _is_moe(m) else weights_gb)
        read_per_card = read_weights / shard + (batch * avg_len * kv_tok_gb) / shard
        bw_ms = read_per_card / bw_gbs * 1000
        attn_flops = 4 * m["lay"] * attn_width(m) * attn_span_eff * batch * _attn_frac(m)
        flops_per_card = (2 * m["active"] * 1e9 * batch + attn_flops) / shard
        compute_ms = flops_per_card / eff_per_card * 1000
        comm_ms = (2 * m["lay"] * batch * m["hid"] * 2) / (chip["ibw"] * 1e9 * min(shard, 8)) * 1000
        step_ms = (max(bw_ms, compute_ms) + const["rooflineOverlap"] * min(bw_ms, compute_ms)
                   + comm_ms + const["decodeFixedMs"])
        return {"shard": shard, "rep": rep, "batch": batch, "hit": hit,
                "readPerCard": read_per_card, "bwMs": bw_ms, "computeMs": compute_ms,
                "commMs": comm_ms, "stepMs": step_ms, "cards": shard * rep}

    rep_max = _clamp(math.ceil(scen["conc"] / 8), 16, 256)

    # 搜索满足 TPOT 的最小卡数：达标组合里取卡数最小（同卡数取步长更短）。
    # 加副本会让 batch 变小、步长变短但总卡数上升——「最小卡数」和「达标」是两件事，
    # 必须分开跟踪（否则会误报「带宽下限加卡无效」）。
    best_ok = None
    best_any = None

    def better(cur, s):
        return cur is None or s["cards"] < cur["cards"] or (
            s["cards"] == cur["cards"] and s["stepMs"] < cur["stepMs"])

    for shard in shards:
        for rep in range(1, rep_max + 1):
            s = step_ms_at(shard, rep)
            if better(best_any, s):
                best_any = s
            if s["stepMs"] <= scen["tpot"]:
                if better(best_ok, s):
                    best_ok = s
                break  # 同一分片下副本再大只会更费卡，本分片的最优已拿到
    best = best_ok or best_any
    # 枚举上限（最宽分片 × 最大副本）的步长：无解时用它告诉用户「最多能到多少」
    effort = step_ms_at(shards[-1], rep_max)

    # 带宽理论下限：最宽分片 + 最小批（副本拉满）下的权重读取。
    # 必须用最小批而非当前并发——加副本正是靠「batch 变小 → 命中专家变少」摊薄每卡读取。
    widest_shard = shards[-1]
    min_batch = max(1.0, math.ceil(scen["conc"] / rep_max))
    floor_read = (((1 - routed_frac) + hit_frac_of(min_batch) * routed_frac) * weights_gb
                  if _is_moe(m) else weights_gb) / widest_shard
    floor_ms = floor_read / bw_gbs * 1000 + const["decodeFixedMs"]
    band_limited = scen["tpot"] < floor_ms
    tpot_short = best_ok is None

    # ---- 杜邦树（页面 decodeConstraint 节点同口径）----
    s = best
    read_weights_per_card = (((1 - routed_frac) + s["hit"] * routed_frac) * weights_gb / s["shard"]
                             if _is_moe(m) else weights_gb / s["shard"])
    read_kv_per_card = (s["batch"] * avg_len * kv_tok_gb) / s["shard"]
    read_node = _mk_node(
        "每步每卡读取",
        ("(非专家 + 命中 × 路由) × 权重 ÷ 分片" if _is_moe(m) else "权重 ÷ 分片") + " + 批量 KV ÷ 分片",
        f"{read_weights_per_card:.1f} + {read_kv_per_card:.2f}", f"{s['readPerCard']:.1f} GB",
        note=(f"MoE 每步只读命中专家 ≈ {s['hit'] * 100:.0f}%（批 {_jnum(s['batch'])}），非专家部分常驻读取"
              if _is_moe(m) else "Dense 模型每步读全量权重"),
        children=[
            _mk_node("权重读取（分片后）",
                     ("(非专家 + 命中×路由) × 权重 ÷ 分片" if _is_moe(m) else "权重 ÷ 分片"),
                     f"{weights_gb:.1f}GB" + (" × 命中折算" if _is_moe(m) else "") + f" ÷ {s['shard']}",
                     f"{read_weights_per_card:.1f} GB"),
            _mk_node("批量 KV 读取", "批 × 均长 × 每token KV ÷ 分片",
                     f"{_jnum(s['batch'])} × {_jnum(avg_len)} × {_jexp(kv_tok_gb)} ÷ {s['shard']}",
                     f"{read_kv_per_card:.2f} GB"),
        ])
    bw_node = _mk_node(
        "带宽时间", "读取 ÷ (HBM 带宽 × 利用率)",
        f"{s['readPerCard']:.1f}GB ÷ ({_jnum(chip['bw'])}TB/s × {_jnum(eng['bwUtilD'])})",
        f"{s['bwMs']:.1f} ms")
    compute_node = _mk_node(
        "计算时间", "FLOPs/步 ÷ 分片 ÷ (峰值 × Decode MFU)",
        f"2 × {_jnum(m['active'])}B × 批 {_jnum(s['batch'])} ÷ {s['shard']} ÷ ({_jnum(chip[prec['aKey']])}T × {mfu_d:.3f})",
        f"{s['computeMs']:.2f} ms")
    comm_node = _mk_node(
        "通信开销", "TP AllReduce 量 ÷ 互联带宽（分片 ≤8 内）",
        f"2 × {_jnum(m['lay'])} 层 × {_jnum(s['batch'])} × {_jnum(m['hid'])} × 2B ÷ {_jnum(chip['ibw'])}GB/s",
        (f"{s['commMs']:.3f}" if s["commMs"] < 0.01 else f"{s['commMs']:.2f}") + " ms")
    step_node = _mk_node(
        "① 单步步长", f"max(带宽, 计算) + {_jnum(const['rooflineOverlap'])} × min + 通信 + 调度 {_jnum(const['decodeFixedMs'])}ms",
        f"max({s['bwMs']:.1f}, {s['computeMs']:.2f}) + {_jnum(const['rooflineOverlap'])} × min + {s['commMs']:.2f} + {_jnum(const['decodeFixedMs'])}",
        f"{s['stepMs']:.1f} ms（目标 {_jnum(scen['tpot'])} ms）",
        children=[read_node, bw_node, compute_node, comm_node])
    floor_node = _mk_node(
        "② 带宽理论下限", f"最宽分片时权重读取 ÷ 带宽 + 调度 {_jnum(const['decodeFixedMs'])}ms",
        f"{floor_ms:.1f} ms（最宽 {widest_shard} 卡分片）",
        ("目标低于下限，加卡无效" if band_limited
         else (f"枚举上限 {effort['cards']} 卡时 {effort['stepMs']:.1f}ms，仍高于目标" if tpot_short
               else f"目标 {_jnum(scen['tpot'])}ms 可达")))
    node = _mk_node(
        "C · Decode 约束", "枚举 分片宽度 × 副本数，取满足 TPOT 的最小总卡数",
        f"分片 {s['shard']} 卡 × 副本 {s['rep']}（批 {_jnum(s['batch'])}）", f"{s['cards']} 卡",
        children=[step_node, floor_node])

    return {
        "cards": best["cards"], "shard": best["shard"], "replicas": best["rep"],
        "batch": best["batch"], "stepMs": best["stepMs"], "hit": best["hit"],
        "readPerCard": best["readPerCard"], "bwMs": best["bwMs"],
        "computeMs": best["computeMs"], "commMs": best["commMs"],
        "floorMs": floor_ms, "bandLimited": band_limited, "tpotShort": tpot_short,
        "tpotReached": best_ok is not None,
        "effortCards": effort["cards"], "effortMs": effort["stepMs"],
        "effortShard": widest_shard, "repMax": rep_max, "node": node,
    }


# ---------------------------------------------------------------- 单场景合成

def evaluate(m: dict, scen: dict, chip: dict, prec: dict, eng: dict, const: dict) -> dict:
    """单场景合成：卡数 = max(A,B,C)，奇数补偶；瓶颈 = 主导约束（并列按 显存>Decode>Prefill）。"""
    a = mem_constraint(m, scen, chip, prec, eng, const)
    b = prefill_constraint(m, scen, chip, prec, eng, const)
    c = decode_constraint(m, scen, chip, prec, eng, const)

    raw = max(a["cards"], b["cards"], c["cards"])
    cards = raw + 1 if raw % 2 == 1 else raw
    if a["cards"] >= b["cards"] and a["cards"] >= c["cards"]:
        bottleneck = "mem"
    elif c["cards"] >= b["cards"]:
        bottleneck = "decode"
    else:
        bottleneck = "prefill"

    # 杜邦式树：顶层「所需算力卡」= max(A,B,C) → 奇数补偶；三条约束各自逐层拆到原始参数
    bottleneck_node = {"mem": a, "decode": c, "prefill": b}[bottleneck]["node"]
    bottleneck_node["highlight"] = True
    tree = _mk_node(
        "所需算力卡 N", "max(A 显存, B Prefill, C Decode) → 奇数补偶",
        f"max({a['cards']}, {b['cards']}, {c['cards']}) = {raw}" + (f" → 补偶 {cards}" if cards != raw else ""),
        f"{cards} 卡", tag="总计", children=[a["node"], b["node"], c["node"]])

    warnings = []
    if scen["promptLen"] > 65536:
        warnings.append({"type": "longInput", "msg": "输入长度 >64K：长序列估算误差放大，结论仅作量级参考"})
    if scen["outputLen"] > 16384:
        warnings.append({"type": "longOutput", "msg": "输出长度 >16K：长输出估算误差放大，结论仅作量级参考"})
    if a["weightCards"] > 8:
        warnings.append({"type": "crossNode", "msg": "模型权重超过单机 8 卡，需跨机部署（EP/PP），互联开销已按简化口径计入"})
    if c["bandLimited"]:
        warnings.append({"type": "bandLimited",
                         "msg": f"TPOT 目标低于芯片显存带宽理论下限（约 {c['floorMs']:.0f}ms），加卡无效：建议放宽目标、换更高带宽芯片或换更小模型"})
    elif c["tpotShort"]:
        warnings.append({"type": "tpotShort",
                         "msg": (f"当前并发下压不到 TPOT 目标：枚举上限 {c['effortCards']} 卡（分片 {c['effortShard']} × 副本 {c['repMax']}）"
                                 f"时步长仍约 {c['effortMs']:.0f}ms，高于目标 {scen['tpot']:.0f}ms。"
                                 "建议放宽 TPOT、减少并发，或换更高带宽 / 更大显存芯片")})
    if not b["ttftOk"]:
        warnings.append({"type": "ttft", "msg": "TTFT 目标在高负载下不可达，建议降低并发或放宽首 Token 目标"})

    return {
        "cards": cards, "rawCards": raw, "bottleneck": bottleneck,
        "bottleneckLabel": BOTTLENECK_LABEL[bottleneck],
        "a": a["cards"], "b": b["cards"], "c": c["cards"],
        "A": a, "B": b, "C": c, "tree": tree,
        "servers": math.ceil(cards / 8),
        "warnings": warnings,
        "eng": eng,
        "tier": None, "modelKey": None, "chipKey": None, "precKey": None,
        "scen": dict(scen),
    }


# ---------------------------------------------------------------- 汇总（页面 aggregate）

def aggregate(results: list[dict]) -> dict:
    """按芯片分组小计 + 按模型归类明细 + 服务器台数 / 功耗。

    只给「算力需求量」：采购侧余量由使用方按 SLA 另行加（规划器在池层 headroom 表达）。
    台数按芯片组各自 8 卡/台折算（不同芯片不混机）。
    results 各项需含 chipKey / modelKey / cards / bottleneck / scen.conc，
    以及芯片视图（powerKW / label，evaluate 输出自带）。
    """
    by_chip: dict[str, dict] = {}
    by_model: dict[str, dict] = {}
    bottleneck_dist = {"mem": 0, "prefill": 0, "decode": 0}

    for r in results:
        chip = r.get("chip") or {}
        group = by_chip.setdefault(r["chipKey"], {
            "chipKey": r["chipKey"], "chipLabel": chip.get("label") or r["chipKey"], "cards": 0})
        group["cards"] += r["cards"]
        mm = by_model.setdefault(r["modelKey"], {
            "modelKey": r["modelKey"], "modelName": r.get("modelName") or r["modelKey"],
            "chips": {}, "conc": 0, "cards": 0, "bottleneck": r["bottleneck"]})
        mm["chips"][r["chipKey"]] = mm["chips"].get(r["chipKey"], 0) + r["cards"]
        mm["conc"] += (r.get("scen") or {}).get("conc", 0) or 0
        mm["cards"] += r["cards"]
        bottleneck_dist[r["bottleneck"]] += 1

    by_chip_list = []
    for key, g in by_chip.items():
        chip = next((r.get("chip") or {} for r in results if r["chipKey"] == key), {})
        power = float(chip.get("powerKW") or 0)
        by_chip_list.append({**g, "powerKW": g["cards"] * power, "servers": math.ceil(g["cards"] / 8)})

    return {
        "totalCards": sum(g["cards"] for g in by_chip_list),
        "byChip": by_chip_list,
        "byModel": sorted(by_model.values(), key=lambda x: -x["cards"]),
        "servers": sum(g["servers"] for g in by_chip_list),
        "powerKW": sum(g["powerKW"] for g in by_chip_list),
        "bottleneckDist": bottleneck_dist,
    }


# ---------------------------------------------------------------- 高层入口（catalog + 请求）

def estimate(request: dict, models: list[dict], chips: list[dict], scenes: list[dict],
             profile: str = "neutral") -> dict:
    """单场景推理算力评估（v2.0.0 页面口径）。

    request: model_key / chip_key / weight_precision / scene_key /
             concurrency / prompt_len / output_len / ttft_target_ms / tpot_target_ms
             （kv_precision / prefix_hit / max_ctx 为兼容保留字段，新引擎不消费）
    models/chips/scenes: catalog 清单（inference_models/chips/scenes.json 的条目形态，
             自定义模型同构）。profile: optimistic/neutral/conservative → 档位 tier。
    """
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

    prec_key = str(request.get("weight_precision") or "")
    prec = _precision_of(prec_key)
    chip_v = _chip_view(chip)
    if prec["needNativeInt4"] and not chip_v["nativeInt4"]:
        raise InferenceIssue("UNSUPPORTED_PRECISION",
                             "该芯片无 INT4 峰值，不支持 W4A8（INT4 权重）精度，请选择 950 系列或改用 W8A8")

    tier = PROFILE_TIER.get(profile or "neutral", "standard")
    m_v = _model_view(model)
    scen = {
        "promptLen": int(request.get("prompt_len") or scene["prompt_len"]),
        "outputLen": int(request.get("output_len") or scene["output_len"]),
        "conc": float(request.get("concurrency") or scene["concurrency"]),
        "ttft": float(request.get("ttft_target_ms") or scene["ttft_ms"]),
        "tpot": float(request.get("tpot_target_ms") or scene["tpot_ms"]),
    }
    if scen["conc"] < 1:
        raise InferenceIssue("INVALID_SCENE", "并发会话数至少为 1")
    if scen["ttft"] <= 0 or scen["tpot"] <= 0:
        raise InferenceIssue("INVALID_SLA", "TTFT 与 TPOT 目标必须大于 0")

    eng = eng_at(chip["key"], tier)
    const = _constants()
    out = evaluate(m_v, scen, chip_v, prec, eng, const)
    out.update({
        "tier": tier, "tierLabel": TIERS.get(tier, tier),
        "modelKey": model["key"], "chipKey": chip["key"], "precKey": prec["key"],
        "model_label": model.get("label") or model["key"],
        "chip_label": chip_v["label"],
        "scene_key": scene["key"], "scene_name": scene.get("name") or scene["key"],
        "profile": profile or "neutral",
        "arch": "MoE" if _is_moe(m_v) else "Dense", "moe": _is_moe(m_v),
        "chip": chip_v,
        "power_kw": out["cards"] * chip_v["powerKW"],
        "precision": {"key": prec["key"], "label": prec["label"],
                      "weight_bytes": prec["w"], "kv_bytes": prec["kv"],
                      "compute_tflops": chip_v[prec["aKey"]]},
        "workload": {"prompt_len": scen["promptLen"], "output_len": scen["outputLen"],
                     "concurrency": scen["conc"], "ttft_target_ms": scen["ttft"],
                     "tpot_target_ms": scen["tpot"]},
    })
    return _finite(out)


def _finite(value):
    """深度把非有限浮点（饱和时的 Infinity/NaN）转成 None，保证 JSON 可序列化。"""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_finite(v) for v in value]
    return value
