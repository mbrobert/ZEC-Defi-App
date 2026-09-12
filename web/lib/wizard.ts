/**
 * Wizard state + derivations (pure). The page owns the state; everything
 * numeric on Review is produced by `deriveReview` from chain-read inputs, the
 * served forecast cell and the gate verdict (informational since 2026-09-12).
 */
import { ltvPresets, presetToLpParams, validateLpParams, type CollateralSymbol, type LpParams, type LtvPreset, type LtvPresetId } from "@zyo/shared";
import { COLLATERAL_ASSETS } from "./chain";
import { findCell, refusalPlain, type ForecastCell, type ForecastView } from "./forecast";
import { findVerdict, type GateEntry, type GateView } from "./gate";
import { fmtUsd } from "./format";
import { planLoan, planYield, type LoanPlan, type YieldPlan } from "./math";
import { DEFAULT_BAND_TOLERANCE_BPS, MAX_BAND_TOLERANCE_BPS } from "./plan";
import type { MarketRead } from "./reads";

export type StrategyChoice = { kind: "lp"; entry: GateEntry } | { kind: "hold" } | { kind: "spot" };

export interface WizardState {
  collateral: CollateralSymbol;
  amount: string;
  ltvPreset: LtvPresetId;
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
    ltvPreset: "p40",
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

/**
 * Presets for the chosen asset from the LIVE liquidation threshold; null when
 * the reserve is unreadable or unusable.
 *
 * The registry's own `maxOfferedLtvBps` is `min(LT / floor, venue.maxLtvBps,
 * 5000)` — it respects the venue's MAX LTV as well as its liquidation
 * threshold, so an Aave LTV→0 deprecation takes the offer to zero instead of
 * advertising a setting under which every open reverts. This mirrors that: a
 * preset above the venue's own LTV is marked NOT offerable, and the UI says
 * "not offered right now" rather than rendering "0 %".
 */
export function presetsFor(market: MarketRead, collateral: CollateralSymbol): LtvPreset[] | null {
  const r = market.reserves[collateral];
  if (!r || !r.usageAsCollateralEnabled || !r.isActive || r.isFrozen) return null;
  const venueLtv = Number.isFinite(r.ltvBps) ? r.ltvBps : 0;
  return ltvPresets(r.liquidationThresholdBps).map((p) => (p.ltvBps > venueLtv ? { ...p, offerable: false } : p));
}

export interface ReviewDerivation {
  asset: (typeof COLLATERAL_ASSETS)[CollateralSymbol];
  amount: number;
  priceUsd: number;
  liquidationThresholdBps: number;
  supplyAprPct: number;
  preset: LtvPreset;
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

export function deriveReview(state: WizardState, market: MarketRead, gate: GateView, forecast: ForecastView | null = null): ReviewDerivation | null {
  const r = market.reserves[state.collateral];
  const presets = presetsFor(market, state.collateral);
  if (!r || !presets) return null;
  const preset = presets.find((p) => p.id === state.ltvPreset) ?? presets[0];
  const amount = amountNumber(state.amount);
  const problems: string[] = [];
  if (amount <= 0) problems.push("Enter a collateral amount.");
  if (!preset.offerable) problems.push(`The ${preset.label} setting is not offered for ${state.collateral} at today's liquidation threshold.`);
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
    ltvBps: preset.ltvBps,
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
    preset,
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
