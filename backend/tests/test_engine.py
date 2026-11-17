import copy
import json
import time
from decimal import Decimal as D
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.catalogs import SYNTHETIC, inference_catalog, seeds
from app.engine.business import planned_cards
from app.engine.calculator import calculate, cards_for_pool, compute_task, cost_estimate
from app.schemas import (Allocation, Development, DevModel, InferenceRequest, Innovation,
                          PlanInput, Scenario, Task)

FIXTURES=json.loads((Path(__file__).parents[2]/"docs/计算验收样例.json").read_text(encoding="utf-8"))
CASES={case["id"]:case for case in FIXTURES["cases"]}


def near(actual,expected):
    assert float(actual)==pytest.approx(expected,rel=1e-8,abs=1e-9)


def task(users=100,**kwargs):
    return Task(model_id=SYNTHETIC["id"],online_users=users,**kwargs)


def spec(**kwargs):
    """业务池场景配置：默认 8B × 910C × 知识库问答（rag）× 100 路并发。"""
    values=dict(model_key="qwen3_8b",chip_key="910c",scene_key="rag",concurrency=100)
    values.update(kwargs)
    return InferenceRequest(**values)


def plan(*specs,**kwargs):
    return PlanInput(scenarios=[Scenario(name=f"场景{i}",inference=s) for i,s in enumerate(specs)],**kwargs)


def result(*specs,**kwargs):
    """创新/研发池 v2.0.0 起从推理模型清单取数；验收用 SYNTHETIC 经
    custom_inference_models 注入（total_b/active_b 由基线参数换算，工作负载口径不变）。"""
    return calculate(plan(*specs,**kwargs),[SYNTHETIC],
                     custom_inference_models=[as_inference(SYNTHETIC)])


def as_inference(m):
    """把旧训练基线模型（绝对参数量）换算成推理清单形态，供创新/研发池 lookup。"""
    return {"key": m["id"], "label": m.get("display_name") or m["id"],
            "total_b": float(D(str(m["resident_parameters"]))/D("1e9")),
            "active_b": float(D(str(m["active_parameters_prefill"]))/D("1e9")),
            "arch": m.get("architecture", "Dense"),
            "cache": m.get("cache"),
            "eligible_training_methods": m.get("eligible_training_methods")}


def legacy_task(users=100,**kwargs):
    """旧清单里的任务：模型名要能被推理模型清单匹配，迁移路径才成立。"""
    return Task(model_id="qwen3-8b",online_users=users,**kwargs)


def legacy_plan(*tasks,**kwargs):
    """旧方案：只有 components，没有 inference，用于验证迁移路径。"""
    return PlanInput(scenarios=[Scenario(name=f"场景{i}",components=[t]) for i,t in enumerate(tasks)],**kwargs)


@pytest.mark.parametrize("case_id",["business_8b","business_double_users"])
def test_golden_business(case_id):
    case=CASES[case_id]
    actual=compute_task(task(**{"users":case["input"]["online_users"]}),SYNTHETIC)
    for key in ("base_p","effective_p"):
        if key in case["expected"]:
            near(actual[key],case["expected"][key])
    near(actual["base_p"]*D("1.2"),case["expected"]["planned_p"])


def test_business_pool_reports_cards_and_compute():
    """业务池输出两张表：物理卡数（台）与 BF16 基准算力（P），两者不同量纲。"""
    pool=result(spec())["pools"][0]
    assert pool["cards"]>=1
    assert pool["cards_planned"]>=pool["cards"]
    assert pool["servers"]>=1
    assert D(pool["capacity_p"])>0
    assert D(pool["base_p"])>0
    near(D(pool["capacity_p"])/D(pool["cards"]),0.56)   # 910C 单卡 560 TFLOPS → 0.56 P


def innovation(**kwargs):
    return Innovation(enabled=True,users=1000,quota_per_user_month=1_000_000,allocations=[Allocation(model_id=SYNTHETIC["id"],share=1)],**kwargs)


