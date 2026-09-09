/**
 * Money math for the wizard, review and dashboard. PURE — no I/O, no React.
 *
 * Every input that is a risk parameter (liquidation threshold, borrow rate,
 * emissions, IL drag) arrives as an argument that was READ from chain or from
 * the yield gate. Nothing in this file types an LTV, HF, fee or ±.
 * Ladder rungs and fee bps come from @zyo/shared.
 */
import {
  BPS_DENOMINATOR,
  FEES,
  HF_LADDER,
  entryHfForLtv,
  liquidationDropPct,
  rungDropPct,
  rungFor,
  type HfRung,
} from "@zyo/shared";

export const RAY = 10n ** 27n;
export const WAD = 10n ** 18n;
/** Aave's base currency on Base is USD with 8 decimals (BASE_CURRENCY_UNIT = 1e8). */
export const AAVE_BASE_UNIT = 10n ** 8n;

/** Aave ray-scaled rate → percent APR (e.g. 0.04828e27 → 4.828). */
export function rayToAprPct(rateRay: bigint): number {
  // 1e27 ray → fraction; ×100 → percent. Keep 6 decimals of precision.
  return Number((rateRay * 100_000_000n) / RAY) / 1_000_000;
}

/** Aave 1e18-scaled health factor → number; type(uint256).max (no debt) → +Infinity. */
export function wadHealthFactor(hfWad: bigint): number {
  if (hfWad >= 2n ** 255n) return Number.POSITIVE_INFINITY;
  return Number((hfWad * 10_000n) / WAD) / 10_000;
}

/** Aave base-currency amount (8 dp USD) → USD number, full precision. */
export function baseUnitsToUsd(amount: bigint): number {
  return fromAtomic(amount, 8);
}

/** Token atomic amount → human number using its decimals. Precision-safe for UI display. */
export function fromAtomic(amount: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const frac = amount % scale;
  return Number(whole) + Number(frac) / Number(scale);
}

