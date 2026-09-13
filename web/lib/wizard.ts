/**
 * Wizard state + derivations (pure). The page owns the state; everything
 * numeric on Review is produced by `deriveReview` from chain-read inputs, the
 * served forecast cell and the gate verdict (informational since 2026-09-12).
 *
 * The setting is a health factor (BUILD-PLAN-2026-09-12 D7 / §2b): the user chooses the entry HF on
 * a continuous slider from the registry floor up to "borrow nothing"; the borrow follows from
 * debt = collateral × LT ÷ HF and typing a borrow drives the HF back. "Sheltered" and "Expert"
 * are marks on that slider, not modes. Below the Sheltered mark the user ticks an acknowledgment
 * that names the drawdown they chose.
 */
import {
  ENTRY_HF_FLOOR,
  HF_MARKS,
  offeredLtvBounds,
  presetToLpParams,
  validateLpParams,
  type CollateralSymbol,
  type HfRung,
  type LpParams,
  type LtvBindingCap,
} from "@zyo/shared";
import { COLLATERAL_ASSETS } from "./chain";
import { findCell, refusalPlain, type ForecastCell, type ForecastView } from "./forecast";
import { findVerdict, type GateEntry, type GateView } from "./gate";
import { fmtUsd } from "./format";
import { planLoan, planYield, type LoanPlan, type YieldPlan } from "./math";
import { DEFAULT_BAND_TOLERANCE_BPS, MAX_BAND_TOLERANCE_BPS } from "./plan";
import type { MarketRead } from "./reads";

export type StrategyChoice = { kind: "lp"; entry: GateEntry } | { kind: "hold" } | { kind: "spot" };

/** The two quick-click marks (D7). The Sheltered one is also the line under which the acknowledgment is required. */
export const SHELTERED_MARK = HF_MARKS.find((m) => m.id === "sheltered")!;
export const EXPERT_MARK = HF_MARKS.find((m) => m.id === "expert")!;

export interface WizardState {
  collateral: CollateralSymbol;
  amount: string;
  /**
   * The entry health factor chosen on the slider (D7). +∞ = "borrow nothing", the slider's far end,
   * which the review refuses as a position (there is nothing to deploy). Kept at full precision when
   * it was derived from a typed borrow, so the borrow reads back to the cent.
   */
  entryHf: number;
  /**
   * Ticked on the Setting step when `entryHf` is under the Sheltered mark; the sentence names the
   * drawdown to liquidation the user chose (§2b). Reset whenever the HF, collateral or amount moves.
   */
  hfAcknowledged: boolean;
  strategy: StrategyChoice | null;
  /** Advanced only: override the preset's width / delay (on-chain bounds enforced). null = preset value. */
  customWidthBps: number | null;
  customDelayHours: number | null;
  /** Advanced only: price-band tolerance for the deposit, bps of price. */
  bandToleranceBps: number;
  /** Ask for the keeper protection grant after opening (Simple: always on). */
  keeperProtection: boolean;
  /**
   * The user ticked the acknowledgment on Review — the sentence that names the forecast, the
   * borrow cost and the drawdown to liquidation for THIS position (BUILD-PLAN-2026-09-12 D4/D5).
   * Reset whenever the collateral, amount, setting or strategy changes.
   */
  acknowledged: boolean;
}

export const WIZARD_STEPS = ["Collateral", "Setting", "Strategy", "Review", "Sign"] as const;

export function defaultWizardState(collateral: CollateralSymbol = "cbBTC"): WizardState {
  return {
    collateral,
    amount: collateral === "cbBTC" ? "0.5" : "5",
    // The Sheltered mark; the page clamps it up to the asset's offered minimum when that is higher.
    entryHf: SHELTERED_MARK.hf,
    hfAcknowledged: false,
    strategy: null,
    customWidthBps: null,
    customDelayHours: null,
    bandToleranceBps: DEFAULT_BAND_TOLERANCE_BPS,
    keeperProtection: true,
    acknowledged: false,
  };
}

