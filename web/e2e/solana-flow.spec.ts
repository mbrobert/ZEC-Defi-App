import { expect, test, type Page } from "@playwright/test";

/**
 * The Solana flow in forced demo mode (no wallet, no RPC, no yield service): every screen renders from the labelled
 * snapshot, one decision per screen, the risk before the button, Kamino's cap named on the slider, and zero console
 * errors — at desktop and phone widths (playwright.config.ts projects).
 */
async function collectErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return errors;
}

test("solana wizard: Kamino's words → amount with the pool view → the slider at Kamino's cap → review → sign says connect", async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto("/solana/new");
  await expect(page.getByTestId("kamino-wording")).toContainText("bridged representation");
  await expect(page.getByTestId("kamino-wording")).toContainText("Kamino");
  await expect(page.getByTestId("sol-wizard-next")).toBeDisabled();
  await page.getByTestId("ack-bridged").check();
  await page.getByTestId("sol-wizard-next").click();

  await expect(page.getByTestId("pool-view")).toContainText("snapshot");
  await expect(page.getByTestId("pool-fundable")).toContainText("$355,599.95");
  await expect(page.getByTestId("sol-wizard-next")).toBeDisabled();
  await page.getByTestId("zec-amount").fill("10");
  await expect(page.getByTestId("sol-wizard-next")).toBeEnabled();
  await page.getByTestId("sol-wizard-next").click();

  // the slider opens at the most Kamino allows, HF 1.625 — its cap, named
  await expect(page.getByTestId("sol-entry-hf")).toHaveText("1.63");
  const slider = page.getByTestId("sol-hf-slider");
  await expect(slider).toHaveAttribute("data-binding", "venue_max_ltv");
  await expect(page.getByText(/Kamino's own 40 % loan-to-value cap/).first()).toBeVisible();
  await expect(page.getByTestId("sol-mark-sheltered")).toBeDisabled();
  await expect(page.getByTestId("sol-plan")).toContainText("Liquidation begins at");
  await expect(page.getByTestId("sol-rate-after")).toContainText("%");
  // a cautious HF typed in drives the borrow down and needs no acknowledgment
  await page.getByTestId("sol-hf-input").fill("2.5");
  await page.getByTestId("sol-hf-input").press("Enter");
  await expect(page.getByTestId("sol-entry-hf")).toHaveText("2.50");
  await expect(page.getByTestId("sol-hf-ack")).toHaveCount(0);
  await page.getByTestId("sol-wizard-next").click();

  // step 4: where the borrowed USDC goes — the default keeps it on Solana and names the reserve
  await expect(page.getByTestId("sol-deploy")).toContainText("stays on Solana as the reserve");
  await expect(page.getByTestId("sol-loop-keep")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("sol-wizard-next").click();

  await expect(page.getByTestId("sol-review")).toContainText("Entry health factor");
  await expect(page.getByTestId("sol-review-loop")).toContainText("stays in your Oilskin account on Solana");
  await expect(page.getByText("The way out is through the Oilskin program")).toBeVisible();
  await expect(page.getByText("Circle can freeze USDC")).toBeVisible();
  await expect(page.getByTestId("sol-wizard-next")).toBeDisabled();
  await page.getByTestId("sol-ack-review").check();
  await page.getByTestId("sol-wizard-next").click();

  await expect(page.getByTestId("sol-step-deposit")).toContainText("simulated");
  await expect(page.getByText(/Connect a Solana wallet to sign/)).toBeVisible();
  expect(errors, errors.join("\n")).toEqual([]);
});

test("solana review, Advanced: whether the keeper may sell ZEC is the owner's choice; Simple takes the default and shows no control", async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto("/solana/new");
  await page.getByTestId("mode-advanced").click();
  await expect(page.getByTestId("mode-advanced")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("ack-bridged").check();
  await page.getByTestId("sol-wizard-next").click();
  await page.getByTestId("zec-amount").fill("10");
  await page.getByTestId("sol-wizard-next").click();
  await page.getByTestId("sol-wizard-next").click();
  await page.getByTestId("sol-wizard-next").click();
  await expect(page.getByTestId("sol-review")).toContainText("Entry health factor");
  // the default: the keeper may sell, and the risk list says so
  const control = page.getByTestId("sol-keeper-sell");
  await expect(control).toBeVisible();
  await expect(page.getByTestId("sol-keeper-sell-yes")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("sol-risk-keeper-sells")).toContainText("The keeper may sell your ZEC");
  await expect(page.getByTestId("sol-risk-keeper-no-sell")).toHaveCount(0);
  // no: the card swaps for the one that says what it costs, and the acknowledgment is still required
  await page.getByTestId("sol-keeper-sell-no").click();
  await expect(page.getByTestId("sol-keeper-sell-no")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("sol-risk-keeper-no-sell")).toContainText("the keeper may not sell your ZEC");
  await expect(page.getByTestId("sol-risk-keeper-no-sell")).toContainText("liquidates at a health factor of 1");
  await expect(page.getByTestId("sol-risk-keeper-sells")).toHaveCount(0);
  await expect(page.getByTestId("sol-wizard-next")).toBeDisabled();
  // Simple mode: no control, and Oilskin's default is back whatever was chosen
  await page.getByTestId("mode-simple").click();
  await expect(page.getByTestId("mode-simple")).toHaveAttribute("aria-checked", "true");
  await expect(control).toHaveCount(0);
  await expect(page.getByTestId("sol-risk-keeper-sells")).toBeVisible();
  await expect(page.getByTestId("sol-risk-keeper-no-sell")).toHaveCount(0);
  expect(errors, errors.join("\n")).toEqual([]);
});

test("solana deploy: the loop's forecast is Kamino-priced; a chosen pool needs the acknowledgment, names the reserve, and the crossing is listed as not signable", async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto("/solana/new");
  await page.getByTestId("mode-advanced").click();
  await page.getByTestId("ack-bridged").check();
  await page.getByTestId("sol-wizard-next").click();
  await page.getByTestId("zec-amount").fill("10");
  await page.getByTestId("sol-wizard-next").click();
  await page.getByTestId("sol-wizard-next").click();
  // the screen: the forecast line names Kamino, every pool × setting is listed in Advanced, the keep option is on
  await expect(page.getByTestId("sol-loop-forecast-line")).toContainText("Kamino");
  await expect(page.getByTestId("sol-loop-forecast-line")).toContainText("demo");
  await expect(page.locator('[data-testid^="sol-loop-cell-"]')).toHaveCount(27);
  await expect(page.locator('[data-testid^="sol-loop-cell-"][data-priced]').first()).toBeVisible();
  await expect(page.getByTestId("sol-loop-disabled")).toHaveCount(0); // the e2e server runs with the flag on
  await expect(page.getByTestId("sol-wizard-next")).toBeEnabled();
  // Simple lists one cell per pool; back to Advanced for the choice below
  await page.getByTestId("mode-simple").click();
  await expect(page.locator('[data-testid^="sol-loop-cell-"]')).toHaveCount(9);
  await page.getByTestId("mode-advanced").click();
  await expect(page.locator('[data-testid^="sol-loop-cell-"]')).toHaveCount(27);
  // choose the cbBTC/USDC sheltered cell: the summary, the two disclosures and the acknowledgment appear; Continue waits for it
  await page.getByTestId("sol-loop-cell-aero-cbbtc-usdc-sheltered").click();
  await expect(page.getByTestId("sol-loop-cell-aero-cbbtc-usdc-sheltered")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("sol-loop-keep")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("sol-loop-summary")).toContainText("Stays on Solana");
  await expect(page.getByTestId("sol-loop-summary")).toContainText("the reserve");
  await expect(page.getByTestId("sol-loop-disclosure-cross_chain_circle")).toContainText("Circle");
  await expect(page.getByTestId("sol-loop-ack-text")).toContainText("stays on Solana as the reserve");
  await expect(page.getByTestId("sol-wizard-next")).toBeDisabled();
  await page.getByTestId("sol-loop-ack").check();
  await expect(page.getByTestId("sol-wizard-next")).toBeEnabled();
  await page.getByTestId("sol-wizard-next").click();
  // review names both amounts; sign lists the crossing's four steps as not in this build
  // the web names a pair token0/token1 as the pool does (USDC/cbBTC), the prototypes the other way round
  await expect(page.getByTestId("sol-review-loop")).toContainText(/crosses to Base into (USDC\/cbBTC|cbBTC\/USDC) \(sheltered\)/);
  await expect(page.getByTestId("sol-review-loop")).toContainText("stays on Solana as the reserve");
  await page.getByTestId("sol-ack-review").check();
  await page.getByTestId("sol-wizard-next").click();
  await expect(page.getByTestId("sol-afterwards")).toContainText("not signable in this build");
  await expect(page.getByTestId("sol-after-set_base_account")).toBeVisible();
  await expect(page.getByTestId("sol-after-deposit_for_burn")).toContainText("Burn");
  await expect(page.getByTestId("sol-after-cross_chain_grant")).toContainText("not in this build");
  expect(errors, errors.join("\n")).toEqual([]);
});

test("solana positions page: demo says the build names no program, lists the risks, links to a new position", async ({ page }) => {
  const errors = await collectErrors(page);
  await page.goto("/solana");
  await expect(page.getByText(/names no Solana program/)).toBeVisible();
  await expect(page.getByText("The keeper may sell your ZEC")).toBeVisible();
  await expect(page.getByTestId("sol-new")).toHaveAttribute("href", "/solana/new");
  expect(errors, errors.join("\n")).toEqual([]);
});
