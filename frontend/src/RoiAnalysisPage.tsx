import EmbedFrame from './EmbedFrame';

/**
 * ROI 分析页：嵌入「Investment ROI」独立工具页（frontend/public/roi-analysis/index.html）。
 *
 * 内容迁移自 AI DC 场景的 aidc-investment-roi 页面（AI 数据中心投入产出与回收周期
 * 测算：CAPEX 构成、电费与运维、云上比价、回收周期敏感性），已本地化：中文单语言、
 * 固定浅色主题、套用项目墨绿配色；Tailwind 运行时已本地化（js/tailwind.js），
 * 云比价/默认参数由页内本地配置兜底（无外部 API 依赖）。
 * 以同源 iframe 集成避免样式污染；内嵌页通过 postMessage 上报内容高度，容器自适应。
 */

const IFRAME_SRC = '/roi-analysis/index.html';

export default function RoiAnalysisPage() {
  return (
    <div className="roi-embed">
      <EmbedFrame
        src={IFRAME_SRC}
        title="ROI 分析"
        testId="roi-embed"
        messageType="roi-analysis-height"
      />
    </div>
  );
}
