# -*- coding: utf-8 -*-
"""复现业务场景页 vs 推理评估页的算力差异"""
import json
from decimal import Decimal
from app.schemas import PlanInput, Scenario, InferenceRequest
from app.catalogs import inference_catalog
from app.engine import inference
from app.engine.calculator import calculate

models = inference_catalog.models()
chips = inference_catalog.chips()
scenes = inference_catalog.scenes()

print("=== 公共输入 ===")
print("模型: qwen36_35b_a3b | 芯片: 910c | 场景: long_summary | 并发: 30 | profile: neutral | 精度: auto/auto")

# ---------- 推理评估页路径（直接调 inference.estimate） ----------
spec = InferenceRequest(model_key="qwen36_35b_a3b", chip_key="910c",
                        scene_key="long_summary", concurrency=Decimal(30)).to_engine()
spec["scene_key"] = "long_summary"
r = inference.estimate(spec, models, chips, scenes, "neutral")
print("\n=== 推理评估页 (inference.estimate 原始结果) ===")
print("精度:", r["precision"]["label"], "| compute_tflops:", r["precision"]["compute_tflops"])
print("工作负载: prompt_len=%s output_len=%s max_ctx=%s concurrency=%s" % (
    r["workload"]["prompt_len"], r["workload"]["output_len"], r["workload"]["max_ctx"], r["workload"]["concurrency"]))
print("TTFT目标: %sms | TPOT目标: %sms | prefix_hit=%s" % (
    r["workload"]["ttft_target_ms"], r["workload"]["tpot_target_ms"], spec.get("prefix_hit")))
print("显存约束卡数 A:", r["memory"]["n_memory"])
print("Prefill 约束卡数 B:", r["prefill"]["n_pf"], "| demand_tflops:", r["prefill"]["demand_tflops"])
print("Decode 约束卡数 C:", r["decode"]["n_dc"], "| demand_tflops:", r["decode"]["demand_tflops"])
print("最终卡数:", r["result"]["cards"], "| 瓶颈:", r["result"]["bottleneck"])
print("SLA: passed=%s ttft_ms=%s tpot_ms=%s" % (r["sla"]["passed"], r["sla"]["ttft_ms"], r["sla"]["tpot_ms"]))
print("需求算力(推理评估页显示, P):", round(r["prefill"]["demand_tflops"]/1000, 4))

# ---------- 业务池路径 ----------
scenario = Scenario(name="技术文档摘要",
                    inference=InferenceRequest(model_key="qwen36_35b_a3b", chip_key="910c",
                                               scene_key="long_summary", concurrency=Decimal(30)))
plan = PlanInput(scenarios=[scenario])
report = calculate(plan, [], False, models, chips, scenes)
biz = report["pools"][0]
item = biz["items"][0]
print("\n=== 业务场景页 (calculate -> business 折算) ===")
print("base_p (需求算力 P):", item["base_p"])
print("effective_p (等效算力 P):", item["effective_p"])
print("demand_tflops:", item["trace"]["variables"]["demand_tflops"])
print("compute_tflops:", item["trace"]["variables"]["compute_tflops"])
print("bf16_tflops:", item["trace"]["variables"]["bf16_tflops"])
print("demand_p = demand_tflops × compute/bf16 / 1000 =",
      round(float(item["trace"]["variables"]["demand_tflops"]) * float(item["trace"]["variables"]["compute_tflops"]) / float(item["trace"]["variables"]["bf16_tflops"]) / 1000, 4))
print("卡数:", item["cards"], "| 含余量卡数:", item["cards_planned"], "| headroom:", plan.headroom)
print("需求算力显示(业务场景页, P):", item["base_p"])
