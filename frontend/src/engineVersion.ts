/** 引擎版本判定：同一个数字在不同版本的快照里含义不同，展示文案必须跟着版本走。 */
import type { Obj } from './api';

/** 业务池取消方案余量的起始版本：engine-v2.1.1。 */
const BUSINESS_NO_HEADROOM: [number, number, number] = [2, 1, 1];

function parse(version: unknown): [number, number, number] | null {
  const m = /engine-v(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * 该快照的业务池是否仍含方案余量（即 engine-v2.1.0 及更早）。
 *
 * 结果快照不可变：旧 run 的 `cards_planned` 是 `max(8, ceil(N × (1+h) / 8) × 8)` 的产物，
 * 若沿用新口径写成「补偶后」，70 张会显示成「补偶后 88 张」，把余量讲成补偶。
 * 无版本号（测试夹具、本地构造对象）按当前口径处理。
 */
export function businessHasHeadroom(report: Obj | null | undefined): boolean {
  const version = parse(report?.engine_version);
  if (!version) return false;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== BUSINESS_NO_HEADROOM[i]) return version[i] < BUSINESS_NO_HEADROOM[i];
  }
  return false;
}
