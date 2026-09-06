import { test, expect, type Page } from "@playwright/test";

/**
 * Full demo-mode flow, zero console errors, at 1360 (desktop) and 390 (phone).
 * Everything here must work with no wallet, no RPC and no yield service —
 * and in BOTH product modes (Simple = guided, Advanced = full suite).
 */

const PINNED_CBZEC = "0xB2000000000000000000008501b13360000cb2EC";
const DEMO_ACCOUNT = "0x2222222222222222222222222222222222222222";

function watchConsole(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`[console.error] ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${e.message}`));
  return { errors };
}

async function setMode(page: Page, mode: "simple" | "advanced") {
  await page.getByTestId(`mode-${mode}`).click();
  await expect(page.getByTestId(`mode-${mode}`)).toHaveAttribute("aria-checked", "true");
}

test.describe("Oilskin demo mode", () => {
  test("landing → onboarding: jurisdiction, three steps, wallet-address help, pinned cbZEC + counterfeit check, already-on-Base", async ({ page }) => {
    const { errors } = watchConsole(page);
    await page.goto("/");
    await expect(page.getByTestId("demo-banner")).toContainText("Demo mode");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("cbBTC or WETH");
    await expect(page.getByText("Top LTV we offer").first()).toBeVisible();
    await expect(page.getByTestId("mode-simple")).toHaveAttribute("aria-checked", "true");

    // Client-side navigation, as a user would: a hard `goto` here would abort the Coinbase SDK's
    // in-flight COOP HEAD probe and log a spurious "Failed to fetch" console error.
    await page.getByRole("link", { name: "ZEC → cbZEC", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Three steps");
    const jur = page.getByTestId("jurisdiction");
    await jur.locator("#country").selectOption("US");
    await jur.locator("#state").selectOption("NY");
    await expect(page.getByTestId("eligibility")).toHaveAttribute("data-status", "excluded");
    await jur.locator("#state").selectOption("TX");
    await expect(page.getByTestId("eligibility")).toHaveAttribute("data-status", "eligible");
    await jur.locator("#country").selectOption("EEA");
    await expect(page.getByTestId("eligibility")).toHaveAttribute("data-status", "excluded");
    await jur.locator("#country").selectOption("GB");
    await expect(page.getByTestId("eligibility")).toHaveAttribute("data-status", "unverified");

    const steps = page.getByTestId("steps");
    await expect(steps.getByRole("heading", { level: 3 })).toHaveCount(3);
    await expect(steps).toContainText("KYC");
    await expect(steps).toContainText("transparent");
    await expect(steps).toContainText("Send ZEC on Base");
    // Never type an address by hand: the wallet-address helper sits under step 2
    await expect(page.getByTestId("wallet-address-card")).toContainText("Connect your wallet first");

    const card = page.getByTestId("cbzec-card");
    await expect(page.getByTestId("cbzec-address")).toHaveText(PINNED_CBZEC);
    await expect(card).toContainText("Counterfeit warning");
    await card.locator("#cbzec-check").fill("0xb2000000000000000000008501b13360000cb2ed");
    await expect(page.getByTestId("cbzec-verdict")).toHaveAttribute("data-verdict", "counterfeit");
    await card.locator("#cbzec-check").fill(PINNED_CBZEC.toLowerCase());
    await expect(page.getByTestId("cbzec-verdict")).toHaveAttribute("data-verdict", "genuine");

    await expect(page.getByTestId("already-on-base")).toContainText("Already on Base?");
    await expect(page.getByTestId("disclosures-onboard")).toContainText("Jurisdiction");
    expect(errors).toEqual([]);
  });

  test("SIMPLE wizard: collateral → setting (computed) → ONE recommendation → review (plain sentences) → sign (simulated, 4 steps incl. keeper protection)", async ({ page }) => {
    const { errors } = watchConsole(page);
    await page.goto("/new?collateral=WETH");
    await setMode(page, "simple");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("New position");

    await expect(page.getByTestId("collateral-cbZEC")).toBeDisabled();
    await expect(page.getByTestId("disabled-reason-cbZEC")).toContainText("No lending market");
    await expect(page.getByTestId("collateral-WETH")).toHaveAttribute("aria-checked", "true");
    await page.getByTestId("collateral-cbBTC").click();
    await page.getByTestId("amount").fill("0.5");
    await page.getByTestId("wizard-next").click();

    await expect(page.getByTestId("preset-p30")).toHaveAttribute("data-ltv", "3000");
    await expect(page.getByTestId("preset-p40")).toHaveAttribute("data-ltv", "4000");
    await expect(page.getByTestId("preset-top")).toHaveAttribute("data-ltv", "5000");
    await page.getByTestId("preset-p40").click();
    await expect(page.getByTestId("entry-hf")).toHaveText("1.95");
    await expect(page.getByTestId("borrow-usdc")).toContainText("15,926.18");
    // The ladder says what actually happens, and that the first rung is a message.
    const ladder = page.getByTestId("rung-ladder");
    await expect(ladder).toContainText("a message, not a transaction");
    await expect(ladder).toContainText("the position is closed, the loan repaid and your cbBTC returned to you");
    await expect(ladder).toContainText("only if you grant the keeper permission");
    await expect(page.getByTestId("rung-caveat")).toContainText("expires after 30 days");
    await page.getByTestId("wizard-next").click();

    // One recommendation only; at 4.828% the model says hold, and says why
    await expect(page.getByRole("heading", { level: 2, name: "Our recommendation" })).toBeVisible();
    await expect(page.locator('[data-testid^="strategy-"]')).toHaveCount(0);
    await expect(page.getByTestId("advanced-controls")).toHaveCount(0);
    const rec = page.getByTestId("recommendation-hold");
    await expect(rec).toContainText("recommended today");
    await expect(rec).toContainText("4.83% USDC borrow rate");
    // Simple mode explains the refusal in one plain sentence — no codes, no jargon.
    const whyNot = page.getByTestId("recommendation-why-not");
    await expect(whyNot).toContainText("The closest one was USDC/cbBTC (conservative)");
    await expect(whyNot).toContainText("it earns less than the loan costs");
    await expect(whyNot).not.toContainText("_");
    await rec.click();
    await page.getByTestId("wizard-next").click();

    const review = page.getByTestId("review");
    await expect(review).toContainText("Liquidation threshold (Aave, read)");
    await expect(review).toContainText("1.95 (floor 1.55)");
    await expect(review).toContainText("Emergency rung (HF < 1.05)");
    await expect(review).toContainText("the position is closed, the loan repaid and your cbBTC returned to you");
    await expect(review).toContainText("expires in 30 days unless renewed");
    await expect(review).toContainText("Net carry per year");
    await expect(page.getByTestId("review-problems")).toHaveCount(0);
    const disc = page.getByTestId("disclosures-review");
    for (const t of ["Custodial entry", "Identity verification", "Jurisdiction", "cbZEC issuer powers", "cbZEC peg", "Oilskin's own cbZEC market", "Liquidation", "Impermanent loss", "Keeper dependence", "Smart-contract risk", "Demo mode"]) {
      await expect(disc).toContainText(t);
    }
    // Every planned call carries a plain sentence; Simple hides the technical args
    const calls = page.getByTestId("planned-calls");
    await expect(calls).toContainText("3 transactions · 1 signature");
    await expect(page.getByTestId("call-approve")).toContainText("nothing moves in this step");
    await expect(page.getByTestId("call-permit-signature")).toContainText("costs nothing");
    await expect(page.getByTestId("call-open")).toContainText("keeps the USDC in your account");
    await expect(page.getByTestId("call-grant")).toContainText("for 30 days");
    await expect(page.getByTestId("call-grant")).toContainText("revoke it at any time");
    await expect(calls).not.toContainText("createAccountAndExec");
    await page.getByTestId("wizard-next").click();

    await expect(page.getByTestId("sign")).toContainText("Demo mode: the steps below are simulated");
    await expect(page.getByTestId("plain-open")).toContainText("if anything along the way fails, the whole thing is undone");
    await page.getByTestId("sign-run").click();
    await expect(page.getByTestId("sign-done")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("account-address")).toHaveText(DEMO_ACCOUNT);
    for (const k of ["approve", "permit-signature", "open", "grant"]) {
      await expect(page.getByTestId(`sign-step-${k}`)).toHaveAttribute("data-state", "done");
    }
    expect(errors).toEqual([]);
  });

  test("ADVANCED wizard: every pool with the model's numbers, why-not list, custom controls, technical detail on review", async ({ page }) => {
    const { errors } = watchConsole(page);
    await page.goto("/new");
    await setMode(page, "advanced");
    await page.getByTestId("amount").fill("0.5");
    await page.getByTestId("wizard-next").click();
    await page.getByTestId("preset-top").click();
    await expect(page.getByTestId("entry-hf")).toHaveText("1.56"); // 0.78 / 0.50
    await page.getByTestId("wizard-next").click();

    await expect(page.getByTestId("gate-empty")).toContainText("No pool clears the gate for cbBTC at today’s 4.83% borrow rate");
    await expect(page.getByTestId("gate-line")).toContainText("emissions sampled 2026-08-31 01:34Z");
    await expect(page.getByTestId("gate-line")).toContainText("engine fee 15%");
    await expect(page.getByTestId("gate-line")).not.toContainText("STALE");
    await expect(page.locator('[data-testid^="strategy-aero-"]')).toHaveCount(0);
    const rejected = page.getByTestId("gate-rejected");
    await rejected.locator("summary").click();
    await expect(rejected).toContainText("USDC/cbBTC conservative");
    await expect(rejected).toContainText("LP net -5.29% vs borrow 4.83%");
    await expect(rejected).toContainText("would clear at 2.02× today's net emissions on the closed form alone");
    await expect(rejected).toContainText("MC net -5.21%");
    await expect(rejected).toContainText("Once the loss from the price moving is priced in, it earns less than the loan costs.");
    await expect(rejected).toContainText("gauge pays no AERO");
    await expect(page.getByTestId("advanced-controls")).toBeVisible();
    await page.getByTestId("band-tolerance").fill("2");
    await expect(page.getByTestId("advanced-controls")).toContainText("Above 1% a sandwich");
    await page.getByTestId("band-tolerance").fill("0.5");
    await page.getByTestId("keeper-protection").uncheck();
    await page.getByTestId("strategy-hold").click();
    await page.getByTestId("wizard-next").click();

    const calls = page.getByTestId("planned-calls");
    await expect(calls).toContainText("2 transactions · 1 signature"); // no grant
    await expect(calls).toContainText("createAccountAndExec");
    // The hold path is the router's openBorrowOnly, not the old three-call batch
    // that skipped the entry health-factor floor.
    await expect(calls).toContainText("StrategyRouter.openBorrowOnly");
    await expect(calls).toContainText("refuses a borrow under the registry's entry health-factor floor");
    await expect(calls).not.toContainText("execBatch([permit2");
    await expect(calls).toContainText("your Oilskin account (0x2222…2222)");
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("sign-step-grant")).toHaveCount(0);
    await page.getByTestId("sign-run").click();
    await expect(page.getByTestId("sign-done")).toBeVisible({ timeout: 20_000 });
    expect(errors).toEqual([]);
  });

  test("dashboard: tiles, ladder band, position card, claim/unwind action panels with plain sentences; Advanced raw data", async ({ page }) => {
    const { errors } = watchConsole(page);
    await page.goto("/dashboard");
    await setMode(page, "simple");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Demo dashboard");
    await expect(page.getByTestId("tile-hf")).toContainText("1.95");
    await expect(page.getByTestId("tile-hf")).toContainText("Healthy");
    await expect(page.getByTestId("tile-debt")).toContainText("40.0% LTV");
    await expect(page.getByTestId("health-band")).toContainText("warning < 1.50");
    await expect(page.getByTestId("account-link")).toHaveText("0x2222…2222");

    const card = page.getByTestId("position-card").first();
    await expect(card).toContainText("WETH/USDC");
    await expect(card).toContainText("In range");
    await card.getByRole("button").first().click();
    await expect(card).toContainText("Oilskin performance fee (10% of realised)");
    await expect(page.getByTestId("raw-position")).toHaveCount(0);
    await card.getByTestId("claim-btn").click();
    const panel = page.getByTestId("action-panel");
    await expect(panel).toContainText("Claim rewards");
    await expect(page.getByTestId("plain-claim")).toContainText("the performance fee comes off here");
    await page.getByTestId("sign-run").click();
    await expect(page.getByTestId("sign-done")).toContainText("Rewards sent to your wallet");
    await panel.getByRole("button", { name: "Close" }).click();
    await card.getByTestId("unwind-btn").click();
    await expect(page.getByTestId("plain-unwind")).toContainText("repays your Aave loan in full");

    // Keeper protection: status, expiry, what it can and cannot do — read from the grant.
    const keeper = page.getByTestId("keeper-panel");
    await expect(keeper).toHaveAttribute("data-status", "active");
    await expect(page.getByTestId("keeper-status-label")).toContainText("day");
    await expect(page.getByTestId("keeper-expiry")).toContainText("2026-09-29");
    await expect(page.getByTestId("keeper-rungs")).toContainText("a message, not a transaction");
    await expect(page.getByTestId("keeper-budgets")).toContainText("USDC");
    await expect(keeper).toContainText("is not bounded by them");

    await setMode(page, "advanced");
    await expect(page.getByTestId("keeper-raw")).toContainText("StrategyRouter.unwind");
    await expect(page.getByTestId("raw-account")).toContainText("Oilskin account");
    await expect(page.getByTestId("raw-account")).toContainText(DEMO_ACCOUNT);
    await expect(page.getByTestId("raw-position")).toContainText("engine pool id");
    await expect(page.getByTestId("activity-rail")).toContainText("Created OilskinAccount");
    expect(errors).toEqual([]);
  });

  test("spot: gated in Simple; Advanced shows the demo quote, cbZEC pin, slippage guard, disclosures", async ({ page }) => {
    const { errors } = watchConsole(page);
    await page.goto("/spot");
    await setMode(page, "simple");
    await expect(page.getByTestId("spot-simple-gate")).toBeVisible();
    await page.getByTestId("spot-switch-advanced").click();
    await expect(page.getByRole("heading", { level: 1 })).toContainText("CoW");
    await expect(page.getByTestId("quote")).toContainText("Expected to receive");
    await expect(page.getByText(PINNED_CBZEC).first()).toBeVisible();
    await expect(page.getByTestId("sign-order-btn")).toHaveCount(0);
    await page.getByTestId("slippage").fill("3.5");
    await expect(page.getByTestId("slippage-note")).toContainText("refused");
    await page.getByTestId("slippage").fill("1.5");
    await expect(page.getByTestId("slippage-note")).toContainText("Above 1%");
    await page.getByTestId("sell-token").selectOption("cbBTC");
    await page.getByTestId("buy-token").selectOption("USDC");
    await page.getByTestId("sell-amount").fill("0.1");
    await expect(page.getByTestId("quote")).toContainText("7,963");
    await expect(page.getByTestId("disclosures-spot")).toContainText("Spot orders via CoW");
    expect(errors).toEqual([]);
  });

  test("no horizontal overflow at this viewport on every page and every wizard step, both modes", async ({ page }) => {
    // ~20 full navigations against `next dev` in both product modes. The work is
    // the harness's, not the page's; give it room rather than trimming coverage.
    test.setTimeout(300_000);
    const noOverflow = async (label: string) => {
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${label} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
    };
    for (const mode of ["simple", "advanced"] as const) {
      for (const path of ["/", "/onboard", "/dashboard", "/spot"]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await setMode(page, mode);
        await noOverflow(`${path} (${mode})`);
      }
      await page.goto("/dashboard");
      await page.getByTestId("position-card").first().getByRole("button").first().click();
      await noOverflow(`/dashboard card open (${mode})`);
      await page.goto("/new");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await noOverflow(`/new collateral (${mode})`);
      await page.getByTestId("wizard-next").click();
      await noOverflow(`/new setting (${mode})`);
      await page.getByTestId("wizard-next").click();
      if (mode === "advanced") await page.getByTestId("gate-rejected").locator("summary").click();
      await noOverflow(`/new strategy (${mode})`);
      await page.getByTestId(mode === "advanced" ? "strategy-hold" : "recommendation-hold").click();
      await page.getByTestId("wizard-next").click();
      await noOverflow(`/new review (${mode})`);
      await page.getByTestId("wizard-next").click();
      await noOverflow(`/new sign (${mode})`);
    }
  });
});
