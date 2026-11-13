import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Alert, Button, Card, Checkbox, Collapse, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Spin, Switch, Table, Tabs, Tag, Tooltip, Upload, App as AntApp } from 'antd';
import { AppstoreOutlined, ArrowRightOutlined, ApartmentOutlined, BarChartOutlined, BookOutlined, BuildOutlined, CheckCircleOutlined, CloudUploadOutlined, CopyOutlined, DatabaseOutlined, DownOutlined, DeleteOutlined, ExperimentOutlined, FileTextOutlined, FundOutlined, HistoryOutlined, InfoCircleOutlined, PlusOutlined, ReloadOutlined, SaveOutlined, SettingOutlined, ThunderboltFilled, UndoOutlined } from '@ant-design/icons';
import * as echarts from 'echarts';
import { api, capacity, num, poolNames, stateNames, typeNames, waitJob } from './api';
import type { Obj } from './api';
import BusinessPage from './BusinessPage';
import InferenceParamsPage from './InferenceParamsPage';
import PlanningBasis from './PlanningBasis';
import PlanningOrganization from './PlanningOrganization';
import CalculationDerivation from './CalculationDerivation';
import InferencePage from './InferencePage';
import PlaceholderPage from './PlaceholderPage';
import CabinetLayoutPage from './CabinetLayoutPage';
import RoiAnalysisPage from './RoiAnalysisPage';
import RoomPowerPage from './RoomPowerPage';
import RoomLiquidCoolingPage from './RoomLiquidCoolingPage';
import RoomMicroModulePage from './RoomMicroModulePage';
import RoomDcLayoutPage from './RoomDcLayoutPage';
import Room3dLayoutPage from './Room3dLayoutPage';

// 二级菜单
const planningItems = [
  ['projects', '项目概览', <AppstoreOutlined aria-hidden="true" />],
  ['business', '业务场景', <FileTextOutlined aria-hidden="true" />],
  ['innovation', '创新服务', <ThunderboltFilled aria-hidden="true" />],
  ['development', '开发测试', <ExperimentOutlined aria-hidden="true" />],
  ['results', '测算结果', <BarChartOutlined aria-hidden="true" />],
  ['basis', '规划依据', <BookOutlined aria-hidden="true" />],
  ['settings', '基线与设置', <SettingOutlined aria-hidden="true" />],
] as const;
const roomItems = [
  ['room-dc-layout', '数据中心布局示意图'],
  ['room-3d-layout', '机房立体布局'],
  ['room-power', '机房供电'],
  ['room-liquid-cooling', '机房液冷层高承重'],
  ['room-micro-module', '液冷微模块布局'],
] as const;
// 一级菜单（分组；items 为空表示无二级菜单的单页）
const navGroups = [
  { id: 'planning', label: '算力规划', icon: <DatabaseOutlined aria-hidden="true" />, items: planningItems },
  { id: 'room', label: '机房布局', icon: <ApartmentOutlined aria-hidden="true" />, items: roomItems },
  { id: 'cabinet', label: '机柜布局', icon: <BuildOutlined aria-hidden="true" />, items: null },
  { id: 'roi', label: 'ROI 分析', icon: <FundOutlined aria-hidden="true" />, items: null },
] as const;
// 所有可路由页面 → 标题（二级菜单 + 分组根页 + 独立页）
const pageTitles: Record<string, string> = {
  ...Object.fromEntries(planningItems.map(([id, label]) => [id, label])),
  ...Object.fromEntries(roomItems.map(([id, label]) => [id, label])),
  cabinet: '机柜布局',
  roi: 'ROI 分析',
  inference: '推理评估',
  organization: '规划方案组织设计',
};
const groupOfPage = (page: string): string | null => {
  if ((planningItems as readonly (readonly [string, ...unknown[]])[]).some(i => i[0] === page) || page === 'organization') return 'planning';
  if ((roomItems as readonly (readonly [string, ...unknown[]])[]).some(i => i[0] === page)) return 'room';
  if (page === 'cabinet' || page === 'roi') return page;
  return null;
};
// 待补充内容的页面说明（后续提供内容时替换 PlaceholderPage）
const placeholderNotes: Record<string, string> = {
  'room-power': '机房供电：UPS、配电、双路冗余与机柜功率密度规划。',
  'room-liquid-cooling': '机房液冷层高承重：液冷管路、楼板承重与净空高度校核。',
  'room-micro-module': '液冷微模块布局：微模块单元、CDU 与冷量分配。',
  roi: 'ROI 分析：算力投入、折旧与业务收益的回收周期测算。',
};
// 内容待补充的页面（走 PlaceholderPage，不显示方案操作区）；当前均已接入正式内容
const placeholderPages = [] as const;
const clone = <T,>(value: T): T => structuredClone(value);

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <div className="field"><label>{label}{hint && <Tooltip title={hint}><InfoCircleOutlined aria-hidden="true" /></Tooltip>}</label>{children}</div>;
}
function Chart({ pools }: { pools: Obj[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chart.setOption({ color: ['#176658', '#79af92', '#d9ad63'], tooltip: { trigger: 'item', formatter: (p: Obj) => p.name + '：' + capacity(p.value) }, legend: { bottom: 0, icon: 'circle' }, series: [{ type: 'pie', radius: ['58%', '78%'], center: ['50%', '44%'], label: { show: false }, data: pools.filter(p => Number(p.planned_p) > 0).map(p => ({ name: poolNames[p.id], value: Number(p.planned_p) })) }] });
    const observer = new ResizeObserver(() => chart.resize()); observer.observe(ref.current);
    return () => { observer.disconnect(); chart.dispose(); };
  }, [pools]);
  return <div ref={ref} style={{ height: 260 }} aria-label="三个资源池算力占比图" />;
}

