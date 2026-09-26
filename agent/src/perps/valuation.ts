/**
 * Fail-closed valuation of one account's SHORT on Hyperliquid — the third chain's twin of
 * `engine/valuation.ts` (Base, G1–G4) and `solana/valuation.ts` (S1–S6); design §4–§5.
 *
 * Inputs are one `PerpsSnapshot` (every precompile read at one block, the venue's entry record, the
 * independent mark). Verdicts:
 *   NO_POSITION — no perp position and no other notional on the account: nothing to protect;
 *   OK          — every rule passed; the distance and the equivalent HF are the venue's own rule in integers
 *                 (`shortDistanceBps`), the numbers `protect` will recompute;
 *   UNKNOWN     — any rule failed, every failed rule named. The ladder never runs on UNKNOWN.
 * Rules, each sufficient alone to force UNKNOWN:
 *   P0 every read the health rests on answered and decoded (a precompile that does not answer stops every rung);
 *   P1 the venue's asset parameters are the deployed ones (`VenueParamsChanged` is what `protect` would say);
 *   P2 the mark agrees with the oracle within the venue's own bound (`MarkOracleDeviation`);
 *   P3 an independent mark, when required, exists, is fresh, and agrees with the precompile's;
 *   P4 the position is a short — a long is not this product (design §11) — and cross-margined;
 *   P5 the account carries ONE position: `accountMarginSummary.ntlPos` is this short's notional, to the
 *      venue's own tolerance (`OtherPositionsOpen`): another perp would share the account value and make
 *      the distance a fiction, so every rung stops rather than act on it.
 * A non-positive account value with a short open is NOT unknown: it is a distance of zero (HF 1.00), the
 * venue's engine is already entitled to act, and every rung fires.
 */
import { MAX_SHORT_DISTANCE_BPS, equivalentHfBps, notionalE6, shortDistanceBps, type PerpPosition } from "@zyo/shared";
import type { PerpsEntry, PerpsSnapshot } from "./reader.js";

export interface PerpsValuationParams {
  /** Maximum age of the independent mark, seconds. */
  independentMaxAgeS: number;
  /** Precompile mark versus the independent mark, basis points. */
  oracleDeviationBps: number;
  /** false ONLY on testnet without an API; the keeper says so loudly at startup. */
  requireIndependent: boolean;
}

export type PerpsValuation =
  | { kind: "NO_POSITION"; spotE6: bigint }
  | {
      kind: "OK";
      /** The up-move that liquidates, bps, and its equivalent health factor (bps and as the ladder's number). */
      distanceBps: number;
      hfBps: number;
      hf: number;
      /** Signed size (negative), its magnitude, and the mark the distance was taken at. */
      szi: bigint;
      size: bigint;
      markRaw: bigint;
      oracleRaw: bigint;
      accountValueE6: bigint;
      ntlE6: bigint;
      /** The spot reserve on HyperCore (10^6) and what the venue says is withdrawable. */
      spotE6: bigint;
      withdrawableE6: bigint;
      /** The owner's recorded entry (D9), or null when the venue holds none — `protect` then reverts `NoEntry`. */
      entry: PerpsEntry | null;
      szDecimals: number;
      mmrBps: number;
      independent: boolean;
      position: PerpPosition;
    }
  | { kind: "UNKNOWN"; reasons: string[] };

/** A HyperCore spot balance (weiDecimals) as 10^6 USDC — the venue's `_spotE6`. */
export function spotToE6(totalWei: bigint, weiDecimals: number, evmDecimals: number): bigint {
  return totalWei / 10n ** BigInt(weiDecimals - evmDecimals);
}

