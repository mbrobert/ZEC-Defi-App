/**
 * Sizing a `keeper_protect` — the twin of `dispatch/policy.ts`. Pure: no I/O, no clock.
 *
 * Given an OK valuation, the rung that fired, the grant's remaining budgets and the keeper's own USDC, decide
 * the one instruction the keeper sends:
 *   • repay-only  — the Account's idle USDC covers what lifts HF to the rung's disarm level (plus a safety
 *                   margin so rounding cannot land a hair under it, which the program refuses as ineffective);
 *   • sale        — it does not: the keeper pays the remainder in (its own USDC), the program repays it and
 *                   releases the ZEC that payment covers at the Scope price less `saleDiscountBps`
 *                   (0 = the keeper pays fair value; the grant's allowance is headroom, never profit by
 *                   default), sized so that afterwards HF ≥ disarm AND Kamino's LTV cap lets the withdraw
 *                   happen at all (`SOLANA-ARCHITECTURE.md` §3);
 *   • refused     — a bound the keeper cannot move binds (no live grant, the rung not allowed, keeper capital
 *                   short of what a sale needs). A grant budget that binds is NOT a refusal: the program
 *                   accepts an action that exhausts a budget, so the plan clamps to it and says so.
 */
import type { SolanaValuation } from "./valuation.js";

export interface RungTarget {
  id: number;
  /** disarm level, e.g. 1.40 for repay */
  disarmHf: number;
}

export interface GrantBounds {
  live: boolean;
  allowedRungs: number;
  repayLeft: bigint;
  sellLeft: bigint;
  maxSellSlippageBps: number;
}

export interface PlanInput {
  valuation: Extract<SolanaValuation, { kind: "OK" }>;
  rung: RungTarget;
  grant: GrantBounds;
  /** USDC (base units) the keeper is willing and able to pay in for a sale. */
  keeperUsdc: bigint;
  /** Discount off the Scope price the keeper pays on a sale, bps; must be ≤ the grant's allowance. */
  saleDiscountBps: number;
  /** Fraction of margin above the disarm level to aim for, bps (rounding safety). */
  marginBps: number;
}

export type ProtectPlan =
  | { kind: "repay-only"; rungId: number; repayUsdc: bigint; keeperUsdcIn: 0n; sellZec: 0n; expectedHf: number; note?: string }
  | { kind: "sale"; rungId: number; repayUsdc: bigint; keeperUsdcIn: bigint; sellZec: bigint; expectedHf: number; note?: string }
  | { kind: "refused"; reason: string; permanent: boolean };

const ZEC_UNIT = 1e8;
const USDC_UNIT = 1e6;

function hfAfter(collateralZec: number, priceUsd: number, ltBps: number, debtUsdc: number): number {
  return debtUsdc <= 0 ? Number.POSITIVE_INFINITY : (collateralZec * priceUsd * ltBps) / 10_000 / debtUsdc;
}

