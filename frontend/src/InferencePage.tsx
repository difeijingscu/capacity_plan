import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, Collapse, Descriptions, Empty, Form, Input, InputNumber,
  Modal, Row, Segmented, Select, Space, Spin, Table, Tag, Tooltip, App as AntApp,
} from 'antd';
import {
  ApiOutlined, DeleteOutlined, InfoCircleOutlined, PlusOutlined, ReloadOutlined,
  ThunderboltFilled,
} from '@ant-design/icons';
import { api } from './api';
import type { Obj } from './api';

const num = (v: unknown, digits = 2) =>
  v == null ? '—' : Number(v).toLocaleString('zh-CN', { maximumFractionDigits: digits });

const int = (v: unknown) => (v == null ? '—' : Math.round(Number(v)).toLocaleString('zh-CN'));

const warnText: Record<string, string> = {
  MLA_KV_PROXY: '该模型使用 MLA/压缩 KV，每 token 的缓存量按低秩维度近似，属经验代理值。',
  ATTN_SPAN_CAPPED: '模型设置了有效注意力跨度上限，超出部分不计入注意力计算量。',
  TTFT_NOT_REACHABLE_IN_NODE: '首 Token 目标在机内张量并行上限（8 卡）内无法达成，需放宽 TTFT 或缩短输入。',
  SLA_NOT_MET: '按当前拓扑与时延目标，即使逐级加数据并行仍未完全达标，请复核目标或扩大规模。',
  BANDWIDTH_FLOOR: '权重读取本身已接近或超过 TPOT 目标，属芯片显存带宽下限，继续加卡无效。',
  SLOT_OVERSOLD: '有效并发超过连续批上限（256），存在排队等待，TTFT 会被拉长。',
  PREFILL_BANDWIDTH_LIMITED: 'Prefill 阶段受显存带宽限制，加张量并行收益有限，建议换更高带宽芯片。',
  MIXED_UTIL_LIFTED: 'Prefill 与 Decode 同时占用同一批卡，利用率之和超过阈值，卡数下界被抬升。',
};

const numTag = { fontSize: 11, lineHeight: '18px', marginInlineEnd: 0 } as const;

