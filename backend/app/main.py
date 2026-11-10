from __future__ import annotations

import hashlib
import json
import os
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from threading import Lock
from typing import Literal
from uuid import uuid4

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from app.assistant import Proposal, ask_provider, check_changes, local_proposal
from app.derivations import build_derivation
from app.catalogs import seeds
from app.catalogs import inference_catalog
from app.engine.calculator import ENGINE_VERSION, CalculationIssue, calculate, clean, cost_estimate, resolved, INTENSITIES, TEMPLATES
from app.engine import inference as inference_engine
from app.engine import params as inference_params
from app.imports import preview, suggest_task
from app.schemas import Development, InferenceModelInput, InferenceRequest, PlanInput, Scenario, Task, prune_payload
from app.store import RevisionConflict, Store, now

ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = ROOT.parent


def create_app(data_dir=None):
    store = Store(data_dir or os.getenv("PLANNER_DATA_DIR", str(PROJECT_ROOT/"data")))
    store.publish_seeds("model", seeds("models"))
    store.publish_seeds("card", seeds("cards"))
    store.recover()
    saved_params = store.get("active", "inference-params")
    inference_params.load((saved_params or {}).get("overrides"))
    inference_engine.reload()
    executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="planner")
    credential = {"key": os.getenv("PLANNER_AI_KEY","")}
    calculation_lock=Lock()

    @asynccontextmanager
    async def lifespan(app):
        yield
        executor.shutdown(wait=True)

    app = FastAPI(title="算力规划工作台",version="1.0.0",lifespan=lifespan)
    app.state.store = store

    @app.middleware("http")
    async def request_id(request, call_next):
        request.state.request_id = uuid4().hex
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        return response

    def error(request, status, code, message, fields=None):
        return JSONResponse(status_code=status,content={"code":code,"message":message,"field_errors":fields or [],"request_id":getattr(request.state,"request_id","")})

    @app.exception_handler(RevisionConflict)
    async def conflict_handler(request, exc):
        return error(request,409,"STALE_REVISION","方案已更新，请刷新后重新应用修改")

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(request, exc):
        return error(request,422,"INVALID_INPUT","输入格式不正确",json.loads(json.dumps(exc.errors(),default=str)))

    @app.exception_handler(ValidationError)
    async def schema_handler(request, exc):
        msg = str(exc)
        return error(request,422,"INVALID_SHARE" if "INVALID_SHARE" in msg else "INVALID_INPUT",msg,json.loads(json.dumps(exc.errors(),default=str)))

    @app.exception_handler(ValueError)
    async def value_handler(request, exc):
        return error(request,422,"INVALID_INPUT",str(exc))

    def need(key, kind=None):
        value = store.get(key,kind)
        if not value:
            raise HTTPException(404,"记录不存在")
        return value

    def models():
        return [m for m in store.list("model") if m.get("status")=="PUBLISHED"]

    def plan_record(key):
        return need(key,"plan")

    def readable_payload(payload):
        """读路径兜底：剪掉当前 schema 已下线的字段，让旧方案能被打开。
        写入仍然走 PlanInput 严格校验，字段名写错不会被静默吞掉。"""
        return prune_payload(PlanInput, payload or {})

    def update_plan(key, payload, expected):
        record = plan_record(key)
        old_revision = record["revision"]
        if expected != old_revision:
            raise RevisionConflict(key)
        validated = PlanInput.model_validate(payload).model_dump(mode="json")
        store.insert("plan_history",{"plan_id":key,"revision_number":old_revision,"payload":record["payload"]})
        return store.replace(key,{**record,"payload":validated,"status":"DRAFT","previous_payload":record["payload"]},expected)

    def submit_job(kind, work, metadata=None):
        job = store.insert("job",{"job_type":kind,"status":"QUEUED",**(metadata or {})})
        def wrapped():
            store.replace(job["id"],{**job,"status":"RUNNING"})
            try:
                result = work()
                store.replace(job["id"],{**job,"status":"SUCCEEDED","result":result})
            except Exception as exc:
                # Do not persist provider response/headers or potentially sensitive content.
                code = exc.code if isinstance(exc,CalculationIssue) else "TASK_FAILED"
                store.replace(job["id"],{**job,"status":"FAILED","error_code":code,"error":"任务未完成，请检查参数或接口设置后重试","error_type":type(exc).__name__})
        executor.submit(wrapped)
        return job

    @app.get("/api/v1/health")
    def health():
        return {"status":"ok","engine_version":ENGINE_VERSION}

    @app.get("/api/v1/defaults")
    def defaults():
        return {
            "templates":TEMPLATES,
            "task_defaults":Task().model_dump(mode="json",exclude={"id","provenance"}),
            "development_defaults":Development().model_dump(mode="json",exclude={"models"}),
            "planning_defaults":PlanInput().model_dump(mode="json",include={"headroom","memory_reserve"}),
            "intensities":INTENSITIES,
            "defaults_version":"defaults-v1",
        }

    @app.get("/api/v1/projects")
    def projects(archived: bool=False):
        all_plans = [{**v,"payload":readable_payload(v.get("payload"))} for v in store.list("plan")]
        return [{**p,"plans":[v for v in all_plans if v["project_id"]==p["id"]]} for p in store.list("project") if bool(p.get("archived_at"))==archived]

    @app.post("/api/v1/projects")
    def create_project(body:dict):
        name = str(body.get("name","")).strip()
        if not name or len(name)>200:
            raise ValueError("请填写200字以内项目名称")
        base = PlanInput.model_validate(body.get("payload") or {})
        project = store.insert("project",{"name":name,"archived_at":None})
        plan = store.insert("plan",{"project_id":project["id"],"label":"基准方案","payload":base.model_dump(mode="json"),"status":"DRAFT","parent_id":None})
        return {"project":project,"plan":plan}

    @app.get("/api/v1/projects/{project_id}/calculations")
    def project_calculations(project_id:str):
        need(project_id,"project")
        labels={p["id"]:p["label"] for p in store.list("plan") if p["project_id"]==project_id}
        return [{**r,"plan_label":labels.get(r["plan_id"],"历史方案")} for r in store.list("calculation") if r.get("project_id")==project_id]

    @app.patch("/api/v1/projects/{project_id}")
    def edit_project(project_id:str,body:dict):
        record = need(project_id,"project")
        name = body.get("name",record["name"])
        if not isinstance(name,str) or not name.strip():
            raise ValueError("项目名称不能为空")
        return store.replace(project_id,{**record,"name":name,"archived_at":now() if body.get("archived") else None},body.get("expected_revision",record["revision"]))

    @app.post("/api/v1/demo")
    def demo():
        catalog = models()
        text_task = suggest_task("知识问答","查询制度与知识",catalog)
        text_task.online_users=Decimal(100)
        payload = PlanInput(is_demo=True,scenarios=[
            Scenario(name="企业知识问答",description="查询内部制度与知识并回答",components=[text_task],
                     inference=InferenceRequest(model_key="qwen3_8b",chip_key="910c",scene_key="kb_qa",concurrency=Decimal(100))),
            Scenario(name="技术文档摘要",description="长文档一次送入，输出结构化摘要",
                     inference=InferenceRequest(model_key="qwen36_35b_a3b",chip_key="910c",scene_key="long_summary",concurrency=Decimal(30))),
            Scenario(name="报告与文案生成",description="短输入、长输出，含思考链",
                     inference=InferenceRequest(model_key="deepseek_v4_flash",chip_key="950(486T)",scene_key="long_gen",concurrency=Decimal(20))),
        ])
        if text_task.model_id:
            payload.innovation.enabled=True
            payload.innovation.users=Decimal(1000)
            payload.innovation.quota_per_user_month=Decimal(1000000)
            from app.schemas import Allocation, DevModel
            payload.innovation.allocations=[Allocation(model_id=text_task.model_id,share=1)]
            payload.development.enabled=True
            payload.development.models=[DevModel(model_id=text_task.model_id)]
        return create_project({"name":"示例 · 组织AI算力规划","payload":payload.model_dump(mode="json")})

    @app.get("/api/v1/plans/{plan_id}")
    def get_plan(plan_id:str):
        record = plan_record(plan_id)
        record = {**record,"payload":readable_payload(record.get("payload"))}
        if record.get("previous_payload"):
            record["previous_payload"] = readable_payload(record["previous_payload"])
        record["calculations"] = [{k:r.get(k) for k in ("id","plan_id","plan_revision","created_at","result","status")} for r in store.list("calculation") if r["plan_id"]==plan_id]
        return record

    @app.patch("/api/v1/plans/{plan_id}")
    def patch_plan(plan_id:str,body:dict):
        record = plan_record(plan_id)
        payload = body.get("payload") or {**record["payload"],**body.get("patch",{})}
        result = update_plan(plan_id,payload,body.get("expected_revision"))
        if body.get("label"):
            result = store.replace(plan_id,{**result,"label":str(body["label"])},result["revision"])
        return result

    @app.post("/api/v1/plans/{plan_id}/undo")
    def undo_plan(plan_id:str,body:dict):
        record=plan_record(plan_id)
        if not record.get("previous_payload"):
            raise ValueError("没有可撤销的修改")
        return update_plan(plan_id,readable_payload(record["previous_payload"]),body.get("expected_revision"))

    @app.post("/api/v1/plans/{plan_id}/clone")
    def clone(plan_id:str,body:dict):
        record=plan_record(plan_id)
        return store.insert("plan",{"project_id":record["project_id"],"label":str(body.get("label","对比方案"))[:200],"payload":record["payload"],"status":"DRAFT","parent_id":plan_id})

    @app.put("/api/v1/plans/{plan_id}/{section}")
    def replace_section(plan_id:str,section:str,body:dict):
        if section not in ("scenarios","innovation","development"):
            raise HTTPException(404)
        record=plan_record(plan_id)
        return update_plan(plan_id,{**record["payload"],section:body["value"]},body.get("expected_revision"))

    @app.post("/api/v1/plans/{plan_id}/validate")
    def validate(plan_id:str,body:dict):
        record=plan_record(plan_id)
        if body.get("plan_revision",record["revision"]) != record["revision"]:
            raise RevisionConflict(plan_id)
        report=calculate(PlanInput.model_validate(record["payload"]),models())
        return {"errors":report["missing_items"],"warnings":report["warnings"],"readiness":report["completeness"],"counted_tasks":report["counted_tasks"]}

    @app.post("/api/v1/plans/{plan_id}/calculate")
    def run(plan_id:str,body:dict):
        record=plan_record(plan_id)
        if body.get("plan_revision") != record["revision"]:
            raise RevisionConflict(plan_id)
        catalog=models()
        canonical=json.dumps({"payload":record["payload"],"catalog":catalog,"engine":ENGINE_VERSION},sort_keys=True,ensure_ascii=False)
        fingerprint=hashlib.sha256(canonical.encode()).hexdigest()
        cached=next((r for r in store.list("calculation") if r.get("input_hash")==fingerprint and r["plan_id"]==plan_id and r["plan_revision"]==record["revision"]),None)
        if cached:
            return {"run_id":cached["id"],"status":"SUCCEEDED"}
        def work():
            report=calculate(PlanInput.model_validate(readable_payload(record["payload"])),catalog,True)
            calculation=store.insert("calculation",{"plan_id":plan_id,"project_id":record["project_id"],"plan_revision":record["revision"],"input_hash":fingerprint,"input_snapshot":record["payload"],"catalog_snapshot":catalog,"result":report,"status":"SUCCEEDED"})
            return {"run_id":calculation["id"]}
        with calculation_lock:
            existing_run=next((r for r in store.list("calculation") if r.get("input_hash")==fingerprint and r["plan_id"]==plan_id and r["plan_revision"]==record["revision"]),None)
            if existing_run:
                return {"run_id":existing_run["id"],"status":"SUCCEEDED"}
            pending=next((j for j in store.list("job") if j.get("input_hash")==fingerprint and j.get("plan_id")==plan_id and j.get("plan_revision")==record["revision"] and j["status"] in ("QUEUED","RUNNING")),None)
            if pending:
                return {"job_id":pending["id"],"status":pending["status"]}
            job=submit_job("calculation",work,{"input_hash":fingerprint,"plan_id":plan_id,"plan_revision":record["revision"]})
        return {"job_id":job["id"],"status":job["status"]}

    @app.post("/api/v1/preview-calculation")
    def preview_calculation(body:dict):
        return calculate(PlanInput.model_validate(body["payload"]),models())

    @app.get("/api/v1/jobs/{job_id}")
    def get_job(job_id:str):
        return need(job_id,"job")

    @app.get("/api/v1/calculations/{run_id}")
    def get_run(run_id:str):
        return need(run_id,"calculation")

    @app.get("/api/v1/calculations/{run_id}/trace")
    def get_trace(run_id:str,item_id:str):
        report=need(run_id,"calculation")["result"]
        item=next((i for p in report["pools"] for i in p["items"] if i["id"]==item_id),None)
        if not item:
            raise HTTPException(404,"结果项不存在")
        return item

    @app.get("/api/v1/calculations/{run_id}/derivation")
    def calculation_derivation(run_id:str, scope:Literal["total","business","innovation","development"]="total"):
        return clean(build_derivation(need(run_id,"calculation"),scope))

    @app.get("/api/v1/calculations/{run_id}/costs")
    def historical_costs(run_id:str):
        need(run_id,"calculation")
        return [c for c in store.list("cost") if c["calculation_run_id"]==run_id]

    @app.post("/api/v1/calculations/compare")
    def compare(body:dict):
        ids=body.get("run_ids",[])
        if not 2<=len(ids)<=3:
            raise ValueError("请选择2至3个计算版本")
        runs=[need(key,"calculation") for key in ids]
        base=runs[0]
        def differences(a,b,path=""):
            changes=[]
            if isinstance(a,dict) and isinstance(b,dict):
                for key in sorted(set(a)|set(b)):
                    changes.extend(differences(a.get(key),b.get(key),f"{path}.{key}" if path else key))
            elif isinstance(a,list) and isinstance(b,list):
                for index in range(max(len(a),len(b))):
                    changes.extend(differences(a[index] if index<len(a) else None,b[index] if index<len(b) else None,f"{path}[{index}]"))
            elif a!=b:
                changes.append({"field":path,"before":a,"after":b})
            return changes
        return {"runs":[{"id":r["id"],"plan_id":r["plan_id"],"plan_revision":r["plan_revision"],"result":r["result"],"parameter_changes":[] if r==base else differences(base["input_snapshot"],r["input_snapshot"]),"delta_p":None if r["result"]["total_planned_p"] is None or base["result"]["total_planned_p"] is None else str(Decimal(r["result"]["total_planned_p"])-Decimal(base["result"]["total_planned_p"]))} for r in runs]}

    @app.post("/api/v1/imports/preview")
    async def import_preview(file:UploadFile|None=File(default=None),text:str|None=Form(default=None),sheet:str|None=Form(default=None),header_row:int=Form(default=1),column_mapping:str=Form(default="{}"),confirm_online_semantics:bool=Form(default=False)):
        content=await file.read(20*1024*1024+1) if file else None
        result=preview(models(),text,content,file.filename if file else None,sheet,header_row,json.loads(column_mapping),confirm_online_semantics)
        return store.insert("import",result)

    @app.post("/api/v1/imports/{import_id}/commit")
    def commit_import(import_id:str,body:dict):
        batch=need(import_id,"import")
        commits=batch.get("commits",{})
        key=body["plan_id"]+":"+body.get("idempotency_key","default")
        if key in commits:
            return plan_record(body["plan_id"])
        if batch.get("needs_online_confirmation"):
            raise ValueError("请先确认并发列是否指同时在线人数，并重新预览")
        record=plan_record(body["plan_id"])
        existing=record["payload"]["scenarios"]
        incoming=batch["scenarios"]
        strategy=body.get("strategy","append")
        if strategy=="replace_all":
            scenarios=incoming
        elif strategy=="update_by_name":
            if len({s["name"] for s in existing})!=len(existing) or len({s["name"] for s in incoming})!=len(incoming):
                raise ValueError("名称重复，无法自动按名称更新，请选择新增或手工处理")
            updates={s["name"]:s for s in incoming}
            scenarios=[updates.pop(s["name"],s) for s in existing]+list(updates.values())
        else:
            scenarios=existing+incoming
        result=update_plan(record["id"],{**record["payload"],"scenarios":scenarios},body.get("expected_revision"))
        store.replace(import_id,{**batch,"commits":{**commits,key:result["revision"]}})
        return result

    @app.get("/api/v1/catalog/models")
    def catalog_models(task_type:str|None=None,include_drafts:bool=False):
        values=store.list("model")
        return [m for m in values if (include_drafts or m.get("status")=="PUBLISHED") and (not task_type or task_type in m.get("tasks",[]))]

    @app.get("/api/v1/catalog/cards")
    def catalog_cards():
        return store.list("card")

    @app.get("/api/v1/catalog/baselines")
    def catalog_baselines():
        return store.list("baseline")

    # ------------------------------------------------ 推理算力评估（A/B/C 四约束）
    @app.get("/api/v1/inference/catalog")
    def inference_catalog_all():
        """推理评估所需的全部模板：模型结构、芯片规格、场景档位。"""
        custom = [m for m in store.list("inference-model") if not m.get("archived_at")]
        return {
            "models": inference_catalog.models(),
            "custom_models": custom,
            "chips": inference_catalog.chips(),
            "scenes": inference_catalog.scenes(),
            "sensitivity": [
                {"key": k, "label": v["label"]} for k, v in inference_engine.SENSITIVITY.items()
            ],
            "precision": ["auto", "bf16", "fp8", "int8", "int4"],
            "defaults_version": "inference-v1",
        }

    @app.post("/api/v1/inference/estimate")
    def inference_estimate(body: dict):
        """算一次推理评估，返回三维约束、拓扑与卡数。

        结果同时写入 calculation 快照，供历史对比与推导回看。
        """
        request = InferenceRequest.model_validate(body)
        custom = [m for m in store.list("inference-model") if not m.get("archived_at")]
        try:
            result = inference_engine.estimate(
                request.to_engine(),
                inference_catalog.models() + custom,
                inference_catalog.chips(),
                inference_catalog.scenes(),
                request.profile,
            )
        except inference_engine.InferenceIssue as exc:
            raise ValueError(f"{exc.code}: {exc.message}") from exc
        payload = {"request": request.model_dump(mode="json"), "result": result}
        return clean(payload)

    @app.post("/api/v1/inference/models")
    def inference_model_create(body: dict):
        """登记自定义模型结构，供清单外模型复用。"""
        data = InferenceModelInput.model_validate(body)
        if inference_catalog.find_model(data.key):
            raise ValueError("该模型标识已存在于内置清单，请换一个标识")
        existing = next((m for m in store.list("inference-model") if m["id"] == data.key), None)
        if existing:
            raise ValueError("该自定义模型已登记，可直接选用")
        return store.insert("inference-model", {**data.to_engine(), "archived_at": None}, data.key)

    @app.get("/api/v1/inference/models")
    def inference_model_list():
        return [m for m in store.list("inference-model") if not m.get("archived_at")]

    @app.delete("/api/v1/inference/models/{key}")
    def inference_model_archive(key: str):
        record = need(key, "inference-model")
        return store.replace(key, {**record, "archived_at": now()})

    # ------------------------------------------------ 推理参数（可配置）
    def params_state():
        effective = inference_params.current()
        overrides = inference_params.overrides()
        return clean({
            "defaults_version": effective.get("version"),
            "defaults_updated": effective.get("updated"),
            "notes": effective.get("notes", []),
            "effective": effective,
            "overrides": overrides,
            "has_overrides": bool(overrides),
            "schema": inference_params.describe(),
            "engine": {
                "tp_intra_cap": inference_engine.TP_INTRA_CAP,
                "sensitivity": [
                    {"key": k, "label": v["label"]}
                    for k, v in inference_engine.SENSITIVITY.items()
                ],
            },
        })

    def persist_params(patch):
        body = {"overrides": patch, "updated_at": now()}
        if store.get("active", "inference-params"):
            store.replace("active", body)
        else:
            store.insert("inference-params", body, "active")

    @app.get("/api/v1/inference/params")
    def inference_params_read():
        """当前生效参数 + 覆盖层 + 字段说明（前端按 schema 渲染表单）。"""
        return params_state()

    @app.put("/api/v1/inference/params")
    def inference_params_write(body: dict):
        """局部覆盖参数：只传要改的字段，按 schema 校验后落库并立即生效。"""
        patch = body.get("overrides") if isinstance(body.get("overrides"), dict) else body
        cleaned, errors = inference_params.validate(patch)
        if errors:
            raise ValueError("参数不合法：" + "；".join(
                f"{e['key']} {e['message']}" for e in errors[:6]))
        if not cleaned:
            raise ValueError("没有可应用的参数改动")
        merged = inference_params.set_overrides(cleaned)
        inference_engine.reload()
        persist_params(merged)
        return params_state()

    @app.post("/api/v1/inference/params/reset")
    def inference_params_reset():
        """清空覆盖层，回到 catalogs/inference_params.json 的默认值。"""
        inference_params.reset()
        inference_engine.reload()
        persist_params({})
        return params_state()

    @app.post("/api/v1/catalog/model-revisions")
    def model_revision(body:dict):
        fields=("display_name","source_url","revision","architecture","tasks")
        if not all(body.get(key) for key in fields):
            raise ValueError("新模型版本需名称、revision、来源、架构和任务类型")
        if not set(body["tasks"]).issubset({"text","vlm","cv","unit","native"}):
            raise ValueError("任务类型不合法")
        if body["architecture"] not in ("Dense","MoE","CV"):
            raise ValueError("架构必须为Dense、MoE或CV")
        for key in ("resident_parameters","active_parameters_prefill","active_parameters_decode","flop_per_unit"):
            if body.get(key) is not None and (not Decimal(str(body[key])).is_finite() or Decimal(str(body[key]))<=0):
                raise ValueError(f"{key}必须是正有限数")
        return store.insert("model",{**body,"status":"DRAFT","evidence_grade":body.get("evidence_grade","C")},body.get("id") or uuid4().hex)

    @app.post("/api/v1/catalog/baseline-revisions")
    def baseline_revision(body:dict):
        if body.get("calculator_id") not in ("llm-phases-v1","unit-work-v1","lora-work-v1") or not body.get("source_url"):
            raise ValueError("仅允许已注册计算器，且必须提供来源")
        if body.get("evidence_grade","C")!="C":
            raise ValueError("新基线默认C级，实测校准需保留完整证据后另行审核")
        parameters=body.get("parameters",{})
        # Validate an actual task profile before storing: never evaluate formula text.
        task=Task.model_validate(parameters)
        return store.insert("baseline",{**body,"parameters":task.model_dump(mode="json"),"revision":body.get("revision","custom-v1"),"status":"DRAFT"})

    @app.post("/api/v1/catalog/revisions/{revision_id}/publish")
    def publish(revision_id:str):
        record=need(revision_id)
        if record.get("status")!="DRAFT":
            raise ValueError("仅草稿可以发布")
        if record.get("tasks") and any(t in record["tasks"] for t in ("text","vlm")):
            if not record.get("active_parameters_prefill") or not record.get("active_parameters_decode"):
                raise ValueError("文本模型必须提供两个阶段的激活参数或保持待校准草稿")
        return store.replace(revision_id,{**record,"status":"PUBLISHED"})

    @app.post("/api/v1/catalog/revisions/{revision_id}/retire")
    def retire(revision_id:str):
        record=need(revision_id)
        return store.replace(revision_id,{**record,"status":"RETIRED"})

    @app.post("/api/v1/catalog/revisions/{revision_id}/trial")
    def trial(revision_id:str,body:dict):
        record=need(revision_id)
        task=Task.model_validate({**body.get("parameters",{}),"model_id":record["id"]})
        from app.engine.calculator import compute_task
        try:
            return clean(compute_task(task,record))
        except CalculationIssue as exc:
            return {"status":"MISSING","code":exc.code,"message":exc.message}

    @app.get("/api/v1/prices")
    def prices():
        return store.list("price")

    @app.post("/api/v1/prices")
    def save_price(body:dict):
        need(body["card_id"],"card")
        for key in ("price_low","price_high"):
            if body.get(key) is None or not Decimal(str(body[key])).is_finite() or Decimal(str(body[key]))<0:
                raise ValueError("请填写有效的人民币价格上下限")
        if Decimal(str(body["price_high"]))<Decimal(str(body["price_low"])):
            raise ValueError("价格上限不能小于下限")
        if not body.get("source") or not body.get("quote_date"):
            raise ValueError("价格需要来源和报价日期")
        date.fromisoformat(body["quote_date"])
        return store.insert("price",{**body,"currency":"CNY","region":"中国大陆","valid_days":int(body.get("valid_days",30))})

    @app.post("/api/v1/cost-estimates")
    def costs(body:dict):
        run_record=need(body["run_id"],"calculation")
        chosen=[need(key,"card") for key in body.get("spec_ids",[]) ] if body.get("spec_ids") else store.list("card")
        selected_prices={}
        rows=[need(key,"price") for key in body["price_revision_ids"]] if body.get("price_revision_ids") else store.list("price")
        for row in rows:
            if row["card_id"] not in selected_prices:
                selected_prices[row["card_id"]]=row
        result=cost_estimate(run_record["result"],chosen,selected_prices)
        for item in result["items"]:
            price=item.get("price")
            if price and date.today()>date.fromisoformat(price["quote_date"])+timedelta(days=price["valid_days"]):
                item["price_status"]="PRICE_EXPIRED"
            else:
                item["price_status"]="PRICE_MISSING" if not price else "DEMO" if price.get("is_demo") else "VALID"
        return store.insert("cost",{"calculation_run_id":run_record["id"],"result":result,"card_snapshot":chosen,"price_snapshot":selected_prices})

    @app.get("/api/v1/settings")
    def settings():
        record=store.get("assistant-settings")
        return {**(record or {"endpoint":"","model":"","timeout":45}),"has_key":bool(credential["key"]),"mode":"connected" if record and record.get("endpoint") and record.get("model") else "local"}

    @app.put("/api/v1/settings")
    def update_settings(body:dict):
        endpoint=str(body.get("endpoint",""))
        if endpoint and not endpoint.startswith(("http://","https://")):
            raise ValueError("接口地址须以http://或https://开头")
        if "api_key" in body and body["api_key"]:
            credential["key"]=body["api_key"]
        if body.get("clear_key"):
            credential["key"]=""
        value={"endpoint":endpoint,"model":str(body.get("model","")),"timeout":min(120,max(5,int(body.get("timeout",45))))}
        if store.get("assistant-settings"):
            store.replace("assistant-settings",value)
        else:
            store.insert("settings",value,"assistant-settings")
        return settings()

    @app.post("/api/v1/assistant/messages")
    def message(body:dict):
        record=plan_record(body["plan_id"])
        if body.get("revision")!=record["revision"]:
            raise RevisionConflict(record["id"])
        text=str(body.get("message","")).strip()
        if not text or len(text)>10000:
            raise ValueError("请输入1至10000字符")
        store.insert("message",{"plan_id":record["id"],"role":"user","content":text})
        def work():
            config=settings()
            payload=PlanInput.model_validate(record["payload"])
            fallback_reason=None
            if config["mode"]=="connected":
                try:
                    proposal=ask_provider(config,credential["key"],text,payload,record["revision"],models())
                    mode="connected"
                except Exception:
                    proposal=local_proposal(text,payload,record["revision"],models())
                    fallback_reason="AI接口暂不可用，已保留输入并切换本地规则。请检查配置或直接填写表格。"
                    mode="fallback"
            else:
                proposal=local_proposal(text,payload,record["revision"],models())
                mode="local"
            check_changes(proposal,payload,models())
            saved=store.insert("proposal",{"plan_id":record["id"],"proposal":proposal.model_dump(),"status":"PENDING","mode":mode,"fallback_reason":fallback_reason})
            return {"proposal_id":saved["id"]}
        job=submit_job("assistant",work)
        return {"job_id":job["id"]}

    @app.get("/api/v1/assistant/proposals/{proposal_id}")
    def get_proposal(proposal_id:str):
        return need(proposal_id,"proposal")

    @app.post("/api/v1/assistant/proposals/{proposal_id}/apply")
    def apply_proposal(proposal_id:str,body:dict):
        record=need(proposal_id,"proposal")
        plan=plan_record(record["plan_id"])
        proposal=Proposal.model_validate(record["proposal"])
        if record["status"]=="APPLIED":
            return plan
        if body.get("expected_revision")!=plan["revision"] or proposal.base_revision!=plan["revision"]:
            raise RevisionConflict(plan["id"])
        updated=check_changes(proposal,PlanInput.model_validate(plan["payload"]),models())
        result=update_plan(plan["id"],updated.model_dump(mode="json"),plan["revision"])
        store.replace(proposal_id,{**record,"status":"APPLIED"})
        return result

    @app.get("/api/v1/assistant/messages/{plan_id}")
    def message_history(plan_id:str):
        return [m for m in store.list("message") if m["plan_id"]==plan_id]

    dist=PROJECT_ROOT/"frontend"/"dist"
    if dist.exists():
        assets=dist/"assets"
        if assets.exists():
            app.mount("/assets",StaticFiles(directory=assets),name="assets")
        @app.get("/{path:path}")
        def spa(path:str):
            if path.startswith("api/"):
                raise HTTPException(404)
            return FileResponse(dist/"index.html")
    return app


app=create_app()
