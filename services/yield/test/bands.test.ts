import assert from "node:assert/strict";
import { test } from "node:test";
import { FEES } from "@zyo/shared";
import { keptEngineNetPct, mixUserBand, OILSKIN_KEEP, userNetPct } from "../src/bands.js";
import { ENGINE_FEE_BPS, keepFactor } from "../src/model.js";
import type { CohortBand } from "../src/types.js";

test("fee semantics: OILSKIN_KEEP derives from shared FEES and composes to the model path's keep factor", () => {
  assert.equal(OILSKIN_KEEP, 1 - FEES.performanceBps / 10_000);
  // empirical path: engine-net (already post-engine-fee) × OILSKIN_KEEP;
  // model path: gross × (1 − engine) × OILSKIN_KEEP — the same economics.
  assert.ok(Math.abs((1 - ENGINE_FEE_BPS / 10_000) * OILSKIN_KEEP - keepFactor("SNUGGLEFI")) < 1e-12);
  assert.ok(Math.abs(OILSKIN_KEEP - keepFactor("DIRECT")) < 1e-12);
});

test("userNetPct: affine map matches the product formula", () => {
  // supply 0.8 + 0.5 × (20 × 0.9 − 13.2) = 0.8 + 0.5 × 4.8 = 3.2
  assert.equal(userNetPct(20, 0.5, 13.2, 0.8), 3.2);
  // negative carry goes negative, honestly
  assert.ok(userNetPct(1, 0.5, 13.2, 0.8) < 0);
  // zero LTV → pure supply
  assert.equal(userNetPct(50, 0, 13.2, 0.8), 0.8);
});

function band(p: [number, number, number, number, number], n = 5): CohortBand {
  return {
    windowDays: 30, n, excluded: 0, totalPrincipalUsd: 1000, meanDaysOpen: 10,
    excludedReasons: { unpriced: 0, ambiguous_entry: 0, short_position: 0, dust_principal: 0, absurd_outcome: 0 },
    p10: p[0], p25: p[1], p50: p[2], p75: p[3], p90: p[4],
    medianUnweighted: p[2],
  };
}

test("mixUserBand: percentile order survives the affine transform", () => {
  const u = mixUserBand([band([-40, 5, 30, 60, 120])], 0.4, 13.2, 0.8)!;
  assert.ok(u.p10 <= u.p25 && u.p25 <= u.p50 && u.p50 <= u.p75 && u.p75 <= u.p90);
  // spot: p50 = 0.8 + 0.4 × (30×0.9 − 13.2) = 0.8 + 0.4 × 13.8 = 6.32
  assert.equal(u.p50, 6.32);
});

test("mixUserBand: equal-split mix averages percentile points before the transform", () => {
  const a = band([0, 10, 20, 30, 40]);
  const b = band([20, 30, 40, 50, 60]);
  const mix = mixUserBand([a, b], 0.3, 13.2, 0.8)!;
  const single = mixUserBand([band([10, 20, 30, 40, 50])], 0.3, 13.2, 0.8)!;
  assert.deepEqual(mix, single);
});

test("mixUserBand: pools without data are skipped; all-empty → null", () => {
  const empty = { ...band([1, 2, 3, 4, 5]), n: 0 };
  assert.equal(mixUserBand([empty], 0.3, 13.2, 0.8), null);
  const mixed = mixUserBand([empty, band([10, 20, 30, 40, 50])], 0.3, 13.2, 0.8)!;
  assert.equal(mixed.p50, userNetPct(30, 0.3, 13.2, 0.8));
});

test("FIX D-MED-2: the 10 % performance fee is applied to GAINS ONLY — a losing band is never flattered", () => {
  // Multiplying a loss by OILSKIN_KEEP shrinks it, and the bad-case number is
  // the one a first-time user most needs to be true. Fee-free on the downside:
  //   userNet = supply + ltv × (engineNet − borrow)   for engineNet ≤ 0
  const borrow = 4.828;
  const supply = 0.012;
  const cases: [number, number, number][] = [
    // engineNet, ltv, the fee-free answer
    [-40, 0.4, supply + 0.4 * (-40 - borrow)],
    [-40, 0.5, supply + 0.5 * (-40 - borrow)],
    [-60, 0.5, supply + 0.5 * (-60 - borrow)],
    [-0.01, 0.3, supply + 0.3 * (-0.01 - borrow)],
    [0, 0.5, supply + 0.5 * (0 - borrow)],
  ];
  for (const [engineNet, ltv, expected] of cases) {
    assert.equal(keptEngineNetPct(engineNet), engineNet, `keep must not touch ${engineNet}`);
    assert.equal(userNetPct(engineNet, ltv, borrow, supply), Math.round(expected * 100) / 100, `${engineNet} @ ${ltv}`);
  }
  // The audit's exact figures: −20.40 % was served where −22.40 % is true.
  assert.equal(userNetPct(-40, 0.5, borrow, supply), Math.round((supply + 0.5 * (-40 - borrow)) * 100) / 100);
  assert.ok(userNetPct(-40, 0.5, borrow, supply) < -22, "the loss must not shrink");
  // Gains are unchanged: the fee IS charged on performance.
  assert.equal(keptEngineNetPct(30), 30 * OILSKIN_KEEP);
  assert.equal(userNetPct(30, 0.4, borrow, supply), Math.round((supply + 0.4 * (30 * OILSKIN_KEEP - borrow)) * 100) / 100);
});

test("FIX D-MED-2: a mixed band's DOWNSIDE percentiles are fee-free while its upside is not", () => {
  const band = (p: Partial<CohortBand>): CohortBand => ({
    windowDays: 30, n: 12, excluded: 0, totalPrincipalUsd: 1, meanDaysOpen: 9,
    excludedReasons: { unpriced: 0, ambiguous_entry: 0, short_position: 0, dust_principal: 0, absurd_outcome: 0 },
    p10: -40, p25: 5, p50: 30, p75: 60, p90: 120, medianUnweighted: 30, ...p,
  });
  const u = mixUserBand([band({})], 0.5, 4.828, 0.012)!;
  assert.equal(u.p10, Math.round((0.012 + 0.5 * (-40 - 4.828)) * 100) / 100); // fee-free
  assert.equal(u.p90, Math.round((0.012 + 0.5 * (120 * OILSKIN_KEEP - 4.828)) * 100) / 100); // fee charged
  // percentile order still survives the transform
  assert.ok(u.p10 < u.p25 && u.p25 < u.p50 && u.p50 < u.p75 && u.p75 < u.p90);
});
