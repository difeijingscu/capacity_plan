// @vitest-environment jsdom
/**
 * 回归：业务场景行的「计算过程」必须可展开。
 * 预览响应里 pool.items 是逐场景完整结果（带 trace.detail.tree），
 * pool.scenarios 只是概览摘要；读错数据源会让按钮永远 disabled。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';

vi.mock('./api', () => ({
  capacity: (v: unknown) => String(v ?? ''),
  num: (v: unknown) => String(v ?? ''),
}));
vi.mock('./CoefPanel', () => ({ default: () => null }));
vi.mock('./CustomModelModal', () => ({ default: () => null }));
vi.mock('./CustomChipModal', () => ({ default: () => null }));
vi.mock('./FxTree', () => ({
  default: ({ tree }: { tree: { label: string } }) => <div data-testid="fx-tree">{tree.label}</div>,
}));

import BusinessPage from './BusinessPage';
import type { Obj } from './api';

// vitest 未开 globals，@testing-library 的自动清理不会注册，需手动清理两次渲染的 DOM。
afterEach(() => cleanup());

beforeAll(() => {
  // antd Table 会向 getComputedStyle 传第二个伪元素参数，jsdom 未实现该重载（仅是控制台噪音）。
  const computed = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((elt: Element) => computed(elt)) as typeof window.getComputedStyle;
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

const payload: Obj = {
  scenarios: [{
    id: 's1', name: '企业知识问答', description: '', enabled: true,
    inference: { model_key: 'glm5_3_flash', chip_key: '910c', scene_key: 'rag',
      weight_precision: 'auto', concurrency: 100 },
  }],
  business_defaults: { chip_key: '910c', profile: 'neutral' },
  headroom: 0.2,
};

const catalog: Obj = {
  models: [{ key: 'glm5_3_flash', label: 'GLM-5.3 Flash', total_b: 30, active_b: 3, arch: 'MoE' }],
  custom_models: [],
  chips: [{ key: '910c', label: '昇腾910C · 128GB', bf16_tflops: 560, memory_gb: 128, native_int4: false }],
  custom_chips: [],
  scenes: [{ key: 'rag', name: '知识问答', group: '问答', concurrency: 100 }],
  tiers: [
    { key: 'conservative', label: '保守' },
    { key: 'standard', label: '均衡' },
    { key: 'aggressive', label: '激进' },
  ],
};

/** 与后端 /preview-calculation 的 business pool 同构：items 完整、scenarios 精简。 */
const preview: Obj = {
  headroom: 0.2,
  pools: [{
    id: 'business', cards: 18, cards_planned: 26, base_p: '9.8', planned_p: '11.8',
    capacity_planned_p: '20', missing_items: [],
    scenarios: [{
      id: 's1', name: '企业知识问答', cards: 18, cards_planned: 26,
      base_p: '9.8', completeness: 'COMPLETE', model_label: 'GLM-5.3 Flash',
    }],
    items: [{
      id: 's1', name: '企业知识问答', cards: 18, cards_planned: 26, base_p: '9.8',
      model_label: 'GLM-5.3 Flash', bottleneck: 'prefill', bottleneck_label: 'Prefill',
      latency_status: 'PASSED', warnings: [],
      trace: { detail: { tree: { label: '所需算力卡 N', children: [] } } },
    }],
  }],
};

function renderPage(p: Obj, plan: Obj = payload) {
  return render(
    <AntApp>
      <BusinessPage payload={plan} edit={() => {}} catalog={catalog}
        preview={p} refreshCatalog={async () => {}} onImport={() => {}} />
    </AntApp>,
  );
}

/** 旧方案：只有 components，没有 inference；配置必须由后端迁移后回传。 */
const legacyPayload: Obj = {
  scenarios: [{
    id: 's1', name: '旧场景', description: '', enabled: true,
    components: [{ id: 't1', task_type: 'text', model_id: 'qwen3-8b', online_users: 100 }],
  }],
  business_defaults: { chip_key: '910c', profile: 'neutral' },
  headroom: 0.2,
};

const legacyPreview: Obj = {
  headroom: 0.2,
  pools: [{
    id: 'business', cards: 10, cards_planned: 16, base_p: '5', planned_p: '6',
    missing_items: [], items: [], scenarios: [],
    resolved_specs: {
      s1: {
        enabled: true, origin: 'migrated', warnings: ['MIGRATED_INFERENCE'],
        spec: { model_key: 'glm5_3_flash', chip_key: '910c', scene_key: 'rag', concurrency: 100 },
      },
    },
  }],
};

