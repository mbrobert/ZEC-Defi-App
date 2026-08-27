/**
 * Band assembly: engine-net cohort bands → user-net APY bands.
 *
 * user_apy(pXX) = SUPPLY_APY + LTV × (engineNet_pXX × OILSKIN_KEEP − BORROW_APR)
 *
 * Fee semantics (IMPORTANT — differs from the demo's gross-path constant):
 *   • Empirical engine-net flows are measured AFTER the engine's 15%
 *     performance fee (it is skimmed before owner payouts), so only
 *     Oilskin's 10% applies here: OILSKIN_KEEP = 1 − PLATFORM_FEE
 *     .performanceBps/10000 = 0.90.
 *   • The demo's static path multiplies GROSS fee APR by 0.765
 *     (= 0.90 × 0.85) because a gross sample nets NEITHER fee yet.
 *   Both paths therefore state the same economics; tests pin this.
 *
 * Monotonicity note: user_apy is increasing in engineNet, so applying the
 * affine map per-percentile preserves percentile order — banding commutes
 * with the fee/LTV transform.
 */

import { PLATFORM_FEE } from "@zyo/shared";
import type { CohortBand } from "./types.js";

/** ZEC supply APY on Rhea, percent (same base the demo uses). */
export const SUPPLY_APY_PCT = 0.8;

export const OILSKIN_KEEP = 1 - PLATFORM_FEE.performanceBps / 10_000; // 0.90

export interface UserBand {
  ltv: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export function userNetPct(
  engineNetPct: number,
  ltv: number,
  borrowAprPct: number,
  supplyApyPct = SUPPLY_APY_PCT
): number {
  return round2(supplyApyPct + ltv * (engineNetPct * OILSKIN_KEEP - borrowAprPct));
}

/**
 * Map one pool's engine-net band to a user-net band at an LTV. When several
 * pools are mixed equal-split (the app's allocation rule), percentile
 * points are averaged across pools BEFORE the transform — an approximation
 * (true mix percentiles need joint distributions) and labeled as such in
 * the API payload ("mixAveraging": "percentile-mean-v1").
 */
export function mixUserBand(
  bands: CohortBand[],
  ltv: number,
  borrowAprPct: number,
  supplyApyPct = SUPPLY_APY_PCT
): UserBand | null {
  const usable = bands.filter((b) => b.n > 0);
  if (!usable.length) return null;
  const mean = (pick: (b: CohortBand) => number) =>
    usable.reduce((s, b) => s + pick(b), 0) / usable.length;
  const u = (engineNetPct: number) => userNetPct(engineNetPct, ltv, borrowAprPct, supplyApyPct);
  return {
    ltv,
    p10: u(mean((b) => b.p10)),
    p25: u(mean((b) => b.p25)),
    p50: u(mean((b) => b.p50)),
    p75: u(mean((b) => b.p75)),
    p90: u(mean((b) => b.p90)),
  };
}

function round2(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : x;
}
