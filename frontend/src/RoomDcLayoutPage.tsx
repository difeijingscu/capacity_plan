import { useEffect, useRef, useState } from 'react';
import { Card, Tag } from 'antd';

/**
 * 机房布局 → 数据中心布局示意图。
 * 内容迁移自 AI DC 场景的「四层数据中心示意图」与「单层详细平面图」两块示意，
 * 按本项目风格重排（antd Card + 主题色）；图形口径与原示意保持一致，仅作风格适配。
 */

// —— 四层等轴测示意（几何与配色沿用原示意） ——
type ZoneStyle = { label: string; fill: string; stroke: string; text: string; dash?: string };
const ZONES: Record<string, ZoneStyle> = {
  hvac: { label: '制冷', fill: '#e0f2fe', stroke: '#0284c7', text: '#0369a1' },
  server: { label: '机房', fill: '#e2e8f0', stroke: '#475569', text: '#334155' },
  electrical: { label: '配电', fill: '#fef3c7', stroke: '#d97706', text: '#92400e' },
  hydraulic: { label: '水力', fill: '#ccfbf1', stroke: '#0d9488', text: '#115e59' },
  battery: { label: '电池', fill: '#ede9fe', stroke: '#7c3aed', text: '#5b21b6' },
  cooling: { label: '冷却塔', fill: '#dbeafe', stroke: '#2563eb', text: '#1d4ed8' },
  tbd: { label: '待定', fill: '#f8fafc', stroke: '#94a3b8', text: '#64748b', dash: '6 4' },
};

type Pt = { x: number; y: number };
const ISO = { ox: 280, oy: 720, sx: 92, sy: 53, zStep: 138 };
const W = 2;
const D = 1.1;
const iso = (x: number, y: number, z: number): Pt => ({ x: ISO.ox + (x - y) * ISO.sx, y: ISO.oy - z * ISO.zStep + (x + y) * ISO.sy });
const poly = (pts: Pt[]) => pts.map(p => p.x + ',' + p.y).join(' ');
const centroid = (pts: Pt[]) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });
const edgeAngle = (p1: Pt, p2: Pt) => { let deg = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI; if (deg > 90) deg -= 180; if (deg < -90) deg += 180; return deg; };
const edgeLength = (p1: Pt, p2: Pt) => Math.hypot(p2.x - p1.x, p2.y - p1.y);
const zonePolygon = (z: number, x0: number, y0: number, w: number, h: number): Pt[] => [iso(x0, y0, z), iso(x0 + w, y0, z), iso(x0 + w, y0 + h, z), iso(x0, y0 + h, z)];

type ZoneCell = { t: string; w?: number; u?: boolean };
const STANDARD_FLOOR_ROWS: ZoneCell[][] = [
  [{ t: 'hvac' }, { t: 'hvac' }],
  [{ t: 'server' }, { t: 'server' }],
  [{ t: 'electrical' }, { t: 'electrical', w: 0.5 }, { t: 'hydraulic', w: 0.5 }],
  [{ t: 'server' }, { t: 'server' }],
  [{ t: 'hvac' }, { t: 'hvac' }],
];
const floors: { id: string; label: string; z: number; gapLabel: string | null; rows: (ZoneCell | null)[][] }[] = [
  { id: '1f', label: '1F', z: 0, gapLabel: '8.0 m', rows: STANDARD_FLOOR_ROWS },
  { id: '2f', label: '2F', z: 1, gapLabel: '7.0 m', rows: STANDARD_FLOOR_ROWS },
  { id: '3f', label: '3F', z: 2, gapLabel: '7.0 m', rows: STANDARD_FLOOR_ROWS },
  {
    id: 'rf', label: 'RF', z: 3, gapLabel: null,
    rows: [[{ t: 'battery', w: 1 }, null], [{ t: 'cooling' }, { t: 'cooling' }], [{ t: 'battery', w: 1 }, null]],
  },
];

