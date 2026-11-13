// =====================================================================
// 本文件由 tools/gen_golden_eval_engine.mjs 自动生成 —— 请勿手工编辑。
// 来源：frontend/public/inference-eval.html
//   · 「数据块」= 页面 script#1（预设数据：CHIPS/PRECISIONS/ENG_*/SCENARIOS/MODELS…）
//   · 「引擎块」= 页面 script#2（纯函数计算引擎，切换计划阶段 0 提取范围）
// 两块均逐字复制，未改动任何逻辑。页面更新后重跑生成脚本即可同步。
//
// Node ESM 兼容 shim：引擎块在无 require/module 的环境下从 window 取预设数据，
// 这里把 window 指到 globalThis，使数据块的 Object.assign(window, __EXPORTS) 生效。
// =====================================================================
globalThis.window = globalThis;

/* ============ 数据块（inference-eval.html script#1 逐字提取） ============ */
// 场景算力评估器 · 预设数据
// 来源：各厂商公开资料与公开技术文献（模型架构、芯片规格、场景时延目标），经工程经验校准
// 口径：基于理论模型与工程经验估算，非实测数据；验收与投资决策以现场压测为准。
// 归类：场景按计算形态分组，雷同的行业实例已合并到通用项，跨行业通用场景统一归入「通用 · …」。

// 芯片口径（昇腾社区处理器/整机产品页、华为企业业务产品彩页，2026-11 核对）：
//   910 家族按「芯片型号 → 可交付配置」梳理（SKU 结构与 950 一致，逐档来源见页面依据区）：
//     昇腾910B 芯片层有 4 个型号，Cube Core 数分两档（依据 CANN 官方 NPUTargetSpec：910B1/910B2 = 24 Cube、910B3/910B4 = 20 Cube；
//       Vector Core 恒为 2 倍 → 48 / 40）。官方只公布整机与标卡标称，未逐型号公布算力，故这里按**可交付配置**拆卡：
//       910B · 64GB：Atlas 800T A2 训练服务器（8×910B）整机 2.24 PFLOPS ÷ 8 = 280T/卡、64GB HBM、1.6TB/s、HCCS 392GB/s 双向（196 单向）
//       910B · 32GB：Atlas 300T A2 标卡 / Atlas 800I A2（32GB 款）= 280T/卡、32GB HBM、800GB/s、功耗 350W
//       未单列：910B1/910B2 的 24 Cube 高性能档（第三方测算 376 / 414T，主要用于 Atlas 900T A2 液冷集群），
//         官方无逐型号标称，需要时走「自定义算力卡」填 24 Cube 档，避免把未核验数字写进预设。
//     昇腾910C：单款芯片、单配置档，取官网**推理整机**可交付口径 ——
//       Atlas 800I A3（8×昇腾910）整机 4.48 PFLOPS FP16 ÷ 8 = 560T/卡、8×128GB、3.2TB/s、D2D 784GB/s 双向（392 单向）；
//       官网该页只写「昇腾910」，未出现「910C」「560T 版本」字样，也未列单卡 FP32/INT8、die 数与封装形式，
//       故 560T 属「整机算力 ÷ NPU 数」的对应反推；INT8 官方未列，按 910 同代 1:2 口径折算 1120T（非官网标称）。
//       另一路整机口径为 Atlas 800 A3 超节点 6.0 PFLOPS ÷ 8 = 750T，芯片标称 800T（全联接大会 2025），
//       本工具统一取更低、更贴近推理交付的 560T；按超节点/芯片峰值估算时，在自定义卡填 750 / 800 即可。
//   950 系列：芯片层 2 款（950PR / 950DT），官网处理器页按 Cube Core 分为 5 个计算能力档，
//     档位数字一律指 Cube Core（AI 矩阵核）数量，不是 CPU 核/线程数，也不是 Vector 核（Vector = 2×Cube）；
//     本工具把这 5 档做成 5 张可选预设卡（不再用单一「整机标称」代表整条产品线）：
//       PR-32 Cube：FP16 486 / FP8·INT8 919 / MXFP4 1784、128GB@1.6TB/s
//       PR-28 Cube：FP16 425 / FP8·INT8 804 / MXFP4 1561、112GB@1.4TB/s
//       DT-36 Cube：FP16 547 / FP8·INT8 1034 / MXFP4 2007、144GB@4.0TB/s
//       DT-32 Cube：FP16 486 / FP8·INT8 919 / MXFP4 1784、96GB@4.0TB/s
//       DT-28 Cube：FP16 425 / FP8·INT8 804 / MXFP4 1561、96GB@4.0TB/s
//     以上均为「Cube + Vector 总算力」口径（官网同一张规格表另有「仅 Cube」口径，单列见依据区）。
//   已公开整机 / 标卡交叉验证：Atlas 350 标卡（PR-28）= 425/804/1561T、112GB@1.4TB/s、≤600W；
//     Atlas 650E（DT-28）= 425/804/1560T、8×96GB@4.0TB/s、整机 14.5kW；
//     Atlas 850E（DT-32）= 486/919/1784T、8×96GB@4.0TB/s、整机 15.6kW；DT-36 按满配 144GB（950 SuperPoD 口径）。
//   未决口径：白皮书未把 DT 的 36/32/28 Cube 与 144/96GB 逐档绑定，此处按已公开整机配置配对，订货以官方配置表为准；
//     官网处理器页另列 PR 84GB 容量档，未单列 SKU，需要时走「自定义算力卡」。
//   ibw 取芯片级互联单向带宽（灵衢 2TB/s 双向 ÷2）；功耗：910 系列为板卡级公开值，PR 为标卡 ≤600W，
//     DT 按整机功耗折算为工程估算（650E 14.5kW÷8≈1.81kW、850E 15.6kW÷8≈1.95kW，扣 CPU/风扇后 NPU 分摊取 0.90/0.95/1.00）。
var CHIPS = {
  "910b":    {label:"昇腾910B · 64GB",   fam:"910", disp:"FP16 280T", cf_fp16:280, cf_int8:560,  cf_int4:0,    cm:64,  bw:1.6, ibw:196,  powerKW:.30, nativeInt4:false},
  "910b32":  {label:"昇腾910B · 32GB",   fam:"910", disp:"FP16 280T", cf_fp16:280, cf_int8:560,  cf_int4:0,    cm:32,  bw:.8,  ibw:196,  powerKW:.35, nativeInt4:false},
  "910c":    {label:"昇腾910C · 128GB",  fam:"910", disp:"FP16 560T", cf_fp16:560, cf_int8:1120, cf_int4:0,    cm:128, bw:3.2, ibw:392,  powerKW:.60, nativeInt4:false},
  "950pr32": {label:"昇腾950PR · 32 Cube",  fam:"950", disp:"FP16 486T", cf_fp16:486, cf_int8:919,  cf_int4:1784, cm:128, bw:1.6, ibw:1000, powerKW:.60, nativeInt4:true},
  "950pr":   {label:"昇腾950PR · 28 Cube",  fam:"950", disp:"FP16 425T", cf_fp16:425, cf_int8:804,  cf_int4:1561, cm:112, bw:1.4, ibw:1000, powerKW:.60, nativeInt4:true},
  "950dt36": {label:"昇腾950DT · 36 Cube",  fam:"950", disp:"FP16 547T", cf_fp16:547, cf_int8:1034, cf_int4:2007, cm:144, bw:4,   ibw:1000, powerKW:1.00, nativeInt4:true},
  "950dt32": {label:"昇腾950DT · 32 Cube",  fam:"950", disp:"FP16 486T", cf_fp16:486, cf_int8:919,  cf_int4:1784, cm:96,  bw:4,   ibw:1000, powerKW:.95, nativeInt4:true},
  "950dt":   {label:"昇腾950DT · 28 Cube",  fam:"950", disp:"FP16 425T", cf_fp16:425, cf_int8:804,  cf_int4:1560, cm:96,  bw:4,   ibw:1000, powerKW:.90, nativeInt4:true},
};

// 推理量化精度档位：W 权重字节 / A 激活算力档 / KV 字节（自动跟随）
var PRECISIONS = {
  bf16: {label:"BF16 · W16A16",    w:2,   aKey:"cf_fp16", aLabel:"BF16/FP16 峰值", kv:2},
  w8a8: {label:"W8A8 · INT8/FP8",  w:1,   aKey:"cf_int8", aLabel:"INT8/FP8 峰值",  kv:1},
  w4a8: {label:"W4A8 · INT4 权重",  w:.5,  aKey:"cf_int8", aLabel:"INT8 激活峰值",  kv:1, needNativeInt4:true},
};

// 工程开销系数（均衡档 = 参考实现按芯片的经验中位数；档位系数作用于 MFU 与带宽利用率）
//   mfuP：Prefill 有效 MFU（长序列大 GEMM 的实际达峰比例）
//   mfuDRatio：Decode MFU ÷ Prefill MFU —— 910C 的 Prefill MFU 已按「大 GEMM 达峰」标定得较低（0.26），
//     而其 Decode 有效 MFU 约 0.21（小 batch / 带宽受限），故比值抬到 0.80；其余芯片 0.58 / 0.66
var ENG_DEFAULTS = {
  "910b":    {mfuP:.40, mfuDRatio:.58, bwUtilD:.62, kvReserve:1.10, memUtil:.90},
  "910b32":  {mfuP:.40, mfuDRatio:.58, bwUtilD:.62, kvReserve:1.10, memUtil:.90},
  "910c":    {mfuP:.26, mfuDRatio:.80, bwUtilD:.62, kvReserve:1.10, memUtil:.90},
  "950pr32": {mfuP:.40, mfuDRatio:.66, bwUtilD:.70, kvReserve:1.10, memUtil:.90},
  "950pr":   {mfuP:.40, mfuDRatio:.66, bwUtilD:.70, kvReserve:1.10, memUtil:.90},
  "950dt36": {mfuP:.40, mfuDRatio:.66, bwUtilD:.70, kvReserve:1.10, memUtil:.90},
  "950dt32": {mfuP:.40, mfuDRatio:.66, bwUtilD:.70, kvReserve:1.10, memUtil:.90},
  "950dt":   {mfuP:.40, mfuDRatio:.66, bwUtilD:.70, kvReserve:1.10, memUtil:.90},
};

