import EmbedFrame from './EmbedFrame';

/**
 * 机柜布局页：嵌入「Card → Power」独立工具页（frontend/public/cabinet-layout/index.html）。
 *
 * 内容迁移自 AI DC 场景的 aidc-layout-Card2Power 页面（由算力卡数推算机柜组成、
 * 设计功率与机房面积，再落到机房平面布局与制冷方案），已本地化：中文单语言、
 * 固定浅色主题、套用项目墨绿配色，去除站点导航与外部依赖。
 * 以同源 iframe 集成避免样式污染；内嵌页通过 postMessage 上报内容高度，
 * 容器自适应（含后端未重启时的 SPA 回落检测，见 EmbedFrame）。
 */

const IFRAME_SRC = '/cabinet-layout/index.html';

export default function CabinetLayoutPage() {
  return (
    <div className="cabinet-embed">
      <EmbedFrame
        src={IFRAME_SRC}
        title="机柜布局"
        testId="cabinet-embed"
        messageType="cabinet-layout-height"
      />
    </div>
  );
}
