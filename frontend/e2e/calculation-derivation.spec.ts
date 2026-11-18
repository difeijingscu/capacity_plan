import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function createAndCalculate(page: Page, name: string, partial = false) {
  const response = await page.request.post('/api/v1/projects', { data: { name, payload: {
    scenarios: [
      { name: '推导问答', inference: { model_key: 'qwen3_8b', chip_key: '910c', scene_key: 'rag', concurrency: 100 } },
      { name: '推导长文', inference: { model_key: 'deepseek_v4_flash', chip_key: '950dt', scene_key: 'long_gen', concurrency: 20 } },
      ...(partial ? [{ name: '待补基线任务', components: [{ task_type: 'unit', units_per_second: 3 }] }] : []),
    ],
    // cache_hit_rate 显式写成 30%：下面断言的黄金值按「Prefill × (1 − 30%)」算，
    // 不依赖 schemas.Innovation 的缺省值（缺省值将来若调整，这条用例不该跟着漂）。
    innovation: partial ? { enabled: false } : { enabled: true, users: 1000, quota_per_user_month: 50000000,
      cache_hit_rate: 0.3, allocations: [{ model_id: 'deepseek_v4_flash', share: 1 }] },
    development: partial ? { enabled: false } : { enabled: true, intensity: 'standard',
      models: [{ model_id: 'qwen3_8b', method: 'lora' }, { model_id: 'qwen36_27b', method: 'lora' }] },
  } } });
  expect(response.ok()).toBeTruthy();
  await page.goto('/');
  const card = page.locator('.project-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await card.getByRole('button', { name: '基准方案', exact: true }).click();
  await page.getByRole('button', { name: '开始测算', exact: true }).click();
  await expect(page.getByText(partial ? '已计入部分的建议算力' : '建议规划总算力', { exact: true })).toBeVisible();
}

test('四张容量卡片展示真实代入过程及研发最大任务聚合', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await createAndCalculate(page, '四卡推导验收');
  const drawer = page.locator('.calculation-derivation');
  await page.getByRole('button', { name: '查看创新服务计算推导', exact: true }).click();
  await expect(drawer.getByText('创新服务 · 计算推导', { exact: true })).toBeVisible();
  await expect(drawer.locator('.fx2-card.t-root .nm')).toHaveText('创新池规划结果');
  await expect(drawer.locator('.fx2-branch')).toHaveCount(3);
  await expect(drawer.locator('.fx-block')).toContainText('需求与工作量');
  await expect(drawer.locator('.fx-block')).toContainText('显存需求');
  // engine-v2.2.0：创新/研发池也不再加余量与 +1 冗余，第三个主干改叫「物理卡数」
  await expect(drawer.locator('.fx-block')).toContainText('物理卡数');
  await expect(drawer.locator('.fx-block')).not.toContainText('余量与物理卡数');
  await expect(drawer).toContainText('50,000,000,000');
  await expect(drawer).toContainText('633,600');
  await expect(drawer).toContainText('78,914.141414');
  // engine-v2.1.0：前缀缓存命中率只折算 Prefill——先给命中前的全量工作量，
  // 再单独一步乘 (1 − 30%)，两个数字都要能在抽屉里逐项对上。
  await expect(drawer).toContainText('前缀缓存命中率');
  await expect(drawer).toContainText('63,897,600,000,000');
  await expect(drawer).toContainText('44,728,320,000,000');
  await expect(drawer).toContainText('11.818182');
  await expect(drawer).toContainText('9.848485');
  await expect(drawer).toContainText('21.666667');
  await expect(drawer).toContainText('输入结构修正 κp');
  await expect(drawer).toContainText('输入效率 ηp');
  await page.screenshot({ path: '../docs/screenshots/10-innovation-derivation.png', fullPage: true });
  await drawer.locator('.ant-drawer-close').click();
  await page.getByRole('button', { name: '查看建议规划总算力计算推导', exact: true }).click();
  await expect(drawer).toContainText('汇总三类资源池基础容量');
  await expect(drawer).toContainText('三类资源池的数值组成');
  await expect(drawer).toContainText('汇总后也不再增加');
  await drawer.locator('.ant-drawer-close').click();
  // 业务池：三维取最大 + 奇数补偶 + 时延预测 + 卡数与算力两套口径都要能看到
  await page.getByRole('button', { name: '查看业务场景计算推导', exact: true }).click();
  await expect(drawer).toContainText('显存约束 A');
  await expect(drawer).toContainText('Prefill 约束 B');
  await expect(drawer).toContainText('Decode 约束 C');
  await expect(drawer).toContainText('三维取最大（不是相加）');
  await expect(drawer).toContainText('卡数 = max(A, B, C)，奇数补偶');
  await expect(drawer).toContainText('折算等效算力');
  await expect(drawer).toContainText('时延预测');
  // engine-v2.1.1：业务池不再乘方案余量，卡数只补偶
  await expect(drawer).toContainText('汇总场景规划卡数');
  await expect(drawer).toContainText('业务池不加方案余量');
  await expect(drawer).toContainText('卡数为物理台数');
  await drawer.getByRole('button', { name: /推导长文/ }).click();
  await expect(drawer).toContainText('deepseek_v4_flash');
  await drawer.locator('.ant-drawer-close').click();
  await page.getByRole('button', { name: '查看开发测试计算推导', exact: true }).click();
  await expect(drawer.locator('.fx2-card.t-root .nm')).toHaveText('研发池规划结果');
  await expect(drawer.locator('.fx-block')).toContainText('训练显存需求');
  await expect(drawer).toContainText('微调槽位容量');
  await expect(drawer).toContainText('max(');
  await expect(drawer).toContainText('× 微调槽位数');
  await expect(drawer).toContainText('不机械累加所有候选模型');
  await expect(drawer).toContainText('F训练 = k训练 × N训练激活 × D × E');
  expect(errors).toEqual([]);
});

