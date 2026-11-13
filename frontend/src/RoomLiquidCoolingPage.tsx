import EmbedFrame from './EmbedFrame';

/**
 * 机房液冷层高承重页：嵌入「Liquid Cooling · Building Requirements」独立内容页
 * （frontend/public/room-liquid-cooling/index.html）。
 *
 * 内容迁移自 AI DC 场景的 ai-dc-liquid-requirements 页面（机房剖面示意图：当前代际
 * 与未来演进的层高、楼板承重、桥架/管路空间分层要求），已本地化：中文单语言、
 * 固定浅色主题、套用项目墨绿配色。
 * 以同源 iframe 集成避免样式污染；内嵌页通过 postMessage 上报内容高度，容器自适应。
 */

const IFRAME_SRC = '/room-liquid-cooling/index.html';

export default function RoomLiquidCoolingPage() {
  return (
    <div className="room-liquid-cooling-embed">
      <EmbedFrame
        src={IFRAME_SRC}
        title="机房液冷层高承重"
        testId="room-liquid-cooling-embed"
        messageType="room-liquid-cooling-height"
      />
    </div>
  );
}
