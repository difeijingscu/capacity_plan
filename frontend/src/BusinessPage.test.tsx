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

function renderPage(p: Obj) {
  return render(
    <AntApp>
      <BusinessPage payload={payload} edit={() => {}} catalog={catalog} legacyModels={[]}
        preview={p} refreshCatalog={async () => {}} onImport={() => {}} />
    </AntApp>,
  );
}

describe('业务场景 · 计算过程', () => {
  it('已估算场景的按钮可用，点击后展开杜邦树，并显示主导因素', () => {
    renderPage(preview);
    const button = screen.getByRole('button', { name: '计算过程' }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(screen.getByTestId('fx-tree').textContent).toBe('所需算力卡 N');
    expect(screen.getByText(/主导因素：Prefill/)).toBeTruthy();
  });

  it('场景没有估算结果时按钮保持禁用（不误报为可展开）', () => {
    const empty = {
      ...preview,
      pools: [{ ...preview.pools[0], scenarios: [], items: [], missing_items: [ { id: 's1', name: '企业知识问答', message: '待补模型' } ] }],
    };
    renderPage(empty);
    expect((screen.getByRole('button', { name: '计算过程' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