type OutlineEl = { points: string };
type ZoneEl = { points: string; fill: string; stroke: string; dash?: string };
type LabelEl = { x: number; y: number; angle: number; lines: string[]; color: string; size: number; lineHeight: number };
type FloorLabelEl = { x: number; y: number; text: string };
type DimEl = { x: number; y1: number; y2: number; ticks: number[]; label: string };

// 图形为静态示意，构建一次即可
const fourLayerLayout = (() => {
  const outlines: OutlineEl[] = [];
  const zones: ZoneEl[] = [];
  const labels: LabelEl[] = [];
  const floorLabels: FloorLabelEl[] = [];
  const dims: DimEl[] = [];

  floors.forEach((floor) => {
    outlines.push({ points: poly([iso(0, 0, floor.z), iso(W, 0, floor.z), iso(W, D, floor.z), iso(0, D, floor.z)]) });

    const rowCount = floor.rows.length;
    floor.rows.forEach((row, ri) => {
      const y0 = (ri / rowCount) * D;
      const rh = D / rowCount;
      let xCursor = 0;
      row.forEach((cell) => {
        if (!cell) return;
        const cw = (cell.w || 0.5) * W;
        if (xCursor + cw > W + 0.001) return;
        const pts = zonePolygon(floor.z, xCursor + 0.03, y0 + 0.03, cw - 0.06, rh - 0.06);
        const style = ZONES[cell.u ? 'tbd' : cell.t] || ZONES.tbd;
        zones.push({ points: poly(pts), fill: style.fill, stroke: style.stroke, dash: style.dash });

        const c = centroid(pts);
        const widthEdge = edgeLength(pts[0], pts[1]);
        const depthEdge = edgeLength(pts[0], pts[3]);
        const alongWidth = widthEdge >= depthEdge;
        const angle = alongWidth ? edgeAngle(pts[0], pts[1]) : edgeAngle(pts[0], pts[3]);
        const span = alongWidth ? widthEdge : depthEdge;
        const size = Math.min(Math.max(7, span * 0.085), 11);
        labels.push({ x: c.x, y: c.y, angle, lines: [style.label + (cell.u ? '?' : '')], color: style.text, size, lineHeight: size * 1.1 });
        xCursor += cw;
      });
    });

    const pt = iso(-0.18, D * 0.5, floor.z);
    floorLabels.push({ x: pt.x - 10, y: pt.y, text: floor.label });

    if (floor.gapLabel) {
      const xDim = ISO.ox + (W - D) * ISO.sx + 120;
      const lower = iso(W + 0.08, D * 0.5, floor.z);
      const upper = iso(W + 0.08, D * 0.5, floor.z + 1);
      dims.push({ x: xDim, y1: lower.y, y2: upper.y, ticks: [lower.y, upper.y], label: floor.gapLabel });
    }
  });

  return { outlines, zones, labels, floorLabels, dims };
})();