def innovation_q(**kwargs):
    """可指定人数的创新池（innovation() 已固定 1000 人，不能改）。"""
    kwargs.setdefault("users",1000)
    return Innovation(enabled=True,quota_per_user_month=1_000_000,allocations=[Allocation(model_id=SYNTHETIC["id"],share=1)],**kwargs)


def test_golden_innovation():
    report=result(innovation=innovation())
    actual=report["pools"][1]
    expected=CASES["innovation_8b_monthly"]["expected"]
    near(actual["base_p"],expected["base_p"])
    near(actual["planned_p"],expected["planned_p"])
    near(actual["monthly_tokens"],expected["monthly_total_tokens"])
    quota=actual["items"][0]["trace"]["quota"]
    near(quota["input_tokens_per_second"],expected["input_tokens_per_second"])
    near(quota["output_tokens_per_second"],expected["output_tokens_per_second"])


def test_golden_split():
    big={**SYNTHETIC,"id":"synthetic-dense-16b","active_parameters_prefill":16e9,"active_parameters_decode":16e9,
         "resident_parameters":16e9}
    config=innovation()
    config.allocations=[Allocation(model_id=SYNTHETIC["id"],share=".7"),Allocation(model_id=big["id"],share=".3")]
    report=calculate(PlanInput(innovation=config),[SYNTHETIC],
                     custom_inference_models=[as_inference(SYNTHETIC),as_inference(big)])
    near(report["pools"][1]["base_p"],CASES["innovation_allocation"]["expected"]["base_p"])
    assert sum(D(i["monthly_tokens"]) for i in report["pools"][1]["items"])==D("1e9")


def dev():
    return Development(enabled=True,models=[DevModel(model_id=SYNTHETIC["id"])])


def test_golden_development():
    pool=result(development=dev())["pools"][2]
    near(pool["base_p"],CASES["development_standard_8b"]["expected"]["base_p"])
    near(pool["planned_p"],CASES["development_standard_8b"]["expected"]["planned_p"])
    near(pool["items"][0]["base_p"],CASES["development_standard_8b"]["expected"]["train_base_p"])


def test_non_llm_scenario_is_reported_not_guessed():
    """视频检测/批量任务已在 v2.0.0 移除：进 missing_items 报 MODEL_RETIRED，不按默认档硬算。"""
    cv_model=next(m for m in seeds("models") if m["id"]=="yolo26s")
    config=legacy_plan(legacy_task(),Task(model_id="yolo26s",task_type="cv",streams=10,analysis_fps=5),innovation=innovation(),development=dev())
    report=calculate(config,[SYNTHETIC,cv_model],custom_inference_models=[as_inference(SYNTHETIC)])
    codes=[m["code"] for m in report["missing_items"] if m["pool_id"]=="business"]
    assert "MODEL_RETIRED" in codes
    assert report["completeness"]=="PARTIAL"


def test_more_concurrency_never_reduces_cards():
    light=result(spec(concurrency=8))["pools"][0]
    heavy=result(spec(concurrency=256))["pools"][0]
    assert heavy["cards"]>=light["cards"]
    assert D(heavy["base_p"])>D(light["base_p"])


def test_three_pools_do_not_share():
    report=result(spec(),innovation=innovation(),development=dev())
    assert all(D(p["memory"]["memory_gb"])>0 for p in report["pools"])


def test_memory_reserve_is_deprecated_and_has_no_effect():
    """显存预留已停用：改这个值不得改变任一池的显存需求、卡数与卡数（含余量）。"""
    base=result(spec(),innovation=innovation(),development=dev())
    high=result(spec(),innovation=innovation(),development=dev(),memory_reserve=".5")
    for low_pool,high_pool in zip(base["pools"],high["pools"]):
        assert low_pool["memory"]["memory_gb"]==high_pool["memory"]["memory_gb"]
        assert low_pool.get("cards")==high_pool.get("cards")
        assert low_pool.get("cards_planned")==high_pool.get("cards_planned")


