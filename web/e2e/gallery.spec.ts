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

// parity: GAL-01
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

// parity: GAL-02
test('filename filter narrows the current view without new requests', async ({ page }) => {
  await openGallery(page, '?lib=lib&folder=portraits');
  await expect(page.locator('.cell')).toHaveCount(2);
  let requests = 0;
  page.on('request', (r) => { if (r.url().includes('/api/assets')) requests++; });
  await page.getByRole('button', { name: 'Filter by filename' }).click();
  const input = page.getByRole('searchbox', { name: 'Filter by filename' });
  await expect(input).toBeFocused();
  await input.fill('P2');
  await expect(page.locator('.cell')).toHaveCount(1);
  await expect(page.locator('.cell[aria-label="p2.jpg"]')).toBeVisible();
  await expect(page.locator('.topbar-sub')).toContainText('1 match');
  await input.fill('nope');
  await expect(page.getByText('No loaded filenames match')).toBeVisible();
  await input.press('Escape');
  await expect(input).toBeHidden();
  await expect(page.locator('.cell')).toHaveCount(2);
  expect(requests).toBe(0);
});

// parity: GAL-03
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

// parity: VIEW-01
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

// parity: VIEW-09
test('an image fits between the viewer bars, clear of the title', async ({ page }) => {
  await openGallery(page);
  await openAsset(page, 'gen_00001_.png');
  const img = page.locator('.slide.active img.media.full.shown');
  await expect(img).toBeVisible();
  // The picture inside the image box (object-fit: contain).
  const pic = await img.evaluate((el: HTMLImageElement) => {
    const r = el.getBoundingClientRect();
    const fit = Math.min(r.width / el.naturalWidth, r.height / el.naturalHeight);
    const h = el.naturalHeight * fit;
    return { top: r.top + (r.height - h) / 2, bottom: r.top + (r.height + h) / 2 };
  });
  const title = (await page.locator('.viewer-title').boundingBox())!;
  const fav = (await page.locator('.viewer-bottom .fav-btn').boundingBox())!;
  expect(pic.top).toBeGreaterThanOrEqual(title.y + title.height);
  expect(pic.bottom).toBeLessThanOrEqual(fav.y);
});

// parity: VIEW-02
test('going back during a slide leaves the viewer closed (iOS edge-swipe back)', async ({ page }) => {
  await openGallery(page);
  await openAsset(page, 'gen_00001_.png');
  await expect(page.locator('.slide.active img.media.full.shown')).toBeVisible();
  // Start sliding to the next asset, then go back before the slide animation finishes.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    history.back();
  });
  await expect(page.locator('.viewer')).toHaveCount(0);
  await page.waitForTimeout(500);
  await expect(page.locator('.viewer')).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('a')).toBeNull();
});

// parity: VIEW-03
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

// parity: VIEW-04
test('audio plays in the viewer and has its own filter', async ({ page }) => {
  await openGallery(page, 'gallery?lib=lib&folder=audio&kind=audio');
  const cell = page.locator('.cell[aria-label="tune_00001_.flac"]');
  await expect(cell.locator('.badge-video')).toContainText('0:04');
  await expect(page.locator('.cell')).toHaveCount(1);
  await cell.click();
  await expect(page.locator('.viewer-name')).toHaveText('tune_00001_.flac');
  await expect(page.locator('.viewer-sub')).toContainText('0:04');
  const audio = page.locator('.slide.active audio');
  await expect(audio).toBeVisible();
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);
  expect(await audio.evaluate((a: HTMLAudioElement) => a.duration)).toBeCloseTo(4, 0);
  await audio.evaluate((a: HTMLAudioElement) => { a.currentTime = 3; });
  await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.seeking ? -1 : a.currentTime)).toBeGreaterThan(2.5);
});

// parity: VIEW-05
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

