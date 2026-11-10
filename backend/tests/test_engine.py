import copy
import json
import time
from decimal import Decimal as D
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.catalogs import SYNTHETIC, seeds
from app.engine.calculator import calculate, compute_task, cost_estimate
from app.schemas import (Allocation, Development, DevModel, InferenceRequest, Innovation,
                          PlanInput, Scenario, Task)

FIXTURES=json.loads((Path(__file__).parents[2]/"docs/计算验收样例.json").read_text(encoding="utf-8"))
CASES={case["id"]:case for case in FIXTURES["cases"]}


def near(actual,expected):
    assert float(actual)==pytest.approx(expected,rel=1e-8,abs=1e-9)


def task(users=100,**kwargs):
    return Task(model_id=SYNTHETIC["id"],online_users=users,**kwargs)


def spec(**kwargs):
    """业务池场景配置：默认 8B × 910C × 知识库问答 × 100 路并发。"""
    values=dict(model_key="qwen3_8b",chip_key="910c",scene_key="kb_qa",concurrency=100)
    values.update(kwargs)
    return InferenceRequest(**values)


def plan(*specs,**kwargs):
    return PlanInput(scenarios=[Scenario(name=f"场景{i}",inference=s) for i,s in enumerate(specs)],**kwargs)


def result(*specs,**kwargs):
    # 创新/研发池仍按旧口径读模型目录，所以照旧传 SYNTHETIC；业务池不再需要它。
    return calculate(plan(*specs,**kwargs),[SYNTHETIC])


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
    big={**SYNTHETIC,"id":"synthetic-dense-16b","active_parameters_prefill":16e9,"active_parameters_decode":16e9}
    config=innovation()
    config.allocations=[Allocation(model_id=SYNTHETIC["id"],share=".7"),Allocation(model_id=big["id"],share=".3")]
    report=calculate(PlanInput(innovation=config),[SYNTHETIC,big])
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
    """视频检测/批量任务不在推理引擎范围内：进 missing_items，不按默认档硬算。"""
    cv_model=next(m for m in seeds("models") if m["id"]=="yolo26s")
    config=legacy_plan(legacy_task(),Task(model_id="yolo26s",task_type="cv",streams=10,analysis_fps=5),innovation=innovation(),development=dev())
    report=calculate(config,[SYNTHETIC,cv_model])
    codes=[m["code"] for m in report["missing_items"] if m["pool_id"]=="business"]
    assert "UNSUPPORTED_PROFILE" in codes
    assert report["completeness"]=="PARTIAL"


def test_more_concurrency_never_reduces_cards():
    light=result(spec(concurrency=8))["pools"][0]
    heavy=result(spec(concurrency=256))["pools"][0]
    assert heavy["cards"]>=light["cards"]
    assert D(heavy["base_p"])>D(light["base_p"])


def test_three_pools_do_not_share():
    report=result(spec(),innovation=innovation(),development=dev())
    assert all(D(p["memory"]["memory_gb"])>0 for p in report["pools"])


def test_moe_and_distinct_phase_params():
    model={**SYNTHETIC,"architecture":"MoE","resident_parameters":100e9,"active_parameters_prefill":4e9,"active_parameters_decode":8e9}
    actual=compute_task(task(kappa_prefill=1.1,kappa_decode=1.1),model)
    reference=compute_task(task(),SYNTHETIC)
    assert actual["memory"]["weight_gb"]==D(200)
    assert actual["base_p"]<reference["base_p"]
    assert actual["prefill_flop_per_request"]==reference["prefill_flop_per_request"]/2
    assert actual["decode_flop_per_request"]==reference["decode_flop_per_request"]


def test_half_service_window_doubles_capacity():
    original=result(innovation=innovation())["pools"][1]
    half=result(innovation=innovation(service_hours_per_day=4))["pools"][1]
    near(half["base_p"],float(original["base_p"])*2)


def test_native_capacity_not_implicitly_converted():
    """原生存量不走推理引擎，也不按默认档折算成 BF16 基准算力。"""
    report=calculate(legacy_plan(legacy_task(),Task(task_type="native",native_precision="INT8",native_capacity=100)),[SYNTHETIC])
    assert report["missing_items"][0]["code"]=="UNSUPPORTED_PROFILE"
    assert report["completeness"]=="PARTIAL"


def test_high_intensity_and_candidate_invariance():
    standard=result(development=dev())
    high=dev(); high.intensity="high"
    assert D(result(development=high)["total_planned_p"])>D(standard["total_planned_p"])
    small={**SYNTHETIC,"id":"small","active_parameters_prefill":1e9,"active_parameters_decode":1e9}
    config=dev();config.models.append(DevModel(model_id="small"))
    actual=calculate(PlanInput(development=config),[SYNTHETIC,small])
    assert actual["total_planned_p"]==standard["total_planned_p"]


def test_disabled_and_missing_dev():
    assert result(spec())["pools"][2]["planned_p"]=="0.00"
    missing=result(spec(),development=Development(enabled=True))
    assert missing["pools"][2]["planned_p"] is None
    assert missing["completeness"]=="PARTIAL"


def test_missing_scenario_not_lost():
    """无法估算的场景必须留在 missing_items，不能悄悄消失。"""
    report=calculate(legacy_plan(legacy_task(),Task(task_type="unit",units_per_second=10)),[SYNTHETIC])
    assert report["completeness"]=="PARTIAL"
    assert report["total_tasks"]==2
    assert report["counted_tasks"]==1
    assert report["missing_items"][0]["code"]=="UNSUPPORTED_PROFILE"


def test_vlm_adds_vision():
    model={**SYNTHETIC,"tasks":["text","vlm"]}
    normal=compute_task(task(),model)
    vision=compute_task(task(task_type="vlm"),model)
    assert vision["base_p"]>normal["base_p"]
    assert vision["vision_flop_per_request"]>0


def test_headroom_once():
    """余量只在池层乘一次：planned = base × (1+h)，卡数不再叠加第二重余量。"""
    one=result(spec(),headroom=".2")["pools"][0]
    near(D(one["planned_p"]),float(one["base_p"])*1.2)
    two=result(spec(),spec(),headroom=".2")["pools"][0]
    near(D(two["base_p"]),float(one["base_p"])*2)
    near(D(two["planned_p"]),float(two["base_p"])*1.2)


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
    report=calculate(legacy_plan(legacy_task(),innovation=innovation()),[model])
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
    """旧清单写了模型名但清单里没有：不许落到默认模型上硬算。"""
    report=calculate(legacy_plan(Task(model_id="llama-3-70b",task_type="text",online_users=100)),[])
    assert [m["code"] for m in report["missing_items"]]==["MODEL_NOT_MATCHED"]
    assert "llama-3-70b" in report["missing_items"][0]["message"]
    assert report["pools"][0]["items"]==[]
    assert report["completeness"]=="BLOCKED"


def test_scenario_without_any_input_is_flagged():
    report=calculate(PlanInput(scenarios=[Scenario(name="空场景")]),[])
    assert report["pools"][0]["items"][0]["inference_origin"]=="default"
    assert "SCENARIO_NOT_CONFIGURED" in report["pools"][0]["items"][0]["warnings"]


def test_sensitivity_recalculates():
    report=calculate(plan(spec()),[],True)
    assert D(report["sensitivity"][0]["total_planned_p"])<D(report["total_planned_p"])
    assert D(report["sensitivity"][1]["total_planned_p"])>D(report["total_planned_p"])


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
