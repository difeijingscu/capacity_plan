/** 引擎版本判定：同一个数字在不同版本的快照里含义不同，展示文案必须跟着版本走。 */
import type { Obj } from './api';

/** 业务池取消方案余量的起始版本：engine-v2.1.1。 */
const BUSINESS_NO_HEADROOM: [number, number, number] = [2, 1, 1];
/** 创新/研发池取消方案余量与 +1 故障冗余的起始版本：engine-v2.2.0。 */
const POOL_NO_HEADROOM: [number, number, number] = [2, 2, 0];

function parse(version: unknown): [number, number, number] | null {
  const m = /engine-v(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function before(report: Obj | null | undefined, limit: [number, number, number]): boolean {
  const version = parse(report?.engine_version);
  if (!version) return false;
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== limit[i]) return version[i] < limit[i];
  }
  return false;
}

/**
 * 该快照的业务池是否仍含方案余量（即 engine-v2.1.0 及更早）。
 *
 * 结果快照不可变：旧 run 的 `cards_planned` 是 `max(8, ceil(N × (1+h) / 8) × 8)` 的产物，
 * 若沿用新口径写成「补偶后」，70 张会显示成「补偶后 88 张」，把余量讲成补偶。
 * 无版本号（测试夹具、本地构造对象）按当前口径处理。
 */
export function businessHasHeadroom(report: Obj | null | undefined): boolean {
  return before(report, BUSINESS_NO_HEADROOM);
}

/**
 * 该快照的创新/研发池是否仍含方案余量与 +1 张故障冗余（engine-v2.2.0 之前）。
 *
 * 同样的理由：旧 run 的 `planned_p = base_p × 1.2`、`cards_planned = max(cards+1, 余量卡数)`，
 * 标成「建议容量」会让人以为引擎建议多留 20%。
 */
export function poolHasHeadroom(report: Obj | null | undefined): boolean {
  return before(report, POOL_NO_HEADROOM);
}

/** 三池是否都完全不叠余量（engine-v2.2.0 起），用于总量脚注选词。 */
export function hasNoPoolHeadroom(report: Obj | null | undefined): boolean {
  return !businessHasHeadroom(report) && !poolHasHeadroom(report);
}
