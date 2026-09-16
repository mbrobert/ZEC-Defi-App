import { test, expect, type Page } from "@playwright/test";
import { readSepoliaDeployment } from "./sepolia-deployment";

/**
 * Base Sepolia rehearsal, against the LIVE testnet deployment docs/DEPLOYMENTS.md records —
 * no demo snapshot, no mock wallet, no yield service. Read-only: nothing here connects a wallet
 * or signs. The suite skips by name while the table holds no addresses.
 *
 * What these three tests prove: the build is pointed at 84532 and says so wherever the chain is
 * named; the cbZEC the onboarding pins is the DOUBLE (never the mainnet token); the pages that
 * need mainnet-only services say so instead of quoting nothing. What they cannot prove is in
 * docs/SEPOLIA-REHEARSAL.md.
 */
const dep = readSepoliaDeployment();
const SKIP_REASON =
  "docs/DEPLOYMENTS.md has no Base Sepolia addresses yet — deploy (DEPLOY-SEPOLIA.md §4), fill the table, then this suite runs";

/** Console errors, minus the yield service the rehearsal deliberately runs without. */
function watchConsole(page: Page): { errors: string[] } {
  const errors: string[] = [];
  const ignorable = (t: string) => /localhost:8787|127\.0\.0\.1:8787|ERR_CONNECTION_REFUSED|Failed to fetch/.test(t);
  page.on("console", (m) => {
    if (m.type() === "error" && !ignorable(m.text())) errors.push(`[console.error] ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  return { errors };
}

test.describe("Base Sepolia rehearsal (live chain, read-only, no wallet)", () => {
  test.skip(!dep, SKIP_REASON);

  test("landing → onboarding render against the Sepolia deployment; the pinned cbZEC is the DOUBLE and links sepolia.basescan.org", async ({ page }) => {
    const { errors } = watchConsole(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("demo-banner")).toHaveCount(0); // a live build, not the snapshot
    await page.getByRole("link", { name: "Your ZEC", exact: true }).click();
    await expect(page.getByTestId("cbzec-address")).toHaveText(dep!.cbzec);
    const link = page.locator('a[href^="https://sepolia.basescan.org/token/"]').first();
    await expect(link).toHaveAttribute("href", `https://sepolia.basescan.org/token/${dep!.cbzec}`);
    expect(errors).toEqual([]);
  });

  test("spot says CoW Protocol is Base mainnet only and names chain 84532", async ({ page }) => {
    const { errors } = watchConsole(page);
    await page.goto("/spot");
    await page.getByTestId("mode-advanced").click();
    await expect(page.getByText(/Base mainnet only/)).toBeVisible();
    await expect(page.getByText(/84532/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("dashboard without a wallet asks for one and shows no position", async ({ page }) => {
    const { errors } = watchConsole(page);
    await page.goto("/dashboard");
    await expect(page.getByText(/connect/i).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});
