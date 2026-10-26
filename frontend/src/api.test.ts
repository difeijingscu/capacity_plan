import { describe, expect, it, vi, afterEach } from 'vitest';
import { api, capacity } from './api';

afterEach(() => vi.restoreAllMocks());
describe('capacity display', () => {
  it('keeps missing values distinct from zero and tiny needs', () => {
    expect(capacity(null)).toBe('待补充');
    expect(capacity(0)).toBe('0 T16');
    expect(capacity(.000001)).toBe('0.001 T16');
  });
  it('switches T/P without losing the calculation precision label', () => {
    expect(capacity(.1630598)).toBe('163 T16');
    expect(capacity(1.578)).toBe('1.58 P16');
  });
});
describe('API errors', () => {
  it('preserves actionable revision conflict messages', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({ code: 'STALE_REVISION', message: '方案已更新，请刷新' }) }));
    await expect(api('/plans/test', 'PATCH', {})).rejects.toThrow('方案已更新，请刷新');
  });
  it('does not force a JSON content type onto Excel multipart uploads', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'preview' }) });
    vi.stubGlobal('fetch', fetcher);
    const form = new FormData(); form.append('text', '场景');
    await api('/imports/preview', 'POST', form);
    expect(fetcher.mock.calls[0][1].headers).toEqual({});
    expect(fetcher.mock.calls[0][1].body).toBe(form);
  });
});
