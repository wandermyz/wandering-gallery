import { expect, test, type Page } from '@playwright/test';

const FLOW = '/generate/wai-illustrious-tags';

async function comfyOnline(online: boolean) {
  await fetch('http://127.0.0.1:2397/fake/online', { method: 'POST', body: JSON.stringify({ online }) });
}

async function noHorizontalScroll(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
}

test.beforeEach(async ({ page }) => {
  await comfyOnline(true);
  await page.goto('/gallery');
  await page.evaluate(() => localStorage.clear());
});

test('describe, tag variations, edit them and generate a batch', async ({ page }) => {
  await page.goto('/generate');
  await expect(page).toHaveURL(new RegExp(`${FLOW}$`));
  await expect(page.locator('.topbar h1')).toHaveText('WAI-Illustrious · prompt to tags');
  await expect(page.locator('.topbar-sub')).toHaveText('ComfyUI · Fake GPU');

  await expect(page.getByRole('button', { name: 'Generate tags' })).toBeDisabled();
  await page.locator('#gen-prompt').fill('a girl at the beach');
  await page.getByRole('button', { name: 'More tag variations' }).click();
  await page.getByRole('button', { name: 'More tag variations' }).click();
  await expect(page.locator('.gen-var')).toHaveCount(3);
  await page.getByRole('button', { name: 'Generate tags' }).click();

  const tags = page.locator('.gen-tags');
  await expect(tags.nth(0)).toHaveValue('1girl, base tags for a girl at the beach');
  await expect(tags.nth(1)).toHaveValue('1girl, varied tags for a girl at the beach');
  await expect(tags.nth(2)).toHaveValue(/varied tags/);

  // Edit one, drop one, regenerate one.
  await tags.nth(1).fill('1girl, edited tags');
  await page.getByRole('button', { name: 'Remove variation 3' }).click();
  await expect(page.locator('.gen-var')).toHaveCount(2);
  await page.getByRole('button', { name: 'Regenerate variation 1' }).click();
  await expect(tags.nth(0)).toHaveValue(/base tags/);
  await expect(tags.nth(1)).toHaveValue('1girl, edited tags');

  // The draft survives a reload.
  await page.reload();
  await expect(page.locator('#gen-prompt')).toHaveValue('a girl at the beach');
  await expect(tags.nth(1)).toHaveValue('1girl, edited tags');

  await page.getByRole('button', { name: 'Fewer images per variation' }).click();
  await page.getByRole('button', { name: 'Generate 4 images' }).click();
  const run = page.locator('.gen-run').first();
  await expect(run.locator('.cap-pill')).toHaveText('Running');
  await expect(run.locator('.gen-run-tags').nth(1)).toContainText('1girl, edited tags');
  await expect(run.locator('a.gen-thumb')).toHaveCount(4, { timeout: 20_000 });
  await expect(run.locator('.cap-pill')).toHaveText('Done');
  await noHorizontalScroll(page);

  // An image opens in the gallery viewer; closing it comes back here.
  await run.locator('a.gen-thumb').first().click();
  await expect(page).toHaveURL(/\/gallery\?lib=comfy&a=\d+$/);
  await expect(page.locator('.viewer-name')).toHaveText(/^fake_\d+_\.png$/);
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await expect(page).toHaveURL(new RegExp(`${FLOW}$`));
  await expect(page.locator('.gen-run').first().locator('a.gen-thumb')).toHaveCount(4);

  // Reuse puts the run's prompt and tags back into the form.
  await page.locator('#gen-prompt').fill('something else');
  await page.locator('.gen-run').first().getByRole('button', { name: 'Reuse' }).click();
  await expect(page.locator('#gen-prompt')).toHaveValue('a girl at the beach');
});

test('a running batch can be cancelled', async ({ page }) => {
  await page.goto(FLOW);
  await page.locator('#gen-prompt').fill('cancel me');
  await page.locator('.gen-tags').first().fill('1girl, typed by hand');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'More images per variation' }).click();
  await page.getByRole('button', { name: 'Generate 6 images' }).click();
  const run = page.locator('.gen-run').first();
  await expect(run.locator('.cap-pill')).toHaveText('Running');
  await run.getByRole('button', { name: 'Cancel' }).click();
  await expect(run.locator('.cap-pill')).toHaveText('Cancelled');
  await expect(run.locator('.gen-thumb-ph', { hasText: 'Cancelled' }).first()).toBeVisible();
});

test('shows an error when ComfyUI is not running', async ({ page }) => {
  await comfyOnline(false);
  await page.goto(FLOW);
  await expect(page.locator('.banner-error[role="alert"]')).toContainText('ComfyUI is not running at http://127.0.0.1:2397');
  await expect(page.locator('.topbar-sub')).toHaveText('ComfyUI offline');
  await page.locator('#gen-prompt').fill('a cat');
  await page.getByRole('button', { name: 'Generate tags' }).click();
  await expect(page.locator('.toast-error')).toContainText(/not running/);
  await expect(page.locator('.gen-tags').first()).toHaveValue('');

  await comfyOnline(true);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.locator('.banner-error[role="alert"]')).toHaveCount(0);
});
