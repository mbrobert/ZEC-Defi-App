/**
 * The yield model, in one place (the gate, the sample generator, the Python
 * Monte Carlo and the web pin all read these formulas):
 *
 *   Width. A Snuggle/Slipstream position of TOTAL tick span `bps` has price
 *   bounds P·1.0001^(±bps/2). The model prices it as a symmetric ±w range
 *   with the exact upper half-width
 *       w = 1.0001^(bps/2) − 1         (audit FACT 3: 4500 → ±25.23 %)
 *   — never the linear bps/200 approximation, which is 2.7 points short at
 *   the Conservative preset.
 *
 *   Concentration. A position of liquidity L on [P(1−w), P(1+w)] is worth
 *   L·√P·f(w) in token1 units with
 *       f(w) = 2 − √(1−w) − 1/√(1+w)
 *   (re-derived from the v3 amount formulas; an unbounded (0, ∞) range
 *   would give f = 2, which the symmetric ±w form approaches as w → 1 only
 *   on the lower side — full range is not a special case of this model).
 *
 *   Emissions (sources/gauges.ts). The gauge streams rewardRate AERO/s to
 *   staked in-range liquidity, so a new position of width w earns
 *       APR(w) = rewardRate·yr·AERO$ ÷ V_staked(w),
 *       V_staked(w) = stakedLiquidity·√P·f(w) / 10^dec1 · token1$.
 *
 *   Fees. Emissions are GROSS. Engine-routed pools pay the engine's
 *   performance fee at harvest, then Oilskin's (packages/shared FEES) —
 *   keep = (1 − engine)(1 − perf) = 0.765 today; DIRECT pools keep
 *   (1 − perf). Nothing else is charged (no fee on principal, ever).
 *
 *   IL + rebalance drag. Zero-drift GBM at annualized σ, re-centered after
 *   the preset's rebalance delay. The continuous drag RATE of a concentrated
 *   position is the standard "LP is short volatility" result scaled by its
 *   concentration:
 *       x = σ² / (4·f(w))            (an unbounded range: f = 2 → σ²/8)
 *   so a position with no emissions ends the year at e^{−x} of its value:
 *       drag(σ, w) = −100 · (1 − e^{−x}).
 *
 *   Combining. Emissions accrue on the position's CURRENT value, which the
 *   drag is shrinking, so the year's realized emissions are
 *       r · ∫₀¹ e^{−x·t} dt = r · (1 − e^{−x}) / x       (r = net in-range rate)
 *   and the LP slice ends the year at
 *       lpNet = (1 − e^{−x}) · (r / x − 1).
 *   This reproduces the Monte Carlo (scripts/lp-sim.py) to ~0.1 pt at the
 *   Conservative/Moderate presets and within ~4.4 pt at Aggressive AT TODAY'S
 *   DEEPLY-NEGATIVE EMISSIONS. That number is not the model's accuracy where
 *   the decision is made: the error ignores time out of range, so it scales
 *   with the emissions level and reaches +7 to +32 pt at the gate boundary —
 *   wider than the borrow rate being tested. The gate therefore does NOT
 *   decide on this form alone; see src/mc-calibration.ts for the second,
 *   Monte-Carlo-calibrated number it must also clear.
 *   The additive shortcut r + drag is NOT used: at tight widths it overstates
 *   the outcome by >100 pt. The sim re-validates every cell on every run.
 *
 *   Note r/x is width-independent (both ∝ 1/f(w)): the SIGN of lpNet is the
 *   same at every width for a given pool — a pool that loses at one width
 *   loses at all of them, and vice versa; width only scales the magnitude.
 *
 *   Gate. A pool is offered at a setting only when lpNet AND the
 *   MC-calibrated mcLpNet (src/mc-calibration.ts) both exceed the LIVE Aave
 *   USDC variable borrow APR. User net on the whole collateral position
 *   = collateral supply APR + LTV × (lpNet − borrow).
 */