// 工程口径常数（与芯片/档位无关，全站唯一来源：engine 计算与页面「当前生效的工程系数」都读这里）
//   这些量原来以魔法数字散落在 engine.js 里，页面面板看不到，属于「藏在算式里的系数」
var ENG_CONST = {
  prefillBudget: .85,   // Prefill 计算预算占比：吞吐下限 N1 与时延判据各留 15% 余量
  decodeFixedMs: 1.35,  // Decode 每步固定开销（调度 + 内核启动），与分片/批量无关
  rooflineOverlap: .4,  // Decode 步长 = max(带宽时间, 计算时间) + 0.4 × min(…)：两条管线未完全重叠的惩罚
  queueCoef: .5,        // M/G/1 排队近似：TTFT = 服务时间 × (1 + 0.5ρ/(1−ρ))
  moeSkew: 1.08,        // MoE 权重装载偏斜：专家分布不均与对齐填充，按总参 +8% 预留显存
  moeHitInflate: 1.08,  // MoE Decode 专家命中膨胀：每步实际读到的专家略多于理论期望值
};
var TIERS = {conservative:{label:"保守", coef:.8}, standard:{label:"均衡", coef:1.0}, aggressive:{label:"激进", coef:1.2}};

var SCENARIOS = {
  long_agent:{name:"长任务 Agent 对话",promptLen:32768,outputLen:1024,maxCtx:131072,conc:50,ttft:5000,tpot:50,hint:"几十轮工具调用、上下文随轮次累积；输入按累积上下文峰值 32K 估，按同时在跑的 Agent 会话数估并发，KV 按输入+输出一半的连续批均值预留（不写满 128K），TTFT 可放宽。"},
  qa:{name:"短问答 / 智能客服",promptLen:768,outputLen:256,maxCtx:8192,conc:9,ttft:500,tpot:30,hint:"短输入、短输出、时延高敏感（TTFT 500ms）；按在线会话数估并发。门户/APP 问答若 SLA 更宽，可选「短问答对话」或在「调整参数」中放宽 TTFT。"},
  gen_chat:{name:"短问答对话",promptLen:1024,outputLen:512,maxCtx:8192,conc:9,ttft:1000,tpot:45,hint:"门户/APP 通用问答，SLA 比客服略宽；与「短问答 / 智能客服」按 TTFT 目标区分。"},
  wealth:{name:"投顾助手",promptLen:2048,outputLen:768,maxCtx:16384,conc:9,ttft:2000,tpot:55,hint:"持仓解读与产品匹配，按投顾问席位估。"},
  code:{name:"长文生成",promptLen:1024,outputLen:8196,maxCtx:32768,conc:9,ttft:1000,tpot:50,hint:"短输入、长输出。代码、文案、报告都按这一档估。"},
  gen_code:{name:"代码补全",promptLen:2048,outputLen:128,maxCtx:16384,conc:9,ttft:800,tpot:30,hint:"中输入、短输出、时延高敏感。行内补全，只出短片段。"},
  voice_rt:{name:"实时语音 / 智能外呼",promptLen:640,outputLen:100,maxCtx:4096,conc:9,ttft:400,tpot:30,hint:"短输入、极短输出、时延极敏感；实时语音通话与智能外呼话术通用，按同时通话路数估并发。"},
  rag:{name:"知识库 / 领域问答",promptLen:8192,outputLen:1024,maxCtx:32768,conc:100,ttft:3000,tpot:50,hint:"检索段拼入后再生成答复；企业知识库、政策制度/办事指南、医学指南与文献辅助等各行业检索问答通用，首 Token 要求适中。"},
  edu_tutor:{name:"学科辅导",promptLen:2048,outputLen:2048,maxCtx:16384,conc:9,ttft:2500,tpot:55,hint:"题目讲解，输出长于客服、并发更低。"},
  nl2sql:{name:"取数问数",promptLen:3072,outputLen:384,maxCtx:16384,conc:9,ttft:2000,tpot:50,hint:"Schema + 自然语言，输出 SQL 或短解释。"},
  docreview:{name:"长文档审核 / 合规审查",promptLen:24576,outputLen:1536,maxCtx:65536,conc:9,ttft:18000,tpot:85,hint:"超长合同、授信材料、申报材料合规审查通用，Prefill 为主；按审核岗估并发。"},
  gen_summary:{name:"长文档摘要",promptLen:32768,outputLen:1024,maxCtx:65536,conc:9,ttft:20000,tpot:80,hint:"长输入、短输出。报告或卷宗一次送入，TTFT 随窗口变长。"},
  meeting:{name:"会议纪要",promptLen:16384,outputLen:2048,maxCtx:32768,conc:9,ttft:12000,tpot:80,hint:"转写稿整理成议题、决议和待办。"},
  extract:{name:"信息抽取 / 结构化输出",promptLen:4096,outputLen:512,maxCtx:16384,conc:9,ttft:4000,tpot:60,hint:"单据/合同要素抽成 JSON、作业批改评分等结构化输出通用；可批量、TTFT 可放宽。"},
  docwrite:{name:"公文 / 结构化文书",promptLen:4096,outputLen:2048,maxCtx:32768,conc:9,ttft:8000,tpot:75,hint:"模板+要素生成通知函、政务公文、教案方案、SOAP 病历等结构化文书，跨行业通用；输出更长时调高输出长度。"},
  research:{name:"研报长文",promptLen:8192,outputLen:6144,maxCtx:65536,conc:9,ttft:12000,tpot:90,hint:"长素材进、长结构化报告出。"},
  copywrite:{name:"营销内容",promptLen:1024,outputLen:1536,maxCtx:8192,conc:9,ttft:3000,tpot:70,hint:"短 briefing 生成中长文案。"},
  credit:{name:"信贷辅导",promptLen:5120,outputLen:1024,maxCtx:32768,conc:9,ttft:4000,tpot:60,hint:"申贷材料核对与政策解释。"},
  med_qa:{name:"预问诊",promptLen:2048,outputLen:1024,maxCtx:16384,conc:9,ttft:3000,tpot:55,hint:"主诉分诊，时延宽于文本客服。"},
  multiturn:{name:"多轮会话 / 坐席助手",promptLen:3072,outputLen:512,maxCtx:16384,conc:9,ttft:1500,tpot:50,hint:"带多轮历史的助手、坐席 Copilot、热线工单摘要分类通用；输出仍短，并发按在线会话/坐席数估。"},
  gen_translate:{name:"机器翻译",promptLen:3072,outputLen:3072,maxCtx:16384,conc:9,ttft:5000,tpot:70,hint:"段/篇级互译，输入与输出长度接近。"},
  offline:{name:"批量离线",promptLen:2048,outputLen:1024,maxCtx:8192,conc:9,ttft:30000,tpot:150,hint:"夜间跑批/打标，用来估离线池。"},
  agent:{name:"工具调用智能体",promptLen:6144,outputLen:1024,maxCtx:32768,conc:9,ttft:2500,tpot:50,hint:"多步工具调用（上下文 6K 级），按同时在跑的任务数估；几十轮工具调用、上下文持续累积的长任务请选「长任务 Agent 对话」。"},
  think:{name:"深度推理",promptLen:2048,outputLen:8192,maxCtx:32768,conc:500,ttft:8000,tpot:80,hint:"短输入、超长输出。短题目、长思维链，TTFT 可放宽。"},
  long64k:{name:"超长文档",promptLen:65536,outputLen:2048,maxCtx:65536,conc:6,ttft:40000,tpot:90,hint:"超长输入、少并发。年报或长合同一次送入。"},
  long128k:{name:"超长输入128K",promptLen:131072,outputLen:2048,maxCtx:131072,conc:4,ttft:60000,tpot:100,hint:"全书/卷宗拼接，结论作量级参考。"},
  ctx128k:{name:"长上下文128K",promptLen:4096,outputLen:1024,maxCtx:131072,conc:4,ttft:4000,tpot:50,hint:"短问答预留 128K 窗口；KV 按输入+输出一半的连续批均值预留，不是每路写满 128K。"},
  ctx1m:{name:"百万上下文",promptLen:8192,outputLen:2048,maxCtx:1048576,conc:4,ttft:15000,tpot:80,hint:"1M 窗口写入配方；KV 按输入+输出一半的连续批均值预留，不是每路写满 1M。"},
  custom:{name:"自定义业务场景",promptLen:2048,outputLen:2048,maxCtx:4096,conc:9,ttft:2000,tpot:50,hint:"手动填写输入、输出、并发和时延目标。"}
};

// 场景分组（下拉 optgroup 顺序）：按计算形态归类，跨行业通用场景统一放在「通用 · …」；
// 参数与形态雷同的行业实例已并入通用项，仅保留带行业特有口径的场景在「行业专属」。
var SCENARIO_GROUPS = [
  {label:"通用 · 对话与问答", keys:["long_agent","qa","gen_chat","voice_rt","multiturn","rag"]},
  {label:"通用 · 内容生成", keys:["code","gen_code","nl2sql","copywrite","gen_translate","research","docwrite"]},
  {label:"通用 · 文档处理", keys:["gen_summary","meeting","extract","docreview"]},
  {label:"通用 · 智能体与离线", keys:["agent","offline"]},
  {label:"通用 · 推理与超长上下文", keys:["think","long64k","long128k","ctx128k","ctx1m"]},
  {label:"行业专属", keys:["wealth","credit","med_qa","edu_tutor"]},
  {label:"自定义", keys:["custom"]},
];

