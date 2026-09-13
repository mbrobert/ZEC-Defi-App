/**
 * The forecast — the gate's model, served as information at the entry health factor (HF) the
 * user chose. BUILD-PLAN-2026-09-12 D4 (the yield gate is no longer a barrier), D5 (Simple mode
 * allows every curated pool after an acknowledgment), D7 (risk is a continuous HF), step A3.
 *
 * What is different from src/gate.ts, and why it is a sibling and not a rewrite:
 *   - the gate stops at the first failed inequality and publishes nothing past it (its tests pin
 *     that order); the forecast prices EVERY number the inputs allow — a cell whose emissions sit
 *     below the borrow still gets its drag, its LP net on both forms, its break-evens and its
 *     user net — and reports the borrow comparison as `clearsBorrow`, information the site shows;
 *   - the only refusals are the safety ones in BUILD-PLAN §2 (`ForecastRefusal`): the registry
 *     entry floor, a borrow the pool cannot fund, stale rates, a paused or inactive reserve, a
 *     disabled asset, the venue's own LTV. A negative forecast, a thin buffer above the floor,
 *     an uncalibrated cell — all shown, acknowledged, allowed;
 *   - the position is described at the CHOSEN entry HF through one identity
 *     (debt = collateral × LT ÷ HF; drawdown to liquidation = 1 − 1 ÷ HF), not at fixed LTV
 *     presets, and the borrow rate is re-priced on the venue's own curve with this borrow added.
 *
 * Every model function is the gate's (src/model.ts, src/mc-calibration.ts); nothing here is a
 * new number. The gate itself is unchanged and /v1/gate still serves it.
 */

import { COLLATERAL_ASSETS, ENTRY_HF_FLOOR, kaminoCurveAprBps, type CollateralSymbol, type CuratedPool } from "@zyo/shared";
import type { VolatilityInputs } from "./config.js";
import { MAX_ABS_NET_PCT, MAX_EMISSIONS_APR_PCT, MIN_GATE_STAKED_SAMPLES } from "./gate.js";
import { applyMcCalibration, type McCalibrationCell } from "./mc-calibration.js";
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
import type {
  AaveBorrowCurve,
  AaveRatesSample,
  AaveReserve,
  EmissionsSample,
  ForecastBindingCap,
  ForecastCell,
  ForecastDisclosureId,
  ForecastRefusal,
  ForecastUnpricedReason,
} from "./types.js";

/** The "borrow nothing" end of the slider: at HF 1,000 the LTV is under 0.1 %. */
export const MAX_ENTRY_HF = 1_000;
/** The lowest HF the route accepts as an input at all (below 1 the position is liquidatable at entry). */
export const MIN_ENTRY_HF = 1;

export interface ForecastInputs {
  pool: CuratedPool;
  setting: Setting;
  collateral: CollateralSymbol;
  rates: (AaveRatesSample & { stale: boolean }) | null;
  emissions: (EmissionsSample & { stale: boolean }) | null;
  volatility: VolatilityInputs;
  mcCalibration: Map<string, McCalibrationCell>;
  nowSeconds: number;
  /** The entry HF the user chose (the slider). */
  entryHf: number;
  /** The registry floor the slider cannot go under — packages/shared ENTRY_HF_FLOOR until A4 reads it from the registry. */
  entryHfFloor?: number;
  /** Deposit size in USD; null when the caller only wants the per-pool picture. */
  depositUsd: number | null;
  /** The collateral's USD price, for the liquidation price; null when the service has none. */
  collateralPriceUsd: number | null;
  /**
   * A CROSS-CHAIN position (BUILD-PLAN D6; `CROSSCHAIN-LOOP-2026-09-12.md` §6 item 1): the loan is on another
   * chain's venue — Kamino — so the rate it costs, the collateral parameters that size it and whether the pool
   * can fund it at all are that venue's. Only the LP slice stays Base's. Absent = an ordinary Base position.
   */
  venueBorrow?: ForecastVenueBorrow | null;
}

/**
 * The borrow side of a cross-chain position, as the yield service reads it from Kamino. It carries the POOL
 * STATE rather than a single answer, because each cell borrows a different amount: the rate after this cell's
 * own borrow is computed here, the same way Aave's is, instead of being taken on trust from the caller.
 */
