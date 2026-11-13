import io
import json
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook

from app.main import create_app
from app.schemas import PlanInput, Scenario, Task
from app.store import Store


@pytest.fixture
def client(tmp_path):
    app=create_app(tmp_path)
    with TestClient(app) as value:
        yield value


def make_plan(client):
    # 旧口径清单，模型名要能被推理模型清单匹配（否则业务池会报 MODEL_NOT_MATCHED，不再落默认模型）。
    payload=PlanInput(scenarios=[Scenario(name="知识问答",components=[Task(model_id="qwen3-8b",online_users=100)])]).model_dump(mode="json")
    r=client.post("/api/v1/projects",json={"name":"验收项目","payload":payload})
    assert r.status_code==200,r.text
    return r.json()["plan"]


def test_display_defaults_match_calculation_defaults(client):
    from app.engine.calculator import TEMPLATES, resolved
    settings=client.get("/api/v1/defaults").json()
    for template in TEMPLATES:
        effective=resolved(Task(template=template))
        for field,value in settings["templates"][template].items():
            assert float(value)==float(effective[field])
    task=Task()
    assert settings["task_defaults"]["input_tokens"] is None
    for field in ("calls_per_request","eta_prefill","eta_decode","analysis_fps","visual_tokens_per_image"):
        assert float(settings["task_defaults"][field])==float(getattr(task,field))


def await_job(client,response):
    data=response.json()
    if data.get("run_id"):
        return data
    for _ in range(1500):
        job=client.get("/api/v1/jobs/"+data["job_id"]).json()
        if job["status"]=="SUCCEEDED":
            return job["result"]
        assert job["status"] not in ("FAILED","INTERRUPTED"),job
        time.sleep(.01)
    raise AssertionError("Job timed out")


def run(client,plan):
    result=await_job(client,client.post(f"/api/v1/plans/{plan['id']}/calculate",json={"plan_revision":plan["revision"]}))
    return client.get("/api/v1/calculations/"+result["run_id"]).json()


def test_project_persistence_clone_archive(client):
    p=make_plan(client)
    copied=client.post(f"/api/v1/plans/{p['id']}/clone",json={"label":"高需求方案"}).json()
    assert copied["parent_id"]==p["id"]
    assert copied["payload"]==p["payload"]
    projects=client.get("/api/v1/projects").json()
    assert len(projects[0]["plans"])==2
    project=projects[0]
    assert client.patch("/api/v1/projects/"+project["id"],json={"archived":True,"expected_revision":project["revision"]}).status_code==200
    assert client.get("/api/v1/projects").json()==[]
    assert len(client.get("/api/v1/projects?archived=true").json())==1


def test_historical_snapshot_and_revision_conflict(client):
    p=make_plan(client)
    old=run(client,p)
    payload=p["payload"]
    payload["scenarios"][0]["components"][0]["online_users"]=200
    updated=client.patch("/api/v1/plans/"+p["id"],json={"expected_revision":p["revision"],"payload":payload}).json()
    assert updated["revision"]>p["revision"]
    new=run(client,updated)
    # 推理链路下并发翻倍不等于算力翻倍：卡数要过三维取 max 与 SLA 回验，是台阶式增长。
    # 这里只断言"输入变了 → 结果跟着变且不减少"，倍数关系属于引擎测试的职责。
    assert float(new["result"]["total_planned_p"])>float(old["result"]["total_planned_p"])
    assert float(new["result"]["pools"][0]["cards"])>=float(old["result"]["pools"][0]["cards"])
    assert client.get("/api/v1/calculations/"+old["id"]).json()["input_snapshot"]["scenarios"][0]["components"][0]["online_users"]=="100"
    assert client.patch("/api/v1/plans/"+p["id"],json={"expected_revision":p["revision"],"payload":payload}).status_code==409
    assert client.post(f"/api/v1/plans/{p['id']}/calculate",json={"plan_revision":p["revision"]}).status_code==409
    comparison=client.post("/api/v1/calculations/compare",json={"run_ids":[old["id"],new["id"]]}).json()
    assert comparison["runs"][1]["parameter_changes"]
    undo=client.post(f"/api/v1/plans/{p['id']}/undo",json={"expected_revision":updated["revision"]}).json()
    assert undo["payload"]["scenarios"][0]["components"][0]["online_users"]=="100"


