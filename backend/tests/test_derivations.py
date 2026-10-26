from copy import deepcopy
from decimal import Decimal as D

import pytest
from fastapi.testclient import TestClient

from app.catalogs import SYNTHETIC, seeds
from app.engine.calculator import calculate, clean
from app.main import create_app
from app.schemas import Allocation, Development, DevModel, Innovation, PlanInput, Scenario, Task


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as value:
        yield value


def save_run(client, payload, models=None):
    models = models or [SYNTHETIC]
    plan = client.post("/api/v1/projects", json={"name": "推导验收", "payload": payload.model_dump(mode="json")}).json()["plan"]
    return client.app.state.store.insert("calculation", dict(
        plan_id=plan["id"], project_id=plan["project_id"], plan_revision=plan["revision"],
        input_snapshot=payload.model_dump(mode="json"), catalog_snapshot=deepcopy(models),
        result=clean(calculate(payload, models)), status="SUCCEEDED"))


def get(client, run, scope):
    response = client.get(f"/api/v1/calculations/{run['id']}/derivation", params={"scope": scope})
    assert response.status_code == 200, response.text
    return response.json()


def by_title(steps, title):
    return next(s for s in steps if s["title"] == title)


def test_innovation_large_quota_matches_32p_snapshot(client):
    model = next(m for m in seeds("models") if m["id"] == "deepseek-v4-flash")
    payload = PlanInput(innovation=Innovation(enabled=True, users=1000, quota_per_user_month=50_000_000,
                                            allocations=[Allocation(model_id=model["id"], share=1)]))
    run = save_run(client, payload, [model])
    explanation = get(client, run, "innovation")
    assert float(explanation["planned_p"]) == pytest.approx(32.07792207792208)
    assert D(by_title(explanation["steps"], "得到全池实际月度Token预算")["value"]) == 50_000_000_000
    assert D(by_title(explanation["steps"], "得到有效服务时间")["value"]) == 633600
    task = explanation["items"][0]
    assert float(by_title(task["steps"], "输入阶段容量")["value"]) == pytest.approx(16.88311688311688)
    assert float(by_title(task["steps"], "生成阶段容量")["value"]) == pytest.approx(9.84848484848485)
    assert task["revision"] == model["revision"]
    assert "1.2" in by_title(task["steps"], "每请求输入工作量")["substitution"]
    assert any("同时执行" in i["note"] for i in explanation["inputs"])


def test_derivation_is_read_only_and_uses_frozen_inputs_and_catalog(client):
    payload = PlanInput(scenarios=[Scenario(name="问答", components=[Task(model_id=SYNTHETIC["id"], online_users=100)])])
    run = save_run(client, payload)
    before = get(client, run, "business")
    plan = client.get("/api/v1/plans/" + run["plan_id"]).json()
    assert plan["calculations"][0]["plan_id"] == plan["id"]
    changed = deepcopy(plan["payload"])
    changed["headroom"] = ".5"
    changed["scenarios"][0]["components"][0]["online_users"] = 900
    assert client.patch("/api/v1/plans/" + plan["id"], json={"expected_revision": plan["revision"], "payload": changed}).status_code == 200
    store = client.app.state.store
    live_model = store.get(SYNTHETIC["id"])
    store.replace(SYNTHETIC["id"], {**live_model, "active_parameters_prefill": "999000000000"})
    counts = {kind: len(store.list(kind)) for kind in ["calculation", "plan_history", "job"]}
    assert get(client, run, "business") == before
    assert {kind: len(store.list(kind)) for kind in counts} == counts
    assert "100 ×" in by_title(before["items"][0]["steps"], "在线人数换算模型请求速率")["substitution"]


def test_total_margin_once_and_native_mapping_are_explained(client):
    payload = PlanInput(headroom=".2", scenarios=[Scenario(name="映射", components=[
        Task(task_type="native", native_capacity=10, native_precision="INT8", reference_mapping=".5", baseline_source="人工核验映射")
    ])])
    run = save_run(client, payload)
    total = get(client, run, "total")
    assert D(total["base_p"]) == 5 and D(total["planned_p"]) == 6
    assert D(total["steps"][-1]["value"]) == 6
    business = get(client, run, "business")
    assert D(business["items"][0]["steps"][0]["value"]) == 5
    assert get(client, run, "innovation")["steps"] == []
    assert get(client, run, "innovation")["completeness"] == "DISABLED"


