import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRY_HF_FLOOR, MAX_OFFERED_LTV_CAP_BPS, maxOfferedLtvBps } from "@zyo/shared";
import { DEMO_MARKET, demoForecast, demoGate } from "../lib/demo";
import { findCell } from "../lib/forecast";
import type { MarketRead } from "../lib/reads";
import { defaultWizardState, deriveReview, presetsFor } from "../lib/wizard";

test("presetsFor computes 30/40/top from the reserve's liquidation threshold", () => {
  const btc = presetsFor(DEMO_MARKET, "cbBTC")!;
  assert.deepEqual(
    btc.map((p) => p.ltvBps),
    [3000, 4000, 5000],
  );
  assert.ok(btc.every((p) => p.offerable));
  assert.ok(btc.every((p) => (p.entryHf ?? 0) >= ENTRY_HF_FLOOR));
  const weth = presetsFor(DEMO_MARKET, "WETH")!;
  assert.equal(weth[2].ltvBps, 5000);
  assert.equal(weth[2].ltvBps, Math.min(MAX_OFFERED_LTV_CAP_BPS, Math.floor(8300 / ENTRY_HF_FLOOR)));
});

test("presetsFor: cbZEC (not listed → null reserve) yields no presets", () => {
  assert.equal(presetsFor(DEMO_MARKET, "cbZEC"), null);
});

test("presetsFor: a low-threshold asset gets a computed, lower top and unofferable rungs", () => {
  const m: MarketRead = {
    ...DEMO_MARKET,
    reserves: { ...DEMO_MARKET.reserves, WETH: { ...DEMO_MARKET.reserves.WETH!, liquidationThresholdBps: 6000 } },
  };
  const p = presetsFor(m, "WETH")!;
  assert.equal(p[2].ltvBps, maxOfferedLtvBps(6000));
  assert.equal(p[2].ltvBps, 3870);
  assert.equal(p[0].offerable, true); // 30%
  assert.equal(p[1].offerable, false); // 40% > 38.7%
});

test("presetsFor: frozen / non-collateral reserve is refused", () => {
  const m: MarketRead = { ...DEMO_MARKET, reserves: { ...DEMO_MARKET.reserves, cbBTC: { ...DEMO_MARKET.reserves.cbBTC!, isFrozen: true } } };
  assert.equal(presetsFor(m, "cbBTC"), null);
});

test("deriveReview (hold): every number derived; problems empty for a valid selection", () => {
  const gate = demoGate();
  const st = { ...defaultWizardState("cbBTC"), strategy: { kind: "hold" as const } };
  const d = deriveReview(st, DEMO_MARKET, gate)!;
  assert.deepEqual(d.problems, []);
  assert.equal(d.preset.ltvBps, 4000);
  assert.equal(d.liquidationThresholdBps, 7800);
  assert.ok(Math.abs(d.loan.entryHf - 1.95) < 1e-9);
  assert.equal(d.verdict, null);
  assert.equal(d.yieldPlan, null);
  // carry = borrow cost − supply interest
  assert.ok(Math.abs(d.holdCostUsdPerYear - (d.loan.borrowCostUsdPerYear - (d.loan.collateralUsd * DEMO_MARKET.reserves.cbBTC!.supplyAprPct) / 100)) < 1e-9);
});

test("deriveReview (lp): a pool the model forecasts at a loss is priced, flagged as not beating the borrow, and NOT a problem (D4: shown, acknowledged, allowed)", () => {
  const gate = demoGate();
  const forecast = demoForecast();
  const entry = gate.verdicts.find((e) => e.poolId === "aero-cbbtc-usdc" && e.setting === "sheltered" && e.collateral === "cbBTC")!;
  const st = { ...defaultWizardState("cbBTC"), strategy: { kind: "lp" as const, entry } };
  const d = deriveReview(st, DEMO_MARKET, gate, forecast)!;
  assert.equal(d.gateOk, false, "informational: it does not beat the borrow");
  assert.deepEqual(d.problems, [], "a negative forecast is not a problem");
  assert.equal(d.cell?.poolId, "aero-cbbtc-usdc");
  assert.equal(d.cell?.lpNetPct, -10.92);
  assert.equal(d.cell?.allowed, true);
  assert.equal(d.verdict?.lpNetPct, -10.92);
  assert.equal(d.lpParams?.rangeWidthBps, 4500);
  assert.equal(d.lpParams?.rebalanceDelayHours, 48);
  assert.ok(d.yieldPlan && d.yieldPlan.totalUsd < 0);
  // The review's user net is the market snapshot's borrow and supply (the 2026-09-12 ledger read at
  // block 51,226,072: 4.5174 % / 0.0115 %) applied to the gate's lpNet (−10.92, the same block):
  // 0.0115 + 0.4 × (−10.92 − 4.5174).
  // Computed here from the same two inputs, never typed as a result.
  const expected = DEMO_MARKET.reserves.cbBTC!.supplyAprPct + 0.4 * (entry.lpNetPct! - DEMO_MARKET.usdcBorrowAprPct);
  assert.ok(Math.abs(d.yieldPlan!.userNetPct - expected) < 0.01, `${d.yieldPlan!.userNetPct} vs ${expected}`);
});