export function amountNumber(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export interface HfMark {
  id: "sheltered" | "expert";
  hf: number;
  label: string;
  /** False when the mark sits under the lowest HF offered on this asset today; `why` says which cap. */
  offered: boolean;
  why: string | null;
}

/** The slider's bounds on one asset, from the LIVE reserve and the registry floor. */
export interface HfBounds {
  /** The lowest entry HF offered — the slider's right-hand stop — and the cap that put it there. */
  minHf: number;
  binding: LtvBindingCap;
  /** LTV at `minHf`, whole bps. */
  maxLtvBps: number;
  /** The registry's entry floor (read from the deployment; the shared constant in demo mode). */
  floor: number;
  ltBps: number;
  venueLtvBps: number;
  marks: HfMark[];
}

/** What stops the slider, in words. */
export function bindingPlain(binding: LtvBindingCap, floor: number): string {
  switch (binding) {
    case "entry_hf_floor":
      return `the registry's entry floor of ${floor.toFixed(2)}`;
    case "venue_max_ltv":
      return "Aave's own maximum LTV for this asset";
  }
}

/**
 * Bounds for the chosen asset from the LIVE liquidation threshold, the venue's own max LTV and the
 * registry floor — the only two limits since the 50 % product cap was removed (2026-09-12); null when
 * the reserve is unreadable, unusable, or offers nothing (an Aave LTV→0
 * deprecation takes the offer to zero instead of advertising a setting under which every open reverts —
 * the registry's own `maxOfferedLtvBps` is the same min, so what is shown is what the chain accepts).
 */
export function hfBoundsFor(market: MarketRead, collateral: CollateralSymbol, floor: number = ENTRY_HF_FLOOR): HfBounds | null {
  const r = market.reserves[collateral];
  if (!r || !r.usageAsCollateralEnabled || !r.isActive || r.isFrozen) return null;
  if (!Number.isFinite(r.liquidationThresholdBps) || r.liquidationThresholdBps <= 0) return null;
  const venueLtvBps = Number.isFinite(r.ltvBps) ? r.ltvBps : 0;
  const b = offeredLtvBounds(r.liquidationThresholdBps, venueLtvBps, floor);
  if (b.maxLtvBps <= 0 || !Number.isFinite(b.minHf)) return null;
  const marks: HfMark[] = HF_MARKS.map((m) => {
    const offered = m.hf >= b.minHf - 1e-9;
    return {
      id: m.id,
      hf: m.hf,
      label: m.label,
      offered,
      why: offered ? null : `${m.label} (${m.hf.toFixed(2)}) is under the lowest health factor offered for ${collateral} today, ${b.minHf.toFixed(2)} — ${bindingPlain(b.binding, floor)}.`,
    };
  });
  return { minHf: b.minHf, binding: b.binding, maxLtvBps: b.maxLtvBps, floor, ltBps: r.liquidationThresholdBps, venueLtvBps, marks };
}

/** A chosen HF pulled up to the offered minimum; +∞ (borrow nothing) passes through. */
export function clampEntryHf(hf: number, b: HfBounds): number {
  if (!Number.isFinite(hf)) return hf;
  return hf < b.minHf ? b.minHf : hf;
}

/** The HF that a typed borrow means, from the identity HF = collateral × LT ÷ debt; +∞ for no borrow. */
export function entryHfForBorrow(borrowUsdc: number, collateralUsd: number, ltBps: number): number {
  if (!(borrowUsdc > 0) || !(collateralUsd > 0)) return Number.POSITIVE_INFINITY;
  return (collateralUsd * ltBps) / 10_000 / borrowUsdc;
}

export function needsHfAcknowledgment(entryHf: number): boolean {
  return Number.isFinite(entryHf) && entryHf < SHELTERED_MARK.hf - 1e-9;
}

/** The sentence the user ticks under the slider when the HF is below the Sheltered mark (§2b). */
export function hfAcknowledgmentText(i: { entryHf: number; collateral: string; drawdownPct: number; rungs: readonly HfRung[] }): string {
  const first = i.rungs[0]!;
  const last = i.rungs[i.rungs.length - 1]!;
  return (
    `I chose an entry health factor of ${i.entryHf.toFixed(2)}, under the Sheltered mark of ${SHELTERED_MARK.hf.toFixed(2)}. ` +
    `A ${i.drawdownPct.toFixed(1)}% fall in ${i.collateral} from today's price liquidates this position. ` +
    `The keeper's first step, a message, comes at HF ${first.hf.toFixed(2)} and its last, closing the position, at ${last.hf.toFixed(2)} — and only while the permission I grant it is live. ` +
    `Nothing here is advice or a promise.`
  );
}

export interface ReviewDerivation {
  asset: (typeof COLLATERAL_ASSETS)[CollateralSymbol];
  amount: number;
  priceUsd: number;
  liquidationThresholdBps: number;
  supplyAprPct: number;
  /** The slider's bounds on this asset (the floor, the binding cap, the marks). */
  bounds: HfBounds;
  loan: LoanPlan;
  borrowAprPct: number;
  /** The verdict the review is priced on (re-fetched from the current gate view). */
  verdict: GateEntry | null;
  lpParams: LpParams | null;
  yieldPlan: YieldPlan | null;
  /**
   * Informational since 2026-09-12: the chosen cell clears the borrow on BOTH models (re-derived
   * from the served numbers). Never a problem — the forecast is shown and acknowledged, not gated.
   */
  gateOk: boolean;
  /** The forecast cell the chosen LP entry came from, when the forecast view carries it. */
  cell: ForecastCell | null;
  /** Hold / spot: cost of carrying the borrow with nothing deployed, USD per year. */
  holdCostUsdPerYear: number;
  /** True when Advanced overrides moved the width away from the verdict's — the model priced the preset width, not this one. */
  customWidth: boolean;
  problems: string[];
}

export function deriveReview(
  state: WizardState,
  market: MarketRead,
  gate: GateView,
  forecast: ForecastView | null = null,
  /** The registry's entry floor as read from the deployment; the shared constant when unknown (demo). */
  floor: number = ENTRY_HF_FLOOR,
): ReviewDerivation | null {
  const r = market.reserves[state.collateral];
  const bounds = hfBoundsFor(market, state.collateral, floor);
  if (!r || !bounds) return null;
  const amount = amountNumber(state.amount);
  const problems: string[] = [];
  if (amount <= 0) problems.push("Enter a collateral amount.");
  if (!(typeof state.entryHf === "number") || Number.isNaN(state.entryHf) || state.entryHf < 1) {
    problems.push("The health factor is not a readable number.");
  } else if (!Number.isFinite(state.entryHf)) {
    problems.push("Borrow nothing is the far end of the slider: with no loan there is nothing to deploy. Move it to borrow, or leave without opening a position.");
  } else if (state.entryHf < bounds.minHf - 1e-9) {
    problems.push(`A health factor of ${state.entryHf.toFixed(2)} is under the lowest offered for ${state.collateral} today, ${bounds.minHf.toFixed(2)} (${bindingPlain(bounds.binding, floor)}).`);
  }
  if (needsHfAcknowledgment(state.entryHf) && !state.hfAcknowledged) {
    problems.push(`Tick the acknowledgment under the slider: you chose a health factor under the Sheltered mark of ${SHELTERED_MARK.hf.toFixed(2)}.`);
  }
  if (!Number.isFinite(r.priceUsd) || r.priceUsd <= 0) problems.push("Collateral price unreadable — refusing to size the borrow.");
  if (!Number.isFinite(market.usdcBorrowAprPct)) problems.push("USDC borrow rate unreadable.");
  if (!state.strategy) problems.push("Choose a strategy.");
  if (!Number.isInteger(state.bandToleranceBps) || state.bandToleranceBps < 1 || state.bandToleranceBps > MAX_BAND_TOLERANCE_BPS) {
    problems.push(`Price tolerance must be between 0.01% and ${MAX_BAND_TOLERANCE_BPS / 100}%.`);
  }

  const loan = planLoan({
    collateralAmount: amount,
    collateralPriceUsd: r.priceUsd,
    liquidationThresholdBps: r.liquidationThresholdBps,
    entryHf: Number.isFinite(state.entryHf) && state.entryHf >= 1 ? state.entryHf : Number.POSITIVE_INFINITY,
    borrowAprPct: market.usdcBorrowAprPct,
  });
  const supplyInterest = (loan.collateralUsd * r.supplyAprPct) / 100;
  const holdCostUsdPerYear = loan.borrowCostUsdPerYear - supplyInterest;
  // The liquidity hard-refusal (BUILD-PLAN-2026-09-12 §2 item 2): a borrow the pool cannot fund is
  // refused by name, from the same getReserveData words the rate came from.
  const usdc = market.reserves.USDC;
  if (usdc?.availableUnits !== undefined && loan.borrowUsdc > usdc.availableUnits) {
    problems.push(`The Aave USDC pool cannot fund this borrow right now: it holds ${fmtUsd(usdc.availableUnits, 0)} USDC to lend and this position would borrow ${fmtUsd(loan.borrowUsdc, 0)}.`);
  }

  let verdict: GateEntry | null = null;
  let cell: ForecastCell | null = null;
  let lpParams: LpParams | null = null;
  let yieldPlan: YieldPlan | null = null;
  let gateOk = true;
  if (state.strategy?.kind === "lp") {
    const chosen = state.strategy.entry;
    // The chosen entry is priced from the forecast cell when the view carries it (live or demo), else
    // from the gate verdict, else from the entry the user picked — never blocked for not clearing.
    cell = forecast ? (findCell(forecast, { ...chosen, collateral: state.collateral }) ?? null) : null;
    const live = findVerdict(gate, { ...chosen, collateral: state.collateral }) ?? (chosen.collateral === state.collateral ? chosen : null);
    verdict = live;
    gateOk = !!live && live.qualifies;
    if (!live) problems.push("The chosen pool has no forecast for this collateral.");
    // The forecast's SAFETY refusals are problems; its verdict on profitability is not.
    for (const refusal of cell?.refusals ?? []) problems.push(refusalPlain(refusal));
    if (live) {
      lpParams = { ...presetToLpParams(live.preset, live.pool.pairClass), rangeWidthBps: live.rangeWidthBps, rebalanceDelayHours: live.rebalanceDelayHours || presetToLpParams(live.preset).rebalanceDelayHours };
      if (state.customWidthBps !== null) lpParams.rangeWidthBps = state.customWidthBps;
      if (state.customDelayHours !== null) lpParams.rebalanceDelayHours = state.customDelayHours;
      for (const err of validateLpParams(lpParams)) problems.push(err);
      if (live.emissionsGrossPct !== null && live.emissionsNetPct !== null && live.emissionsRealizedPct !== null && live.dragPct !== null && live.lpNetPct !== null) {
        yieldPlan = planYield({
          borrowUsdc: loan.borrowUsdc,
          collateralUsd: loan.collateralUsd,
          borrowAprPct: market.usdcBorrowAprPct,
          supplyAprPct: r.supplyAprPct,
          emissionsGrossPct: live.emissionsGrossPct,
          emissionsNetPct: live.emissionsNetPct,
          emissionsRealizedPct: live.emissionsRealizedPct,
          dragPct: live.dragPct,
          lpNetPct: live.lpNetPct,
          engineFeeBps: gate.engineFeeBps,
        });
      }
    }
  }

  return {
    asset: COLLATERAL_ASSETS[state.collateral],
    amount,
    priceUsd: r.priceUsd,
    liquidationThresholdBps: r.liquidationThresholdBps,
    supplyAprPct: r.supplyAprPct,
    bounds,
    loan,
    borrowAprPct: market.usdcBorrowAprPct,
    verdict,
    cell,
    lpParams,
    yieldPlan,
    gateOk,
    holdCostUsdPerYear,
    customWidth: !!verdict && !!lpParams && lpParams.rangeWidthBps !== verdict.rangeWidthBps,
    problems,
  };
}
