import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRY_HF_FLOOR, HF_LADDER, FEES } from "@zyo/shared";
import {
  baseUnitsToUsd,
  clearsGate,
  currentLtvBps,
  exactHalfWidthPct,
  fmtHalfWidth,
  fromAtomic,
  hfBand,
  liveLiquidationPrice,
  planLoan,
  planYield,
  rayToAprPct,
  toAtomic,
  wadHealthFactor,
} from "../lib/math";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test("rayToAprPct: Aave ray rate → percent (VERIFIED USDC 4.828%)", () => {
  close(rayToAprPct(48_280_000_000_000_000_000_000_000n), 4.828);
  close(rayToAprPct(0n), 0);
  close(rayToAprPct(10n ** 27n), 100);
});

test("wadHealthFactor: 1e18-scaled, uint256.max = no debt = Infinity", () => {
  close(wadHealthFactor(1_950_000_000_000_000_000n), 1.95);
  assert.equal(wadHealthFactor(2n ** 256n - 1n), Number.POSITIVE_INFINITY);
  close(wadHealthFactor(999_900_000_000_000_000n), 0.9999);
});

test("baseUnitsToUsd: Aave 8-dp base currency", () => {
  close(baseUnitsToUsd(3_981_544_500_000n), 39_815.445);
});

test("toAtomic / fromAtomic round-trip across decimals", () => {
  assert.equal(toAtomic("0.5", 8), 50_000_000n);
  assert.equal(toAtomic("15926.18", 6), 15_926_180_000n);
  assert.equal(toAtomic("5", 18), 5n * 10n ** 18n);
  assert.equal(toAtomic("0.000000001", 8), 0n); // below precision truncates, never rounds up
  close(fromAtomic(50_000_000n, 8), 0.5);
  close(fromAtomic(15_926_180_000n, 6), 15_926.18);
  assert.throws(() => toAtomic("abc", 8), RangeError);
  assert.throws(() => toAtomic("", 8), RangeError);
  assert.throws(() => toAtomic("1e5", 8), RangeError);
});

test("planLoan: cbBTC at LT 7800 (chain read) and the 40% preset", () => {
  const p = planLoan({ collateralAmount: 0.5, collateralPriceUsd: 79_630.89, liquidationThresholdBps: 7800, ltvBps: 4000, borrowAprPct: 4.828 });
  close(p.collateralUsd, 39_815.445);
  close(p.borrowUsdc, 15_926.178);
  close(p.entryHf, 1.95); // 0.78 / 0.40
  assert.ok(p.entryHf >= ENTRY_HF_FLOOR);
  close(p.liquidationDropPct, (1 - 4000 / 7800) * 100);
  close(p.liquidationPriceUsd, 79_630.89 * (4000 / 7800), 1e-6);
  close(p.borrowCostUsdPerYear, 15_926.178 * 0.04828);
  // Every ladder rung present, in ladder order, at price = liq × rung.hf
  assert.equal(p.rungs.length, HF_LADDER.length);
  p.rungs.forEach(({ rung, priceUsd }, i) => {
    assert.equal(rung.id, HF_LADDER[i].id);
    close(priceUsd, p.liquidationPriceUsd * rung.hf, 1e-6);
  });
});

test("planLoan: WETH at LT 8300 and the top (50%) preset opens above the floor", () => {
  const p = planLoan({ collateralAmount: 5, collateralPriceUsd: 2453.45, liquidationThresholdBps: 8300, ltvBps: 5000, borrowAprPct: 4.828 });
  close(p.entryHf, 1.66);
  assert.ok(p.entryHf >= ENTRY_HF_FLOOR);
  close(p.liquidationDropPct, (1 - 5000 / 8300) * 100);
});

test("planLoan: zero LTV = no debt, no liquidation", () => {
  const p = planLoan({ collateralAmount: 1, collateralPriceUsd: 100, liquidationThresholdBps: 7800, ltvBps: 0, borrowAprPct: 5 });
  assert.equal(p.borrowUsdc, 0);
  assert.equal(p.entryHf, Number.POSITIVE_INFINITY);
  assert.equal(p.liquidationPriceUsd, 0);
});

test("planLoan rejects non-bps thresholds (fail closed)", () => {
  assert.throws(() => planLoan({ collateralAmount: 1, collateralPriceUsd: 1, liquidationThresholdBps: 0.78, ltvBps: 4000, borrowAprPct: 5 }), RangeError);
  assert.throws(() => planLoan({ collateralAmount: 1, collateralPriceUsd: 1, liquidationThresholdBps: 7800, ltvBps: NaN, borrowAprPct: 5 }), RangeError);
});

