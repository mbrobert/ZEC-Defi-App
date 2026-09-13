import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRY_HF_FLOOR, ladderFor, maxOfferedLtvBps } from "@zyo/shared";
import { BANNED_WORDS } from "../lib/copy";
import { DEMO_MARKET, demoForecast, demoGate } from "../lib/demo";
import { findCell } from "../lib/forecast";
import { planLoan } from "../lib/math";
import type { MarketRead } from "../lib/reads";
import { bindingPlain, clampEntryHf, defaultWizardState, deriveReview, entryHfForBorrow, hfAcknowledgmentText, hfBoundsFor, needsHfAcknowledgment } from "../lib/wizard";

test("hfBoundsFor: the slider's stop on each asset is the smaller of the 1.25 floor and Aave's max LTV, named — the floor binds on both Base assets (cbBTC 62.40 %, WETH 66.40 %) and both marks are offered", () => {
  const btc = hfBoundsFor(DEMO_MARKET, "cbBTC")!;
  assert.equal(btc.floor, ENTRY_HF_FLOOR);
  assert.equal(btc.maxLtvBps, 6240, "floor(7800 × 100 / 125); Aave's 7300 sits above it");
  assert.equal(btc.binding, "entry_hf_floor");
  assert.equal(btc.minHf, 1.25);
  assert.equal(btc.maxLtvBps, maxOfferedLtvBps(7800));
  assert.deepEqual(btc.marks.map((m) => [m.id, m.hf, m.offered]), [["sheltered", 1.55, true], ["expert", 1.3, true]]);
  assert.equal(btc.marks[1]!.why, null);
  const weth = hfBoundsFor(DEMO_MARKET, "WETH")!;
  assert.equal(weth.maxLtvBps, 6640);
  assert.equal(weth.minHf, 1.25);
  assert.equal(weth.binding, "entry_hf_floor");
  assert.equal(bindingPlain("entry_hf_floor", 1.25), "the registry's entry floor of 1.25");
  assert.equal(bindingPlain("venue_max_ltv", 1.25), "Aave's own maximum LTV for this asset");
});

