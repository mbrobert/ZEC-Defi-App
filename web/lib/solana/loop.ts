/**
 * The cross-chain loop's DEPLOY decision inside the Solana wizard (BUILD-PLAN D6; SOLANA-ARCHITECTURE.md §14):
 * once USDC is borrowed on Kamino it may stay idle in the Account, or cross to the user's own Base account by
 * Circle's CCTP and work in an Aerodrome pool. This module is the forecast of that second choice — the service's
 * `/v1/forecast?crossChain=1` cells, priced by Kamino's borrow side — and the arithmetic around it: the reserve
 * that stays on Solana (the rung-2 requirement, `reserveFractionFor`), the amount that crosses, the user's net
 * at THIS position's LTV, the acknowledgment, and the crossing's own steps, which this build lists and does not
 * sign (the address lookup table and the two-key keeper process are deploy artefacts; ROADMAP §1 item 3).
 *
 * The forecast is a forecast, not a gate (D4/D5): every priced pool may be chosen once its numbers are read and
 * acknowledged; only the service's safety refusals stop a cell.
 */
import { MIN_LADDER_ENTRY_HF, reserveFractionFor } from "@zyo/shared";
import { acknowledgmentText, bestPerPool, normalizeForecast, userNetAtLtv, type ForecastCell, type ForecastView } from "../forecast";
import type { SolanaOpenPlan } from "./plan";
import raw from "./demo-forecast-crosschain.json";

/**
 * The registry label the evaluator requires on every cell. The loop's collateral is ZEC on Kamino — which the
 * cell's `borrowVenue`, threshold and cap carry — and the wizard never shows this label.
 */
export const LOOP_COLLATERAL_LABEL = "cbBTC" as const;

export type LoopChoice = { kind: "keep" } | { kind: "base"; poolId: string; setting: string };
export const DEFAULT_LOOP_CHOICE: LoopChoice = { kind: "keep" };

/** The generated snapshot (services/yield/scripts/gen-demo-forecast.mjs on the recorded Kamino capture), labelled demo. */
export function demoLoopForecast(): ForecastView {
  return normalizeForecast(raw, "demo");
}

/** Every Kamino-priced cell, best user net at this position's LTV first; unpriced cells last. */
export function loopCells(view: ForecastView, ltvBps: number): ForecastCell[] {
  const score = (c: ForecastCell) => userNetAtLtv(c, ltvBps) ?? -Infinity;
  return view.cells.filter((c) => c.borrowVenue === "kamino").sort((a, b) => score(b) - score(a) || b.rangeWidthBps - a.rangeWidthBps);
}

/** Simple mode's list: one cell per pool, at its best setting for this LTV. */
export function loopCellsPerPool(view: ForecastView, ltvBps: number): ForecastCell[] {
  return bestPerPool(loopCells(view, ltvBps), ltvBps);
}

export interface LoopPlan {
  kind: LoopChoice["kind"];
  borrowUsdc: number;
  /** The rung-2 requirement, held back on Solana whatever is chosen: `reserveFractionFor(entryHf)` of the debt, rounded up to the cent. */
  reserveUsdc: number;
  reserveFraction: number;
  /** What would cross to Base: the borrow less the reserve (0 when the USDC stays). */
  crossUsdc: number;
  cell: ForecastCell | null;
  userNetPct: number | null;
  mcUserNetPct: number | null;
  /** The chosen cell exists and the service does not refuse it. */
  allowed: boolean;
}

/** Cents, rounded up: the program rounds the reserve up too (`reserve_units_for`). */
const ceilCents = (x: number) => Math.ceil(x * 100 - 1e-9) / 100;

export function planLoop(plan: SolanaOpenPlan, choice: LoopChoice, view: ForecastView): LoopPlan {
  const borrowUsdc = plan.borrowUsdc;
  const finite = Number.isFinite(plan.entryHf) && borrowUsdc > 0;
  const reserveFraction = finite ? reserveFractionFor(Math.max(plan.entryHf, MIN_LADDER_ENTRY_HF)) : 0;
  const reserveUsdc = finite ? Math.min(borrowUsdc, ceilCents(borrowUsdc * reserveFraction)) : 0;
  const cell = choice.kind === "base" && finite ? (view.cells.find((c) => c.borrowVenue === "kamino" && c.poolId === choice.poolId && c.setting === choice.setting) ?? null) : null;
  const base = choice.kind === "base" && cell !== null;
  return {
    kind: base ? "base" : "keep",
    borrowUsdc,
    reserveUsdc,
    reserveFraction,
    crossUsdc: base ? Math.round((borrowUsdc - reserveUsdc) * 100) / 100 : 0,
    cell,
    userNetPct: cell ? userNetAtLtv(cell, plan.ltvBps) : null,
    mcUserNetPct: cell ? userNetAtLtv(cell, plan.ltvBps, cell.mcLpNetPct) : null,
    allowed: base && cell.allowed,
  };
}

/** The Base wizard's acknowledgment, with the loop's own sentence: what stays, what crosses, and through whom. */
export function loopAcknowledgment(lp: LoopPlan, plan: SolanaOpenPlan, view: ForecastView): string {
  if (lp.kind !== "base" || !lp.cell) return "";
  const borrow = lp.cell.borrowAprAfterPct ?? lp.cell.borrowAprNowPct ?? view.borrowAprPct ?? 0;
  const base = acknowledgmentText({
    strategy: "lp",
    collateral: "ZEC",
    cell: lp.cell,
    borrowAprPct: borrow,
    drawdownToLiquidationPct: plan.drawdownPct ?? 0,
  });
  return `${base} I understand that ${lp.reserveUsdc.toFixed(2)} USDC stays on Solana as the reserve, that ${lp.crossUsdc.toFixed(2)} USDC would cross to my own Base account through Circle, and that this build does not yet sign the crossing.`;
}

export interface CrossingStep {
  id: "set_base_account" | "deposit_for_burn" | "receive_and_open" | "cross_chain_grant";
  title: string;
  sentence: string;
}
/** The crossing as SOLANA-ARCHITECTURE §14.6 signs it — listed on the sign screen, not signed by this build. */
export function crossingSteps(lp: LoopPlan): CrossingStep[] {
  if (lp.kind !== "base" || !lp.cell) return [];
  const pair = `${lp.cell.pool.token0}/${lp.cell.pool.token1}`;
  return [
    { id: "set_base_account", title: "Record your Base account on Solana", sentence: "Writes the address of your own Oilskin account on Base into your Solana account, so a burn can only ever be pointed there." },
    { id: "deposit_for_burn", title: `Burn ${lp.crossUsdc.toFixed(2)} USDC to Base`, sentence: `Burns the USDC on Solana through Circle's CCTP with your Base account as the only possible recipient; ${lp.reserveUsdc.toFixed(2)} USDC stays behind as the reserve the program requires.` },
    { id: "receive_and_open", title: `Receive on Base and open ${pair}`, sentence: "After Circle attests, anyone may deliver the mint to your Base account; you then sign the pool position from your Base wallet." },
    { id: "cross_chain_grant", title: "Allow the keeper to close the pool position and burn back", sentence: "A second, revocable permission on Base, bounded in USDC per day, so rungs 3 and 4 can bring USDC back to Solana to repay." },
  ];
}
