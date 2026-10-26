import copy
import json
import time
from datetime import date
from decimal import Decimal as D
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.catalogs import SYNTHETIC, seeds
from app.engine.calculator import calculate, compute_task, cost_estimate
from app.schemas import Allocation, Development, DevModel, Innovation, PlanInput, Scenario, Task

FIXTURES=json.loads((Path(__file__).parents[2]/"docs/计算验收样例.json").read_text(encoding="utf-8"))
CASES={case["id"]:case for case in FIXTURES["cases"]}


def near(actual,expected):
    assert float(actual)==pytest.approx(expected,rel=1e-8,abs=1e-9)


def task(users=100,**kwargs):
    return Task(model_id=SYNTHETIC["id"],online_users=users,**kwargs)


def plan(*tasks,**kwargs):
    return PlanInput(scenarios=[Scenario(name=f"场景{i}",components=[t]) for i,t in enumerate(tasks)],**kwargs)


def result(*tasks,**kwargs):
    return calculate(plan(*tasks,**kwargs),[SYNTHETIC])


@pytest.mark.parametrize("case_id",["business_8b","business_double_users"])
def test_golden_business(case_id):
    case=CASES[case_id]
    actual=compute_task(task(**{"users":case["input"]["online_users"]}),SYNTHETIC)
    for key in ("base_p","effective_p"):
        if key in case["expected"]:
            near(actual[key],case["expected"][key])
    near(actual["base_p"]*D("1.2"),case["expected"]["planned_p"])


def test_memory_single_and_shared():
    single=result(task())
    near(single["pools"][0]["memory"]["memory_gb"],CASES["single_memory"]["expected"]["memory_gb"])
    shared=result(task(),task())
    group=shared["pools"][0]["memory"]["groups"][0]
    assert len(shared["pools"][0]["memory"]["groups"])==1
    near(group["weight_gb"],16)
    near(group["memory_gb"],CASES["shared_group"]["expected"]["group_memory_gb"])
    near(shared["pools"][0]["base_p"],CASES["shared_group"]["expected"]["base_p"])


def innovation(**kwargs):
    return Innovation(enabled=True,users=1000,quota_per_user_month=1_000_000,allocations=[Allocation(model_id=SYNTHETIC["id"],share=1)],**kwargs)


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


def test_golden_cv_and_project():
    cv_model=next(m for m in seeds("models") if m["id"]=="yolo26s")
    config=plan(task(),Task(model_id="yolo26s",task_type="cv",streams=10,analysis_fps=5),innovation=innovation(),development=dev())
    report=calculate(config,[SYNTHETIC,cv_model])
    near(report["pools"][0]["items"][1]["base_p"],CASES["cv_streams"]["expected"]["base_p"])
    near(report["total_base_p"],CASES["three_pool_project"]["expected"]["total_base_p"])
    near(report["total_planned_p"],CASES["three_pool_project"]["expected"]["total_planned_p"])


def test_independent_deployment():
    shared=result(task(),task())
    independent=result(task(),task(independent=True))
    assert len(independent["pools"][0]["memory"]["groups"])==2
    assert D(independent["pools"][0]["memory"]["memory_gb"])>D(shared["pools"][0]["memory"]["memory_gb"])


def test_three_pools_do_not_share():
    report=result(task(),innovation=innovation(),development=dev())
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


def test_native_not_implicitly_converted():
    report=result(task(),Task(task_type="native",native_precision="INT8",native_capacity=100))
    assert report["completeness"]=="PARTIAL"
    assert report["missing_items"][0]["code"]=="PRECISION_NOT_COMPARABLE"
    near(report["total_planned_p"],CASES["business_8b"]["expected"]["planned_p"])


def test_high_intensity_and_candidate_invariance():
    standard=result(development=dev())
    high=dev(); high.intensity="high"
    assert D(result(development=high)["total_planned_p"])>D(standard["total_planned_p"])
    small={**SYNTHETIC,"id":"small","active_parameters_prefill":1e9,"active_parameters_decode":1e9}
    config=dev();config.models.append(DevModel(model_id="small"))
    actual=calculate(PlanInput(development=config),[SYNTHETIC,small])
    assert actual["total_planned_p"]==standard["total_planned_p"]


