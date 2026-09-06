/**
 * Band assembly: engine-net cohort bands → user-net APR bands.
 *
 * user_apr(pXX) = collateralSupplyApr + LTV × (engineNet_pXX × OILSKIN_KEEP − borrowApr)
 *
 * Fee semantics (IMPORTANT — differs from the model path):
 *   • Empirical engine-net flows are measured AFTER the engine's performance
 *     fee (it is skimmed before owner payouts), so only Oilskin's
 *     performance fee applies here: OILSKIN_KEEP = 1 − FEES.performanceBps/10000.
 *   • The MODEL path (src/model.ts keepFactor) starts from GROSS gauge
 *     emissions and applies the engine fee first, then Oilskin's — the two
 *     paths therefore state the same economics; tests pin this.
 *   • The keep factor applies to GAINS ONLY. A performance fee is charged on
 *     performance; multiplying a LOSS by 0.9 shrinks it and flatters the one
 *     number a first-time user most needs to be true. Every cohort percentile
 *     can be negative (`cohorts.ts` computes netAprFraction freely), and the
 *     MODEL path never does this — `gate.ts` applies keepFactor to gross
 *     EMISSIONS only and leaves the drag alone. Unconditional keep here made
 *     a −40 % cohort p10 read −20.40 % at LTV 0.5 instead of −22.40 %, and a
 *     −60 % cohort −29.40 % instead of −32.40 % (wave-1 lens D MED-2; a
 *     recurrence of the Part-4 `simple.html` defect).
 *
 * Supply and borrow are the LIVE Aave figures for the chosen collateral —
 * there is no fallback constant (audit Lens F: a hard-coded 0.8 % once
 * stood in for a measured 0.04 %).
 *
 * Monotonicity note: user_apr is increasing in engineNet, so applying the
 * affine map per-percentile preserves percentile order — banding commutes
 * with the fee/LTV transform.
 */

import { FEES } from "@zyo/shared";
import type { CohortBand } from "./types.js";

export const OILSKIN_KEEP = 1 - FEES.performanceBps / 10_000;

export interface UserBand {
  ltv: number;
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

/** The engine-net APR the user keeps: the fee is taken on gains, never on losses. */
export function keptEngineNetPct(engineNetPct: number): number {
  return engineNetPct > 0 ? engineNetPct * OILSKIN_KEEP : engineNetPct;
}

export function userNetPct(
  engineNetPct: number,
  ltv: number,
  borrowAprPct: number,
  supplyAprPct: number
): number {
  return round2(supplyAprPct + ltv * (keptEngineNetPct(engineNetPct) - borrowAprPct));
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
  supplyAprPct: number
): UserBand | null {
  const usable = bands.filter((b) => b.n > 0);
  if (!usable.length) return null;
  const mean = (pick: (b: CohortBand) => number) =>
    usable.reduce((s, b) => s + pick(b), 0) / usable.length;
  const u = (engineNetPct: number) => userNetPct(engineNetPct, ltv, borrowAprPct, supplyAprPct);
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
