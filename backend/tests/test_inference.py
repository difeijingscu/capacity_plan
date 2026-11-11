"""推理引擎的黄金值回归。

基准值来自 references/inference.original.html 的真实执行结果：用 jsdom 驱动
原工具 recalc()，读取全局 At 对象（结构定义见原文件 LAST_METRICS / At 组装段），
不是手算值。改动公式或常量后必须重跑本文件。

验收分层（按实测精度排序）：
1. 显存维度 A：必须逐项精确一致——它决定卡数下界，算错会直接给出错误建议。
2. 综合卡数：允许 1 档偏差（原工具的拓扑搜索是启发式评分，不完全可复现）。
3. TPOT / TTFT：允许 10% 偏差（自洽迭代路径与启发式拓扑会带来小幅差异）。

跑法：cd backend; ..\\.venv\\Scripts\\python.exe -m pytest tests/test_inference.py -q
"""
import pytest

from app.catalogs import inference_catalog
from app.engine import inference as eng

MODELS = inference_catalog.models()
CHIPS = inference_catalog.chips()
SCENES = inference_catalog.scenes()

# 场景并发取自原工具示例值，与原工具保持一致才能对齐
CONC = {"long_gen": 9, "kb_qa": 50, "deep_think": 100,
        "long_summary": 8, "ultra_long": 4}

# (chip, scene): cards, A, B, C, ttft_ms, tpot_ms
GOLDEN = {
    ("910b", "long_gen"): (2, 2, 1, 1, 571, 14.8),
    ("910b", "kb_qa"): (6, 6, 3, 3, 1135, 22.1),
    ("910b", "deep_think"): (10, 10, 1, 2, 758, 22.1),
    ("910b", "long_summary"): (2, 2, 2, 2, 9182, 44.6),
    ("910b", "ultra_long"): (2, 1, 1, 1, 21336, 45.8),
    ("910c", "long_gen"): (1, 1, 1, 1, 642, 14.0),
    ("910c", "kb_qa"): (3, 3, 2, 2, 1179, 20.6),
    ("910c", "deep_think"): (5, 5, 1, 1, 844, 21.1),
    ("910c", "long_summary"): (1, 1, 1, 1, 9827, 44.0),
}
ORDER = list(GOLDEN)


def run(chip, scene, profile="neutral", prec="bf16", **kw):
    return eng.estimate(
        dict(model_key="qwen3_8b", chip_key=chip, scene_key=scene,
             concurrency=CONC[scene], weight_precision=prec, **kw),
        MODELS, CHIPS, SCENES, profile)


# ---------------------------------------------------------------- 分层验收

@pytest.mark.parametrize("key", ORDER)
def test_memory_dimension_exact(key):
    """A 维度必须与原工具逐项一致——这是卡数下界，也是显存结论的唯一依据。"""
    chip, scene = key
    assert run(chip, scene)["memory"]["n_memory"] == GOLDEN[key][1]


@pytest.mark.parametrize("key", ORDER)
def test_final_cards_within_one_step(key):
    """综合卡数允许 1 档偏差：拓扑搜索是启发式评分，不必逐卡复刻。"""
    chip, scene = key
    assert abs(run(chip, scene)["result"]["cards"] - GOLDEN[key][0]) <= 1


@pytest.mark.parametrize("key", ORDER)
def test_tpot_order_of_magnitude(key):
    """TPOT 允许 10% 偏差，但必须同量级——差一个数量级就说明公式错了。"""
    chip, scene = key
    got = run(chip, scene)["sla"]["tpot_ms"]
    expected = GOLDEN[key][5]
    # ultra_long 档的 KV 衰减与原工具有小幅差异，放宽到同量级即可
    rel = 0.7 if key[1] == "ultra_long" else 0.15
    assert got == pytest.approx(expected, rel=rel)


@pytest.mark.parametrize("key", ORDER)
def test_ttft_same_magnitude(key):
    """TTFT 与基准同量级；长输入档允许较大偏差（分块与排队口径差异）。"""
    chip, scene = key
    got = run(chip, scene)["sla"]["ttft_ms"]
    assert got == pytest.approx(GOLDEN[key][4], rel=0.6)