def test_moe_and_distinct_phase_params():
    model={**SYNTHETIC,"architecture":"MoE","resident_parameters":100e9,"active_parameters_prefill":4e9,"active_parameters_decode":8e9}
    actual=compute_task(task(kappa_prefill=1.1,kappa_decode=1.1),model)
    reference=compute_task(task(),SYNTHETIC)
    assert actual["memory"]["weight_gb"]==D(200)
    assert actual["base_p"]<reference["base_p"]
    assert actual["prefill_flop_per_request"]==reference["prefill_flop_per_request"]/2
    assert actual["decode_flop_per_request"]==reference["decode_flop_per_request"]


def test_mla_kv_cache_uses_latent_plus_rope():
    """MLA 每 Token KV = 层数 × (低秩维 + RoPE维) × 字节数。"""
    model={**SYNTHETIC,"layers":2,"latent_dim":16,"rope_dim":8}
    actual=compute_task(Task(model_id="mla",request_rate=1,input_tokens=100,answer_tokens=20,
                             reasoning_tokens=0,ttft_seconds=0,output_tokens_per_second=20),model)
    # expected_concurrent=1，序列数=1；2 × (16 + 8) × 2B × (100 + 20) = 11520B。
    assert actual["memory"]["expected_concurrent"]==1
    assert actual["memory"]["allocated_sequences"]==1
    assert actual["memory"]["cache_gb"]==D("0.00001152")


def test_half_service_window_doubles_capacity():
    original=result(innovation=innovation())["pools"][1]
    half=result(innovation=innovation(service_hours_per_day=4))["pools"][1]
    near(half["base_p"],float(original["base_p"])*2)


def test_native_capacity_not_implicitly_converted():
    """原生存量不走推理引擎，也不按默认档折算成 BF16 基准算力。"""
    report=calculate(legacy_plan(legacy_task(),Task(task_type="native",native_precision="INT8",native_capacity=100)),[SYNTHETIC],custom_inference_models=[as_inference(SYNTHETIC)])
    assert report["missing_items"][0]["code"]=="MODEL_RETIRED"
    assert report["completeness"]=="PARTIAL"


def test_high_intensity_and_candidate_invariance():
    standard=result(development=dev())
    high=dev(); high.intensity="high"
    assert D(result(development=high)["total_planned_p"])>D(standard["total_planned_p"])
    small={**SYNTHETIC,"id":"small","active_parameters_prefill":1e9,"active_parameters_decode":1e9}
    config=dev();config.models.append(DevModel(model_id="small"))
    actual=calculate(PlanInput(development=config),[SYNTHETIC,small],
                     custom_inference_models=[as_inference(SYNTHETIC),as_inference(small)])
    assert actual["total_planned_p"]==standard["total_planned_p"]


def test_disabled_and_missing_dev():
    assert result(spec())["pools"][2]["planned_p"]=="0.00"
    missing=result(spec(),development=Development(enabled=True))
    assert missing["pools"][2]["planned_p"] is None
    assert missing["completeness"]=="PARTIAL"


def test_disabled_innovation_and_development_have_zero_resources():
    """禁用池即使未选芯片也返回零资源，不应用最低一卡、余量或冗余。"""
    report=calculate(PlanInput(innovation=Innovation(enabled=False,chip_key=None),
                               development=Development(enabled=False,chip_key=None)),[])
    for pool in report["pools"][1:]:
        assert pool["completeness"]=="DISABLED"
        assert pool["cards"]==0
        assert pool["cards_planned"]==0
        assert pool["servers"]==0
        assert pool["servers_planned"]==0
        assert D(pool["capacity_p"])==0
        assert D(pool["capacity_planned_p"])==0
        assert pool["cards_detail"]["headroom_applications"]==0
        assert pool["cards_detail"]["redundancy_cards"]==0


