import type { Address } from "../types/evm.js";
import { MAX_UINT256 } from "../types/evm.js";

/**
 * Fail-closed valuation of one OilskinAccount's Aave v3 position.
 *
 * Input is a raw snapshot exactly as read from chain (services/chain.ts) —
 * possibly incomplete, possibly inconsistent, possibly adversarial. Output is
 * one of three verdicts:
 *
 *   NO_DEBT  — provably nothing to protect (and every input agrees);
 *   OK       — a health factor we independently recomputed and cross-checked;
 *   UNKNOWN  — anything else. The ladder never runs on UNKNOWN; the monitor
 *              escalates instead.
 *
 * The invariant that matters (AUDIT-FINDINGS Part 4 row 1: a debt asset whose
 * oracle read 0 valued the debt at $0 → HF +∞ → HEALTHY with $9,500 of live
 * debt): **non-empty debt can never yield NO_DEBT, and can yield OK only when
 * every reserve carrying exposure has a positive price from two independent
 * sources that agree, and the recomputed HF agrees with the pool's.**
 *
 * Four independent guards, each sufficient on its own to force UNKNOWN:
 *   G1 completeness  — a reserve row that failed to read, or debt reported by
 *                      the pool with no reserve row carrying it (or vice versa);
 *   G2 prices        — zero / stale / future / non-finalised Chainlink answer,
 *                      zero Aave-oracle price, or the two disagreeing;
 *   G3 accounting    — Σ reserve debt and Σ reserve collateral must reproduce
 *                      the pool's totals, and the weighted LT must reproduce
 *                      `currentLiquidationThreshold`;
 *   G4 health factor — the pool's HF must equal the one recomputed from
 *                      reserve rows; MAX_UINT with debt, 0 with collateral, or
 *                      an HF above the sanity bound is absurd.
 *
 * All arithmetic is bigint; a `number` is produced only at the very end.
 */

export type ReserveSymbol = string;

export interface ChainlinkRead {
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
  decimals: number;
}

export interface ReserveRow {
  asset: Address;
  symbol: ReserveSymbol;
  decimals: number;
  /** DataProvider.getReserveConfigurationData → liquidationThreshold (bps). */
  liquidationThresholdBps: bigint;
  /** DataProvider.getUserReserveData → currentATokenBalance. */
  aTokenBalance: bigint;
  /** currentVariableDebt + currentStableDebt. */
  debt: bigint;
  /** getUserReserveData → usageAsCollateralEnabled (user-level flag). */
  usingAsCollateral: boolean;
  /** AaveOracle.getAssetPrice(asset), BASE_CURRENCY_UNIT = 1e8. */
  aavePrice: bigint;
  /** Independent Chainlink read for the same asset, or null when none is wired. */
  chainlink: ChainlinkRead | null;
}

export interface AccountSnapshot {
  account: Address;
  /** Pool.getUserAccountData(account). */
  totalCollateralBase: bigint;
  totalDebtBase: bigint;
  currentLiquidationThresholdBps: bigint;
  healthFactorWad: bigint;
  /** One row per reserve the keeper knows how to value. */
  reserves: ReserveRow[];
  /** Reserves the reader tried to fetch and could not (G1). */
  unreadableReserves: { symbol: ReserveSymbol; reason: string }[];
  /** Block the snapshot was read at (for logging only). */
  blockNumber: bigint;
}

export interface ValuationParams {
  /**
   * Unix seconds "now" for staleness checks. The monitor and the dispatcher
   * take this from the CHAIN HEAD's block timestamp, not the host clock: a
   * keeper host 10 minutes slow used to read every feed as "updated in the
   * future" and every account as UNKNOWN (audit C-LOW-1).
   */
  nowS: bigint;
  /**
   * Fallback staleness bound, in seconds, for a feed with no per-feed policy.
   * Kept only as a floor for feeds whose cadence could not be probed.
   */
  priceMaxAgeS: number;
  /**
   * PER-FEED staleness bounds, keyed by reserve symbol, derived at startup
   * from each aggregator's OWN observed round cadence (engine/feeds.ts).
   *
   * One global constant cannot be right for two feeds at once: the live
   * USDC/USD round was 44,475 s old — a $1-pegged asset on a long heartbeat,
   * perfectly healthy — against a 10,800 s default, so EVERY borrower (they
   * all carry USDC debt) read UNKNOWN on every tick and the ladder never ran,
   * while raising that one constant past 24 h would have disabled the guard
   * for cbBTC and WETH, the assets that actually move (audit C-HIGH-2).
   */
  priceMaxAgeBySymbol?: ReadonlyMap<string, number>;
  oracleDeviationBps: number;
  hfToleranceBps: number;
}

