import { expect, test, type Page } from '@playwright/test';

const isMobile = (name: string) => name.startsWith('iphone');

/** Switches section the way a user would: the rail on desktop, the drawer on phones. */
async function goSection(page: Page, label: string, mobile: boolean) {
  if (mobile) {
    await page.locator('.topbar .icon-btn').first().click();
    await page.locator('.section-switch a', { hasText: label }).click();
  } else {
    await page.locator('.rail-item', { hasText: label }).click();
  }
}

async function noHorizontalScroll(page: Page) {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
}

test('pre-section URLs land on the same gallery view', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/gallery$/);
  await expect(page.locator('.topbar h1')).toHaveText('All media');

  await page.goto('/?lib=lib&folder=portraits');
  await expect(page).toHaveURL(/\/gallery\?lib=lib&folder=portraits$/);
  await expect(page.locator('.cell')).toHaveCount(2);

  await page.goto('/trash');
  await expect(page).toHaveURL(/\/gallery\/trash$/);
  await expect(page.locator('.topbar h1')).toHaveText('Trash');

  await page.goto('/no-such-page');
  await expect(page).toHaveURL(/\/gallery$/);
});

test('sections switch from the rail or the drawer and keep the gallery view', async ({ page }, info) => {
  const mobile = isMobile(info.project.name);
  await page.goto('/gallery?lib=lib&folder=portraits');
  await expect(page.locator('.cell')).toHaveCount(2);
  await expect(page.locator('.rail')).toBeVisible({ visible: !mobile });
  if (!mobile) {
    // The rail sits beside the content, never over it.
    const rail = await page.locator('.rail').boundingBox();
    const bar = await page.locator('.topbar').boundingBox();
    expect(bar!.x).toBeGreaterThanOrEqual(rail!.x + rail!.width);
  }

  // Generate opens its (single) flow.
  await goSection(page, 'Generate', mobile);
  await expect(page).toHaveURL(/\/generate\/wai-illustrious-tags$/);
  await expect(page.locator('.topbar h1')).toHaveText('WAI-Illustrious · prompt to tags');
  await noHorizontalScroll(page);

  await goSection(page, 'Train', mobile);
  await expect(page).toHaveURL(/\/train$/);
  await expect(page.locator('.topbar h1')).toHaveText('Train');

  // Coming back restores the folder and filters the gallery was left on.
  await goSection(page, 'Gallery', mobile);
  await expect(page).toHaveURL(/\/gallery\?lib=lib&folder=portraits$/);
  await expect(page.locator('.cell')).toHaveCount(2);

  // The back button walks section changes.
  await page.goBack();
  await expect(page.locator('.topbar h1')).toHaveText('Train');
  await page.goBack();
  await expect(page.locator('.topbar h1')).toHaveText('WAI-Illustrious · prompt to tags');
  await page.goBack();
  await expect(page.locator('.topbar h1')).toHaveText('Test Library');
  await expect(page.locator('.cell')).toHaveCount(2);
});

test('closing the viewer with the back button stays in the gallery', async ({ page }) => {
  await page.goto('/gallery?lib=lib&folder=portraits');
  await page.locator('.cell[aria-label="p1.jpg"]').click();
  await expect(page.locator('.viewer-name')).toHaveText('p1.jpg');
  await page.goBack();
  await expect(page.locator('.viewer')).toHaveCount(0);
  await expect(page).toHaveURL(/\/gallery\?lib=lib&folder=portraits$/);
  await expect(page.locator('.cell')).toHaveCount(2);
});

test('nothing scrolls sideways on narrow and wide screens', async ({ page }, info) => {
  const sizes = isMobile(info.project.name) ? [null] : [{ width: 320, height: 640 }, { width: 899, height: 700 }, { width: 900, height: 700 }, { width: 1920, height: 1080 }];
  for (const size of sizes) {
    if (size) await page.setViewportSize(size);
    for (const url of ['/gallery', '/gallery?lib=lib', '/gallery/trash', '/generate', '/train']) {
      await page.goto(url);
      await expect(page.locator('.topbar h1')).toBeVisible();
      await noHorizontalScroll(page);
    }
    if (size) await expect(page.locator('.rail')).toBeVisible({ visible: size.width >= 900 });
  }
});
