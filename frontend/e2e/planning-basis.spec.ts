import { test, expect } from '@playwright/test';

test('无需项目即可阅读规划依据，首页和侧栏入口一致', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '规划思路和依据' }).click();
  await expect(page.getByRole('heading', { name: '规划依据', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: '整体规划思路' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('C总建议 = C业务建议 + C创新建议 + C研发建议')).toBeVisible();
  await expect(page.locator('.plan-meta')).toHaveCount(0);
  await page.getByRole('tab', { name: '业务场景计算依据' }).click();
  await expect(page.getByText('λ = U × r × a ÷ 60', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '2048', exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: '创新服务计算依据' }).click();
  await expect(page.getByText('Q月 = U × q × u', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('峰值倍数', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '开发测试计算依据' }).click();
  await expect(page.getByText('F训练 = ktrain × Ntrain × D × E', { exact: false })).toBeVisible();
  await expect(page.getByRole('cell', { name: '标准（默认）', exact: true })).toBeVisible();
  await expect(page.getByText('ktrain 初始 4，ηtrain 初始 0.25。', { exact: false })).toBeVisible();
  await page.getByRole('tab', { name: '依据与来源' }).click();
  await expect(page.getByRole('link', { name: /Scaling Laws/ })).toHaveAttribute('href', /arxiv\.org/);
  await page.locator('.planning-basis .ant-pagination-next button').click();
  await expect(page.getByRole('cell', { name: 'Qwen3-8B', exact: true })).toBeVisible();
  const modelRow = page.getByRole('row').filter({ has: page.getByRole('cell', { name: 'Qwen3-8B', exact: true }) });
  await expect(modelRow.getByRole('link')).toHaveAttribute('href', /b968826d9c46dd6066d109eabc6255188de91218/);
  await page.getByRole('button', { name: '项目概览', exact: true }).click();
  await page.getByRole('button', { name: '规划依据', exact: true }).click();
  await expect(page.getByRole('heading', { name: '规划依据', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('业务场景移除助手并使用全宽，切换规划依据保留未保存输入', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '载入示例项目' }).click();
  await page.getByLabel('规模-企业知识问答').fill('321');
  await page.getByLabel('规模-企业知识问答').blur();
  await expect(page.getByLabel('与规划助手对话')).toHaveCount(0);
  await expect(page.locator('.assistant')).toHaveCount(0);
  const panel = await page.locator('.main-panel').boundingBox();
  const heading = await page.locator('.page-heading').boundingBox();
  expect(panel!.width).toBeCloseTo(heading!.width, 0);
  await page.getByRole('button', { name: '规划依据', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始测算', exact: true })).toHaveCount(0);
  await page.screenshot({ path: '../docs/screenshots/06-planning-basis.png', fullPage: true });
  await page.getByRole('button', { name: '业务场景', exact: true }).click();
  await expect(page.getByLabel('规模-企业知识问答')).toHaveValue('321');
  await expect(page.getByRole('button', { name: /保存方案/ })).toBeEnabled();
});

test('规划依据在窄屏可阅读，公式与表格不撑开页面', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '规划依据', exact: true }).click();
  for (const name of ['整体规划思路', '业务场景计算依据', '创新服务计算依据', '开发测试计算依据', '依据与来源']) {
    await page.getByRole('tab', { name, exact: true }).click({ force: true });
    await expect(page.getByRole('tabpanel')).toBeVisible();
    const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    expect(sizes.scroll, name).toBeLessThanOrEqual(sizes.width + 1);
  }
});