export function evaluatePerps(s: PerpsSnapshot, p: PerpsValuationParams): PerpsValuation {
  const reasons: string[] = [];
  const { params } = s;

  // P0 every read answered
  for (const f of s.readFailures) {
    if (f.what.startsWith("independent")) continue; // P3 judges it
    reasons.push(`P0 ${f.what} did not answer or did not decode: ${f.reason}`);
  }
  if (!s.position || !s.summary || s.markRaw === null || s.oracleRaw === null || !s.assetInfo || !s.spot || s.withdrawableE6 === null) {
    if (reasons.length === 0) reasons.push("P0 a read is missing from the snapshot");
    return { kind: "UNKNOWN", reasons };
  }

  // P1 venue parameters
  if (s.assetInfo.szDecimals !== params.szDecimals || s.assetInfo.maxLeverage !== params.maxLeverage) {
    reasons.push(`P1 venue parameters moved: szDecimals ${s.assetInfo.szDecimals} / maxLeverage ${s.assetInfo.maxLeverage} versus the deployed ${params.szDecimals} / ${params.maxLeverage} (protect would revert VenueParamsChanged)`);
  }
  if (s.assetInfo.onlyIsolated) reasons.push("P1 the venue marks this market isolated-only; the cross-margin rule does not apply");

  // P2 mark versus oracle, the venue's own bound
  const hi = s.markRaw > s.oracleRaw ? s.markRaw : s.oracleRaw;
  const lo = s.markRaw > s.oracleRaw ? s.oracleRaw : s.markRaw;
  if (lo <= 0n) reasons.push(`P2 a zero price: mark ${s.markRaw}, oracle ${s.oracleRaw}`);
  else {
    const dev = Number(((hi - lo) * 10_000n) / lo);
    if (dev > params.maxMarkOracleDeviationBps) reasons.push(`P2 mark ${s.markRaw} and oracle ${s.oracleRaw} disagree by ${dev} bps (the venue's bound is ${params.maxMarkOracleDeviationBps}; protect would revert MarkOracleDeviation)`);
  }

  // P3 independent mark
  if (p.requireIndependent) {
    if (!s.independent) reasons.push(`P3 no independent mark${s.readFailures.find((f) => f.what.startsWith("independent"))?.reason ? ` (${s.readFailures.find((f) => f.what.startsWith("independent"))!.reason})` : ""}`);
    else {
      const age = Number(s.nowS) - s.independent.atS;
      if (age > p.independentMaxAgeS) reasons.push(`P3 independent mark (${s.independent.source}) is ${age}s old (max ${p.independentMaxAgeS}s)`);
      if (s.markRaw > 0n && s.independent.markRaw > 0n) {
        const a = s.markRaw > s.independent.markRaw ? s.markRaw : s.independent.markRaw;
        const b = s.markRaw > s.independent.markRaw ? s.independent.markRaw : s.markRaw;
        const dev = Number(((a - b) * 10_000n) / b);
        if (dev > p.oracleDeviationBps) reasons.push(`P3 independent mark ${s.independent.markRaw} (${s.independent.source}) disagrees with the precompile's ${s.markRaw} by ${dev} bps (max ${p.oracleDeviationBps})`);
      } else reasons.push("P3 a zero mark cannot be checked");
    }
  }

  const spotE6 = spotToE6(s.spot.total, params.usdcWeiDecimals, params.usdcEvmDecimals);

  // no position at all
  if (s.position.szi === 0n) {
    if (s.summary.ntlPos !== 0n) reasons.push(`P5 no ${params.perpAsset} position but the account carries ${s.summary.ntlPos} of other notional — another perp was opened outside the product`);
    if (reasons.length) return { kind: "UNKNOWN", reasons };
    return { kind: "NO_POSITION", spotE6 };
  }

  // P4 a short, cross-margined
  if (s.position.szi > 0n) reasons.push(`P4 the position is a LONG of ${s.position.szi} — not this product (design §11); the keeper does not act on it`);
  if (s.position.isIsolated) reasons.push("P4 the position is isolated-margined; the cross-margin distance rule does not apply");
  if (reasons.length) return { kind: "UNKNOWN", reasons };

  // P5 one position
  const ntlE6 = s.markRaw > 0n ? notionalE6(s.position.szi, s.markRaw, params.szDecimals) : 0n;
  const tol = ntlE6 / 10_000n + 1n;
  if (s.summary.ntlPos > ntlE6 + tol || s.summary.ntlPos + tol < ntlE6) {
    reasons.push(`P5 the account's total notional ${s.summary.ntlPos} is not this short's ${ntlE6}: another position shares the account value (protect would revert OtherPositionsOpen)`);
  }
  if (reasons.length) return { kind: "UNKNOWN", reasons };

  const distanceBps = shortDistanceBps({ accountValueE6: s.summary.accountValue, szi: s.position.szi, markRaw: s.markRaw, szDecimals: params.szDecimals, mmrBps: params.mmrBps });
  const hfBps = equivalentHfBps(Math.min(distanceBps, MAX_SHORT_DISTANCE_BPS));
  return {
    kind: "OK",
    distanceBps,
    hfBps,
    hf: hfBps / 10_000,
    szi: s.position.szi,
    size: -s.position.szi,
    markRaw: s.markRaw,
    oracleRaw: s.oracleRaw,
    accountValueE6: s.summary.accountValue,
    ntlE6,
    spotE6,
    withdrawableE6: s.withdrawableE6,
    entry: s.entry,
    szDecimals: params.szDecimals,
    mmrBps: params.mmrBps,
    independent: s.independent !== null,
    position: s.position,
  };
}
