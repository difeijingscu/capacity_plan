// @vitest-environment jsdom
/**
 * 回归：开发测试页按「全局配置 → 模型开发测试强度 → 算力汇总」三段组织，
 * 且「需要微调的模型」只提供单选——旧方案的多候选模型不能静默消失，
 * 必须显式提示并可收敛，否则页面显示与引擎出卡口径会分裂。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';

vi.mock('./api', () => ({
  capacity: (v: unknown) => String(v ?? ''),
  num: (v: unknown) => String(v ?? ''),
}));

import DevelopmentPage from './DevelopmentPage';
import type { Obj } from './api';

afterEach(() => cleanup());

beforeAll(() => {
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

/** 与 /api/v1/inference/catalog 同构的最小目录。 */
const catalog: Obj = {
  models: [
    { key: 'deepseek_v4_flash', label: 'DeepSeek-V4-Flash（284B/A13B）', total_b: 284, active_b: 13, arch: 'MoE' },
    { key: 'glm5_3_flash', label: 'GLM-5.3 Flash', total_b: 30, active_b: 3, arch: 'MoE' },
    { key: 'deepseek_v4_pro', label: 'DeepSeek-V4-Pro', total_b: 1600, active_b: 49, arch: 'MoE' },
  ],
  custom_models: [],
  chips: [{ key: '910c', label: '昇腾910C · 128GB', bf16_tflops: 560, memory_gb: 128, native_int4: false }],
  custom_chips: [],
};

/** 与后端 INTENSITIES 一致的档位默认参数。 */
const intensityDefaults: Obj = {
  light: { train_data_tokens: 1000000, epochs: 1, train_deadline_hours: 24, sequence_length: 2048, train_slots: 1 },
  standard: { train_data_tokens: 5000000, epochs: 2, train_deadline_hours: 12, sequence_length: 2048, train_slots: 1 },
  high: { train_data_tokens: 20000000, epochs: 3, train_deadline_hours: 8, sequence_length: 4096, train_slots: 2 },
};

function planWith(models: Obj[]): Obj {
  return {
    headroom: 0.2,
    development: {
      enabled: true, intensity: 'standard', models, chip_key: '910c',
      train_data_tokens: null, epochs: null, train_deadline_hours: null,
      sequence_length: null, train_slots: null, train_k: 4, train_eta: 0.25, adapter_fraction: 0.005,
    },
  };
}

/** 与后端 /preview-calculation 的 development pool 同构（单模型）。 */
const preview: Obj = {
  headroom: 0.2,
  pools: [{
    id: 'development', cards: 12, cards_planned: 13, servers: 2, servers_planned: 2,
    base_p: '8', planned_p: '9.6', completeness: 'COMPLETE',
    memory: { memory_gb: '120', status: 'PROXY', train_slot_gb: '120' },
    intensity_parameters: intensityDefaults.standard,
    missing_items: [],
    cards_detail: {
      chip_label: '昇腾910C', compute_cards: 12, memory_cards: 1,
      bottleneck: '算力', headroom: 0.2, redundancy_cards: 1, rule: '卡数 = max(cards+1, 余量卡数)',
    },
    items: [{
      id: 'train-glm5_3_flash', model_id: 'glm5_3_flash', name: 'GLM-5.3 Flash · LORA',
      base_p: '8', memory: { memory_gb: '120', status: 'PROXY' },
      trace: { variables: { flop_total: '1.2e17', base_weight_gb: '60', adapter_state_gb: '2.4', activation_gb: '12', workspace_gb: '6', train_slots: 1 } },
    }],
  }],
};

function renderPage(plan: Obj, p: Obj | null = preview, edit: (mutator: (plan: Obj) => void) => void = () => {}) {
  return render(
    <AntApp>
      <DevelopmentPage payload={plan} edit={edit} catalog={catalog} preview={p}
        intensityDefaults={intensityDefaults}
        derivationReady={false} derivationStale={false} onDerivation={() => {}} />
    </AntApp>,
  );
}

/** 取某个 aria-label 的 Select 当前回显文本（antd 把选中项渲染在容器里，不在 input 上）。 */
function selectedText(label: string): string {
  const combo = screen.getByRole('combobox', { name: label });
  return combo.closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent || '';
}

const single = [{ model_id: 'glm5_3_flash', method: 'lora' }];