// 打开页面时预置的场景（按显示顺序）：长上下文 Agent / 检索问答 / 深度推理
// 三者分别代表「长上下文 + 长 KV」「检索拼接的中等负载」「大模型慢思考」三类典型推理形态
var DEFAULT_SCENES = ["long_agent", "rag", "think"];

// 每类场景的推荐默认模型
var SCENARIO_DEFAULT_MODEL = {
  long_agent:"deepseek_v3",
  qa:"glm4_9b",
  gen_chat:"glm4_9b",
  multiturn:"glm4_9b",
  voice_rt:"glm4_9b",
  gen_code:"qwen3_14b",
  nl2sql:"qwen3_14b",
  extract:"glm5_3_flash",
  code:"glm5_3_flash",
  rag:"glm5_3_flash",
  gen_summary:"glm5_3_flash",
  meeting:"glm5_3_flash",
  docwrite:"glm5_3_flash",
  copywrite:"glm5_3_flash",
  gen_translate:"glm5_3_flash",
  research:"glm5_3_flash",
  agent:"glm5_3_flash",
  offline:"glm5_3_flash",
  think:"deepseek_r1",
  wealth:"qwen3_32b",
  credit:"qwen3_32b",
  docreview:"glm5_3_flash",
  med_qa:"qwen3_32b",
  edu_tutor:"qwen3_32b",
  long64k:"glm5_3_flash",
  long128k:"glm5_3_flash",
  ctx128k:"glm5_3_flash",
  ctx1m:"glm5_3_flash",
  custom:"glm5_3_flash",
};

var MODELS = {deepseek_v4_pro:{total:1600,active:49,hid:7168,lay:61,heads:128,kvh:1,experts:384,topK:6,ffn:2.57,headDim:128,kvHeadDim:512,attnSpan:16384},deepseek_v4_flash:{total:284,active:13,hid:4096,lay:43,heads:64,kvh:1,experts:256,topK:6,ffn:2.57,headDim:128,kvHeadDim:512,attnSpan:16384},deepseek_v3:{total:671,active:37,hid:7168,lay:61,heads:128,kvh:128,experts:256,topK:8,latentDim:512,ffn:2.571429,headDim:128,ropeDim:64,qkHeadDim:192,vHeadDim:128},deepseek_r1:{total:671,active:37,hid:7168,lay:61,heads:128,kvh:128,experts:256,topK:8,latentDim:512,ffn:2.571429,headDim:128,ropeDim:64,qkHeadDim:192,vHeadDim:128},qwen38_24t_a95b:{total:2400,active:95,hid:8192,lay:92,heads:64,kvh:4,experts:512,topK:10,gqaKvFraction:.25,ffn:.25,headDim:256},qwen38_27b:{total:27,active:27,hid:5120,lay:64,heads:24,kvh:4,gqaKvFraction:.25,ffn:3.4,headDim:256},qwen36_27b:{total:27,active:27,hid:5120,lay:64,heads:24,kvh:4,gqaKvFraction:.25,ffn:3.4,headDim:256},qwen36_35b_a3b:{total:35,active:3,hid:2048,lay:40,heads:16,kvh:2,experts:256,topK:8,gqaKvFraction:.25,ffn:.25,headDim:256},qwen3_4b:{total:4,active:4,hid:2560,lay:36,heads:32,kvh:8,ffn:3.8,headDim:128},qwen3_8b:{total:8.2,active:8.2,hid:4096,lay:36,heads:32,kvh:8,ffn:3,headDim:128},qwen3_14b:{total:14.8,active:14.8,hid:5120,lay:40,heads:40,kvh:8,ffn:3.4,headDim:128},qwen3_32b:{total:32.8,active:32.8,hid:5120,lay:64,heads:64,kvh:8,ffn:5,headDim:128},qwen25_72b:{total:72.7,active:72.7,hid:8192,lay:80,heads:64,kvh:8,ffn:3.609375,headDim:128},qwen25_32b:{total:32.5,active:32.5,hid:5120,lay:64,heads:40,kvh:8,ffn:5.4,headDim:128},qwen35_27b:{total:27,active:27,hid:5120,lay:64,heads:24,kvh:4,gqaKvFraction:.25,ffn:3.4,headDim:256},qwen3_235b_a22b:{total:235,active:22,hid:4096,lay:94,heads:64,kvh:4,experts:128,topK:8,ffn:.375,headDim:128},qwen35_35b_a3b:{total:35,active:3,hid:2048,lay:40,heads:16,kvh:2,experts:256,topK:8,gqaKvFraction:.25,ffn:.25,headDim:256},qwen35_122:{total:122,active:10,hid:3072,lay:48,heads:32,kvh:2,experts:256,topK:8,gqaKvFraction:.25,ffn:.333333,headDim:256},qwen35_397b_moe:{total:397,active:17,hid:4096,lay:60,heads:32,kvh:2,experts:512,topK:10,gqaKvFraction:.25,ffn:.25,headDim:256},glm5_3:{total:744,active:40,hid:6144,lay:78,heads:64,kvh:64,experts:256,topK:8,latentDim:512,ffn:2,headDim:64,ropeDim:64,qkHeadDim:256,vHeadDim:256,attnSpan:32768},glm5_3_flash:{total:320,active:18,hid:4096,lay:45,heads:64,kvh:64,experts:288,topK:8,latentDim:512,ffn:3,headDim:128,ropeDim:0,qkHeadDim:256,vHeadDim:256,attnSpan:32768},glm5_2:{total:744,active:40,hid:6144,lay:78,heads:64,kvh:64,experts:256,topK:8,latentDim:512,ffn:2,headDim:64,ropeDim:64,qkHeadDim:256,vHeadDim:256,attnSpan:32768},glm4_9b:{total:9.4,active:9.4,hid:4096,lay:40,heads:32,kvh:2,ffn:3.34375,headDim:128},kimi_k3:{total:2780,active:104.2,hid:7168,lay:93,heads:96,kvh:96,experts:896,topK:16,moeLayers:92,latentDim:512,ffn:4.714286,headDim:128,ropeDim:64,qkHeadDim:192,vHeadDim:128,gqaKvFraction:.2580645},kimi_k27:{total:1043,active:32.6,hid:7168,lay:61,heads:64,kvh:64,experts:384,topK:8,latentDim:512,ffn:2.571429,headDim:128,ropeDim:64,qkHeadDim:192,vHeadDim:128},kimi_k26:{total:1043,active:32.6,hid:7168,lay:61,heads:64,kvh:64,experts:384,topK:8,latentDim:512,ffn:2.571429,headDim:128,ropeDim:64,qkHeadDim:192,vHeadDim:128},kimi_k2_5:{total:1043,active:32.6,hid:7168,lay:61,heads:64,kvh:64,experts:384,topK:8,latentDim:512,ffn:2.571429,headDim:128,ropeDim:64,qkHeadDim:192,vHeadDim:128},kimi_k2_thinking:{total:1043,active:32.6,hid:7168,lay:61,heads:64,kvh:64,experts:384,topK:8,latentDim:512,ffn:2.571429,headDim:128,ropeDim:64,qkHeadDim:192,vHeadDim:128},kimi_k2:{total:1043,active:32.6,hid:7168,lay:61,heads:64,kvh:64,experts:384,topK:8,latentDim:512,ffn:2.571429,headDim:128,ropeDim:64,qkHeadDim:192,vHeadDim:128},minimax_m2_7:{total:230,active:10,hid:3072,lay:62,heads:48,kvh:8,experts:256,topK:8,ffn:.5,headDim:128},minimax_m2_5:{total:230,active:10,hid:3072,lay:62,heads:48,kvh:8,experts:256,topK:8,ffn:.5,headDim:128},minimax_m2:{total:230,active:10,hid:3072,lay:62,heads:48,kvh:8,experts:256,topK:8,ffn:.5,headDim:128}};

var MODEL_LABELS = {
  deepseek_v4_pro:"DeepSeek-V4-Pro 1.6T (MoE, A49B, 1M ctx)",
  deepseek_v4_flash:"DeepSeek-V4-Flash 284B (MoE, A13B, 1M ctx)",
  deepseek_v3:"DeepSeek-V3 671B (MoE, A37B)",
  deepseek_r1:"DeepSeek-R1 671B (MoE, A37B)",
  qwen38_24t_a95b:"Qwen3.8-2.4T-A95B (MoE, 262K ctx)",
  qwen38_27b:"Qwen3.8-27B (Dense, 262K ctx)",
  qwen36_27b:"Qwen3.6-27B (Dense, 262K ctx)",
  qwen36_35b_a3b:"Qwen3.6-35B-A3B (MoE, 262K ctx)",
  qwen35_397b_moe:"Qwen3.5-397B-A17B (MoE)",
  qwen35_122:"Qwen3.5-122B-A10B (MoE)",
  qwen35_35b_a3b:"Qwen3.5-35B-A3B (MoE)",
  qwen35_27b:"Qwen3.5-27B (Dense)",
  qwen3_235b_a22b:"Qwen3-235B-A22B (MoE)",
  qwen25_72b:"Qwen2.5-72B (Dense)",
  qwen25_32b:"Qwen2.5-32B (Dense)",
  qwen3_32b:"Qwen3-32B (Dense)",
  qwen3_14b:"Qwen3-14B (Dense)",
  qwen3_8b:"Qwen3-8B (Dense)",
  qwen3_4b:"Qwen3-4B (Dense)",
  glm5_3:"GLM-5.3 744B (MoE, A40B, 1M ctx，结构同 5.2)",
  glm5_3_flash:"GLM-5.3-Flash 320B (MoE, A18B, 1M ctx)",
  glm5_2:"GLM-5.2 744B (MoE, A40B, 1M ctx)",
  glm4_9b:"GLM-4-9B (Dense)",
  kimi_k3:"Kimi K3 2.78T (MoE, A104B, 1M ctx)",
  kimi_k27:"Kimi K2.7 1.04T (MoE, A32.6B, 256K ctx)",
  kimi_k26:"Kimi K2.6 1.04T (MoE, A32.6B, 256K ctx)",
  kimi_k2_5:"Kimi K2.5 1.04T (MoE, A32.6B, 262K ctx)",
  kimi_k2_thinking:"Kimi K2 Thinking 1.04T (MoE, A32.6B, 262K ctx)",
  kimi_k2:"Kimi K2 1.04T (MoE, A32.6B)",
  minimax_m2_7:"MiniMax-M2.7 230B (MoE, A10B)",
  minimax_m2_5:"MiniMax-M2.5 230B (MoE, A10B)",
  minimax_m2:"MiniMax-M2 230B (MoE, A10B)",
};