def test_retired_fields_in_stored_plan_do_not_block_reading(client):
    """历史方案里留着已下线字段时，读出来的 payload 必须能被当前版本直接使用。"""
    p=make_plan(client)
    store=client.app.state.store
    record=store.get(p["id"],"plan")
    legacy={**record["payload"],"planning_start":"2026-10-20","planning_end":"2029-10-20",
            "input_time_basis":"endpoint","annual_growth":"0"}
    legacy["development"]={**legacy["development"],"eval_samples":None,"eval_slots":3,"eval_task_type":"text"}
    store.replace(p["id"],{**record,"payload":legacy},record["revision"])

    opened=client.get("/api/v1/plans/"+p["id"]).json()
    assert "planning_start" not in opened["payload"] and "annual_growth" not in opened["payload"]
    assert "eval_samples" not in opened["payload"]["development"]
    assert client.post("/api/v1/preview-calculation",json={"payload":opened["payload"]}).status_code==200
    run_id=await_job(client,client.post(f"/api/v1/plans/{p['id']}/calculate",json={"plan_revision":opened["revision"]}))["run_id"]
    assert client.get("/api/v1/calculations/"+run_id).json()["result"]["pools"][0]["completeness"]!="BLOCKED"


def test_calculation_cache_idempotent(client):
    p=make_plan(client)
    first=run(client,p)
    second=run(client,p)
    assert first["id"]==second["id"]


def test_model_publish_does_not_rewrite_history(client):
    p=make_plan(client);old=run(client,p)
    models=client.get("/api/v1/catalog/models").json()
    original=next(m for m in models if m["id"]=="synthetic-dense-8b")
    assert original["revision"]=="synthetic-v1"
    copy={**original,"id":"synthetic-new","revision":"synthetic-v2","resident_parameters":16e9}
    created=client.post("/api/v1/catalog/model-revisions",json=copy).json()
    assert created["status"]=="DRAFT"
    assert client.post("/api/v1/catalog/revisions/"+created["id"]+"/publish").status_code==200
    retained=client.get("/api/v1/calculations/"+old["id"]).json()
    assert retained["catalog_snapshot"]==old["catalog_snapshot"]


def test_text_import_mapping_units_and_idempotency(client):
    p=make_plan(client)
    text="场景名称\t场景描述\t在线人数\n文档分析\t分析内部材料\t1万\n目标检测\t摄像头监控\t"
    preview=client.post("/api/v1/imports/preview",data={"text":text})
    assert preview.status_code==200,preview.text
    batch=preview.json()
    assert batch["scenarios"][0]["components"][0]["online_users"]=="10000"
    body={"plan_id":p["id"],"expected_revision":p["revision"],"idempotency_key":"once","strategy":"append"}
    first=client.post("/api/v1/imports/"+batch["id"]+"/commit",json=body)
    second=client.post("/api/v1/imports/"+batch["id"]+"/commit",json=body)
    assert first.status_code==second.status_code==200
    assert len(second.json()["payload"]["scenarios"])==3
    assert "row" in batch["scenarios"][0]["source_reference"]


