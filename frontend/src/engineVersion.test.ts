import { describe, expect, it } from 'vitest';

import { businessHasHeadroom } from './engineVersion';

describe('业务池余量口径 · 快照版本判定', () => {
  it('engine-v2.1.0 及更早仍含方案余量', () => {
    expect(businessHasHeadroom({ engine_version: 'engine-v2.1.0' })).toBe(true);
    expect(businessHasHeadroom({ engine_version: 'engine-v2.0.5' })).toBe(true);
    expect(businessHasHeadroom({ engine_version: 'engine-v1.9.9' })).toBe(true);
  });

  it('engine-v2.1.1 起业务池不再乘余量', () => {
    expect(businessHasHeadroom({ engine_version: 'engine-v2.1.1' })).toBe(false);
    expect(businessHasHeadroom({ engine_version: 'engine-v2.2.0' })).toBe(false);
  });

  it('没有版本号的构造对象按当前口径处理，不当成旧快照', () => {
    expect(businessHasHeadroom({})).toBe(false);
    expect(businessHasHeadroom(null)).toBe(false);
    expect(businessHasHeadroom(undefined)).toBe(false);
  });
});
