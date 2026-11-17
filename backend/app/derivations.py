"""Readable derivations from immutable calculation snapshots, never from live defaults."""
from decimal import Decimal

D = lambda value: Decimal(str(value))
PETA = D("1e15")
NAMES = {"total": "建议规划总算力", "business": "业务场景", "innovation": "创新服务", "development": "开发测试"}


def fmt(value):
    if value is None:
        return "待补充"
    number = D(value)
    return format(number, ".6E") if number != 0 and abs(number) < D(".000001") else format(number, ",.6f").rstrip("0").rstrip(".")


def field(label, value, unit="", note=""):
    return dict(label=label, value=None if value is None else str(value), unit=unit, note=note)


def step(title, formula, substitution, value, unit="P", note=""):
    return dict(title=title, formula=formula, substitution=substitution, value=None if value is None else str(value), unit=unit, note=note)


def margin_steps(base, planned, headroom):
    return [step("增加一次容量余量", "建议容量 = 基础容量 × (1 + h)",
                 f"{fmt(base)} × (1 + {fmt(headroom)})", planned,
                 note=f"h = {fmt(D(headroom) * 100)}%；阶段效率和结构修正已计入基础容量，此处仅增加容量预留。")]


def sum_step(title, rows, value):
    terms = [fmt(r.get("base_p")) for r in rows if r.get("base_p") is not None]
    return step(title, "基础容量 = Σ已计入项的基础容量", " + ".join(terms) if terms else "暂无可计入项", value,
                note="按未舍入的快照值汇总；展示的中间数值保留最多6位小数。")


def tree_value(value, unit=""):
    if value is None:
        return "待补充"
    try:
        text = fmt(value)
    except Exception:
        text = str(value)
    return text + (" " + unit if unit else "")


def tree_node(label, relation="", expr="", value="", note="", children=None, tag=""):
    return dict(label=label, relation=relation, expr=expr, value=value,
                note=note or "本次测算保存的输入、目录与引擎轨迹", tag=tag,
                children=children or [])


def tree_steps(rows):
    return [tree_node(r["title"], r.get("formula", ""), r.get("substitution", ""),
                      tree_value(r.get("value"), r.get("unit", "")), r.get("note", ""))
            for r in rows]


def memory_tree(scope, pool, reserve, slots=1):
    memory = pool.get("memory") or {}
    total = memory.get("memory_gb")
    if scope == "innovation":
        groups = memory.get("groups") or []
        children = []
        for group in groups:
            weight = group.get("weight_gb")
            cache = group.get("cache_gb")
            runtime = group.get("runtime_gb")
            children.append(tree_node(
                group.get("model_id") or group.get("id") or "共享部署组",
                "组显存 = (权重 + KV cache + runtime) ÷ (1 - 显存预留)",
                f"({fmt(weight)} + {fmt(cache)} + {fmt(runtime)}) ÷ (1 - {fmt(reserve)})",
                tree_value(group.get("memory_gb"), "GB"),
                "同组兼容任务的权重和 runtime 取最大，KV cache 相加；数值来自 memory_for 与 summarize_memory。",
                [
                    tree_node("模型权重", "同部署组取最大权重", "驻留参数 × 权重位宽 ÷ 8 × 副本及量化元数据",
                              tree_value(weight, "GB"), "模型目录中的驻留参数与本次权重精度。"),
                    tree_node("KV cache", "Σ 序列数 × (输入 + 生成 Token) × 每 Token KV ÷ 10⁹",
                              f"本组各任务 KV 需求求和", tree_value(cache, "GB"),
                              "来自本次模型结构、KV 精度、请求速率、输入/输出长度和分配序列数。"),
                    tree_node("运行时开销", "同部署组取最大 runtime", "max(2 GB, 单副本权重 × 10%) × 副本数",
                              tree_value(runtime, "GB"), "引擎运行开销经验口径，不是实测值。"),
                ]))
        return tree_node("显存需求", "池显存 = Σ 各共享部署组显存",
                         " + ".join(fmt(g.get("memory_gb")) for g in groups) if groups else "暂无可计入部署组",
                         tree_value(total, "GB"),
                         f"显存预留 {fmt(reserve * 100)}% 已在各组应用一次；同池共享，三池之间不共享。", children)

    rows = [i for i in pool.get("items", []) if (i.get("memory") or {}).get("memory_gb") is not None]
    children = []
    for item in rows:
        v = (item.get("trace") or {}).get("variables") or {}
        children.append(tree_node(
            item.get("name", item["id"]),
            "单任务显存 = (基座权重 + adapter + activation + workspace) ÷ (1 - 显存预留)",
            f"({fmt(v.get('base_weight_gb'))} + {fmt(v.get('adapter_state_gb'))} + "
            f"{fmt(v.get('activation_gb'))} + {fmt(v.get('workspace_gb'))}) ÷ (1 - {fmt(reserve)})",
            tree_value((item.get("memory") or {}).get("memory_gb"), "GB"),
            "训练显存为经验代理；不含效果评测。", [
                tree_node("基座权重", "LoRA 按16位；QLoRA 按量化权重及元数据", "模型驻留参数与微调方法",
                          tree_value(v.get("base_weight_gb"), "GB")),
                tree_node("Adapter 状态", "驻留参数 × adapter 比例 × 16 bit ÷ 10⁹", "本次方案 adapter_fraction",
                          tree_value(v.get("adapter_state_gb"), "GB")),
                tree_node("Activation", "max(8 GB, 基座权重 × 20%) × 序列长度 ÷ 2048 × micro batch",
                          f"序列长度 {fmt(v.get('sequence_length'))}；micro batch {fmt(v.get('micro_batch'))}",
                          tree_value(v.get("activation_gb"), "GB")),
                tree_node("Workspace", "max(2 GB, 基座权重 × 10%)", "训练工作区经验预留",
                          tree_value(v.get("workspace_gb"), "GB")),
            ]))
    expression = f"max({', '.join(fmt((i.get('memory') or {}).get('memory_gb')) for i in rows)}) × {fmt(slots)}" if rows else "暂无可计入任务"
    return tree_node("训练显存需求", "池显存 = max(候选单任务显存) × 并行槽位",
                     expression, tree_value(total, "GB"),
                     "每个槽位按最大候选任务配置显存，不累加全部候选模型。", children)