describe('业务场景 · 计算过程', () => {
  it('已估算场景的按钮可用，点击后展开杜邦树，并显示主导因素', () => {
    renderPage(preview);
    const button = screen.getByRole('button', { name: '计算过程' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(screen.getByTestId('fx-tree').textContent).toBe('所需算力卡 N');
    expect(screen.getByText(/主导因素：Prefill/)).toBeTruthy();
    // 整页渲染在本机约 3–5 秒，贴着默认 5 秒上限会随机超时，这里放宽
  }, 20000);

  it('场景没有估算结果时按钮保持禁用（不误报为可展开）', () => {
    const empty = {
      ...preview,
      pools: [{ ...preview.pools[0], scenarios: [], items: [], missing_items: [ { id: 's1', name: '企业知识问答', message: '待补模型' } ] }],
    };
    renderPage(empty);
    expect((screen.getByRole('button', { name: '计算过程' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('业务场景 · 全局量化精度', () => {
  it('场景行不再提供逐场景推理精度选择，只在全局配置里选一次', () => {
    renderPage(preview);
    // 全局是分段按钮（三档并列），不是下拉
    expect(screen.getByRole('radiogroup', { name: '全局推理量化精度' })).toBeTruthy();
    // 场景行里不应再有「推理精度」控件：精度是方案级设置
    expect(screen.queryAllByRole('combobox', { name: /权重精度/ })).toHaveLength(0);
    expect(screen.queryByText('推理精度')).toBeNull();
  });

  it('已配置场景的精度跟随全局值，不在行内保留旧口径', () => {
    // 场景里留着 bf16 的历史值，全局选 w8a8 后行内标签必须显示 W8A8
    const plan: Obj = JSON.parse(JSON.stringify(payload));
    plan.business_defaults = { chip_key: '910c', profile: 'neutral', weight_precision: 'w8a8' };
    renderPage(preview, plan);
    expect(screen.getByText(/910C · 128GB · W8A8/)).toBeTruthy();
    expect(screen.queryByText(/910C · 128GB · BF16/)).toBeNull();
  });

  it('分段按钮选中即写入全局默认与已配置场景', async () => {
    const plan: Obj = JSON.parse(JSON.stringify(payload));
    render(
      <AntApp>
        <BusinessPage payload={plan} edit={(fn: (p: Obj) => void) => fn(plan)} catalog={catalog}
          preview={preview} refreshCatalog={async () => {}} onImport={() => {}} />
      </AntApp>,
    );
    // 与推理评估页对齐：精度是 W8A8 这类并列分段按钮，不是下拉列表
    const group = screen.getByRole('radiogroup', { name: '全局推理量化精度' });
    expect(group.textContent).toContain('BF16');
    fireEvent.click(screen.getByText('W8A8'));
    // 统一全部场景前会二次确认；antd 会在两个汉字间自动插入空格（"统 一"），按正则匹配
    fireEvent.click(await screen.findByRole('button', { name: /统\s*一/ }));
    expect(plan.business_defaults.weight_precision).toBe('w8a8');
    expect(plan.scenarios[0].inference.weight_precision).toBe('w8a8');
  }, 30000);
});

describe('业务场景 · 旧字段迁移只认后端结果', () => {
  it('显示后端解析出的场景档与迁移状态，不在前端另算一套', () => {
    renderPage(legacyPreview, legacyPayload);
    // 迁移状态直接来自 resolved_specs.origin
    expect(screen.getByText('旧字段推导')).toBeTruthy();
    // 场景档来自后端 spec（rag → 知识问答），而非前端硬编码的默认档位
    expect(screen.getByText('知识问答')).toBeTruthy();
  });

  it('后端还没有解析结果时不伪造模型，显示待解析', () => {
    const pending = {
      headroom: 0.2,
      pools: [{ ...legacyPreview.pools[0], resolved_specs: {} }],
    };
    renderPage(pending, legacyPayload);
    expect(screen.getByText('待解析')).toBeTruthy();
    expect(screen.getByText('未选择模型')).toBeTruthy();
  });
});

describe('业务场景 · 全局配置与推理评估页对齐', () => {
  const chips950: Obj[] = [
    { key: '950pr32', label: '昇腾950PR · 32 Cube', family: '950', bf16_tflops: 486, memory_gb: 128, native_int4: true },
    { key: '950pr', label: '昇腾950PR · 28 Cube', family: '950', bf16_tflops: 425, memory_gb: 112, native_int4: true },
    { key: '950dt36', label: '昇腾950DT · 36 Cube', family: '950', bf16_tflops: 547, memory_gb: 144, native_int4: true },
    { key: '950dt32', label: '昇腾950DT · 32 Cube', family: '950', bf16_tflops: 486, memory_gb: 96, native_int4: true },
    { key: '950dt', label: '昇腾950DT · 28 Cube', family: '950', bf16_tflops: 425, memory_gb: 96, native_int4: true },
  ];

  function renderWith(chips: Obj[]) {
    const plan: Obj = JSON.parse(JSON.stringify(payload));
    plan.business_defaults = { chip_key: '950dt32', profile: 'neutral' };
    return render(
      <AntApp>
        <BusinessPage payload={plan} edit={() => {}} catalog={{ ...catalog, chips }}
          preview={preview} refreshCatalog={async () => {}} onImport={() => {}} />
      </AntApp>,
    );
  }

  it('算力卡选项显示「型号 + 档位 +（FP16 峰值/显存）」，同款多档不再重名', async () => {
    renderWith(chips950);
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '全局算力卡' }));
    await new Promise(r => setTimeout(r, 300));
    const labels = Array.from(document.querySelectorAll('.ant-select-item-option'))
      .map(node => (node.textContent || '').trim());
    expect(labels.some(l => l.includes('昇腾950DT · 32 Cube（FP16 486T/96G）'))).toBe(true);
    expect(labels.some(l => l.includes('昇腾950PR · 28 Cube（FP16 425T/112G）'))).toBe(true);
    // 关键：5 个 950 档位各有唯一文案，不能再出现两个「昇腾950PR」
    expect(new Set(labels).size).toBe(labels.length);
  }, 20000);

  it('精度与工程档位是分段按钮而非下拉', () => {
    renderWith(chips950);
    const prec = screen.getByRole('radiogroup', { name: '全局推理量化精度' });
    expect(prec.querySelectorAll('.ant-segmented-item')).toHaveLength(3);
    expect(prec.textContent).toContain('BF16');
    expect(prec.textContent).toContain('W4A8');
    const tier = screen.getByRole('radiogroup', { name: '全局工程档位' });
    expect(tier.textContent).toContain('均衡');
    expect(tier.textContent).toContain('×0.8');
    // 两块都不再是下拉：分组内不应出现 combobox（全局仅算力卡仍是下拉）
    expect(prec.querySelector('[role="combobox"]')).toBeNull();
    expect(tier.querySelector('[role="combobox"]')).toBeNull();
  }, 20000);
});

/**
 * 新增场景必须插到清单最上方：场景多时列表会滚出首屏，
 * 追加到末尾等于「点了按钮看不到新行」。
 */
function StatefulPage({ initial }: { initial: Obj }) {
  const [plan, setPlan] = useState<Obj>(initial);
  const edit = (mut: (p: Obj) => void) => setPlan(prev => {
    const next: Obj = JSON.parse(JSON.stringify(prev));
    mut(next);
    return next;
  });
  return (
    <AntApp>
      <BusinessPage payload={plan} edit={edit} catalog={catalog} preview={preview}
        refreshCatalog={async () => {}} onImport={() => {}} />
    </AntApp>
  );
}

describe('业务场景 · 新增场景位置', () => {
  it('新场景出现在清单第一行，原有场景依次下移', () => {
    const initial: Obj = JSON.parse(JSON.stringify(payload));
    initial.scenarios.push({
      id: 's2', name: '第二个场景', description: '', enabled: true,
      inference: { model_key: 'glm5_3_flash', chip_key: '910c', scene_key: 'rag', concurrency: 50 },
    });
    render(<StatefulPage initial={initial} />);
    fireEvent.click(screen.getByRole('button', { name: /添加场景/ }));
    const names = screen.getAllByPlaceholderText('场景名称')
      .map(node => (node as HTMLInputElement).value);
    expect(names).toHaveLength(3);
    expect(names[0]).toBe('新业务场景');
    expect(names.slice(1)).toEqual(['企业知识问答', '第二个场景']);
  }, 20000);
});
