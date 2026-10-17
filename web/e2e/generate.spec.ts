import { expect, test, type Page } from '@playwright/test';

const FLOW = '/generate/wai-illustrious-tags';

async function comfyOnline(online: boolean) {
  await fetch('http://127.0.0.1:2397/fake/online', { method: 'POST', body: JSON.stringify({ online }) });
}

async function noHorizontalScroll(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
}

/** On touch devices every text field is at least 16px, or iOS Safari zooms in when it is focused. */
async function noFocusZoom(page: Page, project: string) {
  if (!project.startsWith('iphone')) return;
  const sizes = await page.locator('input:not([type=checkbox], [type=radio], [type=range], [type=file]), textarea, select')
    .evaluateAll((els) => els.map((el) => parseFloat(getComputedStyle(el).fontSize)));
  expect(sizes.length).toBeGreaterThan(0);
  for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16);
}

test.beforeEach(async ({ page }) => {
  await comfyOnline(true);
});

// parity: GEN-01
test('describe, tag variations, edit them and generate a batch', async ({ page }, info) => {
  await page.goto('/generate');
  await expect(page).toHaveURL(new RegExp(`${FLOW}$`));
  await expect(page.locator('.topbar h1')).toHaveText('WAI-Illustrious · prompt to tags');
  await expect(page.locator('.topbar-sub')).toHaveText('ComfyUI · Fake GPU');

  await expect(page.getByRole('button', { name: 'Generate tags' })).toBeDisabled();
  // Quality tags are prefilled.
  await expect(page.locator('.gen-tags').first()).toHaveValue('masterpiece');
  await page.locator('#gen-prompt').fill('a girl at the beach');
  await page.getByRole('button', { name: 'More tag variations' }).click();
  await page.getByRole('button', { name: 'More tag variations' }).click();
  await expect(page.locator('.gen-var')).toHaveCount(3);
  await noFocusZoom(page, info.project.name);
  await page.getByRole('button', { name: 'Generate tags' }).click();

  const tags = page.locator('.gen-tags');
  await expect(tags.nth(0)).toHaveValue('masterpiece, 1girl, base tags for a girl at the beach');
  await expect(tags.nth(1)).toHaveValue('masterpiece, 1girl, varied tags for a girl at the beach');
  await expect(tags.nth(2)).toHaveValue(/varied tags/);

  // Edit one, drop one, regenerate one.
  await tags.nth(1).fill('1girl, edited tags');
  await page.getByRole('button', { name: 'Remove variation 3' }).click();
  await expect(page.locator('.gen-var')).toHaveCount(2);
  await page.getByRole('button', { name: 'Regenerate variation 1' }).click();
  await expect(tags.nth(0)).toHaveValue(/base tags/);
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
  // The form and the finished run are still there.
  await expect(page.locator('.gen-run').first().locator('a.gen-thumb')).toHaveCount(4);
  await expect(tags.nth(1)).toHaveValue('1girl, edited tags');

  // Reuse puts the run's prompt and tags back into the form.
  await page.locator('#gen-prompt').fill('something else');
  await page.locator('.gen-run').first().getByRole('button', { name: 'Reuse' }).click();
  await expect(page.locator('#gen-prompt')).toHaveValue('a girl at the beach');

  // Clear removes finished runs from the page.
  await page.locator('.gen-h2-row').getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.gen-run')).toHaveCount(0);

  // A reload starts blank: finished runs and the form are not kept.
  await page.locator('#gen-prompt').fill('draft');
  await page.reload();
  await expect(page.locator('#gen-prompt')).toHaveValue('');
  await expect(page.locator('.gen-var')).toHaveCount(1);
  await expect(page.locator('.gen-run')).toHaveCount(0);
});

// parity: GEN-02
test('tags typed by hand generate images without a description', async ({ page }) => {
  await page.goto('/generate/wai-illustrious-lora-mycat');
  const tags = page.locator('.gen-tags').first();
  await expect(tags).toHaveValue('masterpiece, mycat, cat');
  await expect(page.getByRole('button', { name: 'Generate tags' })).toBeDisabled();
  await tags.fill('masterpiece, mycat, cat, sleeping, sofa');
  await page.getByRole('button', { name: 'Fewer images per variation' }).click();
  await page.getByRole('button', { name: 'Generate 2 images' }).click();
  const run = page.locator('.gen-run').first();
  await expect(run.locator('.gen-run-prompt')).toHaveCount(0);
  await expect(run.locator('.gen-run-tags')).toContainText('masterpiece, mycat, cat, sleeping, sofa');
  await expect(run.locator('a.gen-thumb')).toHaveCount(2, { timeout: 20_000 });
});

