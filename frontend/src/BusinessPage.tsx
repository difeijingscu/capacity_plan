import { useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Empty, Input, InputNumber, Popconfirm,
  Select, Space, Spin, Table, Tag, Tooltip, App as AntApp,
} from 'antd';
import {
  CloudUploadOutlined, DeleteOutlined, InfoCircleOutlined, PlusOutlined, ThunderboltFilled,
} from '@ant-design/icons';
import { capacity, num } from './api';
import type { Obj } from './api';
import CustomModelModal from './CustomModelModal';
import CustomChipModal from './CustomChipModal';
import CoefPanel from './CoefPanel';
import FxTree from './FxTree';
import { METHOD_HTML, BASIS_HTML } from './businessEvalContent';
import './business-eval.css';

/**
 * 业务场景池：分区结构与交互完全对齐「推理评估 For 产品组合」集成页——
 * 全局硬件配置 → 场景清单 → 算力汇总 → 估算方法说明 → 估算依据与口径。
 * 与推理评估页的差异仅在数据联动：场景读写当前规划方案的 payload.scenarios，
 * 计算走后端引擎（与页面公式同口径），结果随预览下发并进入测算快照。
 */

/** 场景未配置推理时的兜底口径：芯片与档位跟随全局默认（business_defaults）。 */
const DEFAULT_INFERENCE: Obj = {
  scene_key: 'rag', weight_precision: 'auto', prefix_hit: 0,
};
/** v2 精度档：W4A8 只在原生支持 INT4 的芯片（950 系列）可选。 */
const PRECISIONS = [
  { value: 'auto', label: '自动推荐' },
  { value: 'bf16', label: 'BF16（全精度）' },
  { value: 'w8a8', label: 'W8A8（INT8 量化）' },
  { value: 'w4a8', label: 'W4A8（INT4 量化）' },
];
/** 旧 schema 档位值 ↔ 页面档位（与后端 engine.PROFILE_TIER 同一套映射）。 */
const PROFILE_TIER: Obj = { optimistic: 'aggressive', neutral: 'standard', conservative: 'conservative' };
const TIER_TO_PROFILE: Obj = { aggressive: 'optimistic', standard: 'neutral', conservative: 'conservative' };
const TIER_FALLBACK = [
  { value: 'conservative', label: '保守' },
  { value: 'standard', label: '均衡' },
  { value: 'aggressive', label: '激进' },
];
const TIER_COEF: Obj = { conservative: '×0.8', standard: '×1', aggressive: '×1.2' };
/** 引擎告警类型与主导因素的中文标签。 */
const WARNING_LABELS: Obj = {
  longInput: '长输入', longOutput: '长输出', crossNode: '跨节点切分',
  bandLimited: '带宽受限', tpotShort: '逐Token未达标', ttft: '首Token未达标',
};
const BOTTLENECK_LABELS: Obj = { mem: '显存', prefill: 'Prefill', decode: 'Decode' };

/** 场景档位里可以一键带入的规模参数（并发在场景主行，其余收进「调整参数」）。 */
const SCENE_FIELDS: [string, string, string][] = [
  ['concurrency', '并发会话', '路'],
  ['prompt_len', '输入长度', 'tok'],
  ['output_len', '输出长度', 'tok'],
  ['max_ctx', '最大上下文', 'tok'],
  ['ttft_target_ms', '首 Token 目标', 'ms'],
  ['tpot_target_ms', '逐 Token 目标', 'ms'],
];
const ADV_FIELDS = SCENE_FIELDS.filter(([f]) => f !== 'concurrency');
/** 规模字段 → 场景档目录字段（目录里时延默认值叫 ttft_ms / tpot_ms）。 */
const SCENE_PRESET_SOURCE: Obj = { ttft_target_ms: 'ttft_ms', tpot_target_ms: 'tpot_ms' };
const presetField = (preset: Obj, field: string) => preset[SCENE_PRESET_SOURCE[field] ?? field];