@pytest.mark.parametrize("parallel", [False, True])
def test_development_uses_largest_candidate_and_slots_not_sum(client, parallel):
    large = {**SYNTHETIC, "id": "large", "active_parameters_prefill": 16_000_000_000,
             "active_parameters_decode": 16_000_000_000, "resident_parameters": 16_000_000_000}
    payload = PlanInput(development=Development(enabled=True, models=[DevModel(model_id=SYNTHETIC["id"]), DevModel(model_id="large")],
                                               train_slots=2, eval_slots=3, train_eval_parallel=parallel))
    run = save_run(client, payload, [SYNTHETIC, large])
    explanation = get(client, run, "development")
    trains = [i for i in run["result"]["pools"][2]["items"] if i["id"].startswith("train-")]
    evaluations = [i for i in run["result"]["pools"][2]["items"] if i["id"].startswith("eval-")]
    tc, ec = max(D(i["base_p"]) for i in trains) * 2, max(D(i["base_p"]) for i in evaluations) * 3
    assert D(explanation["base_p"]) == (tc + ec if parallel else max(tc, ec))
    assert D(by_title(explanation["steps"], "微调槽位容量")["value"]) == tc
    assert D(by_title(explanation["steps"], "评测槽位容量")["value"]) == ec
    assert all(t["steps"] for t in explanation["items"])


def test_cv_direct_override_partial_and_unmapped_capacity(client):
    cv = next(m for m in seeds("models") if m["id"] == "yolo26s")
    payload = PlanInput(scenarios=[
        Scenario(name="检测", components=[Task(task_type="cv", model_id=cv["id"], online_users=100, request_rate=9, images_per_request=2)]),
        Scenario(name="未知任务", components=[Task(task_type="unit", units_per_second=3)]),
        Scenario(name="未映射", components=[Task(task_type="native", native_capacity=5, native_precision="INT8")]),
    ])
    run = save_run(client, payload, [cv])
    explanation = get(client, run, "business")
    assert explanation["completeness"] == "PARTIAL"
    assert len(explanation["missing_items"]) == 2
    detection = explanation["items"][0]
    rate = by_title(detection["steps"], "确定任务处理速率")
    assert D(rate["value"]) == 18
    assert rate["substitution"] == "9 × 2"
    assert D(detection["base_p"]) == D("0.001254")
    assert explanation["items"][1]["base_p"] is None and explanation["items"][1]["steps"] == []


def test_offline_units_and_zero_vs_missing(client):
    task = Task(task_type="unit", total_units=1000, deadline_hours=2, flop_per_unit="1e12", baseline_source="离线任务测量")
    run = save_run(client, PlanInput(scenarios=[Scenario(name="离线", components=[task])]))
    explanation = get(client, run, "business")
    rate = by_title(explanation["items"][0]["steps"], "确定任务处理速率")
    assert rate["substitution"] == "1,000 ÷ (2 × 3600)"
    assert float(rate["value"]) == pytest.approx(1000 / 7200)
    zero = save_run(client, PlanInput(innovation=Innovation(enabled=True, users=1000, quota_per_user_month=0,
                                                          allocations=[Allocation(model_id=SYNTHETIC["id"], share=1)])))
    assert D(get(client, zero, "innovation")["planned_p"]) == 0
    blocked = save_run(client, PlanInput(scenarios=[Scenario(name="未知", components=[Task(task_type="unit")])]))
    assert get(client, blocked, "total")["planned_p"] is None


def test_scope_validation_and_missing_run(client):
    run = save_run(client, PlanInput())
    assert client.get(f"/api/v1/calculations/{run['id']}/derivation?scope=unknown").status_code == 422
    assert client.get("/api/v1/calculations/missing/derivation").status_code == 404
