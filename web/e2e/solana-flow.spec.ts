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

  await expect(page.getByTestId("sol-review")).toContainText("Entry health factor");
  await expect(page.getByText("The way out is through the Oilskin program")).toBeVisible();
  await expect(page.getByText("Circle can freeze USDC")).toBeVisible();
  await expect(page.getByTestId("sol-wizard-next")).toBeDisabled();
  await page.getByTestId("sol-ack-review").check();
  await page.getByTestId("sol-wizard-next").click();

  await expect(page.getByTestId("sol-step-deposit")).toContainText("simulated");
  await expect(page.getByText(/Connect a Solana wallet to sign/)).toBeVisible();
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