function FourLayerDiagram() {
  const svgRef = useRef<SVGSVGElement>(null);
  const floorRef = useRef<SVGGElement>(null);
  const dimRef = useRef<SVGGElement>(null);
  const [vb, setVb] = useState('0 0 1000 820');

  // 与原示意一致：按渲染后的实际包围盒自适应 viewBox，再整体放大 1.32 倍
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const fit = () => {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, hasBounds = false;
      [floorRef.current, dimRef.current].forEach((group) => {
        if (!group) return;
        try {
          const b = group.getBBox();
          if (!Number.isFinite(b.x) || !Number.isFinite(b.y) || !(b.width > 0) || !(b.height > 0)) return;
          minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
          maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
          hasBounds = true;
        } catch { /* 空分组 */ }
      });
      if (!hasBounds) return;
      const pad = 90;
      minX -= pad; minY -= pad; maxX += pad; maxY += pad;
      const contentW = maxX - minX, contentH = maxY - minY;
      if (!(contentW > 0) || !(contentH > 0)) return;
      const cw = svg.clientWidth || 1000, ch = svg.clientHeight || 820;
      if (!(cw > 0) || !(ch > 0)) return;
      const scale = Math.min(cw / contentW, ch / contentH);
      if (!(scale > 0) || !Number.isFinite(scale)) return;
      const vbW = cw / scale / 1.32, vbH = ch / scale / 1.32;
      if (!Number.isFinite(vbW) || !Number.isFinite(vbH) || !(vbW > 0) || !(vbH > 0)) return;
      setVb(`${(minX + maxX) / 2 - vbW / 2} ${(minY + maxY) / 2 - vbH / 2} ${vbW} ${vbH}`);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  return (
    <svg ref={svgRef} className="dc-four-layer-svg" viewBox={vb} preserveAspectRatio="xMidYMid meet" role="img" aria-label="四层数据中心结构示意">
      <g ref={dimRef} fill="#64748b" fontSize={15}>
        {fourLayerLayout.dims.map((d, i) => (
          <g key={i}>
            <line x1={d.x} y1={d.y1} x2={d.x} y2={d.y2} stroke="#64748b" strokeWidth={1.5} />
            {d.ticks.map((y, j) => <line key={j} x1={d.x - 10} y1={y} x2={d.x + 10} y2={y} stroke="#64748b" />)}
            <text x={d.x + 16} y={(d.y1 + d.y2) / 2 + 5}>{d.label}</text>
          </g>
        ))}
      </g>
      <g ref={floorRef}>
        {fourLayerLayout.outlines.map((o, i) => (
          <polygon key={i} points={o.points} fill="rgba(255,255,255,0.55)" stroke="#cbd5e1" strokeWidth={1.5} />
        ))}
        {fourLayerLayout.zones.map((z, i) => (
          <polygon key={i} points={z.points} fill={z.fill} stroke={z.stroke} strokeWidth={1.5} strokeDasharray={z.dash || undefined} />
        ))}
        {fourLayerLayout.labels.map((l, i) => (
          <text key={i} transform={`translate(${l.x},${l.y}) rotate(${l.angle})`} textAnchor="middle" dominantBaseline="middle" fill={l.color} fontSize={l.size} fontWeight={600}>
            {l.lines.map((line, j) => <tspan key={j} x={0} y={(j - (l.lines.length - 1) / 2) * l.lineHeight}>{line}</tspan>)}
          </text>
        ))}
        {fourLayerLayout.floorLabels.map((f, i) => (
          <text key={i} x={f.x} y={f.y} textAnchor="end" dominantBaseline="middle" fill="#223b35" fontSize={18} fontWeight={700}>{f.text}</text>
        ))}
      </g>
    </svg>
  );
}

// —— 单层详细平面图（133m × 92m，静态示意） ——
function FloorDetailDiagram() {
  return (
    <svg viewBox="50 12 1215 962" preserveAspectRatio="xMidYMid meet" className="dc-floor-plan-svg" role="img" aria-label="单层数据中心详细平面图">
      <defs>
        <marker id="dc-arrow" markerWidth={10} markerHeight={10} refX={5} refY={5} orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#7b8b75" />
        </marker>
        <linearGradient id="dc-paper" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="100%" stopColor="#f5f7f4" />
        </linearGradient>
      </defs>

      {/* 建筑边界 */}
      <rect x={170} y={95} width={1080} height={780} rx={10} fill="url(#dc-paper)" stroke="#223b35" strokeWidth={3} />

      {/* 两侧辅助条带（左右对称） */}
      <rect x={185} y={120} width={26} height={190} className="dcl-zone" fill="#f8fafc" stroke="#94a3b8" />
      <rect x={185} y={405} width={26} height={147} className="dcl-zone" fill="#f8fafc" stroke="#94a3b8" />
      <rect x={185} y={650} width={26} height={205} className="dcl-zone" fill="#f8fafc" stroke="#94a3b8" />
      <rect x={1209} y={120} width={26} height={190} className="dcl-zone" fill="#f8fafc" stroke="#94a3b8" />
      <rect x={1209} y={405} width={26} height={147} className="dcl-zone" fill="#f8fafc" stroke="#94a3b8" />
      <rect x={1209} y={650} width={26} height={205} className="dcl-zone" fill="#f8fafc" stroke="#94a3b8" />

      <g transform="translate(710 485) scale(1.154761905 1.059782609) translate(-720 -488)">
        {/* 左上模块 */}
        <rect x={300} y={120} width={395} height={105.3} className="dcl-zone" fill="#e0f2fe" stroke="#0284c7" />
        <text x={497.5} y={165} textAnchor="middle" className="dcl-label" fontSize={22}>
          <tspan x={497.5} dy={0}>EHU 空调机房</tspan>
          <tspan x={497.5} dy={26} className="dcl-sub" fontSize={18}>750平方米</tspan>
        </text>
        <rect x={300} y={225.3} width={395} height={144.8} className="dcl-zone" fill="#e2e8f0" stroke="#475569" />
        <text x={497.5} y={290} textAnchor="middle" className="dcl-label" fontSize={22}>
          <tspan x={497.5} dy={0}>风冷 / 液冷机房</tspan>
          <tspan x={497.5} dy={26} className="dcl-sub" fontSize={18}>820平方米</tspan>
        </text>

        {/* 右上模块 */}
        <rect x={745} y={120} width={395} height={105.3} className="dcl-zone" fill="#e0f2fe" stroke="#0284c7" />
        <text x={942.5} y={165} textAnchor="middle" className="dcl-label" fontSize={22}>
          <tspan x={942.5} dy={0}>EHU 空调机房</tspan>
          <tspan x={942.5} dy={26} className="dcl-sub" fontSize={18}>750平方米</tspan>
        </text>
        <rect x={745} y={225.3} width={395} height={144.8} className="dcl-zone" fill="#e2e8f0" stroke="#475569" />
        <text x={942.5} y={290} textAnchor="middle" className="dcl-label" fontSize={22}>
          <tspan x={942.5} dy={0}>风冷 / 液冷机房</tspan>
          <tspan x={942.5} dy={26} className="dcl-sub" fontSize={18}>820平方米</tspan>
        </text>

        {/* 中部左侧配套区 */}
        <rect x={300} y={411.1} width={119.6} height={147.4} className="dcl-zone" fill="#ccfbf1" stroke="#0d9488" />
        <text x={359.8} y={472} textAnchor="middle" className="dcl-label" fontSize={20}>
          <tspan x={359.8} dy={0}>液冷</tspan>
          <tspan x={359.8} dy={26}>水力</tspan>
          <tspan x={359.8} dy={26}>模块间</tspan>
        </text>
        <rect x={419.6} y={411.1} width={104.6} height={147.4} className="dcl-zone" fill="#fef3c7" stroke="#d97706" />
        <rect x={524.2} y={411.1} width={104.6} height={147.4} className="dcl-zone" fill="#fef3c7" stroke="#d97706" />
        <text x={524.4} y={452} textAnchor="middle" className="dcl-label" fontSize={18}>
          <tspan x={524.4} dy={0}>配电功能区</tspan>
          <tspan x={524.4} dy={20} className="dcl-sub" fontSize={16}>420平方米</tspan>
        </text>
        <rect x={628.8} y={411.1} width={66.2} height={147.4} className="dcl-zone" fill="#fde68a" stroke="#ca8a04" />
        <text x={661.9} y={492} textAnchor="middle" className="dcl-label" fontSize={20}>
          <tspan x={661.9} dy={0}>中压</tspan>
          <tspan x={661.9} dy={28}>室</tspan>
        </text>

        {/* 中部右侧配套区 */}
        <rect x={745} y={411.1} width={95.6} height={147.4} className="dcl-zone" fill="#fde68a" stroke="#ca8a04" />
        <text x={792.8} y={492} textAnchor="middle" className="dcl-label" fontSize={20}>
          <tspan x={792.8} dy={0}>中压</tspan>
          <tspan x={792.8} dy={28}>室</tspan>
        </text>
        <rect x={840.6} y={411.1} width={89.3} height={147.4} className="dcl-zone" fill="#fef3c7" stroke="#d97706" />
        <text x={885.3} y={492} textAnchor="middle" className="dcl-label" fontSize={20}>
          <tspan x={885.3} dy={0}>低压</tspan>
          <tspan x={885.3} dy={28}>配电</tspan>
        </text>
        <rect x={929.9} y={411.1} width={116.4} height={147.4} className="dcl-zone" fill="#f8fafc" stroke="#94a3b8" />
        <text x={988.1} y={498} textAnchor="middle" className="dcl-sub" fontSize={18}>预留</text>
        <rect x={1046.3} y={411.1} width={93.7} height={147.4} className="dcl-zone" fill="#ccfbf1" stroke="#0d9488" />
        <text x={1093.2} y={472} textAnchor="middle" className="dcl-label" fontSize={20}>
          <tspan x={1093.2} dy={0}>液冷</tspan>
          <tspan x={1093.2} dy={26}>水力</tspan>
          <tspan x={1093.2} dy={26}>模块间</tspan>
        </text>

        {/* 左下模块 */}
        <rect x={300} y={598.4} width={395} height={135.8} className="dcl-zone" fill="#e2e8f0" stroke="#475569" />
        <text x={497.5} y={658} textAnchor="middle" className="dcl-label" fontSize={22}>
          <tspan x={497.5} dy={0}>风冷 / 液冷机房</tspan>
          <tspan x={497.5} dy={26} className="dcl-sub" fontSize={18}>820平方米</tspan>
        </text>
        <rect x={300} y={734.2} width={395} height={121.8} className="dcl-zone" fill="#e0f2fe" stroke="#0284c7" />
        <text x={497.5} y={787} textAnchor="middle" className="dcl-label" fontSize={22}>
          <tspan x={497.5} dy={0}>EHU 空调机房</tspan>
          <tspan x={497.5} dy={26} className="dcl-sub" fontSize={18}>750平方米</tspan>
        </text>

        {/* 右下模块 */}
        <rect x={745} y={598.4} width={395} height={135.8} className="dcl-zone" fill="#e2e8f0" stroke="#475569" />
        <text x={942.5} y={658} textAnchor="middle" className="dcl-label" fontSize={22}>
          <tspan x={942.5} dy={0}>风冷 / 液冷机房</tspan>
          <tspan x={942.5} dy={26} className="dcl-sub" fontSize={18}>820平方米</tspan>
        </text>
        <rect x={745} y={734.2} width={395} height={121.8} className="dcl-zone" fill="#e0f2fe" stroke="#0284c7" />
        <text x={942.5} y={787} textAnchor="middle" className="dcl-label" fontSize={22}>
          <tspan x={942.5} dy={0}>EHU 空调机房</tspan>
          <tspan x={942.5} dy={26} className="dcl-sub" fontSize={18}>750平方米</tspan>
        </text>

        {/* 通道与分隔 */}
        <line x1={720} y1={105} x2={720} y2={875} stroke="#223b35" strokeWidth={2} strokeDasharray="8 8" opacity={0.38} />
        <line x1={300} y1={370.1} x2={695} y2={370.1} stroke="#223b35" strokeWidth={2} opacity={0.65} />
        <line x1={745} y1={370.1} x2={1140} y2={370.1} stroke="#223b35" strokeWidth={2} opacity={0.65} />
        <line x1={300} y1={558.5} x2={695} y2={558.5} stroke="#223b35" strokeWidth={2} opacity={0.65} />
        <line x1={745} y1={558.5} x2={1140} y2={558.5} stroke="#223b35" strokeWidth={2} opacity={0.65} />

        {/* POD 边界：左上 IT 模块 + 配电条带上半 */}
        <rect x={292} y={112} width={411} height={373} rx={6} className="dcl-pod-outline" />
        <g aria-label="POD">
          <rect x={300} y={120} width={76} height={34} rx={7} className="dcl-pod-bg" />
          <text x={338} y={143} textAnchor="middle" className="dcl-pod-text" fontSize={22}>POD</text>
        </g>
      </g>

      {/* 尺寸标注 */}
      <line x1={170} y1={62} x2={1250} y2={62} className="dcl-dim" markerStart="url(#dc-arrow)" markerEnd="url(#dc-arrow)" />
      <line x1={170} y1={74} x2={170} y2={95} className="dcl-dim" />
      <line x1={1250} y1={74} x2={1250} y2={95} className="dcl-dim" />
      <text x={710} y={45} textAnchor="middle" className="dcl-dim-text" fontSize={24}>133m</text>

      <line x1={122} y1={95} x2={122} y2={875} className="dcl-dim" markerStart="url(#dc-arrow)" markerEnd="url(#dc-arrow)" />
      <line x1={140} y1={95} x2={170} y2={95} className="dcl-dim" />
      <line x1={140} y1={875} x2={170} y2={875} className="dcl-dim" />
      <text x={88} y={500} textAnchor="middle" className="dcl-dim-text" fontSize={24} transform="rotate(-90 88 500)">92m</text>

      {/* 图例 */}
      <g transform="translate(170 905)">
        <rect x={0} y={0} width={1080} height={48} rx={14} fill="#ffffff" stroke="#e1e7df" />
        <g transform="translate(24 15)">
          <rect width={18} height={18} rx={4} fill="#e0f2fe" stroke="#0284c7" />
          <text x={28} y={14} className="dcl-sub" fontSize={14}>EHU 空调机房</text>
        </g>
        <g transform="translate(190 15)">
          <rect width={18} height={18} rx={4} fill="#e2e8f0" stroke="#475569" />
          <text x={28} y={14} className="dcl-sub" fontSize={14}>风冷 / 液冷机房</text>
        </g>
        <g transform="translate(390 15)">
          <rect width={18} height={18} rx={4} fill="#fef3c7" stroke="#d97706" />
          <text x={28} y={14} className="dcl-sub" fontSize={14}>低压配电</text>
        </g>
        <g transform="translate(530 15)">
          <rect width={18} height={18} rx={4} fill="#fde68a" stroke="#ca8a04" />
          <text x={28} y={14} className="dcl-sub" fontSize={14}>中压室</text>
        </g>
        <g transform="translate(650 15)">
          <rect width={18} height={18} rx={4} fill="#ccfbf1" stroke="#0d9488" />
          <text x={28} y={14} className="dcl-sub" fontSize={14}>水力模块间</text>
        </g>
        <g transform="translate(790 15)">
          <rect width={18} height={18} rx={4} fill="none" stroke="#dc2626" strokeWidth={2} strokeDasharray="4 3" />
          <text x={28} y={14} className="dcl-sub" fontSize={14}>POD</text>
        </g>
        <text x={1010} y={31} textAnchor="end" className="dcl-sub" fontSize={13}>示意图 · 非施工图</text>
      </g>
    </svg>
  );
}

export default function RoomDcLayoutPage() {
  return (
    <div className="placeholder-page">
      <Card className="pool-intro">
        <div>
          <span className="eyebrow">DATA CENTER LAYOUT</span>
          <h2>数据中心布局示意图</h2>
          <p>四层数据中心结构与单层平面分区示意：区域划分、通道走向与制冷形式。</p>
        </div>
        <Tag color="green">示意图 · 非施工图</Tag>
      </Card>

      <div className="dc-layout-grid">
        <Card title="四层数据中心示意图" extra={<Tag>1F–3F + RF · 层高 8.0 / 7.0 / 7.0 m</Tag>}>
          <FourLayerDiagram />
          <small className="muted">按功能分区着色：制冷、机房、配电、水力模块、电池与冷却塔；虚线为待定区域。</small>
        </Card>
        <Card title="单层详细平面图" extra={<Tag>133m × 92m</Tag>}>
          <FloorDetailDiagram />
          <small className="muted">根据手绘草图整理为结构化示意图，非施工比例图；房间名称与尺寸按图中可识别信息保留。</small>
        </Card>
      </div>

      <Card title="POD 布局说明" className="below">
        <ol className="pod-notes-list">
          <li>每栋DC，三层，每层4个POD，共计12个POD；</li>
          <li>每个POD，8个微模块，每个微模块40个机柜，总计320个机柜；</li>
        </ol>
        <p className="note-line">
          备注：POD（Performance Optimization DataCenter）：包含供电、暖通、IT机房、柴发等完整功能。
        </p>
      </Card>
    </div>
  );
}