import { FEES, RANGE_PRESETS, type NamedRangePreset, type PairClass } from "@zyo/shared";

export const SECONDS_PER_YEAR = 31_536_000;

/**
 * Snuggle/MaxFi engine performance fee on harvested rewards, bps. External
 * protocol parameter (not ours, not derived): verified from the deployed
 * contracts 2026-08-13 (docs/FEEDBACK-ANSWERS.md §2) and observed as
 * PerformanceFeeCollected at every harvest in the 2026-08-27 and 2026-09-03
 * log sweeps. Applies to engine-routed pools only.
 */
export const ENGINE_FEE_BPS = 1500;

/** Exact price half-width (fraction) of a TOTAL tick span in bps. */
export function priceHalfWidth(rangeWidthBps: number): number {
  if (!(Number.isFinite(rangeWidthBps) && rangeWidthBps > 0)) {
    throw new RangeError(`rangeWidthBps must be a positive number, got ${rangeWidthBps}`);
  }
  return Math.exp((rangeWidthBps * Math.log(1.0001)) / 2) - 1;
}

/** f(w) = 2 − √(1−w) − 1/√(1+w), w ∈ (0, 1). */
export function widthBracket(w: number): number {
  if (!(w > 0 && w < 1)) throw new RangeError(`half-width must be in (0,1), got ${w}`);
  return 2 - Math.sqrt(1 - w) - 1 / Math.sqrt(1 + w);
}

/** Fraction of gross emissions a user keeps after every performance fee on the path. */
export function keepFactor(protocol: string): number {
  const oilskin = 1 - FEES.performanceBps / 10_000;
  return protocol === "DIRECT" ? oilskin : (1 - ENGINE_FEE_BPS / 10_000) * oilskin;
}

/**
 * Gross in-range emissions APR (percent) for a staked position of half-width
 * w, from raw chain words. Returns null when there is no staked liquidity to
 * share with (a fresh gauge): a division by zero is never an APR.
 */
export function emissionsAprPct(input: {
  rewardRateWeiPerSec: bigint;
  aeroUsd: number;
  stakedLiquidity: number; // Number(uint128) — relative precision only, see gauges.ts
  sqrtPriceX96: bigint;
  token1Decimals: number;
  token1Usd: number;
  halfWidth: number;
}): number | null {
  const { rewardRateWeiPerSec, aeroUsd, stakedLiquidity, sqrtPriceX96, token1Decimals, token1Usd, halfWidth } = input;
  if (!(aeroUsd > 0) || !(token1Usd > 0)) throw new RangeError("emissionsAprPct: prices must be > 0");
  if (rewardRateWeiPerSec === 0n) return 0;
  if (!(stakedLiquidity > 0)) return null;
  const usdPerYear = (Number(rewardRateWeiPerSec) / 1e18) * SECONDS_PER_YEAR * aeroUsd;
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const vStakedUsd = ((stakedLiquidity * sqrtP * widthBracket(halfWidth)) / 10 ** token1Decimals) * token1Usd;
  return vStakedUsd > 0 ? (usdPerYear / vStakedUsd) * 100 : null;
}

/** Continuous drag rate x = σ² / (4·f(w)), per year. */
export function dragRate(sigma: number, halfWidth: number): number {
  if (!(sigma >= 0 && Number.isFinite(sigma))) throw new RangeError(`sigma must be finite ≥ 0, got ${sigma}`);
  return (sigma * sigma) / (4 * widthBracket(halfWidth));
}

/** Closed-form IL + rebalance drag with no emissions, percent (≤ 0). */
export function dragPct(sigma: number, halfWidth: number): number {
  return -100 * (1 - Math.exp(-dragRate(sigma, halfWidth)));
}

