#!/usr/bin/env node
// =====================================================================
// 阶段 0 · 黄金值基准生成脚本（切换计划：推理评估逻辑统一 v2.0）
//
// 用法（在仓库根目录执行）：
//   node tools/gen_golden_eval_engine.mjs
//
// 做两件事：
//   1) 从 frontend/public/inference-eval.html 逐字提取「数据块 + 引擎块」，
//      生成 tools/eval_engine.mjs（不改任何逻辑；页面改动后重跑本脚本即可同步）。
//   2) 批量执行三类用例，输出黄金值 backend/tests/golden_eval_engine.json：
//        a) 32 模型 × 8 芯片全遍历（精度 bf16/w8a8 全覆盖，w4a8 仅 nativeInt4 芯片）
//        b) 29 场景 × 3 精度 × 3 档位抽样（芯片固定 950dt36，覆盖全精度）
//        c) 边界用例：bandLimited / 跨机 / TTFT 不可达 / 奇数补偶
//
// 黄金值比对口径（供 Python 移植验收，见 docs/切换计划-推理评估逻辑统一-v2.0.md 阶段 0）：
//   A 维精确一致；B/C 卡数一致；时延中间量允许 1e-6 相对误差。
// 本脚本不含任何计算逻辑改写——所有数值均由页面引擎原函数产出。
// =====================================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML_PATH = path.join(ROOT, 'frontend', 'public', 'inference-eval.html');
const ENGINE_MJS_PATH = path.join(ROOT, 'tools', 'eval_engine.mjs');
const GOLDEN_PATH = path.join(ROOT, 'backend', 'tests', 'golden_eval_engine.json');

// ---------- 第 1 步：从页面逐字提取数据块与引擎块 ----------
const html = readFileSync(HTML_PATH, 'utf8');
const blocks = [];
const scriptRe = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = scriptRe.exec(html)) !== null) blocks.push(m[1]);

const dataBlock = blocks.find((b) => b.includes('var CHIPS = {'));
const engBlock = blocks.find((b) => b.includes('function evaluate(') && b.includes('function aggregate('));
if (!dataBlock) throw new Error('未在页面中找到数据块（var CHIPS = { ...）');
if (!engBlock) throw new Error('未在页面中找到引擎块（function evaluate / function aggregate）');

const engineMjs = `// =====================================================================
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
${dataBlock.trim()}

/* ============ 引擎块（inference-eval.html script#2 逐字提取） ============ */
${engBlock.trim()}

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
`;
writeFileSync(ENGINE_MJS_PATH, engineMjs, 'utf8');

// ---------- 第 2 步：加载提取出的引擎，批量生成黄金值 ----------
const { CHIPS, PRECISIONS, ENG_DEFAULTS, ENG_CONST, TIERS, SCENARIOS, SCENARIO_DEFAULT_MODEL, MODELS, ENGINE } = (await import(
  'file://' + ENGINE_MJS_PATH.replace(/\\/g, '/')
)).exports;
const { evaluate, aggregate } = ENGINE;

// 目录完整性硬校验：与切换计划口径一致（8 芯片 / 32 模型 / 29 场景）
if (Object.keys(CHIPS).length !== 8) throw new Error('芯片数不是 8：' + Object.keys(CHIPS).length);
if (Object.keys(MODELS).length !== 32) throw new Error('模型数不是 32：' + Object.keys(MODELS).length);
if (Object.keys(SCENARIOS).length !== 29) throw new Error('场景数不是 29：' + Object.keys(SCENARIOS).length);

// JSON 序列化辅助：非有限数（Infinity/-Infinity/NaN）转为字符串，避免 JSON 静默变 null
const num = (v) => (Number.isFinite(v) ? v : String(v));
const scenOf = (s) => ({ conc: s.conc, promptLen: s.promptLen, outputLen: s.outputLen, ttft: s.ttft, tpot: s.tpot });

function runCase(id, kind, modelKey, chipKey, precKey, tier, scen) {
  const r = evaluate({ modelKey, scen }, { chipKey, precKey, tier });
  return {
    id,
    kind,
    modelKey,
    chipKey,
    precKey,
    tier,
    scen: scenOf(scen),
    out: {
      rawCards: r.rawCards,
      cards: r.cards,
      bottleneck: r.bottleneck,
      a: r.a,
      b: r.b,
      c: r.c,
      servers: Math.ceil(r.cards / 8),
      warnings: r.warnings.map((w) => ({ type: w.type, msg: w.msg })),
      A: {
        cards: r.parts.A.cards,
        weightCards: r.parts.A.weightCards,
        tp: r.parts.A.tp,
        replicas: r.parts.A.replicas,
        weightsGB: num(r.parts.A.weightsGB),
        usableGB: num(r.parts.A.usableGB),
        kvTokGB: num(r.parts.A.kvTokGB),
        avgLen: num(r.parts.A.avgLen),
        kvNeedGB: num(r.parts.A.kvNeedGB),
      },
      B: {
        cards: r.parts.B.cards,
        flopsPerReq: num(r.parts.B.flopsPerReq),
        lambda: num(r.parts.B.lambda),
        serviceMs: num(r.parts.B.serviceMs),
        ttftPredMs: num(r.parts.B.ttftPredMs),
        ttftOk: r.parts.B.ttftOk,
      },
      C: {
        cards: r.parts.C.cards,
        shard: r.parts.C.shard,
        replicas: r.parts.C.replicas,
        batch: r.parts.C.batch,
        stepMs: num(r.parts.C.stepMs),
        floorMs: num(r.parts.C.floorMs),
        bandLimited: r.parts.C.bandLimited,
        tpotShort: r.parts.C.tpotShort,
        tpotReached: r.parts.C.tpotReached,
        effortCards: r.parts.C.effortCards,
        effortMs: num(r.parts.C.effortMs),
        effortShard: r.parts.C.effortShard,
        repMax: r.parts.C.repMax,
      },
    },
  };
}

