import { describe, expect, it } from 'vitest';

import { businessHasHeadroom, hasNoPoolHeadroom, poolHasHeadroom } from './engineVersion';

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

describe('创新/研发池余量口径 · 快照版本判定', () => {
  // 边界不同：业务池 v2.1.1 就去掉了余量，创新/研发池到 v2.2.0 才去掉，
  // 所以 v2.1.1 的快照必须是「业务池不含、创新/研发仍含」的混合状态。
  it('engine-v2.2.0 之前仍含余量与 +1 冗余', () => {
    expect(poolHasHeadroom({ engine_version: 'engine-v2.1.1' })).toBe(true);
    expect(poolHasHeadroom({ engine_version: 'engine-v2.1.0' })).toBe(true);
    expect(poolHasHeadroom({ engine_version: 'engine-v1.9.9' })).toBe(true);
  });

  it('engine-v2.2.0 起不再叠加', () => {
    expect(poolHasHeadroom({ engine_version: 'engine-v2.2.0' })).toBe(false);
    expect(poolHasHeadroom({ engine_version: 'engine-v2.3.1' })).toBe(false);
    expect(poolHasHeadroom({})).toBe(false);
  });

  it('三池都不含余量只有 v2.2.0 及之后才成立', () => {
    expect(hasNoPoolHeadroom({ engine_version: 'engine-v2.2.0' })).toBe(true);
    expect(hasNoPoolHeadroom({ engine_version: 'engine-v2.1.1' })).toBe(false);
    expect(hasNoPoolHeadroom({ engine_version: 'engine-v2.1.0' })).toBe(false);
  });
});