var MODEL_FAMILY = {
  deepseek_v4_pro:"DeepSeek",
  deepseek_v4_flash:"DeepSeek",
  deepseek_v3:"DeepSeek",
  deepseek_r1:"DeepSeek",
  qwen38_24t_a95b:"Qwen",
  qwen38_27b:"Qwen",
  qwen36_27b:"Qwen",
  qwen36_35b_a3b:"Qwen",
  qwen3_4b:"Qwen",
  qwen3_8b:"Qwen",
  qwen3_14b:"Qwen",
  qwen3_32b:"Qwen",
  qwen25_72b:"Qwen",
  qwen25_32b:"Qwen",
  qwen35_27b:"Qwen",
  qwen3_235b_a22b:"Qwen",
  qwen35_35b_a3b:"Qwen",
  qwen35_122:"Qwen",
  qwen35_397b_moe:"Qwen",
  glm5_3:"智谱 GLM",
  glm5_3_flash:"智谱 GLM",
  glm5_2:"智谱 GLM",
  glm4_9b:"智谱 GLM",
  kimi_k3:"Kimi",
  kimi_k27:"Kimi",
  kimi_k26:"Kimi",
  kimi_k2_5:"Kimi",
  kimi_k2_thinking:"Kimi",
  kimi_k2:"Kimi",
  minimax_m2_7:"MiniMax",
  minimax_m2_5:"MiniMax",
  minimax_m2:"MiniMax",
};

// 兼容 Node 测试与浏览器内联
var __EXPORTS = {CHIPS, PRECISIONS, ENG_DEFAULTS, ENG_CONST, TIERS, SCENARIOS, SCENARIO_GROUPS, SCENARIO_DEFAULT_MODEL, DEFAULT_SCENES, MODELS, MODEL_LABELS, MODEL_FAMILY};
if (typeof module !== "undefined" && module.exports) {
  module.exports = __EXPORTS;
}
if (typeof window !== "undefined") {
  Object.assign(window, __EXPORTS);
}

/* ============ 引擎块（inference-eval.html script#2 逐字提取） ============ */
'use strict';
(function(){
// 场景算力评估器 · 计算引擎（纯函数，无 DOM 依赖）
// 口径（公开文献依据，详见页面底部「估算依据」）：
//   A 显存约束 = max(权重装载, KV 容量)（PagedAttention/vLLM 显存构成口径）
//   B Prefill 约束（TTFT：到达率 × 每 FLOPs + M/G/1 排队近似）；C Decode 约束（TPOT，权重字节 ÷ HBM 带宽下限）
//   单场景卡数 = max(A,B,C) 奇数补偶；汇总 = Σ 各场景，只给算力需求量（不含采购侧冗余）
// 声明：基于理论模型与工程经验估算，非实测数据；验收与投资决策以现场压测为准。

const DATA = (typeof require !== 'undefined' && typeof module !== 'undefined' && module.exports)
  ? require('./data.js')
  : (typeof window !== 'undefined' ? window : {});
const { CHIPS, PRECISIONS, ENG_DEFAULTS, ENG_CONST, TIERS, MODELS } = DATA;

// ---------- 工具 ----------
const ceil = Math.ceil;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ----------
// 工程系数覆盖层（用户在页面上按自身经验调整）
//   · 按芯片系数（mfuP / mfuDRatio / bwUtilD / kvReserve / memUtil）→ 覆盖 ENG_DEFAULTS[chipKey]
//   · 全局常数（prefillBudget / decodeFixedMs / rooflineOverlap / queueCoef / moeSkew）→ 覆盖 ENG_CONST
//   覆盖值按「基准值」语义存放：档位系数仍在其之上缩放，不会被覆盖绕过
// ----------
const CHIP_OV = {};
let CONST_OV = {};

const ENG_RANGES = {
  chip: {
    mfuP:       [.05, .60],   // Prefill MFU
    mfuDRatio:  [.20, 1.50],  // Decode MFU ÷ Prefill MFU
    bwUtilD:    [.30, .95],   // Decode HBM 带宽利用率
    kvReserve:  [1.00, 1.50], // KV 预留系数
    memUtil:    [.50, .95],   // 显存容量利用率
  },
  const: {
    prefillBudget:   [.50, 1.00],
    decodeFixedMs:   [0, 10],
    rooflineOverlap: [0, 1],
    queueCoef:       [0, 2],
    moeSkew:         [1.00, 1.50],
  },
};

// 只接受已知键、有限数值，并按范围夹取（页面与测试共用同一套边界）
function sanitize(patch, ranges) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const k of Object.keys(ranges)) {
    if (patch[k] === undefined || patch[k] === null || patch[k] === '') continue;
    const v = Number(patch[k]);
    if (!Number.isFinite(v)) continue;
    out[k] = clamp(v, ranges[k][0], ranges[k][1]);
  }
  return out;
}

function setChipEng(chipKey, patch) {
  if (!patch || typeof patch !== 'object') return;              // 不传 = 不动
  const clean = sanitize(patch, ENG_RANGES.chip);
  if (!Object.keys(patch).length) { delete CHIP_OV[chipKey]; return; }  // 空对象 = 清除
  if (!Object.keys(clean).length) return;                       // 全是不认识的值 = 不动，别误清已有配置
  CHIP_OV[chipKey] = Object.assign({}, CHIP_OV[chipKey], clean);
}

function setConstEng(patch) {
  if (!patch || typeof patch !== 'object') return;
  const clean = sanitize(patch, ENG_RANGES.const);
  if (!Object.keys(patch).length) { CONST_OV = {}; return; }
  if (!Object.keys(clean).length) return;
  CONST_OV = clean;
}

// 当前生效的基准系数（默认值 + 用户覆盖），页面展示与计算共用
function engOf(chipKey) {
  return Object.assign({}, ENG_DEFAULTS[chipKey], CHIP_OV[chipKey] || {});
}
function constEngOf() {
  return Object.assign({}, ENG_CONST, CONST_OV);
}
function engOverrideOf(chipKey) {
  return { chip: Object.assign({}, CHIP_OV[chipKey] || {}), const: Object.assign({}, CONST_OV) };
}

// ----------
// 档位缩放：只作用于「效率类」系数（峰值达成率），不作用于结构性开销与口径常数。
//   指数 1   = 全额跟随（保守 0.8 / 激进 1.2）
//   指数 0.5 = 半幅跟随：memUtil 里约一半是 CANN runtime / 通信 buffer 的固定占用，
//              不随「调优乐观与否」同比变化，故只跟一半（保守 0.8^0.5≈0.89 → 90%×0.89≈80%）
//   比值 mfuDRatio 恒为 1.0 指数（即不缩放）：Decode MFU = mfuP × ratio，
//              若把比值也乘档位，Decode 会被扣两次（coef²），保守档会掉到 26×0.8×0.8=16.6%→13.3%
// ----------
const TIER_EXP = { mfuP: 1, bwUtilD: 1, memUtil: .5 };

// 档位作用后的「生效系数」——页面展示与计算共用此函数，避免两处各算一套
function engAt(chipKey, tier) {
  const base = engOf(chipKey);
  const t = TIERS[tier || 'standard'];
  const scaled = (k) => clamp(base[k] * Math.pow(t.coef, TIER_EXP[k]),
    ENG_RANGES.chip[k][0], ENG_RANGES.chip[k][1]);
  return {
    mfuP: scaled('mfuP'),
    mfuDRatio: base.mfuDRatio,   // 比值，不缩放
    bwUtilD: scaled('bwUtilD'),
    memUtil: scaled('memUtil'),
    kvReserve: base.kvReserve,   // 结构性开销，不缩放
  };
}
function clearEngOverride(chipKey) {
  delete CHIP_OV[chipKey];
  CONST_OV = {};
}

// MoE 判定：有专家配置即 MoE
const isMoE = (m) => (m.experts || 0) > 0;

// KV 头维：缺省与 Q 头维一致
const kvHeadDimOf = (m) => m.kvHeadDim || m.headDim || 0;

// 有效注意力跨度：attnSpan>0 时对长度折算
const effSpan = (m, seqLen) => (m.attnSpan > 0 ? Math.min(seqLen, m.attnSpan) : seqLen);

// ----------
// KV Cache 每 token 字节数（GB/token）
//   GQA/MHA：2 × 层数 × KV头数 × KV头维 × KV精度字节
//   MLA：    层数 × (低秩维 + rope维) × KV精度字节
//   混合注意力（gqaKvFraction）：再乘全注意力层占比
// ----------
function kvPerTokenGB(m, kvBytes) {
  let g;
  if (m.latentDim) {
    g = m.lay * (m.latentDim + (m.ropeDim || 64)) * kvBytes;
  } else {
    g = 2 * m.lay * (m.kvh || m.heads) * kvHeadDimOf(m) * kvBytes;
  }
  if (m.gqaKvFraction) g *= m.gqaKvFraction;
  return g / 1e9;
}

