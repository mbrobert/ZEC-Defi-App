import assert from "node:assert/strict";
import { test } from "node:test";
import { mixUserBand, OILSKIN_KEEP, userNetPct } from "../src/bands.js";
import type { CohortBand } from "../src/types.js";

test("fee semantics: OILSKIN_KEEP is 0.90 and composes to the demo's 0.765 gross factor", () => {
  assert.equal(OILSKIN_KEEP, 0.9);
  // demo static path: gross × 0.765; empirical path: (gross × 0.85 engine-net) × 0.90
  assert.ok(Math.abs(0.85 * OILSKIN_KEEP - 0.765) < 1e-12);
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
  assert.equal(mixUserBand([empty], 0.3, 13.2), null);
  const mixed = mixUserBand([empty, band([10, 20, 30, 40, 50])], 0.3, 13.2, 0.8)!;
  assert.equal(mixed.p50, userNetPct(30, 0.3, 13.2, 0.8));
});
