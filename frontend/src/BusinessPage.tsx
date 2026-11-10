import { useState } from 'react';
import {
  Alert, Button, Card, Checkbox, Collapse, Drawer, Empty, Input, InputNumber, Popconfirm,
  Select, Space, Spin, Table, Tag, Tooltip, App as AntApp,
} from 'antd';
import {
  CloudUploadOutlined, DeleteOutlined, InfoCircleOutlined, PlusOutlined, ThunderboltFilled,
} from '@ant-design/icons';
import { capacity, num } from './api';
import type { Obj } from './api';
import CustomModelModal from './CustomModelModal';

/** 场景未配置推理时的兜底口径：与后端 business.DEFAULT_SPEC 保持一致（模型必须显式选）。 */
const DEFAULT_INFERENCE: Obj = {
  chip_key: '910c', scene_key: 'kb_qa',
  weight_precision: 'auto', kv_precision: 'auto', profile: 'neutral', prefix_hit: 0,
};
const PRECISIONS = [
  { value: 'auto', label: '自动推荐' },
  { value: 'bf16', label: 'BF16' },
  { value: 'fp8', label: 'FP8' },
  { value: 'int8', label: 'INT8' },
  { value: 'int4', label: 'INT4' },
];
const KV_PRECISIONS = [
  { value: 'auto', label: 'KV 自动' },
  { value: 'bf16', label: 'KV BF16' },
  { value: 'fp8', label: 'KV FP8' },
  { value: 'int8', label: 'KV INT8' },
];

