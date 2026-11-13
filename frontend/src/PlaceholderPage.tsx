import { Card, Empty } from 'antd';
import type { ReactNode } from 'react';

/**
 * 占位页面：机房布局 / 机柜布局 / ROI 分析等后续提供内容的页面。
 * 由侧栏路由直接传入标题与说明，避免为每个空页面单独建文件。
 * 页面标题由外层 page-heading 的 h1 承担，这里不再重复，避免同屏两个同名标题。
 */
export default function PlaceholderPage({ title, note, eyebrow = 'COMING SOON' }: {
  title: string; note?: ReactNode; eyebrow?: string;
}) {
  return (
    <div className="placeholder-page">
      <Card className="pool-intro">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h3>本页内容建设中</h3>
          <p>{note || '本页内容尚待补充，先保留入口位置。'}</p>
        </div>
      </Card>
      <Card className="below">
        <Empty description={'「' + title + '」内容待补充'} />
        <p className="muted" style={{ textAlign: 'center', marginTop: 8 }}>
          页面已接入侧栏路由，后续提供具体内容与计算逻辑时可直接在本页实现。
        </p>
      </Card>
    </div>
  );
}
