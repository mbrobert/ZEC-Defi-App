/**
 * The Solana open, planned in the browser from the yield service's view of Kamino (lib/solana/yield.ts) and the
 * shared identity (BUILD-PLAN-2026-09-12 §2b): debt = collateral × LT ÷ HF. Kamino's own 40 % LTV cap binds every
 * position at HF ≥ LT ÷ LTV = 1.625, above the registry floor, so the slider's lowest offered HF is the cap's and the
 * screen says so. Pure: no wallet, no RPC.
 */
import { ENTRY_HF_FLOOR, HF_MARKS, ladderFor, MIN_LADDER_ENTRY_HF, type HfRung } from "@zyo/shared";
import type { SolanaBorrowView } from "./yield";

/** The five screens (SOLANA-ARCHITECTURE.md §8): one decision each. */
export const SOLANA_WIZARD_STEPS = ["Your ZEC", "Amount", "Health factor", "Review", "Sign"] as const;

export type SolanaBinding = "venue_max_ltv" | "entry_hf_floor";
export interface SolanaHfMark {
  id: "sheltered" | "expert";
  hf: number;
  label: string;
  offered: boolean;
  why: string | null;
}
export interface SolanaHfBounds {
  /** The lowest entry HF offered — the slider's right-hand stop — and what put it there. */
  minHf: number;
  binding: SolanaBinding;
  ltBps: number;
  ltvCapBps: number;
  floor: number;
  marks: SolanaHfMark[];
}

export function solanaBindingWords(b: SolanaBinding, floor: number): string {
  return b === "venue_max_ltv" ? "Kamino's own 40 % loan-to-value cap for ZEC" : `the entry floor of ${floor.toFixed(2)}`;
}

/** Bounds from the LIVE reserve numbers the view carries; null when it carries none (unreadable, refused). */
export function solanaHfBounds(view: Pick<SolanaBorrowView, "liquidationThresholdBps" | "ltvCapBps" | "entryHfFloor">, floor: number = view.entryHfFloor || ENTRY_HF_FLOOR): SolanaHfBounds | null {
  const lt = view.liquidationThresholdBps;
  const cap = view.ltvCapBps;
  if (lt === null || cap === null || !(lt > 0) || !(cap > 0)) return null;
  const hfAtCap = lt / cap;
  const binding: SolanaBinding = hfAtCap > floor ? "venue_max_ltv" : "entry_hf_floor";
  const minHf = Math.max(hfAtCap, floor);
  const marks: SolanaHfMark[] = HF_MARKS.map((m) => {
    const offered = m.hf >= minHf - 1e-9;
    return { id: m.id, hf: m.hf, label: m.label, offered, why: offered ? null : `${m.label} (${m.hf.toFixed(2)}) is under the lowest health factor offered for ZEC on Kamino, ${minHf.toFixed(3)} — ${solanaBindingWords(binding, floor)}.` };
  });
  return { minHf, binding, ltBps: lt, ltvCapBps: cap, floor, marks };
}

export function clampSolanaHf(hf: number, b: SolanaHfBounds): number {
  if (!Number.isFinite(hf)) return hf;
  return hf < b.minHf ? b.minHf : hf;
}
/** The HF a typed borrow means; +∞ for no borrow. */
export function solanaHfForBorrow(borrowUsdc: number, collateralUsd: number, ltBps: number): number {
  if (!(borrowUsdc > 0) || !(collateralUsd > 0)) return Number.POSITIVE_INFINITY;
  return (collateralUsd * ltBps) / 10_000 / borrowUsdc;
}

export const toUnits = (x: number, decimals: number): bigint => BigInt(Math.round(x * 10 ** decimals));
export const fromUnits = (u: bigint, decimals: number): number => Number(u) / 10 ** decimals;

export interface SolanaOpenPlan {
  collateralZec: number;
  collateralUnits: bigint;
  collateralUsd: number;
  entryHf: number;
  /** USDC to borrow (0 when the HF is +∞). */
  borrowUsdc: number;
  borrowUnits: bigint;
  ltvBps: number;
  liquidationPriceUsd: number | null;
  drawdownPct: number | null;
  rungs: readonly HfRung[];
  ladderOk: boolean;
  /** Whether the pool can lend this much right now (the view's maxFundable). */
  fundable: boolean;
  zecPriceUsd: number;
  ltBps: number;
}

