import {
  Alert, Button, Card, Descriptions, Empty, InputNumber, Select,
  Space, Switch, Table, Tag, Tooltip, App as AntApp,
} from 'antd';
import {
  ApartmentOutlined, CheckCircleOutlined, ExperimentOutlined, InfoCircleOutlined,
} from '@ant-design/icons';
import { capacity, num } from './api';
import type { Obj } from './api';
import { chipSelectOptions, chipSpecHint, matchModel, modelSelectOptions } from './chips';
import './business-eval.css';

/**
 * 开发测试池（模型微调）：分区结构与业务场景页一致——
 * 全局配置 → 模型开发测试强度 → 算力汇总。
 *
 * 与业务池的差别在业务形态：本池只规划「给模型做微调」所需的资源，不含效果评测。
 * 引擎侧 `development.models` 是列表，按「并行槽位 × 最大单任务容量」聚合：
 * - 新建方案由后端缺省带一条 LoRA 记录；
 * - 页面的每次编辑（换模型、换微调方法）都只**原地更新第一条**，不删除其余候选；
 * - 旧方案存在多条候选时显式说明「汇总是按全部候选聚合」并给出收敛入口，
 *   不用一次普通编辑静默丢弃候选（那会让决定最大值的模型消失而看不出原因）。
 */

/** 强度档的名称与说明。参数默认值来自后端 INTENSITIES，页面只负责呈现。 */
const INTENSITIES: [string, string, string][] = [
  ['light', '轻度', '少量实验，单个微调任务排队'],
  ['standard', '标准', '常态化实验，按标准数据与轮次规划'],
  ['high', '高强度', '多任务并行，更大的数据与更短窗口'],
];

/**
 * 强度档参数兜底值，与 engine/calculator.py 的 INTENSITIES 一致。
 * 正常情况下由 `/api/v1/defaults` 下发覆盖；缺下发时用它保证页面不出现空白。
 */
const INTENSITY_FALLBACK: Obj = {
  light: { train_data_tokens: 1_000_000, epochs: 1, train_deadline_hours: 24, sequence_length: 2048, train_slots: 1 },
  standard: { train_data_tokens: 5_000_000, epochs: 2, train_deadline_hours: 12, sequence_length: 2048, train_slots: 1 },
  high: { train_data_tokens: 20_000_000, epochs: 3, train_deadline_hours: 8, sequence_length: 4096, train_slots: 2 },
};

/** 训练系数默认值，与 schemas.Development 的缺省一致。 */
const COEF_DEFAULTS = { train_k: 4, train_eta: 0.25, adapter_fraction: 0.005 };

const MEMORY_LABELS: Obj = {
  COMPLETE: '完整估算', PROXY: '经验代理', WEIGHT_LOWER_BOUND: '仅显存下界', UNKNOWN: '待核验',
};
const METHOD_LABELS: Obj = { lora: 'LoRA', qlora: 'QLoRA' };

/** 任务参数的可编辑项，与 Development 的字段同名。 */
const TASK_FIELDS: [string, string, string][] = [
  ['train_data_tokens', '每任务微调数据 Token', 'tok'],
  ['epochs', '训练轮数', '轮'],
  ['train_deadline_hours', '微调完成时间', '小时'],
  ['sequence_length', '训练序列长度', 'tok'],
  ['train_slots', '同时微调槽位', '个'],
];