test('创新和研发配置页可展开最近测算的杜邦树', async ({ page }) => {
  await createAndCalculate(page, '配置页杜邦树验收');
  const drawer = page.locator('.calculation-derivation');
  await page.getByRole('button', { name: '创新服务', exact: true }).click();
  // 两个池页的汇总卡统一用「查看计算过程」；按钮在无测算快照时置灰，这里能点到即说明快照已就位。
  await page.getByRole('button', { name: '查看计算过程', exact: true }).click();
  await expect(drawer.locator('.fx2-card.t-root .nm')).toHaveText('创新池规划结果');
  await drawer.locator('.ant-drawer-close').click();
  await page.getByRole('button', { name: '开发测试', exact: true }).click();
  // 开发测试页的汇总区完全读 /preview-calculation：预览没覆盖本页时这里只会显示
  // 「选择强度与任务参数后自动汇总」空态，所以先断言 KPI 出现，再验证推导入口。
  const devSummary = page.locator('.ant-card').filter({ has: page.getByRole('heading', { name: '算力汇总' }) });
  await expect(devSummary.locator('.be-kpi .v').first()).toBeVisible();
  await page.getByRole('button', { name: '查看计算过程', exact: true }).click();
  await expect(drawer.locator('.fx2-card.t-root .nm')).toHaveText('研发池规划结果');
});

test('修改输入后推导保留历史口径，重新测算后展示新输入', async ({ page }) => {
  await createAndCalculate(page, '推导快照验收');
  await page.getByRole('button', { name: '业务场景', exact: true }).click();
  await page.getByLabel('并发会话-推导问答').fill('200');
  await page.getByLabel('并发会话-推导问答').blur();
  await page.getByRole('button', { name: '测算结果', exact: true }).click();
  await page.getByRole('button', { name: '查看业务场景计算推导', exact: true }).click();
  const drawer = page.locator('.calculation-derivation');
  await expect(drawer).toContainText('当前输入已变更，以下推导来自所选历史测算快照');
  // 场景级输入走 items 里的输入表，池级输入只有规划卡数与等效算力
  const conc = () => drawer.locator('.derivation-inputs').nth(1)
    .locator('.ant-descriptions-item').filter({ hasText: '并发会话' });
  await expect(conc()).toContainText('100');
  await drawer.locator('.ant-drawer-close').click();
  await page.getByRole('button', { name: '开始测算', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始测算', exact: true })).not.toHaveClass(/ant-btn-loading/);
  await page.getByRole('button', { name: '查看业务场景计算推导', exact: true }).click();
  await expect(conc()).toContainText('200');
  await expect(drawer.getByText('当前输入已变更，以下推导来自所选历史测算快照', { exact: true })).toHaveCount(0);
  await drawer.locator('.ant-drawer-close').click();
  await page.getByRole('button', { name: '项目概览', exact: true }).click();
  await page.locator('.project-card').filter({ has: page.getByRole('heading', { name: '推导快照验收', exact: true }) }).getByRole('button', { name: '基准方案', exact: true }).click();
  await expect(page.getByLabel('并发会话-推导问答')).toBeVisible();
  await page.getByRole('button', { name: '测算结果', exact: true }).click();
  await page.getByRole('button', { name: '查看业务场景计算推导', exact: true }).click();
  await expect(conc()).toContainText('200');
  await expect(drawer.getByText('当前输入已变更，以下推导来自所选历史测算快照', { exact: true })).toHaveCount(0);
});

test('缺失任务和未启用资源池说明清楚，手机抽屉可阅读', async ({ page }) => {
  await createAndCalculate(page, '推导缺失与窄屏验收', true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '查看创新服务计算推导', exact: true }).click();
  const drawer = page.locator('.calculation-derivation');
  await expect(drawer).toContainText('本次方案未启用此资源池');
  await expect(drawer.locator('.derivation-steps')).toHaveCount(0);
  await drawer.locator('.ant-drawer-close').click();
  await page.getByRole('button', { name: '查看已计入部分的建议算力计算推导', exact: true }).click();
  await expect(drawer).toContainText('以下需求尚未完整计入');
  await expect(drawer).toContainText('待补基线任务');
  const size = await drawer.locator('.ant-drawer-body').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.width + 1);
});
