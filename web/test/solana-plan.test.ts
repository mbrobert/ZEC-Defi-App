// The Solana open plan on the demo snapshot (the yield evaluator on the 2026-09-12 capture): the slider's bounds
// name Kamino's cap, the identity holds both ways, the grant is sized to the position, the steps are the ones signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRY_HF_FLOOR, HF_MARKS, ladderFor } from "@zyo/shared";
import { clampSolanaHf, DEFAULT_GRANT_CHOICE, grantParamsFor, openSteps, planSolanaOpen, SOLANA_GRANT, solanaHfBounds, solanaHfForBorrow, VENUE_CAP_MARGIN_BPS } from "../lib/solana/plan";
import { demoSolanaBorrow, normalizeSolanaBorrow, solanaBorrowPath, solanaRefusalPlain, unavailableSolanaBorrow } from "../lib/solana/yield";

const view = demoSolanaBorrow();

test("the demo snapshot is the capture: slot 446,506,191, Kamino's 40 / 65, a ZEC price inside the band, labelled demo", () => {
  assert.equal(view.source, "demo");
  assert.equal(view.slot, 446_506_191);
  assert.equal(view.ltvCapBps, 4000);
  assert.equal(view.liquidationThresholdBps, 6500);
  assert.equal(view.hfAtVenueCap, 1.625);
  assert.ok(view.zecPriceUsd! > 400 && view.zecPriceUsd! < 2000);
  assert.equal(view.stale, false);
  assert.deepEqual(view.refusals, []);
  assert.ok(view.maxFundableUsdc! > 0);
});