/** Net in-range emissions rate r earned on the decaying base over one year, percent. */
export function realizedEmissionsPct(emissionsNetPct: number, sigma: number, halfWidth: number): number {
  const x = dragRate(sigma, halfWidth);
  return x === 0 ? emissionsNetPct : (emissionsNetPct * (1 - Math.exp(-x))) / x;
}

/** LP slice outcome over one year: realized emissions + drag, percent. */
export function lpNetPct(emissionsNetPct: number, sigma: number, halfWidth: number): number {
  return realizedEmissionsPct(emissionsNetPct, sigma, halfWidth) + dragPct(sigma, halfWidth);
}

/**
 * The σ at which lpNet(σ) == borrow (lpNet is decreasing in σ). Null when
 * emissions do not clear the borrow even at σ = 0.
 */
export function breakEvenSigma(emissionsNetPct: number, borrowAprPct: number, halfWidth: number): number | null {
  if (!(emissionsNetPct > borrowAprPct)) return null;
  let lo = 0;
  let hi = 5; // 500 % annualized — beyond any asset we would list
  if (lpNetPct(emissionsNetPct, hi, halfWidth) > borrowAprPct) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (lpNetPct(emissionsNetPct, mid, halfWidth) > borrowAprPct) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * How many times today's net emissions the pool would need (at today's σ)
 * for lpNet to reach the borrow: m = (b/(1−e^{−x}) + 1) · x / r (b, r as
 * fractions). Null when r ≤ 0.
 */
export function breakEvenEmissionsMultiple(
  emissionsNetPct: number,
  borrowAprPct: number,
  sigma: number,
  halfWidth: number
): number | null {
  if (!(emissionsNetPct > 0)) return null;
  const x = dragRate(sigma, halfWidth);
  if (x === 0) return borrowAprPct / emissionsNetPct;
  // fractions throughout: r_needed = x·(b/(1−e^{−x}) + 1); m = r_needed / r_today
  return (((borrowAprPct / 100) / (1 - Math.exp(-x)) + 1) * x) / (emissionsNetPct / 100);
}

/** Whole-collateral-position net, percent. */
export function userNetPct(collateralSupplyAprPct: number, ltvBps: number, lpNetPct: number, borrowAprPct: number): number {
  return collateralSupplyAprPct + (ltvBps / 10_000) * (lpNetPct - borrowAprPct);
}

// ---------------------------------------------------------------------------
// Settings: the three product settings ARE the three shared range presets.
// Width and delay come from @zyo/shared RANGE_PRESETS per pair class.
// ---------------------------------------------------------------------------

export type SettingId = "sheltered" | "steady" | "working";

export interface Setting {
  id: SettingId;
  preset: NamedRangePreset;
  rebalanceDelayHours: number;
}

export const SETTINGS: readonly Setting[] = Object.freeze(
  (
    [
      ["sheltered", "CONSERVATIVE"],
      ["steady", "MODERATE"],
      ["working", "AGGRESSIVE"],
    ] as const
  ).map(([id, preset]) => {
    const def = RANGE_PRESETS.find((p) => p.preset === preset);
    if (!def) throw new Error(`shared RANGE_PRESETS lacks ${preset}`);
    return { id, preset, rebalanceDelayHours: def.defaultRebalanceDelayHours };
  })
);

export function settingWidthBps(setting: Setting, pairClass: PairClass): number {
  const def = RANGE_PRESETS.find((p) => p.preset === setting.preset)!;
  return def.rangeWidthBps[pairClass];
}

/** Every width the service quotes emissions at, as TOTAL bps (both pair classes). */
export function modelWidthsBps(): number[] {
  const set = new Set<number>();
  for (const p of RANGE_PRESETS) {
    set.add(p.rangeWidthBps.UNCORRELATED);
    set.add(p.rangeWidthBps.CORRELATED);
  }
  return [...set].sort((a, b) => b - a);
}

export function round2(x: number): number {
  return Number.isFinite(x) ? Math.round(x * 100) / 100 : x;
}
