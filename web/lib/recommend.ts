/**
 * Simple mode's recommendation, from the served FORECAST — never a curated pick, and since
 * 2026-09-12 (BUILD-PLAN-2026-09-12 D5) never a refusal: every curated pool is open to a Simple-mode
 * user after the acknowledgment. Rule: among the cells the forecast could price for this collateral,
 * the highest user net at the chosen LTV; ties → the wider (calmer) band. When the best forecast is a
 * loss the recommendation SAYS so and still names the cell — the user decides. When nothing can be
 * priced at all, recommend holding the USDC and say why.
 */
import type { CollateralSymbol } from "@zyo/shared";
import { cellsFor, unpricedPlain, userNetAtLtv, type ForecastCell, type ForecastView } from "./forecast";

export type Recommendation =
  | { kind: "lp"; cell: ForecastCell; userNetPct: number; why: string; positive: boolean }
  | { kind: "hold"; why: string; closest: ForecastCell | null; closestWhy: string };

export function recommend(forecast: ForecastView, collateral: CollateralSymbol, ltvBps: number): Recommendation {
  const cells = cellsFor(forecast, collateral, ltvBps);
  const scored = cells
    .filter((c) => c.allowed && c.lpPriced)
    .map((c) => ({ c, un: userNetAtLtv(c, ltvBps) }))
    .filter((x): x is { c: ForecastCell; un: number } => typeof x.un === "number" && Number.isFinite(x.un));
  const borrow = typeof forecast.borrowAprPct === "number" ? `${forecast.borrowAprPct.toFixed(2)}%` : "today's";
  if (scored.length === 0) {
    const closest = cells[0] ?? null;
    return {
      kind: "hold",
      closest,
      closestWhy: closest ? unpricedPlain(closest.lpUnpricedReason) : "",
      why: forecast.unavailableReason
        ? "The yield service could not be reached and no forecast could be shown, so the only thing this page can recommend is to keep the borrowed USDC in your account."
        : forecast.stale
          ? "Our reading of today's numbers is too old to trust, so no pool can be forecast until it refreshes — keeping the borrowed USDC in your account is the only thing this page can recommend."
          : `The model could not price any pool for ${collateral} today, so there is no forecast to choose from — keeping the borrowed USDC in your account is the only thing this page can recommend.`,
    };
  }
  scored.sort((a, b) => b.un - a.un || b.c.rangeWidthBps - a.c.rangeWidthBps);
  const best = scored[0];
  const pair = `${best.c.pool.token0}/${best.c.pool.token1}`;
  const positive = best.un > 0;
  return {
    kind: "lp",
    cell: best.c,
    userNetPct: best.un,
    positive,
    why: positive
      ? `${pair} (${best.c.preset.toLowerCase()}) has the highest forecast net return on your ${collateral} at ${ltvBps / 100}% LTV — priced with both of the models we use, not just the friendlier one.`
      : `${pair} (${best.c.preset.toLowerCase()}) is the least bad forecast for your ${collateral} at ${ltvBps / 100}% LTV, and it is still a loss: at the ${borrow} borrow rate the model expects this position to cost you money. You can open it after reading the forecast; keeping the borrowed USDC in your account, or not borrowing, are the other choices.`,
  };
}
