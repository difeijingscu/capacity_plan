import { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Collapse, Empty, Input, InputNumber, Space, Spin, Tabs, Tag,
  Tooltip, App as AntApp,
} from 'antd';
import { InfoCircleOutlined, ReloadOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import { api } from './api';
import type { Obj } from './api';

function stepOf(meta: Obj) {
  if (meta.type === 'int') return 1;
  const max = Number(meta.max ?? 1);
  return max <= 1 ? 0.01 : max <= 10 ? 0.1 : 1;
}

function Field({ meta, value, overridden, changed, onChange }: {
  meta: Obj; value: unknown; overridden: boolean; changed: boolean; onChange: (v: number | null) => void;
}) {
  return (
    <div className={'param-field' + (changed ? ' is-changed' : '')}>
      <label>
        {meta.label}
        <Tooltip title={meta.note || '暂无说明'}>
          <InfoCircleOutlined aria-hidden="true" />
        </Tooltip>
        {overridden && <Tag color="blue" className="param-tag">已调</Tag>}
        {changed && <Tag color="orange" className="param-tag">未保存</Tag>}
      </label>
      <InputNumber
        aria-label={meta.label} style={{ width: '100%' }}
        value={value == null ? null : Number(value)}
        min={meta.min} max={meta.max} step={stepOf(meta)}
        onChange={onChange}
      />
      <small className="muted">
        {meta.key} · 取值 {meta.min}~{meta.max}{meta.note ? ' · ' + meta.note : ''}
      </small>
    </div>
  );
}

/**
 * 推理参数配置。默认值在 catalogs/inference_params.json，页面上的改动作为「覆盖层」存库：
 * 升级默认值不会抹掉这里的调参，恢复默认也随时可回。
 */
export default function InferenceParamsPage() {
  const { message } = AntApp.useApp();
  const [state, setState] = useState<Obj | null>(null);
  const [draft, setDraft] = useState<Obj>({});
  const [keyword, setKeyword] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      setState(await api('/inference/params'));
      setDraft({});
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const effective: Obj = state?.effective ?? {};
  const overrides: Obj = state?.overrides ?? {};
  const groups: Obj[] = state?.schema?.groups ?? [];
  const tables: Obj[] = state?.schema?.tables ?? [];
  const pending = useMemo(() => {
    let count = 0;
    const walk = (node: Obj) => Object.values(node).forEach(v => {
      if (v && typeof v === 'object') walk(v as Obj); else count += 1;
    });
    walk(draft);
    return count;
  }, [draft]);

  function current(group: string, field: string, scope?: string) {
    const node = draft[group];
    const picked = scope ? node?.[scope]?.[field] : node?.[field];
    if (picked !== undefined) return picked;
    return scope ? effective[group]?.[scope]?.[field] : effective[group]?.[field];
  }
  function overridden(group: string, field: string, scope?: string) {
    return scope ? overrides[group]?.[scope]?.[field] !== undefined : overrides[group]?.[field] !== undefined;
  }
  function changed(group: string, field: string, scope?: string) {
    const node = draft[group];
    const picked = scope ? node?.[scope]?.[field] : node?.[field];
    return picked !== undefined && picked !== (scope ? effective[group]?.[scope]?.[field] : effective[group]?.[field]);
  }
  function setValue(group: string, field: string, value: number | null, scope?: string) {
    setDraft(old => {
      const next = structuredClone(old);
      if (scope) {
        next[group] ||= {};
        next[group][scope] ||= {};
        next[group][scope][field] = value;
      } else {
        next[group] ||= {};
        next[group][field] = value;
      }
      return next;
    });
  }

  const match = (meta: Obj) => !keyword.trim()
    || [meta.label, meta.key, meta.note].some(t => String(t || '').includes(keyword.trim()));

  async function save() {
    if (!pending) { message.info('没有待保存的改动'); return; }
    setSaving(true);
    try {
      setState(await api('/inference/params', 'PUT', { overrides: draft }));
      setDraft({});
      message.success('参数已生效；之后的测算都按新值计算，历史测算不受影响');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    try {
      setState(await api('/inference/params/reset', 'POST', {}));
      setDraft({});
      message.success('已恢复为默认参数');
    } catch (error) {
      message.error((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  if (loading && !state) return <div className="center" style={{ padding: 60 }}><Spin /></div>;
  if (!state) return <Card><Empty description="参数未能加载" /></Card>;

  const items = [
    ...groups.map(group => ({
      key: group.key,
      label: group.label + '（' + (group.fields as Obj[]).length + '）',
      children: (
        <div className="param-grid">
          {(group.fields as Obj[]).filter(match).map((meta: Obj) => (
            <Field key={meta.key} meta={meta}
              value={current(group.key, meta.key)}
              overridden={overridden(group.key, meta.key)}
              changed={changed(group.key, meta.key)}
              onChange={v => setValue(group.key, meta.key, v)} />
          ))}
        </div>
      ),
    })),
    ...tables.map(table => ({
      key: table.key,
      label: table.label,
      children: (
        <div className="param-table-groups">
          <p className="muted">{table.note}</p>
          {(effective[table.key] ? Object.keys(effective[table.key]) : []).map(scope => (
            <Card key={scope} size="small" title={<Space>
              <Tag color="blue">{scope}</Tag>
              {effective[table.key]?.[scope]?.label && <span>{effective[table.key][scope].label}</span>}
            </Space>} className="below">
              <div className="param-grid">
                {(table.fields as Obj[]).filter(match).map((meta: Obj) => (
                  <Field key={meta.key} meta={{ ...meta, key: scope + '.' + meta.key }}
                    value={current(table.key, meta.key, scope)}
                    overridden={overridden(table.key, meta.key, scope)}
                    changed={changed(table.key, meta.key, scope)}
                    onChange={v => setValue(table.key, meta.key, v, scope)} />
                ))}
              </div>
            </Card>
          ))}
        </div>
      ),
    })),
  ];

  return <>
    <Card
      title={<span>推理参数 <Tag>版本 {state.defaults_version}</Tag>
        {state.has_overrides && <Tag color="blue">已调 {Object.keys(state.overrides || {}).length} 组</Tag>}</span>}
      extra={<Space>
        <Input.Search allowClear style={{ width: 220 }} placeholder="按名称或字段检索"
          value={keyword} onChange={e => setKeyword(e.target.value)} />
        <Button icon={<UndoOutlined aria-hidden="true" />} disabled={!pending} onClick={() => setDraft({})}>撤销改动</Button>
        <Button icon={<SaveOutlined aria-hidden="true" />} type="primary" loading={saving} onClick={() => void save()}>
          保存并生效{pending ? `（${pending}）` : ''}
        </Button>
        <Button icon={<ReloadOutlined aria-hidden="true" />} danger onClick={() => void reset()}>恢复默认</Button>
      </Space>}
    >
      <Alert type="info" showIcon message="这些是估算过程中的经验系数与常数项，不是硬件规格。"
        description="默认值随版本发布在参数文件里；本页改动作为覆盖层单独保存，升级默认值不会覆盖你的调整，恢复默认也随时可回。修改后对之后的测算生效，已保存的历史测算保持原样。" />
      <div className="note-line" style={{ marginTop: 12 }}>
        <InfoCircleOutlined aria-hidden="true" />
        芯片算力、显存与带宽属于硬件规格，不在本页；换硬件请改用「算力服务器」清单。
        默认值更新于 {state.defaults_updated || '—'}。
      </div>
      {(state.notes as string[] || []).length > 0 && (
        <Collapse className="below" items={[{
          key: 'notes', label: '参数口径说明',
          children: <ul style={{ margin: 0, paddingLeft: 18 }}>
            {(state.notes as string[]).map(n => <li key={n}>{n}</li>)}
          </ul>,
        }]} />
      )}
      <Tabs className="below" items={items} />
    </Card>
  </>;
}
