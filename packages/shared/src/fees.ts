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

/** Multiply a gross realised amount by (1 − performanceBps/10000). */
export function netOfPerformance(gross: number): number {
  return gross * (1 - FEES.performanceBps / BPS_DENOMINATOR);
}

/** The performance fee taken on a gross realised amount. */
export function performanceFeeOn(gross: number): number {
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

/** Integer (wei-style) variant matching the on-chain arithmetic: fee = gross * bps / 10000, floor. */
export function performanceFeeAtomic(gross: bigint, bps: number = FEES.performanceBps): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > FEES.maxPerformanceBps) {
    throw new RangeError(`performance bps ${bps} outside [0, ${FEES.maxPerformanceBps}]`);
  }
  return (gross * BigInt(bps)) / BigInt(BPS_DENOMINATOR);
}

/** Apply an APR-shaped number (e.g. 12.5 for 12.5%) net of the performance fee. */
export function netAprAfterFees(grossApr: number): number {
  return netOfPerformance(grossApr);
}
