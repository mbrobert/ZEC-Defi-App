/**
 * Cohort math: closed lifecycles → realized engine-net APR distributions.
 *
 * Methodology "closed-position-flows-v2" (documented in
 * docs/YIELD-SERVICE.md, surfaced via /v1/pools methodologyUrl):
 *
 *   • Cohort membership: positions whose CLOSE falls inside the trailing
 *     window. Open positions are excluded (no mark-to-market in v1) — this
 *     is stated in the payload, not hidden.
 *   • Per position: principalUsd = Σ USD(entry inflows @ open day)
 *                                 − Σ USD(attributed refunds @ open day),
 *     outUsd = Σ USD(exit flows @ close day),
 *     netApr = (outUsd − principalUsd)/principalUsd × 365/daysOpen.
 *   • Exclusions (counted PER REASON, never silent): unpriceable flows;
 *     ambiguous entry (multi-position deposit tx); positions open < minDays
 *     (an hours-long position annualizes into noise); principal below $1
 *     (dust); and an ABSOLUTE OUTCOME BOUND — |netApr| > MAX_ABS_NET_APR
 *     (2000 %/yr) is not a return anyone realized, it is an attribution
 *     defect, so it can never enter a band (audit round 3).
 *   • Percentiles are PRINCIPAL-WEIGHTED (a $200k position moves the band
 *     more than a $50 one); the unweighted median ships alongside for
 *     transparency.
 */

import type { PriceBook } from "./prices.js";
import type {
  Address,
  CohortBand,
  ExclusionReason,
  Hex,
  PositionLifecycle,
  ValuedLifecycle,
} from "./types.js";

/** |netApr| (fraction) beyond which a lifecycle is an attribution defect, not data. */
export const MAX_ABS_NET_APR = 20;

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
  for (const [token, amount] of Object.entries(lc.entryRefunds ?? {})) {
    const v = prices.usdValue(token as Address, amount, lc.openedAt);
    if (v === null) unpriced = true;
    else principalUsd -= v;
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
    ambiguousEntry: lc.ambiguousEntry ?? false,
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

/** The single reason a valued lifecycle is excluded, or null when eligible. */
export function exclusionReason(v: ValuedLifecycle, opts: CohortOptions): ExclusionReason | null {
  const minPrincipal = opts.minPrincipalUsd ?? 1;
  if (v.ambiguousEntry) return "ambiguous_entry";
  if (v.unpriced) return "unpriced";
  if (v.daysOpen < opts.minDaysOpen) return "short_position";
  if (!(v.principalUsd >= minPrincipal)) return "dust_principal";
  if (!Number.isFinite(v.netAprFraction) || Math.abs(v.netAprFraction) > MAX_ABS_NET_APR) return "absurd_outcome";
  return null;
}

export function buildCohortBand(
  valued: (ValuedLifecycle | null)[],
  poolId: Hex,
  opts: CohortOptions
): CohortBand {
  const windowStart = opts.nowSeconds - opts.windowDays * 86_400;

  const inWindow = valued.filter(
    (v): v is ValuedLifecycle =>
      v !== null && v.poolId === poolId && v.closedAt >= windowStart && v.closedAt <= opts.nowSeconds
  );
  const excludedReasons: Record<ExclusionReason, number> = {
    unpriced: 0,
    ambiguous_entry: 0,
    short_position: 0,
    dust_principal: 0,
    absurd_outcome: 0,
  };
  const eligible: ValuedLifecycle[] = [];
  for (const v of inWindow) {
    const r = exclusionReason(v, opts);
    if (r) excludedReasons[r]++;
    else eligible.push(v);
  }
  const excluded = inWindow.length - eligible.length;

  const pairs = eligible.map((v) => ({
    value: v.netAprFraction * 100,
    weight: v.principalUsd,
  }));
  const pct = (p: number) => round2(weightedPercentile(pairs, p));

  const band: CohortBand = {
    windowDays: opts.windowDays,
    n: eligible.length,
    excluded,
    excludedReasons,
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
  // By construction after the exclusion above; asserted so a future change
  // to the exclusion can never silently reopen the absurd-band path.
  for (const k of ["p10", "p25", "p50", "p75", "p90", "medianUnweighted"] as const) {
    const x = band[k];
    if (Number.isFinite(x) && Math.abs(x) > MAX_ABS_NET_APR * 100) {
      throw new Error(`cohort band ${poolId} ${k}=${x} exceeds the absolute bound`);
    }
  }
  return band;
}

function round2(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : x;
}
