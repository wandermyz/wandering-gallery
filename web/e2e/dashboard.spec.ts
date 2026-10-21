import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** What the fake vhotseat reports as holding the GPU (see e2e/fake-vhotseat.mjs). */
const GPU_MODE_FILE = '.tmp/fake-vhotseat-mode';
function gpuMode(mode: 'comfy' | 'none') {
  if (mode === 'comfy') return rmSync(GPU_MODE_FILE, { force: true });
  mkdirSync('.tmp', { recursive: true });
  writeFileSync(GPU_MODE_FILE, mode);
}

async function comfyOnline(online: boolean) {
  await fetch('http://127.0.0.1:2397/fake/online', { method: 'POST', body: JSON.stringify({ online }) });
}

async function noHorizontalScroll(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
}

test.beforeEach(async () => {
  await comfyOnline(true);
  gpuMode('comfy');
});

// parity: DASH-01
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

// parity: DASH-02
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

// parity: DASH-03
test('cancels a queued and a running job, also ones queued outside the app', async ({ page }) => {
  await page.goto('/generate/wai-illustrious-tags');
  await page.locator('.gen-tags').first().fill('masterpiece, cancel from dashboard');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'More images per variation' }).click();
  await page.getByRole('button', { name: /^Generate \d+ images$/ }).click();
  await expect(page.locator('.gen-run')).toHaveCount(1);
  // A job from elsewhere (ComfyUI's own page, a script), last in line.
  const r = await fetch('http://127.0.0.1:2397/prompt', {
    method: 'POST',
    body: JSON.stringify({ prompt: { 1: { class_type: 'SaveImage', inputs: { filename_prefix: 'outside' } } }, client_id: 'someone-else' }),
  });
  const outside = ((await r.json()) as { prompt_id: string }).prompt_id;
  const status = async (id: string) => ((await (await fetch(`http://127.0.0.1:2397/fake/jobs/${id}`)).json()) as { status: string }).status;

  await page.goto('/dashboard');
  const running = page.locator('.dash-running');
  await expect(running).toHaveCount(1);
  const theirs = page.locator('.dash-jobs').first().locator('.dash-job', { hasText: 'outside' });
  await expect(theirs).toBeVisible();
  await expect(running.getByRole('button', { name: /^Cancel / })).toBeVisible();
  await noHorizontalScroll(page);

  // Asks first, and Escape leaves it alone.
  await theirs.getByRole('button', { name: 'Cancel outside' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Remove this job from the queue?');
  await expect(page.getByRole('alertdialog')).toContainText('not queued from this app');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await status(outside)).toBe('queued');
  await theirs.getByRole('button', { name: 'Cancel outside' }).click();
  await page.getByRole('button', { name: 'Remove job' }).click();
  await expect(page.locator('.toast')).toContainText('Job removed from the queue');
  await expect(theirs).toHaveCount(0);
  expect(await status(outside)).toBe('cancelled');

  // The running one, queued from Generate.
  await running.getByRole('button', { name: /^Cancel / }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Stop this job?');
  await expect(page.getByRole('alertdialog')).toContainText('queued from Generate');
  await page.getByRole('button', { name: 'Stop job' }).click();
  await expect(page.locator('.toast').last()).toContainText('Job stopped');
  await expect(page.locator('.dash-job.dash-cancelled').first()).toBeVisible();

  // Generate sees the cancelled image; the rest of the run goes on.
  await page.goto('/generate/wai-illustrious-tags');
  const run = page.locator('.gen-run').first();
  await expect(run.locator('.gen-thumb-ph', { hasText: 'Cancelled' })).toHaveCount(1);
  await expect(run.locator('.cap-pill')).not.toHaveText('Running', { timeout: 20_000 });
  await expect(run.locator('.gen-thumb img').first()).toBeVisible();
});

// parity: DASH-06
test('cancels every queued and running job at once', async ({ page }) => {
  await page.goto('/generate/wai-illustrious-tags');
  await page.locator('.gen-tags').first().fill('masterpiece, cancel all');
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'More images per variation' }).click();
  await page.getByRole('button', { name: /^Generate \d+ images$/ }).click();
  await expect(page.locator('.gen-run')).toHaveCount(1);
  const r = await fetch('http://127.0.0.1:2397/prompt', {
    method: 'POST',
    body: JSON.stringify({ prompt: { 1: { class_type: 'SaveImage', inputs: { filename_prefix: 'outside-all' } } }, client_id: 'someone-else' }),
  });
  const outside = ((await r.json()) as { prompt_id: string }).prompt_id;
  const status = async (id: string) => ((await (await fetch(`http://127.0.0.1:2397/fake/jobs/${id}`)).json()) as { status: string }).status;

  await page.goto('/dashboard');
  const all = page.getByRole('button', { name: /^Cancel all \d+$/ });
  await expect(all).toBeVisible();
  await noHorizontalScroll(page);
  await all.click();
  await expect(page.getByRole('alertdialog')).toContainText(/Cancel all \d+ jobs\?/);
  await page.keyboard.press('Escape');
  expect(await status(outside)).toBe('queued');

  await all.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel all' }).click();
  await expect(page.locator('.toast')).toContainText(/Cancelled \d+ jobs/);
  await expect(page.locator('.dash-running')).toHaveCount(0);
  await expect(page.locator('.dash-comfy')).toContainText('The queue is empty.');
  await expect(all).toHaveCount(0);
  expect(await status(outside)).toBe('cancelled');

  // The run is over in Generate too.
  await page.goto('/generate/wai-illustrious-tags');
  await expect(page.locator('.gen-run .cap-pill', { hasText: 'Running' })).toHaveCount(0, { timeout: 20_000 });
});

// parity: DASH-04
test('rejects a job id that is not one', async ({ request }) => {
  const csrf = (await (await request.get('/api/session')).json()).csrf;
  const r = await request.post('/api/dashboard/jobs/--help/cancel', { headers: { 'x-csrf-token': csrf } });
  expect(r.status()).toBe(400);
});

// parity: DASH-05
test('says the GPU is free when nothing holds it', async ({ page }) => {
  gpuMode('none');
  try {
    await page.goto('/dashboard');
    const card = page.locator('section', { has: page.locator('#dash-wl-h') });
    await expect(card.locator('.cap-pill')).toHaveText('Free');
    await expect(card).toContainText('Nothing holds the GPU; whichever side asks next loads.');
    await expect(card).toContainText('Switched to none');
  } finally {
    gpuMode('comfy');
  }
});