def cards_tree(pool, headroom):
    detail = pool.get("cards_detail") or {}
    if detail.get("planned_compute_cards") is None:
        return tree_node("余量与物理卡数", "选择规格完整的芯片后折算物理卡数", "",
                         tree_value(pool.get("cards_planned"), "张"),
                         detail.get("reason") or "本次快照没有可用的卡数明细。")
    bf16 = D(detail["bf16_tflops"])
    per_card_mem = D(detail["memory_gb_per_card"])
    memory_gb = D(detail.get("memory_gb") or 0)
    compute = detail.get("planned_compute_cards")
    memory = detail.get("planned_memory_cards")
    cards = pool.get("cards")
    legacy_double_margin = detail.get("headroom_applications") != 1
    compute_relation = ("历史引擎：planned_p 在卡数阶段再次乘 (1 + h)" if legacy_double_margin else
                        "planned_p 已含一次余量，此处不重复相乘")
    compute_expression = (f"{fmt(pool.get('planned_p'))} × (1 + {fmt(headroom)}) × 1000 ÷ {fmt(bf16)}"
                          if legacy_double_margin else f"{fmt(pool.get('planned_p'))} × 1000 ÷ {fmt(bf16)}")
    children = [
        tree_node("基础卡数与一次余量", "cards = max(一次余量算力卡数, 基础显存卡数)",
                  f"max({detail.get('compute_cards')}, {detail.get('memory_cards')})",
                  tree_value(cards, "张"), "cards 的算力部分已经包含一次方案余量。"),
        tree_node("算力约束卡数", compute_relation,
                  f"ceil({compute_expression})", tree_value(compute, "张"),
                  "旧快照保留当时的重复余量口径；新快照只应用一次。" if legacy_double_margin else
                  "直接读取本次 cards_detail，不再把 planned_p 乘第二次余量。"),
        tree_node("显存约束卡数", "ceil(池显存 × (1 + h) ÷ 单卡显存)",
                  f"ceil({fmt(memory_gb)} × (1 + {fmt(headroom)}) ÷ {fmt(per_card_mem)})",
                  tree_value(memory, "张"), "显存路径只在规划约束中应用一次比例余量。"),
        tree_node("独立故障冗余", "基础卡数 + 1 张",
                  f"{fmt(cards)} + 1", tree_value(None if cards is None else D(cards) + 1, "张"),
                  "这是当前引擎保留的独立冗余规则，不属于比例余量；即使 h=0 也存在。"),
        tree_node("最终规划卡数", "max(基础卡数 + 1, 算力约束, 显存约束)",
                  f"max({fmt(cards)} + 1, {fmt(compute)}, {fmt(memory)})",
                  tree_value(pool.get("cards_planned"), "张"), "池层不按8卡整机对齐，避免混机型池被强制扩成整台。"),
        tree_node("规划服务器数", "ceil(规划卡数 ÷ 8)",
                  f"ceil({fmt(pool.get('cards_planned'))} ÷ {fmt(detail.get('cards_per_server') or 8)})",
                  tree_value(pool.get("servers_planned"), "台"), "仅按8卡/台估算，不代表已完成网络拓扑验证。"),
    ]
    return tree_node("余量与物理卡数", "一次容量余量 → 算力/显存取大 → 独立冗余 → 服务器取整",
                     f"芯片 {detail.get('chip_label') or detail.get('chip_key')}；单卡 {fmt(bf16)} TFLOPS / {fmt(per_card_mem)} GB",
                     tree_value(pool.get("cards_planned"), "张"),
                     "卡数、服务器数与P值是不同量纲；规划容量由规划卡数反算。", children)


def build_pool_tree(scope, pool, explanation, headroom, reserve):
    common_steps = [s for s in explanation["steps"] if s.get("title") != "增加一次容量余量"]
    task_children = []
    for item in explanation.get("items", []):
        source = "模型：" + str(item.get("model") or item.get("id"))
        if item.get("revision"):
            source += "；版本：" + str(item["revision"])
        if item.get("source"):
            source += "；来源：" + str(item["source"])
        task_children.append(tree_node(item.get("name", item["id"]),
                                       "展开本项的公式、代入数值与参数来源", "",
                                       tree_value(item.get("base_p"), "P"), source,
                                       tree_steps(item.get("steps", []))))
    demand_children = tree_steps(common_steps)
    if task_children:
        demand_children.append(tree_node("逐项任务推导", "每个模型或候选任务独立展开", "",
                                        f"{len(task_children)} 项", "所有子节点来自本次保存的计算轨迹。", task_children))
    demand_relation = ("Σ 各模型（Prefill + Decode）需求" if scope == "innovation" else
                       "max(候选单任务需求) × 并行微调槽位")
    demand = tree_node("需求与工作量", demand_relation, "从方案输入和模型目录逐步换算",
                       tree_value(pool.get("base_p"), "P"), "基础需求不含方案容量余量。", demand_children)
    slots = (pool.get("intensity_parameters") or {}).get("train_slots", 1)
    memory = memory_tree(scope, pool, reserve, slots)
    cards = cards_tree(pool, headroom)
    value = (tree_value(pool.get("cards_planned"), "张") + " · " + tree_value(pool.get("planned_p"), "P")
             if pool.get("cards_planned") is not None else tree_value(pool.get("planned_p"), "P"))
    return tree_node("创新池规划结果" if scope == "innovation" else "研发池规划结果",
                     "需求与显存双约束 → 一次容量余量 → 物理卡数与独立冗余",
                     f"headroom = {fmt(D(headroom) * 100)}%；显存预留 = {fmt(D(reserve) * 100)}%",
                     value, "根节点为本次保存结果；三个主干可逐层展开到原始数字与来源。",
                     [demand, memory, cards])