export default function DevelopmentPage({ payload, edit, catalog, catalogLoading, preview, intensityDefaults, derivationReady, derivationStale, onDerivation }: {
  payload: Obj;
  edit: (mutator: (plan: Obj) => void) => void;
  catalog: Obj | null;
  catalogLoading?: boolean;
  preview: Obj | null;
  /** `/api/v1/defaults` 的 intensities：三档强度的后端默认任务参数。 */
  intensityDefaults?: Obj;
  derivationReady?: boolean;
  derivationStale?: boolean;
  onDerivation?: () => void;
}) {
  const { message } = AntApp.useApp();
  const c: Obj = payload.development;
  const models: Obj[] = [...(catalog?.models ?? []), ...(catalog?.custom_models ?? [])];
  const chips: Obj[] = [...(catalog?.chips ?? []), ...(catalog?.custom_chips ?? [])];

  const entries: Obj[] = c.models ?? [];
  /** 本页只呈现一个微调对象：取第一条作为「当前模型」；没有候选就是「未选择」。 */
  const entry: Obj | undefined = entries[0];
  /**
   * 没有候选时保持 undefined，页面不凭空显示一个用户没选过的模型。旧实现回落到
   * DeepSeek-V4-Flash：下拉显示「已选」，引擎却报「请选择需要微调的模型」。
   */
  const modelKey: string | undefined = entry?.model_id;
  const method: string = entry?.method ?? 'lora';
  const extraModels = Math.max(0, entries.length - 1);
  const model: Obj = matchModel(models, modelKey) || {};
  const chip = chips.find((x: Obj) => x.key === c.chip_key) || {};

  const pool: Obj | undefined = preview?.pools?.find((p: Obj) => p.id === 'development');
  const detail: Obj = pool?.cards_detail || {};
  const items: Obj[] = pool?.items ?? [];
  /**
   * 多候选时引擎按 `max(单任务容量)` 聚合，`items[0]` 只是排在第一位的候选：
   * 直接拿它展示会把「最大单任务容量」写成第一位的值，显存构成也会取错条目。
   * 这里取容量最大的那条作为「本池代表性任务」，KPI 与明细脚注都读它。
   */
  const item: Obj | undefined = items.reduce<Obj | undefined>((best, r) => {
    if (r.base_p == null) return best;
    if (!best || best.base_p == null) return r;
    return Number(r.base_p) > Number(best.base_p) ? r : best;
  }, items[0]);
  const maxItemBaseP = item?.base_p == null ? null : Number(item.base_p);
  const vars: Obj = item?.trace?.variables || {};
  const headroomPct = num(Number(payload.headroom ?? 0) * 100, 0);

  /** 强度档生效参数：payload → 档位默认值 → 引擎快照，逐级回退。 */
  const preset: Obj = (intensityDefaults || INTENSITY_FALLBACK)[c.intensity] || INTENSITY_FALLBACK[c.intensity] || {};
  const liveCfg: Obj = pool?.intensity_parameters || {};
  const eff = (key: string) => c[key] ?? preset[key] ?? liveCfg[key];
  const slots = Number(eff('train_slots') ?? 1);
  const coef = (key: keyof typeof COEF_DEFAULTS) => Number(c[key] ?? COEF_DEFAULTS[key]);

  function change(key: string, value: unknown) { edit(p => { p.development[key] = value; }); }

  /**
   * 切强度档：档位是一整套任务参数预设，切换时把手动改过的字段清空，
   * 让五项一起回落到新档默认值——否则「换了档位但数据量还是上一档」会算出假结果。
   */
  function setIntensity(id: string) {
    edit(p => {
      p.development.intensity = id;
      TASK_FIELDS.forEach(([key]) => { p.development[key] = null; });
    });
  }

  /**
   * 新建一条候选记录，方法取 LoRA。只在用户明确选了模型时调用——页面不替用户挑模型。
   */
  function defaultEntry(key: string): Obj {
    return { model_id: key, method: 'lora' };
  }

  /**
   * 开启/关闭本池只改开关本身。
   *
   * 旧实现在开启时若没有候选就补一条默认模型，等于按一次开关方案里就多出一个没选过的模型
   * （还会进快照）。现在宁可把「未选择模型」显式留在页面上。
   */
  function setEnabled(next: boolean) {
    edit(p => { p.development.enabled = next; });
  }

  /** 选模型：只替换第一条的 `model_id`，其余候选原样保留。 */
  function setModel(nextKey: string) {
    if (entries.slice(1).some((m: Obj) => m.model_id === nextKey)) {
      message.warning('该模型已存在于其它候选里，请先收敛为单模型再修改');
      return;
    }
    edit(p => {
      const list = p.development.models || [];
      p.development.models = list.length
        ? list.map((m: Obj, i: number) => (i === 0 ? { ...m, model_id: nextKey } : m))
        : [defaultEntry(nextKey)];
    });
  }

  /**
   * 换微调方法：只改第一条的方法，其余候选及其方法原样保留。
   *
   * 旧实现把列表重写成 `[{第一条 model_id, 新方法}]`，等于「改方法」顺手删掉所有其它候选。
   * 引擎按「槽位 × 最大单任务容量」聚合，删掉决定最大值的那条会让需求算力整段下跌
   * （实测两候选方案改方法后 0.1 P → 0.0304 P，卡数却不变，页面上看不出异常）。
   */
  function setMethod(next: string) {
    // 方法存在候选记录上：没有候选就没有可写的位置，旧实现会顺手建一条默认模型的候选。
    if (!entries.length) {
      message.warning('请先选择需要微调的模型，再设置微调方法');
      return;
    }
    edit(p => {
      const list = p.development.models || [];
      if (!list.length) return;
      p.development.models = list.map((m: Obj, i: number) => (i === 0 ? { ...m, method: next } : m));
    });
  }

  /** 旧方案的多候选模型收敛成单模型（保留第一条，不重排方法）。 */
  function normalizeModels() {
    edit(p => {
      const first = (p.development.models || [])[0];
      if (first) p.development.models = [first];
    });
    message.success('已收敛为单模型');
  }

  /** 恢复当前强度档的默认任务参数：把被改写的字段清空，回落档位值。 */
  function resetTaskFields() {
    edit(p => { TASK_FIELDS.forEach(([key]) => { p.development[key] = null; }); });
  }

  const memoryParts = [    ['基座权重', vars.base_weight_gb],
    ['adapter', vars.adapter_state_gb],
    ['激活', vars.activation_gb],
    ['工作区', vars.workspace_gb],
  ] as [string, unknown][];

  return (
    <div className="main-panel business-eval">
      {/* ============ ① 全局配置 ============ */}
      <Card className="be-global">
        <div className="be-sec-h">
          <h2>全局配置</h2>
          <span>算力卡与训练系数对本池统一生效；训练系数收在下方折叠区，改动立即重算</span>
          <span className="act">
            <Space>
              <span className="muted">本池计入规划</span>
              <Switch aria-label="开发测试启用" checked={c.enabled} checkedChildren="已启用" unCheckedChildren="未启用"
                onChange={v => setEnabled(v)} />
            </Space>
          </span>
        </div>
        <div className="be-global-grid is-2">
          <div className="field">
            <label>算力卡（本池）
              <Tooltip title="与业务场景共用同一套算力卡规格（含自定义卡），三池卡数才可比；训练与推理共用同一张卡的算力与显存。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            <Select aria-label="开发池算力卡" style={{ width: '100%' }} value={c.chip_key || undefined}
              placeholder="未选择则本池不出卡数" allowClear showSearch optionFilterProp="label"
              options={chipSelectOptions(chips)} onChange={v => change('chip_key', v ?? null)} />
            <div className="be-chip-hint">{chipSpecHint(chip)}</div>
          </div>
          <div className="field">
            <label>余量与故障冗余（方案级，只读）</label>
            <div className="be-chip-hint" style={{ marginTop: 0, fontSize: 12 }}>
              +{headroomPct}% 方案余量 · +1 张故障冗余
              <br />余量比例在方案设置中调整，对本池与业务场景同时生效。
            </div>
          </div>
        </div>
        {/* 训练系数：与业务页「当前生效的工程系数」同一交互层级——默认收起 */}
        <details className="be-fold be-fold-sub">
          <summary>
            <span className="be-fold-t">当前生效的训练系数（可调）</span>
            <span className="be-fold-hint">
              k {num(coef('train_k'))} · ηtrain {num(coef('train_eta'))} · adapter {num(coef('adapter_fraction') * 100, 2)}%
              · 槽位 {num(slots, 0)} 个
            </span>
            <span className="be-fold-btn" aria-hidden="true"><i /></span>
          </summary>
          <div className="be-fold-body">
            <div className="form-grid">
              <div className="field">
                <label>训练工作量系数 k
                  <Tooltip title="微调工作量 = k × 激活参数 × 数据 Token × 轮数。k 吸收反向传播、重算与优化器开销，默认 4（前向 3 倍）。">
                    <InfoCircleOutlined aria-hidden="true" />
                  </Tooltip>
                </label>
                <InputNumber aria-label="训练工作量系数" style={{ width: '100%' }} min={1} max={12} step={0.5}
                  value={coef('train_k')}
                  onChange={v => change('train_k', v ?? COEF_DEFAULTS.train_k)} />
                <div className="be-chip-hint">默认 {COEF_DEFAULTS.train_k} · 经验系数，需实测校准</div>
              </div>
              <div className="field">
                <label>训练效率 ηtrain
                  <Tooltip title="训练阶段实际算力占芯片峰值算力的比例；越高越省卡。默认 0.25。">
                    <InfoCircleOutlined aria-hidden="true" />
                  </Tooltip>
                </label>
                <InputNumber aria-label="训练效率" style={{ width: '100%' }} min={0.01} max={1} step={0.05}
                  value={coef('train_eta')}
                  onChange={v => change('train_eta', v ?? COEF_DEFAULTS.train_eta)} />
                <div className="be-chip-hint">默认 {COEF_DEFAULTS.train_eta} · 经验效率，需实测校准</div>
              </div>
              <div className="field">
                <label>adapter 参数比例
                  <Tooltip title="LoRA adapter 参数占基座参数的比例，决定 adapter 显存（× 16 字节/参数）。默认 0.5%。">
                    <InfoCircleOutlined aria-hidden="true" />
                  </Tooltip>
                </label>
                <InputNumber aria-label="adapter 参数比例" style={{ width: '100%' }} min={0.01} max={20} step={0.1}
                  value={Number((coef('adapter_fraction') * 100).toFixed(2))} addonAfter="%"
                  onChange={v => change('adapter_fraction', Number(v ?? 0.5) / 100)} />
                <div className="be-chip-hint">默认 {COEF_DEFAULTS.adapter_fraction * 100}% · 只影响 adapter 显存</div>
              </div>
            </div>
            <div className="note-line" style={{ marginBottom: 0 }}>
              <InfoCircleOutlined aria-hidden="true" />
              训练系数是工程假设，不是厂商保证值；上表数值即本次出卡实际采用值，改动后本池立即重算。
            </div>
          </div>
        </details>
      </Card>

      {/* ============ ② 模型开发测试强度 ============ */}
      <Card>
        <div className="be-sec-h">
          <h2>模型开发测试强度</h2>
          <span>{extraModels > 0
            ? `强度档决定单任务工作量与并行槽位：取 ${entries.length} 个候选里的最大单任务容量 × 槽位数`
            : '强度档决定单任务工作量与并行槽位：单任务容量 × 槽位数即本池需求算力'}</span>
        </div>
        <div className="intensity-grid">
          {INTENSITIES.map(([id, name, note]) => {
            const p: Obj = (intensityDefaults || INTENSITY_FALLBACK)[id] || INTENSITY_FALLBACK[id] || {};
            return <button key={id} className={'intensity-card ' + (c.intensity === id ? 'chosen' : '')}
              onClick={() => setIntensity(id)}>
              <ExperimentOutlined aria-hidden="true" />
              <strong>{name}</strong>
              <p>{note}</p>
              <div className="be-chip-hint" style={{ marginTop: 10 }}>
                数据 {num(Number(p.train_data_tokens || 0) / 1e6)}M tok · {num(p.epochs, 0)} 轮 ·
                {' '}{num(p.train_deadline_hours, 0)} 小时 · {num(p.train_slots, 0)} 槽位
              </div>
              {c.intensity === id && <CheckCircleOutlined aria-hidden="true" className="chosen-check" />}
            </button>;
          })}
        </div>

        <div className="form-grid">
          <div className="field">
            <label>需要微调的模型
              <Tooltip title="模型清单与业务场景页「场景清单」共用同一份分类（按厂商标识分组，含自定义模型）；本池只规划一个模型。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            {/* 不用 Spin 包裹：Spin 的 wrapper 是 inline-block，会把 width:100% 的 Select 挤成内容宽度。
                没有候选记录时 value 为 undefined，下拉留空显示 placeholder——选任何一个值都会写入候选。 */}
            <Select aria-label="需要微调的模型" style={{ width: '100%' }}
              value={model.key || modelKey} loading={!!catalogLoading}
              placeholder="选择需要微调的模型" showSearch optionFilterProp="label"
              options={modelSelectOptions(models)} onChange={setModel} />
            <small className="muted">
              {model.total_b
                ? `总参 ${num(model.total_b)}B · 激活 ${num(model.active_b)}B · ${model.arch}`
                : entry
                  ? `目录里没有「${entry.model_id}」的结构数据，请重新选择`
                  : '本方案还没有候选模型记录；选择一个模型后才会出卡数'}
            </small>
          </div>
          <div className="field">
            <label>微调方法
              <Tooltip title="QLoRA 用 4bit 量化基座（权重显存约减半），但需要额定量化元数据；LoRA 按 FP16 载入基座。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            <Select aria-label="微调方法" style={{ width: '100%' }} value={method} disabled={!entry}
              options={[{ value: 'lora', label: 'LoRA（FP16 基座）' }, { value: 'qlora', label: 'QLoRA（需要量化基线）' }]}
              onChange={setMethod} />
            <small className="muted">
              {entry
                ? `基座 ${METHOD_LABELS[method] || method} · 方法只改显存口径，不改训练工作量`
                : '方法存在候选模型上，先选择模型'}
            </small>
          </div>
          <div className="quota-summary">
            <span>并行微调槽位</span>
            <strong>{num(slots, 0)}</strong>
            <small>{extraModels > 0 ? '最大单任务容量' : '单任务容量'} {maxItemBaseP == null ? '待补充' : capacity(maxItemBaseP)} · 槽位不必常驻同一模型</small>
          </div>
        </div>

        {extraModels > 0 && (
          <Alert className="below" type="warning" showIcon
            message={`本方案有 ${entries.length} 个候选模型，下方汇总按这 ${entries.length} 个候选聚合`}
            description={<Space wrap>
              <span>
                本页只编辑排在第一位的「{model.label || modelKey}」；引擎按「槽位 × 最大单任务容量」取所有候选的最大值，
                因此另外 {extraModels} 个候选仍会影响算力。改动模型或方法只会作用于第一位，不会删除其余候选。
              </span>
              <Button size="small" onClick={normalizeModels}>收敛为单模型</Button>
            </Space>} />
        )}

        <details className="be-fold be-fold-sub">
          <summary>
            <span className="be-fold-t">强度档位的具体任务参数（可调）</span>
            <span className="be-fold-hint">
              数据 {num(Number(eff('train_data_tokens') || 0) / 1e6)}M tok · {num(eff('epochs'), 0)} 轮 ·
              {' '}{num(eff('train_deadline_hours'), 0)} 小时 · 序列 {num(eff('sequence_length'), 0)} · 槽位 {num(slots, 0)}
            </span>
            <span className="be-fold-btn" aria-hidden="true"><i /></span>
          </summary>
          <div className="be-fold-body">
            <div className="form-grid">
              {TASK_FIELDS.map(([key, label, unit]) => <div className="field" key={key}>
                <label>{label}</label>
                <InputNumber aria-label={label} style={{ width: '100%' }} min={1}
                  value={eff(key) == null ? null : Number(eff(key))}
                  onChange={v => change(key, v ?? null)} addonAfter={unit} />
                <small className="muted">
                  档位默认 {num(INTENSITY_FALLBACK[c.intensity]?.[key])} · 留空取档位值
                </small>
              </div>)}
            </div>
            <Button size="small" onClick={resetTaskFields}>恢复当前强度档默认值</Button>
          </div>
        </details>

        <div className="note-line" style={{ marginTop: 14 }}>
          <InfoCircleOutlined aria-hidden="true" />
          只规划模型微调，不含效果评测。单任务训练量 = k × 激活参数 × 数据 Token × 轮数；
          需求算力 = 单任务训练量 ÷（完成时间 × 3600 × ηtrain）；
          本池算力 = 单任务容量 × 并行槽位（不是所有候选模型累加）。
        </div>
      </Card>

      {/* ============ ③ 算力汇总 ============ */}
      <Card>
        <div className="be-sec-h">
          <h2>算力汇总</h2>
          <span>{c.enabled ? '按并行槽位聚合：算力与显存双约束取大，再按余量与冗余补卡' : '本池未启用，不计入规划总量'}</span>
          <span className="act">
            <Space>
              <span className="muted">
                {derivationReady
                  ? (derivationStale ? '输入已变更，展开内容仍来自最近保存的测算快照' : '从单任务训练量、并行槽位逐层展开到显存、余量与物理卡数')
                  : '完成一次正式测算后可展开计算过程'}
              </span>
              <Button icon={<ApartmentOutlined aria-hidden="true" />} disabled={!derivationReady}
                onClick={onDerivation}>查看计算过程</Button>
            </Space>
          </span>
        </div>
        {!c.enabled
          ? <Empty description="开启本池后自动汇总" />
          : pool && pool.completeness !== 'DISABLED' && (pool.items?.length ?? 0) > 0
            ? <>
                <div className="be-kpis">
                  <div className="be-kpi hl">
                    <div className="k">所需卡数</div>
                    <div className="v">{num(pool.cards_planned, 0)}<small>张</small></div>
                    <div className="sub">
                      物理 {num(pool.cards, 0)} 张 · 含余量约 {num(pool.servers_planned, 0)} 台服务器（8 卡/台）
                    </div>
                  </div>
                  <div className="be-kpi">
                    <div className="k">需求算力（BF16 等效）</div>
                    <div className="v">{capacity(pool.planned_p)}</div>
                    <div className="sub">
                      基础 {capacity(pool.base_p)} · {extraModels > 0 ? `最大单任务 × ${num(slots, 0)} 槽位` : `单任务 × ${num(slots, 0)} 槽位`} · 已含 {headroomPct}% 余量
                    </div>
                  </div>
                  <div className="be-kpi">
                    <div className="k">并行微调槽位</div>
                    <div className="v">{num(slots, 0)}<small>个</small></div>
                    <div className="sub">
                      强度档「{INTENSITIES.find(x => x[0] === c.intensity)?.[1] || c.intensity}」·
                      {extraModels > 0 ? '最大单任务容量' : '单任务容量'} {maxItemBaseP == null ? '待补充' : capacity(maxItemBaseP)}
                    </div>
                  </div>
                  <div className="be-kpi">
                    <div className="k">显存需求</div>
                    <div className="v">{num(pool.memory?.memory_gb)}<small>GB</small></div>
                    <div className="sub">
                      {MEMORY_LABELS[pool.memory?.status] || '待核验'} · 槽位合计（{extraModels > 0 ? '最大单任务' : '单任务'}显存 × {num(slots, 0)}）
                    </div>
                  </div>
                </div>

                <div className="be-sec-h" style={{ margin: '18px 0 10px' }}>
                  <h2 style={{ fontSize: 14 }}>微调任务明细</h2>
                  <span>{extraModels > 0 ? `多候选：最大单任务容量 × 槽位即本池需求算力` : '单模型：单任务容量 × 槽位即本池需求算力'}</span>
                </div>
                <Table<Obj> rowKey="id" size="small" pagination={false}
                  dataSource={pool.items ?? []} scroll={{ x: 820 }} columns={[
                    { title: '模型', dataIndex: 'model_id', render: (v: string) => matchModel(models, v)?.label || v },
                    {
                      // 按行取方法：多候选时各条的 method 可以不同，用页面级的 `method`（第一条）会串行。
                      // 旧方案迁移后 model_id 可能是别名，匹配不到时退回 item 名字里的「· LORA / · QLORA」后缀。
                      title: '微调方法', width: 110,
                      render: (_: unknown, r: Obj) => {
                        const key = entries.find((m: Obj) => m.model_id === r.model_id)?.method
                          ?? String(r.name || '').split(' · ').pop()?.toLowerCase();
                        return METHOD_LABELS[key as string] || key || '—';
                      },
                    },
                    {
                      title: '单任务训练量', width: 140,
                      render: (_: unknown, r: Obj) => {
                        const ft = r.trace?.variables?.flop_total;
                        return ft == null ? '—' : num(Number(ft) / 1e15) + ' PFLOP';
                      },
                    },
                    { title: '单任务算力（BF16）', dataIndex: 'base_p', width: 160, render: capacity },
                    {
                      title: '单任务显存', width: 130,
                      render: (_: unknown, r: Obj) => {
                        const mem = r.memory || {};
                        if (mem.memory_gb == null) return '待核验';
                        const v = r.trace?.variables || {};
                        const breakdown = [['基座权重', v.base_weight_gb], ['adapter', v.adapter_state_gb], ['激活', v.activation_gb], ['工作区', v.workspace_gb]]
                          .filter(([, x]) => x != null)
                          .map(([k, x]) => `${k} ${num(x)} GB`).join(' + ');
                        return <Tooltip title={breakdown || '显存构成待补充'}>
                          <span>{num(mem.memory_gb)} GB</span>
                        </Tooltip>;
                      },
                    },
                    { title: '并行槽位', width: 100, render: () => num(slots, 0) + ' 个' },
                  ]} />

                <div className="be-sec-h" style={{ margin: '18px 0 10px' }}>
                  <h2 style={{ fontSize: 14 }}>卡数折算</h2>
                  <span>{detail.rule || '算力约束与显存约束取大'}</span>
                </div>
                <Descriptions size="small" column={{ xs: 1, sm: 1, md: 2, lg: 3 }} items={[
                  { key: 'chip', label: '算力卡', children: detail.chip_label || chip.label || '未选择' },
                  { key: 'compute', label: '算力约束卡数', children: detail.compute_cards == null ? '—' : num(detail.compute_cards, 0) + ' 张' },
                  { key: 'memory', label: '显存约束卡数', children: detail.memory_cards == null ? '—' : num(detail.memory_cards, 0) + ' 张' },
                  { key: 'bottleneck', label: '主导约束', children: detail.bottleneck || '—' },
                  { key: 'coef', label: '训练系数', children: `k ${num(coef('train_k'))} · ηtrain ${num(coef('train_eta'))}` },
                  { key: 'headroom', label: '余量与冗余', children: `+${num(Number(detail.headroom ?? payload.headroom ?? 0) * 100, 0)}% 余量 · +${num(detail.redundancy_cards ?? 1, 0)} 张冗余` },
                  { key: 'servers', label: '服务器台数', children: `${num(pool.servers, 0)} 台物理 · ${num(pool.servers_planned, 0)} 台含余量` },
                ]} />
                {memoryParts.some(([, v]) => v != null) && (
                  <div className="note-line" style={{ marginTop: 12, marginBottom: 0 }}>
                    <InfoCircleOutlined aria-hidden="true" />
                    {extraModels > 0 ? '最大单任务显存构成' : '单任务显存构成'}：{memoryParts.filter(([, v]) => v != null).map(([k, v]) => `${k} ${num(v)} GB`).join(' + ')}
                    {pool.memory?.train_slot_gb != null ? `；槽位合计 ${num(pool.memory.train_slot_gb)} GB` : ''}。
                  </div>
                )}
              </>
            : <Empty description={entry ? '选择强度与任务参数后自动汇总' : '本方案没有候选模型记录，请先选择模型'} />}
        {/* 缺失原因放在分支外：还没算出结果时（BLOCKED）也要说清楚缺什么。 */}
        {c.enabled && (pool?.missing_items?.length ?? 0) > 0 && (
          <Alert className="below" type="warning" showIcon
            message="本池存在未计入的项"
            description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {pool!.missing_items.map((m: Obj) => <li key={m.id}>{m.name || m.id}：{m.message}</li>)}
            </ul>} />
        )}
        <div className="note-line" style={{ marginTop: 12, marginBottom: 0 }}>
          <InfoCircleOutlined aria-hidden="true" />
          本池只覆盖模型微调，不含效果评测与数据标注；「槽位」是同时能跑几个微调任务，不是卡数。
          切换强度档会把下方五项任务参数一起回落到该档默认值，手改过的值需要重新填写。
        </div>
      </Card>
    </div>
  );
}