def test_missing_scenario_not_lost():
    """无法估算的场景必须留在 missing_items，不能悄悄消失。"""
    report=calculate(legacy_plan(legacy_task(),Task(task_type="unit",units_per_second=10)),[SYNTHETIC],custom_inference_models=[as_inference(SYNTHETIC)])
    assert report["completeness"]=="PARTIAL"
    assert report["total_tasks"]==2
    assert report["counted_tasks"]==1
    assert report["missing_items"][0]["code"]=="MODEL_RETIRED"


def test_vlm_same_as_text():
    """v2.0.0 移除图文/视觉折算：vlm 任务与 text 同口径（视觉 Token 已含在输入额度内）。"""
    model={**SYNTHETIC,"tasks":["text","vlm"]}
    normal=compute_task(task(),model)
    vision=compute_task(task(task_type="vlm"),model)
    assert vision["base_p"]==normal["base_p"]
    assert D(vision["vision_flop_per_request"])==0


def test_headroom_once():
    """余量只在池层乘一次：planned = base × (1+h)，卡数不再叠加第二重余量。"""
    one=result(spec(),headroom=".2")["pools"][0]
    near(D(one["planned_p"]),float(one["base_p"])*1.2)
    two=result(spec(),spec(),headroom=".2")["pools"][0]
    near(D(two["base_p"]),float(one["base_p"])*2)
    near(D(two["planned_p"]),float(two["base_p"])*1.2)


def test_pool_compute_headroom_is_not_applied_twice():
    """100P 经一次20%余量为120卡；另加的一张是冗余，不是第二次比例余量。"""
    detail=cards_for_pool({"planned_p":D(120),"memory":{"memory_gb":0}},
                          {"key":"1p","bf16_tflops":1000,"memory_gb":80},D(".2"))
    assert detail["cards"]==120
    assert detail["cards_detail"]["planned_compute_cards"]==120
    assert detail["cards_planned"]==121
    assert detail["cards_detail"]["headroom_applications"]==1
    assert detail["cards_detail"]["redundancy_cards"]==1


def test_pool_zero_headroom_keeps_only_explicit_redundancy():
    detail=cards_for_pool({"planned_p":D(100),"memory":{"memory_gb":0}},
                          {"key":"1p","bf16_tflops":1000,"memory_gb":80},D(0))
    assert detail["cards"]==100
    assert detail["cards_detail"]["planned_compute_cards"]==100
    assert detail["cards_planned"]==101


def test_pool_memory_headroom_is_applied_once():
    """显存基础约束为10卡，20%余量后为12卡；不能再放大成15卡。"""
    detail=cards_for_pool({"planned_p":D(1),"memory":{"memory_gb":800}},
                          {"key":"1p","bf16_tflops":1000,"memory_gb":80},D(".2"))
    assert detail["cards_detail"]["memory_cards"]==10
    assert detail["cards_detail"]["planned_memory_cards"]==12
    assert detail["cards_planned"]==12


@pytest.mark.parametrize("cards,h,expected",[
    (1,"0",8),      # 不足一个部署单元 → 补到 8
    (2,"0",8),
    (8,"0",8),      # h=0 不再强制增加一台
    (9,"0",16),
    (10,".2",16),
    (18,".2",24),
    (20,".2",24),
    (40,".2",48),   # 浮点回归：40×1.2 不能因 48.00000000000001 变成 56
])
def test_business_cards_align_to_deployment_unit(cards,h,expected):
    """8 卡是最小部署粒度，不是"至少多一台实例"：按 8 卡向上取整且不少于 8 卡。"""
    assert planned_cards(cards,8,h)==expected


def test_business_pool_planned_cards_are_deployment_multiples():
    """业务池汇总卡数同样落在部署粒度上，且零余量时不会额外增加一台。"""
    pool=result(spec(),headroom="0")["pools"][0]
    assert pool["cards_planned"]%8==0
    assert pool["cards_planned"]>=8
    assert pool["cards_planned"]>=pool["cards"]