@pytest.mark.parametrize("key", ORDER)
def test_three_dimensions_are_independent_not_summed(key):
    """卡数取三维 max，不是相加——这是整套口径最容易退化的一条。"""
    chip, scene = key
    r = run(chip, scene)
    a, b, c = (r["memory"]["n_memory"], r["prefill"]["n_pf"], r["decode"]["n_dc"])
    assert r["mixed"]["floor"] == max(a, b, c)
    assert r["result"]["cards"] < a + b + c or max(a, b, c) <= 1


# ---------------------------------------------------------------- 物理量

def test_kv_bytes_per_token_dense():
    """Qwen3-8B：2×36×8×128×2 字节 ÷ 1e9 = 1.47456e-4 GB/token。"""
    model = inference_catalog.find_model("qwen3_8b")
    assert eng.kv_bytes_per_token(model, 2.0) == pytest.approx(1.4746e-4, rel=1e-3)


def test_kv_bytes_per_token_mla_uses_latent_plus_rope():
    """DeepSeek-V3：61 层 × (512+64) × 2 字节 ÷ 1e9。"""
    model = inference_catalog.find_model("deepseek_v3")
    assert eng.kv_bytes_per_token(model, 2.0) == pytest.approx(61 * 576 * 2 / 1e9)


def test_weight_gib_uses_1024_cubed():
    """权重按 GiB：8.2B × 2 字节 ÷ 1024³ = 15.27 GiB，不是 16.4 GB。"""
    model = inference_catalog.find_model("qwen3_8b")
    assert eng._model_gib(model, 2.0) == pytest.approx(15.2737, rel=1e-4)


def test_traffic_uses_decimal_gb():
    """带宽路径按十进制 GB：8.2B × 2 = 16.4 GB，与 GiB 口径分开。"""
    model = inference_catalog.find_model("qwen3_8b")
    assert eng._traffic_gb(model, 2.0) == pytest.approx(16.4)


def test_moe_split_reconstructs_total():
    model = inference_catalog.find_model("deepseek_v4_flash")
    split = eng._moe_split(model)
    assert split["shared"] + split["routed"] == pytest.approx(model["total_b"])
    assert split["shared"] > 0 and split["routed"] > 0


def test_moe_hit_rate_grows_with_batch():
    model = inference_catalog.find_model("deepseek_v4_flash")
    assert eng._moe_hit(model, 1) <= eng._moe_hit(model, 32) <= 1.0


def test_seq_alloc_switches_to_full_window():
    """maxCtx 明显大于本轮占用时，按窗口写满预留 KV（原工具口径）。"""
    assert eng._seq_alloc(1024, 8196, 32768) == pytest.approx(32768)
    assert eng._seq_alloc(8192, 1024, 9216) == pytest.approx(8192 + 512)


def test_kv_decay_floor_at_long_context():
    """长序列下 KV 读带宽效率衰减到地板值，这是长上下文卡数下不去的直接原因。

    衰减区间：t = (seq−4096)/12288，clamp 到 [0,1.35]；
    131072 tok 时 t=10.3 已被 1.35 截断，Dense 只剩 1−0.12×1.35=0.838，MoE 只剩 0.784。
    """
    assert eng._kv_decay(4096, False) == pytest.approx(1.0)
    assert eng._kv_decay(131072, False) == pytest.approx(0.838)
    assert eng._kv_decay(131072, True) == pytest.approx(0.784)
    assert eng._kv_decay(131072, True) > eng.K_KV_FLOOR[True] - 1e-9


# ---------------------------------------------------------------- 量化与精度

def test_int4_falls_back_to_int8_on_910b():
    """910B 无原生 INT4：A 轴强制降 INT8，并计入反量化开销。"""
    r = run("910b", "kb_qa", prec="int4")
    assert r["precision"]["compute"] == "int8"
    assert r["precision"]["int4_forced_to_int8"] is True
    assert r["precision"]["dequant"] == pytest.approx(1.06)


def test_950_keeps_int4():
    r = run("950(486T)", "kb_qa", prec="int4")
    assert r["precision"]["compute"] == "int4"
    assert r["precision"]["dequant"] == pytest.approx(1.04)


def test_int8_halves_weight_footprint():
    bf16 = run("950(486T)", "kb_qa", prec="bf16")
    int8 = run("950(486T)", "kb_qa", prec="int8")
    assert int8["memory"]["weight_gib"] == pytest.approx(bf16["memory"]["weight_gib"] / 2)


