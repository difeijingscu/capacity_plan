import { test, expect } from '@playwright/test';

/**
 * 基线与设置页的两份全局数据都必须与业务场景页同源：
 * 模型基线库 = 32 条 LLM，参考卡 = 8 张昇腾卡（含页面登记的参考单价）。
 */
test('基线与设置：模型基线库与参考卡取自业务场景页目录', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  // 「算力规划」默认展开，直接点二级项；再点分组会把整组收起
  await page.getByRole('button', { name: '基线与设置', exact: true }).click();

  const pane = page.locator('.ant-tabs-tabpane-active');
  // 目录从 9 条训练基线换成页面同源的 32 条 + 1 条合成验收模型：10 条/页共 4 页
  await expect(pane.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(10);
  await expect(pane.locator('.ant-pagination-item')).toHaveCount(4);
  // 表格按登记时间倒序，逐页收集后核对总量与关键条目
  const rows: string[] = [];
  for (let i = 0; i < 4; i++) {
    await pane.locator('.ant-pagination-item').nth(i).click();
    rows.push(...await pane.locator('.ant-table-tbody tr.ant-table-row').allInnerTexts());
  }
  expect(rows).toHaveLength(33);
  const pro = rows.find(r => r.includes('DeepSeek-V4-Pro（1600B/A49B）'));
  expect(pro).toBeTruthy();
  // 结构列来自页面：层数、注意力形态（该模型无 latent_dim，页面按 GQA 的 KV 头维口径计算）
  expect(pro).toContain('MoE · 61 层 · GQA');
  // 旧的训练基线目录不再出现
  expect(rows.some(r => r.includes('YOLO'))).toBe(false);

  await page.getByRole('tab', { name: '参考卡与报价' }).click();
  const cards = page.locator('.ant-tabs-tabpane-active .ant-table-tbody tr.ant-table-row');
  await expect(cards).toHaveCount(8);
  const c = page.locator('.ant-tabs-tabpane-active .ant-table-tbody tr.ant-table-row').filter({ hasText: '昇腾910C' });
  await expect(c).toContainText('560 T');
  await expect(c).toContainText('128 GB');
  await expect(c).toContainText('35 万元/卡');
  // 未登记参考价的卡种不编造价格
  const b32 = page.locator('.ant-tabs-tabpane-active .ant-table-tbody tr.ant-table-row').filter({ hasText: '昇腾910B · 32GB' });
  await expect(b32).toContainText('未登记');
  // 旧的 NVIDIA 参考卡已随目录切换移除
  await expect(page.locator('.ant-tabs-tabpane-active')).not.toContainText('NVIDIA');

  expect(errors).toEqual([]);
});
