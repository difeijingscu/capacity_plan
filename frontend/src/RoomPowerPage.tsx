import EmbedFrame from './EmbedFrame';

/**
 * 机房供电页：嵌入「3D 供电路径」独立工具页（frontend/public/room-power/index.html）。
 *
 * 内容迁移自 AI DC 场景的 ai-dc-power 页面（从电网到 AI 服务器机柜的完整 3D 供电
 * 链路：降压、中压 ATS 联锁、变压器、UPS、电池与柴油发电机，支持正常/停电切换、
 * 能源区/机房区视角与电压标注），已本地化：中文单语言、固定浅色主题、套用项目墨绿
 * 配色；three.js 复用 /room-3d/vendor/ 本地依赖。
 * 视口型 3D 应用（内部相机交互），iframe 按「视口高度 − 页头占位」撑满，无高度上报。
 */

const IFRAME_SRC = '/room-power/index.html';

export default function RoomPowerPage() {
  return (
    <div className="placeholder-page">
      <div className="room-power-frame">
        <EmbedFrame
          src={IFRAME_SRC}
          title="机房供电"
          testId="room-power-embed"
          viewport
        />
      </div>
    </div>
  );
}
