// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));
vi.mock('./api', () => ({
  api: apiMock,
  capacity: (v: unknown) => String(v ?? ''),
  num: (v: unknown) => String(v ?? ''),
  stateNames: { COMPLETE: '完整' },
}));
vi.mock('./FxTree', () => ({
  default: ({ tree, variant }: { tree: { label: string }; variant: string }) => (
    <div data-testid="pool-fx-tree" data-variant={variant}>{tree.label}</div>
  ),
}));

import CalculationDerivation from './CalculationDerivation';

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

afterEach(() => {
  cleanup();
  apiMock.mockReset();
});

const snapshot = {
  run_id: 'run-1', scope: 'innovation', title: '创新服务 · 计算推导',
  plan_revision: 3, completeness: 'COMPLETE', created_at: '2026-11-13T00:00:00',
  planned_p: '1.2', base_p: '1', missing_items: [], inputs: [], steps: [], breakdown: [], items: [], notes: [],
  tree: { label: '创新池规划结果', children: [] },
};

describe('创新/研发池计算推导', () => {
  it('从历史快照加载并展示杜邦式计算树', async () => {
    apiMock.mockResolvedValue(snapshot);
    render(<CalculationDerivation runId="run-1" scope="innovation" stale={false} onClose={() => {}} />);
    const tree = await screen.findByTestId('pool-fx-tree');
    expect(tree.textContent).toBe('创新池规划结果');
    expect(tree.getAttribute('data-variant')).toBe('pool');
    expect(apiMock).toHaveBeenCalledWith('/calculations/run-1/derivation?scope=innovation');
    expect(screen.getByText('计算过程 · 杜邦式展开')).toBeTruthy();
  });
});