test("bounds: a quarter of a percent above Kamino's cap (HF 1.629, not 1.625) is the lowest offered when the floor is under it; both marks are not offered and say why", () => {
  const b = solanaHfBounds(view, ENTRY_HF_FLOOR)!;
  assert.ok(b);
  if (ENTRY_HF_FLOOR < 1.625) {
    // the cap exactly is refused by Kamino (localnet, 2026-09-20: BorrowTooLarge); the margin is what the specs borrow at
    assert.equal(VENUE_CAP_MARGIN_BPS, 25);
    assert.equal(b.minHf, 1.629);
    assert.ok(b.minHf > 1.625);
    assert.equal(b.binding, "venue_max_ltv");
  } else {
    assert.equal(b.minHf, ENTRY_HF_FLOOR);
    assert.equal(b.binding, "entry_hf_floor");
  }
  for (const m of b.marks) {
    assert.equal(m.offered, m.hf >= b.minHf - 1e-9);
    if (!m.offered) assert.match(m.why!, /Kamino's own 40 % loan-to-value cap|entry floor/);
  }
  assert.equal(b.marks.length, HF_MARKS.length);
  assert.equal(clampSolanaHf(1.3, b), b.minHf);
  assert.equal(clampSolanaHf(2, b), 2);
  assert.equal(clampSolanaHf(Number.POSITIVE_INFINITY, b), Number.POSITIVE_INFINITY);
  assert.equal(solanaHfBounds({ liquidationThresholdBps: null, ltvCapBps: null, entryHfFloor: 1.25 }), null, "no numbers, no bounds");
});

test("the identity both ways: 10 ZEC at the cap borrows 40 % of value at HF 1.625; typing the borrow gives the HF back; ∞ borrows nothing", () => {
  const P = view.zecPriceUsd!;
  const p = planSolanaOpen({ collateralZec: 10, entryHf: 1.625, view })!;
  assert.ok(Math.abs(p.collateralUsd - 10 * P) < 1e-9);
  assert.ok(Math.abs(p.borrowUsdc - ((10 * P * 0.65) / 1.625 / view.usdcPriceUsd!)) < 0.011, "the borrow is the identity's debt floored to a cent");
  assert.equal(p.ltvBps, 4000);
  assert.ok(Math.abs(p.liquidationPriceUsd! - (p.borrowUsdc * view.usdcPriceUsd!) / (10 * 0.65)) < 1e-9);
  assert.ok(Math.abs(p.drawdownPct! - 100 * (1 - 1 / 1.625)) < 1e-9);
  assert.equal(p.collateralUnits, 1_000_000_000n);
  assert.equal(p.borrowUnits, BigInt(Math.round(p.borrowUsdc * 1e6)));
  assert.equal(p.fundable, p.borrowUsdc <= view.maxFundableUsdc!);
  assert.deepEqual(p.rungs.map((r) => r.id), ladderFor(1.625).map((r) => r.id));
  assert.ok(Math.abs(solanaHfForBorrow(p.borrowUsdc * view.usdcPriceUsd!, p.collateralUsd, 6500) - 1.625) < 1e-4, "the cent floor moves the HF by less than 1e-4");
  const none = planSolanaOpen({ collateralZec: 10, entryHf: Number.POSITIVE_INFINITY, view })!;
  assert.equal(none.borrowUsdc, 0);
  assert.equal(none.ltvBps, 0);
  assert.equal(none.liquidationPriceUsd, null);
  assert.equal(none.fundable, true);
  assert.equal(planSolanaOpen({ collateralZec: 10, entryHf: 2, view: unavailableSolanaBorrow("kamino_unavailable") }), null, "no price, no plan");
  const whale = planSolanaOpen({ collateralZec: 100_000, entryHf: 1.7, view })!;
  assert.equal(whale.fundable, false, "more than the pool can lend today");
});

test("the grant is sized to the position: 30 days, one day per period, the whole debt and collateral as budgets, 2 %, every rung", () => {
  const p = planSolanaOpen({ collateralZec: 10, entryHf: 2, view })!;
  const g = grantParamsFor(p, 1_789_000_000);
  assert.equal(g.expiryTs, BigInt(1_789_000_000 + 30 * 86_400));
  assert.equal(g.periodSecs, 86_400n);
  assert.equal(g.repayUsdcPerPeriod, p.borrowUnits);
  assert.equal(g.sellZecPerPeriod, p.collateralUnits);
  assert.equal(g.maxSellSlippageBps, 200);
  assert.equal(g.allowedRungs, 0b1111);
  assert.equal(SOLANA_GRANT.expiryDays, 30);
  // decision 1: the keeper may sell, on by default; Advanced mode may say no, which is a sell budget of zero and nothing else
  assert.equal(DEFAULT_GRANT_CHOICE.keeperMaySell, true);
  const repayOnly = grantParamsFor(p, 1_789_000_000, { keeperMaySell: false });
  assert.equal(repayOnly.sellZecPerPeriod, 0n);
  assert.deepEqual({ ...repayOnly, sellZecPerPeriod: g.sellZecPerPeriod }, g, "every other field is the default's");
});

test("the grant step's sentence says what the keeper may do: sell within the budget by default, or repay only and nothing else", () => {
  const p = planSolanaOpen({ collateralZec: 10, entryHf: 2, view })!;
  const yes = openSteps(p, { accountExists: true, keeperConfigured: true }).find((s) => s.id === "grant")!;
  const no = openSteps(p, { accountExists: true, keeperConfigured: true, keeperMaySell: false }).find((s) => s.id === "grant")!;
  assert.match(yes.sentence, /sell up to 10 ZEC per day/);
  assert.match(no.sentence, /may not sell your ZEC/);
  assert.match(no.sentence, /sell budget is zero/);
  assert.doesNotMatch(no.sentence, /sell up to/);
  assert.equal(openSteps(p, { accountExists: true, keeperConfigured: false, keeperMaySell: false }).some((s) => s.id === "grant"), false, "no keeper, no grant, whatever the choice");
});

test("the steps are the transactions signed: init only for a new account, borrow only when there is one, grant only with a keeper and a borrow", () => {
  const p = planSolanaOpen({ collateralZec: 10, entryHf: 2, view })!;
  assert.deepEqual(openSteps(p, { accountExists: false, keeperConfigured: true }).map((s) => s.id), ["init", "deposit", "borrow", "grant"]);
  assert.deepEqual(openSteps(p, { accountExists: true, keeperConfigured: false }).map((s) => s.id), ["deposit", "borrow"]);
  const none = planSolanaOpen({ collateralZec: 10, entryHf: Number.POSITIVE_INFINITY, view })!;
  assert.deepEqual(openSteps(none, { accountExists: true, keeperConfigured: true }).map((s) => s.id), ["deposit"]);
  for (const s of openSteps(p, { accountExists: false, keeperConfigured: true })) assert.ok(s.sentence.length > 40 && /[.]$/.test(s.sentence), s.id);
});

test("the route client: the path carries only positive numbers; normalisation keeps finite numbers and strings and nothing else", () => {
  assert.equal(solanaBorrowPath({}), "/v1/solana/borrow");
  assert.equal(solanaBorrowPath({ collateralZec: 10, entryHf: 1.55 }), "/v1/solana/borrow?collateral=10&entryHf=1.55");
  assert.equal(solanaBorrowPath({ collateralZec: 0, amountUsdc: -3, entryHf: 0.5 }), "/v1/solana/borrow");
  const v = normalizeSolanaBorrow({ zecPriceUsd: "1000", poolAvailableUsdc: 5, refusals: ["oracle_stale", 3], allowed: true, disclosures: ["bridged_zec"], stale: false, bindingCap: "made_up", entryHfFloor: 1.25 }, "live");
  assert.equal(v.zecPriceUsd, null);
  assert.equal(v.poolAvailableUsdc, 5);
  assert.deepEqual(v.refusals, ["oracle_stale"]);
  assert.equal(v.allowed, false, "allowed only with no refusals");
  assert.equal(v.bindingCap, null);
  assert.equal(v.stale, false);
  assert.equal(normalizeSolanaBorrow({}, "live").stale, true, "absent means stale");
  for (const r of ["kamino_unavailable", "kamino_stale", "venue_paused", "borrow_disabled", "reserve_not_active", "oracle_stale", "oracle_out_of_band", "entry_hf_below_floor", "venue_ltv_exceeded", "pool_cannot_fund", "borrow_limit_reached", "borrow_cap_24h_reached", "utilization_limit_reached", "deposit_limit_reached"]) {
    assert.ok(solanaRefusalPlain(r).length > 20 && !/_/.test(solanaRefusalPlain(r)), r);
  }
});
