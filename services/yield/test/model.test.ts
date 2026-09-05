import assert from "node:assert/strict";
import { test } from "node:test";
import { FEES, RANGE_PRESETS } from "@zyo/shared";
import {
  breakEvenEmissionsMultiple,
  breakEvenSigma,
  dragPct,
  dragRate,
  emissionsAprPct,
  ENGINE_FEE_BPS,
  keepFactor,
  lpNetPct,
  modelWidthsBps,
  priceHalfWidth,
  realizedEmissionsPct,
  SETTINGS,
  settingWidthBps,
  userNetPct,
  widthBracket,
} from "../src/model.js";

test("priceHalfWidth: the exact FACT-3 conversion for every settled preset (never bps/200)", () => {
  const pct = (bps: number) => Math.round(priceHalfWidth(bps) * 10_000) / 100;
  assert.equal(pct(4500), 25.23);
  assert.equal(pct(1500), 7.79);
  assert.equal(pct(300), 1.51);
  assert.equal(pct(2356), 12.5);
  assert.equal(pct(784), 4.0);
  assert.equal(pct(150), 0.75);
  // the linear approximation is 2.7 points short at the Conservative preset
  assert.ok(priceHalfWidth(4500) - 4500 / 20_000 > 0.027);
  assert.throws(() => priceHalfWidth(0), RangeError);
  assert.throws(() => priceHalfWidth(NaN), RangeError);
});

test("widthBracket: closed-form spot values; full range ≡ 2; narrower ⇒ smaller", () => {
  assert.ok(Math.abs(widthBracket(0.25) - 0.2395474) < 1e-6); // 2 − √0.75 − 1/√1.25
  assert.ok(Math.abs(widthBracket(0.015) - 0.014945) < 1e-5);
  assert.ok(widthBracket(0.999999) < 2 && widthBracket(0.999999) > 1.29);
  assert.ok(widthBracket(0.04) < widthBracket(0.08));
  assert.throws(() => widthBracket(0), RangeError);
  assert.throws(() => widthBracket(1), RangeError);
});

test("keepFactor: engine pools keep (1−engine)(1−perf) = 0.765 today; DIRECT keeps (1−perf)", () => {
  assert.equal(ENGINE_FEE_BPS, 1500);
  assert.ok(Math.abs(keepFactor("SNUGGLEFI") - 0.765) < 1e-12);
  assert.ok(Math.abs(keepFactor("MAXFI") - 0.765) < 1e-12);
  assert.ok(Math.abs(keepFactor("DIRECT") - (1 - FEES.performanceBps / 10_000)) < 1e-12);
});

test("emissionsAprPct: rewardRate 0 → 0; no staked liquidity → null (never Infinity); prices must be > 0", () => {
  const base = { rewardRateWeiPerSec: 1n, aeroUsd: 1, stakedLiquidity: 1, sqrtPriceX96: 2n ** 96n, token1Decimals: 18, token1Usd: 1, halfWidth: 0.1 };
  assert.equal(emissionsAprPct({ ...base, rewardRateWeiPerSec: 0n }), 0);
  assert.equal(emissionsAprPct({ ...base, stakedLiquidity: 0 }), null);
  assert.throws(() => emissionsAprPct({ ...base, aeroUsd: 0 }), RangeError);
  assert.throws(() => emissionsAprPct({ ...base, token1Usd: NaN }), RangeError);
  // scaling sanity: doubling staked liquidity halves the APR; halving width raises it
  const a = emissionsAprPct({ ...base, rewardRateWeiPerSec: 10n ** 18n, stakedLiquidity: 1e18 })!;
  const b = emissionsAprPct({ ...base, rewardRateWeiPerSec: 10n ** 18n, stakedLiquidity: 2e18 })!;
  const c = emissionsAprPct({ ...base, rewardRateWeiPerSec: 10n ** 18n, stakedLiquidity: 1e18, halfWidth: 0.05 })!;
  assert.ok(Math.abs(a / b - 2) < 1e-9);
  assert.ok(c > a);
});

test("drag: σ=0 → 0; rate is σ²/(4·f(w)); monotone in σ and in concentration; bounded at −100 %", () => {
  assert.equal(dragPct(0, 0.1), -0);
  assert.ok(Math.abs(dragRate(0.5, 0.1) - 0.25 / (4 * widthBracket(0.1))) < 1e-12);
  // the ±25.23 % Conservative preset at σ=0.40 is the audit's x ≈ 0.165
  assert.ok(Math.abs(dragRate(0.4, priceHalfWidth(4500)) - 0.1655) < 0.001);
  assert.ok(dragPct(0.6, 0.1) < dragPct(0.3, 0.1));
  assert.ok(dragPct(0.5, 0.02) < dragPct(0.5, 0.2));
  assert.ok(dragPct(5, 0.001) >= -100 && dragPct(5, 0.001) < -99.99); // floating point saturates at exactly −100
  assert.throws(() => dragPct(-1, 0.1), RangeError);
  assert.throws(() => dragPct(NaN, 0.1), RangeError);
});

