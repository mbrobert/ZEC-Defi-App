/**
 * evaluateSolanaBorrow on the mainnet capture: the facts file's projection table recomputed live, the identity
 * at the chosen HF with Kamino's cap named when it binds, the caps and limits as klend enforces them, and every
 * safety refusal by name. Nothing here is a profitability verdict (BUILD-PLAN D4/D5).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ENTRY_HF_FLOOR } from "@zyo/shared";
import { capRoom, evaluateSolanaBorrow, type SolanaBorrowInputs } from "../src/solanaBorrow.js";
import type { KaminoSample } from "../src/sources/kamino.js";
import { FIXTURE_BLOCK_TIME, kaminoSampleFixture, withFactsPool } from "./fixtures/kamino.js";

const NOW = 1_789_240_500_000;
const fresh = (s: KaminoSample = kaminoSampleFixture(NOW)) => ({ ...s, stale: false });
const q = (over: Partial<SolanaBorrowInputs>): SolanaBorrowInputs => ({ sample: fresh(), collateralZec: null, amountUsdc: null, entryHf: null, entryHfFloor: ENTRY_HF_FLOOR, ...over });

test("the pool as it is: depth, limits, caps, utilisation and the rate every borrower pays now — from the reserve bytes, dated by slot", () => {
  const v = evaluateSolanaBorrow(q({}));
  assert.equal(v.chain, "solana");
  assert.equal(v.slot, 446_506_191);
  assert.equal(v.stale, false);
  assert.deepEqual(v.refusals, []);
  assert.equal(v.allowed, true);
  assert.equal(v.ltvCapBps, 4000);
  assert.equal(v.liquidationThresholdBps, 6500);
  assert.equal(v.hfAtVenueCap, 1.625);
  // the pinned units of the capture (kamino.test.ts) in whole USDC
  const available = 355_599.950997;
  const borrowed = 446_186.304801;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  assert.equal(v.poolAvailableUsdc, r2(available));
  assert.equal(v.poolBorrowedUsdc, r2(borrowed));
  assert.equal(v.poolSupplyUsdc, r2(available + borrowed));
  assert.equal(v.borrowLimitUsdc, 2_000_000);
  assert.equal(v.remainingBorrowLimitUsdc, r2(2_000_000 - borrowed));
  assert.equal(v.remaining24hBorrowUsdc, r2(1_000_000 - 3_622.993258), "1,000,000 − the 3,622.99 net borrowed in the window");
  assert.equal(v.maxFundableUsdc, r2(available), "the pool's liquidity binds before its limit and its cap");
  assert.equal(v.utilizationNowPct, 55.65);
  assert.ok(Math.abs(v.borrowAprNowPct! - 3.4199) < 0.001);
  assert.equal(v.depositLimitZec, 13_000);
  assert.ok(Math.abs(v.remainingDepositZec! - (13_000 - 1_202.6072)) < 0.001);
  assert.equal(v.remaining24hWithdrawZec, 3_111.0161, "3,000 ZEC cap plus the 111 ZEC net deposited in the window");
  assert.ok(v.zecPriceUsd! > 400 && v.zecPriceUsd! < 2000);
  assert.ok(v.oracleAgeS! >= 0 && v.oracleAgeS! <= 180);
  assert.equal(v.oracleMaxAgeS, 180);
  assert.equal(v.amountUsdc, null);
  assert.equal(v.hfAtEntry, null);
  assert.ok(!v.disclosures.includes("liquidation_at_chosen_hf"));
  assert.ok(v.disclosures.includes("bridged_zec") && v.disclosures.includes("program_exit_only") && v.disclosures.includes("kamino_parameters_mutable"));
});

test("the facts file's projection table, recomputed: +$84,000 takes the pool to 65.76 % and 4.547 %; +$358,199 is more than the pool has", () => {
  const s = fresh(withFactsPool(kaminoSampleFixture(NOW)));
  const now = evaluateSolanaBorrow(q({ sample: s }));
  assert.equal(now.utilizationNowPct, 55.27);
  assert.ok(Math.abs(now.borrowAprNowPct! - 3.378) < 0.003, `${now.borrowAprNowPct}`);
  const plus84k = evaluateSolanaBorrow(q({ sample: s, amountUsdc: 84_000 }));
  assert.deepEqual(plus84k.refusals, []);
  assert.equal(plus84k.utilizationAfterPct, 65.76);
  assert.ok(Math.abs(plus84k.borrowAprAfterPct! - 4.547) < 0.003, `${plus84k.borrowAprAfterPct}`);
  assert.ok(Math.abs(plus84k.poolSharePctAfter! - 15.95) < 0.01, "84,000 of 526,517 outstanding");
  const plus300k = evaluateSolanaBorrow(q({ sample: s, amountUsdc: 300_000 }));
  assert.ok(Math.abs(plus300k.borrowAprAfterPct! - 11.674) < 0.02, `${plus300k.borrowAprAfterPct}`);
  const empty = evaluateSolanaBorrow(q({ sample: s, amountUsdc: 358_199 }));
  assert.deepEqual(empty.refusals, ["pool_cannot_fund"]);
  assert.equal(empty.allowed, false);
  assert.equal(empty.utilizationAfterPct, 100, "clamped: the request exceeds the pool");
});

test("the identity at the chosen HF: 10 ZEC at Sheltered 1.55 asks 41.9 % LTV, Kamino's 40 % cap binds and HF lands at 1.625; at HF 2 the chosen level binds", () => {
  const s = fresh();
  const P = s.scopeZec.priceUsd;
  const sheltered = evaluateSolanaBorrow(q({ sample: s, collateralZec: 10, entryHf: 1.55 }));
  assert.deepEqual(sheltered.refusals, []);
  assert.ok(Math.abs(sheltered.collateralUsd! - 10 * P) < 0.01);
  assert.ok(Math.abs(sheltered.borrowAtChosenHfUsdc! - (10 * P * 0.65) / 1.55 / s.scopeUsdc.priceUsd) < 0.01);
  assert.ok(Math.abs(sheltered.borrowAtVenueCapUsdc! - (10 * P * 0.4) / s.scopeUsdc.priceUsd) < 0.01);
  assert.equal(sheltered.bindingCap, "venue_max_ltv");
  assert.equal(sheltered.borrowSuggestedUsdc, sheltered.borrowAtVenueCapUsdc);
  assert.equal(sheltered.amountUsdc, sheltered.borrowSuggestedUsdc, "the borrow judged is the suggested one");
  assert.ok(Math.abs(sheltered.hfAtEntry! - 1.625) < 0.001, `${sheltered.hfAtEntry}`);
  assert.equal(sheltered.ltvAtEntryBps, 4000);
  assert.ok(Math.abs(sheltered.liquidationPriceUsd! - P * 0.4 / 0.65) < 0.01, "the price at which HF reaches 1");
  assert.ok(Math.abs(sheltered.drawdownToLiquidationPct! - 38.46) < 0.01);
  assert.ok(sheltered.disclosures.includes("liquidation_at_chosen_hf"));
  const cautious = evaluateSolanaBorrow(q({ sample: s, collateralZec: 10, entryHf: 2 }));
  assert.equal(cautious.bindingCap, "chosen_hf");
  assert.ok(Math.abs(cautious.hfAtEntry! - 2) < 0.001);
  assert.equal(cautious.ltvAtEntryBps, 3250);
  const noHf = evaluateSolanaBorrow(q({ sample: s, collateralZec: 10 }));
  assert.equal(noHf.bindingCap, ENTRY_HF_FLOOR < 1.625 ? "venue_max_ltv" : "entry_hf_floor", "without a chosen HF the floor's borrow is proposed, inside the cap");
});

test("a typed borrow is judged, not resized: above the cap it is venue_ltv_exceeded and below the floor entry_hf_below_floor; a whale is bounded by the pool", () => {
  const s = fresh();
  const P = s.scopeZec.priceUsd;
  const tooMuch = evaluateSolanaBorrow(q({ sample: s, collateralZec: 10, amountUsdc: 10 * P * 0.45 }));
  assert.ok(tooMuch.refusals.includes("venue_ltv_exceeded"));
  assert.equal(tooMuch.refusals.includes("entry_hf_below_floor"), 0.65 / 0.45 < ENTRY_HF_FLOOR, `HF 1.44 against the shared floor ${ENTRY_HF_FLOOR}`);
  assert.equal(tooMuch.amountUsdc, Math.round(10 * P * 0.45 * 100) / 100);
  const fine = evaluateSolanaBorrow(q({ sample: s, collateralZec: 10, amountUsdc: 10 * P * 0.3 }));
  assert.deepEqual(fine.refusals, []);
  assert.ok(Math.abs(fine.hfAtEntry! - 0.65 / 0.3) < 0.01);
  const whale = evaluateSolanaBorrow(q({ sample: s, collateralZec: 1_000, entryHf: 1.7 }));
  assert.equal(whale.bindingCap, "pool_liquidity");
  assert.equal(whale.borrowSuggestedUsdc, whale.maxFundableUsdc);
  assert.deepEqual(whale.refusals, []);
  const belowFloor = evaluateSolanaBorrow(q({ sample: s, collateralZec: 10, entryHf: ENTRY_HF_FLOOR - 0.05 }));
  assert.ok(belowFloor.refusals.includes("entry_hf_below_floor"));
});

test("the venue's limits and caps as klend enforces them: deposit limit, borrow limit, the 24 h borrow cap (reset once the interval has passed), the utilisation block", () => {
  const base = kaminoSampleFixture(NOW);
  const over = evaluateSolanaBorrow(q({ sample: fresh(base), collateralZec: 12_000 }));
  assert.ok(over.refusals.includes("deposit_limit_reached"), "1,202 supplied + 12,000 > 13,000");
  const smallLimit = fresh({ ...base, usdc: { ...base.usdc, borrowLimitUnits: base.usdc.borrowedUnits + 1_000_000_000n } });
  const limit = evaluateSolanaBorrow(q({ sample: smallLimit, amountUsdc: 2_000 }));
  assert.ok(limit.refusals.includes("borrow_limit_reached"));
  assert.equal(limit.maxFundableUsdc, 1_000);
  const capped = fresh({ ...base, usdc: { ...base.usdc, debtWithdrawalCap: { ...base.usdc.debtWithdrawalCap, configCapacity: 10_000_000_000n, currentTotal: 9_000_000_000n, lastIntervalStartTimestamp: BigInt(FIXTURE_BLOCK_TIME - 100), configIntervalLengthSeconds: 86_400n } } });
  const cap = evaluateSolanaBorrow(q({ sample: capped, amountUsdc: 2_000 }));
  assert.ok(cap.refusals.includes("borrow_cap_24h_reached"));
  assert.equal(cap.remaining24hBorrowUsdc, 1_000);
  const elapsed = fresh({ ...base, usdc: { ...base.usdc, debtWithdrawalCap: { ...capped.usdc.debtWithdrawalCap, lastIntervalStartTimestamp: BigInt(FIXTURE_BLOCK_TIME - 90_000) } } });
  const reset = evaluateSolanaBorrow(q({ sample: elapsed, amountUsdc: 2_000 }));
  assert.ok(!reset.refusals.includes("borrow_cap_24h_reached"), "the interval passed: klend resets the counter on the next borrow");
  assert.equal(reset.remaining24hBorrowUsdc, 10_000);
  assert.equal(capRoom({ configCapacity: 0n, currentTotal: 5n, lastIntervalStartTimestamp: 0n, configIntervalLengthSeconds: 0n }, 1), null, "capacity 0 = no cap");
  const utilBlocked = fresh({ ...base, usdc: { ...base.usdc, utilizationLimitBlockBorrowingAbovePct: 60 } });
  const blocked = evaluateSolanaBorrow(q({ sample: utilBlocked, amountUsdc: 100_000 }));
  assert.ok(blocked.refusals.includes("utilization_limit_reached"));
  assert.ok(!evaluateSolanaBorrow(q({ sample: utilBlocked, amountUsdc: 10_000 })).refusals.includes("utilization_limit_reached"));
});

test("safety refusals by name: no sample, a stale sample, emergency mode, borrowing disabled, an inactive reserve, a stale or out-of-band oracle", () => {
  assert.deepEqual(evaluateSolanaBorrow(q({ sample: null })).refusals, ["kamino_unavailable"]);
  const base = kaminoSampleFixture(NOW);
  assert.deepEqual(evaluateSolanaBorrow(q({ sample: { ...base, stale: true } })).refusals, ["kamino_stale"]);
  assert.ok(evaluateSolanaBorrow(q({ sample: fresh({ ...base, market: { ...base.market, emergencyMode: 1 } }) })).refusals.includes("venue_paused"));
  assert.ok(evaluateSolanaBorrow(q({ sample: fresh({ ...base, market: { ...base.market, borrowDisabled: 1 } }) })).refusals.includes("borrow_disabled"));
  assert.ok(evaluateSolanaBorrow(q({ sample: fresh({ ...base, usdc: { ...base.usdc, status: 1 } }) })).refusals.includes("reserve_not_active"));
  const old = evaluateSolanaBorrow(q({ sample: fresh({ ...base, chainTimeS: base.chainTimeS + 600 }) }));
  assert.ok(old.refusals.includes("oracle_stale"));
  assert.ok(old.oracleAgeS! > 180);
  const cheap = evaluateSolanaBorrow(q({ sample: fresh({ ...base, scopeZec: { ...base.scopeZec, priceUsd: 300 } }) }));
  assert.ok(cheap.refusals.includes("oracle_out_of_band"), "below the reserve's own $400 heuristic");
  const badUsdc = evaluateSolanaBorrow(q({ sample: fresh({ ...base, scopeUsdc: { ...base.scopeUsdc, priceUsd: 0.9 } }) }));
  assert.ok(badUsdc.refusals.includes("oracle_out_of_band"));
  assert.throws(() => evaluateSolanaBorrow(q({ entryHf: 0.5 })), RangeError);
  assert.throws(() => evaluateSolanaBorrow(q({ amountUsdc: -1 })), RangeError);
});
