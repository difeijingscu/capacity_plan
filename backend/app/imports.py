from __future__ import annotations

import csv
import hashlib
import io
import re
import zipfile
from decimal import Decimal

from openpyxl import load_workbook

from app.schemas import Scenario, Task

ALIASES = {
    "name": ["场景名称", "应用场景", "场景", "名称", "name"],
    "description": ["场景描述", "描述", "业务描述", "description"],
    "online_users": ["同时在线人数", "在线人数", "在线用户数", "用户数", "online_users"],
    "model_id": ["目标模型", "模型", "模型名称", "model"],
    "input_tokens": ["输入长度", "输入token", "input_tokens"],
    "answer_tokens": ["输出长度", "输出token", "answer_tokens"],
    "reasoning_tokens": ["推理长度", "思考token", "reasoning_tokens"],
    "requests_per_user_min": ["请求频次", "每分钟请求次数"],
    "streams": ["视频路数", "摄像头数", "路数"],
    "analysis_fps": ["分析帧率", "每秒分析帧数", "fps"],
    "images_per_request": ["每请求图片数", "图片数"],
}


def number(value):
    if value is None or str(value).strip() in ("", "待填写", "留空", "-"):
        return None
    match = re.fullmatch(r"\s*([\d,.]+)\s*(万|亿|[kKmMbB])?\s*(?:人|路|次|tokens?|Token)?\s*", str(value))
    if not match:
        raise ValueError("数值格式无法识别")
    multipliers = {None: 1, "万": 10000, "亿": 100000000, "k": 1000, "m": 1000000, "b": 1000000000}
    suffix = match.group(2)
    suffix = suffix.lower() if suffix and suffix.isascii() else suffix
    return Decimal(match.group(1).replace(",", "")) * multipliers[suffix]


def suggest_task(name, description, models):
    combined = name + " " + description
    if re.search("摄像|监控|目标检测|视频流", combined):
        kind, template = "cv", "qa"
    elif re.search("图片|图文|扫描|影像|多模态", combined):
        kind, template = "vlm", "vision"
    elif re.search("语音|音频|视频生成|图像生成|预测|推荐系统", combined):
        kind, template = "unit", "qa"
    else:
        kind = "text"
        template = "report" if "报告" in combined else "document" if "文档" in combined else "extract" if re.search("分类|抽取", combined) else "qa"
    preferred = {"text": "qwen3.6-35b-a3b", "vlm": "qwen3.6-27b", "cv": "yolo26s"}.get(kind)
    eligible = [m for m in models if kind in m.get("tasks", []) and not m.get("is_demo") and m.get("status") == "PUBLISHED"]
    chosen = next((m for m in eligible if m["id"].lower() == preferred), eligible[0] if eligible else None)
    return Task(task_type=kind, template=template, model_id=chosen["id"] if chosen else None)