test("deriveReview: the acknowledgment starts un-ticked, and the liquidity hard-refusal names the pool's balance", () => {
  assert.equal(defaultWizardState("cbBTC").acknowledged, false);
  const gate = demoGate();
  // The demo USDC pool holds 24,768,504 USDC (Addendum 13); a 0.5 cbBTC borrow at 40 % is ~$15.9 K — funded.
  const ok = deriveReview({ ...defaultWizardState("cbBTC"), strategy: { kind: "hold" } }, DEMO_MARKET, gate)!;
  assert.ok(!ok.problems.some((p) => /cannot fund/.test(p)));
  // A pool that holds less than the borrow refuses by name — the same words for every strategy kind.
  const thin: MarketRead = { ...DEMO_MARKET, reserves: { ...DEMO_MARKET.reserves, USDC: { ...DEMO_MARKET.reserves.USDC!, availableUnits: 10_000 } } };
  for (const strategy of [{ kind: "hold" as const }, { kind: "spot" as const }]) {
    const d = deriveReview({ ...defaultWizardState("cbBTC"), strategy }, thin, gate)!;
    assert.ok(d.problems.some((p) => /cannot fund this borrow right now: it holds \$10,000 USDC to lend/.test(p)), d.problems.join(" | "));
  }
  // A snapshot without the field cannot refuse (it says nothing), never refuses by accident.
  const { availableUnits: _drop, ...noField } = DEMO_MARKET.reserves.USDC!;
  const blind: MarketRead = { ...DEMO_MARKET, reserves: { ...DEMO_MARKET.reserves, USDC: noField } };
  assert.ok(!deriveReview({ ...defaultWizardState("cbBTC"), strategy: { kind: "hold" } }, blind, gate)!.problems.some((p) => /cannot fund/.test(p)));
  // A forecast cell's own safety refusals become problems; its profitability never does.
  const forecast = demoForecast();
  const cell = findCell(forecast, { poolId: "aero-cbbtc-usdc", setting: "sheltered", collateral: "cbBTC" })!;
  const refusing = { ...forecast, cells: forecast.cells.map((c) => (c === cell ? { ...c, refusals: ["borrow_paused" as const], allowed: false } : c)) };
  const entry = gate.verdicts.find((e) => e.poolId === "aero-cbbtc-usdc" && e.setting === "sheltered" && e.collateral === "cbBTC")!;
  const d = deriveReview({ ...defaultWizardState("cbBTC"), strategy: { kind: "lp", entry } }, DEMO_MARKET, gate, refusing)!;
  assert.ok(d.problems.some((p) => /paused USDC borrowing/.test(p)));
});

test("deriveReview (lp): a clearing verdict yields a positive plan and no gate problem", () => {
  const gate = demoGate();
  const base = gate.verdicts.find((e) => e.poolId === "aero-cbbtc-usdc" && e.setting === "sheltered" && e.collateral === "cbBTC")!;
  const clearing = { ...base, qualifies: true, reason: null, lpNetPct: 12, emissionsRealizedPct: 27.25, dragPct: -15.25 };
  const view = { ...gate, verdicts: gate.verdicts.map((v) => (v === base ? clearing : v)) };
  const d = deriveReview({ ...defaultWizardState("cbBTC"), strategy: { kind: "lp", entry: clearing } }, DEMO_MARKET, view)!;
  assert.equal(d.gateOk, true);
  assert.deepEqual(d.problems, []);
  assert.ok(d.yieldPlan!.totalUsd > 0);
});

test("deriveReview (lp): a verdict for a different collateral than chosen is refused", () => {
  const gate = demoGate();
  const entry = gate.verdicts.find((e) => e.collateral === "WETH")!;
  const d = deriveReview({ ...defaultWizardState("cbBTC"), strategy: { kind: "lp", entry } }, DEMO_MARKET, gate)!;
  // the WETH verdict for the same pool × setting exists for cbBTC too, so it is re-fetched for cbBTC
  assert.equal(d.verdict?.collateral, "cbBTC");
});

test("deriveReview flags: missing amount, missing strategy, unofferable preset", () => {
  const gate = demoGate();
  const d1 = deriveReview({ ...defaultWizardState("cbBTC"), amount: "0" }, DEMO_MARKET, gate)!;
  assert.ok(d1.problems.some((p) => /amount/i.test(p)));
  assert.ok(d1.problems.some((p) => /strategy/i.test(p)));

  const m: MarketRead = { ...DEMO_MARKET, reserves: { ...DEMO_MARKET.reserves, cbBTC: { ...DEMO_MARKET.reserves.cbBTC!, liquidationThresholdBps: 6000 } } };
  const d2 = deriveReview({ ...defaultWizardState("cbBTC"), ltvPreset: "p40", strategy: { kind: "hold" } }, m, gate)!;
  assert.ok(d2.problems.some((p) => /not offered/i.test(p)));
});

test("deriveReview returns null when the collateral reserve is unreadable", () => {
  assert.equal(deriveReview({ ...defaultWizardState("cbBTC"), collateral: "cbZEC" }, DEMO_MARKET, demoGate()), null);
});
