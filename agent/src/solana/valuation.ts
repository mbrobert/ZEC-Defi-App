/**
 * Fail-closed valuation of one Oilskin account on Solana — the twin of `engine/valuation.ts` (G1–G4) and
 * `docs/SOLANA-ARCHITECTURE.md` §4.
 *
 * Inputs come from ONE simulated transaction (refresh both reserves, refresh the obligation) whose returned
 * account states are Kamino's own refreshed view at the RPC's slot — the same view `keeper_protect` will
 * judge on — plus the Scope entries the reserves read and an independent price. Verdicts:
 *   NO_DEBT  — no obligation, no debt, or debt at or below the shared dust threshold;
 *   OK(hf)   — every rule passed; `hf` is Kamino's own ratio in Kamino's own units;
 *   UNKNOWN  — any rule failed, with every failed rule named. The ladder never runs on UNKNOWN.
 * Rules, each sufficient alone to force UNKNOWN:
 *   S1 the obligation is refreshed at the simulation slot and not stale;
 *   S2 the ZEC reserve is refreshed at that slot and its price status carries all six klend checks;
 *   S3 the Scope ZEC price is positive and no older than the reserve's max age (klend's own bound);
 *   S4 an independent price, when required, exists, is fresh, and agrees with Scope within the deviation;
 *   S5 the HF recomputed from collateral × price × LT / debt agrees with Kamino's within the tolerance;
 *   S6 the numbers are sane (finite, positive collateral value when there is debt).
 */
import { LOAN_DUST_UNITS } from "@zyo/shared";
import { PRICE_STATUS_ALL_CHECKS, SF_ONE, ctokensToLiquidity, type ObligationView, type ReserveView, type ScopeEntry } from "./layouts.js";

export interface IndependentPrice {
  priceUsd: number;
  atS: number;
  source: string;
}

export interface SolanaSnapshot {
  /** Slot the simulation ran at (the refreshed accounts carry it). */
  slot: bigint;
  /** Chain time at that slot. */
  nowS: bigint;
  /** null when klend has closed the obligation (an emptied one) or it was never created. */
  obligation: ObligationView | null;
  zecReserve: ReserveView;
  usdcReserve: ReserveView;
  scopeZec: ScopeEntry;
  scopeUsdc: ScopeEntry;
  independent: IndependentPrice | null;
  /** The Account's own token balances (base units). */
  accountUsdc: bigint;
  accountZec: bigint;
}

export interface SolanaValuationParams {
  /** Maximum age of the Scope ZEC price, seconds. The reserve's own `maxAgePriceSeconds` (180) is the ceiling. */
  priceMaxAgeS: number;
  /** Maximum age of the independent price, seconds. */
  independentMaxAgeS: number;
  /** Scope vs independent, basis points. */
  oracleDeviationBps: number;
  /** Recomputed vs Kamino HF, basis points. */
  hfToleranceBps: number;
  /** false ONLY on localnet, where no independent source exists; the keeper says so loudly at startup. */
  requireIndependent: boolean;
}

export type SolanaValuation =
  | { kind: "NO_DEBT" }
  | {
      kind: "OK";
      hf: number;
      debtUsdc: bigint;
      collateralZec: bigint;
      collateralCtokens: bigint;
      zecUsd: number;
      liquidationThresholdBps: number;
      /** The obligation's current LTV (debt / collateral value), bps. */
      loanToValueBps: number;
      /** Kamino's LTV cap on the ZEC reserve, bps — the bound a withdraw must leave the obligation under. */
      ltvCapBps: number;
      idleUsdc: bigint;
      idleZec: bigint;
      independent: boolean;
    }
  | { kind: "UNKNOWN"; reasons: string[] };

