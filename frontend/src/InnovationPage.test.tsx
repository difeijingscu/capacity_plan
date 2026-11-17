// @vitest-environment jsdom
/**
 * 回归：创新服务页按「全局配置 → 服务规模与模型设置 → 算力汇总」三段组织，
 * 且模型设置只提供单模型选择——旧方案的多模型额度分配不能静默消失，
 * 必须显式提示并可收敛，否则页面显示与引擎出卡口径会分裂。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App as AntApp } from 'antd';

vi.mock('./api', () => ({
  capacity: (v: unknown) => String(v ?? ''),
  num: (v: unknown) => String(v ?? ''),
}));

import InnovationPage from './InnovationPage';
import type { Obj } from './api';

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

function planWith(allocations: Obj[]): Obj {
  return {
    headroom: 0.2,
    innovation: {
      enabled: true, users: 100, quota_per_user_month: 1000000, usage_ratio: 1,
      service_days: 22, service_hours_per_day: 8, peak_factor: 3,
      allocations, eta_prefill: 0.35, eta_decode: 0.15, chip_key: '910c',
    },
  };
}

/** 与后端 /preview-calculation 的 innovation pool 同构（单模型）。 */
const preview: Obj = {
  headroom: 0.2,
  pools: [{
    id: 'innovation', cards: 6, cards_planned: 8, servers: 1, servers_planned: 1,
    base_p: '0.5', planned_p: '0.6', monthly_tokens: '100000000', completeness: 'COMPLETE',
    memory: { memory_gb: '300', status: 'PROXY' }, missing_items: [],
    cards_detail: {
      chip_label: '昇腾910C', compute_cards: 6, memory_cards: 3,
      bottleneck: '算力', headroom: 0.2, redundancy_cards: 1, rule: '卡数 = max(cards+1, 余量卡数)',
    },
    items: [{
      id: 'innovation-glm5_3_flash', model_id: 'glm5_3_flash', base_p: '0.5',
      memory: { memory_gb: '300' }, monthly_tokens: '100000000',
      trace: { variables: { request_rate: '1.2' } },
    }],
  }],
};

function renderPage(plan: Obj, p: Obj | null = preview, edit: (mutator: (plan: Obj) => void) => void = () => {}) {
  return render(
    <AntApp>
      <InnovationPage payload={plan} edit={edit} catalog={catalog} preview={p}
        derivationReady={false} derivationStale={false} onDerivation={() => {}} />
    </AntApp>,
  );
}

/** 取某个 aria-label 的 Select 当前回显的文本（antd 把选中项渲染在容器里，不在 input 上）。 */
function selectedText(label: string): string {
  const combo = screen.getByRole('combobox', { name: label });
  return combo.closest('.ant-select')?.querySelector('.ant-select-selection-item')?.textContent || '';
}

const single = [{ model_id: 'glm5_3_flash', share: 1, input_fraction: 0.8, request_total_tokens: 2560 }];

