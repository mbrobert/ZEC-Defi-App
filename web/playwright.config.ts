import { defineConfig, devices } from "@playwright/test";

/**
 * E2E against `next dev` in forced demo mode: no wallet, no RPC, no yield
 * service — every read falls back to the labelled snapshot, and the whole
 * flow must run with ZERO console errors at desktop (1360) and phone (390).
 *
 * Run: PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3111",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-1360", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } },
    { name: "phone-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "NEXT_PUBLIC_FORCE_DEMO=1 NEXT_PUBLIC_E2E_MOCK_WALLET=1 npx next dev -p 3111 -H 127.0.0.1",
        url: "http://127.0.0.1:3111",
        reuseExistingServer: true,
        timeout: 180_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
