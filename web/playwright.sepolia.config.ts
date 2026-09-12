import { defineConfig, devices } from "@playwright/test";
import { readSepoliaDeployment } from "./e2e/sepolia-deployment";

/**
 * The web against a LIVE Base Sepolia deployment (slice J, 2026-09-12): no demo snapshot, no
 * mock wallet, no yield service — the app reads the chain through the public Sepolia endpoint
 * and the four addresses docs/DEPLOYMENTS.md records. While that table holds no addresses the
 * suite is SKIPPED BY NAME (`sepolia.spec.ts` says why); nothing is started.
 *
 * Run: cd web && npx playwright test -c playwright.sepolia.config.ts
 *      (E2E_BASE_URL=<url> to point at a build you started yourself)
 */
const dep = readSepoliaDeployment();

export default defineConfig({
  testDir: "./e2e",
  testMatch: /sepolia\.spec\.ts$/,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3112",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "desktop-1360", use: { ...devices["Desktop Chrome"], viewport: { width: 1360, height: 900 } } }],
  webServer:
    dep && !process.env.E2E_BASE_URL
      ? {
          command:
            `NEXT_PUBLIC_CHAIN_ID=84532 NEXT_PUBLIC_OILSKIN_FACTORY=${dep.factory} NEXT_PUBLIC_OILSKIN_ROUTER=${dep.router} ` +
            `NEXT_PUBLIC_CBZEC_ADDRESS=${dep.cbzec} NEXT_PUBLIC_AERO_ADDRESS=${dep.aero} npx next dev -p 3112 -H 127.0.0.1`,
          url: "http://127.0.0.1:3112",
          reuseExistingServer: true,
          timeout: 180_000,
          stdout: "ignore",
          stderr: "pipe",
        }
      : undefined,
});