export default function InferencePage({ onBackBasis }: { onBackBasis?: () => void }) {
  const { message } = AntApp.useApp();
  const [catalog, setCatalog] = useState<Obj | null>(null);
  const [result, setResult] = useState<Obj | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [customModal, setCustomModal] = useState(false);
  const [customForm] = Form.useForm();
  const [form] = Form.useForm();

  const [inputs, setInputs] = useState<Obj>({
    model_key: 'qwen3_8b',
    chip_key: '910c',
    scene_key: 'long_gen',
    weight_precision: 'auto',
    kv_precision: 'auto',
    profile: 'neutral',
    prefix_hit: 0,
  });

  const scenes: Obj[] = catalog?.scenes ?? [];
  const models: Obj[] = useMemo(
    () => [...(catalog?.models ?? []), ...(catalog?.custom_models ?? [])],
    [catalog],
  );
  const chips: Obj[] = catalog?.chips ?? [];
  const scene = scenes.find(s => s.key === inputs.scene_key);
  const model = models.find(m => m.key === inputs.model_key);

  useEffect(() => {
    setLoading(true);
    void api('/inference/catalog')
      .then(data => setCatalog(data))
      .catch((e: Error) => message.error(e.message))
      .finally(() => setLoading(false));
  }, [message]);

  function pickScene(key: string) {
    const next = scenes.find(s => s.key === key);
    setInputs(v => ({
      ...v, scene_key: key,
      concurrency: next?.concurrency,
      prompt_len: next?.prompt_len,
      output_len: next?.output_len,
      max_ctx: next?.max_ctx,
      ttft_target_ms: next?.ttft_ms,
      tpot_target_ms: next?.tpot_ms,
    }));
  }

  async function run() {
    setRunning(true);
    try {
      const body: Obj = {
        model_key: inputs.model_key,
        chip_key: inputs.chip_key,
        scene_key: inputs.scene_key,
        weight_precision: inputs.weight_precision || 'auto',
        kv_precision: inputs.kv_precision || 'auto',
        profile: inputs.profile || 'neutral',
        prefix_hit: Number(inputs.prefix_hit || 0),
      };
      for (const key of ['concurrency', 'prompt_len', 'output_len', 'max_ctx',
        'ttft_target_ms', 'tpot_target_ms']) {
        if (inputs[key] != null && inputs[key] !== '') body[key] = Number(inputs[key]);
      }
      const data = await api('/inference/estimate', 'POST', body);
      setResult(data.result);
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function saveCustomModel() {
    try {
      const values = await customForm.validateFields();
      await api('/inference/models', 'POST', values);
      message.success('自定义模型已登记');
      setCustomModal(false);
      customForm.resetFields();
      setCatalog(await api('/inference/catalog'));
    } catch (e) {
      if ((e as Obj)?.errorFields) return;
      message.error((e as Error).message);
    }
  }

  async function removeCustomModel(key: string) {
    try {
      await api('/inference/models/' + key, 'DELETE');
      message.success('已移除该自定义模型');
      setCatalog(await api('/inference/catalog'));
    } catch (e) {
      message.error((e as Error).message);
    }
  }

  if (loading && !catalog) {
    return <div className="center" style={{ padding: 80 }}><Spin /></div>;
  }

  return (
    <div className="inference-page">
      <Card className="pool-intro">
        <div>
          <span className="eyebrow">INFERENCE CAPACITY</span>
          <h2>一个场景，一张卡表。</h2>
          <p>
            按「显存 → Prefill → Decode」三维分别估算所需卡数，取最紧的一项；
            再按首 Token 与逐 Token 时延目标回验，不足时补数据并行。
          </p>
        </div>
        {onBackBasis && <Button onClick={onBackBasis}>查看计算依据</Button>}
      </Card>

      <Card title="场景与输入" className="below">
        <Row gutter={[20, 0]}>
          <Col xs={24} md={12} xl={6}>
            <div className="field">
              <label>使用的模型 <Tooltip title="清单内为内置结构表；清单外可登记自定义模型。"><InfoCircleOutlined /></Tooltip></label>
              <Select
                aria-label="推理模型" data-testid="model-select" style={{ width: '100%' }} value={inputs.model_key}
                showSearch optionFilterProp="label"
                options={models.map(m => ({
                  value: m.key,
                  label: (m.label || m.key) + (m.custom ? ' · 自定义' : ''),
                }))}
                onChange={v => setInputs(s => ({ ...s, model_key: v }))}
              />
              <small className="muted">
                {model
                  ? `总参 ${num(model.total_b)}B · 激活 ${num(model.active_b)}B · ${model.arch}` +
                    (model.experts ? ` · ${model.experts} 专家 TopK ${model.top_k}` : '')
                  : '—'}
              </small>
              <Button size="small" type="link" icon={<PlusOutlined />}
                onClick={() => setCustomModal(true)}>登记自定义模型</Button>
            </div>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <div className="field">
              <label>推理量化精度 <Tooltip title="W 权重 / A 激活 / KV 缓存三轴独立。选「自动」时按模型规模与显存推荐。"><InfoCircleOutlined /></Tooltip></label>
              <Space.Compact style={{ width: '100%' }}>
                <Select
                  aria-label="权重精度" data-testid="prec-select" style={{ width: '50%' }} value={inputs.weight_precision}
                  options={[
                    { value: 'auto', label: '自动推荐' },
                    { value: 'bf16', label: 'BF16' },
                    { value: 'fp8', label: 'FP8' },
                    { value: 'int8', label: 'INT8' },
                    { value: 'int4', label: 'INT4' },
                  ]}
                  onChange={v => setInputs(s => ({ ...s, weight_precision: v }))}
                />
                <Select
                  aria-label="KV精度" style={{ width: '50%' }} value={inputs.kv_precision}
                  options={[
                    { value: 'auto', label: 'KV 自动' },
                    { value: 'bf16', label: 'KV BF16' },
                    { value: 'fp8', label: 'KV FP8' },
                    { value: 'int8', label: 'KV INT8' },
                  ]}
                  onChange={v => setInputs(s => ({ ...s, kv_precision: v }))}
                />
              </Space.Compact>
              <small className="muted">
                {result
                  ? `${result.precision.label} · 算力按 ${num(result.precision.compute_tflops, 0)} TFLOPS`
                  : '910B/910C 无原生 INT4，A 轴会自动降为 INT8'}
              </small>
            </div>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <div className="field">
              <label>业务场景类型</label>
              <Select
                aria-label="业务场景类型" data-testid="scene-select" style={{ width: '100%' }}
                value={inputs.scene_key} showSearch optionFilterProp="label"
                options={scenes.map(s => ({ value: s.key, label: s.name }))}
                onChange={pickScene}
              />
              <small className="muted">{scene?.hint}</small>
            </div>
          </Col>
          <Col xs={24} md={12} xl={6}>
            <div className="field">
              <label>算力服务器</label>
              <Select
                aria-label="算力服务器" data-testid="chip-select" style={{ width: '100%' }}
                value={inputs.chip_key} showSearch optionFilterProp="label"
                options={chips.map(c => ({ value: c.key, label: c.label }))}
                onChange={v => setInputs(s => ({ ...s, chip_key: v }))}
              />
              {(() => {
                const chip = chips.find(c => c.key === inputs.chip_key);
                return chip ? (
                  <small className="muted">
                    BF16 {chip.bf16_tflops}T · INT8 {chip.int8_tflops}T
                    {chip.int4_tflops ? ` · INT4 ${chip.int4_tflops}T` : ''} ·{' '}
                    {chip.memory_gb}GB · {chip.hbm_tbs}TB/s · 互联 {chip.link_gbs}GB/s
                  </small>
                ) : null;
              })()}
            </div>
          </Col>
        </Row>

        <Collapse
          className="below"
          items={[{
            key: 'adv',
            label: '业务规模与时延目标（默认取场景档位，可改写）',
            children: (
              <>
                <Row gutter={[20, 0]}>
                  <Col xs={24} md={8} xl={4}>
                    <div className="field">
                      <label>并发会话</label>
                      <InputNumber aria-label="并发会话" min={1} style={{ width: '100%' }}
                        value={inputs.concurrency} placeholder={String(scene?.concurrency ?? '')}
                        onChange={v => setInputs(s => ({ ...s, concurrency: v as number }))} />
                    </div>
                  </Col>
                  <Col xs={24} md={8} xl={4}>
                    <div className="field">
                      <label>输入长度</label>
                      <InputNumber aria-label="输入长度" min={100} style={{ width: '100%' }}
                        value={inputs.prompt_len} placeholder={String(scene?.prompt_len ?? '')}
                        onChange={v => setInputs(s => ({ ...s, prompt_len: v as number }))} addonAfter="tok" />
                    </div>
                  </Col>
                  <Col xs={24} md={8} xl={4}>
                    <div className="field">
                      <label>输出长度</label>
                      <InputNumber aria-label="输出长度" min={100} style={{ width: '100%' }}
                        value={inputs.output_len} placeholder={String(scene?.output_len ?? '')}
                        onChange={v => setInputs(s => ({ ...s, output_len: v as number }))} addonAfter="tok" />
                    </div>
                  </Col>
                  <Col xs={24} md={8} xl={4}>
                    <div className="field">
                      <label>首 Token 目标</label>
                      <InputNumber aria-label="TTFT目标" min={50} style={{ width: '100%' }}
                        value={inputs.ttft_target_ms} placeholder={String(scene?.ttft_ms ?? '')}
                        onChange={v => setInputs(s => ({ ...s, ttft_target_ms: v as number }))} addonAfter="ms" />
                    </div>
                  </Col>
                  <Col xs={24} md={8} xl={4}>
                    <div className="field">
                      <label>逐 Token 目标</label>
                      <InputNumber aria-label="TPOT目标" min={1} style={{ width: '100%' }}
                        value={inputs.tpot_target_ms} placeholder={String(scene?.tpot_ms ?? '')}
                        onChange={v => setInputs(s => ({ ...s, tpot_target_ms: v as number }))} addonAfter="ms" />
                    </div>
                  </Col>
                  <Col xs={24} md={8} xl={4}>
                    <div className="field">
                      <label>Prefix 命中率</label>
                      <InputNumber aria-label="Prefix命中率" min={0} max={90} style={{ width: '100%' }}
                        value={Number(inputs.prefix_hit || 0) * 100}
                        onChange={v => setInputs(s => ({ ...s, prefix_hit: Number(v) / 100 }))} addonAfter="%" />
                    </div>
                  </Col>
                </Row>
                <div className="note-line">
                  <InfoCircleOutlined />
                  并发建议按业务在线量估算，不直接沿用示例值；Prefix 命中只减少 Prefill 计算，
                  不减少已写入的 KV 显存。
                </div>
              </>
            ),
          }]}
        />

        <div className="batch-bar">
          <Segmented
            value={inputs.profile}
            options={(catalog?.sensitivity ?? []).map((s: Obj) => ({ value: s.key, label: s.label }))}
            onChange={v => setInputs(s => ({ ...s, profile: v as string }))}
          />
          <Button type="primary" icon={<ThunderboltFilled />} loading={running} onClick={() => void run()}>
            开始评估
          </Button>
          <Button icon={<ReloadOutlined />} onClick={() => {
            const s = scenes.find(x => x.key === inputs.scene_key);
            if (s) pickScene(s.key);
          }}>恢复场景默认值</Button>
          <small>三档敏感度结果通常相差 15%~30%，对外报规须注明所用档位。</small>
        </div>
      </Card>

      {!result ? (
        <Card className="below">
          <Empty description="填写场景信息后开始评估，将给出三维约束、拓扑与卡数。" />
        </Card>
      ) : (
        <ResultView data={result} chips={chips} />
      )}

      <Card title="模型清单" className="below"
        extra={<Button size="small" icon={<PlusOutlined />} onClick={() => setCustomModal(true)}>登记自定义模型</Button>}>
        <Table<Obj>
          rowKey="key" dataSource={models} size="small" pagination={{ pageSize: 8 }}
          scroll={{ x: 980 }}
          columns={[
            { title: '模型', dataIndex: 'label', width: 230 },
            { title: '总参 (B)', dataIndex: 'total_b', width: 90, render: (v: unknown) => num(v) },
            { title: '激活 (B)', dataIndex: 'active_b', width: 90, render: (v: unknown) => num(v) },
            { title: '层数', dataIndex: 'layers', width: 70 },
            { title: '注意力', width: 90, render: (_, m) => m.latent_dim || m.rope_dim ? 'MLA' : m.kv_heads < m.heads ? 'GQA' : 'MHA' },
            { title: '架构', width: 90, render: (_, m) => <Tag color={m.arch === 'MoE' ? 'purple' : 'default'}>{m.arch}</Tag> },
            { title: '专家/TopK', width: 100, render: (_, m) => m.experts ? `${m.experts} / ${m.top_k}` : '—' },
            { title: '来源', width: 100, render: (_, m) => m.custom ? <Tag color="blue">自定义</Tag> : <Tag>内置</Tag> },
            {
              title: '', width: 60, render: (_, m) => m.custom
                ? <Button size="small" type="text" icon={<DeleteOutlined />} onClick={() => void removeCustomModel(m.key)} />
                : null,
            },
          ]}
        />
        <div className="note-line" style={{ marginTop: 14, marginBottom: 0 }}>
          <InfoCircleOutlined />
          内置模型结构取自公开模型配置，属纸面规格；自定义模型请按真实结构填写总参、激活参、
          层数与注意力维度，缺失字段会显著影响显存与工作量估算。
        </div>
      </Card>

      <Modal title="登记自定义模型" open={customModal} onCancel={() => setCustomModal(false)}
        onOk={() => void saveCustomModel()} okText="保存" cancelText="取消" width={720} destroyOnClose>
        <Alert type="info" showIcon className="below"
          message="字段与内置模型一致；激活参数对 MoE 填「每个 token 实际参与计算」的参数量。" />
        <Form form={customForm} layout="vertical" preserve={false}
          initialValues={{ arch: 'Dense', kv_heads: 8, head_dim: 128, gqa_kv_fraction: 1, ffn_mul: 2.5, rope_dim: 0, attn_span: 0 }}>
          <Row gutter={16}>
            <Col span={8}><Form.Item name="key" label="标识" rules={[{ required: true, message: '请填写标识' }]}>
              <Input placeholder="my-model-v1" /></Form.Item></Col>
            <Col span={16}><Form.Item name="label" label="显示名称">
              <Input placeholder="自研 30B（选填）" /></Form.Item></Col>
            <Col span={8}><Form.Item name="total_b" label="总参数 (B)" rules={[{ required: true, message: '必填' }]}>
              <InputNumber min={0.1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="active_b" label="激活参数 (B)" rules={[{ required: true, message: '必填' }]}>
              <InputNumber min={0.1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="hid" label="隐层维度" rules={[{ required: true, message: '必填' }]}>
              <InputNumber min={128} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="layers" label="层数" rules={[{ required: true, message: '必填' }]}>
              <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="heads" label="Q 头数" rules={[{ required: true, message: '必填' }]}>
              <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="kv_heads" label="KV 头数">
              <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="head_dim" label="每头维度">
              <InputNumber min={8} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="kv_head_dim" label="KV 头维度（留空同每头）">
              <InputNumber min={8} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="ffn_mul" label="FFN 扩张倍数">
              <InputNumber min={0.1} step={0.1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="gqa_kv_fraction" label="全注意力层占比">
              <InputNumber min={0} max={1} step={0.05} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="experts" label="专家数（MoE 填）">
              <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="top_k" label="Top-K（MoE 填）">
              <InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="attn_span" label="注意力跨度上限（0 不限）">
              <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="latent_dim" label="MLA 低秩维度（留空非 MLA）">
              <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="rope_dim" label="RoPE 维度">
              <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="qk_head_dim" label="MLA QK 头维度">
              <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="v_head_dim" label="MLA V 头维度">
              <InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
    </div>
  );
}

function Metric({ label, value, unit, note, primary }: {
  label: string; value: string; unit?: string; note?: string; primary?: boolean;
}) {
  return (
    <div className={'metric' + (primary ? ' primary' : '')}>
      <span>{label}</span>
      <strong>{value}{unit && <small style={{ fontSize: 13, marginLeft: 5 }}>{unit}</small>}</strong>
      {note && <small>{note}</small>}
    </div>
  );
}

function DimBar({ name, value, max, binding }: { name: string; value: number; max: number; binding: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={'dim-row' + (binding ? ' is-binding' : '')}>
      <span className="dim-name">{name}{binding && <Tag color="red" style={numTag}>瓶颈</Tag>}</span>
      <div className="dim-track"><div className="dim-fill" style={{ width: pct + '%' }} /></div>
      <strong className="dim-val">{value}</strong>
    </div>
  );
}

function Formula({ children }: { children: React.ReactNode }) {
  return <div className="basis-formula">{children}</div>;
}

function ResultView({ data, chips }: { data: Obj; chips: Obj[] }) {
  const r = data;
  const tp = r.topology;
  const maxDim = Math.max(r.memory.n_memory, r.prefill.n_pf, r.decode.n_dc, 1);
  const binding = r.result.bottleneck;

  return (
    <>
      <div className="metric-grid inference-metrics">
        <Metric label="推荐卡数" value={int(r.result.cards)} unit="张"
          note={`${tp.text} · ${r.result.servers} 台（按 8 卡/台）`} primary />
        <Metric label="含余量卡数" value={int(r.result.margin_cards)} unit="张"
          note={`推荐卡数 × 1.2 且至少加一个实例（每实例 ${tp.unit} 张）`} />
        <Metric label="等效算力" value={num(r.result.capacity_p, 3)} unit="P"
          note={`${int(r.result.capacity_tflops)} TFLOPS · ${r.precision.label}`} />
        <Metric label="计划峰值" value={num(r.result.demand_p, 3)} unit="P"
          note={`QPS ${num(r.workload.qps_demand, 3)} · 预测 E2E ${int(r.workload.e2e_predicted_ms)} ms`} />
      </div>

      {r.warnings.length > 0 && (
        <Alert className="below" type="warning" showIcon message="需要留意"
          description={<ul style={{ margin: 0, paddingLeft: 18 }}>
            {r.warnings.map((w: string) => <li key={w}>{warnText[w] || w}</li>)}
          </ul>} />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
          <Card title="三维约束" style={{ height: '100%' }}>
            <div className="dim-chart">
              <DimBar name="① 显存装载" value={r.memory.n_memory} max={maxDim} binding={binding === '显存'} />
              <DimBar name="② Prefill 算力" value={r.prefill.n_pf} max={maxDim} binding={binding === 'Prefill'} />
              <DimBar name="③ Decode 算力/带宽" value={r.decode.n_dc} max={maxDim} binding={binding === 'Decode'} />
            </div>
            <div className="dim-note">
              <div>物理下界 <strong>{r.mixed.floor}</strong> 张 = 三项取最大，<b>不是相加</b></div>
              {r.mixed.lifted && (
                <div className="dim-lift">
                  Prefill 利用率 {num(r.mixed.u_prefill * 100, 1)}% + Decode 利用率{' '}
                  {num(r.mixed.u_decode * 100, 1)}% 超过阈值 {num(r.mixed.threshold * 100, 0)}%，
                  下界抬升至 <strong>{r.mixed.mixed_floor}</strong> 张
                </div>
              )}
              <div className="dim-note-soft">
                当前瓶颈：<Tag color="red" style={numTag}>{binding}</Tag>
                同一批卡既处理 Prefill 也处理 Decode，最终只取最紧的一项。
              </div>
            </div>
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card title="时延与达标判定" style={{ height: '100%' }}>
            <Descriptions column={{ xs: 1, sm: 2 }} size="small" items={[
              {
                key: 'ttft', label: '首 Token（TTFT）',
                children: <span className={r.sla.ttft_ms <= r.sla.ttft_target ? 'sla-ok' : 'sla-bad'}>
                  {int(r.sla.ttft_ms)} / {int(r.sla.ttft_target)} ms
                </span>,
              },
              {
                key: 'tpot', label: '逐 Token（TPOT）',
                children: <span className={r.sla.tpot_ms <= r.sla.tpot_target ? 'sla-ok' : 'sla-bad'}>
                  {num(r.sla.tpot_ms, 1)} / {num(r.sla.tpot_target, 1)} ms
                </span>,
              },
              {
                key: 'pass', label: '达标判定',
                children: r.sla.passed
                  ? <Tag color="green" style={numTag}>达标</Tag>
                  : <Tag color="red" style={numTag}>未达标</Tag>,
              },
              { key: 'dp', label: '数据并行', children: `DP=${r.sla.dp}` },
              { key: 'q', label: '排队等待', children: `${num(r.sla.queue_ms, 1)} ms` },
              { key: 'slot', label: '槽位等待', children: `${num(r.sla.slot_wait_ms, 1)} ms` },
              { key: 'conc', label: '并发会话', children: int(r.workload.concurrency) },
              { key: 'batch', label: 'Decode 有效批', children: num(r.decode.eff_batch, 2) },
            ]} />
            <div className="note-line" style={{ marginTop: 16, marginBottom: 0 }}>
              <InfoCircleOutlined />
              首 Token 需等整段 Prefill 算完，分块预填充只改善对 Decode 的打断，不缩短 TTFT。
              时延不达标时优先加数据并行，不改模型切分。
            </div>
          </Card>
        </Col>
      </Row>

      <Card title="计算过程" className="below">
        <Collapse defaultActiveKey={['mem']} items={[
          {
            key: 'mem', label: `① 显存约束 → ${r.memory.n_memory} 张`,
            children: (
              <>
                <Formula>
                  <span>权重装载下界</span>
                  <div>
                    权重 {num(r.memory.weight_gib)} GiB ÷ (单卡 {int(chips.find(c => c.key === r.chip_key)?.memory_gb)} GB ×{' '}
                    {num(r.memory.mem_fill * 100, 0)}%) = {r.memory.weight_min_cards} 张
                  </div>
                  <small>权重按 GiB 计（÷1024³），显存利用率 {num(r.memory.mem_fill * 100, 0)}% 为中性档默认。</small>
                </Formula>
                <Formula>
                  <span>KV 缓存需求</span>
                  <div>
                    {num(r.memory.kv_bytes_per_token * 1e9, 0)} byte/token × {int(r.memory.kv_alloc_len)} tok ×{' '}
                    {int(r.workload.concurrency)} 路 × {num(r.memory.kv_reserve, 2)} 预留系数 ={' '}
                    {num(r.memory.kv_need_gib)} GiB
                  </div>
                  <small>
                    每会话分配量取「窗口写满」或「输入+输出/2」，取决于 maxCtx 是否明显大于本轮占用。
                    显存按窗口预留，Decode 带宽按连续批均值（{int(r.memory.kv_decode_len)} tok）计。
                  </small>
                </Formula>
                <Formula>
                  <span>单卡可用与副本数</span>
                  <div>
                    单卡可用 = 单卡显存 × 利用率 − 单卡权重 − 激活 {num(r.memory.activation_gib, 2)} GiB =
                    {' '}{num(r.memory.kv_cap_gib)} GiB；所需实例 = ⌈{num(r.memory.kv_need_gib)} ÷ {num(r.memory.kv_cap_gib)}⌉
                  </div>
                  <small>同实例内权重共享，KV 按并发累加；MoE 的专家权重按 EP 分摊。</small>
                </Formula>
              </>
            ),
          },
          {
            key: 'pf', label: `② Prefill 约束 → ${r.prefill.n_pf} 张`,
            children: (
              <>
                <Formula>
                  <span>单请求计算量</span>
                  <div>
                    FFN {num(data.prefill.ffn_flops / 1e12, 1)} TFLOP + 注意力{' '}
                    {num(data.prefill.attn_flops / 1e12, 1)} TFLOP
                    （FFN 填充率 {num(data.prefill.ffn_fill * 100, 1)}%）
                  </div>
                  <small>
                    算力按激活参数计；MoE 小批量时专家块填不满，用填充率折算，这是 MoE
                    在短输入下反而更贵的原因。
                  </small>
                </Formula>
                <Formula>
                  <span>单卡有效算力（roofline 取小）</span>
                  <div>
                    min(单卡算力 × Prefill MFU {num(data.prefill.mfu * 100, 1)}%, 带宽可达) ={' '}
                    {num(data.prefill.effective_tflops, 1)} TFLOPS
                    {data.prefill.bandwidth_limited ? '（带宽受限）' : '（算力受限）'}
                  </div>
                  <small>需求算力与带宽上限取小：算力再高，喂不进数据也没用。</small>
                </Formula>
                <Formula>
                  <span>两个卡数取大</span>
                  <div>
                    吞吐约束 {r.prefill.n_pf_throughput} 张、首 Token 时延约束 {r.prefill.n_pf_latency} 张 →{' '}
                    max = <strong>{r.prefill.n_pf} 张</strong>
                  </div>
                  <small>
                    吞吐按需求 QPS（并发 ÷ 系统预测 E2E），时延按「首 Token 目标 − 引擎固定开销」折成算力预算。
                    时延约束超过 8 即表示机内张量并行不够用。
                  </small>
                </Formula>
              </>
            ),
          },
          {
            key: 'dc', label: `③ Decode 约束 → ${r.decode.n_dc} 张`,
            children: (
              <>
                <Formula>
                  <span>单步搬运与耗时</span>
                  <div>
                    权重读 {num(r.decode.step_bw_ms, 2)} ms（含 KV，合计带宽时间）、算力{' '}
                    {num(r.decode.step_compute_ms, 2)} ms、通信 {num(r.decode.step_comm_ms, 2)} ms、
                    固定开销 {num(r.decode.step_fixed_ms, 2)} ms → TPOT {num(r.decode.tpot_ms, 1)} ms
                  </div>
                  <small>
                    Decode 是带宽游戏：每出一个 token 都要把权重重新读一遍。长序列下 KV 读带宽效率还会衰减。
                  </small>
                </Formula>
                <Formula>
                  <span>权重地板</span>
                  <div>
                    单步权重地板 {num(r.decode.weight_floor_ms, 2)} ms vs 目标 {num(r.sla.tpot_target, 1)} ms
                    {r.decode.bandwidth_floor_blocked ? ' → 已达带宽下限，加卡无效' : ' → 仍在目标内'}
                  </div>
                  <small>地板本身超过目标时，任何并行都救不回来，只能放宽目标或换更高带宽芯片。</small>
                </Formula>
                <Formula>
                  <span>带宽反解副本数</span>
                  <div>
                    带宽约束 {r.decode.n_dc_bw} 张、吞吐约束 {r.decode.n_dc_thr} 张 → max ={' '}
                    <strong>{r.decode.n_dc} 张</strong>
                  </div>
                  <small>按 TPOT 剩余预算反解单副本能带多少路会话，再取整成副本数。</small>
                </Formula>
              </>
            ),
          },
          {
            key: 'sla', label: `④ 拓扑与 SLA 回验 → ${tp.text}`,
            children: (
              <>
                <Descriptions column={{ xs: 1, sm: 2 }} size="small" items={[
                  { key: 'a', label: '张量并行 TP', children: tp.tp },
                  { key: 'b', label: '流水线并行 PP', children: tp.pp },
                  { key: 'c', label: '专家并行 EP', children: data.moe ? tp.ep : '不适用（Dense）' },
                  { key: 'd', label: '数据并行 DP', children: tp.dp },
                  { key: 'e', label: '单实例卡数', children: tp.unit },
                  { key: 'f', label: '总卡数', children: tp.cards },
                ]} />
                <div className="note-line" style={{ marginTop: 16 }}>
                  <InfoCircleOutlined />
                  TP 把权重切碎降低单卡读带宽，但增加 AllReduce；PP 按层切分解决单卡装不下；
                  EP 只切专家。回验不达标时逐级加 DP，不改模型切分。
                </div>
              </>
            ),
          },
        ]} />
      </Card>

      <Card title="评估口径" className="below">
        <Descriptions column={{ xs: 1, sm: 2, xl: 3 }} size="small" items={[
          { key: '1', label: '敏感度档位', children: <Tag color="blue" style={numTag}>{data.profile_label}</Tag> },
          { key: '2', label: '模型结构', children: `${data.model_label} · ${data.arch}` },
          { key: '3', label: '算力服务器', children: data.chip_label },
          { key: '4', label: '量化口径', children: data.precision.label },
          { key: '5', label: '最大上下文', children: `${int(data.workload.max_ctx)} tok` },
          { key: '6', label: 'Prefix 命中', children: `${num(data.workload.prefix_hit * 100, 0)}%` },
        ]} />
        <div className="note-line" style={{ marginTop: 16, marginBottom: 0 }}>
          <InfoCircleOutlined />
          全部效率、结构修正与填充率均为 C 级经验假设，结果用于早期规划；
          响应时间与设备互联条件需以实测校准。三芯对照仅做规格折算，不代表大陆实际供给。
        </div>
      </Card>
    </>
  );
}
