import { useEffect, useRef, useState } from 'react';
import { Alert } from 'antd';

/**
 * 同源 iframe 嵌入容器：供「机柜布局 / ROI 分析 / 机房供电 / 机房液冷层高承重」等
 * 独立工具页共用。
 *
 * - 流式页面（viewport=false）：内嵌页通过 postMessage 上报内容高度（消息类型由
 *   messageType 传入），容器自适应高度，页面内不出现双滚动条；
 * - 视口型页面（viewport=true）：3D 应用内部自适配，iframe 按「视口高度 − 页头占位」撑满；
 * - onLoad 后检测 iframe 内是否误加载了主应用 SPA：后端进程未重启（或静态目录未挂载）时，
 *   catch-all 回落会把工具页路径重写到 SPA 的 index.html，表现为「点开却是项目概览」。
 *   检测到该情况时给出明确的重启提示，避免误判为路由问题。
 */
export default function EmbedFrame({ src, title, testId, messageType, viewport = false }: {
  src: string;
  title: string;
  testId: string;
  messageType?: string;
  viewport?: boolean;
}) {
  const [height, setHeight] = useState<number | null>(null);
  const [spaFallback, setSpaFallback] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!messageType) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; height?: number } | null;
      if (!data || data.type !== messageType || typeof data.height !== 'number') return;
      const h = Math.max(600, Math.min(100000, Math.ceil(data.height)));
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setHeight(h), 50);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timerRef.current);
    };
  }, [messageType]);

  const onLoad = () => {
    try {
      const doc = frameRef.current?.contentDocument;
      // 主应用 SPA 的 index.html 以 <div id="root"> 挂载 React；工具页均不使用该 id。
      if (doc && doc.getElementById('root') && !doc.querySelector('.wrap, .theme-head, .page, main')) {
        setSpaFallback(true);
      } else {
        setSpaFallback(false);
      }
    } catch { /* 跨域等异常忽略 */ }
  };

  if (spaFallback) {
    return (
      <Alert
        type="warning"
        showIcon
        message="嵌入页未加载"
        description={'检测到 iframe 内加载的是主应用页面而非工具页。通常是后端服务尚未重启（新增的静态目录挂载未生效）：请退出本工作台（运行 停止.bat）后重新运行 启动.bat，再刷新浏览器。'}
        data-testid={testId + '-fallback'}
      />
    );
  }

  const style = viewport
    ? { height: 'calc(100vh - 285px)', minHeight: '620px' }
    : { height: height ? height + 'px' : '100vh' };

  return (
    <iframe
      ref={frameRef}
      src={src}
      title={title}
      data-testid={testId}
      onLoad={onLoad}
      style={style}
    />
  );
}