const cases = [];

// ---------- 2a) 32 模型 × 8 芯片全遍历（档位固定 standard） ----------
// 场景取「该模型的默认场景档」（SCENARIO_DEFAULT_MODEL 反查）；无默认场景的模型回落 rag。
const PREC_ALL = ['bf16', 'w8a8', 'w4a8'];
for (const modelKey of Object.keys(MODELS)) {
  const scenKey = Object.keys(SCENARIO_DEFAULT_MODEL).find((k) => SCENARIO_DEFAULT_MODEL[k] === modelKey) || 'rag';
  const scen = SCENARIOS[scenKey];
  for (const chipKey of Object.keys(CHIPS)) {
    for (const precKey of PREC_ALL) {
      if (precKey === 'w4a8' && !CHIPS[chipKey].nativeInt4) continue; // 页面同口径：无 INT4 峰值芯片不支持 W4A8
      cases.push(runCase(`m_${modelKey}__c_${chipKey}__p_${precKey}`, 'model_chip_matrix', modelKey, chipKey, precKey, 'standard', scen));
    }
  }
}

// ---------- 2b) 29 场景 × 3 精度 × 3 档位抽样（芯片固定 950dt36：nativeInt4，三精度均可跑） ----------
const SAMPLE_CHIP = '950dt36';
const SAMPLE_TIERS = ['conservative', 'standard', 'aggressive'];
const part2Results = [];
for (const scenKey of Object.keys(SCENARIOS)) {
  const scen = SCENARIOS[scenKey];
  const modelKey = SCENARIO_DEFAULT_MODEL[scenKey];
  for (const tier of SAMPLE_TIERS) {
    for (const precKey of PREC_ALL) {
      const rec = runCase(`s_${scenKey}__p_${precKey}__t_${tier}`, 'scene_tier_matrix', modelKey, SAMPLE_CHIP, precKey, tier, scen);
      cases.push(rec);
      if (tier === 'standard' && precKey === 'bf16') part2Results.push(rec.out);
    }
  }
}

// ---------- 2c) 边界用例（显式构造，生成时自校验触发了目标告警/形态） ----------
const boundaryDefs = [
  {
    id: 'boundary_band_limited',
    note: 'Dense 模型（每步读全量权重）TPOT 目标低于带宽理论下限 → bandLimited 告警（加卡无效）',
    modelKey: 'qwen25_72b', chipKey: '910b32', precKey: 'bf16', tier: 'standard',
    scen: { conc: 8, promptLen: 1024, outputLen: 128, ttft: 2000, tpot: 5 },
    check: (o) => o.warnings.some((w) => w.type === 'bandLimited') && o.C.bandLimited === true,
  },
  {
    id: 'boundary_cross_node',
    note: '权重超过单机 8 卡需跨机部署 → crossNode 告警（TPOT 可达，非 bandLimited）',
    modelKey: 'deepseek_v3', chipKey: '910b', precKey: 'bf16', tier: 'standard',
    scen: { conc: 8, promptLen: 1024, outputLen: 128, ttft: 2000, tpot: 50 },
    check: (o) => o.warnings.some((w) => w.type === 'crossNode') && o.C.bandLimited === false,
  },
  {
    id: 'boundary_ttft_unreachable',
    note: '高并发 + 紧 TTFT：B 维枚举上限内压不到目标 → ttft 告警',
    modelKey: 'deepseek_v3', chipKey: '910c', precKey: 'bf16', tier: 'standard',
    scen: { conc: 5000, promptLen: 32768, outputLen: 512, ttft: 300, tpot: 100 },
    check: (o) => o.warnings.some((w) => w.type === 'ttft') && o.B.ttftOk === false,
  },
  {
    id: 'boundary_tpot_short',
    note: 'TPOT 高于带宽理论下限但分片×副本枚举上限内压不到 → tpotShort 告警（非 bandLimited）',
    modelKey: 'qwen25_72b', chipKey: '910b32', precKey: 'bf16', tier: 'standard',
    scen: { conc: 129, promptLen: 1024, outputLen: 16384, ttft: 2000, tpot: 21 },
    check: (o) => o.warnings.some((w) => w.type === 'tpotShort') && o.C.bandLimited === false && o.C.tpotShort === true,
  },
  {
    id: 'boundary_odd_to_even',
    note: 'max(A,B,C) 为奇数 → 奇数补偶（rawCards 奇、cards 偶）',
    modelKey: 'qwen3_4b', chipKey: '910c', precKey: 'bf16', tier: 'standard',
    scen: { conc: 9, promptLen: 768, outputLen: 256, ttft: 500, tpot: 30 },
    check: (o) => o.rawCards % 2 === 1 && o.cards === o.rawCards + 1,
  },
];
for (const d of boundaryDefs) {
  const rec = runCase(d.id, 'boundary', d.modelKey, d.chipKey, d.precKey, d.tier, d.scen);
  if (!d.check(rec.out)) {
    throw new Error(`边界用例未触发目标形态：${d.id}（${d.note}）—— 请核对页面引擎或用例参数`);
  }
  cases.push(rec);
}

