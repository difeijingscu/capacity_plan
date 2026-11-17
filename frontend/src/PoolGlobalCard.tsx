import { Card, Select, Tooltip } from 'antd';
import { InfoCircleOutlined } from '@ant-design/icons';
import type { Obj } from './api';
import { chipSelectOptions, chipSpecHint } from './chips';

/**
 * 创新服务 / 开发测试页顶部的「全局配置」：本池算力卡型号。
 *
 * 三池共用同一套算力卡目录（catalogs/inference_chips.json + 自定义卡），
 * 选卡文案走 `chips.ts` 的单一实现，避免页面之间出现两套叫法或重复代码。
 * 这里只影响本池折算卡数，不改动业务场景池的全局值。
 */
export default function PoolGlobalCard({ poolLabel, ariaLabel, chips, value, hint, onChange }: {
  poolLabel: string;
  ariaLabel: string;
  chips: Obj[];
  value?: string | null;
  hint: string;
  onChange: (value: string | null) => void;
}) {
  const chip = chips.find(c => c.key === value);
  return (
    <Card className="below pool-global" size="small">
      <div className="pool-global-head">
        <h3>全局配置</h3>
        <span>本池算力卡对池内全部任务统一生效；改动后按新卡规格重算卡数</span>
      </div>
      <div className="pool-global-grid">
        <div className="field">
          <label>算力卡（{poolLabel}）
            <Tooltip title={hint}>
              <InfoCircleOutlined aria-hidden="true" />
            </Tooltip>
          </label>
          <Select aria-label={ariaLabel} style={{ width: '100%' }} value={value || undefined}
            placeholder="未选择则本池不出卡数" allowClear showSearch optionFilterProp="label"
            options={chipSelectOptions(chips)} onChange={v => onChange(v ?? null)} />
          <div className="pool-chip-hint">{chipSpecHint(chip)}</div>
        </div>
      </div>
    </Card>
  );
}
