/**
 * Simple mode's ONE recommended strategy, from the served gate verdicts —
 * never a curated pick. Rule: among verdicts that CLEAR the gate for this
 * collateral, the highest model userNet at the chosen LTV; ties → the wider
 * (calmer) band. If nothing clears, recommend holding the USDC and say why.
 */
import type { CollateralSymbol } from "@zyo/shared";
import { offeredEntries, type GateEntry, type GateView } from "./gate";

export type Recommendation =
  | { kind: "lp"; entry: GateEntry; userNetPct: number; why: string }
  | { kind: "hold"; why: string };

export function recommend(gate: GateView, collateral: CollateralSymbol, ltvBps: number): Recommendation {
  const offered = offeredEntries(gate, collateral);
  const scored = offered
    .map((e) => ({ e, un: e.userNet.find((u) => u.ltvBps === ltvBps && u.offerable)?.userNetPct }))
    .filter((x): x is { e: GateEntry; un: number } => typeof x.un === "number" && Number.isFinite(x.un));
  if (scored.length === 0) {
    const borrow = Number.isFinite(gate.borrowAprPct) ? `${gate.borrowAprPct.toFixed(2)}%` : "today's";
    return {
      kind: "hold",
      why: gate.unavailableReason
        ? "The yield service could not produce a verdict, so no pool can be recommended right now."
        : `At the ${borrow} USDC borrow rate no Aerodrome pool clears the yield gate once impermanent loss is priced in, so the honest recommendation is to keep the borrowed USDC in your account (or not to borrow at all).`,
    };
  }
  scored.sort((a, b) => b.un - a.un || b.e.rangeWidthBps - a.e.rangeWidthBps);
  const best = scored[0];
  return {
    kind: "lp",
    entry: best.e,
    userNetPct: best.un,
    why: `${best.e.pool.token0}/${best.e.pool.token1} (${best.e.preset.toLowerCase()}) has the highest model net return on your ${collateral} at ${ltvBps / 100}% LTV among the pools that clear the gate today.`,
  };
}
