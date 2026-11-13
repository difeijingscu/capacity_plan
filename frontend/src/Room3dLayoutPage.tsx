import { Card, Tag } from 'antd';

/**
 * 机房布局 → 机房立体布局。
 * 内容迁移自 AI DC 场景的「机房布局（立体）」Three.js 交互页（ai-dc-room-layout-3d），
 * 已本地化为 frontend/public/room-3d/（three.js 落地到 vendor/ 目录、中文单语言、
 * 固定浅色主题并套用项目墨绿配色），与主应用以同源 iframe 集成。
 *
 * 与推理评估页不同，本页为视口型 3D 应用（内部滚动 / 自适应相机），
 * 不需要 postMessage 高度上报，容器按视口高度撑满即可。
 */

const IFRAME_SRC = '/room-3d/index.html';

export default function Room3dLayoutPage() {
  return (
    <div className="placeholder-page">
      <Card className="pool-intro">
        <div>
          <span className="eyebrow">DATA CENTER 3D</span>
          <h2>机房立体布局</h2>
          <p>可交互三维机房布局：园区总览 → A02 数据中心楼 → 各层详细机房，逐级下钻查看。</p>
        </div>
        <Tag color="green">交互式 3D 示意</Tag>
      </Card>
      <div className="room-3d-frame">
        <iframe
          src={IFRAME_SRC}
          title="机房立体布局"
          data-testid="room-3d-embed"
        />
      </div>
    </div>
  );
}
