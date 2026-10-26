import { test, expect } from '@playwright/test';

test('完整规划：示例、编辑、保存、计算、依据、费用和历史对比', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '让每一份算力，都有规划依据。' })).toBeVisible();
  await page.screenshot({ path: '../docs/screenshots/01-projects.png', fullPage: true });
  await page.getByRole('button', { name: '载入示例项目' }).click();
  await expect(page.getByLabel('规模-企业知识问答')).toBeVisible();
  await page.getByLabel('规模-企业知识问答').fill('200');
  await page.getByLabel('规模-企业知识问答').blur();
  await page.getByRole('button', { name: /保存方案/ }).click();
  await expect(page.getByRole('button', { name: /保存方案/ })).toBeDisabled();
  await page.getByRole('button', { name: '接受全部默认值', exact: true }).click();
  await page.screenshot({ path: '../docs/screenshots/02-business.png', fullPage: true });
  await page.getByRole('button', { name: '开始测算', exact: true }).click();
  await expect(page.getByText('建议规划总算力', { exact: true })).toBeVisible();
  await expect(page.getByText('已完成估算', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '查看计算依据' }).first().click();
  await expect(page.getByText('计算依据与追踪', { exact: true })).toBeVisible();
  await expect(page.locator('.ant-drawer-content')).toContainText('llm-phases-v1');
  await page.locator('.ant-drawer-close').click();
  await page.getByRole('button', { name: '生成费用附录' }).click();
  await expect(page.getByText('价格待录入', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: '../docs/screenshots/03-results.png', fullPage: true });
  await page.getByRole('button', { name: '业务场景', exact: true }).click();
  await page.getByLabel('规模-企业知识问答').fill('300');
  await page.getByLabel('规模-企业知识问答').blur();
  await page.getByRole('button', { name: '开始测算', exact: true }).click();
  await expect(page.getByText('建议规划总算力', { exact: true })).toBeVisible();
  const compare = page.getByRole('combobox', { name: '对比计算版本' }); await compare.click();
  const choices = page.locator('.ant-select-dropdown:visible .ant-select-item-option');
  await choices.nth(0).click(); await choices.nth(1).click(); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '对比版本', exact: true }).click();
  await expect(page.getByText('相对首项差额', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('文字导入、缺失任务与手动流程', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '新建规划项目' }).click();
  await page.getByLabel('项目名称', { exact: true }).fill('导入验收项目');
  await page.getByRole('button', { name: '创建项目', exact: true }).click();
  await page.getByRole('button', { name: '导入清单', exact: true }).click();
  await page.getByLabel('场景清单文字').fill('场景名称\t场景描述\t在线人数\n问答助手\t内部知识检索与问答\t100\n语音识别\t音频转文字\t');
  await page.getByRole('button', { name: '识别并预览' }).click();
  await expect(page.getByText('识别到 2 个场景')).toBeVisible();
  await page.getByRole('button', { name: '确认导入', exact: true }).click();
  await expect(page.getByLabel('与规划助手对话')).toHaveCount(0);
  await page.getByLabel('规模-问答助手').fill('150');
  await page.getByLabel('规模-问答助手').blur();
  await expect(page.getByLabel('规模-问答助手')).toHaveValue('150');
  await page.getByRole('button', { name: '开始测算', exact: true }).click();
  await expect(page.getByText('已计入部分的建议算力')).toBeVisible();
  await expect(page.getByText('以下任务尚未计入完整总量')).toBeVisible();
});

test('移动端可访问且没有横向页面溢出', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '新建规划项目' })).toBeVisible();
  const sizes = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.width + 1);
  await page.screenshot({ path: '../docs/screenshots/04-mobile.png', fullPage: true });
});