/** The staleness bound this valuation will apply to `symbol`. */
export function maxAgeFor(p: ValuationParams, symbol: string): number {
  return p.priceMaxAgeBySymbol?.get(symbol) ?? p.priceMaxAgeS;
}

/**
 * Reason prefix for "this account holds collateral Oilskin cannot value".
 * Distinct from every other G3 mismatch because it is ACTIONABLE by the user
 * (audit C-MED-5): the pool reports more collateral than the reserves the
 * keeper knows, so protection is off for that account and nobody else.
 */
export const UNTRACKED_COLLATERAL = "G3 UNTRACKED_COLLATERAL";

export interface CollateralShare {
  asset: Address;
  symbol: ReserveSymbol;
  valueBase: bigint;
  liquidationThresholdBps: bigint;
}

/** One reserve carrying debt, with everything needed to size a repay in its own units. */
export interface DebtShare {
  asset: Address;
  symbol: ReserveSymbol;
  decimals: number;
  /** Raw debt in the asset's own units. */
  amount: bigint;
  /** Aave oracle price, 8 decimals — the same price the pool values it at. */
  price8: bigint;
  valueBase: bigint;
}

export type Valuation =
  | { kind: "NO_DEBT"; collateralBase: bigint }
  | {
      kind: "OK";
      /** Recomputed health factor as a JS number (for the ladder). */
      hf: number;
      hfWad: bigint;
      debtBase: bigint;
      collateralBase: bigint;
      /** Collateral reserves ordered by value, largest first. */
      collateral: CollateralShare[];
      /** Debt reserves ordered by value, largest first. */
      debt: DebtShare[];
      /** The asset whose ladder applies (largest collateral share). */
      dominantCollateral: CollateralShare;
    }
  | { kind: "UNKNOWN"; reasons: string[] };

export const BASE_CURRENCY_UNIT = 100_000_000n; // Aave base currency = USD, 8 decimals
export const WAD = 1_000_000_000_000_000_000n;
export const BPS = 10_000n;
/** HF above this with live debt is not a real account. */
export const HF_SANITY_MAX_WAD = 1_000_000_000_000n * WAD;
/** Feed updatedAt more than this far in the future is a broken clock or feed. */
export const FUTURE_SKEW_S = 300n;

function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/** |a-b| ≤ tolBps of max(|a|,|b|). Two zeros agree; zero vs non-zero never do. */
function withinBps(a: bigint, b: bigint, tolBps: number): boolean {
  if (a === b) return true;
  const ref = a > b ? a : b;
  if (ref <= 0n) return false;
  return absDiff(a, b) * BPS <= ref * BigInt(tolBps);
}

/** Normalise a feed answer with `decimals` to the 8-decimal base unit. */
export function normaliseTo8(answer: bigint, decimals: number): bigint {
  if (decimals === 8) return answer;
  if (decimals > 8) return answer / 10n ** BigInt(decimals - 8);
  return answer * 10n ** BigInt(8 - decimals);
}

function checkChainlink(row: ReserveRow, p: ValuationParams, reasons: string[]): void {
  const cl = row.chainlink;
  if (cl === null) {
    reasons.push(`G2 ${row.symbol}: no independent price feed wired for a reserve with exposure`);
    return;
  }
  if (!Number.isInteger(cl.decimals) || cl.decimals < 0 || cl.decimals > 18) {
    reasons.push(`G2 ${row.symbol}: feed decimals ${cl.decimals} out of range`);
    return;
  }
  if (cl.answer <= 0n) reasons.push(`G2 ${row.symbol}: feed answer ${cl.answer} ≤ 0`);
  if (cl.updatedAt === 0n) reasons.push(`G2 ${row.symbol}: feed never updated`);
  if (cl.updatedAt > p.nowS + FUTURE_SKEW_S) reasons.push(`G2 ${row.symbol}: feed updatedAt in the future`);
  const maxAge = maxAgeFor(p, row.symbol);
  if (cl.updatedAt < p.nowS && p.nowS - cl.updatedAt > BigInt(maxAge)) {
    reasons.push(`G2 ${row.symbol}: feed stale by ${(p.nowS - cl.updatedAt).toString()}s (max ${maxAge}s for this feed)`);
  }
  if (cl.answeredInRound < cl.roundId) reasons.push(`G2 ${row.symbol}: feed round not finalised`);
  if (cl.answer > 0n) {
    const cl8 = normaliseTo8(cl.answer, cl.decimals);
    if (cl8 <= 0n) {
      reasons.push(`G2 ${row.symbol}: feed answer rounds to 0 at 8 decimals`);
    } else if (!withinBps(cl8, row.aavePrice, p.oracleDeviationBps)) {
      reasons.push(
        `G2 ${row.symbol}: chainlink ${cl8} vs aave ${row.aavePrice} disagree beyond ${p.oracleDeviationBps} bps`
      );
    }
  }
}

