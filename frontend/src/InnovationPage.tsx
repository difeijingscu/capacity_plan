import {
  Alert, Button, Card, Collapse, Descriptions, Empty, InputNumber, Select,
  Space, Switch, Table, Tag, Tooltip, App as AntApp,
} from 'antd';
import { ApartmentOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { capacity, num } from './api';
import type { Obj } from './api';
import { chipSelectOptions, chipSpecHint, matchModel, modelSelectOptions } from './chips';
import './business-eval.css';

/**
 * 创新服务池：分区结构与业务场景页一致——全局配置 → 服务规模与模型设置 → 算力汇总。
 *
 * 与业务池的差别只在业务形态：本池是「一份月度 Token 额度 + 一个模型」。
 * 界面只编辑一个模型，但引擎侧的 `innovation.allocations` 是列表、会遍历全部条目出卡：
 * - 新建方案由后端缺省带一条 `share=1` 的分配；
 * - 页面的每次编辑（换模型、改请求 Token）都只**原地更新第一条**，不删除、不重排、不强制改份额；
 * - 旧方案若存在多条分配或份额合计 ≠ 100%，界面显式说明「汇总是 N 个模型的合计」并给出
 *   收敛为单模型 / 按比例归一两个显式入口，绝不靠一次普通编辑静默删掉历史分配。
 */

/** 效率系数默认值，与 schemas.Innovation 的缺省一致。 */
const ETA_DEFAULTS = { eta_prefill: 0.35, eta_decode: 0.15 };
/**
 * 前缀缓存命中率的新建方案默认值，与 schemas.Innovation 的缺省一致。
 * 业界经验：多轮对话、共享系统提示与 RAG 服务的前缀命中率常见 20%–50%，取 30% 作保守默认。
 * 注意它只用于文案与「新建方案」的说明；payload 缺这个键时不能回落到 30%——
 * 后端把「键不存在」判定为 0（engine-v2.1.0 之前没有缓存折算），页面若显示 30%
 * 就又变成「页面一个数、引擎另一个数」。
 */
const CACHE_HIT_DEFAULT = 0.3;
/** 单请求 Token 结构默认值，与 schemas.Allocation 的缺省一致。 */
const REQUEST_DEFAULTS = { request_total_tokens: 2560, input_fraction: 0.8 };
/**
 * 默认服务模型，须与后端 `schemas.DEFAULT_MODEL` 同值（前端不引用后端符号，只能靠约定，改一处要同步改另一处）。
 * 新建方案由后端缺省直接带一条 share=1 的分配；旧方案或外部导入的 payload 若 allocations 为空，
 * 页面按这个默认值展示，并在用户开启本池或改动请求口径时补写，避免「页面有模型、引擎不出数」。
 */
const DEFAULT_MODEL = 'deepseek_v4_flash';
const MEMORY_LABELS: Obj = {
  COMPLETE: '完整估算', PROXY: '经验代理', WEIGHT_LOWER_BOUND: '仅显存下界', UNKNOWN: '待核验',
};

export default function InnovationPage({ payload, edit, catalog, catalogLoading, preview, derivationReady, derivationStale, onDerivation }: {
  payload: Obj;
  edit: (mutator: (plan: Obj) => void) => void;
  catalog: Obj | null;
  catalogLoading?: boolean;
  preview: Obj | null;
  /** 是否存在已保存的测算快照；没有快照时推导抽屉打不开，按钮置灰而不是静默无响应。 */
  derivationReady?: boolean;
  derivationStale?: boolean;
  onDerivation?: () => void;
}) {
  const { message } = AntApp.useApp();
  const c: Obj = payload.innovation;
  const models: Obj[] = [...(catalog?.models ?? []), ...(catalog?.custom_models ?? [])];
  const chips: Obj[] = [...(catalog?.chips ?? []), ...(catalog?.custom_chips ?? [])];

  const allocations: Obj[] = c.allocations ?? [];
  /** 本页只呈现一个模型：取第一条分配作为「当前模型」。 */
  const alloc: Obj | undefined = allocations[0];
  const modelKey: string | undefined = alloc?.model_id ?? DEFAULT_MODEL;
  /**
   * 旧方案的 `model_id` 可能是别名（`qwen3.6-35b-a3b` 对目录 key `qwen3_6_35b_a3b`），
   * 匹配规则与业务场景页共用 `chips.ts` 的 `matchModel`：只做展示层归一，不写回 payload，
   * 避免把「显示修正」当成口径变更。
   */
  const share = Number(alloc?.share ?? 1);
  /** 份额合计：引擎要求各模型合计恰好 100%，不满足时 PlanInput 校验直接拒绝，页面拿不到预览。 */
  const totalShare = allocations.reduce((sum: number, a: Obj) => sum + Number(a.share || 0), 0);
  const sharesValid = allocations.length === 0 || Math.abs(totalShare - 1) < 1e-6;
  const extraAllocations = Math.max(0, allocations.length - 1);
  /** 多分配：引擎遍历全部条目出卡，而页面只编辑第一条，必须在界面上说清两者关系。 */
  const multi = extraAllocations > 0;
  const model: Obj = matchModel(models, modelKey) || {};
  const chip = chips.find((x: Obj) => x.key === c.chip_key) || {};

  const pool: Obj | undefined = preview?.pools?.find((p: Obj) => p.id === 'innovation');
  const detail: Obj = pool?.cards_detail || {};
  const item: Obj | undefined = pool?.items?.[0];
  const monthlyTotal = pool?.monthly_tokens == null ? null : Number(pool.monthly_tokens);
  const monthlyModel = item?.monthly_tokens == null
    ? (monthlyTotal == null ? null : monthlyTotal * share)
    : Number(item.monthly_tokens);
  const requestRate = item?.trace?.variables?.request_rate;
  const headroomPct = num(Number(payload.headroom ?? 0) * 100, 0);
  // 缺键按 0：与后端 PlanInput._legacy_cache_hit 的判据一致（v2.1.0 之前的方案没有缓存
  // 折算）。回落到 30% 会让页面显示与引擎出数分裂——预览按 0 算、页面说 30%。
  const cacheHit = Number(c.cache_hit_rate ?? 0);

  function change(key: string, value: unknown) { edit(p => { p.innovation[key] = value; }); }

  /** 页面显示的默认记录（尚未写入 payload 时的补写内容）。 */
  function defaultAllocation(key = DEFAULT_MODEL): Obj {
    return {
      model_id: key,
      share: 1,
      input_fraction: REQUEST_DEFAULTS.input_fraction,
      request_total_tokens: REQUEST_DEFAULTS.request_total_tokens,
    };
  }

  /** 开启本池时，若旧方案没有模型分配，把页面显示的默认模型一并写入。 */
  function setEnabled(next: boolean) {
    edit(p => {
      p.innovation.enabled = next;
      if (next && !(p.innovation.allocations || []).length) p.innovation.allocations = [defaultAllocation()];
    });
  }

  /**
   * 选模型：只替换第一条的 `model_id`，其余分配原样保留。
   *
   * 旧实现整表重写成 `[{新模型, share: 1}]`，会把其它模型的分配连同各自额度一起静默删掉——
   * 引擎本来按全部条目出卡，用户只改了一次模型却让卡数跳变，且页面上看不出发生了什么。
   * 新模型若已被其它条目占用，直接拒绝：写入会让 `PlanInput` 的「模型不可重复」校验失败。
   */
  function setModel(nextKey: string) {
    if (allocations.slice(1).some((a: Obj) => a.model_id === nextKey)) {
      message.warning('该模型已存在于其它分配中，请先收敛为单模型再修改');
      return;
    }
    edit(p => {
      const list = p.innovation.allocations || [];
      p.innovation.allocations = list.length
        ? list.map((a: Obj, i: number) => (i === 0 ? { ...a, model_id: nextKey } : a))
        : [defaultAllocation(nextKey)];
    });
  }

  /** 把旧方案的多条分配收敛成单模型：保留第一条并占满全部额度。显式动作，由用户点击触发。 */
  function normalizeAllocation() {
    edit(p => {
      const first = (p.innovation.allocations || [])[0];
      if (!first) return;
      p.innovation.allocations = [{ ...first, share: 1 }];
    });
    message.success('已收敛为单模型，全部额度计入该模型');
  }

  /**
   * 按比例把份额归一到 100%：保留全部模型，只缩放份额。
   *
   * 份额合计不等于 1 时 `PlanInput` 校验会拒绝整个 payload，预览与测算都返回 422，
   * 汇总区只能显示空态——这不是「按份额折算」，而是根本没有结果。归一后才能恢复计算。
   */
  function rebalanceAllocations() {
    if (totalShare <= 0) { message.warning('份额合计为 0，请先为每个模型填写份额'); return; }
    edit(p => {
      p.innovation.allocations = (p.innovation.allocations || []).map((a: Obj) => ({
        ...a, share: Number((Number(a.share || 0) / totalShare).toFixed(6)),
      }));
    });
    message.success('已按原比例把份额归一到 100%');
  }

  /**
   * 改请求口径：原地更新第一条，不重排、不强制 `share = 1`、不删其它条目。
   *
   * 旧实现把整张表替换成一条 share=1，等于用「改 Token 数」顺手删掉了别的模型与它们的份额，
   * 卡数会跟着跳变（实测两模型方案改 Token 后 42 → 48 张），用户无法归因。
   */
  function setRequest(field: string, value: unknown) {
    const fallback = REQUEST_DEFAULTS[field as keyof typeof REQUEST_DEFAULTS] ?? 0;
    edit(p => {
      // 没有分配时（旧方案/导入 payload）以默认模型起步，而不是让请求口径改不动。
      const list = p.innovation.allocations || [];
      const head = { ...(list[0] ?? defaultAllocation()), [field]: value ?? fallback };
      p.innovation.allocations = list.length ? [head, ...list.slice(1)] : [head];
    });
  }

  const allocated = c.users == null || c.quota_per_user_month == null
    ? null
    : Number(c.users) * Number(c.quota_per_user_month);

  return (
    <div className="main-panel business-eval">
      {/* ============ ① 全局配置 ============ */}
      <Card className="be-global">
        <div className="be-sec-h">
          <h2>全局配置</h2>
          <span>算力卡与缓存命中率对本池统一生效；效率系数收在下方「当前生效的工程系数」，改动立即重算</span>
          <span className="act">
            <Space>
              <span className="muted">本池计入规划</span>
              <Switch aria-label="创新服务启用" checked={c.enabled} checkedChildren="已启用" unCheckedChildren="未启用"
                onChange={v => setEnabled(v)} />
            </Space>
          </span>
        </div>
        <div className="be-global-grid is-2">
          <div className="field">
            <label>算力卡（本池）
              <Tooltip title="与业务场景共用同一套算力卡规格（含自定义卡），三池卡数才可比；换卡后本池卡数按新规格重算。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            <Select aria-label="创新池算力卡" style={{ width: '100%' }} value={c.chip_key || undefined}
              placeholder="未选择则本池不出卡数" allowClear showSearch optionFilterProp="label"
              options={chipSelectOptions(chips)} onChange={v => change('chip_key', v ?? null)} />
            <div className="be-chip-hint">{chipSpecHint(chip)}</div>
          </div>
          <div className="field">
            <label>缓存命中率
              <Tooltip title="前缀缓存（Prefix Caching）命中率：命中前缀的输入 Token 直接复用已有 KV cache，不再重复做 Prefill。多轮对话、共享系统提示与 RAG 服务常见 20%–50%，取 30% 作保守默认；无缓存或纯冷启动填 0。命中只省 Prefill 算力，Decode 与 KV 显存仍按全量上下文计算。engine-v2.1.0 之前的方案没有这一项，重算按 0 处理，与历史快照口径一致。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            <InputNumber aria-label="缓存命中率" style={{ width: '100%' }} min={0} max={100} step={5}
              value={Number((cacheHit * 100).toFixed(2))} addonAfter="%"
              onChange={v => change('cache_hit_rate', Number(v ?? 0) / 100)} />
            <div className="be-chip-hint">
              {cacheHit === 0
                // 0 有两种来源：用户本意（无缓存/纯冷启动），或 v2.1.0 之前的老方案
                // 没有这个字段、由后端补成 0 以保持与历史快照一致。两种情况都给同一句解释。
                ? `0% 表示不做前缀缓存折算。v2.1.0 之前的方案没有这一项，重算按 0 与历史快照一致；新建方案默认 ${CACHE_HIT_DEFAULT * 100}%`
                : `默认 ${CACHE_HIT_DEFAULT * 100}% · 只折算 Prefill，Decode 与显存按全量上下文`}
            </div>
          </div>
        </div>
        {/* 工程系数：与业务页同一交互层级——默认收起，避免首屏被经验系数占满 */}
        <details className="be-fold be-fold-sub">
          <summary>
            <span className="be-fold-t">当前生效的工程系数（可调）</span>
            <span className="be-fold-hint">
              ηprefill {num(Number(c.eta_prefill ?? ETA_DEFAULTS.eta_prefill))} · ηdecode {num(Number(c.eta_decode ?? ETA_DEFAULTS.eta_decode))}
              · 方案余量 +{headroomPct}% · 故障冗余 +1 张
            </span>
            <span className="be-fold-btn" aria-hidden="true"><i /></span>
          </summary>
          <div className="be-fold-body">
            <div className="form-grid">
              <div className="field">
                <label>Prefill 效率 ηprefill
                  <Tooltip title="Prefill 阶段实际算力占芯片峰值算力的比例；越高越省卡。默认 0.35，档位需压测支撑。">
                    <InfoCircleOutlined aria-hidden="true" />
                  </Tooltip>
                </label>
                <InputNumber aria-label="Prefill 效率" style={{ width: '100%' }} min={0.01} max={1} step={0.05}
                  value={Number(c.eta_prefill ?? ETA_DEFAULTS.eta_prefill)}
                  onChange={v => change('eta_prefill', v ?? ETA_DEFAULTS.eta_prefill)} />
                <div className="be-chip-hint">默认 {ETA_DEFAULTS.eta_prefill} · 经验效率，需实测校准</div>
              </div>
              <div className="field">
                <label>Decode 效率 ηdecode
                  <Tooltip title="Decode 阶段受显存带宽限制，实际算力占比通常低于 Prefill；越高越省卡。默认 0.15。">
                    <InfoCircleOutlined aria-hidden="true" />
                  </Tooltip>
                </label>
                <InputNumber aria-label="Decode 效率" style={{ width: '100%' }} min={0.01} max={1} step={0.05}
                  value={Number(c.eta_decode ?? ETA_DEFAULTS.eta_decode)}
                  onChange={v => change('eta_decode', v ?? ETA_DEFAULTS.eta_decode)} />
                <div className="be-chip-hint">默认 {ETA_DEFAULTS.eta_decode} · 经验效率，需实测校准</div>
              </div>
              <div className="field">
                <label>余量与故障冗余（方案级，只读）</label>
                <div className="be-chip-hint" style={{ marginTop: 0, fontSize: 12 }}>
                  +{headroomPct}% 方案余量 · +1 张故障冗余
                  <br />余量比例在方案设置中调整，对本池与业务池同时生效。
                </div>
              </div>
            </div>
            <div className="note-line" style={{ marginBottom: 0 }}>
              <InfoCircleOutlined aria-hidden="true" />
              效率系数与缓存命中率都是工程假设，不是厂商保证值；上表数值即本次出卡实际采用值，改动后本池立即重算。
            </div>
          </div>
        </details>
      </Card>

      {/* ============ ② 服务规模与模型设置 ============ */}
      <Card>
        <div className="be-sec-h">
          <h2>服务规模与模型设置</h2>
          <span>一份月度额度、一个模型：额度按请求 Token 结构折算成峰值请求速率</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>支持人数</label>
            <InputNumber aria-label="创新支持人数" style={{ width: '100%' }} min={0}
              value={c.users == null ? null : Number(c.users)}
              onChange={v => change('users', v ?? null)} addonAfter="人" />
          </div>
          <div className="field">
            <label>每人每月总 Token
              <Tooltip title="包含输入与生成 Token；推理 Token 已计入时不再额外相乘。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            <InputNumber aria-label="每人月Token" style={{ width: '100%' }} min={0}
              value={c.quota_per_user_month == null ? null : Number(c.quota_per_user_month)}
              onChange={v => change('quota_per_user_month', v ?? null)} />
          </div>
          <div className="quota-summary">
            <span>月度额度上限</span>
            <strong>{num(allocated)}</strong>
            <small>Token / 月 · 未乘使用率</small>
          </div>
        </div>

        <div className="section-title" style={{ marginTop: 18 }}>
          <h3>模型设置 <Tag color="green">单模型</Tag></h3>
          <span className="muted">创新池按一个模型规划，不做多模型额度拆分</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>服务模型</label>
            {/* 不用 Spin 包裹：Spin 的 wrapper 是 inline-block，会把 width:100% 的 Select 挤成内容宽度。 */}
            <Select aria-label="创新服务模型" style={{ width: '100%' }} value={model.key || modelKey} loading={!!catalogLoading}
              placeholder="选择提供创新服务的模型" showSearch optionFilterProp="label"
              options={modelSelectOptions(models)}
              onChange={setModel} />
            <small className="muted">
              {model.total_b
                ? `总参 ${num(model.total_b)}B · 激活 ${num(model.active_b)}B · ${model.arch}${alloc ? '' : ' · 默认模型，改动任一设置后写入方案'}`
                : '未选择模型；选择后按该模型的结构与上下文上限校验请求'}
            </small>
          </div>
          <div className="field">
            <label>每请求 Token 总量
              <Tooltip title="一次请求的输入 + 生成 Token 合计，用于把月度额度折算成请求数与峰值速率。">
                <InfoCircleOutlined aria-hidden="true" />
              </Tooltip>
            </label>
            <InputNumber aria-label="每请求Token" style={{ width: '100%' }} min={1} step={128}
              value={alloc?.request_total_tokens == null ? null : Number(alloc.request_total_tokens)}
              placeholder={String(REQUEST_DEFAULTS.request_total_tokens)}
              onChange={v => setRequest('request_total_tokens', v)} addonAfter="tok" />
            <small className="muted">留空取默认 {REQUEST_DEFAULTS.request_total_tokens} tok</small>
          </div>
          <div className="field">
            <label>输入 Token 占比</label>
            <InputNumber aria-label="输入Token占比" style={{ width: '100%' }} min={0} max={100}
              value={alloc?.input_fraction == null ? null : Number(alloc.input_fraction) * 100}
              placeholder={String(REQUEST_DEFAULTS.input_fraction * 100)}
              onChange={v => setRequest('input_fraction', v == null ? null : Number(v) / 100)} addonAfter="%" />
            <small className="muted">其余为生成 Token</small>
          </div>
        </div>

        {/* 多分配：引擎遍历全部条目出卡，页面只编辑第一条——两条事实都要写出来，不能只说一半。 */}
        {multi && (
          <Alert className="below" type="warning" showIcon
            message={`本方案有 ${allocations.length} 个模型分配，下方汇总是这 ${allocations.length} 个模型的合计`}
            description={<Space wrap>
              <span>
                本页只编辑排在第一位的「{models.find((m: Obj) => m.key === modelKey)?.label || modelKey}」，
                其份额 {num(share * 100)}%；另外 {extraAllocations} 个模型仍按各自份额参与引擎出卡，
                因此卡数与算力包含全部 {allocations.length} 个模型。改动模型或请求 Token 只会作用于第一位，不会删除其余分配。
              </span>
              <Button size="small" onClick={normalizeAllocation}>收敛为单模型</Button>
            </Space>} />
        )}
        {/*
          份额合计 ≠ 100% 不是「按份额折算」而是方案校验不通过：PlanInput 的 coherent 校验会拒绝
          这种 payload，/preview-calculation 与 /calculate 都返回 422，汇总区只能显示空态。
          旧文案写「下方汇总按该份额折算」，与实际行为相反，这里改为说明真实原因并给出归一入口。
        */}
        {allocations.length > 0 && !sharesValid && (
          <Alert className="below" type="error" showIcon
            message={`各模型份额合计为 ${num(totalShare * 100)}%，方案校验不通过，没有出卡结果`}
            description={<Space wrap>
              <span>
                引擎要求份额合计恰好 100%。当前合计不等于 100%，方案校验直接拒绝，所以下方汇总为空——
                这不是「按份额折算后的结果」。可一键按原比例归一，或收敛为单模型。
              </span>
              <Button size="small" onClick={rebalanceAllocations}>按比例归一为 100%</Button>
              <Button size="small" onClick={normalizeAllocation}>收敛为单模型</Button>
            </Space>} />
        )}

        <Collapse className="below" items={[{
          key: 'service', label: '服务时间与峰值参数（默认值可修改）',
          children: <div className="form-grid">
            {([['service_days', '每月服务日数'], ['service_hours_per_day', '每日服务小时'], ['peak_factor', '峰值倍数']] as [string, string][])
              .map(([key, label]) => <div className="field" key={key}>
                <label>{label}</label>
                <InputNumber aria-label={label} style={{ width: '100%' }} min={key === 'peak_factor' ? 0.01 : 1}
                  step={key === 'peak_factor' ? 0.5 : 1} value={Number(c[key])}
                  onChange={v => change(key, v)} />
              </div>)}
            <div className="field">
              <label>额度使用率</label>
              <InputNumber aria-label="额度使用率" style={{ width: '100%' }} min={0} max={100}
                value={Number(c.usage_ratio) * 100} addonAfter="%"
                onChange={v => change('usage_ratio', Number(v) / 100)} />
            </div>
          </div>,
        }]} />
        <div className="note-line" style={{ marginTop: 12 }}>
          <InfoCircleOutlined aria-hidden="true" />
          默认 22 日 × 每天 8 小时、峰值 3 倍、额度全部兑现；这些参数属于经验假设，按期末规模计算。
          请求速率 = 月度额度 × 使用率 ÷ 服务时长 × 峰值倍数 ÷ 每请求 Token。
        </div>
      </Card>

      {/* ============ ③ 算力汇总 ============ */}
      <Card>
        <div className="be-sec-h">
          <h2>算力汇总</h2>
          <span>{!c.enabled ? '本池未启用，不计入规划总量'
            : multi ? `${allocations.length} 个模型分别出卡后汇总：需求算力与显存约束取大，再按余量与冗余补卡`
              : '单模型独立出卡：需求算力与显存约束取大，再按余量与冗余补卡'}</span>
          <span className="act">
            <Space>
              <span className="muted">
                {derivationReady
                  ? (derivationStale ? '输入已变更，展开内容仍来自最近保存的测算快照' : '从月度额度、模型吞吐逐层展开到显存、余量与物理卡数')
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
                      {multi ? `${allocations.length} 个模型合计 · ` : ''}
                      物理 {num(pool.cards, 0)} 张 · 含余量约 {num(pool.servers_planned, 0)} 台服务器（8 卡/台）
                    </div>
                  </div>
                  <div className="be-kpi">
                    <div className="k">需求算力（BF16 等效）</div>
                    <div className="v">{capacity(pool.planned_p)}</div>
                    <div className="sub">
                      {multi ? `${allocations.length} 个模型合计 · ` : ''}
                      基础 {capacity(pool.base_p)} · 已含 {headroomPct}% 余量
                    </div>
                  </div>
                  <div className="be-kpi">
                    {/* 多分配时第一位只是其中一份额度，标题继续写「本模型」会让人以为下面卡数也按这个模型算。 */}
                    <div className="k">{multi ? '全池月度 Token' : '本模型月度 Token'}</div>
                    <div className="v">{num(multi ? monthlyTotal : monthlyModel, 0)}</div>
                    <div className="sub">
                      {multi
                        ? `${allocations.length} 个模型合计 · 第一位「${models.find((m: Obj) => m.key === modelKey)?.label || modelKey}」占 ${num(share * 100)}%`
                        : `全池 ${num(monthlyTotal, 0)} · 份额 ${num(share * 100)}%`}
                      {requestRate != null ? ` · 首个模型峰值 ${num(requestRate)} 请求/秒` : ''}
                    </div>
                  </div>
                  <div className="be-kpi">
                    <div className="k">显存需求</div>
                    <div className="v">{num(pool.memory?.memory_gb)}<small>GB</small></div>
                    <div className="sub">
                      {MEMORY_LABELS[pool.memory?.status] || '待核验'} · 权重 + KV cache + runtime
                      {multi ? ` · ${allocations.length} 个模型合计` : ''}
                    </div>
                  </div>
                </div>

                <div className="be-sec-h" style={{ margin: '18px 0 10px' }}>
                  <h2 style={{ fontSize: 14 }}>模型明细</h2>
                  <span>单模型：卡数与算力即本池合计</span>
                </div>
                <Table<Obj> rowKey="id" size="small" pagination={false}
                  dataSource={pool.items ?? []} scroll={{ x: 760 }} columns={[
                    {
                      title: '模型', dataIndex: 'model_id',
                      render: (v: string) => matchModel(models, v)?.label || v,
                    },
                    {
                      title: '请求速率', width: 140,
                      render: (_: unknown, r: Obj) => {
                        const rate = r.trace?.variables?.request_rate;
                        return rate == null ? '—' : num(rate) + ' 请求/秒';
                      },
                    },
                    { title: '需求算力（BF16）', dataIndex: 'base_p', width: 160, render: capacity },
                    {
                      // 逐项结果只给分项（weight / cache / runtime），memory_gb 是池级汇总字段。
                      title: '显存需求', width: 130,
                      render: (_: unknown, r: Obj) => {
                        const mem = r.memory || {};
                        if (mem.weight_gb == null) return '待核验';
                        return num(Number(mem.weight_gb) + Number(mem.cache_gb || 0) + Number(mem.runtime_gb || 0)) + ' GB';
                      },
                    },
                    { title: '物理卡数', width: 100, render: () => num(pool.cards, 0) + ' 张' },
                    {
                      title: '含余量卡数', width: 110,
                      render: () => <strong>{num(pool.cards_planned, 0)} 张</strong>,
                    },
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
                  { key: 'cache', label: '缓存命中率', children: `${num(cacheHit * 100)}% · 只折算 Prefill 输入` },
                  { key: 'headroom', label: '余量与冗余', children: `+${num(Number(detail.headroom ?? payload.headroom ?? 0) * 100, 0)}% 余量 · +${num(detail.redundancy_cards ?? 1, 0)} 张冗余` },
                  { key: 'servers', label: '服务器台数', children: `${num(pool.servers, 0)} 台物理 · ${num(pool.servers_planned, 0)} 台含余量` },
                ]} />
              </>
            : <Empty description={
              !alloc ? '选择模型后自动汇总'
                : !sharesValid ? '各模型份额合计须为 100%，归一后自动汇总'
                  : '填写人数与月额度后自动汇总'
            } />}
        {/* 缺失原因放在分支外：还没算出结果时（BLOCKED）也要说清楚缺什么，而不是只给一个空态。 */}
        {c.enabled && (pool?.missing_items?.length ?? 0) > 0 && (
          <Alert className="below" type="warning" showIcon
            message="本池存在未计入的项"
            description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {pool!.missing_items.map((m: Obj) => <li key={m.id}>{m.name || m.id}：{m.message}</li>)}
            </ul>} />
        )}
      </Card>
    </div>
  );
}