describe('开发测试页', () => {
  it('按三段组织：全局配置 / 模型开发测试强度 / 算力汇总', () => {
    renderPage(planWith(single));
    expect(screen.getByText('全局配置')).toBeTruthy();
    expect(screen.getByText('模型开发测试强度')).toBeTruthy();
    expect(screen.getByText('算力汇总')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '需要微调的模型' })).toBeTruthy();
  });

  it('「需要支持的模型」已改名为「需要微调的模型」，且不再提供多选', () => {
    renderPage(planWith(single));
    expect(screen.queryByText('需要支持的模型')).toBeNull();
    const select = screen.getByRole('combobox', { name: '需要微调的模型' });
    expect(select.getAttribute('aria-multiselectable')).toBeNull();
    // 微调方法仍可作为独立字段选择
    expect(screen.getByRole('combobox', { name: '微调方法' })).toBeTruthy();
  });

  it('汇总读取本池卡数、槽位与显存', () => {
    const { container } = renderPage(planWith(single));
    // 含余量 13 张出现在 KPI 与折算说明里；用 KPI 结构定位，避免和表格撞车
    const kpis = [...container.querySelectorAll('.be-kpi')];
    expect(kpis.some(k => k.querySelector('.k')?.textContent === '所需卡数' && /13/.test(k.textContent || ''))).toBe(true);
    expect(kpis.some(k => k.querySelector('.k')?.textContent === '并行微调槽位')).toBe(true);
    expect(screen.getByText(/含余量约 2 台服务器/)).toBeTruthy();
    expect(screen.getByText('算力约束卡数')).toBeTruthy();
  });

  it('旧方案存在多个候选模型时说明「按全部候选聚合」，不谎报未计入', () => {
    renderPage(planWith([
      { model_id: 'glm5_3_flash', method: 'lora' },
      { model_id: 'deepseek_v4_pro', method: 'lora' },
    ]));
    // 引擎按 max(单任务容量) 聚合，两个候选都参与，不能说「其余不在汇总中」
    expect(screen.getByText('本方案有 2 个候选模型，下方汇总按这 2 个候选聚合')).toBeTruthy();
    expect(screen.queryByText(/不在下方汇总/)).toBeNull();
    expect(screen.getByText('收敛为单模型')).toBeTruthy();
  });

  it('改「微调方法」只更新第一条候选，不删除其它候选', () => {
    const plan = planWith([
      { model_id: 'glm5_3_flash', method: 'lora' },
      { model_id: 'deepseek_v4_pro', method: 'lora' },
    ]);
    renderPage(plan, preview, (mutator) => mutator(plan));
    const select = screen.getByRole('combobox', { name: '微调方法' }) as HTMLElement;
    fireEvent.mouseDown(select);
    fireEvent.click(screen.getByText('QLoRA（需要量化基线）'));
    // 改方法不是「收敛为单模型」的入口：另一条候选必须还在
    expect(plan.development.models).toHaveLength(2);
    expect(plan.development.models[0]).toEqual({ model_id: 'glm5_3_flash', method: 'qlora' });
    expect(plan.development.models[1]).toEqual({ model_id: 'deepseek_v4_pro', method: 'lora' });
  });

  it('未启用时汇总给出空态', () => {
    const plan = planWith(single);
    plan.development.enabled = false;
    renderPage(plan);
    expect(screen.getByText('开启本池后自动汇总')).toBeTruthy();
  });

  it('训练系数默认收起在折叠面板里', () => {
    const { container } = renderPage(planWith(single));
    const folds = [...container.querySelectorAll('details.be-fold')] as HTMLDetailsElement[];
    expect(folds.length).toBeGreaterThanOrEqual(2);
    // 首屏只有算力卡与「余量与冗余」两个入口
    expect(folds[0].open).toBe(false);
    expect(folds[0].textContent).toContain('当前生效的训练系数');
    expect(folds[0].querySelector('[aria-label="训练工作量系数"]')).toBeTruthy();
    // 任务参数同样默认收起
    expect(folds[1].open).toBe(false);
    expect(folds[1].textContent).toContain('强度档位的具体任务参数');
  });

  it('没有候选模型时，「需要微调的模型」默认回落到 DeepSeek-V4-Flash', () => {
    const { container } = renderPage(planWith([]));
    expect(selectedText('需要微调的模型')).toContain('DeepSeek-V4-Flash');
    expect(container.textContent).toContain('默认模型');
  });

  it('旧方案没有候选模型时，开启本池会把默认模型写进方案', () => {
    const plan = planWith([]);
    plan.development.enabled = false;
    let written: Obj | null = null;
    renderPage(plan, preview, (mutator) => {
      const next: Obj = JSON.parse(JSON.stringify(plan));
      mutator(next);
      written = next;
    });
    fireEvent.click(screen.getByRole('switch', { name: '开发测试启用' }));
    const models = (written as Obj | null)?.development?.models as Obj[];
    expect(models).toHaveLength(1);
    expect(models[0].model_id).toBe('deepseek_v4_flash');
    expect(models[0].method).toBe('lora');
  });

  it('切换强度档会清空任务参数，避免沿用上一档的数据量', () => {
    const plan = planWith(single);
    plan.development.train_data_tokens = 50000000;
    let written: Obj | null = null;
    renderPage(plan, preview, (mutator) => {
      const next: Obj = JSON.parse(JSON.stringify(plan));
      mutator(next);
      written = next;
    });
    fireEvent.click(screen.getByText('高强度'));
    const dev = (written as Obj | null)?.development as Obj;
    expect(dev.intensity).toBe('high');
    // 五项任务参数全部回落为 null（由后端按档位取值）
    for (const key of ['train_data_tokens', 'epochs', 'train_deadline_hours', 'sequence_length', 'train_slots']) {
      expect(dev[key]).toBeNull();
    }
  });
});