// 把 GB/tok 形式的科学计数还原成「模型架构参数 × KV 精度字节」的可复核代入式，
// 避免计算过程里出现来源不明的 3.514e-5 之类数字。
function kvSourceNode(m, kvBytes, precLabel) {
  const rope = m.ropeDim || 64;
  const frac = m.gqaKvFraction || 0;
  let bytes, relation, expr, archFields;
  if (m.latentDim) {
    bytes = m.lay * (m.latentDim + rope) * kvBytes;
    relation = 'MLA 低秩压缩：层数 × (低秩维 + RoPE维) × KV精度字节';
    expr = m.lay + ' 层 × (' + m.latentDim + ' 低秩 + ' + rope + ' RoPE) × ' + kvBytes + 'B';
    archFields = '层数、低秩维与 RoPE 维';
  } else {
    bytes = 2 * m.lay * (m.kvh || m.heads) * kvHeadDimOf(m) * kvBytes;
    relation = 'GQA/MHA：2(K+V) × 层数 × KV头数 × KV头维 × KV精度字节';
    expr = '2 × ' + m.lay + ' 层 × ' + (m.kvh || m.heads) + ' KV头 × ' + kvHeadDimOf(m) + ' 头维 × ' + kvBytes + 'B';
    archFields = '层数、KV 头数与头维';
  }
  if (frac) {
    bytes *= frac;
    relation += ' × 全注意力层占比';
    expr += ' × ' + Number(frac.toFixed(3)) + '（全注意力层占比）';
  }
  const kvTokGB = bytes / 1e9;
  return mkNode('每token KV · 来源', relation, expr + ' = ' + Math.round(bytes) + ' B/tok',
    kvTokGB.toExponential(3) + ' GB/tok', {
      note: '以上' + archFields + '取自模型公开架构配置；KV 精度 ' + kvBytes + 'B/元素由「' + (precLabel || '当前量化档') + '」自动跟随（BF16 2B / W8A8、W4A8 1B）。结构与显存口径见底部「延伸阅读」：GQA 2305.13245、DeepSeek-V3 2412.19437、PagedAttention 2309.06180。',
    });
}

// ----------
// 杜邦式逐层拆解：节点 = { label, relation(关系式), expr(代入), value(数值), note(来源), tag, children[] }
//   relation 是「父指标 = 因子 × 因子」的关系，expr 是带具体数字的代入，value 是这一层的结论
//   detail 由节点树深度优先展平得到，保持既有测试与外部消费的口径
// ----------
function mkNode(label, relation, expr, value, opts) {
  const n = { label: label, relation: relation || '', expr: expr || '', value: value || '', note: '', tag: '', highlight: false, children: [] };
  if (opts) {
    if (opts.note) n.note = opts.note;
    if (opts.tag) n.tag = opts.tag;
    if (opts.highlight) n.highlight = true;
    if (opts.children) n.children = opts.children.filter(Boolean);
  }
  return n;
}

function flatten(nodes, out, depth) {
  out = out || [];
  for (const n of nodes) {
    if (!n) continue;
    out.push({
      label: n.label, formula: n.relation, subst: n.expr, result: n.value, note: n.note,
      depth: depth || 0, tag: n.tag || '',
    });
    if (n.children && n.children.length) flatten(n.children, out, (depth || 0) + 1);
  }
  return out;
}

// 混合注意力折算也作用于注意力算力项
const attnFrac = (m) => (m.gqaKvFraction ? m.gqaKvFraction : 1);

// ----------
// 注意力算力宽度（每个 Q 头在 QK / AV 两个矩阵乘里要过的隐藏维）
//   GQA/MHA：头数 × 头维（Q 与 V 同维）
//   MLA：头数 × (QK 头维 + V 头维) ÷ 2 —— KV 侧低秩压缩只压缩缓存，不压缩计算；
//        QK^T 走 qkHeadDim、AV 走 vHeadDim，两者都按「头数 × 头维」计 FLOPs。
//        早期实现误把 MLA 的 latentDim 当成注意力宽度，少乘 40 倍（DeepSeek-V3：latentDim 512 → 实际 20480）
// ----------
function attnWidth(m) {
  if (m.latentDim) {
    const qk = m.qkHeadDim || m.headDim || 0;
    const v = m.vHeadDim || m.headDim || 0;
    return m.heads * ((qk + v) / 2);
  }
  return m.heads * (m.headDim || 0);
}

// ----------
// FFN 有效利用率：小批量下专家/行填不满，矩阵乘效率按 token 规模爬升
//   MoE：每专家平均分到 token 数 = token × TopK ÷ 专家数
//        有效率 = 0.07 + 0.43 × (1 − e^(−每专家token/800))（Prefill 按单请求计，不加批次分散系数）
//        → DeepSeek-V3（256 专家 / TopK 8）在 2K / 8K / 32K 输入下约 0.10 / 0.19 / 0.38
//   Dense：0.42 + 0.58 × (1 − e^(−token/5500))，小 prompt 时 FFN 只跑出四成效率
// ----------
function ffnEff(m, tokens) {
  const tok = Math.max(1, tokens || 1);
  if (isMoE(m)) {
    const experts = Math.max(2, m.experts || 2);
    const topK = Math.max(1, Math.min(m.topK || 8, experts - 1));
    const perExpert = (tok * topK) / experts;
    const fill = 1 - Math.exp(-perExpert / 800);
    return clamp(0.07 + 0.43 * fill, 0.05, 0.7);
  }
  return 0.42 + 0.58 * (1 - Math.exp(-tok / 5500));
}

// ----------
// 权重装载宽度（卡数）：≤8 按 2 的幂（机内 TP），>8 按 8 的倍数（跨机 EP）
// ----------
function alignWeightCards(raw) {
  if (raw <= 1) return 1;
  if (raw <= 2) return 2;
  if (raw <= 4) return 4;
  if (raw <= 8) return 8;
  return ceil(raw / 8) * 8;
}

// ----------
// A 显存约束
//   ① 权重 = 总参×W字节 ×(MoE 1.08 偏斜)   —— 显存装全部专家
//   ② 单卡可用 = 显存 × 容量利用率
//   ③ 权重装载宽度 = ⌈权重/单卡可用⌉ 对齐（TP 2的幂 / 跨机 8倍数）
//   ④ 连续批均长 = 输入 + 输出/2（KV 按均值预留，不按每路写满）
//   ⑤ KV 需求 = 并发 × 均长 × 每token KV × 预留系数(1.1，PagedAttention 块对齐)
//   ⑥ 房间不足加副本；卡数 = 宽度 × max(1, 副本数)
// ----------
function memConstraint(m, scen, chip, prec, eng) {
  const C = constEngOf();
  const skew = isMoE(m) ? C.moeSkew : 1;
  const weightsGB = m.total * prec.w * skew;
  const usableGB = chip.cm * eng.memUtil;
  const rawCards = ceil(weightsGB / usableGB);
  let weightCards = alignWeightCards(rawCards);
  // 权重恰好装满（KV 房间为 0）时提升装载宽度，保证每副本至少留得出 KV 房间
  while (weightCards * usableGB - weightsGB <= 0) {
    weightCards = weightCards <= 8 ? weightCards * 2 : weightCards + 8;
  }
  const tp = Math.min(8, weightCards);
  const kvTokGB = kvPerTokenGB(m, prec.kv);
  const avgLen = scen.promptLen + scen.outputLen / 2;
  const kvNeedGB = scen.conc * avgLen * kvTokGB * eng.kvReserve;
  const roomPerReplica = Math.max(0, weightCards * usableGB - weightsGB);
  const replicas = Math.max(1, kvNeedGB > 0 ? ceil(kvNeedGB / roomPerReplica) : 1);
  const cards = weightCards * replicas;

  const weightsNode = mkNode('模型权重', '总参 × 权重字节 × MoE 偏斜(' + skew + ')',
    m.total + 'B × ' + prec.w + 'B' + (skew !== 1 ? ' × ' + C.moeSkew : ''), weightsGB.toFixed(1) + ' GB');
  const usableNode = mkNode('单卡可用显存', '标称显存 × 容量利用率', chip.cm + 'GB × ' + eng.memUtil, usableGB.toFixed(1) + ' GB');
  const widthNode = mkNode('① 权重装载宽度', '⌈权重 ÷ 单卡可用⌉ → TP 对齐（≤8 取 2 的幂，>8 取 8 的倍数）',
    '⌈' + weightsGB.toFixed(1) + ' ÷ ' + usableGB.toFixed(1) + '⌉ = ' + rawCards + ' → ' + weightCards, weightCards + ' 卡',
    { children: [weightsNode, usableNode] });

  const kvNode = kvSourceNode(m, prec.kv, prec.label);
  const kvNeedNode = mkNode('KV 需求', '并发 × 连续批均长 × 每token KV × 预留系数',
    scen.conc + ' × ' + avgLen + ' × ' + kvTokGB.toExponential(3) + ' × ' + eng.kvReserve, kvNeedGB.toFixed(2) + ' GB', {
      children: [
        kvNode,
        mkNode('并发', '场景输入：同时在生成中的请求数', '—', scen.conc + ' 路'),
        mkNode('连续批均长', '输入 + 输出 ÷ 2（按均值预留，不按每路写满窗口）',
          scen.promptLen + ' + ' + scen.outputLen + ' ÷ 2', avgLen + ' tok'),
      ],
    });
  const replicaNode = mkNode('② 副本数', '⌈KV 需求 ÷ 每副本 KV 房间⌉，至少 1',
    '⌈' + kvNeedGB.toFixed(2) + ' ÷ ' + roomPerReplica.toFixed(1) + '⌉', replicas + ' 副本', {
      children: [
        kvNeedNode,
        mkNode('每副本 KV 房间', '装载宽度 × 单卡可用 − 权重',
          weightCards + ' × ' + usableGB.toFixed(1) + ' − ' + weightsGB.toFixed(1), roomPerReplica.toFixed(1) + ' GB'),
      ],
    });

  const node = mkNode('A · 显存约束', '权重装载宽度 × 副本数（权重 + KV 容量）',
    weightCards + ' × ' + replicas, cards + ' 卡', { children: [widthNode, replicaNode] });

  return { cards, weightCards, tp, replicas, weightsGB, usableGB, kvTokGB, avgLen, kvNeedGB, node, detail: flatten([node]) };
}