describe('创新服务页', () => {
  it('按三段组织：全局配置 / 服务规模与模型设置 / 算力汇总', () => {
    renderPage(planWith(single));
    expect(screen.getByText('全局配置')).toBeTruthy();
    expect(screen.getByText('服务规模与模型设置')).toBeTruthy();
    expect(screen.getByText('算力汇总')).toBeTruthy();
    // antd Select 把 aria-label 同时放在容器与内部 input 上，按 role 取唯一可交互元素。
    expect(screen.getByRole('combobox', { name: '创新服务模型' })).toBeTruthy();
  });

  it('模型设置只提供单模型：没有多选控件，也没有份额输入', () => {
    renderPage(planWith(single));
    const select = screen.getByRole('combobox', { name: '创新服务模型' });
    expect(select.getAttribute('aria-multiselectable')).toBeNull();
    expect(screen.queryByLabelText(/额度份额/)).toBeNull();
    expect(screen.getByText('单模型')).toBeTruthy();
  });

  it('额度上限与池 Token 用不同名称：U × q 未乘使用率，不等于 KPI 的月度 Token', () => {
    renderPage(planWith(single));
    // 两者曾同名「全池」，使用率 < 100% 时数值不一致，容易被当成算错。
    expect(screen.getByText('月度额度上限')).toBeTruthy();
    expect(screen.getByText(/未乘使用率/)).toBeTruthy();
    expect(screen.queryByText('全池月度额度')).toBeNull();
  });

  it('汇总读取本池卡数与算力', () => {
    renderPage(planWith(single));
    // 明细表「含余量卡数」= 8 张；折算明细里有算力/显存两个约束卡数
    expect(screen.getByText('8 张')).toBeTruthy();
    expect(screen.getByText('算力约束卡数')).toBeTruthy();
    expect(screen.getByText(/含余量约 1 台服务器/)).toBeTruthy();
  });

  it('旧方案存在多个模型分配时说明「汇总是合计值」，不谎报未计入', () => {
    renderPage(planWith([
      { model_id: 'glm5_3_flash', share: 0.6, input_fraction: 0.8, request_total_tokens: 2560 },
      { model_id: 'deepseek_v4_pro', share: 0.4, input_fraction: 0.8, request_total_tokens: 2560 },
    ]));
    // 引擎遍历全部 allocations 出卡，页面必须写「合计」，不能再说「其余模型未计入」
    expect(screen.getByText('本方案有 2 个模型分配，下方汇总是这 2 个模型的合计')).toBeTruthy();
    expect(screen.queryByText(/未计入下方汇总/)).toBeNull();
    expect(screen.getByText('收敛为单模型')).toBeTruthy();
    // 份额合计 60% + 40% = 100%，不该出现校验失败提示
    expect(screen.queryByText(/方案校验不通过/)).toBeNull();
  });

  it('份额合计不等于 100% 时说明真实原因（校验不通过、没有结果），而不是「按份额折算」', () => {
    renderPage(planWith([
      { model_id: 'glm5_3_flash', share: 0.6, input_fraction: 0.8, request_total_tokens: 2560 },
      { model_id: 'deepseek_v4_pro', share: 0.2, input_fraction: 0.8, request_total_tokens: 2560 },
    ]));
    expect(screen.getByText('各模型份额合计为 80%，方案校验不通过，没有出卡结果')).toBeTruthy();
    expect(screen.queryByText(/下方汇总按该份额折算/)).toBeNull();
    expect(screen.getByText('按比例归一为 100%')).toBeTruthy();
  });

  it('改「每请求 Token」只更新第一条分配，不删除其它模型', () => {
    const plan = planWith([
      { model_id: 'glm5_3_flash', share: 0.6, input_fraction: 0.8, request_total_tokens: 2560 },
      { model_id: 'deepseek_v4_pro', share: 0.4, input_fraction: 0.8, request_total_tokens: 2560 },
    ]);
    renderPage(plan, preview, (mutator) => mutator(plan));
    const input = screen.getByRole('spinbutton', { name: '每请求Token' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '4096' } });
    fireEvent.blur(input);
    // 两条都要在：改 Token 不是「收敛为单模型」的入口
    expect(plan.innovation.allocations).toHaveLength(2);
    expect(plan.innovation.allocations[0].request_total_tokens).toBe(4096);
    // 份额原样保留，不强制 share = 1（否则会破坏 100% 校验或改变别的模型额度）
    expect(plan.innovation.allocations.map((a: Obj) => a.share)).toEqual([0.6, 0.4]);
    expect(plan.innovation.allocations[1].model_id).toBe('deepseek_v4_pro');
  });

  it('未启用时汇总给出空态', () => {
    const plan = planWith(single);
    plan.innovation.enabled = false;
    renderPage(plan);
    expect(screen.getByText('开启本池后自动汇总')).toBeTruthy();
  });

  it('全局配置给出缓存命中率，缺字段时按 0 展示并与后端口径一致', () => {
    renderPage(planWith(single));
    const input = screen.getByRole('spinbutton', { name: '缓存命中率' }) as HTMLInputElement;
    // v2.1.0 之前的方案没有该字段，后端判为 0（当时没有缓存折算）；
    // 页面若回落到 30% 就会出现「预览按 0 算、页面说 30%」的分裂。
    expect(input.value).toBe('0');
    expect(screen.getByText(/v2\.1\.0 之前的方案没有这一项，重算按 0 与历史快照一致/)).toBeTruthy();
  });

  it('明示了缓存命中率的方案按原值展示，不回落到默认值', () => {
    const plan = planWith(single);
    plan.innovation.cache_hit_rate = 0.3;
    renderPage(plan);
    const input = screen.getByRole('spinbutton', { name: '缓存命中率' }) as HTMLInputElement;
    expect(input.value).toBe('30');
    expect(screen.getByText(/只折算 Prefill，Decode 与显存按全量上下文/)).toBeTruthy();
  });

  it('效率系数默认收起在「当前生效的工程系数」面板里', () => {
    const { container } = renderPage(planWith(single));
    const fold = container.querySelector('details.be-fold') as HTMLDetailsElement | null;
    expect(fold).toBeTruthy();
    // 默认不展开：首屏只放算力卡与缓存命中率两个入口
    expect(fold!.open).toBe(false);
    expect(fold!.textContent).toContain('当前生效的工程系数');
    // 收起后仍在 DOM 里，只是不占首屏
    expect(fold!.querySelector('[aria-label="Prefill 效率"]')).toBeTruthy();
    expect(fold!.querySelector('[aria-label="Decode 效率"]')).toBeTruthy();
  });

  it('没有模型分配时，服务模型默认回落到 DeepSeek-V4-Flash', () => {
    const { container } = renderPage(planWith([]));
    // 旧方案/导入 payload 的 allocations 可能是空列表，页面仍应给出默认模型而不是空白下拉
    expect(selectedText('创新服务模型')).toContain('DeepSeek-V4-Flash');
    expect(container.textContent).toContain('默认模型');
  });

  it('旧方案没有模型分配时，开启本池会把默认模型写进方案', () => {
    const plan = planWith([]);
    plan.innovation.enabled = false;
    let written: Obj | null = null;
    renderPage(plan, preview, (mutator) => {
      const next: Obj = JSON.parse(JSON.stringify(plan));
      mutator(next);
      written = next;
    });
    fireEvent.click(screen.getByRole('switch', { name: '创新服务启用' }));
    const allocations = (written as Obj | null)?.innovation?.allocations as Obj[];
    expect(allocations).toHaveLength(1);
    expect(allocations[0].model_id).toBe('deepseek_v4_flash');
    expect(allocations[0].share).toBe(1);
  });
});