def preview(models, text=None, content=None, filename=None, sheet=None, header_row=1, column_mapping=None, confirm_online_semantics=False):
    warnings, errors = [], []
    if header_row < 1 or header_row > 100:
        raise ValueError("表头行须介于1与100")
    source = dict(filename=filename or "文字粘贴", sheet=sheet, header_row=header_row)
    if content is not None:
        if len(content) > 20*1024*1024 or not (filename or "").lower().endswith(".xlsx"):
            raise ValueError("仅支持20MB以内的.xlsx文件")
        try:
            with zipfile.ZipFile(io.BytesIO(content)) as archive:
                if sum(info.file_size for info in archive.infolist()) > 100*1024*1024:
                    raise ValueError("解压内容超过100MB")
            workbook = load_workbook(io.BytesIO(content), read_only=True, data_only=True, keep_links=False)
        except Exception as exc:
            raise ValueError("Excel文件无法读取或超过限制") from exc
        sheets = workbook.sheetnames
        selected = sheet or sheets[0]
        if selected not in sheets:
            raise ValueError("工作表不存在")
        source["sheet"] = selected
        rows = list(workbook[selected].iter_rows(min_row=header_row, max_row=header_row+1001, values_only=True))
        workbook.close()
        fingerprint = hashlib.sha256(content).hexdigest()
        warnings.append("公式单元格只读取缓存值；空缓存请手工补充，不执行Excel公式。")
    else:
        text = (text or "").strip()
        if len(text) > 100000:
            raise ValueError("文字超过10万字符")
        if not text:
            raise ValueError("请粘贴场景清单")
        sheets = []
        fingerprint = hashlib.sha256(text.encode()).hexdigest()
        if "\t" in text or "," in text:
            delimiter = "\t" if "\t" in text else ","
            rows = list(csv.reader(io.StringIO(text), delimiter=delimiter))
            first = "".join(rows[0]).lower()
            if not any(alias in first for aliases in ALIASES.values() for alias in aliases):
                rows = [["场景名称", "场景描述", "在线人数"]] + rows
        else:
            rows = [["场景名称", "场景描述"]]
            for line in text.splitlines():
                line = re.sub(r"^\s*(?:\d+[.、)]|[-*])\s*", "", line).strip()
                if line:
                    parts = re.split("[：:]", line, maxsplit=1)
                    rows.append([parts[0], parts[1] if len(parts)>1 else ""])
    if len(rows) > 1001:
        raise ValueError("一次最多导入1000个场景")
    if not rows:
        raise ValueError("没有可读取的表格")
    headers = [str(v or "").strip() for v in rows[0]]
    mapping = {}
    ambiguous = []
    for index, header in enumerate(headers):
        normalized = header.lower().replace(" ", "")
        if header in ("并发数", "并发人数", "并发"):
            ambiguous.append(header)
            if confirm_online_semantics:
                mapping["online_users"] = index
        for field, aliases in ALIASES.items():
            if normalized in aliases:
                mapping[field] = index
    if column_mapping:
        for field, header in column_mapping.items():
            if field in ALIASES and header in headers:
                mapping[field] = headers.index(header)
    scenarios, duplicates = [], []
    seen = set()
    for index, row in enumerate(rows[1:], start=header_row+1):
        if not any(v is not None and str(v).strip() for v in row):
            continue
        def cell(field):
            col = mapping.get(field)
            return row[col] if col is not None and col < len(row) else None
        name = str(cell("name") or cell("description") or "").strip()
        if not name:
            errors.append(dict(row=index, field="name", message="缺少场景名称/描述，该行保留在原始数据中"))
            continue
        description = str(cell("description") or "")
        task = suggest_task(name, description, models)
        task.provenance = {field: {"origin": "import", "source_locator": {**source, "row": index, "column": headers[column]}} for field, column in mapping.items()}
        for field in ALIASES:
            if field in ("name", "description", "model_id"):
                continue
            try:
                value = number(cell(field))
                if value is not None:
                    setattr(task, field, value)
            except ValueError:
                errors.append(dict(row=index, field=field, message=f"无法识别 {cell(field)}，请补充"))
        explicit_model = str(cell("model_id") or "").strip()
        if explicit_model:
            match = next((m for m in models if explicit_model.lower() in (m["id"].lower(),m["display_name"].lower())), None)
            task.model_id = match["id"] if match else None
            if match is None:
                warnings.append(f"第{index}行的模型未匹配：{explicit_model}")
        try:
            task = Task.model_validate(task.model_dump())
        except Exception:
            errors.append(dict(row=index, field="workload", message="有无效数值，请修正后导入"))
            continue
        if name in seen:
            duplicates.append(name)
        seen.add(name)
        try:
            scenarios.append(Scenario(name=name, description=description, components=[task], source_reference={**source,"row":index}).model_dump(mode="json"))
        except Exception:
            errors.append(dict(row=index,field="name",message="场景名称或描述超出限制，该行保留在原始数据中"))
    return dict(headers=headers, mapping={field:headers[index] for field,index in mapping.items()}, sheets=sheets, selected_sheet=source.get("sheet"), scenarios=scenarios, errors=errors, warnings=warnings, duplicates=duplicates, ambiguous_columns=ambiguous, needs_online_confirmation=bool(ambiguous and not confirm_online_semantics), original_rows=[[str(v) if v is not None else None for v in row] for row in rows], source=source, fingerprint=fingerprint)