def describe_task(item, original, models, pool):
    trace = item.get("trace") or {}
    v = trace.get("variables") or {}
    model = models.get(item.get("model_id"), {})
    formula = trace.get("formula_id")
    result = dict(id=item["id"], name=item.get("name", item["id"]), model=model.get("display_name") or item.get("model_id"),
                  revision=trace.get("model_revision") or model.get("revision"), source=trace.get("model_source") or model.get("source_url"),
                  formula_id=formula, base_p=item.get("base_p"), inputs=[], steps=[], notes=[])
    inputs, steps, notes = result["inputs"], result["steps"], result["notes"]
    quota = trace.get("quota")
    if quota:
        inputs.extend([field("模型Token份额", quota["model_share"], "比例"),
                       field("分配给该模型的月Token", quota["allocated"], "Token/月")])
        steps.append(step("分配该模型月额度", "Q模型 = Q月 × 模型份额",
                          f"{fmt(quota['monthly_total'])} × {fmt(quota['model_share'])}", quota["allocated"], "Token/月"))
        steps.append(step("换算模型输入与生成峰值", "输入TPS = Q模型 × 输入比例 ÷ 服务秒数 × 峰值倍数；生成TPS同理",
                          f"输入：{fmt(quota['allocated'])} × {fmt(v.get('input_tokens_total'))} ÷ {fmt(D(v['input_tokens_total']) + D(v['generation_tokens_total']))} ÷ {fmt(quota['service_seconds'])} × {fmt(quota['peak_factor'])}\n"
                          f"输入 = {fmt(quota['input_tokens_per_second'])}；生成 = {fmt(quota['output_tokens_per_second'])}",
                          D(quota["input_tokens_per_second"]) + D(quota["output_tokens_per_second"]), "总Token/秒",
                          "额度中的总生成Token已包含推理Token，不再重复追加。"))
    elif formula == "llm-phases-v1":
        if original.get("request_rate") is None and v.get("online_users") is not None:
            steps.append(step("在线人数换算模型请求速率", "λ = U × r × 每业务请求模型调用次数 ÷ 60",
                              f"{fmt(v['online_users'])} × {fmt(v['requests_per_user_min'])} × {fmt(v['calls_per_request'])} ÷ 60",
                              v["request_rate"], "请求/秒", "U为本次计算采用的期末在线人数，已按方案口径处理增长。"))
        else:
            steps.append(step("采用直接请求速率", "λ = 本次输入的请求/秒", fmt(v.get("request_rate")), v.get("request_rate"), "请求/秒"))

    if formula == "llm-phases-v1":
        inputs.extend([field(label, v.get(key), unit) for label, key, unit in [
            ("请求速率", "request_rate", "请求/秒"), ("输入阶段激活参数 Np", "active_parameters_prefill", "参数"),
            ("生成阶段激活参数 Nd", "active_parameters_decode", "参数"), ("输入总Token Li", "input_tokens_total", "Token/请求"),
            ("可见输出Token", "answer_tokens", "Token/请求"), ("额外推理Token", "reasoning_tokens", "Token/请求"),
            ("总生成Token Lg", "generation_tokens_total", "Token/请求"), ("输入结构修正 κp", "kappa_prefill", ""),
            ("生成结构修正 κd", "kappa_decode", ""), ("输入效率 ηp", "eta_prefill", "比例"), ("生成效率 ηd", "eta_decode", "比例"),
        ]])
        if item.get("task_type") == "vlm":
            steps.append(step("合并图文输入", "Li = 文本Token + (图片数 + 抽取帧数) × 每图视觉Token",
                              f"{fmt(v['input_tokens'])} + ({fmt(v['images_per_request'])} + {fmt(v['extracted_frames_per_request'])}) × {fmt(v['visual_tokens_per_image'])}",
                              v["input_tokens_total"], "Token/请求", "创新额度若已包含视觉Token，则不重复追加视觉Token。"))
        fp, fd, vision = map(D, (item["prefill_flop_per_request"], item["decode_flop_per_request"], item.get("vision_flop_per_request") or 0))
        steps.extend([
            step("每请求输入工作量", "Fp = 2 × Np × Li × κp",
                 f"2 × {fmt(v['active_parameters_prefill'])} × {fmt(v['input_tokens_total'])} × {fmt(v['kappa_prefill'])}", fp, "FLOP/请求"),
            step("每请求生成工作量", "Fd = 2 × Nd × Lg × κd",
                 f"2 × {fmt(v['active_parameters_decode'])} × {fmt(v['generation_tokens_total'])} × {fmt(v['kappa_decode'])}", fd, "FLOP/请求"),
        ])
        if vision:
            expression = fmt(vision) if v.get("vision_flop_per_request") is not None else f"{fmt(fp)} × {fmt(v['vision_flop_ratio'])}"
            steps.append(step("视觉编码工作量", "采用专用输入，或 F视觉 = Fp × 视觉工作量比例", expression, vision, "FLOP/请求",
                              "比例代理与专用输入均以本次快照为准，不代表视觉编码实测。"))
        prefill = D(v["request_rate"]) * ((fp + vision) / D(v["eta_prefill"])) / PETA
        decode = D(v["request_rate"]) * (fd / D(v["eta_decode"])) / PETA
        steps.extend([
            step("输入阶段容量", "Cp = λ × (Fp + F视觉) ÷ ηp ÷ 10¹⁵",
                 f"{fmt(v['request_rate'])} × ({fmt(fp)} + {fmt(vision)}) ÷ {fmt(v['eta_prefill'])} ÷ 10¹⁵", prefill),
            step("生成阶段容量", "Cd = λ × Fd ÷ ηd ÷ 10¹⁵",
                 f"{fmt(v['request_rate'])} × {fmt(fd)} ÷ {fmt(v['eta_decode'])} ÷ 10¹⁵", decode),
            step("单任务基础容量", "C任务基础 = Cp + Cd", f"{fmt(prefill)} + {fmt(decode)}", item.get("base_p")),
        ])
        notes.append("2N为参数主导的近似；κ和效率为本次采用的假设，不是厂商保证值。此处为单任务基础容量，余量在资源池层增加。")
    elif formula == "unit-work-v1":
        inputs.extend([field("每秒单位数", v.get("unit_rate"), "单位/秒"), field("每单位工作量", v.get("flop_per_unit"), "FLOP/单位"),
                       field("单位任务效率", v.get("eta_unit"), "比例")])
        if item.get("task_type") == "cv" and v.get("images_per_second") is None and v.get("streams") is not None:
            expression = f"{fmt(v['streams'])} × {fmt(v['analysis_fps'])}"
            formula_text = "R = 视频路数 × 每路分析帧率"
        elif item.get("task_type") == "unit" and v.get("units_per_second") is None and v.get("total_units") is not None:
            expression = f"{fmt(v['total_units'])} ÷ ({fmt(v['deadline_hours'])} × 3600)"
            formula_text = "R = 离线任务总量 ÷ (完成小时 × 3600)"
        elif item.get("task_type") == "cv" and v.get("images_per_second") is None and v.get("request_rate") is not None:
            expression = f"{fmt(v['request_rate'])} × {fmt(v['images_per_request'])}"
            formula_text = "R = 直接请求速率 × 每请求图片数"
        elif item.get("task_type") == "cv" and v.get("images_per_second") is None and v.get("online_users") is not None:
            expression = f"{fmt(v['online_users'])} × {fmt(v['requests_per_user_min'])} × {fmt(v['calls_per_request'])} ÷ 60 × {fmt(v['images_per_request'])}"
            formula_text = "R = U × r × 调用次数 ÷ 60 × 每请求图片数"
        else:
            expression, formula_text = fmt(v.get("unit_rate")), "采用本次直接处理速率，或请求速率 × 每请求图片数"
        steps.extend([step("确定任务处理速率", formula_text, expression, v.get("unit_rate"), "单位/秒"),
                      step("单位任务基础容量", "C基础 = R × 每单位FLOP ÷ η单位 ÷ 10¹⁵",
                           f"{fmt(v['unit_rate'])} × {fmt(v['flop_per_unit'])} ÷ {fmt(v['eta_unit'])} ÷ 10¹⁵", item.get("base_p"))])
        notes.append("分辨率代理若被采用，展示的每单位FLOP已包含该修正；按本次保存的任务基线计量。")
    elif formula == "lora-work-v1":
        inputs.extend([field(label, v.get(key), unit) for label, key, unit in [
            ("训练激活参数", "active_parameters_train", "参数"), ("每任务训练数据", "train_data_tokens", "Token"),
            ("训练轮数", "epochs", "轮"), ("训练工作量系数", "train_k", ""),
            ("微调时限", "train_deadline_hours", "小时"), ("训练效率", "train_eta", "比例"),
        ]])
        steps.extend([
            step("单次微调总工作量", "F训练 = k训练 × N训练激活 × D × E",
                 f"{fmt(v['train_k'])} × {fmt(v['active_parameters_train'])} × {fmt(v['train_data_tokens'])} × {fmt(v['epochs'])}", v["flop_total"], "FLOP"),
            step("单任务微调基础容量", "C微调 = F训练 ÷ (H × 3600 × η训练 × 10¹⁵)",
                 f"{fmt(v['flop_total'])} ÷ ({fmt(v['train_deadline_hours'])} × 3600 × {fmt(v['train_eta'])} × 10¹⁵)", item.get("base_p")),
        ])
        notes.append("训练工作量系数是经验假设。单任务容量还需按研发槽位聚合，不直接累加全部候选模型。")
    elif formula == "native-mapping-v1" and original.get("native_capacity") is not None:
        inputs.extend([field("原生精度容量", original["native_capacity"], original.get("native_precision", "")),
                       field("参考映射系数", trace.get("mapping"))])
        steps.append(step("经核验映射为参考容量", "C参考 = C原生 × 映射系数",
                          f"{fmt(original['native_capacity'])} × {fmt(trace['mapping'])}", item.get("base_p")))
        notes.append("此映射来自该任务保存的基线来源，不按精度位宽自动换算。")
    else:
        notes.append("该任务未保存可解释的完整轨迹或缺少精度映射；仅展示已保存值，不用当前默认值补造推导。")
    return result