def test_disabled_and_missing_dev():
    assert result(task())["pools"][2]["planned_p"]=="0.00"
    missing=result(task(),development=Development(enabled=True))
    assert missing["pools"][2]["planned_p"] is None
    assert missing["completeness"]=="PARTIAL"


def test_missing_unit_not_lost():
    report=result(task(),Task(task_type="unit",units_per_second=10))
    assert report["completeness"]=="PARTIAL"
    assert report["total_tasks"]==2
    assert report["counted_tasks"]==1
    assert report["missing_items"][0]["code"]=="MISSING_BASELINE"


def test_vlm_adds_vision():
    model={**SYNTHETIC,"tasks":["text","vlm"]}
    normal=compute_task(task(),model)
    vision=compute_task(task(task_type="vlm"),model)
    assert vision["base_p"]>normal["base_p"]
    assert vision["vision_flop_per_request"]>0


def test_headroom_once():
    report=result(task(),task())
    near(report["total_planned_p"],CASES["business_8b"]["expected"]["planned_p"]*2)


def test_independent_pool_cost_rounding_and_missing_price():
    report={"completeness":"COMPLETE","pools":[{"id":str(i),"planned_p":".4","completeness":"COMPLETE","memory":{"status":"COMPLETE","memory_gb":1}} for i in range(2)]}
    cost=cost_estimate(report,[{"id":"card","dense_p16":1,"memory_gb":80}],{})
    assert cost["items"][0]["reference_cards"]==2
    assert cost["items"][0]["amount_low"] is None
    assert cost["items"][0]["status"]=="PRICE_MISSING"


def test_endpoint_period_does_not_scale_capacity():
    short=result(task())
    long=result(task(),planning_end=date(2031,10,20))
    assert short["total_planned_p"]==long["total_planned_p"]


def test_innovation_reasoning_not_added_twice():
    report=result(innovation=innovation())["pools"][1]
    assert report["items"][0]["trace"]["variables"]["generation_tokens_total"]=="512.0"


@pytest.mark.parametrize("override",[
    {"headroom":-1},{"memory_reserve":1},{"annual_growth":float("nan")},
    {"innovation":{"enabled":True,"users":1,"quota_per_user_month":1,"service_hours_per_day":0}},
    {"innovation":{"enabled":True,"allocations":[{"model_id":"a","share":".7"},{"model_id":"b","share":".4"}]}}
])
def test_invalid_parameters_rejected(override):
    with pytest.raises(ValidationError):
        PlanInput.model_validate(override)


def test_unknown_cache_lower_bound():
    model={**SYNTHETIC,"cache":{"type":"unknown"}}
    report=calculate(plan(task()),[model])
    assert report["pools"][0]["memory"]["status"]=="WEIGHT_LOWER_BOUND"


def test_zero_load_does_not_reside():
    report=result(task(users=0))
    assert D(report["total_planned_p"])==0
    assert D(report["pools"][0]["memory"]["memory_gb"])==0


def test_long_context_requires_proxy_and_respects_limit():
    report=result(task(input_tokens=33000))
    assert report["missing_items"][0]["code"]=="CONTEXT_LIMIT_EXCEEDED"
    large={**SYNTHETIC,"context_limit":100000}
    report=calculate(plan(task(input_tokens=33000)),[large])
    assert report["missing_items"][0]["code"]=="MISSING_BASELINE"


def test_1000_scenarios_under_5_seconds():
    config=plan(*(task() for _ in range(1000)))
    start=time.perf_counter()
    report=calculate(config,[SYNTHETIC])
    assert time.perf_counter()-start<5
    assert report["counted_tasks"]==1000


def test_sensitivity_recalculates():
    report=calculate(plan(task()),[SYNTHETIC],True)
    assert D(report["sensitivity"][0]["total_planned_p"])<D(report["total_planned_p"])
    assert D(report["sensitivity"][1]["total_planned_p"])>D(report["total_planned_p"])


def test_scenario_components_aggregate_without_extra_margin():
    first,second=task(),task()
    report=calculate(PlanInput(scenarios=[Scenario(name="组合场景",components=[first,second])]),[SYNTHETIC])
    summary=report["pools"][0]["scenarios"][0]
    assert summary["component_count"]==2
    near(summary["planned_p"],CASES["business_8b"]["expected"]["planned_p"]*2)
