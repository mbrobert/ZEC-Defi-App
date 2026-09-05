/**
 * Reward-claim economics — when the keeper (or the UI's "claim" nudge) should
 * realise rewards. Everything lands in the user's own wallet on Base; the
 * only cost is gas.
 */
export const REWARD_CLAIM_POLICY = {
  /** accruedUsd must exceed gasUsd × multiple. */
  minCostMultiple: 3,
  /** …and always exceed this floor, regardless of gas. */
  minAbsoluteUsd: 5,
  /** Never wait longer than this once anything has accrued. */
  maxHoldDays: 30,
} as const;

export interface ClaimDecision {
  claim: boolean;
  reason: "below-floor" | "gas-too-high" | "max-hold-reached" | "worth-it";
}

/**
 * Pure decision. `accruedUsd` is the GROSS accrued value; the performance
 * fee is taken at claim and does not change the decision.
 */
export function shouldClaim(accruedUsd: number, gasUsd: number, daysSinceFirstAccrual: number): ClaimDecision {
  if (![accruedUsd, gasUsd, daysSinceFirstAccrual].every((x) => typeof x === "number" && Number.isFinite(x))) {
    return { claim: false, reason: "below-floor" }; // fail closed on unreadable inputs
  }
  if (accruedUsd <= 0) return { claim: false, reason: "below-floor" };
  if (daysSinceFirstAccrual >= REWARD_CLAIM_POLICY.maxHoldDays && accruedUsd > gasUsd) {
    return { claim: true, reason: "max-hold-reached" };
  }
  if (accruedUsd < REWARD_CLAIM_POLICY.minAbsoluteUsd) return { claim: false, reason: "below-floor" };
  if (accruedUsd < gasUsd * REWARD_CLAIM_POLICY.minCostMultiple) return { claim: false, reason: "gas-too-high" };
  return { claim: true, reason: "worth-it" };
}