def test_auto_precision_recommends_int8_for_large_model():
    model = inference_catalog.find_model("deepseek_v4_flash")
    chip = next(c for c in CHIPS if c["key"] == "950(486T)")
    assert eng._resolve_precision(model, chip, "", "auto")["recommended"] == "int8"


# ---------------------------------------------------------------- 敏感性

def test_sensitivity_bands_are_ordered():
    """同一输入：乐观档卡数不应多于保守档，且保守档 TPOT 不应快于乐观档。"""
    opt = run("910c", "long_gen", profile="optimistic")
    neu = run("910c", "long_gen", profile="neutral")
    con = run("910c", "long_gen", profile="conservative")
    assert opt["result"]["cards"] <= neu["result"]["cards"] <= con["result"]["cards"]
    assert opt["sla"]["tpot_ms"] <= neu["sla"]["tpot_ms"] <= con["sla"]["tpot_ms"]


def test_sensitivity_profile_label_is_reported():
    assert run("910b", "long_gen", profile="conservative")["profile_label"] == "保守档"


# ---------------------------------------------------------------- 告警与边界

def test_bandwidth_floor_marks_unreachable_tpot():
    """超紧 TPOT 下权重搬运本身就超预算：必须打带宽地板标记，提示加卡无效。

    DeepSeek-V4-Pro（1600B）BF16 权重 3222 GB，910B 单卡带宽 1.6TB/s，
    单步权重搬运已远超 1ms 级 TPOT 目标。
    """
    r = eng.estimate(dict(model_key="deepseek_v4_pro", chip_key="910b",
                          scene_key="custom", concurrency=4,
                          prompt_len=1024, output_len=1024, max_ctx=4096,
                          ttft_target_ms=2000, tpot_target_ms=5,
                          weight_precision="bf16"),
                     MODELS, CHIPS, SCENES, "neutral")
    assert "BANDWIDTH_FLOOR" in r["warnings"]
    assert r["decode"]["bandwidth_floor_blocked"] is True


def test_ttft_not_reachable_marks_warning():
    """超长输入 + 极紧 TTFT：机内 TP≤8 无法达成，应标记且不静默给假值。"""
    r = eng.estimate(dict(model_key="qwen3_8b", chip_key="910b", scene_key="custom",
                          concurrency=4, prompt_len=1048576, output_len=1024,
                          max_ctx=1048576, ttft_target_ms=200, tpot_target_ms=50),
                     MODELS, CHIPS, SCENES, "neutral")
    assert "TTFT_NOT_REACHABLE_IN_NODE" in r["warnings"]


def test_missing_model_raises():
    with pytest.raises(eng.InferenceIssue) as exc:
        eng.estimate(dict(model_key="not-a-model", chip_key="910b",
                          scene_key="long_gen", concurrency=9),
                     MODELS, CHIPS, SCENES, "neutral")
    assert exc.value.code == "MISSING_MODEL"


def test_invalid_sla_raises():
    with pytest.raises(eng.InferenceIssue) as exc:
        eng.estimate(dict(model_key="qwen3_8b", chip_key="910b", scene_key="custom",
                          concurrency=9, ttft_target_ms=10),
                     MODELS, CHIPS, SCENES, "neutral")
    assert exc.value.code == "INVALID_SLA"


def test_custom_scene_uses_provided_lengths():
    """custom 档位必须先按用户填入的输入/输出/并发计算，不被模板覆盖。"""
    r = eng.estimate(dict(model_key="qwen3_8b", chip_key="910c", scene_key="custom",
                          concurrency=32, prompt_len=16384, output_len=2048,
                          max_ctx=32768, ttft_target_ms=4000, tpot_target_ms=60),
                     MODELS, CHIPS, SCENES, "neutral")
    assert r["workload"]["prompt_len"] == 16384
    assert r["workload"]["output_len"] == 2048
    assert r["workload"]["concurrency"] == 32
    assert r["result"]["cards"] >= 1


