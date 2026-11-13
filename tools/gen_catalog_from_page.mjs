#!/usr/bin/env node
// =====================================================================
// 阶段 1 · catalog 生成脚本（切换计划：推理评估逻辑统一 v2.0）
//
// 用法（在仓库根目录执行）：
//   node tools/gen_catalog_from_page.mjs
//
// 从 frontend/public/inference-eval.html 提取出的 tools/eval_engine.mjs
// 读取 CHIPS / SCENARIOS / SCENARIO_GROUPS / SCENARIO_DEFAULT_MODEL，
// 生成后端 catalog（页面是唯一数据源，避免手工转录出错）：
//   backend/app/catalogs/inference_chips.json   （8 条芯片）
//   backend/app/catalogs/inference_scenes.json  （29 条场景档）
//
// 仅 inference_models.json 内容不动（已与页面同源）。
// 价格（ref_price_wan）页面没有，取旧表对应档保留、新卡 null；note 为后端口径说明。
// =====================================================================
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIR = path.join(ROOT, 'backend', 'app', 'catalogs');

const { CHIPS, SCENARIOS, SCENARIO_GROUPS, SCENARIO_DEFAULT_MODEL } = (await import(
  'file://' + path.join(ROOT, 'tools', 'eval_engine.mjs').replace(/\\/g, '/')
)).exports;

// ---------- 芯片 ----------
// 旧表价格保留映射（切换计划 §3 阶段1）：950(425T)→950dt、950(486T)→950dt32、
// 950(547T)→950dt36；910b32/950pr32/950pr 为新卡，价格 null。
const CHIP_PRICE = {
  "910b": 18, "910b32": null, "910c": 35,
  "950pr32": null, "950pr": null,
  "950dt36": 50, "950dt32": 46, "950dt": 40,
};
const CHIP_NOTE = {
  "910b": "Atlas 800T A2 整机 2.24 PFLOPS ÷8 = 280T/卡、64GB HBM@1.6TB/s；HCCS 392GB/s 双向（196 单向）。",
  "910b32": "Atlas 300T A2 标卡 / Atlas 800I A2（32GB 款）：280T/卡、32GB HBM@800GB/s、板卡 350W。",
  "910c": "Atlas 800I A3 推理整机 4.48 PFLOPS ÷8 = 560T/卡、8×128GB@3.2TB/s；INT8 按 910 同代 1:2 折算（非官网标称）。",
  "950pr32": "950PR · 32 Cube 档：FP16 486 / FP8·INT8 919 / MXFP4 1784、128GB@1.6TB/s；标卡 ≤600W。",
  "950pr": "950PR · 28 Cube 档（Atlas 350 标卡）：425/804/1561T、112GB@1.4TB/s、≤600W。",
  "950dt36": "950DT · 36 Cube 档：FP16 547 / FP8·INT8 1034 / MXFP4 2007、144GB@4.0TB/s（950 SuperPoD 满配口径）。",
  "950dt32": "950DT · 32 Cube 档（Atlas 850E）：486/919/1784T、8×96GB@4.0TB/s、整机 15.6kW，功耗按整机折算（工程估算）。",
  "950dt": "950DT · 28 Cube 档（Atlas 650E）：425/804/1560T、8×96GB@4.0TB/s、整机 14.5kW；int4=1560 为整机口径，功耗按整机折算（工程估算）。",
};
const NOTE_SUFFIX = "纸面规格估算，非实测；价格与功耗仅登记，不参与卡数计算。";

const chips = Object.keys(CHIPS).map((key) => {
  const c = CHIPS[key];
  return {
    key,
    label: c.label,
    family: c.fam,                       // "910" | "950"（页面口径）
    bf16_tflops: c.cf_fp16,
    int8_tflops: c.cf_int8,
    int4_tflops: c.nativeInt4 ? c.cf_int4 : null,
    memory_gb: c.cm,
    hbm_tbs: c.bw,
    link_gbs: c.ibw,                     // 芯片级互联单向带宽（灵衢口径）
    native_int4: c.nativeInt4,
    power_kw: c.powerKW,                 // 板卡级
    ref_price_wan: CHIP_PRICE[key] !== undefined ? CHIP_PRICE[key] : null,
    note: (CHIP_NOTE[key] || '') + NOTE_SUFFIX,
  };
});

// ---------- 场景档 ----------
const groupOf = {};
for (const g of SCENARIO_GROUPS) for (const k of g.keys) groupOf[k] = g.label;

const scenes = Object.keys(SCENARIOS).map((key) => {
  const s = SCENARIOS[key];
  if (!groupOf[key]) throw new Error('场景未归组：' + key);
  if (!SCENARIO_DEFAULT_MODEL[key]) throw new Error('场景缺少默认模型：' + key);
  return {
    key,
    name: s.name,
    group: groupOf[key],
    default_model_key: SCENARIO_DEFAULT_MODEL[key],
    prompt_len: s.promptLen,
    output_len: s.outputLen,
    max_ctx: s.maxCtx,
    concurrency: s.conc,
    ttft_ms: s.ttft,
    tpot_ms: s.tpot,
    hint: s.hint,
  };
});

if (chips.length !== 8) throw new Error('芯片数不是 8：' + chips.length);
if (scenes.length !== 29) throw new Error('场景数不是 29：' + scenes.length);

const header = () => ''; // JSON 不支持注释；数据出处见本脚本头注与 docs/更新记录.md

const chipsJson = header() + JSON.stringify(chips, null, 2) + '\n';

const scenesJson = header() + JSON.stringify(scenes, null, 2) + '\n';

writeFileSync(path.join(CATALOG_DIR, 'inference_chips.json'), chipsJson, 'utf8');
writeFileSync(path.join(CATALOG_DIR, 'inference_scenes.json'), scenesJson, 'utf8');

console.log('catalog 生成完成：');
console.log('  inference_chips.json  :', chips.length, '条（910×3 / 950×5）');
console.log('  inference_scenes.json :', scenes.length, '条 / 7 分组');
console.log('  默认并发抽查：rag =', SCENARIOS.rag.conc, '/ think =', SCENARIOS.think.conc);
