export type Obj = Record<string, any>;
export async function api(path: string, method = 'GET', body?: unknown): Promise<any> {
  const response = await fetch('/api/v1' + path, {
    method, headers: body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) {
    throw new Error(value.message || (typeof value.detail === 'string' ? value.detail : '请求未完成，请检查输入'));
  }
  return value;
}
export async function waitJob(id: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const job = await api('/jobs/' + id);
    if (job.status === 'SUCCEEDED') return job.result;
    if (['FAILED', 'INTERRUPTED', 'CANCELLED'].includes(job.status)) throw new Error(job.error || '任务未完成');
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('等待任务超时，请稍后在历史记录中查看');
}
export function capacity(value: unknown) {
  if (value === null || value === undefined) return '待补充';
  const n = Number(value);
  // 单位只表达量级（P = 10^15 FLOPS，T = 10^12 FLOPS）；精度基准（BF16/FP16/FP8）由所在列或说明单独标注。
  if (n === 0) return '0 T';
  return n >= 1 ? Number(n.toPrecision(3)) + ' P' : Number((n * 1000).toPrecision(3)) + ' T';
}
export function num(value: unknown, digits = 2) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}
/**
 * 生成 32 位十六进制 id。
 * 不能直接用 crypto.randomUUID：它只在安全上下文（https 或 localhost）存在，
 * 用局域网 IP / 反向代理以 http 打开时是 undefined，调用即抛 TypeError，
 * 事件回调里的异常不会显示在页面上，表现就是「点了按钮没反应」。getRandomValues 无此限制。
 */
export function uid(): string {
  const box = globalThis.crypto as Crypto | undefined;
  if (typeof box?.randomUUID === 'function') return box.randomUUID().replaceAll('-', '');
  const bytes = new Uint8Array(16);
  if (typeof box?.getRandomValues === 'function') box.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
export const poolNames: Obj = { business: '业务场景', innovation: '创新服务', development: '开发测试' };
export const typeNames: Obj = { text: '文本模型', vlm: '多模态理解', cv: 'CV 目标检测', unit: '其他任务', native: '原生精度容量' };
export const stateNames: Obj = { COMPLETE: '已完成估算', PARTIAL: '部分已计入', BLOCKED: '待补充参数', DISABLED: '未启用', PROXY: '经验代理', WEIGHT_LOWER_BOUND: '仅显存下界', UNKNOWN: '待核验' };