export function planProtect(i: PlanInput): ProtectPlan {
  const v = i.valuation;
  if (!i.grant.live) return { kind: "refused", reason: "no live grant for this keeper", permanent: true };
  if ((i.grant.allowedRungs & (1 << i.rung.id)) === 0) return { kind: "refused", reason: `rung ${i.rung.id} not allowed by the grant`, permanent: true };
  if (i.saleDiscountBps > i.grant.maxSellSlippageBps) return { kind: "refused", reason: `keeper sale discount ${i.saleDiscountBps} bps exceeds the grant's allowance ${i.grant.maxSellSlippageBps} bps`, permanent: true };
  if (!(v.hf < i.rung.disarmHf)) return { kind: "refused", reason: `HF ${v.hf} already at or above the disarm level ${i.rung.disarmHf}`, permanent: false };

  const C = Number(v.collateralZec) / ZEC_UNIT;
  const D = Number(v.debtUsdc) / USDC_UNIT;
  const P = v.zecUsd;
  const LT = v.liquidationThresholdBps;
  const T = i.rung.disarmHf * (1 + i.marginBps / 10_000);
  // Repay needed with no collateral change: (D − R) × T ≤ C × P × LT
  const needUsd = Math.max(0, D - (C * P * (LT / 10_000)) / T);
  const idle = Number(v.idleUsdc) / USDC_UNIT;
  const repayLeft = Number(i.grant.repayLeft) / USDC_UNIT;
  if (repayLeft <= 0) return { kind: "refused", reason: "repay budget for this period is exhausted", permanent: false };

  // ---- repay-only from the Account's idle USDC
  if (idle >= needUsd) {
    const repay = Math.min(needUsd, repayLeft);
    const repayUsdc = BigInt(Math.ceil(repay * USDC_UNIT));
    const note = repay < needUsd ? `repay budget binds: ${repay.toFixed(2)} of ${needUsd.toFixed(2)} USDC needed (the program accepts an exhausted budget)` : undefined;
    return { kind: "repay-only", rungId: i.rung.id, repayUsdc, keeperUsdcIn: 0n, sellZec: 0n, expectedHf: hfAfter(C, P, LT, D - repay), note };
  }

  // ---- sale: idle first, then the keeper pays X for Y ZEC at P × (1 − d)
  const r1 = Math.min(idle, repayLeft);
  const Dp = D - r1;
  const d = i.saleDiscountBps / 10_000;
  const ltvCap = v.ltvCapBps / 10_000;
  // HF target after the sale:   (C − Y) P LT ≥ T (Dp − Y P (1 − d))  → Y ≥ (T Dp − C P LT) / (P (T (1 − d) − LT))
  const yHf = (T * Dp - C * P * (LT / 10_000)) / (P * (T * (1 - d) - LT / 10_000));
  // Kamino must allow the withdraw: (Dp − Y P (1 − d)) ≤ (C − Y) P ltvCap → Y ≥ (Dp − C P ltvCap) / (P ((1 − d) − ltvCap))
  const yLtv = (Dp - C * P * ltvCap) / (P * (1 - d - ltvCap));
  let Y = Math.max(yHf, yLtv, 0) * (1 + i.marginBps / 10_000);
  if (!(Y > 0)) Y = 0;
  const sellLeft = Number(i.grant.sellLeft) / ZEC_UNIT;
  const keeperCash = Number(i.keeperUsdc) / USDC_UNIT;
  let note: string | undefined;
  if (Y > C) return { kind: "refused", reason: `a sale of ${Y.toFixed(4)} ZEC exceeds the ${C.toFixed(4)} ZEC of collateral — the position cannot reach the disarm level`, permanent: false };
  if (sellLeft <= 0) return { kind: "refused", reason: "sell budget for this period is exhausted and idle USDC cannot reach the disarm level", permanent: false };
  if (Y > sellLeft) {
    note = `sell budget binds: ${sellLeft.toFixed(4)} of ${Y.toFixed(4)} ZEC (the program accepts an exhausted budget)`;
    Y = sellLeft;
  }
  let X = Y * P * (1 - d);
  const repayRoom = repayLeft - r1;
  if (X > repayRoom) {
    note = `${note ? note + "; " : ""}repay budget binds the sale: ${repayRoom.toFixed(2)} of ${X.toFixed(2)} USDC`;
    X = Math.max(0, repayRoom);
    Y = X / (P * (1 - d));
  }
  if (X > keeperCash) return { kind: "refused", reason: `keeper capital short: the sale needs ${X.toFixed(2)} USDC, the keeper has ${keeperCash.toFixed(2)}`, permanent: false };
  if (!(Y > 0) || !(X > 0)) return { kind: "refused", reason: "nothing to sell after the bounds", permanent: false };
  const sellZec = BigInt(Math.floor(Y * ZEC_UNIT));
  const keeperUsdcIn = BigInt(Math.ceil(X * USDC_UNIT));
  const repayUsdc = BigInt(Math.ceil(r1 * USDC_UNIT)) + keeperUsdcIn;
  return { kind: "sale", rungId: i.rung.id, repayUsdc, keeperUsdcIn, sellZec, expectedHf: hfAfter(C - Y, P, LT, Dp - X), note };
}
