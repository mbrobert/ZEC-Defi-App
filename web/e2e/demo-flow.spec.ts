import { test, expect, type Page } from "@playwright/test";

/**
 * Full demo-mode flow, zero console errors, at 1360 (desktop) and 390 (phone).
 * Everything here must work with no wallet, no RPC and no yield service —
 * and in BOTH product modes (Simple = guided, Advanced = full suite).
 */

import { DEMO_FORECAST_RAW, DEMO_MARKET } from "../lib/demo";

const PINNED_CBZEC = "0xB2000000000000000000008501b13360000cb2EC";
const DEMO_ACCOUNT = "0x2222222222222222222222222222222222222222";

// Every figure the demo renders is derived here from the SAME snapshot the app renders it from
// (web/lib/demo.ts, one pinned ledger read), never typed: 0.5 cbBTC at the snapshot price, Aave's 78 %
// threshold, debt = collateral × LT ÷ HF.
const CBBTC_USD = DEMO_MARKET.reserves.cbBTC!.priceUsd;
const LT = DEMO_MARKET.reserves.cbBTC!.liquidationThresholdBps / 10_000;
const COLLATERAL_USD = 0.5 * CBBTC_USD;
const usd2 = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const borrowAtHf = (hf: number) => usd2((COLLATERAL_USD * LT) / hf);
const BORROW_PCT = `${DEMO_MARKET.usdcBorrowAprPct.toFixed(2)}%`;
const BEST = DEMO_FORECAST_RAW.cells.find((c) => c.poolId === "aero-cbbtc-usdc" && c.setting === "sheltered" && c.collateral === "cbBTC")!;
const EMISSIONS_SAMPLED = `${DEMO_FORECAST_RAW.emissionsSampledAt.slice(0, 10)} ${DEMO_FORECAST_RAW.emissionsSampledAt.slice(11, 16)}Z`;

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
    await expect(page.getByText("Lowest health factor").first()).toBeVisible();
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

    // The risk slider (BUILD-PLAN D7 / §2b) at the pinned 1.25 floor with no product cap: on cbBTC the slider stops at
    // HF 1.25 (LTV 62.40 %), the registry floor binds (Aave's max LTV 73 % sits above), both marks are offered.
    const slider = page.getByTestId("hf-slider");
    await expect(slider).toHaveAttribute("data-min-hf", "1.25");
    await expect(slider).toHaveAttribute("data-binding", "entry_hf_floor");
    await expect(page.getByTestId("entry-hf")).toHaveText("1.55"); // the default: the Sheltered mark, offered as is
    await expect(page.getByTestId("borrow-usdc")).toContainText(borrowAtHf(1.55)); // collateral × 0.78 ÷ 1.55
    await expect(page.getByTestId("ltv-line")).toContainText("50.3% LTV");
    await expect(page.getByTestId("entry-floor")).toHaveText("1.25");
    await expect(page.getByTestId("mark-sheltered")).toBeEnabled();
    await expect(page.getByTestId("mark-expert")).toBeEnabled();
    await expect(page.getByTestId("mark-why")).toHaveCount(0);
    await expect(page.getByTestId("hf-acknowledgment")).toHaveCount(0); // at or above the Sheltered mark
    // The Expert mark (1.30): under the Sheltered mark, so the acknowledgment appears, names the drawdown and this
    // entry's first and last rung (ladderFor(1.30) = 1.27 … 1.05), and holds Continue until ticked.
    await page.getByTestId("mark-expert").click();
    await expect(page.getByTestId("entry-hf")).toHaveText("1.30");
    await expect(page.getByTestId("borrow-usdc")).toContainText(borrowAtHf(1.3)); // collateral × 0.78 ÷ 1.30
    await expect(page.getByTestId("hf-acknowledgment")).toHaveCount(1);
    await expect(page.getByTestId("hf-ack-text")).toContainText("entry health factor of 1.30, under the Sheltered mark of 1.55");
    await expect(page.getByTestId("hf-ack-text")).toContainText("A 23.1% fall in cbBTC");
    await expect(page.getByTestId("hf-ack-text")).toContainText("comes at HF 1.27 and its last, closing the position, at 1.05");
    await expect(page.getByTestId("wizard-next")).toBeDisabled();
    await page.getByTestId("hf-ack").check();
    await expect(page.getByTestId("wizard-next")).toBeEnabled();
    // Type a health factor: the borrow follows (debt = collateral × LT ÷ HF, at 1.95); the tick is voided by the change.
    await page.getByTestId("hf-input").fill("1.95");
    await page.getByTestId("hf-input").press("Enter");
    await expect(page.getByTestId("entry-hf")).toHaveText("1.95");
    await expect(page.getByTestId("borrow-usdc")).toContainText(borrowAtHf(1.95));
    await expect(page.getByTestId("ltv-line")).toContainText("40.0% LTV");
    // Type a borrow: the HF follows (collateral × LT ÷ 12,000) — and one above the offered maximum is pulled back to it.
    await page.getByTestId("borrow-input").fill("12000");
    await page.getByTestId("borrow-input").press("Enter");
    await expect(page.getByTestId("entry-hf")).toHaveText(((COLLATERAL_USD * LT) / 12_000).toFixed(2));
    await expect(page.getByTestId("hf-acknowledgment")).toHaveCount(0);
    await page.getByTestId("borrow-input").fill("30000");
    await page.getByTestId("borrow-input").press("Enter");
    await expect(page.getByTestId("entry-hf")).toHaveText("1.25");
    await expect(page.getByTestId("borrow-usdc")).toContainText(borrowAtHf(1.25)); // collateral × 0.78 ÷ 1.25, the floor's own ladder 1.23 / 1.16 / 1.09 / 1.05
    await expect(page.getByTestId("rung-ladder")).toContainText("Warning (HF < 1.23");
    await expect(page.getByTestId("hf-acknowledgment")).toHaveCount(1); // 1.25 is under the Sheltered mark too
    await page.getByTestId("hf-input").fill("1.95");
    await page.getByTestId("hf-input").press("Enter");
    await expect(page.getByTestId("entry-hf")).toHaveText("1.95");
    // The ladder is THIS entry HF's — ladderFor(1.95): warn 1.86 … emergency 1.09 — and says what actually
    // happens, and that the first rung is a message.
    const ladder = page.getByTestId("rung-ladder");
    await expect(ladder).toContainText("Warning (HF < 1.86");
    await expect(ladder).toContainText("Emergency (HF < 1.09");
    await expect(ladder).toContainText("a message, not a transaction");
    await expect(ladder).toContainText("the position is closed, the loan repaid and your cbBTC returned to you");
    await expect(ladder).toContainText("only if you grant the keeper permission");
    await expect(page.getByTestId("rung-caveat")).toContainText("expires after 30 days");
    await page.getByTestId("wizard-next").click();

    // The forecast (2026-09-12, D4/D5): every pool at its best setting, the least bad named as a
    // loss in one plain sentence, every card selectable, hold still a choice.
    await expect(page.getByRole("heading", { level: 2, name: "The forecast" })).toBeVisible();
    // One card per pool: the 9 curated Aerodrome pools less the direct-venue cbZEC/USDC pool the demo
    // deployment cannot open (W3-LOW-3) — cards carry data-priced, hold and spot do not.
    await expect(page.locator('[data-testid^="strategy-"][data-priced]')).toHaveCount(8);
    await expect(page.getByTestId("advanced-controls")).toHaveCount(0);
    const note = page.getByTestId("recommendation-note");
    await expect(note).toContainText("USDC/cbBTC (conservative) is the least bad forecast");
    await expect(note).toContainText(`${BORROW_PCT} borrow rate`);
    await expect(note).toContainText("still a loss");
    await expect(note).not.toContainText("_");
    const bestCard = page.getByTestId("strategy-aero-cbbtc-usdc-sheltered");
    await expect(bestCard).toContainText("least bad forecast");
    await expect(bestCard).toContainText(`LP net ${BEST.lpNetPct!.toFixed(2)}% (stricter model ${BEST.mcLpNetPct!.toFixed(2)}%`);
    await expect(bestCard).toContainText("below the borrow");
    await expect(bestCard).toBeEnabled();
    await expect(page.getByTestId("strategy-aero-aero-weth-sheltered")).toContainText("No forecast:");
    await page.getByTestId("strategy-hold").click();
    await page.getByTestId("wizard-next").click();

    const review = page.getByTestId("review");
    await expect(review).toContainText("Liquidation threshold (Aave, read)");
    await expect(review).toContainText("1.95 (your choice; floor 1.25; lowest offered 1.25 — the registry's entry floor of 1.25)");
    await expect(review).toContainText("40.00% LTV");
    await expect(review).toContainText("Emergency rung (HF < 1.09)");
    await expect(review).toContainText("the position is closed, the loan repaid and your cbBTC returned to you");
    await expect(review).toContainText("expires in 30 days unless renewed");
    await expect(review).toContainText("Net carry per year");
    await expect(page.getByTestId("review-problems")).toHaveCount(0);
    // The acknowledgment names THIS position's numbers and holds the button until it is ticked.
    await expect(page.getByTestId("wizard-next")).toBeDisabled();
    const ackText = page.getByTestId("forecast-ack-text");
    await expect(ackText).toContainText(/the loan costs \d\.\d\d% a year today and that rate moves/);
    await expect(ackText).toContainText("48.7% fall in cbBTC would liquidate this position");
    await expect(ackText).not.toContainText("_");
    await expect(page.getByTestId("forecast-disclosures")).toContainText("not advice and not a promise");
    await page.getByTestId("forecast-ack").check();
    await expect(page.getByTestId("wizard-next")).toBeEnabled();
    const disc = page.getByTestId("disclosures-review");
    for (const t of ["Custodial entry", "Identity verification", "Jurisdiction", "cbZEC issuer powers", "cbZEC peg", "No cbZEC lending market on Base", "The yield forecast is a model", "Liquidation", "Impermanent loss", "Keeper dependence", "Smart-contract risk", "Demo mode"]) {
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
    await expect(page.getByTestId("entry-hf")).toHaveText("1.55"); // the default: the Sheltered mark, offered at the 1.25 floor
    await page.getByTestId("wizard-next").click();

    // No empty-menu banner any more: every pool × setting is a card with both models' numbers.
    await expect(page.getByTestId("gate-empty")).toHaveCount(0);
    await expect(page.getByTestId("gate-line")).toContainText(`emissions sampled ${EMISSIONS_SAMPLED}`);
    await expect(page.getByTestId("gate-line")).toContainText("engine fee 15%");
    await expect(page.getByTestId("gate-line")).not.toContainText("STALE");
    // Every pool × setting: 8 openable pools × 3 settings (the direct-venue cbZEC/USDC pool is filtered out on the demo deployment).
    await expect(page.locator('[data-testid^="strategy-"][data-priced]')).toHaveCount(24);
    const best = page.getByTestId("forecast-aero-cbbtc-usdc-sheltered");
    await expect(best).toContainText(`LP net ${BEST.lpNetPct!.toFixed(2)}% (stricter model ${BEST.mcLpNetPct!.toFixed(2)}%, gap ${BEST.modelGapPts!.toFixed(2)} pt)`);
    await expect(best).toContainText(`borrow −${BORROW_PCT}`);
    await expect(best).toContainText(`needs ${BEST.breakEvenEmissionsMultiple!.toFixed(2)}× today's rewards to break even`);
    await expect(page.getByTestId("strategy-aero-cbbtc-usdc-sheltered")).toContainText("below the borrow");
    const unpriced = page.getByTestId("forecast-aero-aero-weth-sheltered");
    await expect(unpriced).toContainText("No forecast:");
    await expect(unpriced).not.toContainText("_");
    await expect(page.getByTestId("strategy-aero-aero-weth-sheltered")).toBeEnabled();
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
    await expect(page.getByTestId("wizard-next")).toBeDisabled();
    await page.getByTestId("forecast-ack").check();
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
    // The dashboard's ladder is the POSITION's (A4): the demo account opened at 40 % LTV → entry HF 1.95 →
    // ladderFor(1.95) = 1.86 / 1.61 / 1.34 / 1.09, and the line says where the numbers come from.
    await expect(page.getByTestId("health-band")).toContainText("warning < 1.86");
    await expect(page.getByTestId("ladder-line")).toContainText("derived from this position's recorded entry health factor 1.95");
    await expect(page.getByTestId("keeper-rungs")).toContainText("Warning (HF < 1.86)");
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
    await expect(page.getByTestId("quote")).toContainText(Math.floor(0.1 * CBBTC_USD).toLocaleString("en-US")); // 0.1 cbBTC at the snapshot price
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
      await noOverflow(`/new strategy (${mode})`);
      await page.getByTestId("strategy-hold").click();
      await page.getByTestId("wizard-next").click();
      await noOverflow(`/new review (${mode})`);
      await page.getByTestId("forecast-ack").check();
      await page.getByTestId("wizard-next").click();
      await noOverflow(`/new sign (${mode})`);
    }

    // Page-level overflow is not the only kind. A grid item can paint OUTSIDE its own card while the
    // document never scrolls sideways — which is what the collateral cards did: at 1024 the cbZEC card's
    // "disabled" chip ended 31px past the card's right edge, in the gutter before the projection panel.
    // Neither project viewport (1360, 390) covers the band where three cards sit beside that panel, so
    // nothing failed. This checks the cards against their OWN boxes, at a width inside that band.
    const noEscapingContent = async (label: string) => {
      const escaped = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="collateral-"], [data-testid^="strategy-"]')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1)
          .map((el) => `${(el as HTMLElement).dataset.testid}: content ${el.scrollWidth}px in a ${el.clientWidth}px card`),
      );
      expect(escaped, label).toEqual([]);
    };
    await page.setViewportSize({ width: 1024, height: 720 });
    for (const mode of ["simple", "advanced"] as const) {
      await page.goto("/new");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await setMode(page, mode);
      await noOverflow(`/new collateral at 1024 (${mode})`);
      await noEscapingContent(`/new collateral at 1024 (${mode})`);
      await page.getByTestId("wizard-next").click();
      await page.getByTestId("wizard-next").click();
      await noOverflow(`/new strategy at 1024 (${mode})`);
      await noEscapingContent(`/new strategy at 1024 (${mode})`);
    }
  });

  test("wallet connect control: one primary button disconnected; connected pill (avatar, address, chain, USDC) with copy/Basescan/disconnect menu", async ({ page }) => {
    const { errors } = watchConsole(page);
    // Plain load, no mock-wallet param: deterministically disconnected — never races the auto-connect effect.
    await page.goto("/dashboard");
    await expect(page.getByTestId("wallet-connect-button")).toBeVisible();

    // Fresh load WITH the param: the mock wallet auto-connects on mount, so wait for the pill directly
    // rather than asserting the button's continued presence, which would race the connect.
    await page.goto("/dashboard?e2eMockWallet=1");
    const pill = page.getByTestId("wallet-pill");
    await expect(pill).toBeVisible();
    await expect(pill.getByTestId("wallet-avatar")).toBeVisible();
    await expect(pill.getByTestId("wallet-address")).toHaveText(DEMO_ACCOUNT.slice(0, 6) + "…" + DEMO_ACCOUNT.slice(-4));
    await expect(pill.getByTestId("wallet-chain-badge")).toContainText("Base");
    await expect(pill.getByTestId("wallet-usdc-balance")).toBeVisible();

    await pill.click();
    const menu = page.getByTestId("wallet-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("wallet-menu-copy")).toContainText("Copy address");
    await expect(menu.getByTestId("wallet-menu-basescan")).toHaveAttribute("href", `https://basescan.org/address/${DEMO_ACCOUNT}`);
    await expect(menu.getByTestId("wallet-menu-disconnect")).toContainText("Disconnect");

    await menu.getByTestId("wallet-menu-disconnect").click();
    await expect(page.getByTestId("wallet-connect-button")).toBeVisible();
    await expect(page.getByTestId("wallet-pill")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
