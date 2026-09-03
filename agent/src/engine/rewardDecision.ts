/**
 * Pure decision logic: should we claim rewards now?
 *
 * Claim when the accrued value clears execution costs by a safety multiple,
 * with an absolute floor, and a max-hold override so small rewards do not sit
 * forever once they at least cover costs. The absolute floor is a HARD floor:
 * it holds even past max-hold (it is load-bearing for auto-shielding — see
 * @zyo/shared REWARD_CLAIM_POLICY.minAbsoluteUsd).
 *
 * Inputs are VALIDATED, not trusted: a NaN gas estimate or a negative cost
 * is suspect data from an upstream failure. We THROW on it — loudly, so the
 * caller alerts — rather than silently WAITing forever or claiming on
 * garbage numbers.
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

export class RewardInputError extends Error {
  constructor(field: string, value: number) {
    super(
      `decideReward: ${field} is ${value} — inputs must be finite and ≥ 0. ` +
        `Refusing to decide on suspect data (a failed gas/price estimate must alert, ` +
        `not silently WAIT or CLAIM).`
    );
    this.name = "RewardInputError";
  }
}

function requireFiniteNonNegative(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) throw new RewardInputError(field, value);
}

export function decideReward(input: RewardDecisionInput): RewardDecision {
  requireFiniteNonNegative("accruedUsd", input.accruedUsd);
  requireFiniteNonNegative("gasUsd", input.gasUsd);
  requireFiniteNonNegative("bridgeFeeUsd", input.bridgeFeeUsd);
  requireFiniteNonNegative("minCostMultiple", input.minCostMultiple);
  requireFiniteNonNegative("minAbsoluteUsd", input.minAbsoluteUsd);
  if (input.accrualAgeDays !== undefined) {
    requireFiniteNonNegative("accrualAgeDays", input.accrualAgeDays);
  }
  if (input.maxHoldDays !== undefined && input.maxHoldDays !== Infinity) {
    requireFiniteNonNegative("maxHoldDays", input.maxHoldDays);
  }

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

  // Max-hold relaxes ONLY the cost multiple — the absolute floor stays hard
  // (a $1.20 claim past max-hold is still below the auto-shield economics).
  const age = input.accrualAgeDays ?? 0;
  const maxHold = input.maxHoldDays ?? Infinity;
  if (age >= maxHold && net > 0 && clearsFloor) {
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

// ---------------------------------------------------------------------------
// Accrued-value attribution.
//
// The on-chain RewardRouter can only claim/route the POSITION's entry token
// (claimTo reverts NothingClaimed when the matching-token amount is 0), so a
// decision must never be funded by reward tokens the router cannot move
// (e.g. AERO on a staked Aerodrome pool). Value in other tokens is real but
// UNROUTABLE — surface it separately so operators see it, and never let it
// trigger a claim that would revert every tick.
// ---------------------------------------------------------------------------

export interface AccruedBreakdown {
  /** Atomic amount of the position's own token among pending rewards. */
  accruedAtomic: bigint;
  /** USD value of the position-token rewards only (what a claim can move). */
  accruedUsd: number;
  /** USD value of pending rewards in OTHER tokens (visible, not claimable). */
  unmatchedUsd: number;
}

export function accruedForPosition(
  positionToken: string,
  pending: { tokens: string[]; amounts: bigint[] },
  usdValue: (token: string, amountAtomic: bigint) => number
): AccruedBreakdown {
  const want = positionToken.toLowerCase();
  let accruedAtomic = 0n;
  let accruedUsd = 0;
  let unmatchedUsd = 0;
  for (let i = 0; i < pending.tokens.length; i++) {
    const token = pending.tokens[i];
    const amount = pending.amounts[i];
    if (token === undefined || amount === undefined) continue;
    const usd = usdValue(token, amount);
    requireFiniteNonNegative(`usdValue(${token})`, usd);
    if (token.toLowerCase() === want) {
      accruedAtomic += amount;
      accruedUsd += usd;
    } else {
      unmatchedUsd += usd;
    }
  }
  return { accruedAtomic, accruedUsd, unmatchedUsd };
}
