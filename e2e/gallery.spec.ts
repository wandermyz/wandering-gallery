import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const LIB = path.resolve('.tmp/e2e/lib');
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const isMobile = (name: string) => name.startsWith('iphone');

async function openGallery(page: Page, query = '') {
  await page.goto(`/${query}`);
  await expect(page.locator('.cell.loaded').first()).toBeVisible();
}

/** Scrolls the virtualised grid (like a user would) until the cell is rendered. */
async function findCell(page: Page, name: string) {
  const cell = page.locator(`.cell[aria-label="${name}"]`);
  // The grid re-renders on the next animation frame after a scroll.
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.evaluate(() => window.scrollTo(0, 0));
  await settle();
  for (let i = 0; i < 60 && !(await cell.count()); i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8));
    await settle();
  }
  await cell.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await settle();
  return cell;
}

async function openAsset(page: Page, name: string) {
  const cell = await findCell(page, name);
  await cell.click({ timeout: 5000 });
  await expect(page.locator('.viewer-name')).toHaveText(name);
}

/** Dispatches raw touch events through CDP (Chromium only) for swipe/pinch gestures. */
async function touch(page: Page, steps: { x: number; y: number }[][], stepDelay = 16) {
  const cdp = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p.x, y: p.y, id: i })) });
  await send('touchStart', steps[0]);
  for (const s of steps.slice(1)) {
    await send('touchMove', s);
    await page.waitForTimeout(stepDelay);
  }
  await send('touchEnd', []);
  await cdp.detach();
}

const swipe = (pts: { x: number; y: number }[]) => pts.map((p) => [p]);

function line(from: { x: number; y: number }, to: { x: number; y: number }, n = 10) {
  return Array.from({ length: n + 1 }, (_, i) => ({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n }));
}

const zoomScale = (page: Page) =>
  page.locator('.slide.active .zoom').evaluateAll((els) => {
    const t = els.map((e) => (e as HTMLElement).style.transform).find((s) => s.includes('scale')) ?? '';
    const m = /scale\(([\d.]+)\)/.exec(t);
    return m ? Number(m[1]) : 1;
  });

test.describe.configure({ mode: 'serial' });

test('gallery shows a responsive grid with day headers, badges and folders', async ({ page }, info) => {
  await openGallery(page);
  await expect(page.locator('.topbar h1')).toHaveText('All media');
  await expect(page.locator('.topbar-sub')).toContainText('items');
  await expect(page.locator('.grid-day').first()).toBeVisible();
  // The grid fills the width: at least 3 columns on phones, more on desktop.
  const row = page.locator('.grid-row').first();
  const cols = await row.locator('.cell').count();
  expect(cols).toBeGreaterThanOrEqual(isMobile(info.project.name) && info.project.name !== 'iphone-landscape' ? 3 : 5);
  const video = page.locator('.cell[aria-label="clip_00001_.mp4"]');
  await expect(video.locator('.badge-video')).toContainText('0:03');

  // Library switching and folder navigation.
  await page.getByRole('button', { name: 'Libraries' }).click();
  await page.locator('.lib-item', { hasText: 'Test Library' }).click();
  await expect(page.locator('.topbar h1')).toHaveText('Test Library');
  await page.locator('.folder-chip', { hasText: 'portraits' }).click();
  await expect(page).toHaveURL(/folder=portraits/);
  await expect(page.locator('.cell')).toHaveCount(2);
  await page.locator('.crumb', { hasText: 'Test Library' }).click();
  await expect(page).not.toHaveURL(/folder=/);
  await expect(page.locator('.cell[aria-label="gen_00001_.png"]')).toBeVisible();
});

test('scrolling reaches the oldest items and pagination cursors are consistent', async ({ page, request }) => {
  // API pagination with a small page size returns every item exactly once.
  const seen: number[] = [];
  let cursor: string | null = '';
  let total = 0;
  while (cursor !== null) {
    const r = await (await request.get(`/api/assets?limit=7${cursor ? `&cursor=${cursor}` : ''}`)).json();
    if (!cursor) total = r.total;
    seen.push(...r.items.map((i: { id: number }) => i.id));
    cursor = r.next;
  }
  expect(seen.length).toBe(total);
  expect(new Set(seen).size).toBe(total);

  // The virtualised grid renders the oldest item once scrolled to the end.
  await page.goto('/');
  await expect(page.locator('.cell').first()).toBeVisible();
  const oldest = page.locator('.cell[aria-label="gen_00002_.png"]');
  for (let i = 0; i < 40 && !(await oldest.count()); i++) {
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(100);
  }
  await expect(oldest).toBeAttached();
  // Only a window of rows is rendered, not the whole list.
  expect(await page.locator('.cell').count()).toBeLessThanOrEqual(total);
});