// ----------
// B Prefill 约束（TTFT）
//   ① 单请求 FLOPs = 2×激活参×新token ÷ FFN利用率 + 注意力项
//      （显存看总参、算力看激活参：MoE 只计算激活专家；小批量专家填不满，按利用率放大）
//   ② 稳态到达率 λ = 并发 ÷ 请求时长（时长 = TTFT + 输出×TPOT）
//   ③ 吞吐卡数 = λ×单请求FLOPs ÷ 有效算力 ÷ prefillBudget（ENG_CONST.prefillBudget，默认 0.85）
//   ④ 时延卡数：服务时间 = FLOPs÷(N×有效算力) + 引擎固定开销；
//      排队按 M/G/1 近似：TTFT ≈ 服务时间 ×(1 + ρ/(2(1−ρ)))，ρ ≥ 1 视为饱和不可行
//   B = max(吞吐, 时延)
// ----------
function prefillFlopsPerReq(m, scen) {
  const newTok = scen.promptLen;
  const avgSpanRaw = newTok / 2 + 1;
  const avgSpan = effSpan(m, avgSpanRaw);
  const fill = ffnEff(m, newTok);
  const gemm = (2 * m.active * 1e9 * newTok) / fill;
  const attn = 4 * m.lay * attnWidth(m) * newTok * avgSpan * attnFrac(m);
  return { total: gemm + attn, gemm, attn, fill, avgSpan, attnWidth: attnWidth(m) };
}

function prefillConstraint(m, scen, chip, prec, eng) {
  const C = constEngOf();
  const fl = prefillFlopsPerReq(m, scen);
  const flopsPerReq = fl.total;
  const effPerCard = chip[prec.aKey] * 1e12 * eng.mfuP;
  const reqDurS = (scen.ttft + scen.outputLen * scen.tpot) / 1000;
  const lambda = scen.conc / reqDurS;
  const fixedMs = 5 + scen.promptLen / 500;

  const computeMsAt = (n) => flopsPerReq / (n * effPerCard) * 1000;
  const ttftAt = (n) => {
    const computeMs = computeMsAt(n);
    const serviceMs = computeMs + fixedMs;
    const rhoRaw = lambda * computeMs / 1000;
    if (rhoRaw >= 1) return { ttft: Infinity, rho: 1, serviceMs };
    const rho = Math.min(0.95, rhoRaw);
    return { ttft: serviceMs * (1 + (C.queueCoef * rho) / (1 - rho)), rho, serviceMs };
  };

  const N1 = Math.max(1, ceil((lambda * flopsPerReq) / (effPerCard * C.prefillBudget)));
  let N2 = N1;
  for (let n = 1; n <= 1024; n++) {
    if (ttftAt(n).ttft <= scen.ttft * C.prefillBudget) { N2 = n; break; }
  }
  let N2Found = true;
  if (ttftAt(N2).ttft > scen.ttft * C.prefillBudget) N2Found = false;
  const cards = Math.max(N1, N2);
  const at = ttftAt(cards);

  const qFactor = isFinite(at.ttft) ? at.ttft / at.serviceMs : Infinity;

  const gemmNode = mkNode('GEMM 项', '2 × 激活参 × 输入 ÷ FFN 有效利用率',
    '2 × ' + m.active + 'B × ' + scen.promptLen + ' ÷ ' + fl.fill.toFixed(2), (fl.gemm / 1e12).toFixed(2) + ' TFLOP');
  const attnNode = mkNode('注意力项',
    (m.latentDim ? 'MLA：4 × 层数 × 头数 × (QK头维+V头维)/2' : 'GQA/MHA：4 × 层数 × 头数 × 头维')
      + ' × 输入 × 有效跨度',
    '4 × ' + m.lay + ' × ' + Math.round(fl.attnWidth) + ' × ' + scen.promptLen + ' × ' + Math.round(fl.avgSpan),
    (fl.attn / 1e12).toFixed(2) + ' TFLOP',
    m.latentDim ? { note: 'MLA 的低秩压缩只作用在 KV 缓存（' + m.latentDim + ' 维），计算仍按 QK/V 的完整头维走：' + m.heads + ' 头 × (' + (m.qkHeadDim || m.headDim) + ' + ' + (m.vHeadDim || m.headDim) + ') ÷ 2 = ' + Math.round(fl.attnWidth) + '。' } : null);
  const flopsNode = mkNode('单请求 FLOPs', '2×激活参×输入 ÷ FFN利用率 + 4×层×注意力宽×输入×跨度',
    'GEMM + 注意力（见下）', (flopsPerReq / 1e12).toFixed(2) + ' TFLOP', { children: [gemmNode, attnNode] });
  const effNode = mkNode('有效算力/卡', '峰值(' + prec.aLabel + ') × Prefill MFU',
    chip[prec.aKey] + 'T × ' + eng.mfuP.toFixed(2), (effPerCard / 1e12).toFixed(1) + ' TFLOPS');
  const lambdaNode = mkNode('稳态到达率 λ', '并发 ÷ (TTFT 目标 + 输出 × TPOT)',
    scen.conc + ' ÷ ' + reqDurS.toFixed(2) + 's', lambda.toFixed(2) + ' 请求/s');

  const bud = C.prefillBudget;
  const n1Node = mkNode('① 吞吐下限 N1', '⌈λ × 单请求 FLOPs ÷ (有效算力 × ' + bud + ')⌉',
    '⌈' + lambda.toFixed(2) + ' × ' + (flopsPerReq / 1e12).toFixed(2) + 'T ÷ (' + (effPerCard / 1e12).toFixed(1) + 'T × ' + bud + ')⌉',
    N1 + ' 卡', { children: [flopsNode, effNode, lambdaNode] });

  const serviceNode = mkNode('N=' + cards + ' 时服务时间', 'FLOPs ÷ (N × 有效算力) + 引擎固定开销 ' + fixedMs.toFixed(1) + 'ms',
    (flopsPerReq / 1e12).toFixed(0) + 'T ÷ (' + cards + ' × ' + (effPerCard / 1e12).toFixed(1) + 'T) × 1000 + ' + fixedMs.toFixed(1) + 'ms',
    (isFinite(at.serviceMs) ? at.serviceMs.toFixed(1) : '∞') + ' ms');
  const queueNode = mkNode('M/G/1 排队放大', 'TTFT = 服务时间 × (1 + ρ / 2(1−ρ))，ρ = λ × 计算时间',
    'ρ=' + at.rho.toFixed(2) + ' → ×' + (isFinite(qFactor) ? qFactor.toFixed(2) : '∞'),
    isFinite(at.ttft) ? at.ttft.toFixed(1) + ' ms' : '饱和不可行');
  const n2Node = mkNode('② 时延下限 N2', '枚举 N：TTFT(N) ≤ TTFT 目标 × ' + bud,
    '目标 ' + (scen.ttft * bud).toFixed(0) + 'ms', (N2Found ? N2 : '不可达') + ' 卡',
    { children: [serviceNode, queueNode] });

  const node = mkNode('B · Prefill 约束', 'max(吞吐下限 N1, 时延下限 N2)',
    'max(' + N1 + ', ' + N2 + ')', cards + ' 卡', { children: [n1Node, n2Node] });

  return { cards, flopsPerReq, lambda, serviceMs: at.serviceMs, ttftPredMs: at.ttft, ttftOk: N2Found, node, detail: flatten([node]) };
}

