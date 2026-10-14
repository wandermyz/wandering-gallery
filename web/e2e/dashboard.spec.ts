import { expect, test, type Page } from '@playwright/test';

async function comfyOnline(online: boolean) {
  await fetch('http://127.0.0.1:2397/fake/online', { method: 'POST', body: JSON.stringify({ online }) });
}

async function noHorizontalScroll(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
}

test.beforeEach(async () => {
  await comfyOnline(true);
});

test('shows ComfyUI, the GPU and its workload, and follows a run to the gallery', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('.topbar h1')).toHaveText('Dashboard');
  await expect(page.locator('#dash-gpu-h')).toBeVisible();
  await expect(page.locator('.dash-stat', { hasText: 'VRAM' })).toContainText('11.5');
  await expect(page.locator('.dash-head', { hasText: 'GPU workload' }).locator('.cap-pill')).toHaveText('ComfyUI');
  await expect(page.locator('.vram-legend')).toContainText('ComfyUI 11.5');
  await noHorizontalScroll(page);

  // A run started from Generate shows up running with its progress, then in Recent.
  await page.goto('/generate/wai-illustrious-tags');
  await page.locator('.gen-tags').first().fill('masterpiece, dashboard test');
  await page.getByRole('button', { name: /^Generate \d+ images?$/ }).click();
  await expect(page.locator('.gen-run')).toHaveCount(1);
  await page.goto('/dashboard');
  await expect(page.locator('.dash-running')).toHaveCount(1);
  await expect(page.locator('.dash-running .dash-job-meta')).toContainText('gallery');
  await expect(page.locator('.dash-running')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('#dash-comfy-h + .cap-pill')).toHaveText('Idle');
  const recent = page.locator('.dash-job', { has: page.locator('a.dash-thumb') }).first();
  await expect(recent).toBeVisible({ timeout: 15_000 });
  await recent.locator('a.dash-thumb').click();
  await expect(page).toHaveURL(/\/gallery\?lib=comfy&a=\d+$/);
  await expect(page.locator('.viewer')).toBeVisible();
});

test('says when ComfyUI is down and recovers on its own', async ({ page }) => {
  await comfyOnline(false);
  await page.goto('/dashboard');
  await expect(page.locator('#dash-comfy-h + .cap-pill')).toHaveText('Offline');
  await expect(page.locator('.dash-comfy .dash-err')).toContainText('not running');
  await expect(page.locator('.topbar-sub')).toHaveText('ComfyUI offline');
  // The GPU card does not depend on ComfyUI.
  await expect(page.locator('.dash-stat', { hasText: 'Load' })).toBeVisible();
  await comfyOnline(true);
  await expect(page.locator('#dash-comfy-h + .cap-pill')).not.toHaveText('Offline', { timeout: 10_000 });
});