def _describe_scenario_v2(item, trace, v):
    """v2.0.0 业务池场景推导：从推理评估页口径的 trace 还原 A/B/C 三维与卡数。"""
    result = dict(id=item["id"], name=item.get("name", item["id"]),
                  model=f"{v.get('model_key', '')} · {v.get('chip_key', '')}",
                  revision=None, source=None, formula_id="inference-abc-v2",
                  base_p=item.get("base_p"), inputs=[], steps=[], notes=[])
    inputs, steps, notes = result["inputs"], result["steps"], result["notes"]
    inputs.extend([
        field("推理模型", v.get("model_key"), "", "模型结构取自内置清单或自定义登记。"),
        field("算力服务器", v.get("chip_key")),
        field("量化档位", v.get("precision")),
        field("工程系数档位", v.get("tier"), "", "保守/均衡/激进按指数规则作用于效率类系数。"),
        field("输入长度", v.get("prompt_len"), "Token"),
        field("输出长度", v.get("output_len"), "Token"),
        field("并发会话", v.get("concurrency"), "路"),
        field("首Token目标", v.get("ttft_target_ms"), "ms"),
        field("逐Token目标", v.get("tpot_target_ms"), "ms"),
    ])
    dims = [
        ("显存约束 A", v.get("a"), "权重装载宽度 × 副本数（权重 + KV 容量）",
         "显存看总参数（MoE 装全部专家）；KV 按并发 × 连续批均长（输入+输出/2）预留。"),
        ("Prefill 约束 B", v.get("b"), "max(吞吐下限 N1, M/G/1 排队时延下限 N2)",
         "算力看激活参数；小批量专家填不满按 FFN 有效利用率放大。"),
        ("Decode 约束 C", v.get("c"), "枚举 分片宽度 × 副本数，取满足 TPOT 的最小卡数",
         "Decode 是带宽游戏：每出一个 Token 都要重读权重；带宽下限之下加卡无效。"),
    ]
    for title, cards, formula, note in dims:
        steps.append(step(title, formula,
                          f"{v.get('model_key')} × {v.get('precision')} @ {v.get('chip_key')}",
                          cards, "张", note))
    raw, cards = v.get("raw_cards"), v.get("cards")
    even = "" if raw == cards else f" → 补偶 {cards}"
    steps.append(step("三维取最大（不是相加）+ 奇数补偶", "卡数 = max(A, B, C)，奇数补偶",
                      f"max({v.get('a')}, {v.get('b')}, {v.get('c')}) = {raw}{even}",
                      cards, "张",
                      f"瓶颈在 {v.get('bottleneck_label') or v.get('bottleneck', '—')}；输出为恰好满足 SLA 的最小卡数。"))
    steps.append(step("时延预测", "TTFT 预测 vs 目标；Decode 步长 vs TPOT 目标",
                      f"TTFT {fmt(v.get('ttft_pred_ms'))} / {fmt(v.get('ttft_target_ms'))} ms；"
                      f"步长 {fmt(v.get('tpot_step_ms'))} / {fmt(v.get('tpot_target_ms'))} ms"
                      f"（带宽理论下限 {fmt(v.get('decode_floor_ms'))} ms）",
                      "达标" if v.get("sla_passed") else "未达标", ""))
    steps.append(step("折算等效算力", "P = 卡数 × 单卡 BF16 算力(T) ÷ 1000",
                      f"{cards} × {fmt(v.get('bf16_tflops'))} ÷ 1000", v.get("base_p"), "P，BF16 基准"))
    notes.append("卡数为物理台数（8 卡/台），与算力（P）不是同一量纲；v2 口径输出最小卡数，容量余量由方案 headroom 在池层一次放大。")
    warnings = item.get("warnings") or []
    if "MIGRATED_INFERENCE" in warnings:
        notes.append("该场景没有推理配置，是按旧字段（模型、在线人数、Token 长度）推导的等价配置，请复核模型与并发。")
    if "SCENARIO_NOT_CONFIGURED" in warnings:
        notes.append("该场景没有任何可用配置，按默认档位估算，结果仅供参考。")
    if any(w.startswith(("MIGRATED_", "CHIP_")) for w in warnings):
        notes.append("该场景携带旧方案的场景档 / 精度 / 芯片配置，已按 v2.0 目录映射迁移（见告警），请复核迁移结果。")
    return result


