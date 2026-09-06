/**
 * The yield gate — pure, deterministic, fail-closed.
 *
 *   qualifies(pool, setting, collateral) ⇔
 *        lpNet(emissionsNet(w), σ, w) > aaveUsdcBorrowApr        (closed form)
 *    AND mcLpNet(emissionsNet(w), pool, setting) > aaveUsdcBorrowApr  (MC-calibrated)
 *
 * with lpNet = realized emissions on the drag-shrunk base + drag (src/model.ts).
 * The SECOND inequality is the boundary guard (audit wave 1 lens D HIGH-1):
 * the closed form ignores time out of range and is 7–32 points optimistic AT
 * THE GATE BOUNDARY — wider than the borrow rate it is compared against — so
 * deciding on it alone can offer a pool the product's own Monte Carlo says
 * loses money. Inside the band where the two forms disagree the gate refuses
 * with `within_model_uncertainty`; see src/mc-calibration.ts for why two
 * calibrated coefficients price the cell exactly at every emissions level.
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
import type { AaveRatesSample, EmissionsSample, GateReason, GateUserNet, GateVerdict } from "./types.js";

export interface GateInputs {
  pool: CuratedPool;
  setting: Setting;
  collateral: CollateralSymbol;
  /** null = never sampled. `stale` is the SERVE-TIME flag. */
  rates: (AaveRatesSample & { stale: boolean }) | null;
  emissions: (EmissionsSample & { stale: boolean }) | null;
  volatility: VolatilityInputs;
  /**
   * `${poolId} ${settingId}` → the Monte-Carlo calibration for that cell
   * (src/mc-calibration.ts `calibrationIndex`). An EMPTY index refuses every
   * cell with `mc_calibration_unavailable` — required, never defaulted, so no
   * call site can offer a pool without the boundary guard.
   */
  mcCalibration: Map<string, McCalibrationCell>;
  /** Unix seconds "now" — epochActive is re-derived from periodFinish. */
  nowSeconds: number;
}

/**
 * Max |user net| / |lpNet| the gate will ever OFFER, percent.
 *
 * This is a REFUSAL bound, not a clamp. It used to clamp `userNetPct` while
 * leaving `lpNetPct` untouched and setting no flag, so the payload stopped
 * satisfying its own published formula (`userNet = supply + LTV × (lpNet −
 * borrow)`) while still reporting `qualifies:true` — a consumer recomputing
 * the headline from the numbers printed beside it got a different answer
 * (wave-1 lens D MED-3: served 2000 % against an arithmetic 2694.26 %). A
 * number this far outside anything real is a broken input, not a yield.
 */
export const MAX_ABS_NET_PCT = 2_000;

/**
 * Upper plausibility bound on the GROSS in-range emissions APR at the served
 * width, percent. The borrow side of the same inequality has had a hard bound
 * since the beginning (`aave.ts` refuses any rate above 1 ray); the emissions
 * side had none at all, so 174,083 % passed the gate (wave-1 lens D MED-4).
 * The marginal in-range APR on a thinly-staked gauge is genuinely enormous
 * AND instantly dilutable by anyone else staking — quoting it as an offerable
 * yield is misleading even when the reading is correct.
 */
export const MAX_EMISSIONS_APR_PCT = 1_000;

/**
 * Independent stakedLiquidity readings required before the pool's APR is
 * trusted. Mirrors MIN_STAKED_SAMPLES in sources/gauges.ts; the gate enforces
 * it again because a sample can also arrive from a persisted file.
 */
export const MIN_GATE_STAKED_SAMPLES = 3;

function refuse(
  base: Omit<GateVerdict, "qualifies" | "reason">,
  reason: GateReason
): GateVerdict {
  return { ...base, qualifies: false, reason };
}

