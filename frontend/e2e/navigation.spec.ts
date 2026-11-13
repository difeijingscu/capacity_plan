import { expect, test } from '@playwright/test';

/**
 * 侧栏分组结构：
 *  - 一级「算力规划」下含 项目概览 / 业务场景 / 创新服务 / 开发测试 / 测算结果 / 规划依据 / 基线与设置；
 *  - 一级「机房布局」下含 5 个二级页面（均已接入正式内容：React 重绘 / 3D 嵌入 / 剖面示意嵌入）；
 *  - 「机柜布局」「ROI 分析」无二级菜单，点击一级即进入对应页面；
 *  - 「推理评估」在分隔线之下独立成项。
 */

const navGroup = (page: import('@playwright/test').Page, label: string) =>
  page.locator('aside.sidebar nav .nav-group').filter({ has: page.getByRole('button', { name: label, exact: true }) });

test('侧栏默认展开算力规划，七个二级入口齐全且已路由', async ({ page }) => {
  await page.goto('/');
  const nav = page.locator('aside.sidebar nav');

  // 一级菜单（4 个分组）＋分隔线下独立的推理评估
  await expect(nav.locator('.nav-group')).toHaveCount(4);
  await expect(nav.locator('.nav-group-head')).toHaveCount(4);
  await expect(nav.getByRole('button', { name: '算力规划', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: '机房布局', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: '机柜布局', exact: true })).toBeVisible();
  await expect(nav.getByRole('button', { name: 'ROI 分析', exact: true })).toBeVisible();

  // 算力规划默认展开：7 个二级项
  const planning = navGroup(page, '算力规划');
  await expect(planning.locator('.nav-sub-item')).toHaveCount(7);
  for (const label of ['项目概览', '业务场景', '创新服务', '开发测试', '测算结果', '规划依据', '基线与设置']) {
    await expect(planning.getByRole('button', { name: label, exact: true })).toBeVisible();
  }

  // 机房布局默认折叠
  const room = navGroup(page, '机房布局');
  await expect(room.locator('.nav-sub')).toHaveCount(0);
  await expect(room.getByRole('button', { name: '机房布局', exact: true })).toHaveAttribute('aria-expanded', 'false');

  // 二级菜单可跳转
  await planning.getByRole('button', { name: '规划依据', exact: true }).click();
  await expect(page.locator('.page-heading h1')).toHaveText('规划依据');
  await expect(planning.getByRole('button', { name: '规划依据', exact: true })).toHaveClass(/active/);
});

