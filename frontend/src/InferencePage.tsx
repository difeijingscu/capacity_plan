import { useEffect, useRef, useState } from 'react';

/**
 * 推理评估页：嵌入「场景算力评估」独立页面（frontend/public/inference-eval.html）。
 *
 * 该页面自带完整的样式、预设数据（29 场景 / 32 模型 / 9 卡型）、
 * A/B/C 三约束计算引擎与交互逻辑，属产品组合中的独立工具页。
 * 为避免其样式与主应用的 antd / 全局 CSS 相互污染，以同源 iframe 方式集成；
 * 内嵌页通过 postMessage 上报内容高度，本容器自适应，页面内不再出现双滚动条。
 */

const IFRAME_SRC = '/inference-eval.html';

export default function InferencePage() {
  const [height, setHeight] = useState<number | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; height?: number } | null;
      if (!data || data.type !== 'inference-eval-height' || typeof data.height !== 'number') return;
      const h = Math.max(600, Math.min(100000, Math.ceil(data.height)));
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setHeight(h), 50);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <div className="inference-embed">
      <iframe
        src={IFRAME_SRC}
        title="场景算力评估"
        data-testid="inference-embed"
        style={{ height: height ? height + 'px' : '100vh' }}
        onLoad={() => { /* 高度由内嵌页 postMessage 上报 */ }}
      />
    </div>
  );
}