export function evaluateSolana(s: SolanaSnapshot, p: SolanaValuationParams): SolanaValuation {
  const reasons: string[] = [];
  if (!s.obligation) return { kind: "NO_DEBT" };
  const ob = s.obligation;

  // S1 obligation freshness
  if (ob.slot !== s.slot) reasons.push(`S1 obligation refreshed at slot ${ob.slot}, simulation slot ${s.slot}`);
  if (ob.stale) reasons.push("S1 obligation marked stale after refresh");

  // S2 ZEC reserve freshness + price status
  if (s.zecReserve.slot !== s.slot) reasons.push(`S2 ZEC reserve refreshed at slot ${s.zecReserve.slot}, simulation slot ${s.slot}`);
  if ((s.zecReserve.priceStatus & PRICE_STATUS_ALL_CHECKS) !== PRICE_STATUS_ALL_CHECKS) reasons.push(`S2 ZEC reserve price status ${s.zecReserve.priceStatus} lacks a klend check (need ${PRICE_STATUS_ALL_CHECKS})`);
  if (s.zecReserve.status !== 0) reasons.push(`S2 ZEC reserve status ${s.zecReserve.status} (not active)`);
  if (s.usdcReserve.status !== 0) reasons.push(`S2 USDC reserve status ${s.usdcReserve.status} (not active)`);

  // S3 Scope price
  const maxAge = BigInt(Math.min(p.priceMaxAgeS, Number(s.zecReserve.maxAgePriceSeconds)));
  const scopeAge = s.nowS - s.scopeZec.unixTimestamp;
  if (!(s.scopeZec.priceUsd > 0)) reasons.push("S3 Scope ZEC price is zero");
  if (scopeAge > maxAge) reasons.push(`S3 Scope ZEC price is ${scopeAge}s old (max ${maxAge}s)`);
  if (scopeAge < -300n) reasons.push(`S3 Scope ZEC price is ${-scopeAge}s in the future`);
  if (!(s.scopeUsdc.priceUsd > 0.9 && s.scopeUsdc.priceUsd < 1.1)) reasons.push(`S3 Scope USDC price ${s.scopeUsdc.priceUsd} is off the dollar`);

  // S4 independent price
  if (p.requireIndependent) {
    if (!s.independent) reasons.push("S4 no independent ZEC price");
    else {
      const age = Number(s.nowS) - s.independent.atS;
      if (age > p.independentMaxAgeS) reasons.push(`S4 independent price (${s.independent.source}) is ${age}s old`);
      const dev = Math.abs(s.independent.priceUsd - s.scopeZec.priceUsd) / s.scopeZec.priceUsd;
      if (!(dev * 10_000 <= p.oracleDeviationBps)) reasons.push(`S4 independent price ${s.independent.priceUsd} (${s.independent.source}) disagrees with Scope ${s.scopeZec.priceUsd} by ${(dev * 100).toFixed(2)} % (max ${p.oracleDeviationBps} bps)`);
    }
  }

  // debt and collateral in units
  const debtUsdc = ob.usdcBorrowedAmountSf / SF_ONE;
  const collateralZec = ctokensToLiquidity(ob.zecDepositedCtokens, s.zecReserve);
  if (debtUsdc <= BigInt(LOAN_DUST_UNITS) || ob.borrowFactorAdjustedDebtValueSf === 0n) {
    return reasons.length ? { kind: "UNKNOWN", reasons } : { kind: "NO_DEBT" };
  }

  // Kamino's HF and the recomputation (S5, S6)
  const hfKamino = Number((ob.unhealthyBorrowValueSf * 10_000n) / ob.borrowFactorAdjustedDebtValueSf) / 10_000;
  const ltBps = s.zecReserve.liquidationThresholdPct * 100;
  const collateralUsd = (Number(collateralZec) / 10 ** s.zecReserve.mintDecimals) * s.scopeZec.priceUsd;
  const debtUsd = (Number(debtUsdc) / 10 ** s.usdcReserve.mintDecimals) * s.scopeUsdc.priceUsd;
  const hfRecomputed = debtUsd > 0 ? (collateralUsd * ltBps) / 10_000 / debtUsd : Number.POSITIVE_INFINITY;
  if (!(collateralUsd > 0)) reasons.push("S6 debt with no collateral value");
  if (!Number.isFinite(hfKamino) || hfKamino <= 0) reasons.push(`S6 Kamino HF ${hfKamino} is not a positive number`);
  if (Number.isFinite(hfRecomputed) && Number.isFinite(hfKamino) && hfKamino > 0) {
    const dev = Math.abs(hfRecomputed - hfKamino) / hfKamino;
    if (!(dev * 10_000 <= p.hfToleranceBps)) reasons.push(`S5 recomputed HF ${hfRecomputed.toFixed(4)} disagrees with Kamino's ${hfKamino.toFixed(4)} by ${(dev * 100).toFixed(2)} % (max ${p.hfToleranceBps} bps)`);
  }
  const ltvBps = ob.depositedValueSf > 0n ? Number((ob.borrowFactorAdjustedDebtValueSf * 10_000n) / ob.depositedValueSf) : 10_000;

  if (reasons.length) return { kind: "UNKNOWN", reasons };
  return {
    kind: "OK",
    hf: hfKamino,
    debtUsdc,
    collateralZec,
    collateralCtokens: ob.zecDepositedCtokens,
    zecUsd: s.scopeZec.priceUsd,
    liquidationThresholdBps: ltBps,
    loanToValueBps: ltvBps,
    ltvCapBps: s.zecReserve.loanToValuePct * 100,
    idleUsdc: s.accountUsdc,
    idleZec: s.accountZec,
    independent: s.independent !== null,
  };
}
