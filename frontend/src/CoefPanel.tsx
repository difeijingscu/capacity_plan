import { useCallback, useEffect, useState } from 'react';
import { Button, InputNumber, Popconfirm, Spin, Tag, Tooltip, App as AntApp } from 'antd';
import { InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { api } from './api';
import type { Obj } from './api';

/**
 * 当前生效的工程系数（可调）——与推理评估页「当前生效的工程系数」面板同口径。
 *
 * 数据来自后端 /inference/params（默认值 catalogs/inference_params.json + 覆盖层）：
 * - 效率类（mfu_prefill / bw_decode / mem_util）按「基准值 × 档位系数」生效（mem_util 半幅）；
 * - 结构性开销（mfu_decode_ratio / kv_reserve）与口径常数不受档位影响；
 * - 改动写入覆盖层并长期生效（与「基线与设置 → 推理参数」同一存储），保存后立即重算。
 * 自定义算力卡未单独登记系数时按通用经验值（CUSTOM_CHIP_PROFILE）生效。
 */

/** 自定义算力卡的通用经验系数（后端 inference.CUSTOM_CHIP_PROFILE 同口径）。 */
const CUSTOM_CHIP_PROFILE: Obj = {
  mfu_prefill: 0.38, mfu_decode_ratio: 0.62, bw_decode: 0.66, kv_reserve: 1.10, mem_util: 0.90,
};

interface CoefDef {
  k: string; label: string; pct?: boolean; ratio?: boolean;
  tiered?: 'full' | 'half' | 'none';
  eff: string; why: string;
}

/** 芯片效率系数（页面 COEF_DEFS scope=chip 同口径，why 文案移植）。 */
const CHIP_COEF_DEFS: CoefDef[] = [
  {
    k: 'mfu_prefill', label: 'Prefill MFU', pct: true, tiered: 'full',
    eff: '算力利用率，作用在 B · Prefill 的「有效算力/卡」',
    why: '长序列 Prefill 几乎全是超大 GEMM，推理框架（vLLM-Ascend / MindIE）实测达峰一般只有标称峰值的 1/4 左右。910C 的 1120T 是 INT8 稠密峰值，取 26%（≈291T/卡），与参考实现一致。随档位全额缩放。',
  },
  {
    k: 'mfu_decode_ratio', label: 'Decode MFU 倍数', ratio: true, tiered: 'none',
    eff: 'Decode MFU = Prefill MFU × 该倍数，作用在 C · Decode 的每步计算时间',
    why: 'Decode 每步 batch 小、访存受限，MFU 通常只有 Prefill 的 0.6~0.85 倍。910C 的 Prefill MFU 已按大 GEMM 取到 0.26，故倍数抬到 0.80（Decode ≈ 0.208）；其余芯片 Prefill 取 0.40、倍数 0.58~0.66，绝对值同样落在 0.23~0.26 这一区间。它是比值，不随档位缩放——若跟着乘，Decode MFU 会被扣两次（×coef²）。',
  },
  {
    k: 'bw_decode', label: 'Decode HBM 带宽利用率', pct: true, tiered: 'full',
    eff: '作用在 C · Decode 的每步权重/KV 读取时间',
    why: 'HBM 标称带宽是理论峰值，而 Decode 每步是「顺序读大权重 + 分散读 KV」的混合访问，实测达成率多在 60%~70%。910C/910B 取 62%，带宽更高的 950 系（4TB/s）取 70%。随档位全额缩放。',
  },
  {
    k: 'mem_util', label: '单卡显存容量利用率', pct: true, tiered: 'half',
    eff: '可用显存 = 标称显存 × 该系数，A/C 两条约束共用',
    why: '显存要给 CANN runtime、通信 buffer 与框架缓存留 8%~12%，故基准按 90% 计。显存越小的卡这部分占比越高。随档位半幅缩放（保守 80.5% / 均衡 90% / 激进 95%）：其中约一半是框架固定占用、不随乐观度变，另一半是碎片与临时峰值，才跟着档位走。',
  },
  {
    k: 'kv_reserve', label: 'KV 显存预留系数', ratio: true, tiered: 'none',
    eff: 'A · 显存：KV 需求 = 并发 × 均长 × 每token KV × 该系数',
    why: 'KV 已按「并发 × 连续批均长」均值预留，但 PagedAttention 块对齐、显存碎片与临时峰值还会多占一点，留 10% 覆盖。调大更保守（卡数上升）；调到 1.00 等于不留碎片余量。不受档位影响——碎片是物理量，不随乐观程度变。',
  },
];

/** 口径常数（页面 COEF_DEFS scope=const 同口径；其余常数沿用 schema 说明）。 */
const CONST_COEF_DEFS: CoefDef[] = [
  {
    k: 'prefill_budget', label: 'Prefill 计算预算占比', pct: true,
    eff: '吞吐下限 N1 与 TTFT 判据（目标 × 该系数）同时生效',
    why: '稳态要留 15% 算力给突发、调度与队列抖动，否则等于「算力一分不剩全排满」，上线即容易排队超时。这是对 B 维卡数影响最直接的一项：调到 100% 会让 B 维明显偏乐观。',
  },
  {
    k: 'decode_fixed_ms', label: 'Decode 每步固定开销', ratio: true,
    eff: '每步累加；同时是「带宽理论下限」的常数项',
    why: '调度器开销 + 内核启动 + 采样，与 batch、分片基本无关，实测多在 1~2ms，取 1.35ms。调大会同步抬高 TPOT 的物理下限，可能把本该「加卡可解」的场景判成「加卡无效」。',
  },
  {
    k: 'roofline_overlap', label: 'Roofline 重叠惩罚', ratio: true,
    eff: 'Decode 步长 = max(带宽, 计算) + 该系数 × min',
    why: 'Decode 每步的访存与计算能部分重叠：完全重叠取 0（步长 = max），完全不重叠取 1（步长 = 两者之和）。实测介于两者之间，取 0.4；引擎为同步执行可上调，深度优化后可下调。',
  },
  {
    k: 'queue_coef', label: '排队近似系数', ratio: true,
    eff: 'M/G/1：TTFT = 服务时间 × (1 + 系数·ρ/(1−ρ))',
    why: 'Kingman 近似里的变异系数项，0.5 对应服务时间抖动中等（CA²≈1）。业务有明显突发（营销活动、整点秒杀）可上调到 0.8~1.0；纯离线批处理可下调到 0.2~0.3。',
  },
  {
    k: 'moe_skew', label: 'MoE 权重偏斜', ratio: true,
    eff: '仅 MoE 模型：权重显存 = 总参 × 字节 × 该系数',
    why: 'MoE 权重按专家分文件存放，专家分布不均 + 按 128/256 对齐填充，实际权重文件比标称参数量大 5%~10%，取 8%。Dense 模型不受此项影响。',
  },
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export default function CoefPanel({ chipKey, tier, chipLabel, onChanged }: {
  chipKey?: string; tier: string; chipLabel?: string; onChanged: () => void;
}) {
  const { message } = AntApp.useApp();
  const [state, setState] = useState<Obj | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await api('/inference/params'));
    } catch (error) {
      message.error((error as Error).message);
    }
  }, [message]);

  useEffect(() => { void load(); }, [load]);

  async function savePatch(patch: Obj) {
    setSaving(true);
    try {
      setState(await api('/inference/params', 'PUT', { overrides: patch }));
      message.success('系数已保存并即时生效');
      onChanged();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function resetAll() {
    setSaving(true);
    try {
      setState(await api('/inference/params/reset', 'POST', {}));
      message.success('已恢复默认系数');
      onChanged();
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (!state) return <Spin size="small" />;
  const effective = state.effective || {};
  const overrides = state.overrides || {};
  const constants = effective.constants || {};
  const tierCoef = Number(effective.tiers?.[tier]?.coef ?? 1);
  const tierLabel = effective.tiers?.[tier]?.label || tier;
  const exps = effective.tier_exponents || {};

  /** schema 元数据（区间与说明）：chip_profiles 表 + constants 组。 */
  const chipMeta: Obj = Object.fromEntries(
    ((state.schema?.tables || []).find((t: Obj) => t.key === 'chip_profiles')?.fields || [])
      .map((f: Obj) => [f.key, f]));
  const constMeta: Obj = Object.fromEntries(
    ((state.schema?.groups || []).find((g: Obj) => g.key === 'constants')?.fields || [])
      .map((f: Obj) => [f.key, f]));

  const chipBase: Obj = { ...CUSTOM_CHIP_PROFILE, ...((effective.chip_profiles || {})[chipKey || ''] || {}) };
  const chipOv: Obj = (overrides.chip_profiles || {})[chipKey || ''] || {};
  const constOv: Obj = overrides.constants || {};
  const customProfile = chipKey && !(effective.chip_profiles || {})[chipKey];

  /** 档位作用后的生效值（与后端 eng_at 同一公式）。 */
  function effOf(def: CoefDef): number {
    const base = Number(chipBase[def.k]);
    if (def.tiered === 'full') {
      const meta = chipMeta[def.k] || {};
      const exp = Number(exps[def.k] ?? 1);
      return clamp(base * Math.pow(tierCoef, exp), Number(meta.min ?? 0), Number(meta.max ?? 1e9));
    }
    if (def.tiered === 'half') {
      const meta = chipMeta[def.k] || {};
      const exp = Number(exps[def.k] ?? 0.5);
      return clamp(base * Math.pow(tierCoef, exp), Number(meta.min ?? 0), Number(meta.max ?? 1e9));
    }
    return base;
  }

  const fmtVal = (def: CoefDef, v: number) =>
    def.pct ? (v * 100).toFixed(1) + ' %' : def.ratio ? '× ' + v.toFixed(2) : String(v);

  function coefRow(def: CoefDef, scope: 'chip' | 'const') {
    const meta = (scope === 'chip' ? chipMeta : constMeta)[def.k] || {};
    const base = scope === 'chip' ? Number(chipBase[def.k]) : Number(constants[def.k]);
    const overridden = scope === 'chip' ? def.k in chipOv : def.k in constOv;
    const range = meta.min !== undefined
      ? `允许 ${def.pct ? Number(meta.min) * 100 + '–' + Number(meta.max) * 100 + ' %' : meta.min + '–' + meta.max}` : '';
    const inputVal = def.pct ? base * 100 : base;
    const effLine = scope === 'chip'
      ? (def.k === 'mfu_decode_ratio'
        ? <>比值不缩放 · 生效 Decode MFU <b>{((effOf(CHIP_COEF_DEFS[0]) * base) * 100).toFixed(1)} %</b></>
        : def.tiered && def.tiered !== 'none'
          ? <>档位 ×{tierCoef}{def.tiered === 'half' && tierCoef !== 1 ? ' 半幅(√)' : ''} → 生效 <b>{fmtVal(def, effOf(def))}</b></>
          : <>不受档位影响</>)
      : null;
    return (
      <div className="cf-item" key={def.k}>
        <div>
          <div className="cf-k">{def.label}
            {range && <span className="cf-range">{range}</span>}
            {overridden && <Tag color="blue" className="param-tag">已调</Tag>}
          </div>
          <div className="cf-why">{def.eff}。{def.why}</div>
        </div>
        <div className="cf-val">
          <InputNumber
            key={scope + ':' + chipKey + ':' + def.k + ':' + base}
            size="small" defaultValue={Number(inputVal.toFixed(4))}
            min={def.pct ? Number(meta.min ?? 0) * 100 : Number(meta.min ?? 0)}
            max={def.pct ? Number(meta.max ?? 1) * 100 : Number(meta.max ?? 100)}
            step={def.pct ? 1 : 0.01}
            disabled={saving || (scope === 'chip' && !chipKey)}
            onBlur={e => commit(def, scope, Number(e.target.value), base)}
            onPressEnter={e => commit(def, scope, Number((e.target as HTMLInputElement).value), base)}
          />
          {effLine && <small className="cf-eff">{effLine}</small>}
        </div>
      </div>
    );
  }

  function commit(def: CoefDef, scope: 'chip' | 'const', raw: number, base: number) {
    if (!Number.isFinite(raw)) return;
    const v = def.pct ? raw / 100 : raw;
    if (Math.abs(v - base) < 1e-9) return;
    if (scope === 'chip') {
      if (!chipKey) return;
      void savePatch({ chip_profiles: { [chipKey]: { [def.k]: v } } });
    } else {
      void savePatch({ constants: { [def.k]: v } });
    }
  }

  const ovCount = Object.keys(chipOv).length + Object.keys(constOv).length;
  const otherConstKeys = Object.keys(constants).filter(k => !CONST_COEF_DEFS.some(d => d.k === k));

  return (
    <Spin spinning={saving} size="small">
      <div className="cf-grid">
        <div className="cf-col tiered">
          <div className="cf-col-h">效率类 · 按芯片标定（{chipLabel || chipKey || '—'}）
            <em>基准值可改；Prefill MFU 与带宽利用率随档位（{tierLabel} ×{tierCoef}）全额缩放，显存利用率半幅，比值与 KV 预留不缩放{customProfile ? '；该卡未单独登记系数，当前按通用经验值生效' : ''}</em>
          </div>
          {CHIP_COEF_DEFS.map(d => coefRow(d, 'chip'))}
        </div>
        <div className="cf-col">
          <div className="cf-col-h">结构性开销 / 口径常数
            <em>物理必然多占的量与口径常数，与调优乐观程度无关，档位不改动它们</em>
          </div>
          {CONST_COEF_DEFS.map(d => coefRow(d, 'const'))}
          {otherConstKeys.length > 0 && (
            <Tooltip title={'其余口径常数（' + otherConstKeys.map(k => constMeta[k]?.label || k).join('、') + '）可在「基线与设置 → 推理参数」调整'}>
              <small className="cf-eff"><InfoCircleOutlined /> 另 {otherConstKeys.length} 项 FFN 利用率与排队上限常数见基线与设置页</small>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="cf-bar">
        <span>{ovCount ? `当前芯片/常数已调整 ${ovCount} 项（保存在参数覆盖层，长期生效）` : '当前全部为默认值'}</span>
        <span className="spacer" />
        <Popconfirm title="恢复全部默认？将清空推理参数的全部覆盖（含其他芯片与常数）。" onConfirm={() => void resetAll()}>
          <Button size="small" icon={<ReloadOutlined aria-hidden="true" />} disabled={!state.has_overrides}>恢复默认</Button>
        </Popconfirm>
      </div>
    </Spin>
  );
}