export interface ForecastVenueBorrow {
  chain: "solana";
  venue: "kamino";
  /** The borrow APR at the pool right now. */
  borrowAprNowPct: number;
  /** What the collateral earns at that venue while it sits there. */
  supplyAprPct: number;
  liquidationThresholdBps: number;
  venueMaxLtvBps: number;
  /** Pool state in the loan token's own units, as decimal strings (they are bigints on the wire). */
  availableUnits: string;
  borrowedUnits: string;
  borrowLimitUnits: string;
  decimals: number;
  /** Kamino's piecewise-linear curve: (utilisation bps, APR bps). */
  borrowCurve: readonly (readonly [number, number])[];
  /** What the venue refuses whatever the amount — paused, stale oracle, out of band. */
  refusals: readonly ForecastRefusal[];
  stale: boolean;
}

/**
 * The borrow APR at the other venue after `borrowUsd` more is borrowed, or **null when that pool cannot fund
 * it** — which is the `pool_cannot_fund` refusal, not a rate. Null covers three ways Kamino says no: more than
 * the reserve has available, past its borrow limit, and a utilisation the curve cannot be read at.
 */
export function venueBorrowAprAfterPct(v: ForecastVenueBorrow, borrowUsd: number): number | null {
  const units = unitsOfUsd(borrowUsd, v.decimals);
  if (units < 0n) return null;
  const available = BigInt(v.availableUnits);
  const borrowed = BigInt(v.borrowedUnits);
  const limit = BigInt(v.borrowLimitUnits);
  if (units > available) return null;
  if (limit > 0n && borrowed + units > limit) return null;
  const supplied = available + borrowed;
  if (supplied <= 0n) return null;
  const utilizationBps = Number(((borrowed + units) * 10_000n) / supplied);
  return Math.round(kaminoCurveAprBps(v.borrowCurve, Math.min(10_000, utilizationBps)) * 100) / 10_000;
}

// ---------------------------------------------------------------------------
// The identity, and the venue curve
// ---------------------------------------------------------------------------

/** debt = collateral × LT ÷ HF  ⇒  LTV at entry = LT ÷ HF; drawdown to liquidation = 1 − 1 ÷ HF. */
export function hfIdentity(liquidationThresholdBps: number, entryHf: number): { ltvAtEntryBps: number; drawdownToLiquidationPct: number } {
  if (!(entryHf >= MIN_ENTRY_HF && Number.isFinite(entryHf))) throw new RangeError(`entryHf must be finite ≥ ${MIN_ENTRY_HF}, got ${entryHf}`);
  return {
    ltvAtEntryBps: Math.floor(liquidationThresholdBps / entryHf),
    drawdownToLiquidationPct: round2(100 * (1 - 1 / entryHf)),
  };
}

/**
 * Aave v3 (DefaultReserveInterestRateStrategyV2) variable borrow APR at a utilisation, percent:
 *   U ≤ Uopt: base + slope1 × U ÷ Uopt
 *   U > Uopt: base + slope1 + slope2 × (U − Uopt) ÷ (1 − Uopt)
 */
export function aaveVariableBorrowAprPct(curve: AaveBorrowCurve, utilizationBps: number): number {
  if (!(utilizationBps >= 0 && utilizationBps <= 10_000)) throw new RangeError(`utilization ${utilizationBps} bps out of [0, 10000]`);
  const { optimalUsageBps: uOpt, baseVariableBorrowRateBps: base, variableRateSlope1Bps: s1, variableRateSlope2Bps: s2 } = curve;
  const bps =
    utilizationBps <= uOpt
      ? base + (s1 * utilizationBps) / uOpt
      : base + s1 + (s2 * (utilizationBps - uOpt)) / (10_000 - uOpt);
  return Math.round(bps * 100) / 10_000; // bps → percent, 4 decimals
}

/** Units the borrow reserve can lend right now: totalAToken − totalVariableDebt (Aave's virtual balance to within the treasury accrual). */
export function availableUnits(reserve: AaveReserve): bigint {
  return BigInt(reserve.totalATokenUnits) - BigInt(reserve.totalVariableDebtUnits);
}

/**
 * The borrow APR after `extraBorrowUnits` more are borrowed: the debt rises by that amount, the
 * supplied total does not move, so U' = (D + Δ) ÷ S. Null when the pool cannot fund it (that is
 * the `pool_cannot_fund` refusal, not a rate).
 */