// ----------
// C Decode 约束（TPOT，带宽游戏）
//   ① 每步每卡读取 = 权重分片 + 批量 KV 读取（Decode 每步都要把激活权重读一遍显存）
//      MoE：路由专家只读「命中」部分：hit = (1−(1−TopK/专家数)^批) × moeHitInflate
//           非专家部分（注意力/共享专家）占比 ≈ 1 − (2×层×hid² + Dense前3层FFN)/总参
//   ② 步长 = max(计算时间, 带宽时间) + rooflineOverlap×min项（默认 0.4，两条管线未完全重叠的惩罚）
//            + TP AllReduce 通信 + decodeFixedMs 调度固定开销（默认 1.35ms）
//   ③ 理论下限 = 最宽分片 + 最小批的权重读取 ÷ 带宽 + 调度 —— TPOT 低于此值才加卡无效
//   ④ 枚举 分片宽度×副本数，在「步长 ≤ TPOT」的组合里取卡数最小；都压不到时退化为最小卡数并告警
//      分片：≤8 机内 TP，并发 ≥64 放开到 16、≥256 放开到 32（超节点/跨机），权重装不下时按对齐卡数补
//      副本：1 ~ clamp(并发/8, 16, 256) —— 固定 16 会让万级并发无解
// ----------
function decodeConstraint(m, scen, chip, prec, eng) {
  const C = constEngOf();
  const usableGB = chip.cm * eng.memUtil;
  const skew = isMoE(m) ? C.moeSkew : 1;
  const weightsGB = m.total * prec.w * skew;
  const rawCards = ceil(weightsGB / usableGB);
  const alignedCards = alignWeightCards(rawCards);

  // 候选分片宽度：默认到机内 8 卡，并发大到需要多副本时才放开到 16 / 32（超节点或跨机 TP）
  // 分片越宽跨机通信越贵，小并发没必要动它；放开上限也给「带宽理论下限」一个合理的最宽口径
  const shardCap = scen.conc >= 256 ? 32 : (scen.conc >= 64 ? 16 : 8);
  const shards = [];
  for (const s of [1, 2, 4, 8, 16, 32]) if (s <= shardCap && s * usableGB >= weightsGB) shards.push(s);
  // 权重装不下时必须补到「权重对齐卡数」及其 2 倍，否则无解
  if (!shards.includes(alignedCards)) shards.push(alignedCards);
  if (!shards.includes(alignedCards * 2)) shards.push(alignedCards * 2);
  shards.sort((a, b) => a - b);

  const kvTokGB = kvPerTokenGB(m, prec.kv);
  const avgLen = scen.promptLen + scen.outputLen / 2;
  const attnSpanEff = effSpan(m, avgLen);

  // MoE 专家命中折算
  let routedFrac = 0;
  if (isMoE(m)) {
    const nonExpert = (2 * m.lay * m.hid * m.hid + 3 * Math.min(m.lay, 3) * (m.ffn || 1) * m.hid * m.hid) / 1e9;
    routedFrac = clamp(1 - nonExpert / m.total, 0.05, 0.99);
  }
  const hitFracOf = (batch) => (isMoE(m) ? Math.min(1, (1 - Math.pow(1 - (m.topK || 8) / m.experts, batch)) * C.moeHitInflate) : 1);

  const bwGBs = chip.bw * 1000 * eng.bwUtilD; // GB/s（含带宽利用率）
  const mfuD = eng.mfuP * eng.mfuDRatio;
  const effPerCard = chip[prec.aKey] * 1e12 * mfuD;

  const stepMsAt = (shard, rep) => {
    const batch = Math.max(1, ceil(scen.conc / rep));
    const hit = hitFracOf(batch);
    const readWeights = isMoE(m)
      ? ((1 - routedFrac) + hit * routedFrac) * weightsGB
      : weightsGB;
    const readPerCard = readWeights / shard + (batch * avgLen * kvTokGB) / shard;
    const bwMs = readPerCard / bwGBs * 1000;
    const attnFlops = 4 * m.lay * attnWidth(m) * attnSpanEff * batch * attnFrac(m);
    const flopsPerCard = (2 * m.active * 1e9 * batch + attnFlops) / shard;
    const computeMs = flopsPerCard / effPerCard * 1000;
    const commMs = (2 * m.lay * batch * m.hid * 2) / (chip.ibw * 1e9 * Math.min(shard, 8)) * 1000;
    const stepMs = Math.max(bwMs, computeMs) + C.rooflineOverlap * Math.min(bwMs, computeMs) + commMs + C.decodeFixedMs;
    return { shard, rep, batch, hit, readPerCard, bwMs, computeMs, commMs, stepMs, cards: shard * rep };
  };

  // 副本数上限：按并发推导（每副本至少 8 路批），下限 16、上限 256
  // 固定 16 会让大并发场景无解（并发 10000 时需要 500+ 卡），只能给出兜底的错误结论
  const repMax = clamp(Math.ceil(scen.conc / 8), 16, 256);

  // 搜索满足 TPOT 的最小卡数：在「达标」的组合里取卡数最小（同卡数取步长更短）
  // 注意：加副本会让 batch 变小、步长变短但总卡数上升，所以"最小卡数"和"达标"是两件事。
  // 早期实现只在「卡数更小」时更新 best，导致已找到的达标组合被丢弃、返回不达标的最小卡数，
  // 进而误报「带宽下限加卡无效」（并发 100 的场景踩过），这里把两个口径分开。
  let bestOk = null;   // 达标组合中的最优解 → 真正要返回的卡数
  let bestAny = null;  // 无解时的最小卡数组合 → 兜底展示
  const better = (cur, s) => !cur || s.cards < cur.cards || (s.cards === cur.cards && s.stepMs < cur.stepMs);
  for (const shard of shards) {
    for (let rep = 1; rep <= repMax; rep++) {
      const s = stepMsAt(shard, rep);
      if (better(bestAny, s)) bestAny = s;
      if (s.stepMs <= scen.tpot) {
        if (better(bestOk, s)) bestOk = s;
        break; // 同一分片下副本再大只会更费卡，本分片的最优已拿到
      }
    }
  }
  const best = bestOk || bestAny;
  // 枚举上限（最宽分片 × 最大副本）的步长：无解时用它告诉用户"最多能到多少"
  const effort = stepMsAt(shards[shards.length - 1], repMax);

  // 带宽理论下限：最宽分片 + 最小批（副本拉满）下的权重读取
  // 必须用最小批而非当前并发——加副本正是靠"batch 变小 → 命中专家变少"来摊薄每卡读取，
  // 用当前并发的命中率会把这个收益算没，反而把可达的目标误判成"加卡无效"
  const widestShard = shards[shards.length - 1];
  const minBatch = Math.max(1, Math.ceil(scen.conc / repMax));
  const floorRead = (isMoE(m) ? ((1 - routedFrac) + hitFracOf(minBatch) * routedFrac) * weightsGB : weightsGB) / widestShard;
  const floorMs = floorRead / bwGBs * 1000 + C.decodeFixedMs;
  const bandLimited = scen.tpot < floorMs;
  const tpotShort = !bestOk; // 分片 ≤ 最宽档、副本 ≤ repMax 的枚举范围内压不到目标

  const s = best;
  const readWeightsPerCard = isMoE(m)
    ? ((1 - routedFrac) + s.hit * routedFrac) * weightsGB / s.shard
    : weightsGB / s.shard;
  const readKvPerCard = (s.batch * avgLen * kvTokGB) / s.shard;

  const readNode = mkNode('每步每卡读取', (isMoE(m) ? '(非专家 + 命中 × 路由) × 权重 ÷ 分片' : '权重 ÷ 分片') + ' + 批量 KV ÷ 分片',
    readWeightsPerCard.toFixed(1) + ' + ' + readKvPerCard.toFixed(2), s.readPerCard.toFixed(1) + ' GB', {
      note: isMoE(m) ? 'MoE 每步只读命中专家 ≈ ' + (s.hit * 100).toFixed(0) + '%（批 ' + s.batch + '），非专家部分常驻读取' : 'Dense 模型每步读全量权重',
      children: [
        mkNode('权重读取（分片后）', isMoE(m) ? '(非专家 + 命中×路由) × 权重 ÷ 分片' : '权重 ÷ 分片',
          weightsGB.toFixed(1) + 'GB' + (isMoE(m) ? ' × 命中折算' : '') + ' ÷ ' + s.shard, readWeightsPerCard.toFixed(1) + ' GB'),
        mkNode('批量 KV 读取', '批 × 均长 × 每token KV ÷ 分片',
          s.batch + ' × ' + avgLen + ' × ' + kvTokGB.toExponential(3) + ' ÷ ' + s.shard, readKvPerCard.toFixed(2) + ' GB'),
      ],
    });
  const bwNode = mkNode('带宽时间', '读取 ÷ (HBM 带宽 × 利用率)',
    s.readPerCard.toFixed(1) + 'GB ÷ (' + chip.bw + 'TB/s × ' + eng.bwUtilD + ')', s.bwMs.toFixed(1) + ' ms');
  const computeNode = mkNode('计算时间', 'FLOPs/步 ÷ 分片 ÷ (峰值 × Decode MFU)',
    '2 × ' + m.active + 'B × 批 ' + s.batch + ' ÷ ' + s.shard + ' ÷ (' + chip[prec.aKey] + 'T × ' + mfuD.toFixed(3) + ')',
    s.computeMs.toFixed(2) + ' ms');
  const commNode = mkNode('通信开销', 'TP AllReduce 量 ÷ 互联带宽（分片 ≤8 内）',
    '2 × ' + m.lay + ' 层 × ' + s.batch + ' × ' + m.hid + ' × 2B ÷ ' + chip.ibw + 'GB/s',
    (s.commMs < 0.01 ? s.commMs.toFixed(3) : s.commMs.toFixed(2)) + ' ms');

  const stepNode = mkNode('① 单步步长', 'max(带宽, 计算) + ' + C.rooflineOverlap + ' × min + 通信 + 调度 ' + C.decodeFixedMs + 'ms',
    'max(' + s.bwMs.toFixed(1) + ', ' + s.computeMs.toFixed(2) + ') + ' + C.rooflineOverlap + ' × min + ' + s.commMs.toFixed(2) + ' + ' + C.decodeFixedMs,
    s.stepMs.toFixed(1) + ' ms（目标 ' + scen.tpot + ' ms）', { children: [readNode, bwNode, computeNode, commNode] });
  const floorNode = mkNode('② 带宽理论下限', '最宽分片时权重读取 ÷ 带宽 + 调度 ' + C.decodeFixedMs + 'ms',
    floorMs.toFixed(1) + ' ms（最宽 ' + widestShard + ' 卡分片）',
    bandLimited ? '目标低于下限，加卡无效'
      : (tpotShort ? '枚举上限 ' + effort.cards + ' 卡时 ' + effort.stepMs.toFixed(1) + 'ms，仍高于目标' : '目标 ' + scen.tpot + 'ms 可达'));

  const node = mkNode('C · Decode 约束', '枚举 分片宽度 × 副本数，取满足 TPOT 的最小总卡数',
    '分片 ' + s.shard + ' 卡 × 副本 ' + s.rep + '（批 ' + s.batch + '）', s.cards + ' 卡', { children: [stepNode, floorNode] });

  return {
    cards: s.cards, shard: s.shard, replicas: s.rep, batch: s.batch, stepMs: s.stepMs,
    floorMs, bandLimited, tpotShort, tpotReached: !!bestOk,
    effortCards: effort.cards, effortMs: effort.stepMs, effortShard: widestShard, repMax,
    node, detail: flatten([node]),
  };
}

