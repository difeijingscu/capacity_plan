// @vitest-environment jsdom
/**
 * 回归：规划依据页必须与引擎口径逐条对齐。
 *
 * 这一页是纯展示、没有接口校验，历史上多次出现「代码改了、文案没改」：
 * 业务池写着「C建议 = C基础 × (1 + h)」、A 约束写成「权重 + KV + 激活空间 ÷ 单卡显存」、
 * 台数写成「卡数 ÷ 8」，而引擎早已是不加余量、装载宽度 × 副本数、逐场景 ⌈卡数 ÷ 8⌉ 求和。
 * 因此这里守住三件事：三池不出现 ×(1 + h)；业务池的补偶 / 8 卡 / 台数口径正确；
 * 创新与研发池的建议容量等于基础容量，且创新池带缓存命中折算。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('./api', () => ({
  capacity: (v: unknown) => String(v ?? ''),
  num: (v: unknown, digits?: number) => v == null ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: digits ?? 2 }),
}));

import PlanningBasis from './PlanningBasis';

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

const TABS = ['整体规划思路', '业务场景计算依据', '创新服务计算依据', '开发测试计算依据'] as const;

function openTab(name: typeof TABS[number]) {
  render(<PlanningBasis defaults={{}} models={[]} />);
  fireEvent.click(screen.getByRole('tab', { name }));
}

describe('规划依据 · 三池统一口径', () => {
  it('任何页签都不再出现「建议容量 = 基础容量 × (1 + h)」', () => {
    render(<PlanningBasis defaults={{}} models={[]} />);
    for (const name of TABS) {
      fireEvent.click(screen.getByRole('tab', { name }));
      expect(screen.queryByText(/1 \+ h/)).toBeNull();
      expect(screen.queryByText(/故障冗余 \+ 1/)).toBeNull();
    }
  });
});

describe('规划依据 · 业务场景口径', () => {
  it('卡数为「补偶后不足 8 卡补到 8 卡」，台数按场景各自 ⌈卡数 ÷ 8⌉ 求和', () => {
    openTab('业务场景计算依据');
    expect(screen.getByText(/卡数场景 = max\(8, 补偶\( max\(A, B, C\) \)\)/)).toBeTruthy();
    expect(screen.getByText(/台数池 = Σ 各场景 ⌈卡数场景 ÷ 8⌉/)).toBeTruthy();
    // 旧文案把整池卡数一次性除以 8，会把 2 个 10 卡场景错算成 3 台
    expect(screen.queryByText(/台数 = 卡数 ÷ 8/)).toBeNull();
  });

  it('A 约束按「权重装载宽度 × 副本数」，不再写成一次除法', () => {
    openTab('业务场景计算依据');
    expect(screen.getByText(/A = 装载宽度 × 副本数/)).toBeTruthy();
    expect(screen.getByText(/KV 需求 = 并发 × \(Li \+ Lo ÷ 2\) × 每 Token KV × KV 预留系数/)).toBeTruthy();
    expect(screen.queryByText(/激活与运行空间/)).toBeNull();
  });

  it('建议容量等于基础容量', () => {
    openTab('业务场景计算依据');
    expect(screen.getByText(/C建议 = C基础/)).toBeTruthy();
  });
});

describe('规划依据 · 创新服务口径', () => {
  it('说明整份额度归单模型，不再出现多模型按份额共享的说法', () => {
    openTab('创新服务计算依据');
    expect(screen.getByText(/整份额度都归选定的这一个模型/)).toBeTruthy();
    expect(screen.queryByText(/多个模型按份额/)).toBeNull();
    expect(screen.queryByText(/各模型份额合计100%/)).toBeNull();
    expect(screen.queryByText(/Σwm = 1/)).toBeNull();
    expect(screen.queryByText(/ΣCm基础/)).toBeNull();
  });

  it('公式按单模型书写，建议容量等于基础容量，并含缓存命中折算与卡数折算', () => {
    openTab('创新服务计算依据');
    expect(screen.getByText(/Q月 = U × q × u/)).toBeTruthy();
    expect(screen.getByText(/Fp = 2 × Np × Li × κp × \(1 − h\)/)).toBeTruthy();
    expect(screen.getByText(/C创新建议 = C基础/)).toBeTruthy();
    expect(screen.getByText(/规划卡数 = max\(算力卡数, 显存卡数\)/)).toBeTruthy();
  });

  it('示例按单模型换算，不再给两个模型的 70%/30% 分配', () => {
    openTab('创新服务计算依据');
    expect(screen.getByText(/整份额度归本池选定的那一个模型/)).toBeTruthy();
    expect(screen.queryByText(/两个模型份额70% \/ 30%/)).toBeNull();
  });
});

describe('规划依据 · 开发测试口径', () => {
  it('按最大单任务 × 槽位聚合，建议容量等于基础容量', () => {
    openTab('开发测试计算依据');
    expect(screen.getByText(/C单任务 = max\(各候选模型的单任务微调容量\)/)).toBeTruthy();
    expect(screen.getByText(/C研发建议 = Ct/)).toBeTruthy();
    expect(screen.getByText(/规划卡数 = max\(⌈C建议 × 1000 ÷ 单卡 BF16 峰值⌉, ⌈池显存 ÷ 单卡显存⌉\)/)).toBeTruthy();
  });
});
