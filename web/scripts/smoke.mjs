// Smoke test against the deployed instance. Usage: node scripts/smoke.mjs https://host:port
// Read-mostly: toggles one favorite on and off again, never deletes.
import { chromium, devices } from '@playwright/test';

const base = process.argv[2];
if (!base) {
  console.error('usage: node scripts/smoke.mjs <url>');
  process.exit(2);
}
const out = process.argv[3] ?? '.tmp/smoke-shots';
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
let failed = false;
for (const [name, opts] of [
  ['iphone', devices['iPhone 15 Pro']],
  ['desktop', { viewport: { width: 1440, height: 900 } }],
]) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(base + '/');
    await page.waitForSelector('.cell.loaded', { timeout: 15000 });
    await page.screenshot({ path: `${out}/${name}-grid.png` });
    const first = page.locator('.cell').first();
    const label = await first.getAttribute('aria-label');
    await first.click();
    await page.waitForSelector('.viewer-name');
    const fav = page.locator('.viewer-bottom .fav-btn');
    const wasFav = (await fav.getAttribute('class')).includes('active');
    await fav.click();
    await page.waitForFunction((w) => document.querySelector('.viewer-bottom .fav-btn').classList.contains('active') !== w, wasFav);
    await fav.click();
    await page.waitForFunction((w) => document.querySelector('.viewer-bottom .fav-btn').classList.contains('active') === w, wasFav);
    await page.getByRole('button', { name: 'Details and metadata' }).click();
    await page.waitForSelector('.info .section', { timeout: 10000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${name}-viewer-info.png` });
    console.log(`${name}: ok (opened ${label})${errors.length ? ' errors: ' + errors.join('; ') : ''}`);
    if (errors.length) failed = true;
  } catch (e) {
    failed = true;
    console.log(`${name}: FAILED ${e.message}`);
  }
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
