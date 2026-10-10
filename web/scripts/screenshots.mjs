// Visual regression helper. Takes a fixed set of screenshots of a running instance (normally
// the e2e fixture server) on desktop and iPhone viewports, or compares two such sets.
//   node scripts/screenshots.mjs shoot <url> <outDir>
//   node scripts/screenshots.mjs diff <dirA> <dirB>
import fs from 'node:fs';
import path from 'node:path';
import { chromium, devices } from '@playwright/test';
import sharp from 'sharp';

const [cmd, a, b] = process.argv.slice(2);

const PROFILES = [
  ['desktop', { viewport: { width: 1366, height: 860 } }],
  ['iphone', devices['iPhone 15 Pro']],
  ['iphone-landscape', devices['iPhone 15 Pro landscape']],
];

// Day headers and relative dates depend on the clock; hide them so runs are comparable.
const MASK_CSS = '.grid-day, .toasts { visibility: hidden !important; } * { caret-color: transparent !important; }';

async function settle(page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = r; }))));
  });
  await page.waitForTimeout(400);
}

async function shoot(base, out) {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });
  for (const [name, opts] of PROFILES) {
    const ctx = await browser.newContext({ ...opts, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.addInitScript((css) => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = css;
        document.head.append(s);
      });
    }, MASK_CSS);
    const snap = async (label) => {
      await settle(page);
      await page.screenshot({ path: path.join(out, `${name}-${label}.png`) });
    };
    const closeSheet = async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    };

    await page.goto(base + '/');
    await page.waitForSelector('.cell.loaded');
    await snap('grid');
    await page.getByRole('button', { name: 'Libraries' }).click();
    await snap('libraries');
    await closeSheet();
    await page.getByRole('button', { name: 'Filter and view options' }).click();
    await snap('filters');
    await closeSheet();
    await page.goto(base + '/?lib=lib');
    await page.waitForSelector('.folder-chip');
    await snap('library');
    await page.goto(base + '/?lib=lib&folder=portraits');
    await page.waitForSelector('.cell.loaded');
    await page.locator('.cell[aria-label="p1.jpg"]').click();
    await page.waitForSelector('.viewer-name');
    await snap('viewer');
    await page.getByRole('button', { name: 'Details and metadata' }).click();
    await page.waitForSelector('.info .section');
    await snap('info');
    await page.goto(base + '/trash');
    await snap('trash');
    await ctx.close();
    console.log(`${name}: ok`);
  }
  await browser.close();
}

async function diff(dirA, dirB) {
  let bad = 0;
  const names = new Set([...fs.readdirSync(dirA), ...fs.readdirSync(dirB)].filter((f) => f.endsWith('.png')));
  for (const f of [...names].sort()) {
    const pa = path.join(dirA, f), pb = path.join(dirB, f);
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) {
      console.log(`${f}: missing in ${fs.existsSync(pa) ? dirB : dirA}`);
      bad++;
      continue;
    }
    const [ia, ib] = await Promise.all([pa, pb].map((p) => sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true })));
    if (ia.info.width !== ib.info.width || ia.info.height !== ib.info.height) {
      console.log(`${f}: size ${ia.info.width}x${ia.info.height} vs ${ib.info.width}x${ib.info.height}`);
      bad++;
      continue;
    }
    let px = 0;
    for (let i = 0; i < ia.data.length; i += 4) {
      if (ia.data[i] !== ib.data[i] || ia.data[i + 1] !== ib.data[i + 1] || ia.data[i + 2] !== ib.data[i + 2]) px++;
    }
    const pct = (100 * px) / (ia.info.width * ia.info.height);
    console.log(`${f}: ${px ? `${px} px differ (${pct.toFixed(2)}%)` : 'identical'}`);
    if (px) bad++;
  }
  console.log(bad ? `${bad} screenshot(s) differ` : 'all identical');
  process.exit(bad ? 1 : 0);
}

if (cmd === 'shoot' && a && b) await shoot(a.replace(/\/$/, ''), b);
else if (cmd === 'diff' && a && b) await diff(a, b);
else {
  console.error('usage: screenshots.mjs shoot <url> <outDir> | diff <dirA> <dirB>');
  process.exit(2);
}
