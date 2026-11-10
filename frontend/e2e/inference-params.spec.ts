import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const SPEC = { model_key: 'qwen3_8b', chip_key: '910c', scene_key: 'kb_qa', concurrency: 100, profile: 'neutral' };

async function openParams(page: Page, tab?: string | RegExp) {
  await page.getByRole('button', { name: '基线与设置', exact: true }).click();
  await page.getByRole('tab', { name: '推理参数' }).click();
  if (tab) await page.getByRole('tab', { name: tab }).click();
}

/** 推理参数：默认值可读、改动可存、越界被拒、可恢复，且刷新后仍生效。 */
test('推理参数：显示默认值、保存覆盖值并恢复默认', async ({ page }) => {
  await page.goto('/');
  await openParams(page, /卡数聚合与混部/);

  const margin = page.getByRole('spinbutton', { name: '扩容余量倍数' });
  await expect(margin).toHaveValue('1.2');
  await expect(page.getByText(/版本\s*inference/).first()).toBeVisible();

  // 检索能缩小到目标字段
  await page.getByPlaceholder('按名称或字段检索').fill('余量');
  await expect(margin).toBeVisible();
  await page.getByPlaceholder('按名称或字段检索').fill('');

  await margin.fill('1.5');
  await margin.blur();
  await expect(page.getByText('未保存').first()).toBeVisible();
  await page.getByRole('button', { name: /保存并生效/ }).click();
  await expect(page.getByText('参数已生效', { exact: false })).toBeVisible();
  await expect(page.getByText('已调').first()).toBeVisible();
  await page.screenshot({ path: '../docs/screenshots/11-inference-params.png', fullPage: true });

  // 刷新后覆盖值仍在：改的是库里的覆盖层，不是前端状态
  await page.reload();
  await openParams(page, /卡数聚合与混部/);
  await expect(page.getByRole('spinbutton', { name: '扩容余量倍数' })).toHaveValue('1.5');

  // 越界值由后端拒绝，不静默截断（前端控件会夹到区间内，所以直接打接口）
  const bad = await page.request.put('/api/v1/inference/params',
    { data: { overrides: { aggregation: { margin_factor: 9 } } } });
  expect(bad.status()).toBe(422);
  expect((await bad.json()).message).toContain('参数不合法');

  // 恢复默认
  await page.getByRole('button', { name: '恢复默认' }).click();
  await expect(page.getByText('已恢复为默认参数', { exact: false })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: '扩容余量倍数' })).toHaveValue('1.2');
});

/** 参数改动必须真的落到引擎上：同一个场景在显存利用率降低后需要更多卡。 */
test('推理参数改动影响引擎出卡', async ({ page }) => {
  await page.goto('/');
  const estimate = async () => {
    const body = await (await page.request.post('/api/v1/inference/estimate', { data: SPEC })).json();
    return Number(body.result.result.cards);
  };
  const before = await estimate();

  await openParams(page, '敏感度三档');
  const fill = page.getByRole('spinbutton', { name: '显存利用率' }).nth(1); // 中性档
  await expect(fill).toHaveValue('0.90');
  await fill.fill('0.6');
  await fill.blur();
  await page.getByRole('button', { name: /保存并生效/ }).click();
  await expect(page.getByText('参数已生效', { exact: false })).toBeVisible();

  expect(await estimate()).toBeGreaterThan(before);

  await page.getByRole('button', { name: '恢复默认' }).click();
  await expect(page.getByText('已恢复为默认参数', { exact: false })).toBeVisible();
  expect(await estimate()).toBe(before);
});
