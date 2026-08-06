/**
 * Pure decision logic: should we claim rewards now?
 *
 * Claim when the accrued value clears execution costs by a safety multiple,
 * with an absolute floor, and a max-hold override so small rewards do not sit
 * forever once they at least cover costs.
 */

export interface RewardDecisionInput {
  /** USD value of claimable rewards. */
  accruedUsd: number;
  /** USD cost of the claim/compound gas on Base. */
  gasUsd: number;
  /** USD cost of the intents bridge leg (0 when compounding). */
  bridgeFeeUsd: number;
  /** accrued must exceed (gas + bridge) × this multiple. */
  minCostMultiple: number;
  /** …and this absolute floor. */
  minAbsoluteUsd: number;
  /** Days since rewards first started accruing unclaimed. */
  accrualAgeDays?: number;
  /** Once older than this, claim as soon as costs are merely covered. */
  maxHoldDays?: number;
}

export type RewardAction = "CLAIM" | "WAIT";

export interface RewardDecision {
  action: RewardAction;
  reason: string;
  /** Net USD the user keeps if claiming now. */
  netUsd: number;
}

export function decideReward(input: RewardDecisionInput): RewardDecision {
  const costs = input.gasUsd + input.bridgeFeeUsd;
  const net = input.accruedUsd - costs;

  if (input.accruedUsd <= 0) {
    return { action: "WAIT", reason: "nothing accrued", netUsd: 0 };
  }

  const clearsMultiple = input.accruedUsd >= costs * input.minCostMultiple;
  const clearsFloor = input.accruedUsd >= input.minAbsoluteUsd;

  if (clearsMultiple && clearsFloor) {
    return {
      action: "CLAIM",
      reason: `accrued $${input.accruedUsd.toFixed(2)} ≥ ${input.minCostMultiple}× costs ($${costs.toFixed(2)}) and floor`,
      netUsd: net,
    };
  }

  const age = input.accrualAgeDays ?? 0;
  const maxHold = input.maxHoldDays ?? Infinity;
  if (age >= maxHold && net > 0) {
    return {
      action: "CLAIM",
      reason: `max hold ${maxHold}d reached with positive net ($${net.toFixed(2)})`,
      netUsd: net,
    };
  }

  const why = !clearsFloor
    ? `accrued $${input.accruedUsd.toFixed(2)} below floor $${input.minAbsoluteUsd}`
    : `accrued $${input.accruedUsd.toFixed(2)} < ${input.minCostMultiple}× costs ($${(costs * input.minCostMultiple).toFixed(2)})`;
  return { action: "WAIT", reason: why, netUsd: net };
}