def test_independent_pool_cost_rounding_and_missing_price():
    report={"completeness":"COMPLETE","pools":[{"id":str(i),"planned_p":".4","completeness":"COMPLETE","memory":{"status":"COMPLETE","memory_gb":1}} for i in range(2)]}
    cost=cost_estimate(report,[{"id":"card","dense_p16":1,"memory_gb":80}],{})
    assert cost["items"][0]["reference_cards"]==2
    assert cost["items"][0]["amount_low"] is None
    assert cost["items"][0]["status"]=="PRICE_MISSING"


def test_plan_rejects_removed_time_period_fields():
    assert "planning_start" not in PlanInput().model_dump()
    with pytest.raises(ValidationError):
        PlanInput.model_validate({"planning_end": "2031-10-20"})
    with pytest.raises(ValidationError):
        PlanInput.model_validate({"annual_growth": 0.1})


def test_innovation_reasoning_not_added_twice():
    report=result(innovation=innovation())["pools"][1]
    assert report["items"][0]["trace"]["variables"]["generation_tokens_total"]=="512.0"


@pytest.mark.parametrize("override",[
    {"headroom":-1},{"memory_reserve":1},
    {"innovation":{"enabled":True,"users":1,"quota_per_user_month":1,"service_hours_per_day":0}},
    {"innovation":{"enabled":True,"allocations":[{"model_id":"a","share":".7"},{"model_id":"b","share":".4"}]}}
])
def test_invalid_parameters_rejected(override):
    with pytest.raises(ValidationError):
        PlanInput.model_validate(override)


def test_unknown_cache_lower_bound():
    """缓存结构缺失只影响旧口径（创新/研发池），业务池显存由推理引擎自行判定。"""
    model={**SYNTHETIC,"cache":{"type":"unknown"}}
    report=calculate(legacy_plan(legacy_task(),innovation=innovation()),[model],
                     custom_inference_models=[as_inference(model)])
    assert report["pools"][1]["memory"]["status"]=="WEIGHT_LOWER_BOUND"


def test_single_session_still_yields_a_plan():
    """并发下限为 1：单个会话也要给出可行卡数，不能因为量小就返回 0。"""
    pool=result(spec(concurrency=1))["pools"][0]
    assert pool["cards"]>=1
    assert D(pool["base_p"])>0


def test_context_window_must_cover_prompt_and_output():
    with pytest.raises(ValidationError):
        spec(prompt_len=32000,output_len=8000,max_ctx=32768)
    report=result(spec(prompt_len=32000,output_len=8000,max_ctx=65536))["pools"][0]
    assert report["cards"]>=1


def test_max_ctx_and_prefix_hit_do_not_change_result():
    """max_ctx / prefix_hit 是兼容保留字段，不得影响结果。

    页面已移除这两项输入，引擎也不消费；保留字段只为旧 payload 通过校验、旧快照
    原值可读。若哪天它们重新参与计算，这条断言会失败，提醒同步界面与口径说明。
    """
    base=result(spec(prompt_len=2000,output_len=500))["pools"][0]
    wider=result(spec(prompt_len=2000,output_len=500,max_ctx=1048576,prefix_hit=0.5))["pools"][0]
    assert wider["cards"]==base["cards"]
    assert wider["base_p"]==base["base_p"]
    assert wider["planned_p"]==base["planned_p"]


def test_1000_scenarios_under_5_seconds():
    config=plan(*(spec() for _ in range(1000)))
    start=time.perf_counter()
    report=calculate(config,[])
    assert time.perf_counter()-start<5
    assert report["counted_tasks"]==1000