/** 按 groupOf 分组生成 Select 的 optgroup 结构（保持首次出现顺序）。 */
function groupOptions(items: Obj[], groupOf: (item: Obj) => string, toOption: (item: Obj) => Obj) {
  const groups: { label: string; options: Obj[] }[] = [];
  const index = new Map<string, Obj[]>();
  for (const item of items) {
    const label = groupOf(item);
    if (!index.has(label)) { const bucket: Obj[] = []; index.set(label, bucket); groups.push({ label, options: bucket }); }
    index.get(label)!.push(toOption(item));
  }
  return groups;
}
const modelGroup = (m: Obj) => m.custom ? '自定义' : (String(m.label || m.key).match(/^[A-Za-z]+/)?.[0] || '其他');
const chipGroup = (c: Obj) => c.custom ? '自定义' : (c.family ? '昇腾' + c.family + ' 系列' : '其他');

/** 把池内逐场景结果按模型归类：场景数、卡数与算力合计、主导因素分布。 */
function summarizeByModel(scenarios: Obj[]): Obj[] {
  const rows: Obj[] = [];
  const index = new Map<string, Obj>();
  for (const r of scenarios) {
    if (r.cards == null) continue;
    const key = r.model_label || r.model_id || '未选择';
    let row = index.get(key);
    if (!row) {
      row = { model_label: key, scenarios: 0, cards: 0, base_p: 0, bottlenecks: [] as string[], not_met: 0 };
      index.set(key, row); rows.push(row);
    }
    row.scenarios += 1;
    row.cards += Number(r.cards);
    row.base_p += Number(r.base_p || 0);
    const b = r.bottleneck_label || BOTTLENECK_LABELS[r.bottleneck] || r.bottleneck;
    if (b && !row.bottlenecks.includes(b)) row.bottlenecks.push(b);
    if (r.latency_status === 'NOT_MET') row.not_met += 1;
  }
  return rows;
}

/** 后端 business.resolve_spec 直接拒收的任务类型：业务池只覆盖大模型推理。 */
const NON_LLM_TASKS = new Set(['cv', 'unit', 'native']);

