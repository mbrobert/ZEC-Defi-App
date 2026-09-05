import assert from "node:assert/strict";
import { test } from "node:test";
import { COLLATERAL_SYMBOLS, ltvPresets, maxOfferedLtvBps, poolById, type CollateralSymbol } from "@zyo/shared";
import { evaluateGate, evaluatePool, MAX_ABS_NET_PCT, type GateInputs } from "../src/gate.js";
import { keepFactor, lpNetPct, priceHalfWidth, SETTINGS, userNetPct } from "../src/model.js";
import { emissionsFixture, NOW_S, ratesFixture, volatilityFixture } from "./fixtures/model.js";

const CBBTC_POOL = poolById("aero-cbbtc-usdc")!;
const ZEC_POOL = poolById("aero-cbzec-usdc")!;
const LINK_POOL = poolById("aero-weth-link")!;
const VOL = volatilityFixture();
const SHELTERED = SETTINGS[0]!;
const WORKING = SETTINGS[2]!;

/** cbBTC/USDC in-range APRs from the 2026-08-31 words at the S4 widths (scripts/lp-sim.py). */
const CBBTC_APR = { "4500": 14.131, "2356": 27.9, "1500": 44.6286, "784": 86.0, "300": 226.8496, "150": 456.0 };

function inputs(over: Partial<GateInputs> = {}): GateInputs {
  return {
    pool: CBBTC_POOL,
    setting: SHELTERED,
    collateral: "cbBTC",
    rates: { ...ratesFixture(), stale: false },
    emissions: { ...emissionsFixture(CBBTC_POOL.id, CBBTC_APR), stale: false },
    volatility: VOL,
    nowSeconds: NOW_S,
    ...over,
  };
}

test("cbBTC/USDC sheltered at 4.828 %: refused net_below_borrow with the model numbers (lpNet ≈ −5.29 %)", () => {
  const v = evaluateGate(inputs());
  assert.equal(v.qualifies, false);
  assert.equal(v.reason, "net_below_borrow");
  assert.equal(v.rangeWidthBps, 4500);
  assert.ok(Math.abs(v.halfWidth - priceHalfWidth(4500)) < 1e-12);
  assert.equal(v.emissionsGrossPct, 14.13);
  assert.ok(Math.abs(v.emissionsNetPct! - 14.131 * keepFactor("SNUGGLEFI")) < 0.01);
  assert.ok(Math.abs(v.lpNetPct! - -5.29) < 0.02);
  assert.equal(v.borrowAprPct, 4.828);
  assert.equal(v.collateralSupplyAprPct, 0.012);
  assert.equal(v.sigma, 0.4);
  assert.equal(v.setting, "sheltered");
  assert.equal(v.preset, "CONSERVATIVE");
});

test("break-even numbers are reported for a failing cell (what would flip it)", () => {
  const v = evaluateGate(inputs());
  // net 10.81 > 4.828 so a σ exists at which it would clear; and an emissions multiple
  assert.ok(v.breakEvenSigma !== null && v.breakEvenSigma! > 0 && v.breakEvenSigma! < 0.4);
  assert.ok(v.breakEvenEmissionsMultiple !== null && v.breakEvenEmissionsMultiple! > 1);
});

test("user net per LTV comes from the LIVE liquidation threshold via shared ltvPresets (never typed)", () => {
  const v = evaluateGate(inputs());
  const presets = ltvPresets(7800);
  assert.deepEqual(v.userNet.map((u) => u.ltvBps), presets.map((p) => p.ltvBps));
  assert.deepEqual(v.userNet.map((u) => u.offerable), presets.map((p) => p.offerable));
  for (const u of v.userNet) {
    const expected = userNetPct(0.012, u.ltvBps, v.lpNetPct!, 4.828);
    assert.ok(Math.abs(u.userNetPct - expected) < 0.011, `${u.ltvBps}: ${u.userNetPct} vs ${expected}`);
  }
  // a lower liquidation threshold lowers the top preset (D2 lesson: at LT 0.70 the top is below 50 %)
  const low = evaluateGate(inputs({ rates: { ...ratesFixture({ collateral: { cbBTC: { ...ratesFixture().collateral.cbBTC!, liquidationThresholdBps: 7000 }, WETH: ratesFixture().collateral.WETH! } }), stale: false } }));
  assert.equal(low.userNet[2]!.ltvBps, maxOfferedLtvBps(7000));
  assert.ok(low.userNet[2]!.ltvBps < 5000);
  // WETH collateral: its own supply APR and LT
  const weth = evaluateGate(inputs({ collateral: "WETH" }));
  assert.equal(weth.collateralSupplyAprPct, 1.843);
  assert.equal(weth.borrowAprPct, 4.828); // the borrow does not depend on the collateral
});