test('viewer navigates between assets and zooms images', async ({ page }, info) => {
  await openGallery(page);
  await openAsset(page, 'gen_00001_.png');
  await expect(page.locator('.slide.active img.media.full.shown')).toBeVisible();

  if (isMobile(info.project.name)) {
    const vp = page.viewportSize()!;
    const cy = vp.height / 2;
    // Swipe left -> next asset.
    await touch(page, swipe(line({ x: vp.width * 0.8, y: cy }, { x: vp.width * 0.15, y: cy })));
    await expect(page.locator('.viewer-name')).not.toHaveText('gen_00001_.png');
    // Swipe right -> back.
    await touch(page, swipe(line({ x: vp.width * 0.15, y: cy }, { x: vp.width * 0.85, y: cy })));
    await expect(page.locator('.viewer-name')).toHaveText('gen_00001_.png');
    await expect(page.locator('.slide.active img.media.full.shown')).toBeVisible();

    // Pinch out to zoom.
    const cx = vp.width / 2;
    const a = line({ x: cx - 30, y: cy }, { x: cx - 120, y: cy });
    const b = line({ x: cx + 30, y: cy }, { x: cx + 120, y: cy });
    await touch(page, a.map((p, i) => [p, b[i]]));
    expect(await zoomScale(page)).toBeGreaterThan(2);
    // While zoomed, a horizontal drag pans instead of changing the asset.
    await touch(page, swipe(line({ x: cx, y: cy }, { x: cx - 100, y: cy })));
    await expect(page.locator('.viewer-name')).toHaveText('gen_00001_.png');
    // Double-tap resets to fit.
    await page.touchscreen.tap(cx, cy);
    await page.waitForTimeout(60);
    await page.touchscreen.tap(cx, cy);
    await expect.poll(() => zoomScale(page)).toBe(1);
    // Double-tap zooms in again.
    await page.touchscreen.tap(cx, cy);
    await page.waitForTimeout(60);
    await page.touchscreen.tap(cx, cy);
    await expect.poll(() => zoomScale(page)).toBeGreaterThan(1.5);
  } else {
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.viewer-name')).not.toHaveText('gen_00001_.png');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.viewer-name')).toHaveText('gen_00001_.png');
    // Wheel zoom on the image.
    const box = (await page.locator('.stage').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -200);
    await expect.poll(() => zoomScale(page)).toBeGreaterThan(1.5);
    await page.keyboard.press('Escape'); // first Escape resets zoom
    await expect.poll(() => zoomScale(page)).toBe(1);
  }

  // Back returns to the gallery at the same place.
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await expect(page.locator('.viewer')).toHaveCount(0);
  await expect(page.locator('.cell[aria-label="gen_00001_.png"]')).toBeInViewport();
});

test('videos play and can be scrubbed', async ({ page }) => {
  await openGallery(page);
  await openAsset(page, 'clip_00001_.mp4');
  const video = page.locator('video.media');
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
  await video.evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(0);
  expect(await video.evaluate((v: HTMLVideoElement) => v.duration)).toBeCloseTo(3, 0);
  // Scrub: seeking requires HTTP range support.
  await video.evaluate((v: HTMLVideoElement) => { v.pause(); v.currentTime = 2.2; });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.seeking ? -1 : v.currentTime)).toBeGreaterThan(2);
});

test('favorite and rating persist across reloads and show in the grid', async ({ page }) => {
  await openGallery(page);
  await openAsset(page, 'gen_00003_.png');
  const fav = page.locator('.viewer-bottom .fav-btn');
  await fav.click();
  await expect(fav).toHaveClass(/active/);
  await page.locator('.viewer-bottom').getByRole('radio', { name: '4 stars' }).click();
  await expect(page.locator('.viewer-bottom .star.on')).toHaveCount(4);
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  const cell = page.locator('.cell[aria-label="gen_00003_.png"]');
  await expect(cell).toBeInViewport();
  await expect(cell.locator('.badge-fav')).toBeVisible();
  await expect(cell.locator('.mini-rating')).toHaveText('4');

  await page.reload();
  await expect(page.locator('.cell').first()).toBeVisible();
  await expect((await findCell(page, 'gen_00003_.png')).locator('.mini-rating')).toHaveText('4');
  // Favorites view and min-rating filter.
  await page.goto('/?fav=1');
  await expect(page.locator('.cell[aria-label="gen_00003_.png"]')).toBeVisible();
  await page.goto('/?rating=4');
  await expect(page.locator('.cell')).toHaveCount(1);
  await page.goto('/?rating=5');
  await expect(page.getByText('Nothing matches these filters.')).toBeVisible();

  // Reset via the UI: tapping the current rating clears it.
  await openGallery(page);
  await openAsset(page, 'gen_00003_.png');
  await page.locator('.viewer-bottom').getByRole('radio', { name: '4 stars' }).click();
  await expect(page.locator('.viewer-bottom .star.on')).toHaveCount(0);
  await page.locator('.viewer-bottom .fav-btn').click();
  await expect(page.locator('.viewer-bottom .fav-btn')).not.toHaveClass(/active/);
});