def describe_scenario(item):
    """业务池场景：从推理引擎快照还原 A/B/C 三维、SLA 与卡数（新旧两种 trace 格式）。"""
    trace = item.get("trace") or {}
    v = trace.get("variables") or {}
    if trace.get("formula_id") == "inference-abc-v2":
        return _describe_scenario_v2(item, trace, v)
    dims = v.get("dimensions") or {}
    result = dict(id=item["id"], name=item.get("name", item["id"]),
                  model=f"{v.get('model_key', '')} · {v.get('chip_key', '')}",
                  revision=None, source=None, formula_id="inference-abc-v1",
                  base_p=item.get("base_p"), inputs=[], steps=[], notes=[])
    inputs, steps, notes = result["inputs"], result["steps"], result["notes"]
    inputs.extend([
        field("推理模型", v.get("model_key"), "", "模型结构取自内置清单或自定义登记。"),
        field("算力服务器", v.get("chip_key")),
        field("量化口径", v.get("precision")),
        field("输入长度", v.get("prompt_len"), "Token"),
        field("输出长度", v.get("output_len"), "Token"),
        field("最大上下文", v.get("max_ctx"), "Token"),
        field("并发会话", v.get("concurrency"), "路"),
        field("首Token目标", v.get("ttft_target_ms"), "ms"),
        field("逐Token目标", v.get("tpot_target_ms"), "ms"),
    ])
    steps.extend([
        step("显存约束卡数", "权重（GiB）÷（单卡显存 × 利用率）→ 枚举 TP×PP×EP 取总卡数最小解",
             f"推理模型 {v.get('model_key')} × 量化 {v.get('precision')}", dims.get("memory"), "张",
             "权重看总参，KV 看并发 × 每会话分配窗口；同实例内权重共享。"),
        step("Prefill 约束卡数", "max(吞吐约束, 首Token 时延约束)",
             f"需求算力 {fmt(v.get('demand_tflops'))} TFLOPS ÷ 单卡有效算力", dims.get("prefill"), "张",
             "有效算力按 roofline 取「算力×MFU」与「带宽可达」的较小值。"),
        step("Decode 约束卡数", "max(带宽反解副本数, 吞吐约束)",
             f"逐Token {fmt(v.get('tpot_ms'))} ms vs 目标 {fmt(v.get('tpot_target_ms'))} ms", dims.get("decode"), "张",
             "Decode 是带宽游戏：每出一个 Token 都要重读权重，长序列下 KV 读带宽还会衰减。"),
        step("三维取最大（不是相加）", "物理下界 = max(A, B, C)",
             f"max({dims.get('memory')}, {dims.get('prefill')}, {dims.get('decode')})",
             item.get("cards"), "张", f"瓶颈在 {v.get('bottleneck', '—')}；同一批卡同时承担 Prefill 与 Decode。"),
        step("时延回验", "TTFT ≤ 目标 且 TPOT ≤ 目标；不达标逐级加 DP，仍不行则放大 TP",
             f"TTFT {fmt(v.get('ttft_ms'))} / {fmt(v.get('ttft_target_ms'))} ms；"
             f"TPOT {fmt(v.get('tpot_ms'))} / {fmt(v.get('tpot_target_ms'))} ms",
             "达标" if v.get("sla_passed") else "未达标", "",
             f"采用拓扑 {v.get('topology')}，单实例 {v.get('unit')} 卡。"),
        step("折算参考算力", "P = 卡数 × 单卡 BF16 算力(T) ÷ 1000",
             f"{item.get('cards')} × {fmt(v.get('bf16_tflops'))} ÷ 1000", item.get("capacity_p"), "P，BF16 基准"),
    ])
    notes.append("卡数为物理台数，与算力（P）不是同一量纲；需求算力以 BF16 稠密算力为基准、按所选精度折算。")
    warnings = item.get("warnings") or []
    if "MIGRATED_INFERENCE" in warnings:
        notes.append("该场景没有推理配置，是按旧字段（模型、在线人数、Token 长度）推导的等价配置，请复核模型与并发。")
    if "SCENARIO_NOT_CONFIGURED" in warnings:
        notes.append("该场景没有任何可用配置，按默认档位估算，结果仅供参考。")
    return result


