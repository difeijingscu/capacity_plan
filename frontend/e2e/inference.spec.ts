import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * antd Select 的选中文字层会拦截 input 上的点击，因此点外层容器（data-testid 所在节点）；
 * 选项列表是虚拟滚动，必须先键入关键字过滤再点可见选项。
 */
async function pickOption(page: Page, testId: string, keyword: string) {
  const select = page.getByTestId(testId);
  await select.click();
  await select.getByRole('combobox').fill(keyword);
  const option = page
    .locator('.ant-select-dropdown:visible .ant-select-item-option')
    .filter({ hasText: keyword })
    .first();
  await option.waitFor({ state: 'visible' });
  await option.click();
}

const cardCount = async (page: Page) => {
  const text = await page.locator('.inference-metrics .metric strong').first().textContent();
  return Number((text ?? '').replace(/\D/g, ''));
};

test('推理评估：默认场景出卡数，三维约束与拓扑可读', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '推理评估' }).click();
  await expect(page.getByRole('heading', { name: '推理评估' })).toBeVisible();

  await expect(page.getByRole('combobox', { name: '推理模型' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '算力服务器' })).toBeVisible();

  await page.getByRole('button', { name: '开始评估' }).click();

  const metric = page.locator('.inference-metrics .metric').first();
  await expect(metric).toBeVisible();
  await expect(metric.locator('strong')).toContainText('张');

  // 三维只取 max，不相加；瓶颈标注必须出现
  await expect(page.getByText('三项取最大').first()).toBeVisible();
  await expect(page.getByText('当前瓶颈').first()).toBeVisible();

  // 计算过程四个折叠项
  await expect(page.getByText('① 显存约束', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('② Prefill 约束', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('③ Decode 约束', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('④ 拓扑与 SLA 回验', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: '../docs/screenshots/09-inference.png', fullPage: true });
});

test('推理评估：换成大模型与弱芯片后卡数增加', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '推理评估' }).click();
  await page.getByRole('button', { name: '开始评估' }).click();
  await expect(page.locator('.inference-metrics .metric').first()).toBeVisible();
  const first = await cardCount(page);

  await pickOption(page, 'model-select', 'DeepSeek-V4-Flash');
  await pickOption(page, 'chip-select', '910B');
  await page.getByRole('button', { name: '开始评估' }).click();

  await expect(page.locator('.inference-metrics .metric').first()).toBeVisible();
  await expect(page.getByText('DeepSeek-V4-Flash', { exact: false }).first()).toBeVisible();
  const second = await cardCount(page);
  expect(second).toBeGreaterThan(first);
});

test('推理评估：切换场景档位后输入长度随之更新', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '推理评估' }).click();
  await pickOption(page, 'scene-select', '摘要');
  await page.getByText('业务规模与时延目标', { exact: false }).first().click();
  await expect(page.getByRole('spinbutton', { name: '输入长度' })).toHaveValue('32768');
  await expect(page.getByRole('spinbutton', { name: '输出长度' })).toHaveValue('1024');
});

test('推理评估：自定义模型可登记并参与评估', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '推理评估' }).click();
  await page.getByRole('button', { name: '登记自定义模型' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.getByLabel('标识').fill('e2e-model');
  await page.getByLabel('显示名称').fill('E2E 测试模型');
  await page.getByLabel('总参数 (B)').fill('30');
  await page.getByLabel('激活参数 (B)').fill('30');
  await page.getByLabel('隐层维度').fill('5120');
  await page.getByLabel('层数').fill('64');
  await page.getByLabel('Q 头数').fill('40');
  await page.getByRole('button', { name: /保\s*存/ }).click();

  await expect(page.getByText('自定义模型已登记')).toBeVisible();

  await pickOption(page, 'model-select', 'E2E 测试模型');
  await expect(page.getByTestId('model-select')).toContainText('E2E 测试模型');

  await page.getByRole('button', { name: '开始评估' }).click();
  await expect(page.locator('.inference-metrics .metric').first()).toBeVisible();
  await expect(page.getByText('E2E 测试模型', { exact: false }).first()).toBeVisible();
});
