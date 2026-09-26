/**
 * Sizing a `protect(rung, topUpE6, reduceSz)` — the third chain's twin of `dispatch/policy.ts` and
 * `solana/policy.ts` (design §5, "policy"). Pure: no I/O, no clock.
 *
 * Given an OK valuation, the rung that fired, and the grant's remaining budgets, decide the ONE instruction
 * the keeper sends. The order is the design's, and the reason is §9 item 6 — a reduce UN-HEDGES the user,
 * a top-up does not — so at every rung the reserve goes first and size is closed only for what the reserve
 * cannot reach:
 *   • rung 1 (top-up)   — move reserve from the spot balance into the position until the rung's disarm
 *                         distance plus the plan margin is reached; the venue refuses a reduce here;
 *   • rung 2 (de-risk)  — the reserve first; then the smallest reduce-only buy that reaches the target,
 *                         capped at the de-risk fraction of the short (a third) and the grant's budget;
 *   • rung 3 (close)    — the whole short, under the grant's reduce budget (a budget of zero is Advanced's
 *                         "may not close" twin: then only the reserve can act), and the reserve beside it.
 * A grant budget that binds is NOT a refusal — the venue accepts an action that exhausts a budget — so the
 * plan clamps to it and says so. A reserve that binds is said too, by name, because only the owner can fund
 * it. Refused, by name: no live grant, a rung the grant excludes (both permanent — only the owner clears
 * them), a position already at or above the disarm level, and a plan with nothing left to do.
 *
 * The reduce is sized for the WORST fill the grant allows: an IOC buy may fill up to `maxSlippageBps`
 * above the mark, and that shortfall is realised out of the account value the distance is measured on.
 */
import { MAX_SHORT_DISTANCE_BPS, distanceBpsForHfBps, equivalentHfBps, reduceForDistance, shortDistanceBps, topUpE6ForDistance, unitNotionalE6, type ShortReads } from "@zyo/shared";
import type { PerpsValuation } from "./valuation.js";

export type OkPerpsValuation = Extract<PerpsValuation, { kind: "OK" }>;

export interface PerpRungTarget {
  /** As the venue numbers them: 1 top-up, 2 de-risk, 3 close. */
  index: number;
  /** The rung's disarm level on THIS account's ladder, bps of HF. */
  disarmHfBps: number;
}

export interface PerpGrantBounds {
  live: boolean;
  allowedRungs: number;
  topUpLeft: bigint;
  reduceLeft: bigint;
  /** False when the grant's per-period reduce budget is ZERO — the owner chose top-up-only, which is not an exhausted budget. */
  reduceAllowed: boolean;
  maxSlippageBps: number;
}

export interface PerpPlanInput {
  valuation: OkPerpsValuation;
  rung: PerpRungTarget;
  grant: PerpGrantBounds;
  /** The most of the short a de-risk may close, bps of the size. */
  deriskFractionBps: number;
  /** Margin above the disarm level to aim for, bps of HF (rounding safety). */
  marginBps: number;
}

export type PerpProtectPlan =
  | { kind: "protect"; rung: number; topUpE6: bigint; reduceSz: bigint; expectedDistanceBps: number; expectedHfBps: number; note?: string }
  | { kind: "refused"; reason: string; permanent: boolean };

const hfStr = (bps: number): string => (bps / 10_000).toFixed(4);
const e6 = (v: bigint): string => (Number(v) / 1e6).toFixed(2);

/** The realised loss (10^6) of buying back `reduceSz` at up to `slippageBps` above the mark. */
export function worstFillLossE6(reduceSz: bigint, markRaw: bigint, szDecimals: number, slippageBps: number): bigint {
  if (reduceSz <= 0n || slippageBps <= 0) return 0n;
  const num = reduceSz * unitNotionalE6(markRaw, szDecimals) * BigInt(slippageBps);
  return (num + 9_999n) / 10_000n;
}

/** The reduce that reaches `targetDistanceBps` after its own worst fill is charged to the account value; a short fixed-point. */
export function reduceForDistanceWithSlippage(reads: ShortReads, targetDistanceBps: number, slippageBps: number): bigint {
  let r = reduceForDistance(reads, targetDistanceBps);
  for (let k = 0; k < 3 && r > 0n; k++) {
    const loss = worstFillLossE6(r, reads.markRaw, reads.szDecimals, slippageBps);
    const r2 = reduceForDistance({ ...reads, accountValueE6: reads.accountValueE6 - loss }, targetDistanceBps);
    if (r2 <= r) break;
    r = r2;
  }
  return r;
}