// ----------
// 单场景合成：卡数 = max(A,B,C)，奇数补偶；瓶颈 = 主导约束
// ----------
const BOTTLENECK_LABEL = { mem: '显存', prefill: 'Prefill', decode: 'Decode' };

function evaluate(scenCfg, globCfg) {
  const { modelKey, scen } = scenCfg;
  const { chipKey, precKey, tier } = globCfg;
  const m = MODELS[modelKey];
  const chip = CHIPS[chipKey];
  const prec = PRECISIONS[precKey];
  if (!m) throw new Error('未知模型：' + modelKey);
  if (!chip) throw new Error('未知芯片：' + chipKey);
  if (!prec) throw new Error('未知精度：' + precKey);
  if (prec.needNativeInt4 && !chip.nativeInt4) {
    throw new Error('该芯片无 INT4 峰值，不支持 W4A8（INT4 权重）精度，请选择 950 系列或改用 W8A8');
  }
  const eng = engAt(chipKey, tier);

  const A = memConstraint(m, scen, chip, prec, eng);
  const B = prefillConstraint(m, scen, chip, prec, eng);
  const C = decodeConstraint(m, scen, chip, prec, eng);

  const raw = Math.max(A.cards, B.cards, C.cards);
  const cards = raw % 2 === 1 ? raw + 1 : raw;
  // 瓶颈判定：取 max 维；并列按 显存 > Decode > Prefill
  let bottleneck;
  if (A.cards >= B.cards && A.cards >= C.cards) bottleneck = 'mem';
  else if (C.cards >= B.cards) bottleneck = 'decode';
  else bottleneck = 'prefill';

  // 杜邦式树：顶层「所需算力卡」= max(A,B,C) → 奇数补偶；三条约束各自逐层拆到原始参数
  const bottleneckNode = bottleneck === 'mem' ? A.node : bottleneck === 'decode' ? C.node : B.node;
  bottleneckNode.highlight = true;
  const tree = mkNode('所需算力卡 N', 'max(A 显存, B Prefill, C Decode) → 奇数补偶',
    'max(' + A.cards + ', ' + B.cards + ', ' + C.cards + ') = ' + raw + (cards !== raw ? ' → 补偶 ' + cards : ''),
    cards + ' 卡', { tag: '总计', children: [A.node, B.node, C.node] });

  const warnings = [];
  if (scen.promptLen > 65536) warnings.push({ type: 'longInput', msg: '输入长度 >64K：长序列估算误差放大，结论仅作量级参考' });
  if (scen.outputLen > 16384) warnings.push({ type: 'longOutput', msg: '输出长度 >16K：长输出估算误差放大，结论仅作量级参考' });
  if (A.weightCards > 8) warnings.push({ type: 'crossNode', msg: '模型权重超过单机 8 卡，需跨机部署（EP/PP），互联开销已按简化口径计入' });
  if (C.bandLimited) warnings.push({ type: 'bandLimited', msg: 'TPOT 目标低于芯片显存带宽理论下限（约 ' + C.floorMs.toFixed(0) + 'ms），加卡无效：建议放宽目标、换更高带宽芯片或换更小模型' });
  else if (C.tpotShort) warnings.push({
    type: 'tpotShort',
    msg: '当前并发下压不到 TPOT 目标：枚举上限 ' + C.effortCards + ' 卡（分片 ' + C.effortShard + ' × 副本 ' + C.repMax + '）时步长仍约 '
      + C.effortMs.toFixed(0) + 'ms，高于目标 ' + scen.tpot + 'ms。建议放宽 TPOT、减少并发，或换更高带宽 / 更大显存芯片',
  });
  if (!B.ttftOk) warnings.push({ type: 'ttft', msg: 'TTFT 目标在高负载下不可达，建议降低并发或放宽首 Token 目标' });

  return {
    cards, rawCards: raw, bottleneck,
    bottleneckLabel: BOTTLENECK_LABEL[bottleneck],
    a: A.cards, b: B.cards, c: C.cards,
    parts: { A, B, C },
    tree,
    eng, warnings,
    modelKey, chipKey, precKey, tier: tier || 'standard',
    scen: { ...scen },
  };
}

// ----------
// 汇总：按芯片分组小计 + 按模型归类明细 + 服务器台数 / 功耗
//   只给「算力需求量」：故障冗余、业务突发等采购侧余量不在本工具内处理，
//   需要时由使用方按 SLA 在需求量之上另行加余量（N+1 或比例）。
//   台数按芯片组各自 8 卡/台折算（不同芯片不混机）。
// ----------
function aggregate(results) {
  const byChipMap = new Map();
  const byModelMap = new Map();
  const bottleneckDist = { mem: 0, prefill: 0, decode: 0 };

  for (const r of results) {
    const chip = CHIPS[r.chipKey];
    if (!byChipMap.has(r.chipKey)) byChipMap.set(r.chipKey, { chipKey: r.chipKey, chipLabel: chip ? chip.label : r.chipKey, cards: 0 });
    byChipMap.get(r.chipKey).cards += r.cards;
    if (!byModelMap.has(r.modelKey)) byModelMap.set(r.modelKey, { modelKey: r.modelKey, modelName: r.modelName || r.modelKey, chips: {}, conc: 0, cards: 0, bottleneck: r.bottleneck });
    const mm = byModelMap.get(r.modelKey);
    if (!mm.chips[r.chipKey]) mm.chips[r.chipKey] = 0;
    mm.chips[r.chipKey] += r.cards;
    mm.conc += r.scen ? r.scen.conc : (r.conc || 0);
    mm.cards += r.cards;
    bottleneckDist[r.bottleneck] = (bottleneckDist[r.bottleneck] || 0) + 1;
  }

  const byChip = [...byChipMap.values()].map(g => {
    const chip = CHIPS[g.chipKey];
    const p = chip ? chip.powerKW : 0;
    return {
      ...g,
      powerKW: g.cards * p,
      servers: ceil(g.cards / 8),
    };
  });
  const sum = (k) => byChip.reduce((a, g) => a + g[k], 0);

  const byModel = [...byModelMap.values()].sort((x, y) => y.cards - x.cards);

  return {
    totalCards: sum('cards'),
    byChip,
    byModel,
    servers: sum('servers'),
    powerKW: sum('powerKW'),
    bottleneckDist,
  };
}

// ----------
// 自定义算力卡：把用户填写的规格注册进预设表，A/B/C 计算链路与汇总逻辑零改动
//   CHIPS / ENG_DEFAULTS 为对象引用，注册后 evaluate / aggregate 立即可见
//   INT4 峰值填 0 表示不支持 W4A8
// ----------
const CUSTOM_ENG_BASE = { mfuP: 0.38, mfuDRatio: 0.62, bwUtilD: 0.66, kvReserve: 1.10, memUtil: 0.90 };

function registerCustomChip(key, spec) {
  if (!key || typeof key !== 'string') throw new Error('自定义算力卡标识无效');
  if (!spec || typeof spec !== 'object') throw new Error('自定义算力卡规格无效');
  const num = (v, name, allowZero) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || (!allowZero && n <= 0)) {
      throw new Error(name + ' 需为' + (allowZero ? '非负' : '正') + '数值');
    }
    return n;
  };
  const cfInt4 = num(spec.cf_int4 === undefined ? 0 : spec.cf_int4, 'INT4 峰值', true);
  const chip = {
    label: (String(spec.label === undefined ? '' : spec.label).trim() || '自定义算力卡').slice(0, 24),
    cf_fp16: num(spec.cf_fp16, 'BF16/FP16 峰值'),
    cf_int8: num(spec.cf_int8, 'INT8/FP8 峰值'),
    cf_int4: cfInt4,
    cm: num(spec.cm, '显存容量'),
    bw: num(spec.bw, 'HBM 带宽'),
    ibw: num(spec.ibw, '互联带宽'),
    powerKW: num(spec.powerKW, '单卡功耗'),
    nativeInt4: cfInt4 > 0,
    custom: true,
  };
  CHIPS[key] = chip;
  ENG_DEFAULTS[key] = { ...CUSTOM_ENG_BASE, ...(spec.eng || {}) };
  return chip;
}

// 兼容浏览器内联
const ENGINE = { kvPerTokenGB, memConstraint, prefillConstraint, decodeConstraint, evaluate, aggregate, registerCustomChip, attnWidth, ffnEff, prefillFlopsPerReq, BOTTLENECK_LABEL, ENG_CONST, ENG_RANGES, TIER_EXP, setChipEng, setConstEng, engOf, engAt, constEngOf, engOverrideOf, clearEngOverride };
if (typeof module !== 'undefined' && module.exports) module.exports = ENGINE;
if (typeof window !== 'undefined') window.ENGINE = ENGINE;

})();

/* ============ ESM 导出（用 as 别名，避免与数据块的 var 声明重名） ============ */
const __EXPORTS_OUT = {
  CHIPS: globalThis.CHIPS,
  PRECISIONS: globalThis.PRECISIONS,
  ENG_DEFAULTS: globalThis.ENG_DEFAULTS,
  ENG_CONST: globalThis.ENG_CONST,
  TIERS: globalThis.TIERS,
  SCENARIOS: globalThis.SCENARIOS,
  SCENARIO_GROUPS: globalThis.SCENARIO_GROUPS,
  SCENARIO_DEFAULT_MODEL: globalThis.SCENARIO_DEFAULT_MODEL,
  DEFAULT_SCENES: globalThis.DEFAULT_SCENES,
  MODELS: globalThis.MODELS,
  MODEL_LABELS: globalThis.MODEL_LABELS,
  MODEL_FAMILY: globalThis.MODEL_FAMILY,
  ENGINE: globalThis.ENGINE,
};
export {
  __EXPORTS_OUT as exports,
};