def build_business_tree(pool, explanation, headroom):
    """业务池杜邦树：逐场景三维取最大 → 汇总 → 一次余量 → 8 卡部署粒度 → 容量折算。

    与创新/研发不同，业务池没有独立故障冗余、也不按整机对齐；卡数只由
    「Σ 场景卡数 × (1 + h) 再向上取整到 8 卡」决定，所以这里不出现 +1 节点。
    变量取自 pool.items 的 trace（explanation.items 只有文字步骤，没有原始变量）。
    """
    steps_by_id = {i["id"]: i.get("steps", []) for i in explanation.get("items") or []}
    items = pool.get("items") or []
    cards, cards_planned = pool.get("cards"), pool.get("cards_planned")
    scenes, scene_cards, bf16_values = [], [], set()
    for item in items:
        v = (item.get("trace") or {}).get("variables") or {}
        if v.get("bf16_tflops") is not None:
            bf16_values.add(D(v["bf16_tflops"]))
        final = v.get("cards", item.get("cards"))
        if final is not None:
            scene_cards.append(D(final))
        raw = v.get("raw_cards")
        even = "" if raw is None or final is None or D(raw) == D(final) else f" → 补偶 {fmt(final)}"
        scenes.append(tree_node(
            item.get("name") or item["id"],
            "卡数 = max(A显存, B Prefill, C Decode)，奇数补偶",
            f"max({fmt(v.get('a'))}, {fmt(v.get('b'))}, {fmt(v.get('c'))}){even}",
            tree_value(final, "张"),
            f"模型 {v.get('model_key') or '—'} · {v.get('precision') or '—'} @ {v.get('chip_key') or '—'}；"
            f"瓶颈 {v.get('bottleneck_label') or '—'}；该场景需求算力 {tree_value(item.get('base_p'), 'P')}",
            tree_steps(steps_by_id.get(item["id"], []))))
    demand = tree_node("逐场景需求与卡数", "Σ 各场景卡数（三维取最大，不是相加）",
                       " + ".join(fmt(c) for c in scene_cards) if scene_cards else "暂无可计入场景",
                       tree_value(cards, "张"),
                       "场景高峰按同时发生汇总；卡数是物理台数，与算力（P）不是同一量纲。",
                       scenes)
    margin = tree_node("一次容量余量与部署粒度",
                       "含余量卡数 = max(8, ceil(Σ卡数 × (1 + h) ÷ 8) × 8)",
                       f"max(8, ceil({fmt(cards)} × (1 + {fmt(headroom)}) ÷ 8) × 8)",
                       tree_value(cards_planned, "张"),
                       f"h = {fmt(D(headroom) * 100)}%；余量只在场景层放大一次，池层不再重复；"
                       "结果向上对齐到最小部署粒度 8 卡，且不少于一个部署单元。",
                       [tree_node("建议算力（含余量）", "建议容量 = 基础容量 × (1 + h)",
                                  f"{fmt(pool.get('base_p'))} × (1 + {fmt(headroom)})",
                                  tree_value(pool.get("planned_p"), "P"),
                                  "阶段效率与结构修正已计入基础容量，此处只加容量预留。")])
    bf16 = next(iter(bf16_values), None)
    capacity_note = ("按所选芯片的 BF16 稠密算力折算。" if len(bf16_values) <= 1 else
                     "各场景芯片不同，按各自单卡算力分别折算后求和。")
    capacity = tree_node("等效算力折算", "P = 卡数 × 单卡 BF16 算力(T) ÷ 1000",
                         f"{fmt(cards_planned)} × {fmt(bf16)} ÷ 1000" if bf16 is not None else "芯片规格待补充",
                         tree_value(pool.get("capacity_planned_p"), "P"), capacity_note,
                         [tree_node("物理卡数（不含余量）", "逐场景三维取最大后求和", "",
                                    tree_value(cards, "张"), "含余量卡数见上一分支。"),
                          tree_node("规划服务器数（参考）", "ceil(卡数 ÷ 8)", f"ceil({fmt(cards_planned)} ÷ 8)",
                                    tree_value(pool.get("servers"), "台"),
                                    "仅按 8 卡/台折算，不代表已完成网络与供电拓扑验证。")])
    # 图例名放在 legend 上：tag 会被渲染成卡片胶囊，与图例重复。
    demand["legend"], margin["legend"], capacity["legend"] = "需求 / 卡数", "余量 / 粒度", "容量折算"
    value = (tree_value(cards_planned, "张") + " · " + tree_value(pool.get("planned_p"), "P")
             if cards_planned is not None else tree_value(pool.get("planned_p"), "P"))
    return tree_node("业务池规划结果",
                     "逐场景三维取最大 → 汇总 → 一次容量余量 → 8 卡部署粒度 → 容量折算",
                     f"headroom = {fmt(D(headroom) * 100)}%", value,
                     "根节点为本次保存结果；三个主干可逐层展开到原始数字与来源。",
                     [demand, margin, capacity])