test("planYield mirrors the yield model: fees split from served gross/net, lpNet + supply − borrow", () => {
  // The model's cbBTC/USDC sheltered cell (MODEL-NUMBERS.md): gross 14.13, net 10.81 (×0.765), realized 9.96, drag −15.25, lpNet −5.29
  const y = planYield({
    borrowUsdc: 10_000,
    collateralUsd: 25_000,
    borrowAprPct: 4.828,
    supplyAprPct: 0.012,
    emissionsGrossPct: 14.13,
    emissionsNetPct: 10.81,
    emissionsRealizedPct: 9.96,
    dragPct: -15.25,
    lpNetPct: -5.29,
    engineFeeBps: 1500,
  });
  close(y.grossEmissionsUsd, 1413);
  close(y.netEmissionsUsd, 1081);
  // Oilskin's share = net/(1−perf) × perf = 1081/0.9 × 0.1; engine = gross − net − oilskin
  close(y.oilskinFeeUsd, (1081 / 0.9) * (FEES.performanceBps / 10_000), 1e-9);
  close(y.engineFeeUsd, 1413 - 1081 - y.oilskinFeeUsd, 1e-9);
  close(y.realizedEmissionsUsd, 996);
  close(y.dragUsd, -1525);
  close(y.lpNetUsd, -529);
  close(y.borrowCostUsd, 482.8);
  close(y.supplyInterestUsd, 3);
  close(y.totalUsd, 3 - 529 - 482.8);
  // userNet = supply + LTV × (lpNet − borrow) = 0.012 + 0.4 × (−5.29 − 4.828) = −4.035 (doc: −4.03)
  close(y.userNetPct, (y.totalUsd / 25_000) * 100);
  close(y.userNetPct, 0.012 + 0.4 * (-5.29 - 4.828), 1e-9);
});

test("clearsGate: BOTH served models must beat the served borrow; unreadable or uncalibrated never clears", () => {
  assert.equal(clearsGate(10, 4.828, 9.4), true);
  assert.equal(clearsGate(4.828, 4.828, 9.4), false);
  assert.equal(clearsGate(-5.29, 4.828, -5.21), false);
  assert.equal(clearsGate(null, 4.828, 9.4), false);
  assert.equal(clearsGate(50, null, 40), false);
  assert.equal(clearsGate(NaN, 4.828, 9.4), false);
  // The model-uncertainty band: the closed form clears, the calibrated one does not.
  assert.equal(clearsGate(4.83, 4.828, 4.6), false);
  assert.equal(clearsGate(4.83, 4.828, -4.9), false);
  // A cell priced only once is never offered.
  assert.equal(clearsGate(10, 4.828, null), false);
  assert.equal(clearsGate(10, 4.828), false);
});

test("exactHalfWidthPct: 1.0001^(bps/2) − 1, matching the model (4500 → 25.23%, 1500 → 7.79%, 300 → 1.51%)", () => {
  close(exactHalfWidthPct(4500), 25.23, 0.005);
  close(exactHalfWidthPct(1500), 7.79, 0.005);
  close(exactHalfWidthPct(300), 1.51, 0.005);
  close(exactHalfWidthPct(2356), 12.5, 0.005);
  assert.equal(fmtHalfWidth(4500), "±25.2%");
  assert.equal(fmtHalfWidth(1500), "±7.79%");
  assert.throws(() => exactHalfWidthPct(0), RangeError);
});

test("hfBand follows the shared ladder", () => {
  assert.equal(hfBand(Number.POSITIVE_INFINITY).label, "No debt");
  assert.equal(hfBand(1.95).rung, null);
  assert.equal(hfBand(1.95).kind, "good");
  assert.equal(hfBand(1.45).rung?.id, "warn");
  assert.equal(hfBand(1.45).kind, "warn");
  assert.equal(hfBand(1.3).rung?.id, "repay");
  assert.equal(hfBand(1.1).rung?.id, "derisk");
  assert.equal(hfBand(1.1).kind, "crit");
  assert.equal(hfBand(1.0).rung?.id, "emergency");
  assert.throws(() => hfBand(NaN)); // fail closed, from shared rungFor
});

test("currentLtvBps and liveLiquidationPrice from account data", () => {
  assert.equal(currentLtvBps(39_815.445, 15_926.178), 4000);
  assert.equal(currentLtvBps(0, 0), 0);
  close(liveLiquidationPrice(39_815.445, 15_926.178, 7800, 79_630.89), 79_630.89 * (4000 / 7800), 1e-6);
  assert.equal(liveLiquidationPrice(100, 0, 7800, 10), 0);
});
