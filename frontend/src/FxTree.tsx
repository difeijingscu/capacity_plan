import { useMemo, useState } from 'react';
import { Tooltip } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import type { Obj } from './api';

/**
 * 杜邦式计算过程树：总卡数 → A/B/C 约束 → 因子 → 原始参数。
 * 数据来自后端引擎 evaluate() 输出的 tree（随 trace.detail 下发），
 * 节点 = { label, relation(关系式), expr(代入), value(数值), note(来源), tag, highlight, children[] }。
 * 渲染口径与推理评估页一致：根 → A/B/C 三栏并排，分支内部纵向逐层展开，
 * 初始只展开第一层（根 + A/B/C 三张卡片），点卡片逐层下钻。
 */

const BRANCH_CLASS = ['a', 'b', 'c'];

/** 关键变量复用路径：同一输入被两条链路同时引用（与推理评估页 FX_REUSE 一致）。 */
const FX_REUSE: { k: string; br: string; cls: string; to: [string, string][] }[] = [
  { k: '并发数', br: '共用', cls: 's', to: [['稳态到达率 λ', 'B1'], ['KV 需求', 'A2']] },
  { k: '单卡可用显存', br: 'A', cls: 'a', to: [['权重装载宽度', 'A1'], ['每副本 KV 房间', 'A2']] },
  { k: '模型权重', br: 'A', cls: 'a', to: [['权重装载宽度', 'A1'], ['每副本 KV 房间', 'A2']] },
  { k: '权重装载宽度', br: 'A', cls: 'a', to: [['A 显存约束卡数', 'A'], ['每副本 KV 房间', 'A2']] },
  { k: '输入长度', br: '共用', cls: 's', to: [['连续批均长', 'A2'], ['单请求 Prefill FLOPs', 'B1']] },
  { k: 'TTFT 目标', br: 'B', cls: 'b', to: [['稳态到达率 λ', 'B1'], ['时延下限 N2', 'B2']] },
  { k: '每 token KV', br: '共用', cls: 's', to: [['KV 需求', 'A2'], ['批量 KV 读取', 'C1']] },
  { k: '分片宽度', br: 'C', cls: 'c', to: [['单步计算时间', 'C1'], ['TP 通信开销', 'C1']] },
];

function collectPaths(node: Obj, path: string, depth: number, out: Set<string>) {
  if (depth >= 1 && node.children?.length) out.add(path);
  (node.children || []).forEach((c: Obj, i: number) => collectPaths(c, path + '.' + i, depth + 1, out));
}

function FxCard({ node, path, level, branch, folded, onToggle }: {
  node: Obj; path: string; level: number; branch: string;
  folded: Set<string>; onToggle: (path: string) => void;
}) {
  const kids: Obj[] = node.children || [];
  const hasKids = kids.length > 0;
  const isFolded = folded.has(path);
  // 分支着色：第一层按 A/B/C 分派，深层继承
  const br = level === 1 ? (BRANCH_CLASS[Number(path.split('.')[1])] || branch) : branch;
  const type = level === 0 ? 'root' : hasKids ? br : 'leaf';
  return (
    <div className={'fx2-node' + (hasKids ? ' has-kids' : '') + (isFolded ? ' folded' : '')}>
      <div className={'fx2-card t-' + type + (hasKids ? ' has-kids' : '')}
        role={hasKids ? 'button' : undefined} tabIndex={hasKids ? 0 : undefined}
        onClick={() => hasKids && onToggle(path)}
        onKeyDown={e => { if (hasKids && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onToggle(path); } }}>
        <div className="hd">
          {hasKids && <span className="tw">{isFolded ? '▸' : '▾'}</span>}
          <span className="nm">{node.label}</span>
          {node.note ? <Tooltip title={'来源：' + node.note}><InfoCircleOutlined className="fx2-info" /></Tooltip> : null}
          {node.highlight ? <span className="fx2-pill hi">主导</span> : node.tag ? <span className="fx2-pill">{node.tag}</span> : null}
        </div>
        {node.relation ? <div className="fm">{node.relation}</div> : null}
        {node.expr ? <div className="sb">{node.expr}</div> : null}
        <div className="rs">{node.value}</div>
        {hasKids && isFolded ? <div className="fx2-more">⊞ 下级 {kids.length} 项 · 点击展开</div> : null}
      </div>
      {hasKids && !isFolded && (
        <div className="fx2-kids">
          {kids.map((c, i) => (
            <FxCard key={path + '.' + i} node={c} path={path + '.' + i} level={level + 1}
              branch={br} folded={folded} onToggle={onToggle} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FxTree({ tree }: { tree: Obj | null | undefined }) {
  // 默认只展开第一层：折叠所有「非根且有下级」的节点（与页面 fxFoldDeep 一致）
  const defaultFolded = useMemo(() => {
    const out = new Set<string>();
    if (tree) collectPaths(tree, 'r', 0, out);
    return out;
  }, [tree]);
  const [folded, setFolded] = useState<Set<string>>(defaultFolded);

  if (!tree) return null;
  const toggle = (path: string) => setFolded(prev => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path); else next.add(path);
    return next;
  });
  const expandAll = () => setFolded(new Set());
  const topOnly = () => setFolded(defaultFolded);

  const kids: Obj[] = tree.children || [];
  return (
    <div className="fx-block">
      <div className="fx-t">
        <span>计算过程 · 杜邦式逐层拆解</span>
        <span className="fx-lgs">
          <span><i className="l-root" />根</span><span><i className="l-a" />A 显存</span>
          <span><i className="l-b" />B Prefill</span><span><i className="l-c" />C Decode</span>
          <span><i className="l-leaf" />叶子参数</span>
        </span>
        <span className="fx-ctrl">
          <button type="button" onClick={expandAll}>全部展开</button>
          <button type="button" onClick={topOnly}>只看 A/B/C</button>
        </span>
      </div>
      <div className="fx2-tree">
        <FxCard node={{ ...tree, children: [] }} path="r" level={0} branch=""
          folded={folded} onToggle={toggle} />
        <div className="fx2-branches">
          {kids.map((c, i) => (
            <div className="fx2-branch" key={i}>
              <FxCard node={c} path={'r.' + i} level={1} branch={BRANCH_CLASS[i] || 'a'}
                folded={folded} onToggle={toggle} />
            </div>
          ))}
        </div>
      </div>
      <div className="fx2-hint">
        <span>⊞ 点卡片逐层展开 / 收起下级 · 初始只展开第一层</span>
      </div>
      <div className="fx2-reuse">
        <div className="fx2-reuse-h">关键变量复用路径<span>同一参数被多条链路引用 · 改动会同时影响两个分支</span></div>
        <div className="fx2-reuse-g">
          {FX_REUSE.map(v => (
            <div className="fx2-var" key={v.k}>
              <div className="fx2-var-h">{v.k}<span className={'br ' + v.cls}>{v.br}</span></div>
              <ul>{v.to.map(t => <li key={t[0]}><span className="ar">↳</span><b>{t[0]}</b><em>{t[1]}</em></li>)}</ul>
            </div>
          ))}
        </div>
      </div>
      <div className="fx2-foot">
        口径：容量按十进制 GB（1 GB = 10⁹ B）；每 token KV 随模型架构与量化档变化。
        最终卡数取 max(A 显存, B Prefill, C Decode) → 奇数补偶；余量在池层统一加成，场景层为最小卡数。
      </div>
    </div>
  );
}