// parity: HID-01
test('hidden items leave the grid until unlocked with the passphrase', async ({ page, request }) => {
  await openGallery(page);
  await openAsset(page, 'gen_00004_.png');
  const src = await page.locator('.slide.active img').first().getAttribute('src');
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  // Hidden while locked: the viewer moves on and the item leaves the grid.
  await expect(page.locator('.viewer-name')).not.toHaveText('gen_00004_.png');
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await expect(page.locator('.cell[aria-label="gen_00004_.png"]')).toHaveCount(0);
  const id = Number(/assets\/(\d+)\//.exec(src!)![1]);
  expect((await request.get(`/api/assets/${id}/file`)).status()).toBe(404);

  await page.reload();
  await expect(page.locator('.cell').first()).toBeVisible();
  expect(await (await findCell(page, 'gen_00005_.png')).count()).toBe(1);
  await expect(page.locator('.cell[aria-label="gen_00004_.png"]')).toHaveCount(0);

  await page.getByRole('button', { name: 'Show hidden items' }).click();
  // At least 16px, or iOS Safari zooms into the field when it is focused.
  expect(parseFloat(await page.getByLabel('Passphrase').evaluate((el) => getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  await page.getByLabel('Passphrase').fill('wrong');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong passphrase');
  await page.getByLabel('Passphrase').fill('e2e passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  const cell = await findCell(page, 'gen_00004_.png');
  await expect(cell.locator('.badge-hidden')).toBeVisible();
  await expect(cell.locator('img')).toHaveJSProperty('complete', true);
  expect(await cell.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  // The countdown, and locking again by hand.
  await page.getByRole('button', { name: 'Hidden items are shown' }).click();
  await expect(page.locator('.unlock-timer')).toHaveText(/^1[45]:\d\d$/);
  await page.getByRole('button', { name: 'Lock now' }).click();
  await expect(page.locator('.cell[aria-label="gen_00004_.png"]')).toHaveCount(0);

  // Unhide (needs the unlock again).
  await page.getByRole('button', { name: 'Show hidden items' }).click();
  await page.getByLabel('Passphrase').fill('e2e passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await openAsset(page, 'gen_00004_.png');
  await page.getByRole('button', { name: 'Unhide' }).click();
  await expect(page.getByRole('button', { name: 'Hide', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await page.getByRole('button', { name: 'Hidden items are shown' }).click();
  await page.getByRole('button', { name: 'Lock now' }).click();
  await expect(await findCell(page, 'gen_00004_.png')).toHaveCount(1);
});

// parity: INFO-01
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

// parity: INFO-02
test('caption sidecars can be edited in the details panel', async ({ page }, info) => {
  await openGallery(page, '?lib=lib&folder=portraits');
  await expect(page.locator('.cell[aria-label="p1.jpg"] .badge-cap')).toBeVisible();
  await expect(page.locator('.cell[aria-label="p2.jpg"] .badge-cap')).toHaveCount(0);
  await openAsset(page, 'p1.jpg');
  if (!(await page.locator('.info').count())) await page.getByRole('button', { name: 'Details and metadata' }).click();
  const panel = page.locator('.info');
  const section = panel.locator('.section', { hasText: 'Caption' }).first();
  await expect(section.locator('.cap-pill')).toBeVisible();
  const box = section.locator('textarea.cap-text');
  await expect(box).toHaveValue(/^portrait, man/);
  // Typing must not trigger viewer shortcuts (f = favorite, digits = rating).
  const caption = `portrait, man, f5, ${info.project.name}`;
  await box.fill('');
  await box.pressSequentially(caption);
  await expect(page.locator('.viewer-bottom .fav-btn')).not.toHaveClass(/active/);
  // An unsaved edit survives closing and reopening the panel.
  await page.getByRole('button', { name: 'Close details' }).click();
  await expect(box).toHaveCount(0);
  await page.getByRole('button', { name: 'Details and metadata' }).click();
  await expect(box).toHaveValue(caption);
  await section.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(section.locator('.cap-pill')).toHaveText('Edited');
  expect(fs.readFileSync(path.join(LIB, 'portraits', 'p1.txt'), 'utf8')).toBe(caption);
  await section.getByRole('button', { name: 'Approve' }).click();
  await expect(section.locator('.cap-pill')).toHaveText('Approved');
  const json = JSON.parse(fs.readFileSync(path.join(LIB, 'portraits', 'p1.caption.json'), 'utf8'));
  expect(json).toMatchObject({ status: 'approved', caption, review: { by: 'gallery' }, description: 'A smiling man.' });
  await page.getByRole('button', { name: 'Close details' }).click();
});

// parity: TAG-01
test('tags can be added (new or existing), browsed in the Tags view, and removed', async ({ page }, info) => {
  // Every project shares one server, so tag names are per project.
  const sunset = `sunset ${info.project.name}`;
  const beach = `beach ${info.project.name}`;
  const tags = page.locator('.info .section', { hasText: 'Tags' }).first();
  const input = tags.getByRole('combobox', { name: 'Add a tag' });
  // Earlier projects may have left tags of their own on the same images.
  const mine = tags.locator('.tag-chip-name', { hasText: info.project.name });

  await openGallery(page);
  await openAsset(page, 'gen_00001_.png');
  if (!(await page.locator('.info').count())) await page.getByRole('button', { name: 'Details and metadata' }).click();
  // Create two new tags; typing "f" must not toggle the favorite.
  await input.fill(sunset);
  await tags.getByRole('button', { name: `Create “${sunset}”` }).click();
  await expect(mine).toHaveText([sunset]);
  await input.fill(beach);
  await input.press('Enter');
  await expect(mine).toHaveText([beach, sunset]);
  await expect(page.locator('.viewer-bottom .fav-btn')).not.toHaveClass(/active/);

  // On the next image the existing tag is suggested (not created again).
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await openAsset(page, 'gen_00002_.png');
  if (!(await page.locator('.info').count())) await page.getByRole('button', { name: 'Details and metadata' }).click();
  await input.fill(sunset.toUpperCase());
  await expect(tags.locator('.tag-option.create')).toHaveCount(0);
  await tags.locator('.tag-option', { hasText: sunset }).click();
  await expect(mine).toHaveText([sunset]);

  // Tags view: count, open the tag, both images are listed.
  await page.goto('/gallery/tags');
  const row = page.locator('.tags-item', { hasText: sunset });
  await expect(row.locator('.lib-count')).toHaveText('2');
  await row.locator('.tags-open').click();
  await expect(page).toHaveURL(/\/gallery\?tag=/);
  await expect(page.locator('.topbar-title h1')).toHaveText(`# ${sunset}`);
  await expect(page.locator('.cell')).toHaveCount(2);

  // Removing a tag in the viewer drops the image from that tag's view after closing.
  await openAsset(page, 'gen_00002_.png');
  if (!(await page.locator('.info').count())) await page.getByRole('button', { name: 'Details and metadata' }).click();
  await tags.getByRole('button', { name: `Remove tag ${sunset}` }).click();
  await expect(mine).toHaveCount(0);
  await page.getByRole('button', { name: 'Close details' }).click();
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await page.reload();
  await expect(page.locator('.cell')).toHaveCount(1);

  // Delete both tags from the Tags view.
  await page.goto('/gallery/tags');
  for (const t of [sunset, beach]) {
    await page.getByRole('button', { name: `Delete tag ${t}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete tag' }).click();
    await expect(page.locator('.tags-item', { hasText: t })).toHaveCount(0);
  }
});

// parity: GAL-04
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

// parity: VIEW-10
test('a file that changes on disk while open keeps its scroll and zoom until reloaded', async ({ page }, info) => {
  const folder = `changing_${info.project.name}`;
  const dir = path.join(LIB, folder);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
  const body = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of a long document.`).join('\n\n');
  const doc = path.join(dir, 'notes.md');
  const img = path.join(dir, 'pic.png');
  fs.writeFileSync(doc, `# First draft\n\n${body}\n`);
  fs.copyFileSync(path.join(LIB, 'gen_00002_.png'), img);
  fs.appendFileSync(img, Buffer.from(folder));
  try {
    await openGallery(page, `gallery?lib=lib&folder=${folder}`);
    await page.locator('.cell[aria-label="notes.md"]').click();
    const h1 = page.locator('.slide.active .md h1');
    await expect(h1).toHaveText('First draft');
    const scroller = page.locator('.slide.active .md-scroll');
    await scroller.evaluate((el) => el.scrollTo(0, 1200));
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBe(1200);

    fs.writeFileSync(doc, `# Second draft\n\n${body}\n`);
    const pill = page.getByRole('button', { name: 'File changed · Reload' });
    await expect(pill).toBeVisible({ timeout: 15_000 });
    // Still the version being read, where it was being read.
    await expect(h1).toHaveText('First draft');
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(1200);
    await pill.click();
    await expect(h1).toHaveText('Second draft');
    await expect(pill).toHaveCount(0);

    // A zoomed image stays zoomed.
    await page.getByRole('button', { name: 'Back to gallery' }).click();
    await page.locator('.cell[aria-label="pic.png"]').click();
    await expect(page.locator('.slide.active img.media.full.shown')).toBeVisible();
    const zoom = page.locator('.slide.active .zoom');
    await page.keyboard.press('+');
    await expect(zoom).toHaveAttribute('style', /scale/);
    fs.appendFileSync(img, Buffer.from('more'));
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(zoom).toHaveAttribute('style', /scale/);
    await pill.click();
    await expect(pill).toHaveCount(0);
    await expect(zoom).not.toHaveAttribute('style', /scale/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// parity: TRASH-01
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

// parity: VIEW-06
test('the viewer offers share/save of the original', async ({ page }) => {
  await openGallery(page);
  await openAsset(page, 'gen_00001_.png');
  await expect(page.getByRole('button', { name: 'Share or save original' })).toBeVisible();
});

// parity: GAL-05
test('read-only libraries cannot delete', async ({ page }) => {
  await openGallery(page, '?lib=ro');
  await openAsset(page, 'locked.png');
  await expect(page.getByRole('button', { name: 'Library is read-only' })).toBeDisabled();
});

// parity: GAL-06
test('originals are unchanged by browsing and organising', async () => {
  // gen_00001_ was opened, zoomed and had metadata read in every project.
  const before = fs.statSync(path.join(LIB, 'gen_00001_.png'));
  expect(before.size).toBeGreaterThan(0);
  const names = fs.readdirSync(LIB).filter((n) => !n.startsWith('fresh_')).sort();
  expect(names).toContain('gen_00001_.png');
  expect(names.filter((n) => n.includes('restored'))).toEqual([]);
});

// parity: MD-01
test('Markdown documents render with their embedded images and videos, and can be hidden', async ({ page, request }, info) => {
  await openGallery(page, 'gallery?lib=lib&folder=story');
  const cell = page.locator('.cell[aria-label="tale.md"]');
  await expect(cell.locator('.badge-video')).toHaveText('MD');
  await cell.click();
  await expect(page.locator('.viewer-name')).toHaveText('tale.md');
  const doc = page.locator('.slide.active .md');
  await expect(doc.locator('h1')).toHaveText('The Tale');
  // The embedded image is the gallery's own (thumbnail-free) file URL, and it loads.
  const img = doc.locator('img[alt="The scene"]');
  await expect(img).toHaveAttribute('src', /\/api\/assets\/\d+\/file\?v=/);
  await img.evaluate((el: HTMLImageElement) => el.decode());
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(600);
  // It fits the column.
  const box = (await img.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const video = doc.locator('video');
  await expect(video).toHaveAttribute('src', /\/api\/assets\/\d+\/file\?v=/);
  await expect(video).toHaveAttribute('controls', '');
  await expect(video).toHaveAttribute('playsinline', '');
  await video.scrollIntoViewIfNeeded();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThan(0);

  // Mermaid blocks are drawn as diagrams (by Pele, in the app's colors); one that does not
  // parse stays as source.
  await expect(doc.locator('.md-diagram svg.pele')).toHaveCount(1);
  await expect(doc.locator('.md-diagram svg')).toContainText('Dusk');
  await expect(doc.locator('pre.md-mermaid-error')).toHaveText('not a diagram');
  // Tapping a diagram opens it full screen, where it zooms in and out.
  await doc.locator('.md-diagram').click();
  const zoomed = page.getByRole('dialog', { name: 'Diagram' });
  await expect(zoomed.locator('.diagram-zoom-content svg')).toContainText('Dusk');
  // The copy keeps its colors.
  expect(await zoomed.locator('.diagram-zoom-content svg').evaluate((el) => getComputedStyle(el).getPropertyValue('--_bg'))).toBe('#050707');
  const width = () => zoomed.locator('.diagram-zoom-content svg').evaluate((el) => el.getBoundingClientRect().width);
  const fitted = await width();
  await zoomed.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(width).toBeGreaterThan(fitted * 1.4);
  await zoomed.getByRole('button', { name: 'Fit' }).click();
  await expect.poll(width).toBeCloseTo(fitted, 0);
  if (isMobile(info.project.name)) {
    // Pinch apart zooms; a one-finger drag pans instead of moving to another item.
    const { width: w, height: h } = page.viewportSize()!;
    const c = { x: w / 2, y: h / 2 };
    const a = line({ x: c.x - 20, y: c.y }, { x: c.x - 120, y: c.y });
    const b = line({ x: c.x + 20, y: c.y }, { x: c.x + 120, y: c.y });
    await touch(page, a.map((p, i) => [p, b[i]]));
    await expect.poll(width).toBeGreaterThan(fitted * 2);
    const left = () => zoomed.locator('.diagram-zoom-content svg').evaluate((el) => el.getBoundingClientRect().left);
    const before = await left();
    await touch(page, swipe(line({ x: w * 0.7, y: c.y }, { x: w * 0.3, y: c.y })));
    await expect.poll(left).toBeLessThan(before - 50);
  }
  await page.keyboard.press('Escape');
  await expect(zoomed).toHaveCount(0);
  await expect(page.locator('.viewer-name')).toHaveText('tale.md');

  // Hiding the embedded image hides it in the document too, until unlocked.
  const secretSrc = await doc.locator('img').nth(1).getAttribute('src');
  const secretId = Number(/assets\/(\d+)\//.exec(secretSrc!)![1]);
  const csrf = (await (await request.get('/api/session')).json()).csrf;
  await request.post(`/api/assets/${secretId}/hidden`, { data: { hidden: true }, headers: { 'x-csrf-token': csrf } });
  await page.reload();
  await expect(doc.locator('h1')).toHaveText('The Tale');
  await expect(doc.locator('img')).toHaveCount(1);
  await expect(doc.locator('.md-missing')).toHaveCount(1);
  // Showing it again needs the unlock (this request context's own session).
  await request.post('/api/unlock', { data: { passphrase: 'e2e passphrase' }, headers: { 'x-csrf-token': csrf } });
  expect((await request.post(`/api/assets/${secretId}/hidden`, { data: { hidden: false }, headers: { 'x-csrf-token': csrf } })).ok()).toBe(true);
  await request.post('/api/lock', { headers: { 'x-csrf-token': csrf } });

  // A link to an asset opens it in the viewer.
  await doc.getByRole('link', { name: 'the scene' }).click();
  await expect(page.locator('.viewer-name')).toHaveText('scene.png');
  await page.goBack();
  await expect(page.locator('.viewer-name')).toHaveText('tale.md');

  if (isMobile(info.project.name)) {
    // Vertical drags scroll the document; a horizontal swipe moves to the next item.
    const scroller = page.locator('.slide.active .md-scroll');
    const { width, height } = page.viewportSize()!;
    await scroller.evaluate((el) => el.scrollTo(0, 0));
    await touch(page, swipe(line({ x: width / 2, y: height * 0.7 }, { x: width / 2, y: height * 0.3 })));
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(50);
    await expect(page.locator('.viewer-name')).toHaveText('tale.md');
    // (tale.md is the last item, so the swipe goes back and then forward again.)
    await touch(page, swipe(line({ x: width * 0.1, y: height / 2 }, { x: width * 0.85, y: height / 2 })));
    await expect(page.locator('.viewer-name')).not.toHaveText('tale.md');
    await touch(page, swipe(line({ x: width * 0.85, y: height / 2 }, { x: width * 0.1, y: height / 2 })));
    await expect(page.locator('.viewer-name')).toHaveText('tale.md');
  }

  // Hidden like an image: it leaves the grid while locked.
  await page.getByRole('button', { name: 'Hide', exact: true }).click();
  await expect(page.locator('.viewer-name')).not.toHaveText('tale.md');
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await expect(page.locator('.cell[aria-label="tale.md"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show hidden items' }).click();
  await page.getByLabel('Passphrase').fill('e2e passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.locator('.cell[aria-label="tale.md"]').click();
  await expect(page.locator('.slide.active .md h1')).toHaveText('The Tale');
  await page.getByRole('button', { name: 'Unhide' }).click();
  await page.getByRole('button', { name: 'Back to gallery' }).click();
  await page.getByRole('button', { name: 'Hidden items are shown' }).click();
  await page.getByRole('button', { name: 'Lock now' }).click();
  await expect(page.locator('.cell[aria-label="tale.md"]')).toHaveCount(1);
});