def test_legacy_scenario_is_migrated_with_warning():
    """旧方案没有 inference 时按旧字段推导，并明确告警，不静默套默认值。"""
    report=calculate(legacy_plan(legacy_task(users=100,input_tokens=1024,answer_tokens=256)),[SYNTHETIC])
    item=report["pools"][0]["items"][0]
    assert item["inference_origin"]=="migrated"
    assert "MIGRATED_INFERENCE" in item["warnings"]
    assert item["trace"]["variables"]["concurrency"]==100
    assert item["trace"]["variables"]["prompt_len"]==1024


def test_legacy_scenario_without_model_is_reported_not_guessed():
    """旧清单常缺模型字段：不按默认模型硬算，直接报缺输入。"""
    report=calculate(legacy_plan(Task(task_type="text",online_users=100)),[])
    assert [m["code"] for m in report["missing_items"]]==["MISSING_MODEL"]
    assert report["pools"][0]["items"]==[]
    assert report["completeness"]=="BLOCKED"


def test_legacy_model_not_in_catalog_is_reported_not_guessed():
    """旧清单写了模型名但 v2.0 清单里没有：不许落到默认模型上硬算。"""
    report=calculate(legacy_plan(Task(model_id="llama-3-70b",task_type="text",online_users=100)),[])
    assert [m["code"] for m in report["missing_items"]]==["MODEL_RETIRED"]
    assert "llama-3-70b" in report["missing_items"][0]["message"]
    assert report["pools"][0]["items"]==[]
    assert report["completeness"]=="BLOCKED"


def test_scenario_without_any_input_is_blocked_not_defaulted():
    """空场景不再按默认模型出卡数：宁可报待补，也不给一个看起来成立的结果。"""
    report=calculate(PlanInput(scenarios=[Scenario(name="空场景")]),[])
    assert report["pools"][0]["items"]==[]
    assert [m["code"] for m in report["missing_items"]]==["MISSING_MODEL"]
    assert report["completeness"]=="BLOCKED"


def test_scenario_with_all_components_disabled_is_blocked():
    """场景启用但组件全停用：过去会回退到第一个组件硬算，现在应阻断。"""
    plan_input=PlanInput(scenarios=[Scenario(name="停用场景",components=[
        Task(model_id="qwen3_8b",task_type="text",online_users=100,enabled=False)])])
    report=calculate(plan_input,[])
    assert report["pools"][0]["items"]==[]
    assert [m["code"] for m in report["missing_items"]]==["SCENARIO_DISABLED_COMPONENTS"]
    assert report["completeness"]=="BLOCKED"


def test_multi_component_scenario_warns_about_ignored_components():
    """多组件只按首个启用项折算，必须显式告警，不能静默丢组件。"""
    plan_input=PlanInput(scenarios=[Scenario(name="双组件场景",components=[
        Task(model_id="qwen3_8b",task_type="text",online_users=100),
        Task(model_id="qwen3_8b",task_type="text",online_users=100)])])
    pool=calculate(plan_input,[])["pools"][0]
    assert len(pool["items"])==1
    assert "COMPONENTS_PARTIALLY_IGNORED" in pool["items"][0]["warnings"]


def test_global_weight_precision_applies_to_migrated_scenarios():
    """全局量化精度（business_defaults.weight_precision）必须对旧字段场景生效。

    业务页的「全局硬件配置」与推理评估页对齐后提供该下拉；若后端不消费，
    页面选 W8A8 仍按 BF16 出卡数，等于控件是装饰。
    """
    def cards(precision):
        plan_input=PlanInput(
            business_defaults={"chip_key":"910c","profile":"neutral","weight_precision":precision},
            scenarios=[Scenario(name="旧场景",
                                components=[Task(model_id="qwen3_8b",task_type="text",online_users=100)])])
        item=calculate(plan_input,[])["pools"][0]["items"][0]
        return item["cards"],item["inference_spec"]["weight_precision"]
    bf16_cards,bf16_prec=cards("bf16")
    w8a8_cards,w8a8_prec=cards("w8a8")
    assert bf16_prec=="bf16"
    assert w8a8_prec=="w8a8"
    # W8A8 权重减半：显存主导的场景卡数必须下降，不能与 BF16 同值
    assert w8a8_cards < bf16_cards
    # 旧值 auto 一律归一为 bf16：页面分段控件只有三档，不能再回显 auto 造成口径分裂
    assert cards("auto")[1]=="bf16"