/** 与后端 business._norm 同一套归一化：去符号、转小写。 */
const norm = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export default function BusinessPage({ payload, edit, catalog, legacyModels, catalogLoading, preview, refreshCatalog, onImport }: {
  payload: Obj;
  edit: (mutator: (plan: Obj) => void) => void;
  catalog: Obj | null;
  legacyModels: Obj[];
  catalogLoading?: boolean;
  preview: Obj | null;
  refreshCatalog: () => Promise<void>;
  onImport: () => void;
}) {
  const { message, modal } = AntApp.useApp();
  const [modelModal, setModelModal] = useState(false);
  const [chipModal, setChipModal] = useState(false);
  /** 每行的展开区：'adv' 调整参数 / 'fx' 计算过程，同一时间只开一个。 */
  const [folds, setFolds] = useState<Obj>({});
  const toggleFold = (id: string, kind: string) =>
    setFolds(f => ({ ...f, [id]: f[id] === kind ? null : kind }));

  const models: Obj[] = [...(catalog?.models ?? []), ...(catalog?.custom_models ?? [])];
  const chips: Obj[] = [...(catalog?.chips ?? []), ...(catalog?.custom_chips ?? [])];
  const customChips = chips.filter(c => c.custom);
  const scenes: Obj[] = catalog?.scenes ?? [];
  const pool = preview?.pools?.[0];

  /** 全局硬件：以 business_defaults 为准；老方案没有该字段时从已配置场景推导。 */
  const configured = payload.scenarios.filter((s: Obj) => s.inference);
  const derivedChips = [...new Set(configured.map((s: Obj) => s.inference.chip_key).filter(Boolean))] as string[];
  const derivedTiers = [...new Set(configured.map((s: Obj) => PROFILE_TIER[s.inference.profile] || s.inference.profile).filter(Boolean))] as string[];
  const defaults = payload.business_defaults || {};
  const globalChip: string | undefined = defaults.chip_key
    ?? (derivedChips.length === 1 ? derivedChips[0] : derivedChips.length === 0 ? '910c' : undefined);
  const globalTier: string = defaults.profile
    ? (PROFILE_TIER[defaults.profile] || defaults.profile)
    : (derivedTiers.length === 1 ? derivedTiers[0] : 'standard');
  const mixedChip = !defaults.chip_key && derivedChips.length > 1;
  const globalProfile = TIER_TO_PROFILE[globalTier] || 'neutral';
  const globalChipInfo: Obj = chips.find(c => c.key === globalChip) || {};

  /** 三个下拉都按目录分组：场景按业务组、芯片按系列、模型按厂商（label 前缀）。 */
  const sceneOptions = groupOptions(scenes, (s: Obj) => String(s.group || '其他'),
    x => ({ value: x.key, label: x.name, title: x.hint }));
  const chipOptions = groupOptions(chips, chipGroup,
    c => ({ value: c.key, label: c.label.split(' · ')[0] + (c.custom ? ' · 自定义' : ''), title: c.label }));
  const modelOptions = groupOptions(models, modelGroup,
    m => ({ value: m.key, label: (m.label || m.key) + (m.custom ? ' · 自定义' : '') }));
  const tierOptions: Obj[] = (catalog?.tiers ?? []).map((t: Obj) => ({ value: t.key, label: t.label }));
  /** W4A8 需要芯片原生 INT4；其余档位始终可选。 */
  const precisionOptions = (chip: Obj) => PRECISIONS.map(p =>
    p.value === 'w4a8' && !chip.native_int4 ? { ...p, disabled: true } : p);

  /** 全局改写：写入 business_defaults 并同步所有已配置场景。 */
  function applyChipGlobal(value: string) {
    const label = chips.find(c => c.key === value)?.label || value;
    const doit = () => edit(plan => {
      plan.business_defaults = { chip_key: value, profile: globalProfile };
      plan.scenarios.forEach((s: Obj) => { if (s.inference) s.inference.chip_key = value; });
    });
    if (configured.length > 0) {
      modal.confirm({
        title: '统一全部场景的算力卡？',
        content: `将把 ${configured.length} 个已配置场景的算力卡改为「${label}」；尚未配置的场景在选定模型后跟随该全局值。`,
        okText: '统一', cancelText: '取消', onOk: doit,
      });
    } else doit();
  }
  function applyTierGlobal(value: string) {
    edit(plan => {
      plan.business_defaults = { chip_key: globalChip || '910c', profile: TIER_TO_PROFILE[value] || value };
      plan.scenarios.forEach((s: Obj) => { if (s.inference) s.inference.profile = TIER_TO_PROFILE[value] || value; });
    });
  }

  /** 旧字段里的模型标识 → 推理模型清单标识，口径与后端迁移一致。 */
  function matchModel(modelId: unknown): string | undefined {
    const target = norm(modelId);
    if (!target) return undefined;
    const hit = models.find(m => norm(m.key) === target)
      || models.find(m => norm(m.label) === target)
      || models.find(m => {
        const key = norm(m.key);
        return key && (key.includes(target) || target.includes(key));
      });
    return hit?.key;
  }

  /**
   * 场景的推理配置：已配置的直接用；只有旧字段的按后端同一套规则折算，
   * 这样表里显示的就是实际参与计算的模型，不会出现「显示一套、算另一套」。
   * 芯片与档位的兜底跟随全局硬件配置。
   */
  function specOf(s: Obj): Obj {
    const base = { ...DEFAULT_INFERENCE, chip_key: globalChip || '910c', profile: globalProfile };
    if (s.inference) return { ...base, ...s.inference };
    const task: Obj = (s.components || [])[0] || {};
    const spec: Obj = { ...base };
    const matched = matchModel(task.model_id) || matchModel(legacyModels.find(m => m.id === task.model_id)?.display_name);
    if (matched) spec.model_key = matched;
    if (task.online_users != null) spec.concurrency = Number(task.online_users);
    if (task.input_tokens != null) spec.prompt_len = Number(task.input_tokens);
    if (task.answer_tokens != null) spec.output_len = Number(task.answer_tokens) + Number(task.reasoning_tokens || 0);
    return spec;
  }

  /** 旧字段场景的迁移状态：与后端 resolve_spec 的三种结局一一对应。 */
  function legacyState(target: Obj): 'configured' | 'migrated' | 'missing' | 'unsupported' {
    if (target.inference) return 'configured';
    const task: Obj = (target.components || []).find((c: Obj) => c.enabled) || (target.components || [])[0] || {};
    if (!task.task_type) return 'missing';
    if (NON_LLM_TASKS.has(task.task_type)) return 'unsupported';
    const matched = matchModel(task.model_id) || matchModel(legacyModels.find(m => m.id === task.model_id)?.display_name);
    return matched ? 'migrated' : 'missing';
  }

  /** 写入推理配置：以当前展示值为基线，保住旧字段折算出来的并发与长度。返回是否写入。 */
  function write(s: Obj, values: Obj): boolean {
    const next = { ...specOf(s), ...values };
    if (!next.model_key) {
      message.warning('请先为该场景选择一个模型，再调整规模或时延参数');
      return false;
    }
    edit(plan => {
      const target = plan.scenarios.find((x: Obj) => x.id === s.id);
      if (target) target.inference = next;
    });
    return true;
  }

  const sceneOf = (spec: Obj) => scenes.find(s => s.key === spec.scene_key) || {};
  const chipOf = (spec: Obj) => chips.find(c => c.key === spec.chip_key) || {};
  const modelOf = (spec: Obj) => models.find(m => m.key === spec.model_key) || {};
  const rating = (id: string) => pool?.scenarios?.find((x: Obj) => x.id === id);

  /** 只补空字段：已填的并发与长度是业务输入，不能被档位默认值覆盖。 */
  function applySceneDefaults(ids: string[]) {
    if (!ids.length) { message.info('还没有可以补全的场景'); return; }
    let done = 0;
    let blocked = 0;
    edit(plan => {
      for (const id of ids) {
        const target = plan.scenarios.find((s: Obj) => s.id === id);
        if (!target) continue;
        const current = specOf(target);
        if (!current.model_key) { blocked += 1; continue; }
        const preset = sceneOf(current);
        let touched = false;
        for (const [field] of SCENE_FIELDS) {
          if (current[field] == null && presetField(preset, field) != null) { current[field] = presetField(preset, field); touched = true; }
        }
        if (touched) {
          target.inference = current;
          done += 1;
        }
      }
    });
    if (done) message.success(`已按场景档补全 ${done} 个场景的空字段`);
    else if (!blocked) message.info('各场景的规模参数都已填写，没有需要补的');
    if (blocked) message.warning(`${blocked} 个场景还没有选模型，未能补全`);
  }

  function addScenario() {
    const id = crypto.randomUUID().replaceAll('-', '');
    const preset = sceneOf({ scene_key: DEFAULT_INFERENCE.scene_key });
    const first = models.find(m => m.key === (preset.default_model_key || 'qwen3_8b')) || models[0];
    edit(plan => plan.scenarios.push({
      id, name: '新业务场景', description: '', enabled: true, source_reference: {},
      components: [],
      inference: {
        ...DEFAULT_INFERENCE,
        chip_key: globalChip || '910c', profile: globalProfile,
        model_key: first?.key,
        concurrency: preset.concurrency ?? null,
      },
    }));
    setFolds(f => ({ ...f, [id]: 'adv' }));
  }

  /** 场景状态徽标：与旧表格「状态」列同一套口径。 */
  function stateTag(s: Obj) {
    if (!s.enabled) return <Tag>未计入</Tag>;
    const legacy = legacyState(s);
    if (legacy === 'unsupported') {
      return <Tooltip title="视频检测、批量任务与原生存量不在业务池口径内，不会按大模型硬算。请在推理评估页单独估算，或把该场景改为大模型推理。">
        <Tag color="red">不支持</Tag>
      </Tooltip>;
    }
    if (legacy === 'missing') {
      return <Tooltip title="旧字段里的模型为空或不在推理模型清单中，无法推导等价配置。请在「模型」列选择模型。">
        <Tag color="red">待补模型</Tag>
      </Tooltip>;
    }
    if (legacy === 'migrated') {
      return <Tooltip title="该场景只有旧字段：按模型名去符号匹配 + 任务模板推导等价配置（匹配结果见「模型」列），并发取自在线人数。建议改为显式选择。">
        <Tag color="orange">旧字段推导</Tag>
      </Tooltip>;
    }
    const row = rating(s.id);
    if (!row) return <Tag>待估算</Tag>;
    return row.completeness === 'COMPLETE'
      ? <Tag color="green">已估算</Tag>
      : <Tag color="orange">需复核</Tag>;
  }

  function scenarioRow(s: Obj) {
    const spec = specOf(s);
    const row = rating(s.id);
    const off = legacyState(s) === 'unsupported';
    const model = modelOf(spec);
    const chip = chipOf(spec);
    const tree = row?.trace?.detail?.tree;
    const warns: string[] = (row?.warnings || []).filter((w: string) => WARNING_LABELS[w]);
    const fold = folds[s.id];
    const bottleneck = row?.bottleneck_label || BOTTLENECK_LABELS[row?.bottleneck] || row?.bottleneck;
    return (
      <div className={'scen-row' + (!s.enabled ? ' disabled' : '')} key={s.id}>
        <div className="scen-top">
          <div className="field">
            <label>场景名称</label>
            <Input aria-label={'场景名称-' + s.id} value={s.name} placeholder="场景名称"
              onChange={e => edit(p => { p.scenarios.find((x: Obj) => x.id === s.id).name = e.target.value; })} />
            <small className="muted">{s.description || '点「调整参数」补充场景描述'}</small>
          </div>
          <div className="field">
            <label>场景类型</label>
            <Select aria-label={'场景类型-' + s.name} style={{ width: '100%' }} value={off ? null : spec.scene_key}
              placeholder={off ? '不适用' : '待选择'} disabled={off}
              options={sceneOptions}
              onChange={v => {
                const values: Obj = { scene_key: v };
                const preset = scenes.find(x => x.key === v) || {};
                for (const [field] of SCENE_FIELDS) values[field] = presetField(preset, field) ?? null;
                if (!spec.model_key && preset.default_model_key) values.model_key = preset.default_model_key;
                write(s, values);
              }} />
          </div>
          <div className="field">
            <label>模型</label>
            <Select aria-label={'模型-' + s.name} style={{ width: '100%' }} value={spec.model_key}
              placeholder="待选择" showSearch optionFilterProp="label"
              options={modelOptions}
              onChange={v => write(s, { model_key: v })} />
            <small className="muted">
              {model.total_b
                ? `总参 ${num(model.total_b)}B · 激活 ${num(model.active_b)}B · ${model.arch}`
                : off
                  ? '视频/批量任务 · 业务池不覆盖，选择大模型可改为推理场景'
                  : '未选择模型'}
            </small>
          </div>
          <div className="field">
            <label>推理精度</label>
            <Select aria-label={'权重精度-' + s.name} style={{ width: '100%' }} value={off ? null : spec.weight_precision}
              placeholder="不适用" disabled={off}
              options={precisionOptions(chip)} onChange={v => write(s, { weight_precision: v })} />
          </div>
          <div className="field">
            <label>并发会话</label>
            <InputNumber aria-label={'并发会话-' + s.name} min={1} style={{ width: '100%' }} disabled={off}
              value={spec.concurrency == null || off ? null : Number(spec.concurrency)}
              placeholder={off ? '不适用' : String(sceneOf(spec).concurrency ?? '待填写')}
              onChange={v => write(s, { concurrency: v ?? null })} />
          </div>
          <div className="scen-badge">
            {row?.cards_planned != null
              ? <>
                  <span className="cards">{num(row.cards_planned, 0)}<small>张</small></span>
                  <small className="muted">物理 {num(row.cards, 0)} 张 · {capacity(row.base_p)}{row.sla_passed === false ? ' · 时延未达标' : ''}</small>
                </>
              : <span className="pending">{off ? '不适用' : '待补充'}</span>}
            {stateTag(s)}
          </div>
        </div>
        {(bottleneck || warns.length > 0) && (
          <div className="scen-warn">
            {bottleneck && <span className="tag">主导因素：{bottleneck}</span>}
            {warns.map((w: string) => (
              <Tooltip key={w} title={WARNING_LABELS[w] + '（引擎校验告警）'}>
                <span className={'tag' + (row?.latency_status === 'NOT_MET' ? ' err' : '')}>{WARNING_LABELS[w]}</span>
              </Tooltip>
            ))}
          </div>
        )}
        <div className="scen-ops">
          <Checkbox checked={s.enabled}
            onChange={e => edit(p => { p.scenarios.find((x: Obj) => x.id === s.id).enabled = e.target.checked; })}>
            计入规划
          </Checkbox>
          <Button size="small" type={fold === 'adv' ? 'primary' : 'default'} ghost={fold === 'adv'}
            onClick={() => toggleFold(s.id, 'adv')}>调整参数</Button>
          <Button size="small" type={fold === 'fx' ? 'primary' : 'default'} ghost={fold === 'fx'}
            disabled={!tree} onClick={() => toggleFold(s.id, 'fx')}>计算过程</Button>
          <span className="right">
            <small className="muted">{chip.label ? `${chip.label.split(' · ')[0]}` : ''}</small>
            <Popconfirm title="移除此场景？保存后仍可撤销。"
              onConfirm={() => edit(p => { p.scenarios = p.scenarios.filter((x: Obj) => x.id !== s.id); })}>
              <Button size="small" type="text" aria-label={'移除-' + s.name} icon={<DeleteOutlined aria-hidden="true" />} />
            </Popconfirm>
          </span>
        </div>
        {fold === 'adv' && (
          <div className="scen-fold">
            <div className="scen-adv-grid">
              {ADV_FIELDS.map(([field, label, unit]) => (
                <div className="field" key={field}>
                  <label>{label}</label>
                  <InputNumber style={{ width: '100%' }} aria-label={label + '-' + s.name}
                    min={field === 'tpot_target_ms' ? 1 : field === 'ttft_target_ms' ? 50 : field === 'max_ctx' ? 512 : 1}
                    value={spec[field] == null ? null : Number(spec[field])}
                    placeholder={String(presetField(sceneOf(spec), field) ?? '')}
                    addonAfter={unit}
                    onChange={v => write(s, { [field]: v ?? null })} />
                </div>
              ))}
              <div className="field">
                <label>Prefix 命中率</label>
                <InputNumber style={{ width: '100%' }} aria-label={'Prefix命中率-' + s.name} min={0} max={90}
                  value={Number(spec.prefix_hit || 0) * 100} addonAfter="%"
                  onChange={v => write(s, { prefix_hit: Number(v) / 100 })} />
              </div>
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>场景描述</label>
                <Input.TextArea value={s.description} rows={2} aria-label={'场景描述-' + s.name}
                  onChange={e => edit(p => { p.scenarios.find((x: Obj) => x.id === s.id).description = e.target.value; })} />
              </div>
            </div>
            <div className="note-line" style={{ marginTop: 10 }}>
              <InfoCircleOutlined aria-hidden="true" />
              留空的字段取场景档位默认值；并发按业务同时在线会话估算，不用人数直接代替；
              Prefix 命中只减少 Prefill 计算，不减少已写入的 KV 显存。
            </div>
            <Button size="small" icon={<ThunderboltFilled aria-hidden="true" />} style={{ marginTop: 8 }}
              onClick={() => {
                const values: Obj = {};
                const preset = sceneOf(spec);
                for (const [field] of SCENE_FIELDS) values[field] = presetField(preset, field) ?? null;
                write(s, values);
              }}>按场景档恢复默认</Button>
          </div>
        )}
        {fold === 'fx' && tree && (
          <div className="scen-fold"><FxTree tree={tree} /></div>
        )}
      </div>
    );
  }

  const byModel = pool?.scenarios?.length ? summarizeByModel(pool.scenarios) : [];
  const headroomPct = num(Number(preview?.headroom ?? payload.headroom ?? 0) * 100, 0);
  const missingCount = pool?.missing_items?.length ?? 0;
  const estimatedCount = (pool?.scenarios ?? []).filter((x: Obj) => x.cards != null).length;

  return (
    <div className="main-panel business-eval">
      {/* ============ ① 全局硬件配置 ============ */}
      <Card className="be-global">
        <div className="be-sec-h">
          <h2>全局硬件配置</h2>
          <span>算力卡与工程档位对全部场景统一生效；改动立即重算</span>
          <span className="act">
            <Button icon={<PlusOutlined aria-hidden="true" />} onClick={() => setChipModal(true)}>登记自定义算力卡</Button>
          </span>
        </div>
        <div className="be-global-grid">
          <div className="field">
            <label>算力卡（全局）
              <Tooltip title="所有场景共用同一算力卡；切换会把已配置场景统一改写为新卡。预设以外的型号可点右上「登记自定义算力卡」按厂商规格填写。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            <Select aria-label="全局算力卡" style={{ width: '100%' }} value={globalChip}
              placeholder={mixedChip ? '各场景不一致（选择后统一）' : '待选择'}
              showSearch optionFilterProp="label" options={chipOptions}
              onChange={applyChipGlobal} />
            <div className="be-chip-hint">
              {globalChipInfo.bf16_tflops
                ? `BF16 ${globalChipInfo.bf16_tflops}T · INT8 ${globalChipInfo.int8_tflops ?? '—'}T · 显存 ${globalChipInfo.memory_gb}GB · 带宽 ${globalChipInfo.hbm_tbs}TB/s · 互联 ${globalChipInfo.link_gbs ?? '—'}GB/s`
                : '—'}
            </div>
          </div>
          <div className="field">
            <label>工程开销档位（全局）
              <Tooltip title="只缩放效率类系数：Prefill MFU 与带宽利用率全额跟随，单卡显存利用率半幅；结构性开销与口径常数不受档位影响。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            <Select aria-label="全局工程档位" style={{ width: '100%' }} value={globalTier}
              options={tierOptions.length ? tierOptions : TIER_FALLBACK}
              onChange={applyTierGlobal} />
            <div className="be-chip-hint">保守 ×0.8 / 均衡 ×1 / 激进 ×1.2，作用于下方生效系数</div>
          </div>
          <div className="field">
            <label>权重精度与 KV 精度</label>
            <div className="be-chip-hint" style={{ marginTop: 0, fontSize: 12, lineHeight: 1.9 }}>
              精度在场景清单逐场景选择：权重精度定显存装载量、激活精度定峰值算力档位、KV 精度自动跟随（全精度 2 字节、量化 1 字节）。W4A8 仅在芯片原生支持 INT4 时可选。
            </div>
          </div>
        </div>
        <div>
          <div className="be-sec-h" style={{ marginBottom: 10 }}>
            <h2 style={{ fontSize: 14 }}>当前生效的工程系数（可调）</h2>
            <span>基准值 × 档位系数（{TIER_COEF[globalTier] || '×1'}）= 生效值；改动写入参数覆盖层长期生效</span>
          </div>
          <CoefPanel chipKey={globalChip} tier={globalTier} chipLabel={globalChipInfo.label}
            onChanged={() => edit(() => { /* 系数已写入参数覆盖层；触发一次预览重算 */ })} />
        </div>
      </Card>

      {/* ============ ② 场景清单 ============ */}
      <Card>
        <div className="be-sec-h">
          <h2>场景清单 <Tag>{payload.scenarios.length} 个</Tag></h2>
          <span>逐场景独立出卡：同一模型的不同场景不共享权重驻留，卡数直接相加</span>
          <span className="act">
            <Space>
              <Button icon={<PlusOutlined aria-hidden="true" />} onClick={() => setModelModal(true)}>登记自定义模型</Button>
              <Button icon={<CloudUploadOutlined aria-hidden="true" />} onClick={onImport}>导入清单</Button>
              <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={addScenario}>添加场景</Button>
            </Space>
          </span>
        </div>
        <div className="note-line">
          <InfoCircleOutlined aria-hidden="true" />
          每个场景选择模型、推理精度、场景类型并填写并发会话数；算力卡与工程档位取自上方全局配置。
          系统按「显存 → Prefill → Decode」三维取最大再用时延回验，给出所需算力与卡数；「调整参数」可改写场景档默认值，「计算过程」给出杜邦式逐层拆解。
        </div>
        <Spin spinning={!!catalogLoading}>
          <div className="scen-list">
            {payload.scenarios.length === 0
              ? <Empty description="上传业务场景清单，或添加第一个场景。" />
              : payload.scenarios.map(scenarioRow)}
          </div>
        </Spin>
        <div className="batch-bar">
          <Button onClick={() => applySceneDefaults(payload.scenarios.map((s: Obj) => s.id))}>按场景档补全全部</Button>
          <small>只补空字段：已填的并发与长度属于业务输入，不会被档位默认值覆盖。</small>
        </div>
        {missingCount > 0 && <Alert className="below" type="warning" showIcon
          message={`${missingCount} 个场景未计入合计`}
          description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>
            {pool.missing_items.map((m: Obj) => <li key={m.id}>{m.name || m.id}：{m.message}</li>)}
          </ul>} />}
      </Card>

      {/* ============ ③ 算力汇总 ============ */}
      <Card>
        <div className="be-sec-h">
          <h2>算力汇总</h2>
          <span>逐场景独立出卡后求和；余量只在池层乘一次，场景层不重复加</span>
        </div>
        {pool ? (
          <div className="be-kpis">
            <div className="be-kpi hl">
              <div className="k">所需卡数（含 {headroomPct}% 余量）</div>
              <div className="v">{num(pool.cards_planned, 0)}<small>张</small></div>
              <div className="sub">物理 {num(pool.cards, 0)} 张 · 约 {num(Math.ceil(Number(pool.cards_planned || 0) / 8), 0)} 台服务器（8 卡/台）</div>
            </div>
            <div className="be-kpi">
              <div className="k">需求算力（BF16 等效）</div>
              <div className="v">{capacity(pool.planned_p)}</div>
              <div className="sub">卡数 × 芯片 BF16 峰值折算的等效参考，与卡数不同量纲</div>
            </div>
            <div className="be-kpi">
              <div className="k">规划等效算力</div>
              <div className="v">{capacity(pool.capacity_planned_p)}</div>
              <div className="sub">含余量后的等效供给（BF16 基准）</div>
            </div>
            <div className="be-kpi">
              <div className="k">已估算场景</div>
              <div className="v">{estimatedCount}<small>/ {payload.scenarios.length} 个</small></div>
              <div className="sub">{missingCount ? `${missingCount} 个未计入（见场景清单下方清单）` : '全部场景已计入合计'}</div>
            </div>
          </div>
        ) : <Empty description="填写场景后自动汇总" />}
        {byModel.length > 0 && (
          <>
            <div className="be-sec-h" style={{ margin: '18px 0 10px' }}>
              <h2 style={{ fontSize: 14 }}>按模型归类</h2>
              <span>同一模型的不同场景不共享权重驻留，卡数直接相加</span>
            </div>
            <Table<Obj> rowKey="model_label" size="small" pagination={false}
              dataSource={byModel} scroll={{ x: 720 }} columns={[
                { title: '模型', dataIndex: 'model_label' },
                { title: '场景数', dataIndex: 'scenarios', width: 80, render: (v: number) => v + ' 个' },
                { title: '物理卡数合计', dataIndex: 'cards', width: 120, render: (v: number) => num(v, 0) + ' 张' },
                { title: '需求算力合计（BF16 等效）', dataIndex: 'base_p', width: 170, render: capacity },
                { title: '主导因素', dataIndex: 'bottlenecks', render: (v: string[]) => v.length ? v.map(b => <Tag key={b} color="blue">{b}</Tag>) : '—' },
                { title: '时延未达标', dataIndex: 'not_met', width: 100, render: (v: number) => v ? <span style={{ color: '#cf1322' }}>{v} 个场景</span> : '—' },
              ]} />
          </>
        )}
      </Card>

      {/* ============ ④ 估算方法说明 ============ */}
      <Card>
        <div className="be-sec-h">
          <h2>估算方法说明</h2>
          <span>三维约束取最大 · 杜邦式逐层拆解</span>
        </div>
        <div className="be-doc" dangerouslySetInnerHTML={{ __html: METHOD_HTML }} />
      </Card>

      {/* ============ ⑤ 估算依据与口径 ============ */}
      <Card>
        <div className="be-sec-h">
          <h2>估算依据与口径</h2>
          <span>公开文献 · 官方数据来源 · 免责声明</span>
        </div>
        <div className="be-doc">
          <div dangerouslySetInnerHTML={{ __html: BASIS_HTML }} />
          {customChips.length > 0 && (
            <>
              <h3>已登记的自定义算力卡（{customChips.length} 张）</h3>
              <div className="tbl-wrap"><table className="dt">
                <thead><tr><th>名称</th><th>BF16</th><th>INT8</th><th>INT4</th><th>显存</th><th>HBM 带宽</th><th>互联</th><th>功耗</th><th>原生 INT4</th></tr></thead>
                <tbody>
                  {customChips.map(c => (
                    <tr key={c.key}>
                      <td>{c.label}</td>
                      <td>{c.bf16_tflops}T</td>
                      <td>{c.int8_tflops ? c.int8_tflops + 'T' : '—'}</td>
                      <td>{c.int4_tflops ? c.int4_tflops + 'T' : '—'}</td>
                      <td>{c.memory_gb}GB</td>
                      <td>{c.hbm_tbs}TB/s</td>
                      <td>{c.link_gbs ? c.link_gbs + 'GB/s' : '—'}</td>
                      <td>{c.power_kw ? c.power_kw + 'kW' : '—'}</td>
                      <td>{c.native_int4 ? '是' : '否'}</td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
              <p className="src">自定义算力卡规格由使用者按厂商资料填写，工程系数沿用通用经验值（见「当前生效的工程系数」面板说明），未经现场压测校准，误差可能放大。</p>
            </>
          )}
        </div>
      </Card>

      <CustomModelModal open={modelModal} onClose={() => setModelModal(false)} onSaved={refreshCatalog} />
      <CustomChipModal open={chipModal} onClose={() => setChipModal(false)} onSaved={refreshCatalog} />
    </div>
  );
}