test('机房布局展开后二级入口完成路由', async ({ page }) => {
  await page.goto('/');
  const room = navGroup(page, '机房布局');
  await room.getByRole('button', { name: '机房布局', exact: true }).click();

  await expect(room.getByRole('button', { name: '机房布局', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(room.locator('.nav-sub-item')).toHaveCount(5);

  // 数据中心布局示意图已是正式内容页：四层示意 + 单层平面图 + POD 说明
  await room.getByRole('button', { name: '数据中心布局示意图', exact: true }).click();
  await expect(page.locator('.page-heading h1')).toHaveText('数据中心布局示意图');
  await expect(page.locator('header.topbar')).toContainText('数据中心布局示意图');
  await expect(room.getByRole('button', { name: '数据中心布局示意图', exact: true })).toHaveClass(/active/);
  await expect(page.getByRole('img', { name: '四层数据中心结构示意' })).toBeVisible();
  await expect(page.getByRole('img', { name: '单层数据中心详细平面图' })).toBeVisible();
  await expect(page.getByText('POD 布局说明')).toBeVisible();

  // 机房立体布局已是正式内容页：项目风格外壳 + 同源嵌入 3D 应用
  await room.getByRole('button', { name: '机房立体布局', exact: true }).click();
  await expect(page.locator('.page-heading h1')).toHaveText('机房立体布局');
  await expect(page.locator('header.topbar')).toContainText('机房立体布局');
  await expect(room.getByRole('button', { name: '机房立体布局', exact: true })).toHaveClass(/active/);
  await expect(page.getByTestId('room-3d-embed')).toBeVisible();
  const embedFrame = page.frameLocator('[data-testid="room-3d-embed"]');
  await expect(embedFrame.locator('#three-app')).toBeVisible();
  await expect(embedFrame.locator('#loading')).toBeHidden();

  // 机房供电：3D 供电路径嵌入页（视口型 iframe）
  await room.getByRole('button', { name: '机房供电', exact: true }).click();
  await expect(page.getByTestId('room-power-embed')).toBeVisible();
  const powerFrame = page.frameLocator('[data-testid="room-power-embed"]');
  await expect(powerFrame.locator('#power-app')).toBeVisible();
  await expect(powerFrame.locator('#toolbar')).toBeVisible();

  // 机房液冷层高承重：剖面示意内容页（高度自适应 iframe）
  await room.getByRole('button', { name: '机房液冷层高承重', exact: true }).click();
  await expect(page.getByTestId('room-liquid-cooling-embed')).toBeVisible();
  const reqFrame = page.frameLocator('[data-testid="room-liquid-cooling-embed"]');
  await expect(reqFrame.locator('main.requirements')).toBeVisible();
  await expect(reqFrame.locator('main.requirements h1')).toContainText('机房液冷层高承重');

  // 液冷微模块布局：3D 模拟器嵌入页（视口型 iframe）
  await room.getByRole('button', { name: '液冷微模块布局', exact: true }).click();
  await expect(page.getByTestId('room-micro-module-embed')).toBeVisible();
  const rackFrame = page.frameLocator('[data-testid="room-micro-module-embed"]');
  await expect(rackFrame.locator('#rack-simulator')).toBeVisible();
  await expect(rackFrame.locator('#scene canvas')).toBeVisible();

  for (const label of ['机房供电', '机房液冷层高承重', '液冷微模块布局']) {
    await room.getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('.page-heading h1')).toHaveText(label);
    await expect(page.locator('header.topbar')).toContainText(label);
    await expect(room.getByRole('button', { name: label, exact: true })).toHaveClass(/active/);
  }

  // 再次点击一级可折叠
  await room.getByRole('button', { name: '机房布局', exact: true }).click();
  await expect(room.locator('.nav-sub')).toHaveCount(0);
});

test('机柜布局与 ROI 分析为单页大类，机柜进入嵌入工具页、ROI 进入占位页', async ({ page }) => {
  await page.goto('/');
  // 机柜布局：Card → Power 嵌入页
  await page.locator('aside.sidebar nav').getByRole('button', { name: '机柜布局', exact: true }).click();
  await expect(page.locator('.page-heading h1')).toHaveText('机柜布局');
  await expect(page.getByTestId('cabinet-embed')).toBeVisible();
  await expect(page.locator('.page-heading p')).toContainText('机柜组成');
  // iframe 内容须为 Card → Power 工具页（防止 SPA catch-all 回落吞掉静态资源）
  const cabFrame = page.frameLocator('iframe[data-testid="cabinet-embed"]');
  await expect(cabFrame.locator('.theme-title')).toHaveText('机房功率与布局参考');
  await expect(cabFrame.locator('.tab.on')).toContainText('96 卡');
  const cabinet = navGroup(page, '机柜布局');
  await expect(cabinet.locator('.nav-sub')).toHaveCount(0);
  await expect(cabinet.getByRole('button', { name: '机柜布局', exact: true })).toHaveClass(/active/);

  // ROI 分析：Investment ROI 嵌入页
  await page.locator('aside.sidebar nav').getByRole('button', { name: 'ROI 分析', exact: true }).click();
  await expect(page.locator('.page-heading h1')).toHaveText('ROI 分析');
  await expect(page.locator('.page-heading p')).toContainText('回收周期');
  await expect(page.getByTestId('roi-embed')).toBeVisible();
  const roiFrame = page.frameLocator('iframe[data-testid="roi-embed"]');
  await expect(roiFrame.locator('main')).toBeVisible();
  await expect(roiFrame.getByText('Token 服务投资收益分析').first()).toBeVisible();
  const roi = navGroup(page, 'ROI 分析');
  await expect(roi.locator('.nav-sub')).toHaveCount(0);
  await expect(roi.getByRole('button', { name: 'ROI 分析', exact: true })).toHaveClass(/active/);
});

test('从机房布局跳回算力规划会自动展开分组', async ({ page }) => {
  await page.goto('/');
  // 折叠算力规划后进入某待补充页
  const planning = navGroup(page, '算力规划');
  await planning.getByRole('button', { name: '算力规划', exact: true }).click();
  await expect(planning.locator('.nav-sub')).toHaveCount(0);

  const room = navGroup(page, '机房布局');
  await room.getByRole('button', { name: '机房布局', exact: true }).click();
  await room.getByRole('button', { name: '机房供电', exact: true }).click();
  await expect(page.locator('.page-heading h1')).toHaveText('机房供电');

  // 通过顶栏之外的入口（推理评估再回来无意义），直接点击折叠状态下的算力规划一级
  await planning.getByRole('button', { name: '算力规划', exact: true }).click();
  await expect(planning.locator('.nav-sub-item')).toHaveCount(7);
});