def build_total_tree(report, pools, headroom):
    """总量杜邦树：三池建议容量相加，汇总层不再乘余量。"""
    children = []
    for pool in pools:
        kids = [tree_node("一次容量余量", "建议容量 = 基础容量 × (1 + h)",
                          f"{fmt(pool.get('base_p'))} × (1 + {fmt(headroom)})",
                          tree_value(pool.get("planned_p"), "P"),
                          "余量在池内已应用一次，汇总层不重复相乘。")]
        if pool.get("cards_planned") is not None:
            kids.append(tree_node("含余量卡数", "口径见该池计算推导", "",
                                  tree_value(pool.get("cards_planned"), "张"),
                                  "三池卡数不相加：机型与部署粒度不同，只在本池内有意义。"))
        children.append(tree_node(NAMES.get(pool["id"], pool["id"]), "本池建议容量（已含余量）", "",
                                  tree_value(pool.get("planned_p"), "P"),
                                  f"状态：{pool.get('completeness')}；基础容量 {tree_value(pool.get('base_p'), 'P')}",
                                  kids))
    return tree_node("建议规划总算力", "总量 = Σ 三池建议容量（各池已含余量，汇总不再乘余量）",
                     " + ".join(fmt(p.get("planned_p")) for p in pools) or "暂无可计入资源池",
                     tree_value(report.get("total_planned_p"), "P"),
                     "三池独立配置，同池兼容模型可共享权重但负载仍相加；跨池不共享。", children)