def test_excel_sheet_header_and_ambiguous_column(client):
    book=Workbook();sheet=book.active;sheet.title="场景"
    sheet.append(["项目说明"]);sheet.append(["场景名称","并发数"])
    sheet.append(["知识助手",80])
    raw=io.BytesIO();book.save(raw)
    files={"file":("场景.xlsx",raw.getvalue(),"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    batch=client.post("/api/v1/imports/preview",files=files,data={"header_row":2}).json()
    assert batch["needs_online_confirmation"]
    assert batch["sheets"]==["场景"]
    batch=client.post("/api/v1/imports/preview",files=files,data={"header_row":2,"confirm_online_semantics":"true"}).json()
    assert not batch["needs_online_confirmation"]
    assert batch["scenarios"][0]["components"][0]["online_users"]=="80"


def test_invalid_import_row_not_silently_computed(client):
    text="场景名称\t在线人数\n正常\t100\n异常\t未知"
    batch=client.post("/api/v1/imports/preview",data={"text":text}).json()
    assert len(batch["scenarios"])==2
    assert batch["errors"]
    assert batch["scenarios"][1]["components"][0]["online_users"] is None


def test_local_assistant_apply_and_stale(client):
    p=make_plan(client)
    job=client.post("/api/v1/assistant/messages",json={"plan_id":p["id"],"revision":p["revision"],"message":"全部设为200人在线"})
    done=await_job(client,job)
    proposal=client.get("/api/v1/assistant/proposals/"+done["proposal_id"]).json()
    assert proposal["mode"]=="local"
    applied=client.post("/api/v1/assistant/proposals/"+proposal["id"]+"/apply",json={"expected_revision":p["revision"]})
    assert applied.status_code==200,applied.text
    assert applied.json()["payload"]["scenarios"][0]["components"][0]["online_users"]=="200.0"
    assert client.post("/api/v1/assistant/messages",json={"plan_id":p["id"],"revision":p["revision"],"message":"解释结果"}).status_code==409


def test_ai_failure_falls_back_and_secret_not_persisted(client):
    p=make_plan(client)
    result=client.put("/api/v1/settings",json={"endpoint":"http://127.0.0.1:1/chat/completions","model":"test","api_key":"private-secret","timeout":5})
    assert "private-secret" not in result.text
    job=client.post("/api/v1/assistant/messages",json={"plan_id":p["id"],"revision":p["revision"],"message":"全部设为300人在线"})
    done=await_job(client,job)
    proposal=client.get("/api/v1/assistant/proposals/"+done["proposal_id"]).json()
    assert proposal["mode"]=="fallback"
    assert proposal["fallback_reason"]
    assert "private-secret" not in client.app.state.store.get("assistant-settings").__str__()
    assert run(client,p)["result"]["completeness"]=="COMPLETE"


def test_prices_and_cost_do_not_change_compute(client):
    p=make_plan(client);r=run(client,p)
    before=r["result"]["total_planned_p"]
    costs=client.post("/api/v1/cost-estimates",json={"run_id":r["id"]}).json()
    assert all(i["amount_low"] is None for i in costs["result"]["items"])
    card=client.get("/api/v1/catalog/cards").json()[0]
    price=client.post("/api/v1/prices",json={"card_id":card["id"],"price_low":10000,"price_high":12000,"source":"合成验收报价","quote_date":"2026-01-01","is_demo":True}).json()
    costs=client.post("/api/v1/cost-estimates",json={"run_id":r["id"],"spec_ids":[card["id"]],"price_revision_ids":[price["id"]]}).json()
    assert costs["result"]["items"][0]["is_demo"]
    assert costs["result"]["items"][0]["amount_low"] is not None
    assert client.get("/api/v1/calculations/"+r["id"]).json()["result"]["total_planned_p"]==before


def test_schema_error_is_actionable(client):
    p=make_plan(client);p["payload"]["innovation"]={"enabled":True,"users":10,"quota_per_user_month":100,"allocations":[{"model_id":"a","share":".9"}]}
    response=client.patch("/api/v1/plans/"+p["id"],json={"expected_revision":p["revision"],"payload":p["payload"]})
    assert response.status_code==422
    assert response.json()["code"]=="INVALID_SHARE"


def test_generic_baseline_no_arbitrary_formula(client):
    response=client.post("/api/v1/catalog/baseline-revisions",json={"calculator_id":"execute_python","source_url":"test","parameters":{}})
    assert response.status_code==422


def test_job_snapshot_edit_during_calculation(client):
    p=make_plan(client)
    response=client.post(f"/api/v1/plans/{p['id']}/calculate",json={"plan_revision":p["revision"]})
    payload=p["payload"];payload["scenarios"][0]["components"][0]["online_users"]=200
    new=client.patch("/api/v1/plans/"+p["id"],json={"expected_revision":p["revision"],"payload":payload}).json()
    done=await_job(client,response)
    old=client.get("/api/v1/calculations/"+done["run_id"]).json()
    assert old["plan_revision"]==p["revision"]
    assert new["revision"]>old["plan_revision"]


def test_store_restart_and_interrupted_job(tmp_path):
    first=Store(tmp_path)
    project=first.insert("project",{"name":"保留项目"})
    job=first.insert("job",{"status":"RUNNING"})
    second=Store(tmp_path);second.recover()
    assert second.get(project["id"])["name"]=="保留项目"
    assert second.get(job["id"])["status"]=="INTERRUPTED"


CUSTOM_CHIP_BODY={"key":"test_card","label":"测试自定义卡","bf16_tflops":500,"int8_tflops":1000,
                  "int4_tflops":0,"memory_gb":96,"hbm_tbs":2.4,"link_gbs":200,
                  "power_kw":0.5,"native_int4":False}


def test_custom_chip_register_list_archive(client):
    r=client.post("/api/v1/inference/chips",json=CUSTOM_CHIP_BODY)
    assert r.status_code==200,r.text
    assert r.json()["key"]=="test_card" and r.json()["custom"] is True
    # 重复登记拒绝
    assert client.post("/api/v1/inference/chips",json=CUSTOM_CHIP_BODY).status_code==422
    # 与内置卡重名拒绝
    clash=dict(CUSTOM_CHIP_BODY,key="910c")
    assert client.post("/api/v1/inference/chips",json=clash).status_code==422
    # 目录与列表可见
    assert any(c["key"]=="test_card" for c in client.get("/api/v1/inference/chips").json())
    catalog=client.get("/api/v1/inference/catalog").json()
    assert any(c["key"]=="test_card" for c in catalog["custom_chips"])
    # 归档后不再出现
    assert client.delete("/api/v1/inference/chips/test_card").status_code==200
    assert client.get("/api/v1/inference/chips").json()==[]


def test_custom_chip_estimate_and_plan_calculation(client):
    client.post("/api/v1/inference/chips",json=CUSTOM_CHIP_BODY)
    # 单点估算走自定义卡（工程系数按通用经验值回退）
    estimate=client.post("/api/v1/inference/estimate",json={
        "model_key":"qwen3_8b","chip_key":"test_card","scene_key":"rag",
        "weight_precision":"bf16"})
    assert estimate.status_code==200,estimate.text
    assert estimate.json()["result"]["cards"]>0
    # 方案级计算：业务场景选自定义卡能出卡数（不再落 missing_items）
    payload=PlanInput(scenarios=[Scenario(name="自定义卡场景",components=[],
        inference={"model_key":"qwen3_8b","chip_key":"test_card","scene_key":"rag",
                   "weight_precision":"bf16"})]).model_dump(mode="json")
    r=client.post("/api/v1/projects",json={"name":"自定义卡项目","payload":payload})
    assert r.status_code==200,r.text
    plan=r.json()["plan"]
    preview=client.post("/api/v1/preview-calculation",json={"payload":plan["payload"]}).json()
    pool=preview["pools"][0]
    assert pool["missing_items"]==[]
    assert pool["items"][0]["cards"]>0
    # 业务池结果带杜邦树（trace.detail.tree）
    tree=pool["items"][0]["trace"]["detail"]["tree"]
    assert tree["label"]=="所需算力卡 N" and len(tree["children"])==3
