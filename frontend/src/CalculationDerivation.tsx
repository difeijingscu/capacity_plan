import { useEffect, useState } from 'react';
import { Alert, Button, Card, Collapse, Descriptions, Drawer, Pagination, Space, Spin, Table, Tag } from 'antd';
import { api, capacity, num, stateNames } from './api';
import type { Obj } from './api';

function valueText(value: unknown) {
  if (value == null) return '待补充';
  const text = String(value);
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return text;
  const n = Number(text);
  return n !== 0 && Math.abs(n) < 0.000001 ? n.toExponential(6) : num(n, 6);
}
function Inputs({ rows }: { rows: Obj[] }) {
  return <Descriptions className="derivation-inputs" size="small" column={{ xs: 1, sm: 2 }} items={rows.map((r, i) => ({
    key: i, label: r.label, children: <div>{valueText(r.value)}{r.unit && ' ' + r.unit}{r.note && <small>{r.note}</small>}</div>,
  }))} />;
}
function Steps({ rows }: { rows: Obj[] }) {
  return <ol className="derivation-steps">{rows.map((r, i) => <li key={i}>
    <h4><span>{i + 1}</span>{r.title}</h4><div className="derivation-equation">{r.formula}</div>
    <div className="derivation-substitution"><span>代入本次数值</span><code>{r.substitution}</code></div>
    <div className="derivation-step-result">结果 <strong>{valueText(r.value)}{r.value != null && r.unit && ' ' + r.unit}</strong></div>
    {r.note && <p className="derivation-note">{r.note}</p>}
  </li>)}</ol>;
}

export default function CalculationDerivation({ runId, scope, stale, onClose }: {
  runId?: string; scope: string | null; stale: boolean; onClose: () => void;
}) {
  const [data, setData] = useState<Obj | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [taskPage, setTaskPage] = useState(1);
  useEffect(() => {
    if (!runId || !scope) return;
    let cancelled = false;
    setData(null); setError(''); setTaskPage(1);
    void api('/calculations/' + runId + '/derivation?scope=' + scope).then(result => {
      if (!cancelled) setData(result);
    }).catch(e => { if (!cancelled) setError((e as Error).message); });
    return () => { cancelled = true; };
  }, [runId, scope, retry]);
  const view = data?.run_id === runId && data?.scope === scope ? data : null;
  const taskItems = view?.items?.slice((taskPage - 1) * 10, taskPage * 10) || [];
  return <Drawer className="calculation-derivation" width={980} open={!!scope} onClose={onClose} title={view?.title || '计算推导'} destroyOnHidden>
    {error ? <Alert type="error" showIcon message="计算推导未能加载" description={error} action={<Button onClick={() => setRetry(x => x + 1)}>重试</Button>} /> :
      !view ? <div className="derivation-loading"><Spin tip="正在读取本次测算快照"><div /></Spin></div> : <div className="derivation-content">
        <Space wrap><Tag>方案修订 {view.plan_revision}</Tag><Tag color={view.completeness === 'COMPLETE' ? 'green' : 'orange'}>{stateNames[view.completeness]}</Tag><span className="muted">测算时间 {new Date(view.created_at).toLocaleString('zh-CN')}</span></Space>
        {stale && <Alert type="warning" showIcon message="当前输入已变更，以下推导来自所选历史测算快照" description="尚未测算的新输入不会混入此处。请重新测算后查看对应的新结果。" />}
        <div className="derivation-summary"><span>本次保存的建议容量</span><strong>{capacity(view.planned_p)}</strong><small>快照值：{valueText(view.planned_p)}{view.planned_p != null && ' P'} · 基础容量：{valueText(view.base_p)}{view.base_p != null && ' P'}</small></div>
        {view.completeness === 'DISABLED' && <Alert type="info" showIcon message="本次方案未启用此资源池" description="该资源池计入总量为0，没有任务推导。" />}
        {view.missing_items.length > 0 && <Alert type="warning" showIcon message="以下需求尚未完整计入，当前数值仅代表已计入部分" description={<ul>{view.missing_items.map((r: Obj, i: number) => <li key={i}>{r.name || r.id}：{r.message}</li>)}</ul>} />}
        <Card size="small" title="本次输入与共同口径"><Inputs rows={view.inputs} /></Card>
        {view.steps.length > 0 && <Card size="small" title={scope === 'total' ? '总量汇总与余量' : '资源池推导与汇总'}><Steps rows={view.steps} /></Card>}
        {view.breakdown.length > 0 && <Card size="small" title={scope === 'total' ? '三类资源池的数值组成' : '各场景的数值组成'}><Table<Obj> rowKey="id" size="small" pagination={{ pageSize: 10, hideOnSinglePage: true }} dataSource={view.breakdown} scroll={{ x: 580 }} columns={[
          { title: '名称', dataIndex: 'name' }, { title: '基础容量', dataIndex: 'base_p', render: capacity },
          { title: '建议容量（已含余量）', dataIndex: 'planned_p', render: capacity }, { title: '状态', dataIndex: 'completeness', render: v => stateNames[v] || v },
        ]} /></Card>}
        {view.items.length > 0 && <Card size="small" title={scope === 'development' ? '单任务计算：候选模型与微调' : '逐项展开：输入、公式与代入数值'}>
          <Collapse key={view.run_id + view.scope + taskPage} defaultActiveKey={taskItems.length ? [taskItems[0].id] : []} items={taskItems.map((item: Obj) => ({
            key: item.id, label: <div className="derivation-task-label"><span>{item.name}</span><strong>{capacity(item.base_p)} · 单任务基础</strong></div>,
            children: <><p className="derivation-note">模型：{item.model || '自定义任务'}{item.revision && ' · 固定版本：' + item.revision}</p>
              <Inputs rows={item.inputs} /><Steps rows={item.steps} />
              {item.notes.map((note: string, i: number) => <p className="derivation-note" key={i}>{note}</p>)}
              {/^https?:\/\//.test(item.source || '') && <a href={item.source} target="_blank" rel="noreferrer">查看本次模型或基线来源 ↗</a>}
            </>,
          }))} />
          {view.items.length > 10 && <Pagination className="derivation-pagination" current={taskPage} pageSize={10} total={view.items.length} showSizeChanger={false} onChange={setTaskPage} />}
        </Card>}
        <Card size="small" title="如何理解这些数值">{view.notes.map((note: string, i: number) => <p className="derivation-note" key={i}>{note}</p>)}</Card>
      </div>}
  </Drawer>;
}