test("hfBoundsFor: at the old 1.55 floor the derived top was 50.32 % (no cap clipping it any more); on a 60 % threshold the floor gives 48 %; Aave's LTV binds when it is the smaller, and then the marks under it say why", () => {
  const at155 = hfBoundsFor(DEMO_MARKET, "cbBTC", 1.55)!;
  assert.equal(at155.maxLtvBps, 5032);
  assert.equal(at155.minHf, 1.55);
  assert.equal(at155.binding, "entry_hf_floor");
  assert.deepEqual(at155.marks.map((x) => x.offered), [true, false], "Expert 1.30 sits under a 1.55 floor");
  assert.match(at155.marks[1]!.why!, /Expert \(1\.30\) is under the lowest health factor offered for cbBTC today, 1\.55 — the registry's entry floor of 1\.55/);
  const m: MarketRead = { ...DEMO_MARKET, reserves: { ...DEMO_MARKET.reserves, WETH: { ...DEMO_MARKET.reserves.WETH!, liquidationThresholdBps: 6000 } } };
  const low = hfBoundsFor(m, "WETH")!;
  assert.equal(low.maxLtvBps, 4800, "floor(6000 × 100 / 125)");
  assert.equal(low.binding, "entry_hf_floor");
  assert.equal(low.minHf, 1.25);
  const venue = { ...DEMO_MARKET, reserves: { ...DEMO_MARKET.reserves, cbBTC: { ...DEMO_MARKET.reserves.cbBTC!, ltvBps: 6000 } } };
  const v = hfBoundsFor(venue, "cbBTC")!;
  assert.equal(v.binding, "venue_max_ltv");
  assert.equal(v.maxLtvBps, 6000);
  assert.equal(v.minHf, 1.3, "0.78 / 0.60: Aave's 60 % stops the slider at 1.30, above the 1.25 floor");
  assert.deepEqual(v.marks.map((x) => x.offered), [true, true], "1.30 is exactly reachable");
});

test("hfBoundsFor: an LTV→0 deprecation offers nothing (null), as do a frozen reserve and an unlisted asset", () => {
  const zero = { ...DEMO_MARKET, reserves: { ...DEMO_MARKET.reserves, cbBTC: { ...DEMO_MARKET.reserves.cbBTC!, ltvBps: 0 } } };
  assert.equal(hfBoundsFor(zero, "cbBTC"), null);
  const frozen: MarketRead = { ...DEMO_MARKET, reserves: { ...DEMO_MARKET.reserves, cbBTC: { ...DEMO_MARKET.reserves.cbBTC!, isFrozen: true } } };
  assert.equal(hfBoundsFor(frozen, "cbBTC"), null);
  assert.equal(hfBoundsFor(DEMO_MARKET, "cbZEC"), null);
});

test("the identity both ways: a typed borrow gives the HF, the HF gives the borrow back to the cent; the clamp pulls a low HF up to the 1.25 floor and lets +∞ (borrow nothing) through", () => {
  const b = hfBoundsFor(DEMO_MARKET, "cbBTC")!;
  const collateralUsd = 0.5 * DEMO_MARKET.reserves.cbBTC!.priceUsd;
  const hf = entryHfForBorrow(15_428.17, collateralUsd, 7800);
  assert.ok(Math.abs(hf - 1.95) < 1e-6, `${hf}`);
  const loan = planLoan({ collateralAmount: 0.5, collateralPriceUsd: DEMO_MARKET.reserves.cbBTC!.priceUsd, liquidationThresholdBps: 7800, entryHf: hf, borrowAprPct: 4.5174 });
  assert.equal(loan.borrowUsdc.toFixed(2), "15428.17");
  assert.equal(entryHfForBorrow(0, collateralUsd, 7800), Number.POSITIVE_INFINITY);
  assert.equal(clampEntryHf(1.2, b), 1.25);
  assert.equal(clampEntryHf(1.3, b), 1.3, "the Expert mark is reachable now");
  assert.equal(clampEntryHf(1.95, b), 1.95);
  assert.equal(clampEntryHf(Number.POSITIVE_INFINITY, b), Number.POSITIVE_INFINITY);
  assert.equal(needsHfAcknowledgment(1.549), true);
  assert.equal(needsHfAcknowledgment(1.55), false);
  assert.equal(needsHfAcknowledgment(Number.POSITIVE_INFINITY), false);
});

test("the sub-mark acknowledgment names the HF, the drawdown and the first and last rungs of THAT ladder, in plain words", () => {
  const text = hfAcknowledgmentText({ entryHf: 1.3, collateral: "cbBTC", drawdownPct: 100 * (1 - 1 / 1.3), rungs: ladderFor(1.3) });
  assert.match(text, /entry health factor of 1\.30, under the Sheltered mark of 1\.55/);
  assert.match(text, /A 23\.1% fall in cbBTC/);
  assert.match(text, /a message, comes at HF 1\.27 and its last, closing the position, at 1\.05/);
  assert.match(text, /Nothing here is advice or a promise/);
  for (const w of BANNED_WORDS) assert.ok(!new RegExp(`\\b${w}\\b`, "i").test(text), `banned word ${w}`);
});

test("deriveReview (hold): every number derived; problems empty for a valid selection", () => {
  const gate = demoGate();
  const st = { ...defaultWizardState("cbBTC"), entryHf: 1.95, strategy: { kind: "hold" as const } };
  const d = deriveReview(st, DEMO_MARKET, gate)!;
  assert.deepEqual(d.problems, []);
  assert.equal(d.loan.ltvBps, 4000, "LTV at entry = LT ÷ HF");
  assert.equal(d.bounds.minHf, 1.25);
  assert.equal(d.liquidationThresholdBps, 7800);
  assert.ok(Math.abs(d.loan.entryHf - 1.95) < 1e-9);
  assert.deepEqual(d.loan.rungs.map((x) => x.rung.hf), ladderFor(1.95).map((r) => r.hf), "the ladder is this entry HF's, not the floor's");
  assert.equal(d.verdict, null);
  assert.equal(d.yieldPlan, null);
  // carry = borrow cost − supply interest
  assert.ok(Math.abs(d.holdCostUsdPerYear - (d.loan.borrowCostUsdPerYear - (d.loan.collateralUsd * DEMO_MARKET.reserves.cbBTC!.supplyAprPct) / 100)) < 1e-9);
});

test("deriveReview (lp): a pool the model forecasts at a loss is priced, flagged as not beating the borrow, and NOT a problem (D4: shown, acknowledged, allowed)", () => {
  const gate = demoGate();
  const forecast = demoForecast();
  const entry = gate.verdicts.find((e) => e.poolId === "aero-cbbtc-usdc" && e.setting === "sheltered" && e.collateral === "cbBTC")!;
  const st = { ...defaultWizardState("cbBTC"), entryHf: 1.95, strategy: { kind: "lp" as const, entry } };
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
  const d = deriveReview({ ...defaultWizardState("cbBTC"), entryHf: 1.95, strategy: { kind: "lp", entry } }, DEMO_MARKET, gate, refusing)!;
  assert.ok(d.problems.some((p) => /paused USDC borrowing/.test(p)));
});

test("deriveReview (lp): a clearing verdict yields a positive plan and no gate problem", () => {
  const gate = demoGate();
  const base = gate.verdicts.find((e) => e.poolId === "aero-cbbtc-usdc" && e.setting === "sheltered" && e.collateral === "cbBTC")!;
  const clearing = { ...base, qualifies: true, reason: null, lpNetPct: 12, emissionsRealizedPct: 27.25, dragPct: -15.25 };
  const view = { ...gate, verdicts: gate.verdicts.map((v) => (v === base ? clearing : v)) };
  const d = deriveReview({ ...defaultWizardState("cbBTC"), entryHf: 1.95, strategy: { kind: "lp", entry: clearing } }, DEMO_MARKET, view)!;
  assert.equal(d.gateOk, true);
  assert.deepEqual(d.problems, []);
  assert.ok(d.yieldPlan!.totalUsd > 0);
});

test("deriveReview (lp): a verdict for a different collateral than chosen is refused", () => {
  const gate = demoGate();
  const entry = gate.verdicts.find((e) => e.collateral === "WETH")!;
  const d = deriveReview({ ...defaultWizardState("cbBTC"), entryHf: 1.95, strategy: { kind: "lp", entry } }, DEMO_MARKET, gate)!;
  // the WETH verdict for the same pool × setting exists for cbBTC too, so it is re-fetched for cbBTC
  assert.equal(d.verdict?.collateral, "cbBTC");
});

test("deriveReview flags: missing amount, missing strategy, an HF under the 1.25 floor, borrow nothing, and the sub-mark acknowledgment — the default Sheltered mark itself is offered", () => {
  const gate = demoGate();
  const d1 = deriveReview({ ...defaultWizardState("cbBTC"), amount: "0", entryHf: 1.95 }, DEMO_MARKET, gate)!;
  assert.ok(d1.problems.some((p) => /amount/i.test(p)));
  assert.ok(d1.problems.some((p) => /strategy/i.test(p)));

  // The default state carries the Sheltered mark (1.55), offered on cbBTC at the 1.25 floor: no problem.
  const dflt = deriveReview({ ...defaultWizardState("cbBTC"), strategy: { kind: "hold" } }, DEMO_MARKET, gate)!;
  assert.deepEqual(dflt.problems, []);
  assert.equal(dflt.loan.ltvBps, 5032);

  const under = deriveReview({ ...defaultWizardState("cbBTC"), entryHf: 1.2, strategy: { kind: "hold" } }, DEMO_MARKET, gate)!;
  assert.ok(under.problems.some((p) => /1\.20 is under the lowest offered for cbBTC today, 1\.25 \(the registry's entry floor of 1\.25\)/.test(p)), under.problems.join(" | "));

  const none = deriveReview({ ...defaultWizardState("cbBTC"), entryHf: Number.POSITIVE_INFINITY, strategy: { kind: "hold" } }, DEMO_MARKET, gate)!;
  assert.ok(none.problems.some((p) => /nothing to deploy/.test(p)));
  assert.equal(none.loan.borrowUsdc, 0);

  // The Expert mark (1.30) is offered and needs the acknowledgment; its ladder is 1.27 / 1.19 / 1.11 / 1.05.
  const unticked = deriveReview({ ...defaultWizardState("cbBTC"), entryHf: 1.3, strategy: { kind: "hold" } }, DEMO_MARKET, gate)!;
  assert.deepEqual(unticked.problems, ["Tick the acknowledgment under the slider: you chose a health factor under the Sheltered mark of 1.55."]);
  const ticked = deriveReview({ ...defaultWizardState("cbBTC"), entryHf: 1.3, hfAcknowledged: true, strategy: { kind: "hold" } }, DEMO_MARKET, gate)!;
  assert.deepEqual(ticked.problems, []);
  assert.equal(ticked.bounds.binding, "entry_hf_floor");
  assert.equal(ticked.bounds.minHf, 1.25);
  assert.equal(ticked.loan.ltvBps, 6000, "floor(7800 / 1.30)");
  assert.deepEqual(ticked.loan.rungs.map((x) => x.rung.hf), [1.27, 1.19, 1.11, 1.05]);
  // Exactly on the floor: allowed, LTV 62.40 %, and its ladder is the floor's own (1.23 / 1.16 / 1.09 / 1.05).
  const onFloor = deriveReview({ ...defaultWizardState("cbBTC"), entryHf: 1.25, hfAcknowledged: true, strategy: { kind: "hold" } }, DEMO_MARKET, gate)!;
  assert.deepEqual(onFloor.problems, []);
  assert.equal(onFloor.loan.ltvBps, 6240);
  assert.deepEqual(onFloor.loan.rungs.map((x) => x.rung.hf), [1.23, 1.16, 1.09, 1.05]);
});

test("deriveReview returns null when the collateral reserve is unreadable", () => {
  assert.equal(deriveReview({ ...defaultWizardState("cbBTC"), collateral: "cbZEC" }, DEMO_MARKET, demoGate()), null);
});
