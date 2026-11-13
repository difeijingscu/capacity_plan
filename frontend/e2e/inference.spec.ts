import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * 推理评估页已替换为「场景算力评估」独立页（同源 iframe 嵌入）：
 *  - 侧栏入口移到最后、与主菜单之间有分隔线，名称下带小字标注；
 *  - 页面内容为 frontend/public/inference-eval.html（自包含样式 / 数据 / 计算引擎）。
 * 测试全部通过 contentFrame() 进入 iframe 操作。
 */

const sidebarButton = (page: Page) =>
  page.getByRole('button', { name: /^推理评估/ });

async function openInference(page: Page) {
  await page.goto('/');
  await sidebarButton(page).click();
  await expect(page.getByRole('heading', { name: '推理评估' })).toBeVisible();
  const frame = page.frameLocator('[data-testid="inference-embed"]');
  await expect(frame.locator('header.top').getByText('场景算力评估')).toBeVisible();
  // 等内嵌页脚本初始化完成：初始化末尾 renderAggregate 会把汇总条刷新为「当前测算结果：…」
  await expect(frame.locator('#topNote')).toContainText('当前测算结果');
  return frame;
}

test('推理评估：侧栏入口分隔且带小字标注', async ({ page }) => {
  await page.goto('/');
  const btn = sidebarButton(page);
  await expect(btn).toBeVisible();

  // 小字标注：For产品组合的集成页面
  await expect(btn.getByText('For产品组合的集成页面')).toBeVisible();

  // 与主菜单之间有分隔线，且位于菜单最后（基线与设置之后）
  const nav = page.locator('aside.sidebar nav');
  await expect(nav.locator('.nav-divider')).toHaveCount(1);
  expect(nav.locator('.nav-divider').first()).toBeVisible();
  const navText = await nav.innerText();
  const sepIdx = navText.indexOf('基线与设置');
  const infIdx = navText.indexOf('推理评估');
  expect(sepIdx).toBeGreaterThan(-1);
  expect(infIdx).toBeGreaterThan(sepIdx);
});

test('推理评估：预置场景出卡数，汇总与明细可读', async ({ page }) => {
  const frame = await openInference(page);

  // 预置 3 个典型场景（长任务 Agent 对话 / 知识库问答 / 深度推理）
  await expect(frame.locator('.scen-row')).toHaveCount(3);

  // 每行都有卡数徽章与主导因素标签
  const badge = frame.locator('.scen-row .badge b').first();
  await expect(badge).toBeVisible();
  await expect(frame.locator('.scen-row .tag.b').first()).toContainText('主导因素');

   // 汇总 KPI 出总卡数与服务器台数
  await expect(frame.locator('.kpi.hl .k').first()).toContainText('总卡数');
  await expect(frame.locator('.kpi').filter({ hasText: '服务器台数' })).toBeVisible();
  const totalText = await frame.locator('.kpi.hl .v').first().innerText();
  const totalCards = Number(totalText.replace(/\D/g, ''));
  expect(totalCards).toBeGreaterThan(0);

  // 按模型归类明细表有合计行
  await expect(frame.locator('#byModelTbl tr.sum')).toContainText('合计');
  await page.screenshot({ path: '../docs/screenshots/09-inference.png', fullPage: true });
});

test('推理评估：添加并删除场景行', async ({ page }) => {
  const frame = await openInference(page);
  const rows = () => frame.locator('.scen-row');

  await frame.getByRole('button', { name: /＋\s*添加场景/ }).click();
  await expect(rows()).toHaveCount(4);

  // 新增行置顶且名称可编辑
  const first = rows().first();
  await expect(first).toContainText('自定义业务场景');
  const nameInput = first.locator('[data-f="name"]');
  await nameInput.fill('验收场景');

  // 删除该行回到 3 个
  await first.getByRole('button', { name: '删除' }).click();
  await expect(rows()).toHaveCount(3);
});

test('推理评估：切换算力卡后卡数与统计更新', async ({ page }) => {
  const frame = await openInference(page);
  const total = async () => {
    const text = await frame.locator('.kpi.hl .v').first().innerText();
    return Number(text.replace(/\D/g, ''));
  };

  const before = await total();

  // 切到更弱的芯片（910B · 32GB），总卡数应上升
  const chipSel = frame.locator('#chipSel');
  await chipSel.selectOption('910b32');
  await expect(frame.locator('#chipHint')).toContainText('32');
  const after = await total();
  expect(after).toBeGreaterThan(before);
});

test('推理评估：展开计算过程可见杜邦式拆解', async ({ page }) => {
  const frame = await openInference(page);
  const first = frame.locator('.scen-row').first();
  await first.getByRole('button', { name: /▸\s*计算过程/ }).click();
  await expect(frame.locator('.fx-block .fx-t').first()).toContainText('计算过程');
  // 根节点显示所需算力卡 N
  await expect(frame.locator('.fx2-card.t-root .nm')).toContainText('所需算力卡 N');
  // A/B/C 三个分支
  await expect(frame.locator('.fx2-card').filter({ hasText: 'A · 显存约束' })).toBeVisible();
  await expect(frame.locator('.fx2-card').filter({ hasText: 'B · Prefill 约束' })).toBeVisible();
  await expect(frame.locator('.fx2-card').filter({ hasText: 'C · Decode 约束' })).toBeVisible();
});