// ---------- 2d) aggregate 汇总锚点：2b 的 standard/bf16 29 条 ----------
const agg = aggregate(
  part2Results.map((o, i) => ({
    chipKey: SAMPLE_CHIP,
    modelKey: Object.keys(SCENARIOS)[i],
    modelName: Object.keys(SCENARIOS)[i],
    cards: o.cards,
    bottleneck: o.bottleneck,
    scen: { conc: 0 }, // conc 汇总不在锚点口径内，置 0 以隔离
  }))
);

// ---------- 汇总与写出 ----------
const jsonSafe = (v) =>
  JSON.parse(
    JSON.stringify(v, (_k, val) => (typeof val === 'number' && !Number.isFinite(val) ? String(val) : val))
  );

const golden = {
  meta: {
    purpose: '阶段0黄金值基准：Python 移植引擎与页面 JS 输出逐项比对（A 维精确一致；B/C 卡数一致；时延中间量允许 1e-6 相对误差）',
    source: 'frontend/public/inference-eval.html',
    source_sha256: createHash('sha256').update(html).digest('hex'),
    engine_extraction: 'tools/eval_engine.mjs（数据块+引擎块逐字提取，逻辑未改动）',
    generate_script: 'tools/gen_golden_eval_engine.mjs（可复跑）',
    counts: { cases: cases.length, model_chip_matrix: 0, scene_tier_matrix: 0, boundary: boundaryDefs.length },
    engine_params_snapshot: {
      ENG_DEFAULTS: ENG_DEFAULTS,
      ENG_CONST: ENG_CONST,
      TIERS: TIERS,
      PRECISIONS: PRECISIONS,
      CHIPS: CHIPS,
    },
  },
  cases: jsonSafe(cases),
  aggregate_anchor: {
    note: 'aggregate() 锚点：2b 中 29 场景 × 950dt36 × bf16 × standard 的汇总（conc 不参与该锚点）',
    chipKey: SAMPLE_CHIP,
    totalCards: agg.totalCards,
    servers: agg.servers,
    powerKW: agg.powerKW,
    byChip: agg.byChip,
    bottleneckDist: agg.bottleneckDist,
    byModel: agg.byModel.map((x) => ({ modelKey: x.modelKey, cards: x.cards, bottleneck: x.bottleneck })),
  },
};
golden.meta.counts.model_chip_matrix = cases.filter((c) => c.kind === 'model_chip_matrix').length;
golden.meta.counts.scene_tier_matrix = cases.filter((c) => c.kind === 'scene_tier_matrix').length;

writeFileSync(GOLDEN_PATH, JSON.stringify(golden, null, 1), 'utf8');

// ---------- 运行摘要 ----------
const bottleneckDist = { mem: 0, prefill: 0, decode: 0 };
for (const c of cases) bottleneckDist[c.out.bottleneck]++;
const warnTypes = {};
for (const c of cases) for (const w of c.out.warnings) warnTypes[w.type] = (warnTypes[w.type] || 0) + 1;
const oddCases = cases.filter((c) => c.out.rawCards % 2 === 1).length;

console.log('阶段0 黄金值生成完成');
console.log('  引擎提取  →', path.relative(ROOT, ENGINE_MJS_PATH));
console.log('  黄金值    →', path.relative(ROOT, GOLDEN_PATH));
console.log('  用例总数  :', cases.length, `(模型×芯片 ${golden.meta.counts.model_chip_matrix} / 场景×档位 ${golden.meta.counts.scene_tier_matrix} / 边界 ${boundaryDefs.length})`);
console.log('  瓶颈分布  :', JSON.stringify(bottleneckDist));
console.log('  告警分布  :', JSON.stringify(warnTypes));
console.log('  奇数补偶用例:', oddCases, '（rawCards 为奇数的比例）');
console.log('  汇总锚点  : totalCards', agg.totalCards, '/ servers', agg.servers, '/ powerKW', agg.powerKW);