export function aaveBorrowAprAfterPct(curve: AaveBorrowCurve, reserve: AaveReserve, extraBorrowUnits: bigint): number | null {
  if (extraBorrowUnits < 0n) throw new RangeError("extraBorrowUnits must be ≥ 0");
  const supplied = BigInt(reserve.totalATokenUnits);
  const debt = BigInt(reserve.totalVariableDebtUnits) + extraBorrowUnits;
  if (supplied <= 0n || debt > supplied) return null;
  // Two decimals of a basis point are enough: the live word carries four decimals of a percent.
  const utilizationBps = Number((debt * 1_000_000n) / supplied) / 100;
  return aaveVariableBorrowAprPct(curve, utilizationBps);
}

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

function unitsOfUsd(usd: number, decimals: number): bigint {
  // Round to the unit; the reserve's decimals are read from chain (USDC: 6).
  return BigInt(Math.round(usd * 10 ** decimals));
}

export function evaluateForecast(input: ForecastInputs): ForecastCell {
  const { pool, setting, collateral, rates, emissions, volatility, mcCalibration, nowSeconds, entryHf, depositUsd, collateralPriceUsd } = input;
  const entryHfFloor = input.entryHfFloor ?? ENTRY_HF_FLOOR;
  if (!(entryHf >= MIN_ENTRY_HF && entryHf <= MAX_ENTRY_HF && Number.isFinite(entryHf))) {
    throw new RangeError(`entryHf must be in [${MIN_ENTRY_HF}, ${MAX_ENTRY_HF}], got ${entryHf}`);
  }
  if (depositUsd !== null && !(depositUsd > 0 && Number.isFinite(depositUsd))) throw new RangeError(`depositUsd must be > 0, got ${depositUsd}`);
  const rangeWidthBps = settingWidthBps(setting, pool.pairClass);
  const halfWidth = priceHalfWidth(rangeWidthBps);
  const refusals: ForecastRefusal[] = [];
  const disclosures = new Set<ForecastDisclosureId>(["forecast_not_advice", "borrow_rate_moves"]);

  const cell: ForecastCell = {
    poolId: pool.id,
    setting: setting.id,
    preset: setting.preset,
    collateral,
    rangeWidthBps,
    halfWidth,
    entryHf,
    entryHfFloor,
    liquidationThresholdBps: null,
    ltvAtEntryBps: null,
    venueMaxLtvBps: null,
    bindingCap: null,
    drawdownToLiquidationPct: round2(100 * (1 - 1 / entryHf)),
    collateralPriceUsd,
    liquidationPriceUsd: collateralPriceUsd === null ? null : round4(collateralPriceUsd / entryHf),
    depositUsd,
    borrowUsd: null,
    borrowAprNowPct: null,
    borrowAprAfterPct: null,
    userNetBorrowBasis: null,
    poolAvailableUsd: null,
    borrowVenue: null,
    collateralSupplyAprPct: null,
    lpPriced: false,
    lpUnpricedReason: null,
    emissionsGrossPct: null,
    emissionsNetPct: null,
    emissionsRealizedPct: null,
    dragPct: null,
    lpNetPct: null,
    mcLpNetPct: null,
    mcUnavailableReason: null,
    modelGapPts: null,
    sigma: null,
    breakEvenSigma: null,
    breakEvenEmissionsMultiple: null,
    userNetPct: null,
    mcUserNetPct: null,
    clearsBorrow: { closedForm: null, monteCarlo: null, both: null },
    refusals,
    allowed: false,
    disclosures: [],
  };

  // ---- 1. Safety: the floor, the registry, the venue's flags -----------------
  if (entryHf < entryHfFloor) refusals.push("entry_hf_below_floor");
  const asset = COLLATERAL_ASSETS[collateral];
  if (!asset || !asset.enabled) refusals.push("collateral_disabled");

  let reserve: AaveReserve | null = null;
  let borrowNow: number | null = null;
  let supply: number | null = null;
  const venue = input.venueBorrow ?? null;
  if (venue) {
    // Cross-chain: the loan is Kamino's. Base's own rates say nothing about what it costs, so their staleness
    // is not a refusal here — the venue's own is.
    cell.borrowVenue = venue.venue;
    for (const r of venue.refusals) refusals.push(r);
    if (venue.stale) refusals.push("rates_stale");
    borrowNow = venue.borrowAprNowPct;
    supply = venue.supplyAprPct;
    cell.borrowAprNowPct = borrowNow;
    cell.collateralSupplyAprPct = supply;
    cell.liquidationThresholdBps = venue.liquidationThresholdBps;
    cell.venueMaxLtvBps = venue.venueMaxLtvBps;
    const availUnits = BigInt(venue.availableUnits);
    cell.poolAvailableUsd = Number(availUnits) / 10 ** venue.decimals;
    disclosures.add("liquidation_at_chosen_hf");
  } else if (!rates) refusals.push("rates_unavailable");
  else if (rates.stale) refusals.push("rates_stale");
  else {
    const r = rates.collateral[collateral];
    if (!r || !r.usageAsCollateralEnabled || !r.isActive || r.isFrozen) refusals.push("collateral_not_active");
    else {
      reserve = r;
      if (r.isPaused) refusals.push("collateral_paused");
      if (rates.borrow.isPaused) refusals.push("borrow_paused");
      borrowNow = rates.borrow.variableBorrowAprPct;
      supply = r.supplyAprPct;
      cell.borrowAprNowPct = borrowNow;
      cell.collateralSupplyAprPct = supply;
      cell.liquidationThresholdBps = r.liquidationThresholdBps;
      cell.venueMaxLtvBps = r.ltvBps;
      const avail = availableUnits(rates.borrow);
      cell.poolAvailableUsd = Number(avail) / 10 ** rates.borrow.decimals;
      cell.borrowVenue = "aave";
      disclosures.add("liquidation_at_chosen_hf");
    }
  }

  // ---- 2. The position at the chosen HF ---------------------------------------
  let borrowAfter: number | null = null;
  const ltBps = venue ? venue.liquidationThresholdBps : (reserve?.liquidationThresholdBps ?? null);
  const maxLtvBps = venue ? venue.venueMaxLtvBps : (reserve?.ltvBps ?? null);
  if (ltBps !== null && maxLtvBps !== null && (venue !== null || (rates !== null && !rates.stale))) {
    const { ltvAtEntryBps } = hfIdentity(ltBps, entryHf);
    cell.ltvAtEntryBps = ltvAtEntryBps;
    let cap: ForecastBindingCap = entryHf === entryHfFloor ? "entry_hf_floor" : "chosen_hf";
    if (ltvAtEntryBps > maxLtvBps) {
      refusals.push("venue_ltv_exceeded");
      cap = "venue_max_ltv";
    }
    if (depositUsd !== null) {
      const borrowUsd = (depositUsd * ltvAtEntryBps) / 10_000;
      cell.borrowUsd = round2(borrowUsd);
      // Whose pool has to fund it: Kamino's for a cross-chain position, Aave's otherwise. Either way a pool
      // that cannot is a REFUSAL, never a priced cell with an optimistic rate.
      const after = venue
        ? venueBorrowAprAfterPct(venue, borrowUsd)
        : aaveBorrowAprAfterPct(rates!.borrowCurve, rates!.borrow, unitsOfUsd(borrowUsd, rates!.borrow.decimals));
      if (after === null) {
        refusals.push("pool_cannot_fund");
        cap = "pool_liquidity";
      } else borrowAfter = after;
    }
    cell.bindingCap = cap;
    cell.borrowAprAfterPct = borrowAfter;
  }

  // ---- 3. The LP slice: priced whenever emissions and σ exist -----------------
  const unpriced = (reason: ForecastUnpricedReason): ForecastCell => {
    cell.lpUnpricedReason = reason;
    disclosures.add("no_forecast");
    return finish(cell, refusals, disclosures);
  };
  if (!emissions) return unpriced("emissions_unavailable");
  if (emissions.stale) return unpriced("emissions_stale");
  let rewardRate: bigint;
  try {
    rewardRate = BigInt(emissions.rewardRateWeiPerSec);
  } catch {
    return unpriced("emissions_unavailable");
  }
  const epochActive = emissions.epochActive && rewardRate > 0n && emissions.periodFinish > nowSeconds;
  let gross = 0;
  if (epochActive) {
    if (emissions.outlier) return unpriced("staked_liquidity_outlier");
    if (emissions.corroborated !== true || !(emissions.samples >= MIN_GATE_STAKED_SAMPLES)) return unpriced("insufficient_samples");
    const table = emissions.aprByWidthPct;
    const g = table && Object.hasOwn(table, String(rangeWidthBps)) ? table[String(rangeWidthBps)] : undefined;
    if (g === undefined || g === null || !Number.isFinite(g)) return unpriced("no_staked_liquidity");
    if (g > MAX_EMISSIONS_APR_PCT) {
      cell.emissionsGrossPct = round2(g);
      return unpriced("emissions_implausible");
    }
    gross = g;
    disclosures.add("emissions_dilutable");
  }
  // A gauge paying nothing is a priced cell: the LP slice is the drag alone.
  const net = gross * keepFactor(pool.protocol);
  cell.emissionsGrossPct = round2(gross);
  cell.emissionsNetPct = round2(net);

  const vol = volatility.pools[pool.id];
  if (!vol) return unpriced("no_volatility_input");
  const drag = dragPct(vol.sigma, halfWidth);
  const realized = realizedEmissionsPct(net, vol.sigma, halfWidth);
  const lpNet = lpNetPct(net, vol.sigma, halfWidth);
  if (!Number.isFinite(lpNet) || Math.abs(lpNet) > MAX_ABS_NET_PCT) return unpriced("net_out_of_bounds");
  cell.sigma = vol.sigma;
  cell.dragPct = round2(drag);
  cell.emissionsRealizedPct = round2(realized);
  cell.lpNetPct = round2(lpNet);
  cell.lpPriced = true;
  disclosures.add("impermanent_loss");
  disclosures.add("model_uncertainty");

  const mc = applyMcCalibration({
    index: mcCalibration,
    poolId: pool.id,
    setting: setting.id,
    rangeWidthBps,
    sigma: vol.sigma,
    liveFeeBps: emissions.feePips / 100,
    emissionsNetPct: net,
  });
  const mcNet = mc.ok ? mc.mcLpNetPct : null;
  cell.mcLpNetPct = mcNet === null ? null : round2(mcNet);
  cell.mcUnavailableReason = mc.ok ? null : mc.reason;
  cell.modelGapPts = mcNet === null ? null : round2(lpNet - mcNet);

  // ---- 4. Against the borrow it is funded with --------------------------------
  const borrowForUser = borrowAfter ?? borrowNow;
  if (borrowNow !== null) {
    const be = breakEvenSigma(net, borrowNow, halfWidth);
    const bem = breakEvenEmissionsMultiple(net, borrowNow, vol.sigma, halfWidth);
    cell.breakEvenSigma = be === null ? null : round2(be);
    cell.breakEvenEmissionsMultiple = bem === null ? null : round2(bem);
    const closed = lpNet > borrowNow;
    const monte = mcNet === null ? null : mcNet > borrowNow;
    cell.clearsBorrow = { closedForm: closed, monteCarlo: monte, both: monte === null ? null : closed && monte };
  }
  if (borrowForUser !== null && supply !== null && cell.ltvAtEntryBps !== null) {
    cell.userNetBorrowBasis = borrowAfter !== null ? "after" : "now";
    cell.userNetPct = round2(userNetPct(supply, cell.ltvAtEntryBps, lpNet, borrowForUser));
    cell.mcUserNetPct = mcNet === null ? null : round2(userNetPct(supply, cell.ltvAtEntryBps, mcNet, borrowForUser));
  }
  return finish(cell, refusals, disclosures);
}

function finish(cell: ForecastCell, refusals: ForecastRefusal[], disclosures: Set<ForecastDisclosureId>): ForecastCell {
  cell.refusals = [...new Set(refusals)];
  cell.allowed = cell.refusals.length === 0;
  cell.disclosures = [...disclosures];
  return cell;
}

function round4(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 10_000) / 10_000 : x;
}

/** Every cell for one pool: every setting × every registry collateral, at one entry HF. */
export function evaluateForecastPool(
  pool: CuratedPool,
  collaterals: readonly CollateralSymbol[],
  ctx: Omit<ForecastInputs, "pool" | "setting" | "collateral">
): ForecastCell[] {
  const out: ForecastCell[] = [];
  for (const setting of SETTINGS) {
    for (const collateral of collaterals) {
      out.push(evaluateForecast({ ...ctx, pool, setting, collateral }));
    }
  }
  return out;
}