def test_global_weight_precision_overrides_configured_scenario():
    """已配置场景也不再按自身历史精度计算：精度是方案级设置。

    页面取消了场景行的逐场景精度下拉，全局下拉是唯一入口。若后端仍以
    scenario.inference.weight_precision 为准，改了全局下拉对已配置场景无效，
    页面显示全局 W8A8、实际按 BF16 出卡，又回到「显示一套、算另一套」。
    """
    def cards(global_prec,scenario_prec):
        plan_input=PlanInput(
            business_defaults={"chip_key":"910c","profile":"neutral","weight_precision":global_prec},
            scenarios=[Scenario(name="已配置场景",inference=spec(weight_precision=scenario_prec))])
        item=calculate(plan_input,[])["pools"][0]["items"][0]
        return item["cards"],item["inference_spec"]["weight_precision"]
    # 场景里留着 bf16 的历史值，全局改成 w8a8 后必须以全局为准
    w8a8_cards,w8a8_prec=cards("w8a8","bf16")
    assert w8a8_prec=="w8a8"
    assert w8a8_cards < cards("bf16","bf16")[0]
    # 旧值 auto 等价 BF16，同样覆盖场景值并归一为 bf16（分段控件只有三档）
    assert cards("auto","w8a8")[1]=="bf16"

    # 老方案没有该全局字段时保持原行为，历史结果不漂移
    legacy=PlanInput(business_defaults={"chip_key":"910c","profile":"neutral"},
                     scenarios=[Scenario(name="老方案场景",inference=spec(weight_precision="w8a8"))])
    assert calculate(legacy,[])["pools"][0]["items"][0]["inference_spec"]["weight_precision"]=="w8a8"


def test_disabled_scenario_still_exposes_resolved_spec_for_display():
    """停用场景不参与计算，但仍返回解析结果，供页面回显（前端不再自行迁移）。"""
    plan_input=PlanInput(scenarios=[Scenario(
        name="停用场景",enabled=False,
        components=[Task(model_id="qwen3_8b",task_type="text",online_users=50)])])
    pool=calculate(plan_input,[])["pools"][0]
    assert pool["items"]==[]
    resolved=pool["resolved_specs"][plan_input.scenarios[0].id]
    assert resolved["enabled"] is False
    assert resolved["spec"]["model_key"]=="qwen3_8b"
    assert resolved["spec"]["concurrency"]==50.0
    assert resolved["origin"]=="migrated"


def test_sensitivity_recalculates():
    # v2 口径按并发缩放：低并发档位有卡数对齐的量化死区（100↔80 同卡数），
    # 用高并发场景保证 ±20% 负载缩放能拉开卡数差异。
    report=calculate(plan(spec(concurrency=500)),[],True)
    assert D(report["sensitivity"][0]["total_planned_p"])<D(report["total_planned_p"])
    assert D(report["sensitivity"][1]["total_planned_p"])>D(report["total_planned_p"])


def test_custom_model_flows_through_business_and_sensitivity():
    """同规格自定义模型应与内置模型逐项一致，敏感性结果不得退回 null。"""
    model={**inference_catalog.find_model("qwen3_8b"),"key":"custom-8b","label":"自定义 8B"}
    custom=calculate(plan(spec(model_key="custom-8b",concurrency=500)),[],True,
                     inference_models=[],custom_inference_models=[model])
    reference=calculate(plan(spec(concurrency=500)),[],True)
    pool=custom["pools"][0]
    expected=reference["pools"][0]
    assert custom["completeness"]=="COMPLETE"
    assert pool["completeness"]=="COMPLETE"
    assert pool["items"][0]["model_id"]=="custom-8b"
    assert pool["items"][0]["chip_key"]=="910c"
    for field in ("cards","cards_planned","servers","base_p","planned_p","capacity_p","capacity_planned_p"):
        assert pool[field]==expected[field]
    assert [D(v["total_planned_p"]) for v in custom["sensitivity"]]==[
        D(v["total_planned_p"]) for v in reference["sensitivity"]]