// parity: GEN-03
test('a run still in progress shows again after a reload', async ({ page }) => {
  await page.goto(FLOW);
  await page.locator('#gen-prompt').fill('slow run');
  await page.locator('.gen-tags').first().fill('1girl, by hand');
  await page.getByRole('button', { name: 'More images per variation' }).click();
  await page.getByRole('button', { name: 'Generate 4 images' }).click();
  await expect(page.locator('.gen-run .cap-pill')).toHaveText('Running');
  await page.reload();
  const run = page.locator('.gen-run');
  await expect(run).toHaveCount(1);
  await expect(run.locator('.gen-run-prompt')).toHaveText('slow run');
  await expect(run.locator('a.gen-thumb')).toHaveCount(4, { timeout: 20_000 });
  await expect(run.locator('.cap-pill')).toHaveText('Done');
});

// parity: GEN-04
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

// parity: GEN-05
test('shows an error when ComfyUI is not running', async ({ page }) => {
  await comfyOnline(false);
  await page.goto(FLOW);
  await expect(page.locator('.banner-error[role="alert"]')).toContainText('ComfyUI is not running at http://127.0.0.1:2397');
  await expect(page.locator('.topbar-sub')).toHaveText('ComfyUI offline');
  await page.locator('.gen-tags').first().fill('masterpiece, 1girl');
  await page.getByRole('button', { name: 'Generate 3 images' }).click();
  // The fake answers /prompt with a 503 rather than refusing the connection.
  await expect(page.locator('.toast-error')).toContainText(/ComfyUI .*offline/);
  await expect(page.locator('.gen-run')).toHaveCount(0);

  await comfyOnline(true);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.locator('.banner-error[role="alert"]')).toHaveCount(0);
});

// parity: GEN-06
test('a LoRA flow has the same form, with its trigger tags in front', async ({ page }) => {
  await page.goto('/generate/wai-illustrious-lora-mycat');
  await expect(page.locator('.topbar h1')).toHaveText('WAI-Illustrious · My cat LoRA');
  await page.locator('#gen-prompt').fill('a cat on a sofa');
  await page.getByRole('button', { name: 'Generate tags' }).click();
  await expect(page.locator('.gen-tags').first()).toHaveValue('masterpiece, mycat, cat, 1girl, base tags for a cat on a sofa');
  await page.getByRole('button', { name: 'Fewer images per variation' }).click();
  await page.getByRole('button', { name: 'Generate 2 images' }).click();
  const run = page.locator('.gen-run').first();
  await expect(run.locator('a.gen-thumb')).toHaveCount(2, { timeout: 20_000 });
  await noHorizontalScroll(page);
  // The plain flow's form is separate.
  await page.goto(FLOW);
  await expect(page.locator('#gen-prompt')).toHaveValue('');
});

// parity: GEN-07
test('copy an image path in the viewer, paste it into the video flow and generate a video', async ({ page }, info) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await page.goto('/gallery?lib=lib');
  await page.getByRole('button', { name: 'gen_00001_.png' }).click();
  await expect(page.locator('.viewer-name')).toHaveText('gen_00001_.png');
  await page.getByRole('button', { name: 'Copy path' }).click();
  await expect(page.getByRole('button', { name: 'Path copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/\/\.tmp\/e2e\/lib\/gen_00001_\.png$/);

  await page.goto('/generate/minimax-h3-i2v');
  await expect(page.locator('.topbar h1')).toHaveText('MiniMax H3 · image to video');
  const go = page.getByRole('button', { name: 'Generate video' });
  await expect(go).toBeDisabled();
  await page.getByRole('button', { name: 'Paste' }).click();
  await expect(page.locator('#vid-path')).toHaveValue(copied);
  await expect(page.locator('.vid-preview img')).toBeVisible();
  await expect(page.locator('.vid-preview figcaption')).toContainText('gen_00001_.png · 832×1216');
  await noFocusZoom(page, info.project.name);

  // Lengths: 5 s is the default.
  await expect(page.getByRole('radio', { name: '5 s', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: '10 s', exact: true }).click();
  await expect(go).toBeDisabled();
  await page.locator('#vid-prompt').fill('the colors slowly shift');
  await go.click();

  const run = page.locator('.gen-run').first();
  await expect(run.locator('.gen-run-title')).toContainText('10 s');
  await expect(run.locator('.gen-run-tags')).toContainText('gen_00001_.png');
  await expect(run.locator('a.gen-thumb')).toHaveCount(1, { timeout: 20_000 });
  await expect(run.locator('.cap-pill')).toHaveText('Done');
  await noHorizontalScroll(page);
  // The image went to ComfyUI's input folder under a content-derived name.
  const inputs = await (await fetch('http://127.0.0.1:2397/fake/inputs')).json();
  expect(inputs.files).toEqual([expect.stringMatching(/^wg_[0-9a-f]{16}\.png$/)]);

  await run.locator('a.gen-thumb').click();
  await expect(page.locator('.viewer-name')).toHaveText(/^fake_\d+_\.mp4$/);
});

// parity: GEN-08
test('the video flow explains a path that is not a gallery image', async ({ page }) => {
  await page.goto('/generate/minimax-h3-i2v');
  await page.locator('#vid-path').fill('/etc/passwd');
  await page.locator('#vid-path').press('Enter');
  await expect(page.locator('.vid-error')).toHaveText('not an image in the gallery');
  await expect(page.locator('.vid-preview')).toHaveCount(0);
});