def build_derivation(run, scope):
    report, payload = run["result"], run["input_snapshot"]
    headroom = D(report["headroom"])
    # catalog_snapshot 双格式：v2.0.0 起为 {inference_models, inference_chips,
    # inference_scenes, params_effective}；旧快照是模型清单数组，冻结不动。
    snapshot = run.get("catalog_snapshot")
    if isinstance(snapshot, dict):
        models = {m["key"]: {"display_name": m.get("label") or m.get("key"),
                             "revision": m.get("revision"), "source_url": m.get("source_url")}
                  for m in (snapshot.get("inference_models") or [])}
    else:
        models = {m["id"]: m for m in (snapshot or [])}
    pools = report["pools"]
    pool = next((p for p in pools if p["id"] == scope), None)
    result = dict(run_id=run["id"], plan_id=run["plan_id"], plan_revision=run["plan_revision"], created_at=run["created_at"],
                  scope=scope, title=NAMES[scope] + " · 计算推导", completeness=report["completeness"] if scope == "total" else pool["completeness"],
                  base_p=report["total_base_p"] if scope == "total" else pool["base_p"],
                  planned_p=report["total_planned_p"] if scope == "total" else pool["planned_p"],
                  inputs=[], steps=[], breakdown=[], items=[], tree=None, missing_items=report["missing_items"] if scope == "total" else pool["missing_items"],
                  notes=["全部数值来自该次输入、模型和计算轨迹快照，不读取当前编辑值、当前模型库或新的默认值。",
                         "中间数值最多展示6位小数，最终容量采用快照未舍入值；算力以 BF16 稠密算力为基准折算、单位 P / T，效率和结构代理仍需实测校准。"])
    inputs, steps = result["inputs"], result["steps"]
    inputs.extend([field("容量余量", headroom * 100, "%")])
    if scope == "total":
        result["breakdown"] = [dict(id=p["id"], name=NAMES[p["id"]], base_p=p["base_p"], planned_p=p["planned_p"], completeness=p["completeness"]) for p in pools]
        steps.append(sum_step("汇总三类资源池基础容量", pools, report["total_base_p"]))
        steps.extend(margin_steps(report["total_base_p"], report["total_planned_p"], headroom))
        result["notes"].append("三池独立配置；同池兼容模型可以共享权重，但计算负载仍相加。各池建议值已含余量，汇总后不再次增加余量。")
        result["tree"] = build_total_tree(report, pools, headroom)
        return result
    if pool["completeness"] == "DISABLED":
        result["notes"].append("本次方案未启用此资源池，计入总量为0；没有任务推导。")
        return result
    if scope == "innovation":
        config = payload["innovation"]
        inputs.extend([field("支持人数", config["users"], "人", "用于计算月配额，不等于同时执行的请求数。"),
                       field("人均月度总Token", config["quota_per_user_month"], "Token/人/月"), field("额度使用率", config["usage_ratio"], "比例"),
                       field("每月服务日", config["service_days"], "天"), field("每日服务时长", config["service_hours_per_day"], "小时"),
                       field("峰值倍数", config["peak_factor"], "倍")])
        monthly = pool.get("monthly_tokens")
        if monthly is not None:
            seconds = D(config["service_days"]) * D(config["service_hours_per_day"]) * 3600
            average = D(monthly) / seconds
            steps.extend([
                step("得到全池实际月度Token预算", "Q月 = 支持人数 × 人均月额度 × 使用率",
                     f"{fmt(config['users'])} × {fmt(config['quota_per_user_month'])} × {fmt(config['usage_ratio'])}", monthly, "Token/月"),
                step("得到有效服务时间", "T = 每月服务日 × 每日小时 × 3600",
                     f"{fmt(config['service_days'])} × {fmt(config['service_hours_per_day'])} × 3600", seconds, "秒/月"),
                step("月额度换算平均吞吐", "平均总TPS = Q月 ÷ T", f"{fmt(monthly)} ÷ {fmt(seconds)}", average, "Token/秒"),
                step("按峰值倍数规划吞吐", "峰值总TPS = 平均总TPS × 峰值倍数",
                     f"{fmt(average)} × {fmt(config['peak_factor'])}", average * D(config["peak_factor"]), "Token/秒"),
            ])
        result["notes"].append("多个模型分享一份总额度。展开下方模型项查看份额、输入/生成比例、阶段效率和结构修正的数值代入。")
    elif scope == "development":
        config = pool.get("intensity_parameters", {})
        if "train_slots" in config:
            inputs.extend([field("微调槽位", config["train_slots"], "个", "开发测试只规划微调，不含效果评测。")])
            train = [i for i in pool["items"] if i.get("base_p") is not None]
            tc = max((D(i["base_p"]) for i in train), default=D(0))
            terms = ", ".join(fmt(i["base_p"]) for i in train) or "暂无已计入项，暂计0"
            steps.append(step("微调槽位容量", "C微调 = max(已计入候选模型的单任务容量) × 微调槽位数",
                              f"max({terms}) × {fmt(config['train_slots'])}", tc * D(config["train_slots"]),
                              note="未计入模型仍需补齐，暂计0不表示该模型无需资源。" if not train else
                              "最大单任务来源：" + max(train, key=lambda item: D(item["base_p"])).get("name", "候选任务") + "。按此能力配置每个槽位，不机械累加所有候选模型。"))
        else:
            result["notes"].append("旧快照缺少槽位参数，不使用当前档位默认值重建研发聚合。")
    if scope != "development":
        steps.append(sum_step("汇总资源池基础容量", pool["items"], pool["base_p"]))
    steps.extend(margin_steps(pool["base_p"], pool["planned_p"], headroom))
    originals = {t["id"]: t for s in payload["scenarios"] for t in s.get("components", [])}
    if scope == "business":
        result["items"] = [describe_scenario(i) for i in pool["items"]]
        result["breakdown"] = pool.get("scenarios", [])
        inputs.extend([field("业务池卡数（物理）", pool.get("cards"), "张"),
                       field("业务池卡数（含余量）", pool.get("cards_planned"), "张"),
                       field("等效算力（含余量）", pool.get("capacity_planned_p"), "P，BF16 基准")])
        steps.append(step("汇总场景卡数", "业务池卡数 = Σ 各场景含余量卡数",
                          " + ".join(str(i.get("cards_planned")) for i in pool["items"]) or "暂无可计入项",
                          pool.get("cards_planned"), "张",
                          "卡数按 8 卡最小部署粒度向上对齐，且不少于一个部署单元；余量按方案余量比例在场景层放大一次，池层不再重复。"))
        result["notes"].append("场景高峰按同时发生汇总。展开场景查看显存/Prefill/Decode 三维约束与 SLA 回验；卡数是物理台数，算力是 BF16 基准的折算值（P / T）。")
    else:
        result["items"] = [describe_task(i, originals.get(i["id"], {}), models, pool) for i in pool["items"]]
    if scope == "business":
        result["tree"] = build_business_tree(pool, result, headroom)
    elif scope in ("innovation", "development"):
        result["tree"] = build_pool_tree(scope, pool, result, headroom, D(payload["memory_reserve"]))
    return result