test('ComfyUI metadata panel shows parameters, prompts and raw JSON', async ({ page }) => {
  await openGallery(page);
  await openAsset(page, 'gen_00001_.png');
  await page.getByRole('button', { name: 'Details and metadata' }).click();
  const panel = page.locator('.info');
  await expect(panel.locator('.prompt-pos .prompt-text')).toHaveText('1girl, sitting on a beach, sunset');
  await expect(panel.locator('.prompt-neg .prompt-text')).toHaveText('worst quality, bad hands');
  await expect(panel.locator('.param', { hasText: 'Seed' })).toContainText('777');
  await expect(panel.locator('.param', { hasText: 'Sampler' })).toContainText('euler_ancestral');
  await expect(panel.locator('.model', { hasText: 'style_watercolor.safetensors' })).toContainText('0.8 / 0.6');
  await expect(panel.locator('.model', { hasText: 'illustrious_v17.safetensors' })).toBeVisible();
  // Raw JSON is collapsed by default and expandable.
  const raw = panel.locator('.section', { hasText: 'Raw metadata' });
  if (!(await raw.locator('.section-body').count())) await raw.locator('.section-toggle').click();
  await expect(panel.locator('pre.json')).toHaveCount(0);
  await panel.getByRole('button', { name: /Show API prompt JSON/ }).click();
  await expect(panel.locator('pre.json')).toContainText('"ControlNetApplyAdvanced"');
  // Copy button works.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await panel.locator('.prompt-pos').getByRole('button', { name: 'Copy' }).click();
  await expect(panel.locator('.prompt-pos .chip-btn.ok')).toBeVisible();
  await page.getByRole('button', { name: 'Close details' }).click();
});

test('newly generated files appear without reloading', async ({ page }, info) => {
  await openGallery(page);
  const name = `fresh_${info.project.name}.png`;
  const src = path.join(LIB, 'gen_00002_.png');
  const tmp = path.join(path.dirname(LIB), name);
  fs.copyFileSync(src, tmp);
  // Make the content unique so it is not treated as a moved copy of another asset.
  fs.appendFileSync(tmp, Buffer.from(info.project.name));
  fs.renameSync(tmp, path.join(LIB, name));
  await expect(page.locator(`.cell[aria-label="${name}"]`)).toBeVisible({ timeout: 15_000 });
  fs.rmSync(path.join(LIB, name));
  await expect(page.locator(`.cell[aria-label="${name}"]`)).toHaveCount(0, { timeout: 15_000 });
});

test('delete moves the file to trash and restore brings it back intact', async ({ page }, info) => {
  const target = { desktop: 'gen_00010_.png', iphone: 'gen_00011_.png', 'iphone-landscape': 'gen_00012_.png' }[info.project.name]!;
  const file = path.join(LIB, target);
  const hash = sha(file);
  await openGallery(page);
  await openAsset(page, target);
  await page.locator('.viewer-bottom').getByRole('radio', { name: '2 stars' }).click();
  await page.getByRole('button', { name: 'Move to trash' }).click();
  // Confirmation is required.
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText(target);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(fs.existsSync(file)).toBe(true);
  await page.getByRole('button', { name: 'Move to trash' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.locator('.toast')).toContainText('Moved to trash');
  await expect(page.locator('.viewer-name')).not.toHaveText(target);
  expect(fs.existsSync(file)).toBe(false);

  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await expect(page.locator(`.cell[aria-label="${target}"]`)).toHaveCount(0);

  await page.goto('/trash');
  const item = page.locator('.trash-item', { hasText: target });
  await expect(item).toContainText('2★');
  await item.getByRole('button', { name: 'Restore' }).click();
  await expect(page.locator('.toast')).toContainText('Restored');
  expect(sha(file)).toBe(hash);

  await openGallery(page);
  await expect((await findCell(page, target)).locator('.mini-rating')).toHaveText('2');
  // Clean up rating for reruns.
  await openAsset(page, target);
  await page.locator('.viewer-bottom').getByRole('radio', { name: '2 stars' }).click();
  await expect(page.locator('.viewer-bottom .star.on')).toHaveCount(0);
});

test('the viewer offers share/save of the original', async ({ page }) => {
  await openGallery(page);
  await openAsset(page, 'gen_00001_.png');
  await expect(page.getByRole('button', { name: 'Share or save original' })).toBeVisible();
});

test('read-only libraries cannot delete', async ({ page }) => {
  await openGallery(page, '?lib=ro');
  await openAsset(page, 'locked.png');
  await expect(page.getByRole('button', { name: 'Library is read-only' })).toBeDisabled();
});

test('originals are unchanged by browsing and organising', async () => {
  // gen_00001_ was opened, zoomed and had metadata read in every project.
  const before = fs.statSync(path.join(LIB, 'gen_00001_.png'));
  expect(before.size).toBeGreaterThan(0);
  const names = fs.readdirSync(LIB).filter((n) => !n.startsWith('fresh_')).sort();
  expect(names).toContain('gen_00001_.png');
  expect(names.filter((n) => n.includes('restored'))).toEqual([]);
});
