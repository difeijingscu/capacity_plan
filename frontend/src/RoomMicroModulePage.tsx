import EmbedFrame from './EmbedFrame';

/**
 * 液冷微模块布局页：嵌入「液冷微模块 3D 模拟器」独立工具页
 * （frontend/public/room-micro-module/index.html）。
 *
 * 内容迁移自 AI DC 场景的 ai-dc-liquid-rack 页面（液冷微模块三维布局：机柜/冷板/
 * 分集水器/管路走向，支持视角切换、机柜外壳与水路显隐），已本地化：中文单语言、
 * 固定浅色主题、保留制冷青色系保证工程辨识度；three.js 复用 /room-3d/vendor/ 本地依赖。
 * 视口型 3D 应用（内部相机交互），iframe 按「视口高度 − 页头占位」撑满，无高度上报。
 */

const IFRAME_SRC = '/room-micro-module/index.html';

export default function RoomMicroModulePage() {
  return (
    <div className="placeholder-page">
      <div className="room-micro-module-frame">
        <EmbedFrame
          src={IFRAME_SRC}
          title="液冷微模块布局"
          testId="room-micro-module-embed"
          viewport
        />
      </div>
    </div>
  );
}