test("closed form: realized ≤ in-range emissions; lpNet = (1−e^{−x})(r/x − 1); the additive shortcut is NOT what is served", () => {
  const r = 173.54; // cbBTC/USDC working, net in-range, 2026-08-31 words
  const w = priceHalfWidth(300);
  const sig = 0.4;
  const x = dragRate(sig, w);
  assert.ok(realizedEmissionsPct(r, sig, w) < r);
  assert.ok(Math.abs(realizedEmissionsPct(r, 0, w) - r) < 1e-12);
  const expected = 100 * (1 - Math.exp(-x)) * (r / 100 / x - 1);
  assert.ok(Math.abs(lpNetPct(r, sig, w) - expected) < 1e-9);
  // the audit's Monte Carlo cell was −36.7 %; the additive r + drag would say +80 %
  assert.ok(lpNetPct(r, sig, w) < -30 && lpNetPct(r, sig, w) > -35);
  assert.ok(r + dragPct(sig, w) > 75);
});

test("closed form reproduces the 2026-08-31 Monte Carlo cells (cbBTC/USDC sheltered −5.3 %, steady −14.1 %)", () => {
  // In-range net rates at the S4 widths from the raw words (scripts/lp-sim.py):
  assert.ok(Math.abs(lpNetPct(14.131 * 0.765, 0.4, priceHalfWidth(4500)) - -5.29) < 0.05);
  assert.ok(Math.abs(lpNetPct(44.6286 * 0.765, 0.4, priceHalfWidth(1500)) - -14.12) < 0.05);
  assert.ok(Math.abs(lpNetPct(7.625 * 0.765, 0.55, priceHalfWidth(4500)) - -21.86) < 0.05);
});

test("r/x is width-independent: the SIGN of lpNet is the same at every width for a pool", () => {
  // emissions ∝ 1/f(w) and drag rate ∝ 1/f(w): pick an emissions scale k so r = k / f(w)
  for (const k of [0.02, 0.05, 0.2]) {
    const signs = modelWidthsBps().map((bps) => {
      const w = priceHalfWidth(bps);
      return Math.sign(lpNetPct((100 * k) / widthBracket(w), 0.4, w));
    });
    assert.equal(new Set(signs).size, 1, `k=${k}: ${signs.join(",")}`);
  }
});

test("breakEvenSigma: null when emissions ≤ borrow; else lpNet(σ*) = borrow and lpNet is decreasing in σ", () => {
  const w = priceHalfWidth(4500);
  assert.equal(breakEvenSigma(4, 4.828, w), null);
  const be = breakEvenSigma(30, 4.828, w)!;
  assert.ok(be > 0 && be < 5);
  assert.ok(Math.abs(lpNetPct(30, be, w) - 4.828) < 1e-6);
  assert.ok(lpNetPct(30, be - 0.01, w) > 4.828 && lpNetPct(30, be + 0.01, w) < 4.828);
});

test("breakEvenEmissionsMultiple: scaling today's net emissions by m lands exactly on the borrow", () => {
  const w = priceHalfWidth(4500);
  const net = 10.81; // cbBTC/USDC sheltered net
  const m = breakEvenEmissionsMultiple(net, 4.828, 0.4, w)!;
  assert.ok(m > 1);
  assert.ok(Math.abs(lpNetPct(net * m, 0.4, w) - 4.828) < 1e-9);
  assert.equal(breakEvenEmissionsMultiple(0, 4.828, 0.4, w), null);
});

test("userNetPct: supply + LTV × (lpNet − borrow); zero LTV is pure supply", () => {
  assert.ok(Math.abs(userNetPct(1.843, 4000, -5.29, 4.828) - (1.843 + 0.4 * (-5.29 - 4.828))) < 1e-12);
  assert.equal(userNetPct(0.012, 0, 50, 4.828), 0.012);
});

test("SETTINGS map 1:1 onto the shared presets; widths and delays come from @zyo/shared, never typed here", () => {
  assert.deepEqual(SETTINGS.map((s) => s.id), ["sheltered", "steady", "working"]);
  assert.deepEqual(SETTINGS.map((s) => s.preset), ["CONSERVATIVE", "MODERATE", "AGGRESSIVE"]);
  for (const s of SETTINGS) {
    const def = RANGE_PRESETS.find((p) => p.preset === s.preset)!;
    assert.equal(s.rebalanceDelayHours, def.defaultRebalanceDelayHours);
    assert.equal(settingWidthBps(s, "UNCORRELATED"), def.rangeWidthBps.UNCORRELATED);
    assert.equal(settingWidthBps(s, "CORRELATED"), def.rangeWidthBps.CORRELATED);
  }
  assert.deepEqual(modelWidthsBps(), [4500, 2356, 1500, 784, 300, 150]);
});
