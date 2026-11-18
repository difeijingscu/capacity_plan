import { useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Empty, Input, InputNumber, Popconfirm,
  Segmented, Select, Space, Spin, Table, Tag, Tooltip, App as AntApp,
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
import { chipSelectOptions, chipSpecHint, groupOptions, modelGroup } from './chips';
import { METHOD_HTML, BASIS_HTML } from './businessEvalContent';
import './business-eval.css';

/**
 * 业务场景池：分区结构与交互完全对齐「推理评估 For 产品组合」集成页——
 * 全局配置 → 场景清单 → 算力汇总 → 估算方法说明 → 估算依据与口径。
 * 工程系数与两块静态说明默认收起，展开后仍按步骤/小节逐层点开，首屏只留目录。
 * 与推理评估页的差异仅在数据联动：场景读写当前规划方案的 payload.scenarios，
 * 计算走后端引擎（与页面公式同口径），结果随预览下发并进入测算快照。
 */

/** 场景未配置推理时的兜底口径：芯片与档位跟随全局默认（business_defaults）。 */
const DEFAULT_INFERENCE: Obj = {
  scene_key: 'rag', weight_precision: 'w8a8',
};
/**
 * 精度档：与推理评估页同一套三段式（BF16 / W8A8 / W4A8），
 * 分段控件的文字、说明与字节口径都照搬该页，避免两页说不同的话。
 * W4A8 只在原生支持 INT4 的芯片（950 系列）可选。
 */
const PRECISIONS = [
  { value: 'bf16', label: 'BF16', hint: 'BF16/FP16 峰值 · 权重 2B · KV 2B/token' },
  { value: 'w8a8', label: 'W8A8', hint: 'INT8/FP8 峰值 · 权重 1B · KV 1B/token' },
  { value: 'w4a8', label: 'W4A8', hint: 'INT8 激活峰值 · 权重 0.5B · KV 1B/token' },
];
/** 旧数据里的 `auto` 在引擎里等价 BF16，页面统一按 BF16 呈现与回写。 */
const PRECISION_NORMALIZE: Obj = { auto: 'bf16' };
const normPrecision = (value: unknown): string =>
  PRECISION_NORMALIZE[String(value ?? '')] || String(value ?? '');
/** 旧 schema 档位值 ↔ 页面档位（与后端 engine.PROFILE_TIER 同一套映射）。 */
const PROFILE_TIER: Obj = { optimistic: 'aggressive', neutral: 'standard', conservative: 'conservative' };
const TIER_TO_PROFILE: Obj = { aggressive: 'optimistic', standard: 'neutral', conservative: 'conservative' };
const TIER_FALLBACK = [
  { value: 'conservative', label: '保守' },
  { value: 'standard', label: '均衡' },
  { value: 'aggressive', label: '激进' },
];
const TIER_COEF: Obj = { conservative: '×0.8', standard: '×1', aggressive: '×1.2' };
/** 档位说明：与推理评估页一致的三句。 */
const TIER_NOTES: Obj = {
  conservative: '未调优引擎，结果偏安全',
  standard: '中位数工程经验值，估算结果适中',
  aggressive: '深度优化后，需实测支撑',
};
/** 引擎告警类型与主导因素的中文标签。 */
const WARNING_LABELS: Obj = {
  longInput: '长输入', longOutput: '长输出', crossNode: '跨节点切分',
  bandLimited: '带宽受限', tpotShort: '逐Token未达标', ttft: '首Token未达标',
};
const BOTTLENECK_LABELS: Obj = { mem: '显存', prefill: 'Prefill', decode: 'Decode' };

/**
 * 场景档位里可以一键带入的规模参数（并发在场景主行，其余收进「调整参数」）。
 * 不含 max_ctx：estimate 不消费该字段，界面留输入框会让人以为能调上下文窗口。
 * 同名兼容字段仍保留在 payload 与快照里，供旧方案读取。
 */
const SCENE_FIELDS: [string, string, string][] = [
  ['concurrency', '并发会话', '路'],
  ['prompt_len', '输入长度', 'tok'],
  ['output_len', '输出长度', 'tok'],
  ['ttft_target_ms', '首 Token 目标', 'ms'],
  ['tpot_target_ms', '逐 Token 目标', 'ms'],
];
const ADV_FIELDS = SCENE_FIELDS.filter(([f]) => f !== 'concurrency');
/** 规模字段 → 场景档目录字段（目录里时延默认值叫 ttft_ms / tpot_ms）。 */
const SCENE_PRESET_SOURCE: Obj = { ttft_target_ms: 'ttft_ms', tpot_target_ms: 'tpot_ms' };
const presetField = (preset: Obj, field: string) => preset[SCENE_PRESET_SOURCE[field] ?? field];

/** 场景行等窄位置用短名：去掉「昇腾」前缀但保留档位，仍可区分同款各档。 */
const chipShortLabel = (c: Obj): string => String(c.label || c.key || '').replace(/^昇腾\s*/, '');

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

export default function BusinessPage({ payload, edit, catalog, catalogLoading, preview, refreshCatalog, onImport }: {
  payload: Obj;
  edit: (mutator: (plan: Obj) => void) => void;
  catalog: Obj | null;
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
  /** 预览结果按池 id 定位业务池，不依赖 pools 的返回顺序。 */
  const pool = preview?.pools?.find((p: Obj) => p.id === 'business') ?? preview?.pools?.[0];

  /** 全局硬件：以 business_defaults 为准；老方案没有该字段时从已配置场景推导。 */
  const configured = payload.scenarios.filter((s: Obj) => s.inference);
  const derivedChips = [...new Set(configured.map((s: Obj) => s.inference.chip_key).filter(Boolean))] as string[];
  const derivedTiers = [...new Set(configured.map((s: Obj) => PROFILE_TIER[s.inference.profile] || s.inference.profile).filter(Boolean))] as string[];
  const derivedPrecisions = [...new Set(configured.map((s: Obj) => normPrecision(s.inference.weight_precision)).filter(Boolean))] as string[];
  const defaults = payload.business_defaults || {};
  const globalChip: string | undefined = defaults.chip_key
    ?? (derivedChips.length === 1 ? derivedChips[0] : derivedChips.length === 0 ? '910c' : undefined);
  const globalTier: string = defaults.profile
    ? (PROFILE_TIER[defaults.profile] || defaults.profile)
    : (derivedTiers.length === 1 ? derivedTiers[0] : 'standard');
  const mixedChip = !defaults.chip_key && derivedChips.length > 1;
  /**
   * 全局芯片与场景芯片分裂：正常路径下 applyChipGlobal 会把已配置场景一起改写，
   * 只有外部脚本直接写 payload 才会出现。此时已配置场景按各自的 chip_key 出卡数，
   * 页面顶部显示的全局芯片并不代表实际口径，必须提示，不能静默。
   */
  const driftedChips: string[] = defaults.chip_key
    ? (derivedChips.filter((c: string) => c !== defaults.chip_key) as string[])
    : [];
  const globalProfile = TIER_TO_PROFILE[globalTier] || 'neutral';
  const globalChipInfo: Obj = chips.find(c => c.key === globalChip) || {};
  /**
   * 全局量化精度：场景清单不再提供逐场景选择，这里是唯一入口。
   * 显式写入即以全局为准；老方案没有该字段时按各场景历史值推导，
   * 不一致则提示「各场景不一致」，等用户选定后统一，避免静默改掉历史结果。
   */
  const storedPrecision: string | undefined = defaults.weight_precision ? normPrecision(defaults.weight_precision) : undefined;
  // 平台默认精度是 W8A8（2026-11-17 起），与后端 BusinessDefaults 的缺省值一致：
  // 既不存储也不推导的空白方案，展示与出卡都按 W8A8，不出现「页面 BF16、引擎 W8A8」。
  const globalPrecision: string = storedPrecision
    || (derivedPrecisions.length === 1 ? derivedPrecisions[0] : 'w8a8');
  const mixedPrecision = !storedPrecision && derivedPrecisions.length > 1;
  /** 只有「老方案无全局字段且各场景精度不一致」时才不强制取全局值。 */
  const precisionIsGlobal = !!storedPrecision || derivedPrecisions.length <= 1;
  const precisionHint = (PRECISIONS.find(p => p.value === globalPrecision) || PRECISIONS[0]).hint;

  /** 三个下拉都按目录分组：场景按业务组、芯片按系列、模型按厂商（label 前缀）。 */
  const sceneOptions = groupOptions(scenes, (s: Obj) => String(s.group || '其他'),
    x => ({ value: x.key, label: x.name, title: x.hint }));
  const chipOptions = chipSelectOptions(chips);
  const modelOptions = groupOptions(models, modelGroup,
    m => ({ value: m.key, label: (m.label || m.key) + (m.custom ? ' · 自定义' : '') }));
  const tierOptions: { value: string; label: string }[] = (catalog?.tiers ?? []).map((t: Obj) =>
    ({ value: String(t.key), label: t.label + ' ' + (TIER_COEF[t.key] || '') }));
  /** 与推理评估页一致的分段控件选项：W4A8 需芯片原生 INT4，其余档位始终可选。 */
  const precisionOptions = (chip: Obj) => PRECISIONS.map(p =>
    p.value === 'w4a8' && !chip.native_int4 ? { ...p, disabled: true } : p);

  /** 全局改写：写入 business_defaults 并同步所有已配置场景。 */
  function applyChipGlobal(value: string) {
    const label = chips.find(c => c.key === value)?.label || value;
    const doit = () => edit(plan => {
      plan.business_defaults = { ...(plan.business_defaults || {}), chip_key: value, profile: globalProfile };
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
      plan.business_defaults = { ...(plan.business_defaults || {}), chip_key: globalChip || '910c', profile: TIER_TO_PROFILE[value] || value };
      plan.scenarios.forEach((s: Obj) => { if (s.inference) s.inference.profile = TIER_TO_PROFILE[value] || value; });
    });
  }
  /**
   * 全局量化精度：与算力卡同样处理——写入全局默认并同步已配置场景，
   * 只有存在「精度与目标值不同」的场景时才确认，避免无谓弹窗。
   * 比较时先归一：旧值 auto 与 bf16 是同一口径，不该触发"有场景要改"。
   */
  function applyPrecisionGlobal(value: string) {
    const label = PRECISIONS.find(p => p.value === value)?.label || value;
    const affected = configured.filter((s: Obj) => normPrecision(s.inference.weight_precision) !== value);
    const doit = () => edit(plan => {
      // 只改精度，顺带保留已有的 chip_key/profile；不在这里重写全局芯片默认
      plan.business_defaults = { ...(plan.business_defaults || {}), weight_precision: value };
      plan.scenarios.forEach((s: Obj) => { if (s.inference) s.inference.weight_precision = value; });
    });
    if (affected.length > 0) {
      modal.confirm({
        title: '统一全部场景的量化精度？',
        content: `将把 ${affected.length} 个场景的精度改为「${label}」；尚未配置的场景在选定模型后跟随该全局值。`,
        okText: '统一', cancelText: '取消', onOk: doit,
      });
    } else doit();
  }

  /** 后端解析结果：pool.resolved_specs 覆盖全部场景（含停用），items 只含计算成功的启用场景。 */
  function resolvedOf(target: Obj): Obj | undefined {
    return pool?.resolved_specs?.[target.id] || rating(target.id);
  }

  /**
   * 场景的推理配置一律以后端解析结果为准，前端不再复刻迁移规则。
   *
   * 过去前端自己按 components[0] + 默认场景档折算，后端却按「首个启用组件 + template 映射
   * 场景档 + TTFT/输出速率」迁移，两边不是同一套：页面显示一套、引擎算另一套，
   * 而且用户改任一参数就会把这套错误口径写回方案。现在只把后端结果套上全局兜底用于展示；
   * 后端还没有结果或解析失败时不猜模型，由 UI 显示「待补全」。
   */
  function specOf(target: Obj): Obj {
    const base = { ...DEFAULT_INFERENCE, chip_key: globalChip || '910c', profile: globalProfile, weight_precision: globalPrecision };
    const merged = target.inference
      ? { ...base, ...target.inference }
      : resolvedOf(target)?.spec
        ? { ...base, ...resolvedOf(target)!.spec }
        : { ...base, model_key: undefined, scene_key: undefined };
    // 量化精度是方案级设置：全局有明确口径时覆盖场景里的历史值，避免页面显示与引擎口径分裂。
    if (precisionIsGlobal) merged.weight_precision = globalPrecision;
    return merged;
  }

  /** 迁移状态：直接映射后端 origin / error，不再本地推断。 */
  function legacyState(target: Obj): 'configured' | 'migrated' | 'missing' | 'unsupported' | 'inactive' | 'unknown' {
    if (target.inference) return 'configured';
    const resolved = resolvedOf(target);
    if (!resolved) return 'unknown';
    if (resolved.error === 'SCENARIO_DISABLED_COMPONENTS') return 'inactive';
    if (resolved.error) {
      const nonLlm = (target.components || []).some((c: Obj) => NON_LLM_TASKS.has(c.task_type));
      return nonLlm ? 'unsupported' : 'missing';
    }
    return resolved.origin === 'migrated' ? 'migrated' : 'configured';
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
  /**
   * 场景行必须读 pool.items：那里才是逐场景的完整结果，带 trace.detail.tree（杜邦树）、
   * warnings、bottleneck、latency_status。pool.scenarios 只是结果页用的概览摘要，
   * 只有卡数/算力/模型等少量字段，从摘要取数会让「计算过程」按钮永远 disabled。
   * 旧版响应没有 items 时退回摘要，至少保住卡数与状态显示。
   */
  const sceneItems: Obj[] = pool?.items?.length ? pool.items : (pool?.scenarios ?? []);
  const rating = (id: string) => sceneItems.find((x: Obj) => x.id === id);

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
    // 新场景插到最上方：场景多时列表会滚出首屏，追加到末尾等于「点了没反应」。
    edit(plan => plan.scenarios.unshift({
      id, name: '新业务场景', description: '', enabled: true, source_reference: {},
      components: [],
      inference: {
        ...DEFAULT_INFERENCE,
        chip_key: globalChip || '910c', profile: globalProfile,
        weight_precision: globalPrecision,
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
    if (legacy === 'inactive') {
      return <Tooltip title="该场景的组件都已停用，但场景仍处于「计入规划」状态；请启用至少一个组件，或取消计入规划。">
        <Tag color="red">待启用</Tag>
      </Tooltip>;
    }
    if (legacy === 'unknown') {
      return <Tooltip title="本次预览还没有返回该场景的解析结果；保存并测算后会自动重算。">
        <Tag>待解析</Tag>
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
    // pool.items 不带 completeness；按与后端摘要同一口径用 warnings 推导。
    const complete = row.completeness
      ? row.completeness === 'COMPLETE'
      : !(row.warnings || []).length;
    return complete
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
            <small className="muted">&nbsp;</small>
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
            <label>并发会话</label>
            <InputNumber aria-label={'并发会话-' + s.name} min={1} style={{ width: '100%' }} disabled={off}
              value={spec.concurrency == null || off ? null : Number(spec.concurrency)}
              placeholder={off ? '不适用' : String(sceneOf(spec).concurrency ?? '待填写')}
              onChange={v => write(s, { concurrency: v ?? null })} />
            <small className="muted">&nbsp;</small>
          </div>
          <div className="scen-badge">
            {row?.cards_planned != null
              ? <>
                  <span className="cards">{num(row.cards_planned, 0)}<small>张</small></span>
                  <small className="muted">{row.cards_planned === row.cards
                    ? `三维最小 ${num(row.cards, 0)} 张`
                    : `三维最小 ${num(row.cards, 0)} 张 · 补偶后 ${num(row.cards_planned, 0)} 张`} · {capacity(row.base_p)}{row.sla_passed === false || row.latency_status === 'NOT_MET' ? ' · 时延未达标' : ''}</small>
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
          <Tooltip title={!tree ? '该场景还没有估算结果：确认模型、场景类型与并发后会自动重算，随后可展开计算过程' : '杜邦式逐层拆解，可展开到原始参数'}>
            {/* 包一层 span：disabled 按钮本身不触发鼠标事件，否则提示不会出现 */}
            <span style={{ display: 'inline-block' }}>
              <Button size="small" type={fold === 'fx' ? 'primary' : 'default'} ghost={fold === 'fx'}
                disabled={!tree} onClick={() => toggleFold(s.id, 'fx')}>计算过程</Button>
            </span>
          </Tooltip>
          <span className="right">
            <small className="muted">{chip.label ? chipShortLabel(chip) : ''}{off ? '' : ` · ${(PRECISIONS.find(p => p.value === globalPrecision) || PRECISIONS[0]).label}`}</small>
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
                    min={field === 'tpot_target_ms' ? 1 : field === 'ttft_target_ms' ? 50 : 1}
                    value={spec[field] == null ? null : Number(spec[field])}
                    placeholder={String(presetField(sceneOf(spec), field) ?? '')}
                    addonAfter={unit}
                    onChange={v => write(s, { [field]: v ?? null })} />
                </div>
              ))}
              <div className="field" style={{ gridColumn: '1 / -1' }}>
                <label>场景描述</label>
                <Input.TextArea value={s.description} rows={2} aria-label={'场景描述-' + s.name}
                  onChange={e => edit(p => { p.scenarios.find((x: Obj) => x.id === s.id).description = e.target.value; })} />
              </div>
            </div>
            <div className="note-line" style={{ marginTop: 10 }}>
              <InfoCircleOutlined aria-hidden="true" />
              留空的字段取场景档位默认值；并发按业务同时在线会话估算，不用人数直接代替；
              最大上下文与前缀命中率不参与当前计算，界面不再提供入口，旧方案取值原样保留。
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

  const byModel = sceneItems.length ? summarizeByModel(sceneItems) : [];
  const missingCount = pool?.missing_items?.length ?? 0;
  const estimatedCount = sceneItems.filter((x: Obj) => x.cards != null).length;

  return (
    <div className="main-panel business-eval">
      {/* ============ ① 全局配置 ============ */}
      <Card className="be-global">
        <div className="be-sec-h">
          <h2>全局配置</h2>
          <span>算力卡、量化精度与工程档位对全部场景统一生效；改动立即重算</span>
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
            <div className="be-chip-hint">{chipSpecHint(globalChipInfo)}</div>
          </div>
          <div className="field">
            <label>推理量化精度（全局）
              <Tooltip title="W 权重字节决定显存装载量，A 激活精度决定计算峰值档位，KV 精度（自动跟随）决定并发容量。W8A8 相比 BF16：权重减半、KV 减半、算力翻倍。W4A8 需芯片原生支持 INT4。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            {/* 与推理评估页同一套三段式按钮，不用下拉：三档并列，一眼可比 */}
            <Segmented block aria-label="全局推理量化精度"
              value={mixedPrecision ? undefined : globalPrecision}
              options={precisionOptions(globalChipInfo)}
              onChange={v => applyPrecisionGlobal(String(v))} />
            <div className="be-chip-hint">
              {mixedPrecision ? '各场景当前不一致，点选后统一' : precisionHint}
            </div>
          </div>
          <div className="field">
            <label>工程开销档位（全局）
              <Tooltip title="只缩放效率类系数：Prefill MFU 与带宽利用率全额跟随，单卡显存利用率半幅；结构性开销与口径常数不受档位影响。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            <Segmented block aria-label="全局工程档位" value={globalTier}
              options={tierOptions.length ? tierOptions : TIER_FALLBACK.map(t => ({ ...t, label: t.label + ' ' + TIER_COEF[t.value] }))}
              onChange={v => applyTierGlobal(String(v))} />
            <div className="be-chip-hint">{TIER_NOTES[globalTier] || '基准值 × 档位系数，作用于下方生效系数'}</div>
          </div>
        </div>
        {/* 外部写入 payload 才会出现芯片分裂：页面顶部显示的全局值此时不代表实际出卡口径 */}
        {driftedChips.length > 0 && (
          <Alert type="warning" showIcon
            message={'全局算力卡与 ' + driftedChips.length + ' 类场景芯片不一致'}
            description={<Space wrap>
              <span>
                已配置场景按各自的芯片出卡数：{driftedChips.map((k: string) =>
                  chips.find((x: Obj) => x.key === k)?.label || k).join('、')}；
                顶部全局值只对未配置场景与后续新增场景生效。
              </span>
              <Button size="small" onClick={() => applyChipGlobal(globalChip || driftedChips[0])}>统一为全局算力卡</Button>
            </Space>} />
        )}
        {/* 工程系数：默认收起，用户需要时再展开（与推理评估集成页同一交互层级） */}
        <details className="be-fold be-fold-sub">
          <summary>
            <span className="be-fold-t">当前生效的工程系数（可调）</span>
            <span className="be-fold-hint">基准值 × 档位系数（{TIER_COEF[globalTier] || '×1'}）= 生效值；改动写入参数覆盖层长期生效</span>
            <span className="be-fold-btn" aria-hidden="true"><i /></span>
          </summary>
          <div className="be-fold-body">
            <CoefPanel chipKey={globalChip} tier={globalTier} chipLabel={globalChipInfo.label}
              onChanged={() => edit(() => { /* 系数已写入参数覆盖层；触发一次预览重算 */ })} />
          </div>
        </details>
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
          每个场景选择模型、场景类型并填写并发会话数；算力卡、推理量化精度与工程档位取自上方全局配置。
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
          <span>逐场景独立出卡后求和</span>
        </div>
        {pool ? (
          <div className="be-kpis">
            <div className="be-kpi hl">
              <div className="k">所需卡数</div>
              <div className="v">{num(pool.cards_planned, 0)}<small>张</small></div>
              <div className="sub">{pool.cards_planned === pool.cards
                ? `三维最小 ${num(pool.cards, 0)} 张`
                : `三维最小 ${num(pool.cards, 0)} 张 · 补偶后 ${num(pool.cards_planned, 0)} 张`} · 约 {num(Math.ceil(Number(pool.cards_planned || 0) / 8), 0)} 台服务器（8 卡/台）</div>
            </div>
            <div className="be-kpi">
              <div className="k">需求算力（BF16 等效）</div>
              <div className="v">{capacity(pool.planned_p)}</div>
              <div className="sub">卡数 × 芯片 BF16 峰值折算的等效参考，与卡数不同量纲</div>
            </div>
            <div className="be-kpi">
              <div className="k">规划等效算力</div>
              <div className="v">{capacity(pool.capacity_planned_p)}</div>
              <div className="sub">等效供给（BF16 基准）</div>
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

      {/* ============ ④ 估算方法说明：整块默认收起，展开后 5 个步骤仍逐条点开 ============ */}
      <Card className="be-fold-card">
        <details className="be-fold">
          <summary>
            <span className="be-fold-t">估算方法说明</span>
            <span className="be-fold-hint">三维约束取最大 · 杜邦式逐层拆解（5 步，按需点开）</span>
            <span className="be-fold-btn" aria-hidden="true"><i /></span>
          </summary>
          <div className="be-fold-body">
            <div className="be-doc" dangerouslySetInnerHTML={{ __html: METHOD_HTML }} />
          </div>
        </details>
      </Card>

      {/* ============ ⑤ 估算依据与口径：整块默认收起，展开后按小节点开；免责声明为最内一层 ============ */}
      <Card className="be-fold-card">
        <details className="be-fold">
          <summary>
            <span className="be-fold-t">估算依据与口径</span>
            <span className="be-fold-hint">公开文献 · 官方数据来源 · 免责声明（按需逐层展开）</span>
            <span className="be-fold-btn" aria-hidden="true"><i /></span>
          </summary>
          <div className="be-fold-body">
            <div className="be-doc">
              <div dangerouslySetInnerHTML={{ __html: BASIS_HTML }} />
              {customChips.length > 0 && (
                <details className="bsec">
                  <summary>已登记的自定义算力卡（{customChips.length} 张）</summary>
                  <div className="bsec-body">
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
                  </div>
                </details>
              )}
            </div>
          </div>
        </details>
      </Card>

      <CustomModelModal open={modelModal} onClose={() => setModelModal(false)} onSaved={refreshCatalog} />
      <CustomChipModal open={chipModal} onClose={() => setChipModal(false)} onSaved={refreshCatalog} />
    </div>
  );
}
