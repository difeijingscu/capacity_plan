from copy import deepcopy
from decimal import Decimal as D

import pytest
from fastapi.testclient import TestClient

from app.catalogs import SYNTHETIC, seeds
from app.engine.calculator import calculate, clean
from app.main import create_app
from app.schemas import (Allocation, Development, DevModel, InferenceRequest, Innovation,
                          PlanInput, Scenario, Task)


@pytest.fixture
def client(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app) as value:
        yield value


def _as_inference(m):
    """把旧训练基线模型（绝对参数量）换算成推理清单形态，供创新/研发池 lookup。"""
    return {"key": m["id"], "label": m.get("display_name") or m["id"],
            "total_b": float(D(str(m["resident_parameters"])) / D("1e9")),
            "active_b": float(D(str(m["active_parameters_prefill"])) / D("1e9")),
            "arch": m.get("architecture", "Dense"), "cache": m.get("cache"),
            "eligible_training_methods": m.get("eligible_training_methods")}


def save_run(client, payload, models=None):
    models = models or [SYNTHETIC]
    # v2.0.0：创新/研发池从推理模型清单取数；基线模型经换算注入 custom_inference_models
    custom = [_as_inference(x) for x in models
              if x.get("resident_parameters") and x.get("active_parameters_prefill")]
    plan = client.post("/api/v1/projects", json={"name": "推导验收", "payload": payload.model_dump(mode="json")}).json()["plan"]
    return client.app.state.store.insert("calculation", dict(
        plan_id=plan["id"], project_id=plan["project_id"], plan_revision=plan["revision"],
        input_snapshot=payload.model_dump(mode="json"), catalog_snapshot=deepcopy(models),
        result=clean(calculate(payload, models, custom_inference_models=custom)), status="SUCCEEDED"))


def get(client, run, scope):
    response = client.get(f"/api/v1/calculations/{run['id']}/derivation", params={"scope": scope})
    assert response.status_code == 200, response.text
    return response.json()


def by_title(steps, title):
    return next(s for s in steps if s["title"] == title)


def by_title_input(fields, label):
    return next(f for f in fields if f["label"] == label)


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
    payload = PlanInput(scenarios=[Scenario(name="问答", inference=InferenceRequest(
        model_key="qwen3_8b", chip_key="910c", scene_key="kb_qa", concurrency=100))])
    run = save_run(client, payload)
    before = get(client, run, "business")
    plan = client.get("/api/v1/plans/" + run["plan_id"]).json()
    assert plan["calculations"][0]["plan_id"] == plan["id"]
    changed = deepcopy(plan["payload"])
    changed["headroom"] = ".5"
    changed["scenarios"][0]["inference"]["concurrency"] = 900
    assert client.patch("/api/v1/plans/" + plan["id"], json={"expected_revision": plan["revision"], "payload": changed}).status_code == 200
    store = client.app.state.store
    live_model = store.get(SYNTHETIC["id"])
    store.replace(SYNTHETIC["id"], {**live_model, "active_parameters_prefill": "999000000000"})
    counts = {kind: len(store.list(kind)) for kind in ["calculation", "plan_history", "job"]}
    assert get(client, run, "business") == before
    assert {kind: len(store.list(kind)) for kind in counts} == counts
    # 快照读的是当次输入，不是当前表单：场景级输入冻结在 items 里
    scenario = before["items"][0]
    assert D(by_title_input(scenario["inputs"], "并发会话")["value"]) == 100
    assert "max(A, B, C)" in by_title(scenario["steps"], "三维取最大（不是相加）+ 奇数补偶")["formula"]
    assert D(by_title(before["steps"], "增加一次容量余量")["value"]) == pytest.approx(D(before["planned_p"]))


def test_total_margin_once_and_cards_are_explained(client):
    payload = PlanInput(headroom=".2", scenarios=[Scenario(name="问答", inference=InferenceRequest(
        model_key="qwen3_8b", chip_key="910c", scene_key="kb_qa", concurrency=100))])
    run = save_run(client, payload)
    total = get(client, run, "total")
    assert D(total["planned_p"]) == pytest.approx(D(total["base_p"]) * D("1.2"))
    assert D(total["steps"][-1]["value"]) == D(total["planned_p"])
    business = get(client, run, "business")
    pool = run["result"]["pools"][0]
    assert D(business["base_p"]) == D(pool["base_p"])
    assert by_title(business["steps"], "汇总场景卡数")["value"] == str(pool["cards_planned"])
    assert get(client, run, "innovation")["steps"] == []
    assert get(client, run, "innovation")["completeness"] == "DISABLED"


def test_development_uses_largest_candidate_and_slots_not_sum(client):
    large = {**SYNTHETIC, "id": "large", "active_parameters_prefill": 16_000_000_000,
             "active_parameters_decode": 16_000_000_000, "resident_parameters": 16_000_000_000}
    payload = PlanInput(development=Development(enabled=True, models=[DevModel(model_id=SYNTHETIC["id"]), DevModel(model_id="large")],
                                               train_slots=2))
    run = save_run(client, payload, [SYNTHETIC, large])
    explanation = get(client, run, "development")
    trains = [i for i in run["result"]["pools"][2]["items"] if i["id"].startswith("train-")]
    evaluations = [i for i in run["result"]["pools"][2]["items"] if i["id"].startswith("eval-")]
    assert len(trains) == 2 and evaluations == []
    tc = max(D(i["base_p"]) for i in trains) * 2
    assert D(explanation["base_p"]) == tc
    assert D(by_title(explanation["steps"], "微调槽位容量")["value"]) == tc
    assert all(t["steps"] for t in explanation["items"])


def test_non_llm_scenarios_are_blocked_with_reasons(client):
    cv = next(m for m in seeds("models") if m["id"] == "yolo26s")
    payload = PlanInput(scenarios=[
        Scenario(name="检测", components=[Task(task_type="cv", model_id=cv["id"], online_users=100, request_rate=9)]),
        Scenario(name="未知任务", components=[Task(task_type="unit", units_per_second=3)]),
        Scenario(name="未映射", components=[Task(task_type="native", native_capacity=5, native_precision="INT8")]),
    ])
    run = save_run(client, payload, [cv])
    explanation = get(client, run, "business")
    assert explanation["completeness"] == "BLOCKED"
    assert len(explanation["missing_items"]) == 3
    assert {m["code"] for m in explanation["missing_items"]} == {"MODEL_RETIRED"}
    assert explanation["items"] == []


def test_zero_vs_missing(client):
    zero = save_run(client, PlanInput(innovation=Innovation(enabled=True, users=1000, quota_per_user_month=0,
                                                          allocations=[Allocation(model_id=SYNTHETIC["id"], share=1)])))
    assert D(get(client, zero, "innovation")["planned_p"]) == 0
    blocked = save_run(client, PlanInput(scenarios=[Scenario(name="未知", components=[Task(task_type="unit")])]))
    assert get(client, blocked, "total")["planned_p"] is None


def test_scope_validation_and_missing_run(client):
    run = save_run(client, PlanInput())
    assert client.get(f"/api/v1/calculations/{run['id']}/derivation?scope=unknown").status_code == 422
    assert client.get("/api/v1/calculations/missing/derivation").status_code == 404