export function evaluateGate(input: GateInputs): GateVerdict {
  const { pool, setting, collateral, rates, emissions, volatility, mcCalibration, nowSeconds } = input;
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
    mcLpNetPct: null,
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
  // A guardian pause is a SEPARATE flag from active/frozen: during a pause the
  // reserve still quotes a rate and still reads as active, but every supply
  // and borrow reverts on chain. Offering it means the UI says "this earns
  // money" and the user's transaction fails (wave-1 lens D LOW-1).
  if (reserve.isPaused) return refuse(base, "collateral_paused");
  if (rates.borrow.isPaused) return refuse(base, "borrow_paused");
  const borrow = rates.borrow.variableBorrowAprPct;
  const supply = reserve.supplyAprPct;
  const withRates = { ...base, borrowAprPct: borrow, collateralSupplyAprPct: supply };

  // 3. Emissions must exist, be fresh, active, sane.
  if (!emissions) return refuse(withRates, "emissions_unavailable");
  if (emissions.stale) return refuse(withRates, "emissions_stale");
  // A malformed rewardRate must refuse THIS pool, not throw out of the gate:
  // the caller turns an escaped throw into one 500 for every pool, which
  // contradicts "any missing input yields qualifies:false with a reason"
  // (wave-1 lens D LOW-5). Not reachable from the service's own producer.
  let rewardRate: bigint;
  try {
    rewardRate = BigInt(emissions.rewardRateWeiPerSec);
  } catch {
    return refuse(withRates, "emissions_unavailable");
  }
  const epochActive = emissions.epochActive && rewardRate > 0n && emissions.periodFinish > nowSeconds;
  if (!epochActive) return refuse({ ...withRates, emissionsGrossPct: 0, emissionsNetPct: 0 }, "no_emissions");
  if (emissions.outlier) return refuse(withRates, "staked_liquidity_outlier");
  // An anchor nobody corroborated is not an anchor. Until enough independent
  // readings agree, a single anomalous stakedLiquidity is indistinguishable
  // from the truth and the APR built on it is a fabrication (lens D HIGH-2).
  if (emissions.corroborated !== true || !(emissions.samples >= MIN_GATE_STAKED_SAMPLES)) {
    return refuse(withRates, "insufficient_samples");
  }
  // OWN property only: an object-literal lookup resolves prototype keys like
  // "__proto__"/"constructor" to garbage (server.ts uses a Map for the same
  // hazard) — wave-1 lens D LOW-10.
  const table = emissions.aprByWidthPct;
  const gross = table && Object.hasOwn(table, String(rangeWidthBps)) ? table[String(rangeWidthBps)] : undefined;
  if (gross === undefined || gross === null || !Number.isFinite(gross)) {
    return refuse(withRates, "no_staked_liquidity");
  }
  if (gross > MAX_EMISSIONS_APR_PCT) {
    return refuse({ ...withRates, emissionsGrossPct: round2(gross) }, "emissions_implausible");
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
  // userNet is reported EXACTLY as its published formula produces it — the
  // ±MAX_ABS_NET_PCT bound below is a refusal, never a silent clamp.
  const userNet: GateUserNet[] = ltvPresets(reserve.liquidationThresholdBps).map((p) => ({
    ltvBps: p.ltvBps,
    offerable: p.offerable,
    userNetPct: round2(userNetPct(supply, p.ltvBps, lpNet, borrow)),
  }));

  // 6. The Monte-Carlo calibration of the SAME cell (src/mc-calibration.ts).
  //    The closed form ignores time out of range; at the boundary that is
  //    worth more than the borrow rate being tested, so both must clear.
  const mc = applyMcCalibration({
    index: mcCalibration,
    poolId: pool.id,
    setting: setting.id,
    rangeWidthBps,
    sigma: vol.sigma,
    liveFeeBps: emissions.feePips / 100,
    emissionsNetPct: net,
  });
  const full = {
    ...withEmissions,
    emissionsRealizedPct: round2(realized),
    dragPct: round2(drag),
    lpNetPct: round2(lpNet),
    mcLpNetPct: mc.ok ? round2(mc.mcLpNetPct) : null,
    sigma: vol.sigma,
    breakEvenSigma: be === null ? null : round2(be),
    breakEvenEmissionsMultiple: bem === null ? null : round2(bem),
    userNet,
  };

  // 7. The gate itself.
  if (!(lpNet > borrow)) return refuse(full, "net_below_borrow");
  if (!mc.ok) return refuse(full, mc.reason);
  if (!(mc.mcLpNetPct > borrow)) return refuse(full, "within_model_uncertainty");
  // 8. An outcome outside the absolute bound is a broken input, not a yield.
  if (!withinBound(lpNet) || userNet.some((u) => !withinBound(u.userNetPct))) {
    return refuse(full, "net_out_of_bounds");
  }
  return { ...full, qualifies: true, reason: null };
}

function withinBound(x: number): boolean {
  return Number.isFinite(x) && Math.abs(x) <= MAX_ABS_NET_PCT;
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