/** 场景档位里可以一键带入的规模参数。 */
const SCENE_FIELDS: [string, string, string][] = [
  ['concurrency', '并发会话', '路'],
  ['prompt_len', '输入长度', 'tok'],
  ['output_len', '输出长度', 'tok'],
  ['max_ctx', '最大上下文', 'tok'],
  ['ttft_target_ms', '首 Token 目标', 'ms'],
  ['tpot_target_ms', '逐 Token 目标', 'ms'],
];

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
  const { message } = AntApp.useApp();
  const [openId, setOpenId] = useState<string | null>(null);
  const [modelModal, setModelModal] = useState(false);
  const [selected, setSelected] = useState<React.Key[]>([]);

  const models: Obj[] = [...(catalog?.models ?? []), ...(catalog?.custom_models ?? [])];
  const chips: Obj[] = catalog?.chips ?? [];
  const scenes: Obj[] = catalog?.scenes ?? [];
  const scenario = payload.scenarios.find((s: Obj) => s.id === openId);
  const pool = preview?.pools?.[0];

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
   */
  function specOf(s: Obj): Obj {
    if (s.inference) return { ...DEFAULT_INFERENCE, ...s.inference };
    const task: Obj = (s.components || [])[0] || {};
    const spec: Obj = { ...DEFAULT_INFERENCE };
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
  function applySceneDefaults(ids: React.Key[]) {
    if (!ids.length) { message.info('先勾选要补全的场景'); return; }
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
          if (current[field] == null && preset[field] != null) { current[field] = preset[field]; touched = true; }
        }
        if (touched) done += 1;
      }
    });
    if (done) message.success(`已按场景档补全 ${done} 个场景的空字段`);
    else if (!blocked) message.info('所选场景的规模参数都已填写，没有需要补的');
    if (blocked) message.warning(`${blocked} 个场景还没有选模型，未能补全`);
  }

  function addScenario() {
    const id = crypto.randomUUID().replaceAll('-', '');
    const preset = sceneOf(DEFAULT_INFERENCE);
    const first = models.find(m => m.key === 'qwen3_8b') || models[0];
    edit(plan => plan.scenarios.push({
      id, name: '新业务场景', description: '', enabled: true, source_reference: {},
      components: [],
      inference: {
        ...DEFAULT_INFERENCE,
        model_key: first?.key,
        concurrency: preset.concurrency ?? null,
      },
    }));
    setOpenId(id);
  }

  const columns: Obj[] = [
    {
      title: '业务场景', width: 175, fixed: 'left',
      render: (_: unknown, s: Obj) => <div>
        <Input aria-label={'场景名称-' + s.id} variant="borderless" value={s.name}
          onChange={e => edit(p => { p.scenarios.find((x: Obj) => x.id === s.id).name = e.target.value; })} />
        <small className="muted">{s.description || '点击配置补充场景描述'}</small>
      </div>,
    },
    {
      title: '场景类型', width: 144,
      render: (_: unknown, s: Obj) => {
        const spec = specOf(s);
        const off = legacyState(s) === 'unsupported';
        return <Select aria-label={'场景类型-' + s.name} style={{ width: '100%' }} value={off ? null : spec.scene_key}
          placeholder={off ? '不适用' : '待选择'} disabled={off}
          options={scenes.map(x => ({ value: x.key, label: x.name, title: x.hint }))}
          onChange={v => {
            const values: Obj = { scene_key: v };
            const preset = scenes.find(x => x.key === v) || {};
            for (const [field] of SCENE_FIELDS) values[field] = preset[field] ?? null;
            write(s, values);
          }} />;
      },
    },
    {
      title: '模型', width: 175,
      render: (_: unknown, s: Obj) => {
        const spec = specOf(s);
        const model = modelOf(spec);
        return <div>
          <Select aria-label={'模型-' + s.name} style={{ width: '100%' }} value={spec.model_key}
            placeholder="待选择" showSearch optionFilterProp="label"
            options={models.map(m => ({
              value: m.key,
              label: (m.label || m.key) + (m.custom ? ' · 自定义' : ''),
            }))}
            onChange={v => write(s, { model_key: v })} />
          <small className="muted">
            {model.total_b
              ? `总参 ${num(model.total_b)}B · 激活 ${num(model.active_b)}B · ${model.arch}`
              : legacyState(s) === 'unsupported'
                ? '视频/批量任务 · 业务池不覆盖，选择大模型可改为推理场景'
                : '未选择模型'}
          </small>
        </div>;
      },
    },
    {
      title: '推理精度', width: 134,
      render: (_: unknown, s: Obj) => {
        const spec = specOf(s);
        const off = legacyState(s) === 'unsupported';
        return <Space direction="vertical" size={2} style={{ width: '100%' }}>
          <Select aria-label={'权重精度-' + s.name} style={{ width: '100%' }} value={off ? null : spec.weight_precision}
            placeholder="不适用" disabled={off}
            options={PRECISIONS} onChange={v => write(s, { weight_precision: v })} />
          <Select aria-label={'KV精度-' + s.name} size="small" style={{ width: '100%' }} value={off ? null : spec.kv_precision}
            placeholder="不适用" disabled={off}
            options={KV_PRECISIONS} onChange={v => write(s, { kv_precision: v })} />
        </Space>;
      },
    },
    {
      title: '算力服务器', width: 136,
      render: (_: unknown, s: Obj) => {
        const spec = specOf(s);
        const chip = chipOf(spec);
        const off = legacyState(s) === 'unsupported';
        return <div>
          <Select aria-label={'算力服务器-' + s.name} style={{ width: '100%' }} value={off ? null : spec.chip_key}
            placeholder="不适用" disabled={off}
            showSearch optionFilterProp="label"
            options={chips.map(c => ({ value: c.key, label: c.label.split(' · ')[0], title: c.label }))}
            onChange={v => write(s, { chip_key: v })} />
          <small className="muted">{off ? '业务池不覆盖' : chip.bf16_tflops ? `BF16 ${chip.bf16_tflops}T · ${chip.memory_gb}GB` : '—'}</small>
        </div>;
      },
    },
    {
      title: '并发会话', width: 100,
      render: (_: unknown, s: Obj) => {
        const spec = specOf(s);
        const preset = sceneOf(spec);
        const off = legacyState(s) === 'unsupported';
        return <div>
          <InputNumber aria-label={'并发会话-' + s.name} min={1} style={{ width: '100%' }} disabled={off}
            value={spec.concurrency == null || off ? null : Number(spec.concurrency)}
            placeholder={off ? '不适用' : String(preset.concurrency ?? '待填写')}
            onChange={v => write(s, { concurrency: v ?? null })} />
          <small className="muted">{off ? '选定模型后可填' : '同时在线会话'}</small>
        </div>;
      },
    },
    {
      title: '需求算力', width: 100, fixed: 'right',
      render: (_: unknown, s: Obj) => {
        const row = rating(s.id);
        return row?.base_p == null
          ? <span className="muted">待补充</span>
          : <div><strong>{capacity(row.base_p)}</strong><small className="muted">BF16 等效</small></div>;
      },
    },
    {
      title: '所需卡数', width: 100, fixed: 'right',
      render: (_: unknown, s: Obj) => {
        const row = rating(s.id);
        if (row?.cards_planned == null) return <span className="muted">待补充</span>;
        return <div>
          <strong>{num(row.cards_planned, 0)} 张</strong>
          <small className="muted">物理 {num(row.cards, 0)} 张{row.sla_passed === false ? ' · 时延未达标' : ''}</small>
        </div>;
      },
    },
    {
      title: '状态', width: 92, fixed: 'right',
      render: (_: unknown, s: Obj) => {
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
          return <Tooltip title="该场景只有旧字段：按模型名去符号匹配 + 任务模板推导等价配置（匹配结果见「模型」列），并发取自在线人数。建议点「配置」改为显式选择。">
            <Tag color="orange">旧字段推导</Tag>
          </Tooltip>;
        }
        const row = rating(s.id);
        if (!row) return <Tag>待估算</Tag>;
        return row.completeness === 'COMPLETE'
          ? <Tag color="green">已估算</Tag>
          : <Tag color="orange">需复核</Tag>;
      },
    },
    {
      title: '', width: 66, fixed: 'right',
      render: (_: unknown, s: Obj) => <Space size={0}>
        <Button type="link" onClick={() => setOpenId(s.id)}>配置</Button>
        <Popconfirm title="移除此场景？保存后仍可撤销。" onConfirm={() => edit(p => { p.scenarios = p.scenarios.filter((x: Obj) => x.id !== s.id); })}>
          <Button type="text" aria-label={'移除-' + s.name} icon={<DeleteOutlined aria-hidden="true" />} />
        </Popconfirm>
      </Space>,
    },
  ];

  const spec = scenario ? specOf(scenario) : null;
  const preset = spec ? sceneOf(spec) : {};

  return <div className="main-panel">
    <Card
      title={<span>业务场景 <Tag>{payload.scenarios.length} 个</Tag></span>}
      extra={<Space>
        <Button icon={<PlusOutlined aria-hidden="true" />} onClick={() => setModelModal(true)}>登记自定义模型</Button>
        <Button icon={<CloudUploadOutlined aria-hidden="true" />} onClick={onImport}>导入清单</Button>
        <Button type="primary" icon={<PlusOutlined aria-hidden="true" />} onClick={addScenario}>添加场景</Button>
      </Space>}
    >
      <div className="note-line">
        <InfoCircleOutlined aria-hidden="true" />
        每个场景选择模型、推理精度、场景类型与算力服务器，并填写并发会话数；
        系统按「显存 → Prefill → Decode」三维取最大再用时延回验，给出所需算力与卡数。
      </div>
      {pool && <div className="batch-bar" style={{ borderTop: 'none', paddingTop: 0 }}>
        <Tag color="blue">业务池合计</Tag>
        <strong>{num(pool.cards_planned, 0)} 张</strong>
        <small>（物理 {num(pool.cards, 0)} 张 · 含 {num(Number(preview?.headroom ?? 0) * 100, 0)}% 余量 ·
          需求 {capacity(pool.planned_p)} · 等效 {capacity(pool.capacity_planned_p)}）</small>
      </div>}
      <Spin spinning={!!catalogLoading}>
        <Table<Obj> rowKey="id" dataSource={payload.scenarios} columns={columns} scroll={{ x: 1224 }}
          rowSelection={{ selectedRowKeys: selected, onChange: setSelected }}
          pagination={{ pageSize: 12, showSizeChanger: true }}
          locale={{ emptyText: <Empty description="上传业务场景清单，或添加第一个场景。" /> }} />
      </Spin>
      {!!pool?.missing_items?.length && <Alert className="below" type="warning" showIcon
        message={`${pool.missing_items.length} 个场景未计入合计`}
        description={<ul style={{ margin: 0, paddingInlineStart: 18 }}>
          {pool.missing_items.map((m: Obj) => <li key={m.id}>{m.name || m.id}：{m.message}</li>)}
        </ul>} />}
      <div className="batch-bar">
        <Button disabled={!selected.length} onClick={() => applySceneDefaults(selected)}>按场景档补全所选</Button>
        <Button onClick={() => applySceneDefaults(payload.scenarios.map((s: Obj) => s.id))}>按场景档补全全部</Button>
        <small>只补空字段：已填的并发与长度属于业务输入，不会被档位默认值覆盖。</small>
      </div>
    </Card>

    <Drawer width={720} title={scenario ? scenario.name + ' · 推理配置' : '场景配置'}
      open={!!scenario} onClose={() => setOpenId(null)} destroyOnHidden>
      {scenario && spec && <>
        <div className="field">
          <label>场景描述</label>
          <Input.TextArea value={scenario.description} rows={2}
            onChange={e => edit(p => { p.scenarios.find((s: Obj) => s.id === scenario.id).description = e.target.value; })} />
        </div>
        <Checkbox checked={scenario.enabled}
          onChange={e => edit(p => { p.scenarios.find((s: Obj) => s.id === scenario.id).enabled = e.target.checked; })}>
          计入规划
        </Checkbox>

        <Card size="small" className="below" title="模型与硬件">
          <div className="form-grid">
            <div className="field">
              <label>使用的模型</label>
              <Select style={{ width: '100%' }} value={spec.model_key} placeholder="待选择"
                showSearch optionFilterProp="label"
                options={models.map(m => ({ value: m.key, label: (m.label || m.key) + (m.custom ? ' · 自定义' : '') }))}
                onChange={v => write(scenario, { model_key: v })} />
              <small className="muted">
                {modelOf(spec).total_b
                  ? `总参 ${num(modelOf(spec).total_b)}B · 激活 ${num(modelOf(spec).active_b)}B · ${modelOf(spec).arch}`
                  : '未选择模型'}
              </small>
            </div>
            <div className="field">
              <label>推理量化精度</label>
              <Space.Compact style={{ width: '100%' }}>
                <Select style={{ width: '50%' }} value={spec.weight_precision} options={PRECISIONS}
                  onChange={v => write(scenario, { weight_precision: v })} />
                <Select style={{ width: '50%' }} value={spec.kv_precision} options={KV_PRECISIONS}
                  onChange={v => write(scenario, { kv_precision: v })} />
              </Space.Compact>
              <small className="muted">910B/910C 无原生 INT4，权重选 INT4 时算力按 INT8 计。</small>
            </div>
            <div className="field">
              <label>业务场景类型</label>
              <Select style={{ width: '100%' }} value={spec.scene_key}
                options={scenes.map(x => ({ value: x.key, label: x.name }))}
                onChange={v => {
                  const values: Obj = { scene_key: v };
                  const next = scenes.find(x => x.key === v) || {};
                  for (const [field] of SCENE_FIELDS) values[field] = next[field] ?? null;
                  write(scenario, values);
                }} />
              <small className="muted">{preset.hint}</small>
            </div>
            <div className="field">
              <label>算力服务器</label>
              <Select style={{ width: '100%' }} value={spec.chip_key} showSearch optionFilterProp="label"
                options={chips.map(c => ({ value: c.key, label: c.label }))}
                onChange={v => write(scenario, { chip_key: v })} />
              <small className="muted">
                {chipOf(spec).bf16_tflops
                  ? `BF16 ${chipOf(spec).bf16_tflops}T · 显存 ${chipOf(spec).memory_gb}GB · 带宽 ${chipOf(spec).hbm_tbs}TB/s`
                  : '—'}
              </small>
            </div>
          </div>
        </Card>

        <Collapse className="below" items={[{
          key: 'size',
          label: '业务规模与时延目标（默认取场景档位，可改写）',
          children: <>
            <div className="form-grid">
              {SCENE_FIELDS.map(([field, label, unit]) => (
                <div className="field" key={field}>
                  <label>{label}</label>
                  <InputNumber style={{ width: '100%' }}
                    min={field === 'tpot_target_ms' ? 1 : field === 'ttft_target_ms' ? 50 : field === 'max_ctx' ? 512 : 1}
                    value={spec[field] == null ? null : Number(spec[field])}
                    placeholder={String(preset[field] ?? '')}
                    addonAfter={unit}
                    onChange={v => write(scenario, { [field]: v ?? null })} />
                </div>
              ))}
              <div className="field">
                <label>Prefix 命中率</label>
                <InputNumber style={{ width: '100%' }} min={0} max={90}
                  value={Number(spec.prefix_hit || 0) * 100} addonAfter="%"
                  onChange={v => write(scenario, { prefix_hit: Number(v) / 100 })} />
              </div>
              <div className="field">
                <label>敏感度档位</label>
                <Select style={{ width: '100%' }} value={spec.profile}
                  options={(catalog?.sensitivity ?? []).map((s: Obj) => ({ value: s.key, label: s.label }))}
                  onChange={v => write(scenario, { profile: v })} />
              </div>
            </div>
            <div className="note-line">
              <InfoCircleOutlined aria-hidden="true" />
              并发按业务同时在线会话估算，不用人数直接代替；留空的字段取场景档位默认值。
              Prefix 命中只减少 Prefill 计算，不减少已写入的 KV 显存。
            </div>
            <Button icon={<ThunderboltFilled aria-hidden="true" />} onClick={() => {
              const values: Obj = {};
              for (const [field] of SCENE_FIELDS) values[field] = preset[field] ?? null;
              write(scenario, values);
            }}>按场景档恢复默认</Button>
          </>,
        }]} />

        <div className="soft-note" style={{ marginTop: 16 }}>
          同一批卡同时承担 Prefill 与 Decode，最终卡数取三维约束的最大值，不是相加；
          卡数是物理台数；需求算力以 BF16 稠密算力为基准、按所选推理精度折算，单位 P / T，两者不是同一量纲。
        </div>
      </>}
    </Drawer>

    <CustomModelModal open={modelModal} onClose={() => setModelModal(false)} onSaved={refreshCatalog} />
  </div>;
}