export function evaluateSnapshot(s: AccountSnapshot, p: ValuationParams): Valuation {
  const reasons: string[] = [];

  // ---- G1 completeness ---------------------------------------------------
  for (const u of s.unreadableReserves) reasons.push(`G1 ${u.symbol}: unreadable (${u.reason})`);
  const seen = new Set<string>();
  for (const r of s.reserves) {
    const k = r.asset.toLowerCase();
    if (seen.has(k)) reasons.push(`G1 ${r.symbol}: duplicate reserve row`);
    seen.add(k);
    if (!Number.isInteger(r.decimals) || r.decimals < 0 || r.decimals > 36) {
      reasons.push(`G1 ${r.symbol}: decimals ${r.decimals} out of range`);
    }
    if (r.debt < 0n || r.aTokenBalance < 0n || r.aavePrice < 0n || r.liquidationThresholdBps < 0n) {
      reasons.push(`G1 ${r.symbol}: negative field`);
    }
    if (r.liquidationThresholdBps > BPS) reasons.push(`G1 ${r.symbol}: LT ${r.liquidationThresholdBps} > 100%`);
  }
  if (s.totalDebtBase < 0n || s.totalCollateralBase < 0n) reasons.push("G1 pool totals negative");
  if (s.currentLiquidationThresholdBps > BPS) reasons.push("G1 pool LT > 100%");
  if (reasons.length) return { kind: "UNKNOWN", reasons };

  const validRows = s.reserves;

  // ---- G2 prices + G3 accounting ----------------------------------------
  let debtSum = 0n;
  let collateralSum = 0n;
  let weightedLt = 0n; // Σ value_i × LT_i
  const collateral: CollateralShare[] = [];
  const debtRows: DebtShare[] = [];
  let anyReserveDebt = false;

  for (const r of validRows) {
    const hasExposure = r.debt > 0n || (r.aTokenBalance > 0n && r.usingAsCollateral);
    if (!hasExposure) continue;
    if (r.aavePrice <= 0n) reasons.push(`G2 ${r.symbol}: aave oracle price is 0 for a reserve with exposure`);
    checkChainlink(r, p, reasons);
    const unit = 10n ** BigInt(r.decimals);
    if (r.debt > 0n) {
      anyReserveDebt = true;
      const v = (r.debt * r.aavePrice) / unit;
      if (v === 0n && r.aavePrice > 0n) {
        // Dust debt below one base unit: not zero, so refuse to call it zero.
        reasons.push(`G3 ${r.symbol}: debt ${r.debt} values to 0 base units — dust cannot be valued`);
      }
      debtSum += v;
      debtRows.push({ asset: r.asset, symbol: r.symbol, decimals: r.decimals, amount: r.debt, price8: r.aavePrice, valueBase: v });
    }
    if (r.aTokenBalance > 0n && r.usingAsCollateral) {
      if (r.liquidationThresholdBps === 0n) {
        reasons.push(`G3 ${r.symbol}: used as collateral but reserve LT is 0`);
      }
      const v = (r.aTokenBalance * r.aavePrice) / unit;
      collateralSum += v;
      weightedLt += v * r.liquidationThresholdBps;
      collateral.push({ asset: r.asset, symbol: r.symbol, valueBase: v, liquidationThresholdBps: r.liquidationThresholdBps });
    }
  }

  // Debt reported by the pool must be carried by a reserve row and vice versa.
  if (s.totalDebtBase > 0n && !anyReserveDebt) reasons.push("G1 pool reports debt but no reserve row carries any");
  if (s.totalDebtBase === 0n && anyReserveDebt) reasons.push("G1 a reserve row carries debt but the pool reports none");
  if (s.totalDebtBase > 0n && anyReserveDebt && !withinBps(debtSum, s.totalDebtBase, p.hfToleranceBps)) {
    reasons.push(`G3 Σ reserve debt ${debtSum} ≠ pool totalDebtBase ${s.totalDebtBase}`);
  }
  if (!withinBps(collateralSum, s.totalCollateralBase, p.hfToleranceBps)) {
    // Which direction matters: the pool seeing MORE collateral than the keeper
    // can value means the account holds a reserve outside AAVE_V3_RESERVES —
    // a user action, permanent until they withdraw it, and something the
    // dashboard can tell that one user. Anything else is an accounting fault.
    reasons.push(
      s.totalCollateralBase > collateralSum
        ? `${UNTRACKED_COLLATERAL}: pool totalCollateralBase ${s.totalCollateralBase} exceeds Σ reserves the keeper values ${collateralSum} — this account holds collateral Oilskin cannot value, so protection is OFF for it`
        : `G3 Σ reserve collateral ${collateralSum} ≠ pool totalCollateralBase ${s.totalCollateralBase}`
    );
  }
  if (collateralSum > 0n) {
    const ltLocal = weightedLt / collateralSum;
    if (absDiff(ltLocal, s.currentLiquidationThresholdBps) > BigInt(p.hfToleranceBps)) {
      reasons.push(`G3 weighted LT ${ltLocal} ≠ pool LT ${s.currentLiquidationThresholdBps}`);
    }
  } else if (s.currentLiquidationThresholdBps !== 0n && s.totalCollateralBase === 0n) {
    reasons.push("G3 pool LT non-zero with zero collateral");
  }

  const hasDebt = s.totalDebtBase > 0n || anyReserveDebt;

  // ---- G4 health factor --------------------------------------------------
  if (!hasDebt) {
    if (s.healthFactorWad !== MAX_UINT256) reasons.push(`G4 no debt but pool HF ${s.healthFactorWad} ≠ MAX_UINT256`);
    if (reasons.length) return { kind: "UNKNOWN", reasons };
    return { kind: "NO_DEBT", collateralBase: collateralSum };
  }

  if (s.healthFactorWad === MAX_UINT256) reasons.push("G4 debt present but pool HF is MAX_UINT256 (infinite)");
  if (s.healthFactorWad > HF_SANITY_MAX_WAD) reasons.push("G4 pool HF above sanity bound");
  if (collateralSum === 0n) reasons.push("G4 debt with zero valued collateral — nothing to protect, escalate");
  if (debtSum === 0n) reasons.push("G4 debt present but Σ reserve debt values to 0");
  if (reasons.length) return { kind: "UNKNOWN", reasons };

  // hf = Σ(value_i × LT_i / 1e4) / debt, as a wad.
  const hfLocalWad = (weightedLt * WAD) / (debtSum * BPS);
  if (hfLocalWad === 0n) reasons.push("G4 recomputed HF is 0 with positive collateral");
  if (!withinBps(hfLocalWad, s.healthFactorWad, p.hfToleranceBps)) {
    reasons.push(`G4 recomputed HF ${hfLocalWad} ≠ pool HF ${s.healthFactorWad}`);
  }
  if (reasons.length) return { kind: "UNKNOWN", reasons };

  collateral.sort((a, b) => (b.valueBase > a.valueBase ? 1 : b.valueBase < a.valueBase ? -1 : 0));
  debtRows.sort((a, b) => (b.valueBase > a.valueBase ? 1 : b.valueBase < a.valueBase ? -1 : 0));
  const dominant = collateral[0];
  const hf = Number(hfLocalWad) / Number(WAD);
  if (!Number.isFinite(hf) || hf <= 0) return { kind: "UNKNOWN", reasons: ["G4 HF not a finite positive number"] };

  return {
    kind: "OK",
    hf,
    hfWad: hfLocalWad,
    debtBase: debtSum,
    collateralBase: collateralSum,
    collateral,
    debt: debtRows,
    dominantCollateral: dominant,
  };
}