/** The plan at a chosen HF. Null when the view carries no price or threshold (nothing can be planned from nothing). */
export function planSolanaOpen(i: { collateralZec: number; entryHf: number; view: SolanaBorrowView }): SolanaOpenPlan | null {
  const { view } = i;
  if (view.zecPriceUsd === null || view.liquidationThresholdBps === null || !(i.collateralZec > 0)) return null;
  const price = view.zecPriceUsd;
  const usdcPrice = view.usdcPriceUsd ?? 1;
  const collateralUsd = i.collateralZec * price;
  const finite = Number.isFinite(i.entryHf) && i.entryHf >= 1;
  const debtUsd = finite ? (collateralUsd * view.liquidationThresholdBps) / 10_000 / i.entryHf : 0;
  const borrowUsdc = finite ? Math.floor((debtUsd / usdcPrice) * 100) / 100 : 0;
  const rungs = finite ? ladderFor(Math.max(i.entryHf, MIN_LADDER_ENTRY_HF)) : ladderFor(MIN_LADDER_ENTRY_HF);
  return {
    collateralZec: i.collateralZec,
    collateralUnits: toUnits(i.collateralZec, 8),
    collateralUsd,
    entryHf: i.entryHf,
    borrowUsdc,
    borrowUnits: toUnits(borrowUsdc, 6),
    ltvBps: borrowUsdc > 0 ? Math.round(((borrowUsdc * usdcPrice) / collateralUsd) * 10_000) : 0,
    liquidationPriceUsd: borrowUsdc > 0 ? (borrowUsdc * usdcPrice) / ((i.collateralZec * view.liquidationThresholdBps) / 10_000) : null,
    drawdownPct: finite ? 100 * (1 - 1 / i.entryHf) : null,
    rungs,
    ladderOk: finite && i.entryHf >= MIN_LADDER_ENTRY_HF,
    fundable: view.maxFundableUsdc === null ? false : borrowUsdc <= view.maxFundableUsdc + 1e-9,
    zecPriceUsd: price,
    ltBps: view.liquidationThresholdBps,
  };
}

/**
 * The keeper grant the wizard proposes: 30 days, per-day budgets sized to THIS position (the whole debt may be
 * repaid, the whole collateral may be sold in an emergency — the founder's decision 1), a 2 % allowance under the
 * Scope-priced floor for a sale, every rung. Oilskin's defaults, shown before signing and revocable at any time.
 */
export const SOLANA_GRANT = { expiryDays: 30, periodSecs: 86_400n, maxSellSlippageBps: 200, allowedRungs: 0b1111 } as const;
export interface SolanaGrantPlan {
  expiryTs: bigint;
  periodSecs: bigint;
  repayUsdcPerPeriod: bigint;
  sellZecPerPeriod: bigint;
  maxSellSlippageBps: number;
  allowedRungs: number;
}
export function grantParamsFor(plan: SolanaOpenPlan, nowS: number): SolanaGrantPlan {
  return {
    expiryTs: BigInt(nowS + SOLANA_GRANT.expiryDays * 86_400),
    periodSecs: SOLANA_GRANT.periodSecs,
    repayUsdcPerPeriod: plan.borrowUnits,
    sellZecPerPeriod: plan.collateralUnits,
    maxSellSlippageBps: SOLANA_GRANT.maxSellSlippageBps,
    allowedRungs: SOLANA_GRANT.allowedRungs,
  };
}

export type OpenStepId = "init" | "deposit" | "borrow" | "grant";
export interface OpenStep {
  id: OpenStepId;
  title: string;
  sentence: string;
}
/** One wallet prompt per step; each introduced by one plain sentence. Separate transactions: together they exceed Solana's size limit. */
export function openSteps(plan: SolanaOpenPlan, o: { accountExists: boolean; keeperConfigured: boolean }): OpenStep[] {
  const steps: OpenStep[] = [];
  if (!o.accountExists) steps.push({ id: "init", title: "Create your Oilskin account", sentence: "Creates an account on Solana that only your wallet controls, with its own ZEC and USDC token accounts and a Kamino borrowing position owned by that account. One-time, refundable rent only." });
  steps.push({ id: "deposit", title: `Deposit ${plan.collateralZec} ZEC`, sentence: `Moves ${plan.collateralZec} ZEC from your wallet into your Oilskin account and on into Kamino as collateral.` });
  if (plan.borrowUsdc > 0) steps.push({ id: "borrow", title: `Borrow ${plan.borrowUsdc.toFixed(2)} USDC`, sentence: `Borrows ${plan.borrowUsdc.toFixed(2)} USDC from Kamino into your Oilskin account at a health factor of ${plan.entryHf.toFixed(2)}. The program refuses if the result would be under the entry floor.` });
  if (o.keeperConfigured && plan.borrowUsdc > 0) steps.push({ id: "grant", title: "Allow the keeper to protect this position", sentence: `Lets the Oilskin keeper repay up to ${plan.borrowUsdc.toFixed(2)} USDC and, if liquidation threatens, sell up to ${plan.collateralZec} ZEC per day at no worse than 2 % under Kamino's oracle price, for 30 days. You can revoke it at any time; the program checks every action against these limits.` });
  return steps;
}
