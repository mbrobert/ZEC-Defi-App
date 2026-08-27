/**
 * Cohort math: closed lifecycles → realized engine-net APR distributions.
 *
 * Methodology "closed-position-flows-v1" (documented in
 * docs/YIELD-SERVICE.md, surfaced via /v1/pools methodologyUrl):
 *
 *   • Cohort membership: positions whose CLOSE falls inside the trailing
 *     window. Open positions are excluded (no mark-to-market in v1) — this
 *     is stated in the payload, not hidden.
 *   • Per position: principalUsd = Σ USD(entry flows @ open day),
 *     outUsd = Σ USD(exit flows @ their event days),
 *     netApr = (outUsd − principalUsd)/principalUsd × 365/daysOpen.
 *   • Exclusions (counted, never silent): unpriceable flows; positions
 *     open < minDays (an hours-long position annualizes into noise);
 *     principal below $1 (dust).
 *   • Percentiles are PRINCIPAL-WEIGHTED (a $200k position moves the band
 *     more than a $50 one); the unweighted median ships alongside for
 *     transparency.
 */

import type { PriceBook } from "./prices.js";
import type {
  Address,
  CohortBand,
  Hex,
  PositionLifecycle,
  ValuedLifecycle,
} from "./types.js";

export function valueLifecycle(
  lc: PositionLifecycle,
  prices: PriceBook
): ValuedLifecycle | null {
  if (lc.closedAt === undefined || lc.openedAt === undefined) return null; // still open
  const daysOpen = (lc.closedAt - lc.openedAt) / 86_400;

  let principalUsd = 0;
  let outUsd = 0;
  let unpriced = false;

  for (const [token, amount] of Object.entries(lc.entryFlows)) {
    const v = prices.usdValue(token as Address, amount, lc.openedAt);
    if (v === null) unpriced = true;
    else principalUsd += v;
  }
  // Exit flows are valued at close (v1 simplification: harvests cluster
  // near close for short-lived positions; documented).
  for (const [token, amount] of Object.entries(lc.exitFlows)) {
    const v = prices.usdValue(token as Address, amount, lc.closedAt);
    if (v === null) unpriced = true;
    else outUsd += v;
  }

  const netAprFraction =
    principalUsd > 0 && daysOpen > 0
      ? ((outUsd - principalUsd) / principalUsd) * (365 / daysOpen)
      : 0;

  return {
    tokenId: lc.tokenId,
    poolId: lc.poolId,
    closedAt: lc.closedAt,
    daysOpen,
    principalUsd,
    outUsd,
    netAprFraction,
    unpriced,
  };
}

/** Weighted percentile over (value, weight) pairs; p in [0,100]. */
export function weightedPercentile(
  pairs: { value: number; weight: number }[],
  p: number
): number {
  if (!pairs.length) return NaN;
  const sorted = [...pairs].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((s, x) => s + x.weight, 0);
  if (total <= 0) return NaN;
  const target = (p / 100) * total;
  let acc = 0;
  for (const x of sorted) {
    acc += x.weight;
    if (acc >= target) return x.value;
  }
  return sorted[sorted.length - 1].value;
}

export function unweightedMedian(values: number[]): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface CohortOptions {
  windowDays: number;
  /** Unix seconds "now" — injected for determinism in tests. */
  nowSeconds: number;
  minDaysOpen: number;
  minPrincipalUsd?: number;
}

export function buildCohortBand(
  valued: (ValuedLifecycle | null)[],
  poolId: Hex,
  opts: CohortOptions
): CohortBand {
  const windowStart = opts.nowSeconds - opts.windowDays * 86_400;
  const minPrincipal = opts.minPrincipalUsd ?? 1;

  const inWindow = valued.filter(
    (v): v is ValuedLifecycle =>
      v !== null && v.poolId === poolId && v.closedAt >= windowStart && v.closedAt <= opts.nowSeconds
  );
  const eligible = inWindow.filter(
    (v) => !v.unpriced && v.daysOpen >= opts.minDaysOpen && v.principalUsd >= minPrincipal
  );
  const excluded = inWindow.length - eligible.length;

  const pairs = eligible.map((v) => ({
    value: v.netAprFraction * 100,
    weight: v.principalUsd,
  }));
  const pct = (p: number) => round2(weightedPercentile(pairs, p));

  return {
    windowDays: opts.windowDays,
    n: eligible.length,
    excluded,
    totalPrincipalUsd: round2(eligible.reduce((s, v) => s + v.principalUsd, 0)),
    meanDaysOpen: round2(
      eligible.length ? eligible.reduce((s, v) => s + v.daysOpen, 0) / eligible.length : 0
    ),
    p10: pct(10),
    p25: pct(25),
    p50: pct(50),
    p75: pct(75),
    p90: pct(90),
    medianUnweighted: round2(unweightedMedian(eligible.map((v) => v.netAprFraction * 100))),
  };
}

function round2(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : x;
}
