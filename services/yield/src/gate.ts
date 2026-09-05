/**
 * The yield gate — pure, deterministic, fail-closed.
 *
 *   qualifies(pool, setting, collateral) ⇔ lpNet(emissionsNet(w), σ, w) > aaveUsdcBorrowApr
 *   with lpNet = realized emissions on the drag-shrunk base + drag (src/model.ts)
 *
 * with every input LIVE and FRESH. Any missing, stale, outlier, inactive or
 * uncalibrated input yields `qualifies:false` with the specific reason —
 * there is no path on which an absent number reads as zero drag, zero
 * borrow or free emissions. Ordering of the checks matters only for which
 * reason is reported; every check must pass to qualify.
 *
 * The collateral does not change the borrow rate (v1 borrows USDC against
 * any enabled collateral) but it does decide (a) whether the position can
 * exist at all (registry `enabled` + Aave collateral flags read live) and
 * (b) the user-net numbers: the collateral's supply APR and its derived LTV
 * presets (top = min(50 %, floor(LT / entryHfFloor)) from the LIVE
 * liquidation threshold — packages/shared, never typed).
 */

import {
  COLLATERAL_ASSETS,
  ltvPresets,
  type CollateralSymbol,
  type CuratedPool,
} from "@zyo/shared";
import type { VolatilityInputs } from "./config.js";
import {
  breakEvenEmissionsMultiple,
  breakEvenSigma,
  dragPct,
  keepFactor,
  lpNetPct,
  priceHalfWidth,
  realizedEmissionsPct,
  round2,
  SETTINGS,
  settingWidthBps,
  userNetPct,
  type Setting,
} from "./model.js";
import type { AaveRatesSample, EmissionsSample, GateReason, GateUserNet, GateVerdict } from "./types.js";

export interface GateInputs {
  pool: CuratedPool;
  setting: Setting;
  collateral: CollateralSymbol;
  /** null = never sampled. `stale` is the SERVE-TIME flag. */
  rates: (AaveRatesSample & { stale: boolean }) | null;
  emissions: (EmissionsSample & { stale: boolean }) | null;
  volatility: VolatilityInputs;
  /** Unix seconds "now" — epochActive is re-derived from periodFinish. */
  nowSeconds: number;
}

/** Max |user net| the gate will ever serve, percent (round-3 absolute bound). */
export const MAX_ABS_NET_PCT = 2_000;

function refuse(
  base: Omit<GateVerdict, "qualifies" | "reason">,
  reason: GateReason
): GateVerdict {
  return { ...base, qualifies: false, reason };
}

export function evaluateGate(input: GateInputs): GateVerdict {
  const { pool, setting, collateral, rates, emissions, volatility, nowSeconds } = input;
  const rangeWidthBps = settingWidthBps(setting, pool.pairClass);
  const halfWidth = priceHalfWidth(rangeWidthBps);

  const base: Omit<GateVerdict, "qualifies" | "reason"> = {
    poolId: pool.id,
    setting: setting.id,
    preset: setting.preset,
    collateral,
    rangeWidthBps,
    halfWidth,
    emissionsGrossPct: null,
    emissionsNetPct: null,
    emissionsRealizedPct: null,
    dragPct: null,
    lpNetPct: null,
    borrowAprPct: null,
    collateralSupplyAprPct: null,
    sigma: null,
    breakEvenSigma: null,
    breakEvenEmissionsMultiple: null,
    userNet: [],
  };

  // 1. Collateral must be enabled in the registry and live on Aave.
  const asset = COLLATERAL_ASSETS[collateral];
  if (!asset || !asset.enabled) return refuse(base, "collateral_disabled");

  // 2. Rates must exist and be fresh.
  if (!rates) return refuse(base, "rates_unavailable");
  if (rates.stale) return refuse(base, "rates_stale");
  const reserve = rates.collateral[collateral];
  if (!reserve || !reserve.usageAsCollateralEnabled || !reserve.isActive || reserve.isFrozen) {
    return refuse(base, "collateral_not_active");
  }
  const borrow = rates.borrow.variableBorrowAprPct;
  const supply = reserve.supplyAprPct;
  const withRates = { ...base, borrowAprPct: borrow, collateralSupplyAprPct: supply };

  // 3. Emissions must exist, be fresh, active, sane.
  if (!emissions) return refuse(withRates, "emissions_unavailable");
  if (emissions.stale) return refuse(withRates, "emissions_stale");
  const epochActive =
    emissions.epochActive && BigInt(emissions.rewardRateWeiPerSec) > 0n && emissions.periodFinish > nowSeconds;
  if (!epochActive) return refuse({ ...withRates, emissionsGrossPct: 0, emissionsNetPct: 0 }, "no_emissions");
  if (emissions.outlier) return refuse(withRates, "staked_liquidity_outlier");
  const gross = emissions.aprByWidthPct?.[String(rangeWidthBps)];
  if (gross === undefined || gross === null || !Number.isFinite(gross)) {
    return refuse(withRates, "no_staked_liquidity");
  }
  const net = gross * keepFactor(pool.protocol);
  const withEmissions = { ...withRates, emissionsGrossPct: round2(gross), emissionsNetPct: round2(net) };

  // 4. Emissions alone must clear the borrow (drag is never positive, and
  //    realized emissions never exceed the in-range rate).
  if (!(net > borrow)) return refuse(withEmissions, "emissions_below_borrow");

  // 5. σ must be calibrated for the pool.
  const vol = volatility.pools[pool.id];
  if (!vol) return refuse(withEmissions, "no_volatility_input");
  const drag = dragPct(vol.sigma, halfWidth);
  const realized = realizedEmissionsPct(net, vol.sigma, halfWidth);
  const lpNet = lpNetPct(net, vol.sigma, halfWidth);
  const be = breakEvenSigma(net, borrow, halfWidth);
  const bem = breakEvenEmissionsMultiple(net, borrow, vol.sigma, halfWidth);
  const userNet: GateUserNet[] = ltvPresets(reserve.liquidationThresholdBps).map((p) => ({
    ltvBps: p.ltvBps,
    offerable: p.offerable,
    userNetPct: round2(clampAbs(userNetPct(supply, p.ltvBps, lpNet, borrow), MAX_ABS_NET_PCT)),
  }));
  const full = {
    ...withEmissions,
    emissionsRealizedPct: round2(realized),
    dragPct: round2(drag),
    lpNetPct: round2(lpNet),
    sigma: vol.sigma,
    breakEvenSigma: be === null ? null : round2(be),
    breakEvenEmissionsMultiple: bem === null ? null : round2(bem),
    userNet,
  };

  // 6. The gate itself.
  if (!(lpNet > borrow)) return refuse(full, "net_below_borrow");
  return { ...full, qualifies: true, reason: null };
}

function clampAbs(x: number, bound: number): number {
  if (!Number.isFinite(x)) return -bound;
  return Math.max(-bound, Math.min(bound, x));
}

/** All verdicts for one pool: every setting × every registry collateral. */
export function evaluatePool(
  pool: CuratedPool,
  collaterals: readonly CollateralSymbol[],
  ctx: Omit<GateInputs, "pool" | "setting" | "collateral">
): GateVerdict[] {
  const out: GateVerdict[] = [];
  for (const setting of SETTINGS) {
    for (const collateral of collaterals) {
      out.push(evaluateGate({ ...ctx, pool, setting, collateral }));
    }
  }
  return out;
}