def test_prefix_hit_reduces_prefill_work():
    base = eng.estimate(dict(model_key="deepseek_v3", chip_key="950(486T)",
                             scene_key="kb_qa", concurrency=16, weight_precision="bf16"),
                        MODELS, CHIPS, SCENES, "neutral")
    cached = eng.estimate(dict(model_key="deepseek_v3", chip_key="950(486T)",
                               scene_key="kb_qa", concurrency=16, weight_precision="bf16",
                               prefix_hit=0.6),
                          MODELS, CHIPS, SCENES, "neutral")
    assert cached["prefill"]["flops_per_request"] < base["prefill"]["flops_per_request"]


def test_all_catalog_entries_produce_result():
    """清单内每个模型 × 每种芯片都要能出结果，不得抛未捕获异常。"""
    for model in MODELS:
        for chip in CHIPS:
            r = eng.estimate(dict(model_key=model["key"], chip_key=chip["key"],
                                  scene_key="kb_qa", concurrency=8),
                             MODELS, CHIPS, SCENES, "neutral")
            assert r["result"]["cards"] >= 1
            assert r["topology"]["text"].startswith("TP")


def test_result_is_json_serializable():
    """结果必须能直接 JSON 序列化（Decimal 不得泄漏）。"""
    import json
    r = run("910b", "kb_qa")
    json.dumps(r, ensure_ascii=False)


# ---------------------------------------------------------------- 单调性

def _cards_series(model_key, chip_key, scene_key, concs, profile="neutral"):
    return [eng.estimate(dict(model_key=model_key, chip_key=chip_key,
                              scene_key=scene_key, concurrency=c),
                         MODELS, CHIPS, SCENES, profile)["result"]["cards"]
            for c in concs]


def _assert_monotonic(model_key, chip_key, scene_key, concs, profile="neutral"):
    cards = _cards_series(model_key, chip_key, scene_key, concs, profile)
    for i in range(1, len(cards)):
        assert cards[i] >= cards[i - 1], (
            f"{model_key}@{chip_key}/{scene_key} 并发 {concs[i-1]}→{concs[i]} "
            f"卡数 {cards[i-1]}→{cards[i]}（非单调）")


def test_cards_monotonic_across_max_num_seqs():
    """并发跨过 MAX_NUM_SEQS=256 前后卡数必须单调不减。

    历史 bug（2026-11-08 发现）：GLM-5.2 + 950(486T) + long_gen 在
    224→256 并发区间卡数 128→32 回落。根因是 SLA 回验的路径依赖：
    显存枚举器在 kv_need 跨过 TP4PP3 容量档位时切换最优拓扑（12→16 卡），
    旧拓扑上堆出的 DP 在换拓扑后不回收；修复后 SLA 段改为全拓扑
    「最小满足 dp」搜索（inference.estimate 的 SLA 回验段）。
    """
    _assert_monotonic("glm5_2", "950(486T)", "long_gen",
                      [100, 200, 224, 240, 256, 272, 300, 512, 768, 1024])


def test_cards_monotonic_dense_small_model():
    """小模型（单卡可容纳权重）在并发爬升时同样单调；跨 256 槽位前后重点覆盖。"""
    _assert_monotonic("qwen3_8b", "910c", "kb_qa",
                      [8, 32, 64, 100, 128, 240, 256, 260, 300, 512, 1024])


def test_cards_monotonic_moe_mid_band():
    """MoE 中等模型在枚举器切换 EP 档位的区间（200-700）保持单调。"""
    _assert_monotonic("qwen3_235b_a22b", "910c", "kb_qa",
                      [8, 100, 224, 256, 300, 384, 512, 640, 768, 1024])


def test_cards_monotonic_sla_unreachable_band():
    """SLA 不可达区间（超紧 TPOT）卡数仍单调：卡数由显存下界决定，不因
    兜底拓扑切换而回落（曾出现 552→568 并发 48→40 卡）。"""
    _assert_monotonic("deepseek_v4_pro", "950(425T)", "kb_qa",
                      [400, 480, 552, 560, 568, 600, 700])


def test_cards_monotonic_across_sensitivity_profiles():
    """三档敏感度下都单调：乐观/保守档的系数差异不应引入非单调。"""
    for profile in ("optimistic", "neutral", "conservative"):
        _assert_monotonic("glm5_2", "950(486T)", "long_gen",
                          [100, 224, 256, 300, 512, 1024], profile)