export function planPerpProtect(i: PerpPlanInput): PerpProtectPlan {
  const v = i.valuation;
  const rung = i.rung.index;
  if (!i.grant.live) return { kind: "refused", permanent: true, reason: "no live grant for this keeper (the account's Permission on protect, or the venue's PerpGrant, is missing, expired, revoked or of an older epoch)" };
  if (!Number.isInteger(rung) || rung < 1 || rung > 3) return { kind: "refused", permanent: true, reason: `rung ${rung} is not one the venue acts on (1 top-up, 2 de-risk, 3 close)` };
  if ((i.grant.allowedRungs & (1 << rung)) === 0) return { kind: "refused", permanent: true, reason: `rung ${rung} not allowed by the grant` };
  if (v.hfBps >= i.rung.disarmHfBps) return { kind: "refused", permanent: false, reason: `HF ${hfStr(v.hfBps)} already at or above the disarm level ${hfStr(i.rung.disarmHfBps)}` };

  const targetHfBps = Math.ceil(i.rung.disarmHfBps * (1 + i.marginBps / 10_000));
  const targetD = Math.min(distanceBpsForHfBps(targetHfBps), MAX_SHORT_DISTANCE_BPS);
  const reads: ShortReads = { accountValueE6: v.accountValueE6, szi: v.szi, markRaw: v.markRaw, szDecimals: v.szDecimals, mmrBps: v.mmrBps };
  const need = topUpE6ForDistance(reads, targetD);
  const notes: string[] = [];

  // ---- the reserve first, at every rung
  let topUp = need < v.spotE6 ? need : v.spotE6;
  if (topUp > i.grant.topUpLeft) topUp = i.grant.topUpLeft;
  if (topUp < need) {
    if (v.spotE6 === 0n) notes.push(`the reserve on HyperCore is empty (${e6(need)} USDC needed) — only the owner can fund it`);
    else if (v.spotE6 < need) notes.push(`the reserve binds: ${e6(v.spotE6)} of ${e6(need)} USDC needed — only the owner can add to it`);
    if (i.grant.topUpLeft < (need < v.spotE6 ? need : v.spotE6)) notes.push(`top-up budget binds: ${e6(i.grant.topUpLeft)} of ${e6(need)} USDC (the venue accepts an exhausted budget)`);
  }
  const afterTopUp: ShortReads = { ...reads, accountValueE6: v.accountValueE6 + topUp };

  // ---- then size, only where the reserve does not reach
  let reduce = 0n;
  if (rung === 1) {
    if (topUp === 0n) {
      return { kind: "refused", permanent: false, reason: v.spotE6 === 0n ? "the top-up rung has nothing to move: the reserve on HyperCore is empty — the owner must fund it (the venue refuses a reduce at this rung)" : "top-up budget for this period is exhausted (the venue refuses a reduce at this rung)" };
    }
  } else if (rung === 2) {
    if (topUp < need) {
      if (!i.grant.reduceAllowed) notes.push("the grant allows no reduce — the owner chose top-up-only; only the reserve acts at this rung");
      else {
        reduce = reduceForDistanceWithSlippage(afterTopUp, targetD, i.grant.maxSlippageBps);
        const cap = (v.size * BigInt(i.deriskFractionBps)) / 10_000n;
        if (reduce > cap) {
          notes.push(`de-risk fraction binds: ${cap} of ${reduce} raw size (${(i.deriskFractionBps / 100).toFixed(2)} % of the short)`);
          reduce = cap;
        }
        if (reduce > i.grant.reduceLeft) {
          notes.push(`reduce budget binds: ${i.grant.reduceLeft} of ${reduce} raw size (the venue accepts an exhausted budget)`);
          reduce = i.grant.reduceLeft;
        }
      }
    }
    if (topUp === 0n && reduce === 0n) {
      return { kind: "refused", permanent: false, reason: !i.grant.reduceAllowed ? "the reserve cannot act and the grant allows no reduce — the owner chose top-up-only; only the owner can add USDC, reduce or close" : i.grant.reduceLeft === 0n ? "reduce budget for this period is exhausted and the reserve cannot act" : "nothing to do after the bounds" };
    }
  } else {
    // the emergency rung: the whole short, and the reserve beside it — if the close does not fill, the top-up still stood
    if (!i.grant.reduceAllowed) notes.push("the grant allows no reduce — the owner chose top-up-only; the emergency rung can only top up, and the venue liquidates at zero distance whatever the keeper may do");
    else {
      reduce = v.size;
      if (reduce > i.grant.reduceLeft) {
        notes.push(`reduce budget binds the close: ${i.grant.reduceLeft} of ${v.size} raw size (the venue accepts an exhausted budget)`);
        reduce = i.grant.reduceLeft;
      }
    }
    if (topUp === 0n && reduce === 0n) {
      return { kind: "refused", permanent: false, reason: !i.grant.reduceAllowed ? "the reserve is empty or its budget spent, and the grant allows no reduce — the owner chose top-up-only; only the owner can act" : "reduce budget for this period is exhausted and the reserve cannot act" };
    }
  }

  // ---- what the action should leave, at the worst fill the grant allows
  const sizeAfter = v.size - reduce;
  let expectedDistanceBps: number;
  if (sizeAfter <= 0n) expectedDistanceBps = MAX_SHORT_DISTANCE_BPS;
  else {
    const loss = worstFillLossE6(reduce, v.markRaw, v.szDecimals, i.grant.maxSlippageBps);
    expectedDistanceBps = shortDistanceBps({ ...afterTopUp, accountValueE6: afterTopUp.accountValueE6 - loss, szi: -sizeAfter });
  }
  return { kind: "protect", rung, topUpE6: topUp, reduceSz: reduce, expectedDistanceBps, expectedHfBps: equivalentHfBps(expectedDistanceBps), note: notes.length ? notes.join("; ") : undefined };
}
