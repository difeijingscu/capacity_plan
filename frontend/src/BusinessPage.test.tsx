// @vitest-environment jsdom
/**
 * 回归：业务场景行的「计算过程」必须可展开。
 * 预览响应里 pool.items 是逐场景完整结果（带 trace.detail.tree），
 * pool.scenarios 只是概览摘要；读错数据源会让按钮永远 disabled。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  chips: [{ key: '910c', label: '昇腾 910C · 预设', bf16_tflops: 800 }],
  custom_chips: [],
  scenes: [{ key: 'rag', name: '知识问答', group: '问答', concurrency: 100 }],
  tiers: [{ key: 'standard', label: '均衡' }],
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
    // 全局下拉存在
    expect(screen.getByRole('combobox', { name: '全局推理量化精度' })).toBeTruthy();
    // 场景行里不应再有「推理精度」控件：精度是方案级设置
    expect(screen.queryAllByRole('combobox', { name: /权重精度/ })).toHaveLength(0);
    expect(screen.queryByText('推理精度')).toBeNull();
  });

  it('已配置场景的精度跟随全局值，不在行内保留旧口径', () => {
    // 场景里留着 bf16 的历史值，全局选 w8a8 后行内标签必须显示 W8A8
    const plan: Obj = JSON.parse(JSON.stringify(payload));
    plan.business_defaults = { chip_key: '910c', profile: 'neutral', weight_precision: 'w8a8' };
    renderPage(preview, plan);
    expect(screen.getByText(/昇腾 910C · W8A8/)).toBeTruthy();
    expect(screen.queryByText(/昇腾 910C · BF16/)).toBeNull();
  });

  it('全局下拉可选，并把精度写入全局默认与已配置场景', async () => {
    const plan: Obj = JSON.parse(JSON.stringify(payload));
    render(
      <AntApp>
        <BusinessPage payload={plan} edit={(fn: (p: Obj) => void) => fn(plan)} catalog={catalog}
          preview={preview} refreshCatalog={async () => {}} onImport={() => {}} />
      </AntApp>,
    );
    // 与推理评估页对齐：全局硬件配置里必须有可操作的量化精度选择，而不是一段说明文字
    const combo = screen.getByRole('combobox', { name: '全局推理量化精度' });
    fireEvent.mouseDown(combo);
    // rc-select 的选项在弹层挂载后才可点，等一拍再取
    await new Promise(r => setTimeout(r, 300));
    // 选项要命中 .ant-select-item-option 本身，点内部 content 不会触发 rc-select 的选中
    const option = Array.from(document.querySelectorAll('.ant-select-item-option'))
      .find(node => (node.textContent || '').includes('W8A8'));
    expect(option).toBeTruthy();
    fireEvent.click(option!);
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