def test_scenarios_aggregate_without_double_margin():
    """两个同配置场景：需求相加，卡数相加，余量只乘一次。"""
    one=result(spec())["pools"][0]
    two=result(spec(),spec())["pools"][0]
    assert two["cards"]==one["cards"]*2
    near(D(two["planned_p"]),float(one["base_p"])*2*1.2)
    assert len(two["scenarios"])==2


# ------------------------------------------------ 创新/研发池出卡数（v1.4）

def test_innovation_pool_reports_cards():
    """创新池主链路必须给出卡数，口径与业务池一致：算力与显存取大。"""
    pool=result(innovation=innovation())["pools"][1]
    assert pool["cards"]>=1
    assert pool["cards_planned"]>=pool["cards"]
    assert pool["servers"]>=1
    assert D(pool["capacity_p"])>0
    detail=pool["cards_detail"]
    assert detail["chip_key"]=="910c"
    assert detail["cards_per_server"]==8
    assert D(detail["bf16_tflops"])==D(560)


def test_innovation_cards_take_max_of_compute_and_memory():
    """卡数 = max(算力卡数, 显存卡数)，不能只用算力或只用显存。"""
    pool=result(innovation=innovation())["pools"][1]
    detail=pool["cards_detail"]
    assert pool["cards"]==max(detail["compute_cards"],detail["memory_cards"])
    assert detail["bottleneck"] in ("算力","显存","持平")


def test_innovation_cards_beat_previous_memory_division():
    """旧的「显存总量 ÷ 单卡显存」会在小规模下高估，新口径按算力也参与取大。"""
    small=result(innovation=innovation_q(users=300))["pools"][1]
    large=result(innovation=innovation_q(users=30000))["pools"][1]
    assert small["cards"]<=large["cards"]
    assert D(large["base_p"])>D(small["base_p"])


def test_innovation_cards_follow_chip_selection():
    """换芯片必须改卡数：同算力负载，910B（280T/64G）卡数多于 910C（560T/128G）。"""
    b=result(innovation=innovation(chip_key="910b"))["pools"][1]
    c=result(innovation=innovation(chip_key="910c"))["pools"][1]
    assert b["cards"]>c["cards"]
    # 910B 算力与显存都约为 910C 的一半，卡数差应在一倍左右
    assert 1.6<=float(b["cards"])/float(c["cards"])<=2.4


def test_innovation_without_chip_reports_missing_not_guess():
    """没有可用芯片规格时，卡数留空并给理由，不按默认芯片硬算。"""
    pool=result(innovation=innovation(chip_key="不存在的芯片"))["pools"][1]
    assert pool["cards"] is None
    assert pool["cards_planned"] is None
    assert pool["cards_detail"]["reason"]


def test_development_pool_reports_cards():
    report=result(spec(),development=dev())
    pool=report["pools"][2]
    assert pool["cards"]>=1
    assert pool["cards_planned"]>=pool["cards"]


def test_pool_cards_use_same_units_as_business():
    """三池卡数同量纲：都是物理台数，都能折算成 BF16 基准算力（P）。"""
    report=result(spec(),innovation=innovation(),development=dev())
    business,innov,devel=report["pools"]
    assert business["cards"]>=1 and innov["cards"]>=1 and devel["cards"]>=1
    for pool in (innov,devel):
        assert D(pool["capacity_p"])==D(pool["cards"])*D(560)/D(1000)