test("qualifies: a synthetic 2.5× emissions cbBTC/USDC clears at 4.828 % — and the verdict math is the model's", () => {
  const boosted = Object.fromEntries(Object.entries(CBBTC_APR).map(([k, v]) => [k, v * 2.5]));
  const v = evaluateGate(inputs({ emissions: { ...emissionsFixture(CBBTC_POOL.id, boosted), stale: false } }));
  assert.equal(v.qualifies, true);
  assert.equal(v.reason, null);
  const net = 14.131 * 2.5 * keepFactor("SNUGGLEFI");
  assert.ok(Math.abs(v.lpNetPct! - lpNetPct(net, 0.4, priceHalfWidth(4500))) < 0.011);
  assert.ok(v.lpNetPct! > 4.828);
  assert.ok(v.userNet.every((u) => u.userNetPct > 0.012));
});

test("the gate is per setting: the correlated pool uses the correlated widths", () => {
  const pool = poolById("aero-weth-cbbtc")!;
  const em = emissionsFixture(pool.id, { "4500": 1, "2356": 2.7037, "1500": 3, "784": 8.3151, "300": 5, "150": 43.8235 });
  const vs = evaluatePool(pool, ["cbBTC"], { rates: { ...ratesFixture(), stale: false }, emissions: { ...em, stale: false }, volatility: VOL, nowSeconds: NOW_S });
  assert.deepEqual(vs.map((v) => v.rangeWidthBps), [2356, 784, 150]);
  assert.equal(vs[0]!.reason, "emissions_below_borrow"); // 2.70 × 0.765 = 2.07 < 4.828
  assert.equal(vs[1]!.reason, "net_below_borrow");
});

test("cbZEC/USDC can NEVER be offered: rewardRate 0 → no_emissions, even if an APR table were smuggled in", () => {
  const smuggled = emissionsFixture(ZEC_POOL.id, { "4500": 999, "2356": 999, "1500": 999, "784": 999, "300": 999, "150": 999 }, {
    rewardRateWeiPerSec: "0",
    periodFinish: 0,
    epochActive: false,
  });
  for (const setting of SETTINGS) {
    for (const collateral of COLLATERAL_SYMBOLS) {
      const v = evaluateGate(inputs({ pool: ZEC_POOL, setting, collateral, emissions: { ...smuggled, stale: false } }));
      assert.equal(v.qualifies, false, `${setting.id}/${collateral}`);
      assert.ok(v.reason === "no_emissions" || v.reason === "collateral_disabled");
      assert.equal(v.emissionsNetPct ?? 0, 0);
    }
  }
  // and even with epochActive:true typed into the sample, rewardRate 0 still refuses
  const lie = { ...smuggled, epochActive: true, periodFinish: NOW_S + 86_400 };
  assert.equal(evaluateGate(inputs({ pool: ZEC_POOL, emissions: { ...lie, stale: false } })).reason, "no_emissions");
});

test("cbZEC as COLLATERAL is refused (registry enabled:false) before any rate is consulted", () => {
  const v = evaluateGate(inputs({ collateral: "cbZEC", rates: null }));
  assert.equal(v.reason, "collateral_disabled");
  assert.equal(v.qualifies, false);
});