export default function App() {
  const { message } = AntApp.useApp();
  const [page, setPage] = useState('projects');
  const [projects, setProjects] = useState<Obj[]>([]);
  const [archived, setArchived] = useState(false);
  const [plan, setPlan] = useState<Obj | null>(null);
  const [payload, setPayload] = useState<Obj | null>(null);
  const [dirty, setDirty] = useState(false);
  const [models, setModels] = useState<Obj[]>([]);
  const [cards, setCards] = useState<Obj[]>([]);
  const [defaults, setDefaults] = useState<Obj>({});
  const [settings, setSettings] = useState<Obj>({});
  const [runs, setRuns] = useState<Obj[]>([]);
  const [activeRun, setActiveRun] = useState<Obj | null>(null);
  const [loading, setLoading] = useState(false);
  const [calculating, setCalculating] = useState(false);
  const [previewReport, setPreviewReport] = useState<Obj | null>(null);
  const [inferenceCatalog, setInferenceCatalog] = useState<Obj | null>(null);
  const [inferenceLoading, setInferenceLoading] = useState(false);
  const [traceItem, setTraceItem] = useState<Obj | null>(null);
  const [derivationScope, setDerivationScope] = useState<string | null>(null);
  const [projectModal, setProjectModal] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [importModal, setImportModal] = useState(false);
  const [importText, setImportText] = useState('');
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<Obj | null>(null);
  const [importSheet, setImportSheet] = useState<string | undefined>();
  const [headerRow, setHeaderRow] = useState(1);
  const [columnMapping, setColumnMapping] = useState<Obj>({});
  const [onlineSemantics, setOnlineSemantics] = useState(false);
  const [importStrategy, setImportStrategy] = useState('append');
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<Obj | null>(null);
  const [costs, setCosts] = useState<Obj | null>(null);
  const [priceModal, setPriceModal] = useState(false);
  const [priceDraft, setPriceDraft] = useState<Obj>({});
  const [modelDraft, setModelDraft] = useState('');
  const [modelModal, setModelModal] = useState(false);
  const [catalogAll, setCatalogAll] = useState<Obj[]>([]);
  const [selectedRows, setSelectedRows] = useState<React.Key[]>([]);
  const [baselineList, setBaselineList] = useState<Obj[]>([]);
  const [baselineModal, setBaselineModal] = useState(false);
  const [baselineDraft, setBaselineDraft] = useState('');
  const [openGroups, setOpenGroups] = useState<string[]>(['planning']);

  const guard = async (action: () => Promise<any>) => { try { return await action(); } catch (error) { message.error((error as Error).message); return undefined; } };
  const refreshProjects = async () => setProjects(await api('/projects?archived=' + archived));
  const refreshCatalog = async () => {
    const [ms, cs, all, bs] = await Promise.all([api('/catalog/models'), api('/catalog/cards'), api('/catalog/models?include_drafts=true'), api('/catalog/baselines')]);
    setModels(ms); setCards(cs); setCatalogAll(all); setBaselineList(bs);
  };
  const refreshInferenceCatalog = async () => {
    setInferenceLoading(true);
    try {
      setInferenceCatalog(await api('/inference/catalog'));
    } finally { setInferenceLoading(false); }
  };
  useEffect(() => { void guard(async () => { await Promise.all([refreshProjects(), refreshCatalog(), refreshInferenceCatalog()]); setDefaults(await api('/defaults')); setSettings(await api('/settings')); }); }, []);
  useEffect(() => { if (page === 'business' || page === 'innovation' || page === 'development') void guard(async () => { if (!inferenceCatalog) await refreshInferenceCatalog(); }); }, [page]);
  useEffect(() => { void guard(refreshProjects); }, [archived]);
  useEffect(() => { const handler = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [dirty]);
  // 当前页面所属分组自动展开，避免从其他入口跳转后看到折叠的菜单
  useEffect(() => { const g = groupOfPage(page); if (g) setOpenGroups(list => list.includes(g) ? list : [...list, g]); }, [page]);

  useEffect(() => {
    if (!payload || page !== 'business') return;
    let cancelled = false;
    setPreviewReport(null);
    const timer = setTimeout(() => { void api('/preview-calculation', 'POST', {payload}).then(r => { if (!cancelled) setPreviewReport(r); }).catch(() => { if (!cancelled) setPreviewReport(null); }); }, 650);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [payload, page]);

  function edit(mutator: (p: Obj) => void) { if (!payload) return; const p = clone(payload); mutator(p); setPayload(p); setDirty(true); }
  async function loadPlan(id: string) {
    setLoading(true);
    try { if (dirty && plan?.id !== id) await save(); const p = await api('/plans/' + id); const projectRuns = await api('/projects/' + p.project_id + '/calculations'); const historicalCosts = p.calculations[0] ? await api('/calculations/' + p.calculations[0].id + '/costs') : []; setPlan(p); setPayload(p.payload); setDirty(false); setRuns(projectRuns);  setCosts(historicalCosts[0] || null); setActiveRun(p.calculations[0] || null); }
    finally { setLoading(false); }
  }
  async function save() {
    if (!plan || !payload) return null;
    if (!dirty) return plan;
    const p = await api('/plans/' + plan.id, 'PATCH', { expected_revision: plan.revision, payload });
    setPlan(p); setPayload(p.payload); setDirty(false); void refreshProjects(); return p;
  }
  async function calculate() {
    setCalculating(true);
    try {
      const p = await save(); if (!p) return;
      const response = await api('/plans/' + p.id + '/calculate', 'POST', { plan_revision: p.revision });
      const done = response.run_id ? response : await waitJob(response.job_id);
      const r = await api('/calculations/' + done.run_id); setActiveRun(r); setRuns(old => [r, ...old.filter(x => x.id !== r.id)]); setCosts(null); setPage('results');
      message.success(r.result.completeness === 'COMPLETE' ? '测算完成，结果已保存' : '已保存可计算部分，请补充未计入任务');
    } finally { setCalculating(false); }
  }
  const currentProject = projects.find(p => p.id === plan?.project_id);
  const report = activeRun?.result;
  const stale = !!activeRun && (dirty || (activeRun.plan_revision !== plan?.revision || activeRun.plan_id !== plan?.id));
  const modelLabel = (id: string) => models.find(m => m.id === id)?.display_name || id || '未选择';
  /** v2 创新/研发池按推理目录选模型（32 条 LLM + 自定义）；旧 id 由后端 match_model_key 迁移。 */
  const inferenceModels = [...(inferenceCatalog?.models ?? []), ...(inferenceCatalog?.custom_models ?? [])];
  const inferenceModelOptions = inferenceModels.map((m: Obj) => ({ value: m.key, label: (m.label || m.key) + (m.custom ? ' · 自定义' : '') }));
  const inferenceModelLabel = (id: string) => {
    const hit = inferenceModels.find((m: Obj) => m.key === id);
    return hit ? (hit.label || hit.key) : modelLabel(id);
  };
  async function createProject(isDemo = false) {
    const response = isDemo ? await api('/demo', 'POST', {}) : await api('/projects', 'POST', { name: projectName });
    await refreshProjects(); await loadPlan(response.plan.id); setProjectModal(false); setProjectName(''); setPage('business');
  }
  async function previewImport() {
    const form = new FormData();
    if (importFile) form.append('file', importFile); else form.append('text', importText);
    if (importSheet) form.append('sheet', importSheet);
    form.append('header_row', String(headerRow)); form.append('column_mapping', JSON.stringify(columnMapping)); form.append('confirm_online_semantics', String(onlineSemantics));
    setImportPreview(await api('/imports/preview', 'POST', form));
  }
  async function commitImport() {
    const p = await save(); if (!p || !importPreview) return;
    const result = await api('/imports/' + importPreview.id + '/commit', 'POST', { plan_id: p.id, expected_revision: p.revision, strategy: importStrategy, idempotency_key: importPreview.id });
    setPlan(result); setPayload(result.payload); setDirty(false); setImportModal(false); setImportPreview(null); message.success('场景清单已导入'); await refreshProjects();
  }
  const stat = (label: string, value: ReactNode, note: string, accent = '', scope = 'total') => <button type="button" className={'metric metric-interactive ' + accent} aria-label={'查看' + label + '计算推导'} aria-haspopup="dialog" aria-expanded={derivationScope === scope} onClick={() => setDerivationScope(scope)}><span>{label}</span><strong>{value}</strong><small>{note}</small><em className="metric-derivation-hint">查看计算推导 <DownOutlined aria-hidden="true" /></em></button>;

  function projectsPage() {
    return <>
      <div className="hero"><div><div className="eyebrow">CAPACITY SANDBOX / WORKSPACE</div><h1>推演算力空间，洞见投资回报。</h1><p>从业务场景出发，推演业务、创新与研发所需的算力规模。</p><div className="hero-guide-links"><Button className="hero-basis-link" type="link" icon={<BookOutlined aria-hidden="true" />} onClick={() => setPage('basis')}>规划思路和依据 <ArrowRightOutlined aria-hidden="true" /></Button><Button className="hero-basis-link" type="link" icon={<ApartmentOutlined aria-hidden="true" />} onClick={() => setPage('organization')}>规划方案组织设计 <ArrowRightOutlined aria-hidden="true" /></Button></div><Space><Button type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={() => setProjectModal(true)}>新建规划项目</Button><Button onClick={() => void guard(() => createProject(true))}>载入示例项目 <ArrowRightOutlined aria-hidden="true" /></Button></Space></div><div className="hero-art" aria-hidden><div className="chip"><ThunderboltFilled aria-hidden="true" /><span>COMPUTE</span></div><span className="orbit one" /><span className="orbit two" /><div className="hero-label">业务 × 模型 × 规模</div></div></div>
      <div className="section-title"><h2>规划项目 <span>{projects.length}</span></h2><Checkbox checked={archived} onChange={e => setArchived(e.target.checked)}>查看已归档</Checkbox></div>
      <div className="project-grid">{projects.map(p => <Card key={p.id} className="project-card"><div className="project-icon"><DatabaseOutlined aria-hidden="true" /></div><h3>{p.name}</h3><p>{p.plans.length} 个方案 · 单用户工作空间</p><div className="plan-links">{p.plans.map((v: Obj) => <Button key={v.id} type={plan?.id === v.id ? 'primary' : 'default'} size="small" onClick={() => void guard(async () => { await loadPlan(v.id); setPage('business'); })}>{v.label}</Button>)}</div><div className="project-bottom"><small>{new Date(p.updated_at).toLocaleDateString('zh-CN')}</small><Button type="text" size="small" onClick={() => void guard(async () => { await api('/projects/' + p.id, 'PATCH', { archived: !archived, expected_revision: p.revision }); await refreshProjects(); })}>{archived ? '恢复项目' : '归档'}</Button></div></Card>)}</div>
      {!projects.length && <div className="empty-panel"><Empty description="建立第一个规划项目，或载入示例体验完整流程。" /></div>}
      <div className="method-strip">{[['01', '导入业务清单', 'Excel 或文字，一次整理所有场景'], ['02', '确认规模与模型', '少量业务输入，技术细节提供默认值'], ['03', '得到可解释的结果', '三类资源池独立测算，逐项追溯依据']].map(([n, title, text]) => <div key={n}><b>{n}</b><section><strong>{title}</strong><p>{text}</p></section></div>)}</div>
    </>;
  }


  function businessPage() {
    return <BusinessPage payload={payload!} edit={edit} catalog={inferenceCatalog} legacyModels={models}
      catalogLoading={inferenceLoading} preview={previewReport}
      refreshCatalog={refreshInferenceCatalog} onImport={() => setImportModal(true)} />;
  }

  function innovationPage() {
    const c = payload!.innovation;
    function change(key: string, value: unknown) { edit(p => p.innovation[key] = value); }
    const totalShare = c.allocations.reduce((sum: number, a: Obj) => sum + Number(a.share), 0);
    return <><Card className="pool-intro"><div><span className="eyebrow">INNOVATION POOL</span><h2>把创新额度，转换为可规划的资源。</h2><p>每位用户拥有一份月度总 Token 额度，再按比例分配给所选模型。</p></div><Switch checked={c.enabled} checkedChildren="已启用" unCheckedChildren="未启用" onChange={v => change('enabled', v)} /></Card><Card title="月度服务规模"><div className="form-grid"><Field label="支持人数"><InputNumber aria-label="创新支持人数" min={0} value={c.users == null ? null : Number(c.users)} onChange={v => change('users', v)} addonAfter="人" /></Field><Field label="每人每月总 Token" hint="包含输入与总生成Token，推理Token已计入时不再额外相乘。"><InputNumber aria-label="每人月Token" min={0} value={c.quota_per_user_month == null ? null : Number(c.quota_per_user_month)} onChange={v => change('quota_per_user_month', v)} /></Field><div className="quota-summary"><span>全池月度额度</span><strong>{num(c.users == null || c.quota_per_user_month == null ? null : Number(c.users) * Number(c.quota_per_user_month))}</strong><small>Token / 月 · 分配前总额</small></div></div><div className="section-title"><h3>模型与额度分配</h3><Tag color={Math.abs(totalShare - 1) < 1e-6 ? 'green' : 'orange'}>已分配 {num(totalShare * 100)}%</Tag></div><Select mode="multiple" aria-label="创新服务模型" style={{ width: '100%', marginBottom: 18 }} placeholder="选择提供创新服务的模型" options={inferenceModelOptions} value={c.allocations.map((a: Obj) => a.model_id)} onChange={ids => edit(p => { p.innovation.allocations = ids.map((id: string) => ({ model_id: id, share: 1 / ids.length, input_fraction: .8, request_total_tokens: 2560 })); })} /><Table<Obj> rowKey="model_id" pagination={false} dataSource={c.allocations} columns={[
      { title: '模型', dataIndex: 'model_id', render: inferenceModelLabel },
      { title: 'Token 份额', render: (_: unknown, a: Obj) => <InputNumber aria-label={'额度份额-' + a.model_id} min={0} max={100} value={Number(a.share) * 100} addonAfter="%" onChange={v => edit(p => { p.innovation.allocations.find((x: Obj) => x.model_id === a.model_id).share = Number(v) / 100; })} /> },
      { title: '输入Token占比', render: (_: unknown, a: Obj) => <InputNumber min={0} max={100} value={Number(a.input_fraction) * 100} addonAfter="%" onChange={v => edit(p => { p.innovation.allocations.find((x: Obj) => x.model_id === a.model_id).input_fraction = Number(v) / 100; })} /> },
    ]} /><div className="note-line">选择模型后会先均分份额；确认后可自行调整，合计须为100%。</div><Collapse items={[{ key: 'advanced', label: '服务时间与峰值参数（默认值可修改）', children: <div className="form-grid">{[['service_days', '每月服务日数'], ['service_hours_per_day', '每日服务小时'], ['peak_factor', '峰值倍数']].map(([key, label]) => <Field key={key} label={label}><InputNumber min={.01} value={Number(c[key])} onChange={v => change(key, v)} /></Field>)}<Field label="额度使用率"><InputNumber min={0} max={100} value={Number(c.usage_ratio) * 100} addonAfter="%" onChange={v => change('usage_ratio', Number(v) / 100)} /></Field><Field label="算力芯片（折算卡数）" hint="与业务池共用同一套芯片规格，两池卡数才可比。"><Select aria-label="创新池算力芯片" style={{ width: '100%' }} value={c.chip_key || undefined} placeholder="未选择则本池不出卡数" allowClear options={(inferenceCatalog?.chips || []).map((x: Obj) => ({ value: x.key, label: x.label }))} onChange={v => change('chip_key', v ?? null)} /></Field></div> }]} /></Card><Alert className="below" type="info" showIcon message="默认22日 × 每天8小时、峰值3倍、额度全部兑现；这些参数属于经验假设，按期末规模计算。" /></>;
  }

  function developmentPage() {
    const c = payload!.development; const preset = defaults.intensities?.[c.intensity] || {};
    function change(key: string, value: unknown) { edit(p => p.development[key] = value); }
    const fields = [['train_data_tokens', '每任务微调数据 Token'], ['epochs', '训练轮数'], ['train_deadline_hours', '微调完成时间（小时）'], ['sequence_length', '训练序列长度'], ['train_slots', '同时微调槽位']];
    return <><Card className="pool-intro"><div><span className="eyebrow">DEVELOPMENT POOL</span><h2>为模型实验，保留合适的空间。</h2><p>只规划模型微调，不含效果评测；按可并行微调任务的能力配置资源。</p></div><Switch checked={c.enabled} checkedChildren="已启用" unCheckedChildren="未启用" onChange={v => change('enabled', v)} /></Card><Card title="模型与开发测试强度"><div className="intensity-grid">{[['light', '轻度', '少量实验，单个微调任务排队'], ['standard', '标准', '常态化实验，按标准数据与轮次规划'], ['high', '高强度', '多任务并行，更大的数据与更短窗口']].map(([id, name, note]) => <button key={id} className={'intensity-card ' + (c.intensity === id ? 'chosen' : '')} onClick={() => change('intensity', id)}><ExperimentOutlined aria-hidden="true" /><strong>{name}</strong><p>{note}</p>{c.intensity === id && <CheckCircleOutlined aria-hidden="true" className="chosen-check" />}</button>)}</div><Field label="需要支持的模型"><Select aria-label="开发测试模型" mode="multiple" style={{ width: '100%' }} value={c.models.map((m: Obj) => m.model_id)} options={inferenceModelOptions} onChange={ids => edit(p => { p.development.models = ids.map((id: string) => c.models.find((m: Obj) => m.model_id === id) || { model_id: id, method: 'lora' }); })} /></Field><Table<Obj> rowKey="model_id" pagination={false} dataSource={c.models} columns={[{ title: '候选模型', dataIndex: 'model_id', render: inferenceModelLabel }, { title: '微调方法', render: (_: unknown, m: Obj) => <Select value={m.method} options={[{ value: 'lora', label: 'LoRA' }, { value: 'qlora', label: 'QLoRA（需要量化基线）' }]} onChange={v => edit(p => { p.development.models.find((x: Obj) => x.model_id === m.model_id).method = v; })} style={{ width: 230 }} /> }]} /><div className="note-line"><InfoCircleOutlined aria-hidden="true" /> 候选模型共用任务槽位，不会因多选一个模型自动增加一整套常驻资源。</div><Collapse items={[{ key: 'dev', label: '展开强度档位的具体任务参数', children: <><div className="form-grid">{fields.map(([key, label]) => <Field key={key} label={label}><InputNumber aria-label={label} min={1} value={c[key] == null ? Number(preset[key]) : Number(c[key])} onChange={v => change(key, v)} /></Field>)}</div><Button type="link" onClick={() => edit(p => { fields.forEach(([key]) => p.development[key] = null); })}>恢复当前档位默认值</Button></> }, { key: 'chip', label: '算力芯片（折算卡数）', children: <Field label="算力芯片" hint="训练与推理共用同一张卡的算力与显存，两池卡数才可比。"><Select aria-label="开发池算力芯片" style={{ width: '100%' }} value={c.chip_key || undefined} placeholder="未选择则本池不出卡数" allowClear options={(inferenceCatalog?.chips || []).map((x: Obj) => ({ value: x.key, label: x.label }))} onChange={v => change('chip_key', v ?? null)} /></Field> }]} /></Card></>;
  }

  function resultsPage() {
    if (!report) return <Card><Empty description="确认输入后，开始第一次测算。" /><div className="center"><Button type="primary" loading={calculating} onClick={() => void guard(calculate)}>开始测算</Button></div></Card>;
    const rows = report.pools.flatMap((p: Obj) => p.items.map((item: Obj) => ({ ...item, pool_id: p.id })));
    return <><div className="result-toolbar"><div><Tag color={report.completeness === 'COMPLETE' ? 'green' : 'orange'}>{stateNames[report.completeness]}</Tag><span className="muted">已计入 {report.counted_tasks} / {report.total_tasks} 个任务 · 修订 {activeRun!.plan_revision}</span>{report.is_demo && <Tag color="gold">示例数据</Tag>}{stale && <Tag color="orange">输入已变更，结果为历史快照</Tag>}</div><Select aria-label="历史计算版本" value={activeRun!.id} style={{ width: 260 }} options={runs.map(r => ({ value: r.id, label: (r.plan_label || plan?.label || '方案') + ' · 修订 ' + r.plan_revision + ' · ' + new Date(r.created_at).toLocaleString('zh-CN') }))} onChange={id => { setActiveRun(runs.find(r => r.id === id)!); setCosts(null); }} /></div><div className="metric-grid">{stat(report.completeness === 'COMPLETE' ? '建议规划总算力' : '已计入部分的建议算力', capacity(report.total_planned_p), '参考 BF16 稠密等效 · 含' + num(Number(report.headroom) * 100) + '%余量', 'primary')}{report.pools.map((p: Obj) => p.cards_planned != null ? stat(poolNames[p.id], num(p.cards_planned, 0) + ' 张', '含余量 · 需求算力 ' + capacity(p.planned_p), '', p.id) : stat(poolNames[p.id], capacity(p.planned_p), p.completeness === 'DISABLED' ? '本方案未启用' : stateNames[p.completeness], '', p.id))}</div>
      {report.missing_items.length > 0 && <Alert className="below" type="warning" showIcon message="以下任务尚未计入完整总量" description={<ul>{report.missing_items.map((m: Obj) => <li key={m.id}>{m.name || poolNames[m.pool_id]}：{m.message}</li>)}</ul>} />}
      <div className="result-grid"><Card title="资源池结构"><Chart pools={report.pools} /></Card><Card title="规划依据"><Descriptions column={1} size="small" items={[{ key: 'a', label: '基础规划算力', children: capacity(report.total_base_p) }, { key: 'b', label: '计算精度', children: 'BF16 稠密等效参考口径' }, { key: 'c', label: '依据等级', children: <Tag color="gold">C · 经验估算</Tag> }, { key: 'd', label: '响应时间', children: '目标尚未经过性能实测验证' }, { key: 'e', label: '资源关系', children: '三池独立；同池兼容模型默认共享' }, { key: 'f', label: '公式耗时', children: num(report.duration_ms) + ' 毫秒' }]} /><div className="soft-note">结果反映当前假设下的早期规划规模，可在下表逐项查看公式与参数来源。</div></Card></div>
      <Card title="业务场景需求汇总" className="below"><Table<Obj> rowKey="id" dataSource={report.pools[0].scenarios || report.pools[0].items || []} pagination={{pageSize:10}} scroll={{ x: 900 }} columns={[{title:"场景",dataIndex:"name"},{title:"模型",dataIndex:"model_label"},{title:"算力服务器",dataIndex:"chip_label"},{title:"需求算力（BF16）",dataIndex:"base_p",render:capacity},{title:"建议算力（BF16，含余量）",dataIndex:"planned_p",render:capacity},{title:"物理卡数",dataIndex:"cards",render:v => v == null ? '待补充' : num(v, 0) + ' 张'},{title:"所需卡数（含余量）",dataIndex:"cards_planned",render:v => v == null ? '待补充' : <strong>{num(v, 0)} 张</strong>},{title:"主导因素",dataIndex:"bottleneck_label",render:v => v || '—'},{title:"状态",dataIndex:"completeness",render:v => stateNames[v] || v}]} /><small className="muted">卡数是物理台数，按实例对齐；需求算力以 BF16 稠密算力为基准、按所选精度折算，单位 P / T，两者不是同一量纲。</small></Card><Card title="任务明细与计算过程" className="below"><Table<Obj> rowKey="id" dataSource={rows} pagination={{ pageSize: 10 }} scroll={{ x: 760 }} columns={[{ title: '任务', dataIndex: 'name' }, { title: '资源池', dataIndex: 'pool_id', render: v => poolNames[v] }, { title: '基础算力', dataIndex: 'base_p', render: capacity }, { title: '显存依据', render: (_, r) => stateNames[r.memory?.status] || '待核验' }, { title: '', render: (_, r) => <Button type="link" onClick={() => setTraceItem(r)}>查看计算依据</Button> }]} /><small className="muted">开发测试任务明细列出单任务容量；资源池按并行槽位取最大值组合，并非直接累加全部候选模型。</small></Card>
      <Card title="显存与模型共享" className="below"><Table<Obj> rowKey="id" pagination={false} dataSource={report.pools} columns={[{ title: '资源池', dataIndex: 'id', render: v => poolNames[v] }, { title: '显存需求 / 下界', render: (_, p) => num(p.memory.memory_gb) + ' GB' }, { title: '完整性', render: (_, p) => stateNames[p.memory.status] }, { title: '共享组数', render: (_, p) => p.memory.groups?.length || (p.id === 'development' ? '按任务槽位' : 0) }]} expandable={{ expandedRowRender: p => <pre>{JSON.stringify(p.memory, null, 2)}</pre> }} /></Card>
      <Card title="假设敏感性" className="below"><p className="muted">改变规模、效率和微调工作量系数后重新计算；此区间不代表统计置信区间。</p><div className="sensitivity-grid">{report.sensitivity?.map((s: Obj) => <div key={s.name}><span>{s.name}</span><strong>{capacity(s.total_planned_p)}</strong><small>规模×{s.changes.load_scale} · 效率×{s.changes.efficiency_scale} · 微调系数{s.changes.train_k}</small></div>)}</div></Card>
      <Card title="加速卡规格折算参考" className="below" extra={<Button onClick={() => void guard(async () => setCosts(await api('/cost-estimates', 'POST', { run_id: activeRun!.id })))}>生成费用附录</Button>}><p className="muted">各独立池分别取整，结合算力与显存下界折算；互联与拓扑尚未验证。仅计加速卡购置费用，人民币。</p>{costs ? <Table<Obj> rowKey={r => r.card.id} pagination={false} dataSource={costs.result.items} scroll={{ x: 700 }} columns={[{ title: '参考卡', render: (_, r) => r.card.name }, { title: '参考数量', dataIndex: 'reference_cards' }, { title: '加速卡购置区间', render: (_, r) => r.amount_low == null ? '价格待录入' : '¥' + num(r.amount_low, 0) + ' – ¥' + num(r.amount_high, 0) }, { title: '口径', render: (_, r) => <><Tag>{r.price_status === 'VALID' ? '已录报价' : r.price_status === 'PRICE_EXPIRED' ? '报价已过期' : r.price_status === 'DEMO' ? '演示报价' : '待报价'}</Tag>{r.status === 'COMPUTE_LOWER_BOUND_ONLY' && <Tag color="orange">未覆盖显存约束</Tag>}{r.status === 'PARTIAL' && <Tag color="orange">仅部分任务</Tag>}</> }]} expandable={{ expandedRowRender: r => <pre>{JSON.stringify({ pools: r.pools, price: r.price, topology: r.topology_status }, null, 2)}</pre> }} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="选择生成费用附录；没有可靠报价时保留“价格待录入”。" />}</Card>
      <Card title="方案与历史版本对比" className="below"><Space wrap><Select aria-label="对比计算版本" mode="multiple" maxCount={3} style={{ minWidth: 400 }} placeholder="选择2至3个已计算版本" value={compareIds} onChange={setCompareIds} options={runs.map(r => ({ value: r.id, label: (r.plan_label || plan?.label || '方案') + ' · 修订 ' + r.plan_revision + ' · ' + new Date(r.created_at).toLocaleTimeString() }))} /><Button disabled={compareIds.length < 2} onClick={() => void guard(async () => setComparison(await api('/calculations/compare', 'POST', { run_ids: compareIds })))}>对比版本</Button></Space>{comparison && <Table<Obj> className="below" rowKey="id" pagination={false} dataSource={comparison.runs} columns={[{ title: '修订', dataIndex: 'plan_revision' }, { title: '建议算力', render: (_, r) => capacity(r.result.total_planned_p) }, { title: '相对首项差额', render: (_, r) => r.delta_p == null ? '—' : (Number(r.delta_p) >= 0 ? '+' : '-') + capacity(Math.abs(Number(r.delta_p))) }, { title: '变化参数', render: (_, r) => r.parameter_changes.length + ' 项' }]} expandable={{ expandedRowRender: r => <pre>{JSON.stringify(r.parameter_changes, null, 2)}</pre> }} />}</Card>
    </>;
  }

  function settingsPage() {
    return <Tabs items={[
      { key: 'models', label: '模型基线库', children: <Card title="版本化模型目录" extra={<Button icon={<PlusOutlined aria-hidden="true" />} onClick={() => { setModelDraft(JSON.stringify({ display_name: '自定义模型', revision: 'custom-v1', source_url: '', architecture: 'Dense', tasks: ['text'], modalities: ['text'], resident_parameters: null, active_parameters_prefill: null, active_parameters_decode: null, context_limit: 32768, cache: { type: 'unknown' }, eligible_training_methods: ['lora'], evidence_grade: 'C', notes: '' }, null, 2)); setModelModal(true); }}>新增模型版本</Button>}><Alert type="info" message="模型结构来源与经验性能系数分开记录。发布新版本不会改变已经保存的计算快照。" /><Table<Obj> rowKey="id" className="below" dataSource={catalogAll} pagination={{ pageSize: 8 }} scroll={{ x: 900 }} columns={[{ title: '模型', dataIndex: 'display_name' }, { title: '驻留参数', render: (_, m) => m.resident_parameters ? num(Number(m.resident_parameters) / 1e9) + ' B' : '待核验' }, { title: '激活参数 输入/生成', render: (_, m) => (m.active_parameters_prefill ? num(Number(m.active_parameters_prefill) / 1e9) : '—') + ' / ' + (m.active_parameters_decode ? num(Number(m.active_parameters_decode) / 1e9) : '—') + ' B' }, { title: '状态', render: (_, m) => <Tag color={m.status === 'PUBLISHED' ? 'green' : 'default'}>{m.status === 'PUBLISHED' ? '已发布' : m.status === 'DRAFT' ? '草稿' : '已退役'}</Tag> }, { title: '', render: (_, m) => <Space><Button size="small" onClick={() => { const copy = { ...m }; delete copy.id; delete copy.status; delete copy.created_at; delete copy.updated_at; delete copy.record_revision; copy.revision = copy.revision + '-new'; setModelDraft(JSON.stringify(copy, null, 2)); setModelModal(true); }}>复制为新版</Button>{m.status === 'DRAFT' && <Button size="small" type="primary" onClick={() => void guard(async () => { await api('/catalog/revisions/' + m.id + '/publish', 'POST', {}); await refreshCatalog(); })}>发布</Button>}{m.status === 'PUBLISHED' && !m.is_demo && <Popconfirm title="退役后不会改变历史计算，新的方案将不再默认选择此版本。" onConfirm={() => void guard(async () => { await api('/catalog/revisions/' + m.id + '/retire', 'POST', {}); await refreshCatalog(); })}><Button size="small">退役</Button></Popconfirm>}</Space> }]} expandable={{ expandedRowRender: m => <><p>{m.notes}</p><p>固定版本：{m.revision}</p><a href={m.source_url.startsWith('http') ? m.source_url : undefined} target="_blank" rel="noreferrer">查看来源</a><pre>{JSON.stringify(m.cache, null, 2)}</pre><Button onClick={() => void guard(async () => setTraceItem(await api('/catalog/revisions/' + m.id + '/trial', 'POST', { parameters: { task_type: m.tasks[0], online_users: 100, streams: m.tasks[0] === 'cv' ? 1 : null, allow_proxy: true } })))}>试算基线</Button></> }} /></Card> },
      { key: 'baselines', label: '任务参数基线', children: <Card title="自定义任务模板" extra={<Button onClick={() => { setBaselineDraft(JSON.stringify({ calculator_id: 'unit-work-v1', revision: 'custom-v1', source_url: '', evidence_grade: 'C', parameters: { task_type: 'unit', unit_name: '任务', flop_per_unit: null, baseline_source: '' } }, null, 2)); setBaselineModal(true); }}>新增基线</Button>}><p className="muted">使用注册计算器与有来源的参数建立模板，发布后可从场景配置中选择应用。</p><Table<Obj> rowKey="id" dataSource={baselineList} columns={[{ title: '版本', dataIndex: 'revision' }, { title: '计算器', dataIndex: 'calculator_id' }, { title: '来源', dataIndex: 'source_url' }, { title: '状态', dataIndex: 'status' }, { title: '', render: (_, b) => b.status === 'DRAFT' && <Button onClick={() => void guard(async () => { await api('/catalog/revisions/' + b.id + '/publish', 'POST', {}); await refreshCatalog(); })}>发布</Button> }]} /></Card> },
      { key: 'prices', label: '参考卡与报价', children: <Card title="硬件规格与人民币报价" extra={<Button onClick={() => { setPriceDraft({ card_id: cards[0]?.id, quote_date: new Date().toLocaleDateString('en-CA'), tax_status: '含税', condition: '全新', valid_days: 30, is_demo: false }); setPriceModal(true); }}>录入报价</Button>}><Table<Obj> rowKey="id" dataSource={cards} pagination={false} columns={[{ title: '参考卡', dataIndex: 'name' }, { title: 'BF16稠密', render: (_, c) => capacity(c.dense_p16) }, { title: '显存', render: (_, c) => c.memory_gb + ' GB' }, { title: '来源', render: (_, c) => <a href={c.source_url} target="_blank" rel="noreferrer">官方规格</a> }]} expandable={{ expandedRowRender: c => <p>{c.notes}</p> }} /><p className="soft-note">不预设未经核验的市场价格。录入来源、日期、价格上下限后，可到结果页重新生成费用附录。</p></Card> },
      { key: 'inference', label: '推理参数', children: <InferenceParamsPage /> },
      { key: 'ai', label: 'AI 连接设置', children: <Card title="规划助手连接"><div className="form-grid"><Field label="完整对话接口地址"><Input aria-label="AI接口地址" value={settings.endpoint} placeholder="https://…/chat/completions" onChange={e => setSettings({ ...settings, endpoint: e.target.value })} /></Field><Field label="助手模型名称"><Input aria-label="助手模型名称" value={settings.model} onChange={e => setSettings({ ...settings, model: e.target.value })} /></Field><Field label="API Key（仅服务端内存）"><Input.Password aria-label="AI密钥" placeholder={settings.has_key ? '已设置；留空保留' : '可选，重启后从环境变量恢复'} value={settings.api_key || ''} onChange={e => setSettings({ ...settings, api_key: e.target.value })} /></Field></div><Button type="primary" onClick={() => void guard(async () => { setSettings(await api('/settings', 'PUT', settings)); message.success('助手设置已保存'); })}>保存助手设置</Button><p className="soft-note">助手使用的模型与“被规划的模型”各自独立。未连接时使用本地规则；密钥不写入方案、数据库或日志。</p></Card> },
    ]} />;
  }

  const isPlaceholder = (placeholderPages as readonly string[]).includes(page);
  const guidePage = page === 'basis' || page === 'organization' || page === 'inference' || page === 'room-dc-layout' || page === 'room-3d-layout' || page === 'cabinet' || page === 'roi' || page === 'room-power' || page === 'room-liquid-cooling' || page === 'room-micro-module' || isPlaceholder;
  const pageTitle = pageTitles[page] || '算力规划';
  const activeGroup = groupOfPage(page);
  return <div className="shell"><aside className="sidebar"><div className="brand"><span><ThunderboltFilled aria-hidden="true" /></span><div><strong>算力沙盘</strong><small>CAPACITY SANDBOX</small></div></div><div className="workspace-label">规划工作空间</div><nav>{navGroups.map(g => {
    const hasChildren = !!g.items;
    const isOpen = hasChildren ? openGroups.includes(g.id) : false;
    const groupActive = activeGroup === g.id;
    return <div className="nav-group" key={g.id}>
      <button aria-label={g.label} aria-expanded={hasChildren ? isOpen : undefined}
        className={'nav-group-head' + (groupActive ? ' group-active' : '')}
        onClick={() => hasChildren ? setOpenGroups(list => list.includes(g.id) ? list.filter(x => x !== g.id) : [...list, g.id]) : setPage(g.id)}>
        {g.icon}<span>{g.label}</span>{hasChildren ? <DownOutlined aria-hidden="true" className={'nav-caret' + (isOpen ? ' open' : '')} /> : groupActive ? <i /> : null}
      </button>
      {hasChildren && isOpen && <div className="nav-sub">
        {(g.items as readonly (readonly [string, string, ReactNode?])[]).map(([id, label, icon]) => <button aria-label={label} key={id} className={'nav-sub-item' + (page === id || (page === 'organization' && id === 'projects') ? ' active' : '')} onClick={() => setPage(id)}>{icon}<span>{label}</span>{page === id && <i />}</button>)}
      </div>}
    </div>;
  })}<div className="nav-divider" role="separator" /><button aria-label="推理评估" className={'nav-standalone ' + (page === 'inference' ? 'active' : '')} onClick={() => setPage('inference')}><ThunderboltFilled aria-hidden="true" /><span className="nav-standalone-text"><span className="nav-standalone-name">推理评估</span><small className="nav-standalone-note">For产品组合的集成页面</small></span>{page === 'inference' && <i />}</button></nav><div className="sidebar-bottom"><div className="local-dot" /><span>本机工作空间</span><small>单用户 · 数据保存在本地</small></div></aside><div className="workspace"><header className="topbar"><span>工作空间 <b>/</b> {pageTitle}</span><Space><Tag color="green">早期规划估算</Tag><span className="avatar">规</span></Space></header><main><div className="page-heading"><div><span className="eyebrow">CAPACITY SANDBOX</span><h1>{pageTitle}</h1><p>{page === 'projects' ? '建立方案，让需求、模型与算力一一对应。' : page === 'basis' ? '了解三类资源池的规划方法、计算公式与依据来源。' : page === 'inference' ? '按场景并发估算显存 / Prefill / Decode 三约束所需算力卡。' : page === 'organization' ? '理解项目、方案、三类规划及测算记录的关系。' : page === 'room-dc-layout' ? '四层数据中心结构与单层平面分区示意：区域划分、通道走向与制冷形式。' : page === 'room-3d-layout' ? '可交互三维机房布局：园区总览、A02 数据中心楼与各层详细机房。' : page === 'cabinet' ? '选择超节点卡数规模或按机房功率反算，推算机柜组成、设计功率、机房面积与制冷方案。' : page === 'roi' ? 'AI 数据中心投入产出测算：CAPEX 构成、电费与运维、云上比价与回收周期。' : page === 'room-power' ? '从电网到 AI 服务器机柜的完整 3D 供电路径：降压、UPS、电池与柴油发电机。' : page === 'room-liquid-cooling' ? '机房剖面示意：当前代际与未来演进的层高、承重与空间分层要求。' : page === 'room-micro-module' ? '液冷微模块三维布局：机柜、冷板、分集水器与管路走向。' : isPlaceholder ? '本模块入口已就位，页面内容后续提供。' : currentProject?.name || '先创建或打开一个规划项目'}</p></div>{plan && !guidePage && <div className="heading-actions"><Select aria-label="当前方案" style={{ width: 170 }} value={plan.id} options={currentProject?.plans.map((p: Obj) => ({ value: p.id, label: p.label })) || [{ value: plan.id, label: plan.label }]} onChange={id => void guard(async () => { await loadPlan(id); })} /><Button icon={<CopyOutlined aria-hidden="true" />} onClick={() => void guard(async () => { const p = await save(); if (p) { const copied = await api('/plans/' + p.id + '/clone', 'POST', { label: '对比方案 ' + new Date().toLocaleTimeString() }); await refreshProjects(); await loadPlan(copied.id); } })}>复制方案</Button><Button icon={<UndoOutlined aria-hidden="true" />} disabled={!dirty && !plan.previous_payload} onClick={() => void guard(async () => { if (dirty) { setPayload(clone(plan.payload)); setDirty(false); } else { const p = await api('/plans/' + plan.id + '/undo', 'POST', { expected_revision: plan.revision }); setPlan(p); setPayload(p.payload); } })}>撤销</Button><Button icon={<SaveOutlined aria-hidden="true" />} disabled={!dirty} onClick={() => void guard(async () => { await save(); message.success('方案已保存'); })}>保存方案{dirty ? ' *' : ''}</Button><Button type="primary" icon={<ThunderboltFilled aria-hidden="true" />} loading={calculating} onClick={() => void guard(calculate)}>开始测算</Button></div>}</div>
      {plan && payload && page !== 'projects' && page !== 'settings' && !guidePage && <div className="plan-meta"><span><HistoryOutlined aria-hidden="true" /> {plan.label} · 修订 {plan.revision}</span><Tooltip title="只在最终容量增加一次"><label>余量 <InputNumber aria-label="算力余量" size="small" min={0} max={500} value={Number(payload.headroom) * 100} onChange={v => edit(p => p.headroom = Number(v) / 100)} addonAfter="%" style={{ width: 100 }} /></label></Tooltip></div>}
      <Spin spinning={loading}>{page === 'projects' ? projectsPage() : page === 'settings' ? settingsPage() : page === 'inference' ? <InferencePage /> : page === 'basis' ? <PlanningBasis defaults={defaults} models={models} /> : page === 'organization' ? <PlanningOrganization onBack={() => setPage('projects')} onBasis={() => setPage('basis')} /> : page === 'room-dc-layout' ? <RoomDcLayoutPage /> : page === 'room-3d-layout' ? <Room3dLayoutPage /> : page === 'cabinet' ? <CabinetLayoutPage /> : page === 'roi' ? <RoiAnalysisPage /> : page === 'room-power' ? <RoomPowerPage /> : page === 'room-liquid-cooling' ? <RoomLiquidCoolingPage /> : page === 'room-micro-module' ? <RoomMicroModulePage /> : page === 'room-power' || page === 'room-liquid-cooling' || page === 'room-micro-module' || page === 'roi' ? <PlaceholderPage title={pageTitle} note={placeholderNotes[page]} /> : !payload ? <Card><Empty description="请选择一个规划项目开始。" /><div className="center"><Button type="primary" onClick={() => setPage('projects')}>前往项目概览</Button></div></Card> : page === 'business' ? businessPage() : page === 'innovation' ? innovationPage() : page === 'development' ? developmentPage() : resultsPage()}</Spin>
      <footer>算力沙盘 <span>推演算力空间，洞见投资回报。</span></footer></main></div>
      <Modal title="新建规划项目" open={projectModal} onCancel={() => setProjectModal(false)} onOk={() => void guard(() => createProject())} okText="创建项目"><Field label="项目名称"><Input aria-label="项目名称" placeholder="例如：2029年组织AI算力规划" value={projectName} onChange={e => setProjectName(e.target.value)} onPressEnter={() => void guard(() => createProject())} /></Field><p className="muted">创建后可导入场景并配置三类资源池。</p></Modal>
      <Modal width={940} title="导入业务场景清单" open={importModal} onCancel={() => setImportModal(false)} footer={<Space><Button onClick={() => void guard(previewImport)}>识别并预览</Button><Button type="primary" disabled={!importPreview || importPreview.needs_online_confirmation} onClick={() => void guard(commitImport)}>确认导入</Button></Space>}><Tabs items={[{ key: 'text', label: '粘贴文字', children: <Input.TextArea aria-label="场景清单文字" rows={6} value={importText} placeholder={'场景名称\t场景描述\t在线人数\n知识问答\t查询内部制度\t100'} onChange={e => { setImportText(e.target.value); setImportFile(null); setImportPreview(null); }} /> }, { key: 'excel', label: '上传 Excel', children: <><Upload accept=".xlsx" maxCount={1} beforeUpload={file => { setImportFile(file); setImportPreview(null); return false; }} onRemove={() => setImportFile(null)}><Button icon={<CloudUploadOutlined aria-hidden="true" />}>选择 .xlsx 文件</Button></Upload><p className="muted">最多20MB、1000个场景。建议列：场景名称、场景描述、同时在线人数、目标模型。</p><Space><InputNumber aria-label="Excel表头行" min={1} max={100} value={headerRow} onChange={v => setHeaderRow(v || 1)} addonBefore="表头行" />{importPreview?.sheets?.length > 0 && <Select value={importSheet || importPreview!.selected_sheet} options={importPreview!.sheets.map((s: string) => ({ value: s, label: s }))} onChange={v => { setImportSheet(v); setImportPreview(null); }} />}</Space></> }]} />{importPreview && <><div className="section-title"><h3>识别到 {importPreview.scenarios.length} 个场景</h3><Select aria-label="导入合并方式" value={importStrategy} onChange={setImportStrategy} options={[{ value: 'append', label: '作为新场景添加' }, { value: 'update_by_name', label: '按唯一名称更新' }, { value: 'replace_all', label: '替换当前全部场景' }]} /></div>{importPreview.needs_online_confirmation && <Alert type="warning" message={<Checkbox checked={onlineSemantics} onChange={e => setOnlineSemantics(e.target.checked)}>表格中的“并发”列指同时在线人数；勾选后重新预览</Checkbox>} />}{importPreview.errors.map((e: Obj, i: number) => <Alert key={i} type="warning" message={'第' + e.row + '行：' + e.message} />)}<Collapse items={[{ key: 'mapping', label: '检查列映射（修改后重新预览）', children: <div className="form-grid">{[['name', '场景名称'], ['description', '描述'], ['online_users', '在线人数'], ['model_id', '模型']].map(([key, label]) => <Field key={key} label={label}><Select allowClear value={columnMapping[key] || importPreview.mapping[key]} options={importPreview.headers.map((h: string) => ({ value: h, label: h }))} onChange={v => setColumnMapping({ ...columnMapping, [key]: v })} /></Field>)}</div> }]} /><Table<Obj> rowKey="id" size="small" dataSource={importPreview.scenarios} pagination={{ pageSize: 5 }} columns={[{ title: '场景', dataIndex: 'name' }, { title: '任务', render: (_, s) => typeNames[s.components?.[0]?.task_type] || '待配置' }, { title: '在线人数/路数', render: (_, s) => s.components?.[0]?.online_users ?? s.components?.[0]?.streams ?? '待补充' }]} /><small>{importPreview.warnings.join('；')}</small></>}</Modal>
      <CalculationDerivation runId={activeRun?.id} scope={page === 'results' ? derivationScope : null} stale={stale} onClose={() => setDerivationScope(null)} />
      <Drawer title="计算依据与追踪" width={780} open={!!traceItem} onClose={() => setTraceItem(null)}>{traceItem && <><Descriptions column={1} items={[{ key: 'name', label: '任务', children: traceItem.name || '基线试算' }, { key: 'base', label: '基础规划算力', children: capacity(traceItem.base_p) }, { key: 'formula', label: '公式', children: traceItem.trace?.formula }, { key: 'model', label: '模型版本', children: traceItem.trace?.model_revision }, { key: 'source', label: '来源', children: traceItem.trace?.model_source ? <a href={traceItem.trace.model_source} target="_blank" rel="noreferrer">查看原始来源</a> : '见输入参数' }]} /><h3>输入、中间值与来源</h3><pre>{JSON.stringify(traceItem, null, 2)}</pre></>}</Drawer>
      <Modal width={760} title="新增模型版本（不会覆盖旧记录）" open={modelModal} onCancel={() => setModelModal(false)} onOk={() => void guard(async () => { await api('/catalog/model-revisions', 'POST', JSON.parse(modelDraft)); setModelModal(false); await refreshCatalog(); message.success('已保存草稿，核对后可发布'); })}><Input.TextArea aria-label="模型版本JSON" rows={18} value={modelDraft} onChange={e => setModelDraft(e.target.value)} /></Modal>
      <Modal width={760} title="新增任务基线" open={baselineModal} onCancel={() => setBaselineModal(false)} onOk={() => void guard(async () => { await api('/catalog/baseline-revisions', 'POST', JSON.parse(baselineDraft)); setBaselineModal(false); await refreshCatalog(); })}><Input.TextArea aria-label="任务基线JSON" rows={16} value={baselineDraft} onChange={e => setBaselineDraft(e.target.value)} /></Modal>
      <Modal title="录入人民币单卡报价" open={priceModal} onCancel={() => setPriceModal(false)} onOk={() => void guard(async () => { await api('/prices', 'POST', priceDraft); setPriceModal(false); message.success('报价已保存，请重新生成费用附录'); })}><div className="form-grid"><Field label="参考卡"><Select value={priceDraft.card_id} options={cards.map(c => ({ value: c.id, label: c.name }))} onChange={v => setPriceDraft({ ...priceDraft, card_id: v })} /></Field><Field label="报价日期"><Input type="date" value={priceDraft.quote_date} onChange={e => setPriceDraft({ ...priceDraft, quote_date: e.target.value })} /></Field><Field label="价格下限（元/卡）"><InputNumber min={0} value={priceDraft.price_low} onChange={v => setPriceDraft({ ...priceDraft, price_low: v })} /></Field><Field label="价格上限（元/卡）"><InputNumber min={0} value={priceDraft.price_high} onChange={v => setPriceDraft({ ...priceDraft, price_high: v })} /></Field><Field label="报价来源"><Input value={priceDraft.source || ''} onChange={e => setPriceDraft({ ...priceDraft, source: e.target.value })} /></Field><Field label="报价口径"><Input value={priceDraft.tax_status + ' / ' + priceDraft.condition} onChange={e => setPriceDraft({ ...priceDraft, tax_status: e.target.value, condition: '' })} /></Field></div><Checkbox checked={priceDraft.is_demo} onChange={e => setPriceDraft({ ...priceDraft, is_demo: e.target.checked })}>这是演示报价（费用将标为DEMO）</Checkbox></Modal>
    </div>;
}
