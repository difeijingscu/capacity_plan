import { test, expect } from '@playwright/test';

test('概览两个说明入口平级，组织设计无需项目即可阅读并可返回', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const basis = page.getByRole('button', { name: '规划思路和依据', exact: true });
  const organization = page.getByRole('button', { name: '规划方案组织设计', exact: true });
  const basisBox = await basis.boundingBox();
  const organizationBox = await organization.boundingBox();
  expect(organizationBox!.y).toBeCloseTo(basisBox!.y, 0);
  await organization.click();
  await expect(page.getByRole('heading', { name: '规划方案组织设计', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: '项目、规划方案和三类资源池的组合关系图' })).toBeVisible();
  await expect(page.getByText('基准方案的测算结果', { exact: true })).toBeVisible();
  await expect(page.getByText('对比方案的测算结果', { exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '2.0 P', exact: true })).toBeVisible();
  await expect(page.getByText('“当前方案”与“历史计算版本”分别选择', { exact: true })).toBeVisible();
  await expect(page.locator('.plan-meta')).toHaveCount(0);
  await page.screenshot({ path: '../docs/screenshots/07-planning-organization.png', fullPage: true });
  await page.getByRole('button', { name: '返回项目概览', exact: true }).click();
  await expect(organization).toBeVisible();
  await organization.click();
  await page.getByRole('button', { name: '查看规划思路和依据', exact: true }).click();
  await expect(page.getByRole('heading', { name: '规划依据', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('阅读组织设计保留当前方案的未保存内容', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '载入示例项目', exact: true }).click();
  await page.getByLabel('规模-企业知识问答').fill('456');
  await page.getByLabel('规模-企业知识问答').blur();
  await page.getByRole('button', { name: '项目概览', exact: true }).click();
  await page.getByRole('button', { name: '规划方案组织设计', exact: true }).click();
  await expect(page.locator('.heading-actions')).toHaveCount(0);
  await expect(page.locator('.plan-meta')).toHaveCount(0);
  await page.getByRole('button', { name: '返回项目概览', exact: true }).click();
  await page.getByRole('button', { name: '业务场景', exact: true }).click();
  await expect(page.getByLabel('规模-企业知识问答')).toHaveValue('456');
  await expect(page.getByRole('button', { name: /保存方案/ })).toBeEnabled();
});

test('窄屏组织关系图和说明表格不撑开页面', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: '规划方案组织设计', exact: true }).click();
  await expect(page.getByRole('heading', { name: '规划方案组织设计', exact: true })).toBeVisible();
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
  await page.screenshot({ path: '../docs/screenshots/08-organization-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '返回项目概览', exact: true }).click();
  await expect(page.getByRole('button', { name: '规划思路和依据', exact: true })).toBeVisible();
});
