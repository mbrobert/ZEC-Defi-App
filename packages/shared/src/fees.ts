/**
 * Fee model — the single source of truth. Consumed by contracts (as the
 * constructor/immutable values), keeper, yield service and web. Capped
 * on-chain by MAX_PERFORMANCE_BPS; never charged on principal.
 */

export const BPS_DENOMINATOR = 10_000;

export const FEES = {
  /** Share of REALISED yield (rewards / LP fees at claim or compound). Never on principal. */
  performanceBps: 1000,
  /** Immutable on-chain ceiling for performanceBps. */
  maxPerformanceBps: 2000,
  /** v1.1 MetaMorpho vault curator fee (share of vault interest). Unused in v1. */
  curatorBps: 1000,
  /** No orchestration / deposit / withdrawal / management fee in v1. */
  orchestrationBps: 0,
} as const;

if (FEES.performanceBps > FEES.maxPerformanceBps) {
  throw new Error("FEES.performanceBps exceeds maxPerformanceBps");
}

/**
 * Multiply a gross realised amount by (1 − performanceBps/10000).
 *
 * A performance fee is charged on PERFORMANCE. A loss is not performance:
 * `netOfPerformance(-100)` must be −100, not −90. Scaling a negative number
 * by 0.9 *shrinks* the loss and flatters every downside figure derived from
 * it (audit wave 1 lens D MED-2; a recurrence of the Part-4 `simple.html`
 * defect). Zero and losses pass through untouched — the fee is never
 * charged on principal, and never credited on a drawdown.
 */
export function netOfPerformance(gross: number): number {
  if (!(gross > 0)) return gross;
  return gross * (1 - FEES.performanceBps / BPS_DENOMINATOR);
}

/** The performance fee taken on a gross realised amount (0 on a loss). */
export function performanceFeeOn(gross: number): number {
  if (!(gross > 0)) return 0;
  return gross * (FEES.performanceBps / BPS_DENOMINATOR);
}

export interface FeeBreakdown {
  gross: number;
  performanceBps: number;
  performanceFee: number;
  net: number;
}

/** Itemised breakdown for a UI yield row. */
export function feeBreakdown(gross: number): FeeBreakdown {
  const performanceFee = performanceFeeOn(gross);
  return {
    gross,
    performanceBps: FEES.performanceBps,
    performanceFee,
    net: gross - performanceFee,
  };
}

/**
 * Integer (wei-style) variant matching the on-chain arithmetic:
 * fee = gross * bps / 10000, floor. A non-positive gross yields no fee —
 * the on-chain `_takeFee` path is only reached with a realised gain.
 */
export function performanceFeeAtomic(gross: bigint, bps: number = FEES.performanceBps): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > FEES.maxPerformanceBps) {
    throw new RangeError(`performance bps ${bps} outside [0, ${FEES.maxPerformanceBps}]`);
  }
  if (gross <= 0n) return 0n;
  return (gross * BigInt(bps)) / BigInt(BPS_DENOMINATOR);
}

/** Apply an APR-shaped number (e.g. 12.5 for 12.5%) net of the performance fee. */
export function netAprAfterFees(grossApr: number): number {
  return netOfPerformance(grossApr);
}