/** Human decimal string → atomic bigint. Throws on malformed input. */
export function toAtomic(value: string | number, decimals: number): bigint {
  const s = String(value).trim();
  if (!/^\d*(\.\d*)?$/.test(s) || s === "" || s === ".") throw new RangeError(`Not a decimal amount: ${s}`);
  const [w = "0", f = ""] = s.split(".");
  const frac = (f + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export interface LoanPlanInput {
  /** Collateral amount, human units. */
  collateralAmount: number;
  /** Collateral USD price (Chainlink / Aave oracle). */
  collateralPriceUsd: number;
  /** Venue liquidation threshold for this asset, bps, READ FROM CHAIN. */
  liquidationThresholdBps: number;
  /** User-chosen LTV, bps (must already be an offerable preset). */
  ltvBps: number;
  /** Live USDC variable borrow APR, percent. */
  borrowAprPct: number;
}

export interface LoanPlan {
  collateralUsd: number;
  borrowUsdc: number;
  entryHf: number;
  /** Collateral price at which HF = 1.0. */
  liquidationPriceUsd: number;
  liquidationDropPct: number;
  /** Ladder rungs with the collateral price at which each fires. */
  rungs: { rung: HfRung; priceUsd: number; dropPct: number }[];
  /** Interest owed per year at today's rate. */
  borrowCostUsdPerYear: number;
}

export function planLoan(i: LoanPlanInput): LoanPlan {
  const collateralUsd = i.collateralAmount * i.collateralPriceUsd;
  const borrowUsdc = (collateralUsd * i.ltvBps) / BPS_DENOMINATOR;
  const entryHf = entryHfForLtv(i.liquidationThresholdBps, i.ltvBps);
  const drop = liquidationDropPct(i.liquidationThresholdBps, i.ltvBps);
  const liquidationPriceUsd = i.ltvBps === 0 ? 0 : i.collateralPriceUsd * (1 - drop / 100);
  const rungs = HF_LADDER.map((rung) => {
    const dropPct = rungDropPct(rung, i.liquidationThresholdBps, i.ltvBps);
    return { rung, dropPct, priceUsd: i.collateralPriceUsd * (1 - dropPct / 100) };
  });
  return {
    collateralUsd,
    borrowUsdc,
    entryHf,
    liquidationPriceUsd,
    liquidationDropPct: drop,
    rungs,
    borrowCostUsdPerYear: (borrowUsdc * i.borrowAprPct) / 100,
  };
}

export interface YieldPlanInput {
  borrowUsdc: number;
  collateralUsd: number;
  /** Live USDC variable borrow APR, percent. */
  borrowAprPct: number;
  /** Collateral supply APR on Aave, percent (earned on the whole collateral). */
  supplyAprPct: number;
  /** Served by the gate for the chosen pool × setting (percent on the deployed USDC). */
  emissionsGrossPct: number;
  emissionsNetPct: number;
  emissionsRealizedPct: number;
  dragPct: number;
  lpNetPct: number;
  /** Engine fee the model applied (bps); null when unknown → engine share folded into "fees". */
  engineFeeBps: number | null;
}

export interface YieldPlan {
  /** All USD per year on the deployed USDC unless stated. */
  grossEmissionsUsd: number;
  engineFeeUsd: number;
  oilskinFeeUsd: number;
  netEmissionsUsd: number;
  realizedEmissionsUsd: number;
  dragUsd: number;
  lpNetUsd: number;
  borrowCostUsd: number;
  /** Supply interest on the whole collateral. */
  supplyInterestUsd: number;
  totalUsd: number;
  lpNetPct: number;
  /** supply + LTV × (lpNet − borrow): the model's userNet, percent on the collateral. */
  userNetPct: number;
}

/**
 * Mirrors the yield model (services/yield/src/model.ts): the served numbers
 * are percentages on the deployed USDC; the engine's cut and Oilskin's
 * performance fee are already inside `emissionsNetPct` (keep = (1−engine)(1−perf)).
 * Fees are split back out for display only: oilskin = net/(1−perf) × perf,
 * engine = gross − net − oilskin. Nothing here is a projection input.
 */
export function planYield(i: YieldPlanInput): YieldPlan {
  const perf = FEES.performanceBps / BPS_DENOMINATOR;
  const on = (pct: number) => (i.borrowUsdc * pct) / 100;
  const grossEmissionsUsd = on(i.emissionsGrossPct);
  const netEmissionsUsd = on(i.emissionsNetPct);
  const oilskinFeeUsd = perf < 1 ? (netEmissionsUsd / (1 - perf)) * perf : 0;
  const engineFeeUsd = Math.max(0, grossEmissionsUsd - netEmissionsUsd - oilskinFeeUsd);
  const realizedEmissionsUsd = on(i.emissionsRealizedPct);
  const dragUsd = on(i.dragPct);
  const lpNetUsd = on(i.lpNetPct);
  const borrowCostUsd = on(i.borrowAprPct);
  const supplyInterestUsd = (i.collateralUsd * i.supplyAprPct) / 100;
  const totalUsd = supplyInterestUsd + lpNetUsd - borrowCostUsd;
  return {
    grossEmissionsUsd,
    engineFeeUsd,
    oilskinFeeUsd,
    netEmissionsUsd,
    realizedEmissionsUsd,
    dragUsd,
    lpNetUsd,
    borrowCostUsd,
    supplyInterestUsd,
    totalUsd,
    lpNetPct: i.lpNetPct,
    userNetPct: i.collateralUsd > 0 ? (totalUsd / i.collateralUsd) * 100 : 0,
  };
}

/**
 * The gate rule as served, re-derived so the UI never trusts a `qualifies`
 * flag it cannot verify from the same numbers.
 *
 * BOTH prices of the same LP slice must beat the live borrow rate: the
 * published closed form (`lpNetPct`) and the Monte-Carlo-calibrated form
 * (`mcLpNetPct`), which also charges the time the position spends OUT of
 * range. The closed form is 0.2 to 32 points optimistic at the boundary, so
 * "one of them clears" is not a reason to offer anything. Unreadable inputs —
 * including a MISSING calibration — never clear: a cell priced once is a cell
 * we do not offer.
 */
export function clearsGate(lpNetPct: number | null, borrowAprPct: number | null, mcLpNetPct: number | null = null): boolean {
  const beats = (x: number | null) => x !== null && Number.isFinite(x) && borrowAprPct !== null && Number.isFinite(borrowAprPct) && x > borrowAprPct;
  return beats(lpNetPct) && beats(mcLpNetPct);
}

/** Exact price half-width of a TOTAL tick span, percent: 1.0001^(bps/2) − 1 (4500 → 25.23, 1500 → 7.79). */
export function exactHalfWidthPct(rangeWidthBps: number): number {
  if (!(Number.isFinite(rangeWidthBps) && rangeWidthBps > 0)) throw new RangeError(`rangeWidthBps must be positive, got ${rangeWidthBps}`);
  return (Math.exp((rangeWidthBps * Math.log(1.0001)) / 2) - 1) * 100;
}

/** "±7.79%" / "±25.2%" from a TOTAL tick span, using the exact conversion the model prices at. */
export function fmtHalfWidth(rangeWidthBps: number): string {
  const h = exactHalfWidthPct(rangeWidthBps);
  return `±${h.toFixed(h < 10 ? 2 : 1)}%`;
}

/** Health-factor label for a chip, from the shared ladder (null rung = healthy). */
export function hfBand(hf: number | null): { rung: HfRung | null; label: string; kind: "good" | "warn" | "crit" } {
  // `null` = the account read failed or has not resolved. It used to be substituted with +∞ and
  // rendered "No debt" (audit wave 2, N-MED-2); an unreadable health factor is a warning, not a
  // green tile.
  if (hf === null) return { rung: null, label: "Unreadable", kind: "warn" };
  // rungFor throws on NaN/negative (fail closed) and treats +Infinity as healthy.
  const rung = rungFor(hf);
  if (hf === Number.POSITIVE_INFINITY) return { rung: null, label: "No debt", kind: "good" };
  if (!rung) return { rung: null, label: "Healthy", kind: "good" };
  return { rung, label: rung.label, kind: rung.severity >= 3 ? "crit" : "warn" };
}

/** Current LTV from account data (debt / collateral), bps. 0 when no collateral. */
/**
 * The health factor of a live account read, or `null` when it cannot be known: no account, or
 * the Aave `getUserAccountData` leg of the read failed or, with the venue-aware read, any venue the
 * registry names could not be read. Never +∞ for "unknown" — +∞ means "no debt", which is a
 * different, reassuring statement (audit wave 2, N-MED-2).
 */
export function accountHf(
  account: { aave: { healthFactor: number } | null; venues?: { healthFactor: number | null } | null } | null | undefined,
): number | null {
  if (!account) return null;
  if (account.venues) {
    // Venue-aware read (audit wave 2, M-HIGH-2): the WORST venue the registry names, already
    // cross-checked against the Aave leg in lib/reads.ts. null there means unreadable, and stays null.
    const hf = account.venues.healthFactor;
    return typeof hf === "number" && !Number.isNaN(hf) ? hf : null;
  }
  if (!account.aave) return null;
  const hf = account.aave.healthFactor;
  return typeof hf === "number" && !Number.isNaN(hf) ? hf : null;
}

export function currentLtvBps(collateralUsd: number, debtUsd: number): number {
  if (collateralUsd <= 0) return 0;
  return Math.round((debtUsd / collateralUsd) * BPS_DENOMINATOR);
}

/**
 * Collateral price at which HF reaches 1 for a LIVE position: uses the
 * account's blended liquidation threshold (bps) and today's price.
 */
export function liveLiquidationPrice(
  collateralUsd: number,
  debtUsd: number,
  currentLiquidationThresholdBps: number,
  priceUsd: number,
): number {
  if (debtUsd <= 0 || collateralUsd <= 0 || currentLiquidationThresholdBps <= 0) return 0;
  const hfNow = (collateralUsd * currentLiquidationThresholdBps) / BPS_DENOMINATOR / debtUsd;
  return priceUsd / hfNow;
}
