import { describe, expect, it } from 'vitest';
import { chipOptionLabel, chipSelectOptions, chipSpecHint } from './chips';
import type { Obj } from './api';

const chips: Obj[] = [
  { key: '950dt32', label: '昇腾950DT · 32 Cube', family: '950DT', bf16_tflops: 486, memory_gb: 96, hbm_tbs: 3.2, link_gbs: 392 },
  { key: '950dt36', label: '昇腾950DT · 36 Cube', family: '950DT', bf16_tflops: 546, memory_gb: 96 },
  { key: 'my-chip', label: '自研卡', custom: true, bf16_tflops: 300, memory_gb: 64 },
];

describe('算力卡展示口径（三池共用）', () => {
  it('选卡文案带档位与 FP16/显存，同款不同档不重名', () => {
    const labels = chips.map(chipOptionLabel);
    expect(labels[0]).toBe('昇腾950DT · 32 Cube（FP16 486T/96G）');
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels[2]).toContain('· 自定义');
  });

  it('规格摘要缺字段时给占位符，不出现 undefined', () => {
    expect(chipSpecHint(chips[0])).toContain('BF16 486T');
    expect(chipSpecHint(chips[0])).toContain('带宽 3.2TB/s');
    const sparse = chipSpecHint(chips[1]);
    expect(sparse).toContain('INT8 —');
    expect(sparse).not.toContain('undefined');
    expect(chipSpecHint(undefined)).toBe('—');
  });

  it('下拉按系列分组，自定义排在最后', () => {
    const groups = chipSelectOptions(chips);
    expect(groups.map(g => g.label)).toEqual(['昇腾 950DT 系列', '自定义']);
    expect(groups[0].options.map(o => o.value)).toEqual(['950dt32', '950dt36']);
  });
});
