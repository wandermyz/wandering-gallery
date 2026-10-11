import { defineConfig, devices } from '@playwright/test';

const PORT = 2398;

function iphone(d: (typeof devices)[string]) {
  if (process.env.PW_IPHONE_WEBKIT) return d;
  return { ...d, defaultBrowserType: 'chromium' as const, channel: process.env.PW_CHANNEL ?? 'chrome' };
}

export default defineConfig({
  testDir: 'e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.PW_CHANNEL ?? 'chrome',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1366, height: 860 } } },
    // iPhone viewport, DPR, touch and user agent, rendered by Chromium (Playwright's
    // WebKit needs extra system packages). Set PW_IPHONE_WEBKIT=1 to use real WebKit.
    { name: 'iphone', use: iphone(devices['iPhone 15 Pro']) },
    { name: 'iphone-landscape', use: iphone(devices['iPhone 15 Pro landscape']) },
  ],
  webServer: [
    {
      command: `node dist/server/main.js --config .tmp/e2e/config.yaml`,
      url: `http://localhost:${PORT}/api/libraries`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: 'ignore',
    },
    {
      // Stand-in ComfyUI for the Generate page (driven through e2e/fake-comfy-cli.mjs).
      command: 'node e2e/fake-comfy.mjs 2397 .tmp/e2e/comfy-out',
      url: 'http://127.0.0.1:2397/system_stats',
      reuseExistingServer: false,
      timeout: 10_000,
    },
  ],
});
