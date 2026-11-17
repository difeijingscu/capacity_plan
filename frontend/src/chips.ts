import type { Obj } from './api';

/**
 * 算力卡展示口径的唯一实现：业务场景、创新服务、开发测试三处共用。
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
