/**
 * Wizard state + derivations (pure). The page owns the state; everything
 * numeric on Review is produced by `deriveReview` from chain-read inputs and
 * the served gate verdict.
 */
import {
  COLLATERAL_ASSETS,
  ltvPresets,
  presetToLpParams,
  validateLpParams,
  type CollateralSymbol,
  type LpParams,
  type LtvPreset,
  type LtvPresetId,
} from "@zyo/shared";
import { findVerdict, type GateEntry, type GateView } from "./gate";
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
  /** Pool still clears the gate at review time (re-derived from served numbers). */
  gateOk: boolean;
  /** Hold / spot: cost of carrying the borrow with nothing deployed, USD per year. */
  holdCostUsdPerYear: number;
  /** True when Advanced overrides moved the width away from the verdict's — the model priced the preset width, not this one. */
  customWidth: boolean;
  problems: string[];
}

export function deriveReview(state: WizardState, market: MarketRead, gate: GateView): ReviewDerivation | null {
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

  let verdict: GateEntry | null = null;
  let lpParams: LpParams | null = null;
  let yieldPlan: YieldPlan | null = null;
  let gateOk = true;
  if (state.strategy?.kind === "lp") {
    const chosen = state.strategy.entry;
    const live = findVerdict(gate, { ...chosen, collateral: state.collateral }) ?? (chosen.collateral === state.collateral ? chosen : null);
    verdict = live;
    gateOk = !!live && live.qualifies;
    if (!live) problems.push("The chosen pool has no verdict for this collateral.");
    else if (!live.qualifies) problems.push(`${live.pool.token0}/${live.pool.token1} (${live.preset.toLowerCase()}) does not clear the gate at the current borrow rate.`);
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
    lpParams,
    yieldPlan,
    gateOk,
    holdCostUsdPerYear,
    customWidth: !!verdict && !!lpParams && lpParams.rangeWidthBps !== verdict.rangeWidthBps,
    problems,
  };
}
