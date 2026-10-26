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
  if (n === 0) return '0 T16';
  return n >= 1 ? Number(n.toPrecision(3)) + ' P16' : Number((n * 1000).toPrecision(3)) + ' T16';
}
export function num(value: unknown, digits = 2) {
  return value === null || value === undefined ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
}
export const poolNames: Obj = { business: '业务场景', innovation: '创新服务', development: '开发测试' };
export const typeNames: Obj = { text: '文本模型', vlm: '多模态理解', cv: 'CV 目标检测', unit: '其他任务', native: '原生精度容量' };
export const stateNames: Obj = { COMPLETE: '已完成估算', PARTIAL: '部分已计入', BLOCKED: '待补充参数', DISABLED: '未启用', PROXY: '经验代理', WEIGHT_LOWER_BOUND: '仅显存下界', UNKNOWN: '待核验' };