test("every missing/stale/unsafe input refuses with its own reason (fail closed)", () => {
  const cases: [string, Partial<GateInputs>, string][] = [
    ["no rates", { rates: null }, "rates_unavailable"],
    ["stale rates", { rates: { ...ratesFixture(), stale: true } }, "rates_stale"],
    ["collateral frozen on Aave", { rates: { ...ratesFixture({ collateral: { cbBTC: { ...ratesFixture().collateral.cbBTC!, isFrozen: true }, WETH: ratesFixture().collateral.WETH! } }), stale: false } }, "collateral_not_active"],
    ["collateral flag off on Aave", { rates: { ...ratesFixture({ collateral: { cbBTC: { ...ratesFixture().collateral.cbBTC!, usageAsCollateralEnabled: false }, WETH: ratesFixture().collateral.WETH! } }), stale: false } }, "collateral_not_active"],
    ["collateral missing from sample", { rates: { ...ratesFixture({ collateral: { WETH: ratesFixture().collateral.WETH! } }), stale: false } }, "collateral_not_active"],
    ["no emissions sample", { emissions: null }, "emissions_unavailable"],
    ["stale emissions", { emissions: { ...emissionsFixture(CBBTC_POOL.id, CBBTC_APR), stale: true } }, "emissions_stale"],
    ["epoch lapsed by periodFinish", { emissions: { ...emissionsFixture(CBBTC_POOL.id, CBBTC_APR, { periodFinish: NOW_S - 1 }), stale: false } }, "no_emissions"],
    ["epoch flagged inactive", { emissions: { ...emissionsFixture(CBBTC_POOL.id, CBBTC_APR, { epochActive: false }), stale: false } }, "no_emissions"],
    ["staked-liquidity outlier", { emissions: { ...emissionsFixture(CBBTC_POOL.id, CBBTC_APR, { outlier: true }), stale: false } }, "staked_liquidity_outlier"],
    ["no staked liquidity", { emissions: { ...emissionsFixture(CBBTC_POOL.id, null), stale: false } }, "no_staked_liquidity"],
    ["width missing from the table", { emissions: { ...emissionsFixture(CBBTC_POOL.id, { "1500": 44 }), stale: false } }, "no_staked_liquidity"],
    ["NaN in the table", { emissions: { ...emissionsFixture(CBBTC_POOL.id, { ...CBBTC_APR, "4500": NaN }), stale: false } }, "no_staked_liquidity"],
    ["emissions below borrow", { emissions: { ...emissionsFixture(CBBTC_POOL.id, { ...CBBTC_APR, "4500": 6 }), stale: false } }, "emissions_below_borrow"],
    ["no σ for the pool", { pool: LINK_POOL, emissions: { ...emissionsFixture(LINK_POOL.id, CBBTC_APR), stale: false } }, "no_volatility_input"],
  ];
  for (const [name, over, reason] of cases) {
    const v = evaluateGate(inputs(over));
    assert.equal(v.qualifies, false, name);
    assert.equal(v.reason, reason, name);
  }
});

test("emissions_below_borrow is decided on NET emissions (after both fees), not gross", () => {
  // gross 6.0 → net 4.59 < 4.828 although gross > borrow
  const v = evaluateGate(inputs({ emissions: { ...emissionsFixture(CBBTC_POOL.id, { ...CBBTC_APR, "4500": 6.0 }), stale: false } }));
  assert.equal(v.reason, "emissions_below_borrow");
  assert.equal(v.emissionsGrossPct, 6);
  assert.ok(v.emissionsNetPct! < 4.828);
});

test("absolute outcome bound: user net is clamped to ±MAX_ABS_NET_PCT even on absurd inputs", () => {
  const absurd = Object.fromEntries(Object.entries(CBBTC_APR).map(([k]) => [k, 1e9]));
  const v = evaluateGate(inputs({ emissions: { ...emissionsFixture(CBBTC_POOL.id, absurd), stale: false }, setting: WORKING }));
  for (const u of v.userNet) assert.ok(Math.abs(u.userNetPct) <= MAX_ABS_NET_PCT);
});

test("evaluatePool: one verdict per setting × collateral, in settings-major order", () => {
  const vs = evaluatePool(CBBTC_POOL, COLLATERAL_SYMBOLS, { rates: { ...ratesFixture(), stale: false }, emissions: { ...emissionsFixture(CBBTC_POOL.id, CBBTC_APR), stale: false }, volatility: VOL, nowSeconds: NOW_S });
  assert.equal(vs.length, SETTINGS.length * COLLATERAL_SYMBOLS.length);
  const expected: [string, CollateralSymbol][] = [];
  for (const s of SETTINGS) for (const c of COLLATERAL_SYMBOLS) expected.push([s.id, c]);
  assert.deepEqual(vs.map((v) => [v.setting, v.collateral]), expected);
  assert.ok(vs.filter((v) => v.collateral === "cbZEC").every((v) => v.reason === "collateral_disabled"));
});
