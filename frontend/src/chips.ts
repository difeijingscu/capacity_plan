import type { Obj } from './api';

/**
 * 目录展示口径的唯一实现：算力卡与推理模型，业务场景、创新服务、开发测试三处共用。
 *
 * 选卡文案与「推理评估」页保持一致——型号 + 档位 +（FP16 峰值/显存）：
 * 950PR / 950DT 各有多个 Cube 档，只显示「昇腾950DT」会让同款不同档重名。
 */
export function chipOptionLabel(c: Obj): string {
  const spec = c.bf16_tflops && c.memory_gb ? `（FP16 ${c.bf16_tflops}T/${c.memory_gb}G）` : '';
  return `${c.label || c.key}${spec}${c.custom ? ' · 自定义' : ''}`;
}

/** 选卡下方的一行规格摘要，取不到规格时给占位符而不是空白。 */
export function chipSpecHint(c?: Obj | null): string {
  if (!c || !c.bf16_tflops) return '—';
  return `BF16 ${c.bf16_tflops}T · INT8 ${c.int8_tflops ?? '—'}T · 显存 ${c.memory_gb}GB`
    + ` · 带宽 ${c.hbm_tbs ?? '—'}TB/s · 互联 ${c.link_gbs ?? '—'}GB/s`;
}

/** 下拉分组：自定义排最后，其余按昇腾系列归档。 */
export const chipGroup = (c: Obj): string =>
  c.custom ? '自定义' : (c.family ? `昇腾 ${c.family} 系列` : '其他');

/** 按系列分组的选卡下拉选项（antd Select 的 optgroup 结构）。 */
export function chipSelectOptions(chips: Obj[]): { label: string; options: { value: string; label: string; title?: string }[] }[] {
  const groups: { label: string; options: { value: string; label: string; title?: string }[] }[] = [];
  const index = new Map<string, { value: string; label: string; title?: string }[]>();
  for (const chip of chips) {
    const label = chipGroup(chip);
    if (!index.has(label)) { const bucket: { value: string; label: string; title?: string }[] = []; index.set(label, bucket); groups.push({ label, options: bucket }); }
    index.get(label)!.push({ value: chip.key, label: chipOptionLabel(chip), title: chip.label });
  }
  return groups;
}

/** 按 groupOf 分组生成 Select 的 optgroup 结构（保持首次出现顺序）。 */
export function groupOptions(items: Obj[], groupOf: (item: Obj) => string, toOption: (item: Obj) => Obj) {
  const groups: { label: string; options: Obj[] }[] = [];
  const index = new Map<string, Obj[]>();
  for (const item of items) {
    const label = groupOf(item);
    if (!index.has(label)) { const bucket: Obj[] = []; index.set(label, bucket); groups.push({ label, options: bucket }); }
    index.get(label)!.push(toOption(item));
  }
  return groups;
}

/** 模型分组：自定义排最后，其余按厂商标识（目录 label 的英文前缀）归档。 */
export const modelGroup = (m: Obj): string =>
  m.custom ? '自定义' : (String(m.label || m.key).match(/^[A-Za-z]+/)?.[0] || '其他');

/**
 * 推理模型下拉选项——**应用级全局口径**：业务场景页「场景清单」、创新服务页
 * 「服务模型」、开发测试页「需要微调的模型」共用这一份分类清单。
 *
 * 分类按厂商标识分组（GLM / Qwen / DeepSeek …），自定义模型单独归到「自定义」。
 * 三处都调这里而不是各写一份 groupOptions，避免同一条模型在不同页面归属不同分组、
 * 或某页漏掉自定义模型。新增模型只需改目录（catalogs/inference_models.json 或登记自定义模型）。
 */
export function modelSelectOptions(models: Obj[]): { label: string; options: Obj[] }[] {
  return groupOptions(models, modelGroup,
    (m: Obj) => ({ value: m.key, label: (m.label || m.key) + (m.custom ? ' · 自定义' : '') }));
}

/** 目录里某条模型的展示名（取不到时原样返回 id，避免空白单元格）。 */
export function modelDisplayName(models: Obj[], id?: string | null): string {
  return matchModel(models, id)?.label || String(id ?? '');
}

/**
 * 展示层模型匹配：旧方案的 `model_id` 常是别名（`qwen3.6-35b-a3b` 对目录 key
 * `qwen3_6_35b_a3b`），引擎侧由 `business.match_model_key` 归一。
 * 页面只做展示匹配——按 key、再按去符号后的 key / label 比对，命中就显示目录里的
 * 正式名称与规格；未命中（模型已下架）原样显示，由用户重选。
 * 这里不做迁移写回：改口径和改显示是两件事。
 */
export function matchModel(models: Obj[], id?: string | null): Obj | undefined {
  if (!id) return undefined;
  const norm = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return models.find((m: Obj) => m.key === id)
    || models.find((m: Obj) => norm(m.key) === norm(id))
    || models.find((m: Obj) => norm(m.label) === norm(id));
}
