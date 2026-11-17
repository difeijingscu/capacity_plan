// @vitest-environment jsdom
/**
 * 回归：规划依据页与产品实际口径一致——创新服务池按单模型规划。
 *
 * 背景：引擎遍历 `innovations.allocations` 求和、产品语义已收敛到单模型，
 * 但依据页长期写着「多个模型按份额共享这份总额度」，并给了 70%/30% 的分配示例。
 * 纯展示页没有测试覆盖，这类文案才会一直残留，因此这里守住关键句与公式。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('./api', () => ({
  capacity: (v: unknown) => String(v ?? ''),
  num: (v: unknown) => String(v ?? ''),
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

function openInnovationTab() {
  render(<PlanningBasis defaults={{}} models={[]} />);
  fireEvent.click(screen.getByRole('tab', { name: '创新服务计算依据' }));
}

describe('规划依据 · 创新服务口径', () => {
  it('说明整份额度归单模型，不再出现多模型按份额共享的说法', () => {
    openInnovationTab();
    expect(screen.getByText(/整份额度都归选定的这一个模型/)).toBeTruthy();
    expect(screen.queryByText(/多个模型按份额/)).toBeNull();
    expect(screen.queryByText(/各模型份额合计100%/)).toBeNull();
  });

  it('公式按单模型书写：不带模型下标 wm，也不对分配求和', () => {
    openInnovationTab();
    expect(screen.getByText(/Q月 = U × q × u/)).toBeTruthy();
    expect(screen.queryByText(/Σwm = 1/)).toBeNull();
    expect(screen.queryByText(/ΣCm基础/)).toBeNull();
    expect(screen.getByText(/C创新建议 = C基础 × \(1 \+ h\)/)).toBeTruthy();
  });

  it('示例按单模型换算，不再给两个模型的 70%/30% 分配', () => {
    openInnovationTab();
    expect(screen.getByText(/整份额度归本池选定的那一个模型/)).toBeTruthy();
    expect(screen.queryByText(/两个模型份额70% \/ 30%/)).toBeNull();
  });
});
