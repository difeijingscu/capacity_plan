"""黄金值基准测试：Python 移植引擎与页面 JS 引擎（golden_eval_engine.json）逐项比对。

验收口径（docs/切换计划-推理评估逻辑统一-v2.0.md 阶段 0/2）：
- A 维精确一致（卡数与中间量逐位一致，A 不经过 exp/pow）；
- B/C 卡数一致，时延中间量允许 1e-9 相对误差（plan 上限 1e-6，此处更严）；
- bottleneck / servers / 告警类型序列 / aggregate 汇总锚点完全一致。

黄金值由 tools/gen_golden_eval_engine.mjs 从页面引擎批量生成，页面改动后重跑即可。
跑法：cd backend; ..\\.venv\\Scripts\\python.exe -m pytest tests/test_inference.py -q
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from app.catalogs import inference_catalog
from app.engine import inference as engine
from app.engine import params

GOLDEN: dict = json.loads(
    (Path(__file__).with_name("golden_eval_engine.json")).read_text(encoding="utf-8"))

_MODEL_VIEWS = {m["key"]: engine._model_view(m) for m in inference_catalog.models()}
_CHIP_VIEWS = {c["key"]: engine._chip_view(c) for c in inference_catalog.chips()}


@pytest.fixture(autouse=True)
def _clean_params():
    """黄金值以页面默认系数为基准：清掉其他用例可能残留的参数覆盖层。"""
    params.reset()
    yield
    params.reset()


def _prec(key: str) -> dict:
    return engine._precision_of(key)


def _run_case(case: dict) -> dict:
    scen = case["scen"]
    return engine.evaluate(
        _MODEL_VIEWS[case["modelKey"]], scen, _CHIP_VIEWS[case["chipKey"]],
        _prec(case["precKey"]), engine.eng_at(case["chipKey"], case["tier"]),
        engine._constants())


def _num(actual, golden, rel: float):
    """黄金值里 Infinity 序列化为字符串；其余数值按相对误差比对。"""
    if isinstance(golden, str):  # "Infinity" / "-Infinity"
        assert actual is None or actual == math.inf or actual == -math.inf, (actual, golden)
        return
    assert actual is not None and math.isfinite(actual), (actual, golden)
    assert actual == pytest.approx(golden, rel=rel), (actual, golden)


A_FIELDS = ("cards", "weightCards", "tp", "replicas", "weightsGB", "usableGB", "kvTokGB", "avgLen", "kvNeedGB")
B_FIELDS = ("cards", "flopsPerReq", "lambda", "serviceMs", "ttftPredMs", "ttftOk")
C_FIELDS = ("cards", "shard", "replicas", "batch", "stepMs", "floorMs", "bandLimited",
            "tpotShort", "tpotReached", "effortCards", "effortMs", "effortShard", "repMax")


@pytest.mark.parametrize("case", GOLDEN["cases"], ids=lambda c: c["id"])
def test_golden_case(case: dict):
    out = _run_case(case)
    g = case["out"]

    # A 维：精确一致
    for field in A_FIELDS:
        assert out["A"][field] == g["A"][field], f"A.{field}"

    # B/C：卡数与布尔精确一致，时延中间量 1e-9 相对误差
    for field in B_FIELDS:
        expected, actual = g["B"][field], out["B"][field]
        if isinstance(expected, bool) or field == "cards":
            assert actual == expected, f"B.{field}: {actual} != {expected}"
        else:
            _num(actual, expected, 1e-9)
    for field in C_FIELDS:
        expected, actual = g["C"][field], out["C"][field]
        if isinstance(expected, bool) or field in ("cards", "shard", "replicas", "batch",
                                                   "effortCards", "effortShard", "repMax"):
            assert actual == expected, f"C.{field}: {actual} != {expected}"
        else:
            _num(actual, expected, 1e-9)

    # 合成结果：完全一致
    assert out["rawCards"] == g["rawCards"]
    assert out["cards"] == g["cards"]
    assert out["a"] == g["a"] and out["b"] == g["b"] and out["c"] == g["c"]
    assert out["bottleneck"] == g["bottleneck"]
    assert out["servers"] == g["servers"]
    assert [w["type"] for w in out["warnings"]] == [w["type"] for w in g["warnings"]]


def test_golden_aggregate_anchor():
    """aggregate 汇总锚点：29 场景 × 950dt36 × bf16 × standard。"""
    anchor = GOLDEN["aggregate_anchor"]
    scenes = {s["key"]: s for s in inference_catalog.scenes()}
    results = []
    for key, scene in scenes.items():
        model_key = scene["default_model_key"]
        scen = {"promptLen": scene["prompt_len"], "outputLen": scene["output_len"],
                "conc": float(scene["concurrency"]), "ttft": float(scene["ttft_ms"]),
                "tpot": float(scene["tpot_ms"])}
        out = engine.evaluate(
            _MODEL_VIEWS[model_key], scen, _CHIP_VIEWS["950dt36"], _prec("bf16"),
            engine.eng_at("950dt36", "standard"), engine._constants())
        results.append({"modelKey": key, "modelName": scene["name"], "chipKey": "950dt36",
                        "cards": out["cards"], "bottleneck": out["bottleneck"],
                        "scen": scen, "chip": _CHIP_VIEWS["950dt36"]})
    agg = engine.aggregate(results)
    assert agg["totalCards"] == anchor["totalCards"]
    assert agg["servers"] == anchor["servers"]
    assert agg["powerKW"] == pytest.approx(anchor["powerKW"])
    assert [(g["chipKey"], g["cards"]) for g in agg["byChip"]] == \
        [(g["chipKey"], g["cards"]) for g in anchor["byChip"]]
    assert agg["bottleneckDist"] == anchor["bottleneckDist"]
    got_models = {m["modelKey"]: (m["cards"], m["bottleneck"]) for m in agg["byModel"]}
    want_models = {m["modelKey"]: (m["cards"], m["bottleneck"]) for m in anchor["byModel"]}
    assert got_models == want_models


# ---------------------------------------------------------------- 高层入口与迁移口径

def test_precision_aliases_and_guard():
    assert engine._precision_of("")["key"] == "bf16"
    assert engine._precision_of(None)["key"] == "bf16"
    assert engine._precision_of("fp16")["key"] == "bf16"
    assert engine._precision_of("fp8")["key"] == "w8a8"
    assert engine._precision_of("int8")["key"] == "w8a8"
    assert engine._precision_of("int4")["key"] == "w4a8"
    # W4A8 在无原生 INT4 的芯片上拒绝（910c nativeInt4=False），新旧精度值同口径
    models, chips, scenes = inference_catalog.models(), inference_catalog.chips(), inference_catalog.scenes()
    for precision in ("w4a8", "int4"):
        request = {"model_key": "qwen3_8b", "chip_key": "910c", "weight_precision": precision,
                   "scene_key": "rag"}
        with pytest.raises(engine.InferenceIssue, match="INT4"):
            engine.estimate(request, models, chips, scenes)


def test_profile_tier_mapping():
    assert engine.PROFILE_TIER == {"optimistic": "aggressive", "neutral": "standard",
                                   "conservative": "conservative"}


def test_eng_at_tier_scaling():
    """档位缩放：效率类全额、mem_util 半幅、比值与 KV 预留不缩放。"""
    eng = engine.eng_at("910c", "conservative")
    assert eng["mfuP"] == pytest.approx(0.26 * 0.8)
    assert eng["bwUtilD"] == pytest.approx(0.62 * 0.8)
    assert eng["memUtil"] == pytest.approx(0.90 * 0.8 ** 0.5)
    assert eng["mfuDRatio"] == 0.80 and eng["kvReserve"] == 1.10
    aggressive = engine.eng_at("910c", "aggressive")
    assert aggressive["mfuP"] == pytest.approx(0.26 * 1.2)


def test_estimate_high_level():
    result = engine.estimate(
        {"model_key": "glm5_3_flash", "chip_key": "950dt36", "scene_key": "rag",
         "weight_precision": "auto"},
        inference_catalog.models(), inference_catalog.chips(), inference_catalog.scenes(),
        "neutral")
    assert result["tier"] == "standard"
    assert result["precKey"] == "bf16"
    assert result["cards"] == max(result["a"], result["b"], result["c"])
    assert result["cards"] % 2 == 0
    assert result["servers"] == math.ceil(result["cards"] / 8)
    assert result["bottleneck"] in ("mem", "prefill", "decode")
    assert isinstance(result["warnings"], list)


# ---------------------------------------------------------------- 杜邦式拆解树

def _assert_node(node: dict):
    assert set(node) >= {"label", "relation", "expr", "value", "note", "tag",
                         "highlight", "children"}
    assert isinstance(node["label"], str) and node["label"]
    assert isinstance(node["children"], list)
    for child in node["children"]:
        _assert_node(child)


def test_evaluate_tree_structure():
    """杜邦树：根 = max(A,B,C) → 补偶；三条约束子树齐全；主导约束被高亮。"""
    scen = {"promptLen": 4096, "outputLen": 1024, "conc": 100.0, "ttft": 2000.0, "tpot": 50.0}
    out = engine.evaluate(
        _MODEL_VIEWS["glm5_3_flash"], scen, _CHIP_VIEWS["950dt36"],
        _prec("bf16"), engine.eng_at("950dt36", "standard"), engine._constants())
    tree = out["tree"]
    _assert_node(tree)
    assert tree["label"] == "所需算力卡 N"
    assert tree["tag"] == "总计"
    labels = [c["label"] for c in tree["children"]]
    assert labels == ["A · 显存约束", "B · Prefill 约束", "C · Decode 约束"]
    highlighted = [c for c in tree["children"] if c["highlight"]]
    assert len(highlighted) == 1
    assert highlighted[0]["label"].startswith(
        {"mem": "A", "prefill": "B", "decode": "C"}[out["bottleneck"]])
    # A 子树：权重装载宽度与副本数两个分支
    a_node = tree["children"][0]
    assert [c["label"] for c in a_node["children"]] == ["① 权重装载宽度", "② 副本数"]
    # 树必须可 JSON 序列化（随 trace.detail 进快照与 preview 响应）
    json.dumps(tree, ensure_ascii=False)


def test_evaluate_tree_in_estimate_output():
    """高层入口同样带树，且数值与 A/B/C 卡数一致。"""
    result = engine.estimate(
        {"model_key": "qwen3_8b", "chip_key": "910c", "scene_key": "rag",
         "weight_precision": "auto"},
        inference_catalog.models(), inference_catalog.chips(), inference_catalog.scenes())
    assert result["tree"]["children"][0]["value"] == f"{result['a']} 卡"
    json.dumps(result, ensure_ascii=False, default=str)


# ---------------------------------------------------------------- 自定义算力卡

CUSTOM_CHIP = {
    "key": "custom_x", "label": "自定义测试卡", "family": "custom",
    "bf16_tflops": 500.0, "int8_tflops": 1000.0, "int4_tflops": 0.0,
    "memory_gb": 96.0, "hbm_tbs": 2.4, "link_gbs": 200.0,
    "native_int4": False, "power_kw": 0.5, "custom": True,
}


def test_custom_chip_estimate_fallback_profile():
    """未登记工程系数的芯片按 CUSTOM_CHIP_PROFILE 通用经验值计算，不报 MISSING_CHIP。"""
    chips = inference_catalog.chips() + [CUSTOM_CHIP]
    result = engine.estimate(
        {"model_key": "qwen3_8b", "chip_key": "custom_x", "scene_key": "rag",
         "weight_precision": "bf16"},
        inference_catalog.models(), chips, inference_catalog.scenes())
    assert result["cards"] > 0
    assert result["chipKey"] == "custom_x"
    # 生效系数 = 通用经验值（均衡档 ×1）
    assert result["eng"]["mfuP"] == pytest.approx(engine.CUSTOM_CHIP_PROFILE["mfu_prefill"])
    assert result["eng"]["kvReserve"] == pytest.approx(engine.CUSTOM_CHIP_PROFILE["kv_reserve"])


def test_custom_chip_profile_overridable():
    """自定义芯片的工程系数可通过 chip_profiles 覆盖（params 不限制芯片名）。"""
    params.set_overrides({"chip_profiles": {"custom_x": {"mfu_prefill": 0.30}}})
    eng = engine.eng_at("custom_x", "standard")
    assert eng["mfuP"] == pytest.approx(0.30)
    # 其余字段仍取通用经验值
    assert eng["bwUtilD"] == pytest.approx(engine.CUSTOM_CHIP_PROFILE["bw_decode"])
