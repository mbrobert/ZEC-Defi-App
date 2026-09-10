import type { TokenSymbol } from "@zyo/shared";
import type { ReserveContextResult } from "../services/chain.js";
import type { VenueAccountRead, VenueContext, VenueKind, VenueSnapshot } from "../services/venues.js";
import type { Address } from "../types/evm.js";
import { MAX_UINT256 } from "../types/evm.js";
import {
  BPS,
  HF_SANITY_MAX_WAD,
  WAD,
  usableFeedPrice8,
  withinBps,
  type AccountSnapshot,
  type CollateralShare,
  type OracleDisagreement,
  type Valuation,
  type ValuationParams,
} from "./valuation.js";

/**
 * Venue-aware valuation of one OilskinAccount (audit wave 2, M-HIGH-2 — the real fix).
 *
 * Input: the G1–G4 verdict over the Aave pool (`engine/valuation.ts`, unchanged and still the
 * authority for anything that sits in that pool), plus what `services/venues.ts` read through
 * `ICollateralVenue` from every venue the registry names for the account's collateral — current
 * pointer and `previousVenues` alike. Output: one combined verdict, and the per-venue verdicts it
 * was built from.
 *
 * The rule that matters: **a venue never vouches for itself.** Its `healthFactor` is accepted only
 * when it agrees with a health factor implied by the keeper's OWN Chainlink feeds, using the venue's
 * own `collateral`, `debt` and `liquidationThresholdBps` reads. For the Aave venue that independent
 * view is the whole G1–G4 recomputation (and the venue's answers must match the pool snapshot). For
 * any other venue it is the bound below. Four guards, each sufficient on its own to force UNKNOWN,
 * mirroring G1–G4:
 *
 *   V1 completeness  — a registry pointer, a venue, a threshold or a per-account read that failed,
 *                      for any venue where the account has (or may have) exposure;
 *   V2 prices        — the same feed rules as G2 (zero / stale / future / non-finalised / no feed)
 *                      on the collateral and on USDC, from the tick's reserve contexts;
 *   V3 accounting    — the Aave venue's `healthFactor` and `debt` must reproduce the pool snapshot;
 *                      a venue with debt must hold collateral in some asset the registry names;
 *                      a threshold of 0 or > 100 % with collateral is absurd;
 *   V4 health factor — the venue's HF must lie inside the FEED-IMPLIED band. With a_i = collateral_i
 *                      × feedPrice_i × LT_i and D = debt × feedPrice_USDC: a cross-collateral venue
 *                      (Aave) has HF = Σa_i / D exactly; an isolated-market venue (Morpho, worst
 *                      market) has min_i a_i / D ≤ HF ≤ Σa_i / D (mediant inequality, markets
 *                      without debt do not lower the minimum). With ONE collateral asset the band is
 *                      a point. The tolerance around the band is ORACLE_DEVIATION_BPS — the venue's
 *                      threshold and debt are its own words, so the only thing the band can disagree
 *                      about is the PRICE its oracle used versus the keeper's feed, which is exactly
 *                      what that bound already governs for Aave's oracle. MAX_UINT with debt, 0 with
 *                      collateral (Morpho's "my oracle is unreadable" answer, M-MED-2) and an HF above
 *                      the sanity bound are absurd.
 *
 * A PRICE disagreement (V4's band, and only that) is not UNKNOWN — RISKS.md §8 residual (b), policy
 * set 2026-09-10. The verdict is OK at the PESSIMISTIC of the two views: the venue's own HF when its
 * oracle is the pessimist, the feed-implied floor when the venue is the optimist. A protective
 * repay / derisk / emergency is then sized and fired against that figure instead of the account
 * sitting UNKNOWN through a depeg the venue's oracle cannot see. The verdict carries
 * `oracleDisagreement`; `valuationForWithdraw` turns it back into UNKNOWN for any path that would
 * withdraw collateral (the keeper has none; the owner's Close does), and the dashboard shows the
 * account as unreadable, never as healthy.
 *
 * The combined verdict is the WORST venue: UNKNOWN if any venue is UNKNOWN (fail closed — an
 * unreadable previous venue may hold the debt), NO_DEBT only if every venue says so, else OK with
 * the lowest health factor and THAT venue's shares, so the dispatcher sizes a repay against the
 * venue it is actually protecting. When the account owes on two venues for one asset the router's
 * `unwind` repays every one of them, worst health factor first, and says which in one `VenueRepaid`
 * per venue; `confirm()` refuses a receipt that leaves a venue the account still owes untouched
 * (RISKS.md §8 residual (a), closed 2026-09-09).
 */

export interface VenueVerdict {
  venue: Address;
  kind: VenueKind;
  /** Symbols the registry routes to this venue (current or previous), for the log. */
  assets: string[];
  /** The venue's own `healthFactor(account)`; null when the venue could not be read. */
  healthFactorWad: bigint | null;
  valuation: Valuation;
}

export interface AccountValuation {
  /** The combined verdict the ladder runs on. */
  valuation: Valuation;
  /** The G1–G4 verdict over the Aave pool, always computed. */
  aave: Valuation;
  /** Per-venue verdicts; null when the keeper runs without a registry (no router configured). */
  venues: VenueVerdict[] | null;
  /**
   * Every venue whose oracle disagrees with the keeper's feed this tick (residual (b)). Empty is the
   * normal case. Non-empty: `valuation` is pessimistic, the owner is told, and
   * `valuationForWithdraw` is UNKNOWN.
   */
  oracleDisagreements: { venue: Address; disagreement: OracleDisagreement }[];
}

/**
 * The verdict a path that WITHDRAWS collateral must use. A venue whose price is disputed may be
 * about to liquidate at a price the keeper cannot see, or may be undervaluing what it holds; either
 * way collateral does not leave it on a guess. The keeper never withdraws (`policy.ts`,
 * `withdrawAmount: 0`); this is the rule the owner's Close and any future path must apply.
 */
export function valuationForWithdraw(av: AccountValuation): Valuation {
  if (av.oracleDisagreements.length === 0) return av.valuation;
  return {
    kind: "UNKNOWN",
    reasons: av.oracleDisagreements.flatMap((d) => d.disagreement.reasons.map((r) => `withdraw refused — ${r}`)),
  };
}

export interface VenueValuationInput {
  aave: Valuation;
  aaveSnapshot: AccountSnapshot;
  venues: VenueSnapshot;
  context: VenueContext;
  /** The tick's reserve contexts — the feed reads every non-Aave venue is priced from. */
  reserves: Map<TokenSymbol, ReserveContextResult>;
  usdc: { asset: Address; decimals: number };
}

function feedOf(reserves: Map<TokenSymbol, ReserveContextResult>, symbol: string) {
  const r = reserves.get(symbol as TokenSymbol);
  if (!r) return null;
  if (r.ok) return r.ctx.chainlink;
  return r.chainlink === undefined ? null : r.chainlink;
}

function hfToNumber(wad: bigint): number {
  return Number(wad) / Number(WAD);
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Verdict for one venue that is NOT the Aave pool the G1–G4 valuation reads. */
function evaluateOtherVenue(read: VenueAccountRead, spec: VenueContext["venues"][number], input: VenueValuationInput, p: ValuationParams): Valuation {
  const tag = `venue ${short(read.venue)}`;
  const reasons: string[] = [];
  const held = read.collateral.filter((c) => c.amount > 0n);
  const exposed = read.debtUsdc > 0n || held.length > 0;

  // V1: a venue with problems this tick is inert only for an account with nothing on it.
  if (exposed && spec.problems.length) reasons.push(...spec.problems.map((x) => `V1 ${tag}: ${x}`));
  for (const c of held) {
    if (c.liquidationThresholdBps === null) reasons.push(`V1 ${tag} ${c.symbol}: liquidation threshold unreadable for an asset with collateral`);
  }
  if (read.debtUsdc < 0n || read.healthFactorWad < 0n) reasons.push(`V1 ${tag}: negative field`);
  for (const c of read.collateral) if (c.amount < 0n) reasons.push(`V1 ${tag} ${c.symbol}: negative collateral`);
  if (reasons.length) return { kind: "UNKNOWN", reasons };

  // V2 + V3: value every held collateral from the keeper's own feed at the venue's own threshold.
  let sumA = 0n; // Σ collateral_i × price_i × LT_i  (base units × bps)
  let minA = -1n;
  let collateralBase = 0n;
  const shares: CollateralShare[] = [];
  for (const c of held) {
    const lt = c.liquidationThresholdBps ?? 0n;
    if (lt === 0n) reasons.push(`V3 ${tag} ${c.symbol}: liquidation threshold is 0 for an asset with collateral`);
    if (lt > BPS) reasons.push(`V3 ${tag} ${c.symbol}: liquidation threshold ${lt} > 100%`);
    const price8 = usableFeedPrice8(c.symbol, feedOf(input.reserves, c.symbol), p, reasons, `V2 ${tag}`);
    if (price8 === null) continue;
    const unit = 10n ** BigInt(c.decimals);
    const value = (c.amount * price8) / unit;
    if (value === 0n) reasons.push(`V3 ${tag} ${c.symbol}: collateral ${c.amount} values to 0 base units — dust cannot be valued`);
    collateralBase += value;
    const a = value * lt;
    sumA += a;
    minA = minA < 0n || a < minA ? a : minA;
    shares.push({ asset: c.asset, symbol: c.symbol, valueBase: value, liquidationThresholdBps: lt });
  }

  if (read.debtUsdc === 0n) {
    // V4 for the no-debt case: the venue must say so too.
    if (read.healthFactorWad !== MAX_UINT256) reasons.push(`V4 ${tag}: no debt but venue HF ${read.healthFactorWad} ≠ MAX_UINT256`);
    if (reasons.length) return { kind: "UNKNOWN", reasons };
    return { kind: "NO_DEBT", collateralBase };
  }

  const usdcPrice8 = usableFeedPrice8("USDC", feedOf(input.reserves, "USDC"), p, reasons, `V2 ${tag}`);
  if (held.length === 0) reasons.push(`V4 ${tag}: debt ${read.debtUsdc} USDC with zero collateral in any asset the registry names here — nothing to protect, escalate`);
  if (read.healthFactorWad === MAX_UINT256) reasons.push(`V4 ${tag}: debt present but venue HF is MAX_UINT256 (infinite)`);
  if (read.healthFactorWad > HF_SANITY_MAX_WAD) reasons.push(`V4 ${tag}: venue HF above sanity bound`);
  if (read.healthFactorWad === 0n && held.length > 0) {
    reasons.push(`V4 ${tag}: venue HF is 0 with collateral held — the venue could not price its own market (an unreadable oracle answers 0 there); fail closed`);
  }
  if (reasons.length || usdcPrice8 === null) return { kind: "UNKNOWN", reasons };

  const debtBase = (read.debtUsdc * usdcPrice8) / 10n ** BigInt(input.usdc.decimals);
  if (debtBase === 0n) return { kind: "UNKNOWN", reasons: [`V3 ${tag}: debt ${read.debtUsdc} values to 0 base units — dust cannot be valued`] };
  if (sumA === 0n) return { kind: "UNKNOWN", reasons: [`V4 ${tag}: debt with zero valued collateral — nothing to protect, escalate`] };

  // V4: the feed-implied band. hf = a / D, as a wad: a × WAD / (D × BPS).
  const upper = (sumA * WAD) / (debtBase * BPS);
  const lower = (minA * WAD) / (debtBase * BPS);
  const hf = read.healthFactorWad;
  const disagreement: string[] = [];
  let direction: OracleDisagreement["direction"] | null = null;
  if (hf > upper && !withinBps(hf, upper, p.oracleDeviationBps)) {
    direction = "venue-optimistic";
    disagreement.push(
      `V4 ${tag}: venue HF ${hf} above the feed-implied ceiling ${upper} by more than ${p.oracleDeviationBps} bps — the venue's oracle values the collateral higher than the keeper's Chainlink feed does; protecting at the feed-implied floor ${lower}, refusing any withdrawal`
    );
  }
  if (hf < lower && !withinBps(hf, lower, p.oracleDeviationBps)) {
    direction = "venue-pessimistic";
    disagreement.push(
      `V4 ${tag}: venue HF ${hf} below the feed-implied floor ${lower} by more than ${p.oracleDeviationBps} bps — the venue's oracle values the collateral lower than the keeper's Chainlink feed does; protecting at the venue's own ${hf}, refusing any withdrawal`
    );
  }

  // Residual (b) policy (2026-09-10): a price disagreement is acted on at the PESSIMISTIC of the
  // two views — the venue's own HF when its oracle is the pessimist, the feed-implied floor when
  // the venue is the optimist — never left UNKNOWN, never trusted at the optimist's figure. The
  // shares are re-scaled so Σ(value × LT) / D reproduces that figure: a repay sized from this
  // verdict lifts the PESSIMISTIC health to the rung's disarm.
  const pessimisticWad = direction === null ? hf : hf < lower ? hf : lower;
  if (direction !== null && upper > 0n) {
    for (const s of shares) s.valueBase = (s.valueBase * pessimisticWad) / upper;
    collateralBase = shares.reduce((acc, s) => acc + s.valueBase, 0n);
  }

  shares.sort((a, b) => (b.valueBase > a.valueBase ? 1 : b.valueBase < a.valueBase ? -1 : 0));
  const hfNumber = hfToNumber(pessimisticWad);
  if (!Number.isFinite(hfNumber) || hfNumber <= 0) return { kind: "UNKNOWN", reasons: [`V4 ${tag}: HF not a finite positive number`] };
  return {
    kind: "OK",
    hf: hfNumber,
    hfWad: pessimisticWad,
    debtBase,
    collateralBase,
    collateral: shares,
    // The venue's own debt, priced at the keeper's USDC feed — what a repay is sized against.
    debt: [{ asset: input.usdc.asset, symbol: "USDC", decimals: input.usdc.decimals, amount: read.debtUsdc, price8: usdcPrice8, valueBase: debtBase }],
    dominantCollateral: shares[0],
    ...(direction !== null
      ? { oracleDisagreement: { venueHfWad: hf, impliedFloorWad: lower, impliedCeilingWad: upper, direction, reasons: disagreement } }
      : {}),
  };
}

/** Cross-check the Aave venue's answers against the pool snapshot the G1–G4 valuation used (V3). */
function crossCheckAaveVenue(read: VenueAccountRead, input: VenueValuationInput, p: ValuationParams): string[] {
  const tag = `aave venue ${short(read.venue)}`;
  const reasons: string[] = [];
  const snap = input.aaveSnapshot;
  const poolHf = snap.healthFactorWad;
  const sameHf = read.healthFactorWad === poolHf || (poolHf !== MAX_UINT256 && read.healthFactorWad !== MAX_UINT256 && withinBps(read.healthFactorWad, poolHf, p.hfToleranceBps));
  if (!sameHf) reasons.push(`V3 ${tag}: healthFactor ${read.healthFactorWad} ≠ pool HF ${poolHf} — the venue is not reading the pool this keeper reads`);
  const usdcRow = snap.reserves.find((r) => r.asset.toLowerCase() === input.usdc.asset.toLowerCase());
  const poolDebt = usdcRow ? usdcRow.debt : null;
  if (poolDebt === null) {
    if (read.debtUsdc !== 0n) reasons.push(`V3 ${tag}: venue reports ${read.debtUsdc} USDC debt but the pool snapshot has no USDC row`);
  } else if (!withinBps(read.debtUsdc, poolDebt, p.hfToleranceBps)) {
    reasons.push(`V3 ${tag}: debt ${read.debtUsdc} ≠ pool USDC debt ${poolDebt}`);
  }
  return reasons;
}

export function evaluateVenues(input: VenueValuationInput, p: ValuationParams): AccountValuation {
  const verdicts: VenueVerdict[] = [];
  const reasons: string[] = [];

  // V1: the registry itself must have been readable for every asset it knows about.
  for (const u of input.context.unreadableAssets) reasons.push(`V1 registry ${u.symbol}: ${u.reason}`);
  for (const u of input.venues.unreadable) {
    const spec = input.context.venues.find((v) => v.venue.toLowerCase() === u.venue.toLowerCase());
    verdicts.push({
      venue: u.venue,
      kind: spec?.kind ?? "other",
      assets: spec?.assets.map((a) => a.symbol) ?? [],
      healthFactorWad: null,
      valuation: { kind: "UNKNOWN", reasons: [`V1 venue ${short(u.venue)}: unreadable (${u.reason})`] },
    });
  }

  for (const read of input.venues.venues) {
    const spec = input.context.venues.find((v) => v.venue.toLowerCase() === read.venue.toLowerCase());
    const assets = spec?.assets.map((a) => a.symbol) ?? [];
    if (!spec) {
      verdicts.push({ venue: read.venue, kind: read.kind, assets, healthFactorWad: read.healthFactorWad, valuation: { kind: "UNKNOWN", reasons: [`V1 venue ${short(read.venue)}: read without a context entry`] } });
      continue;
    }
    if (read.kind === "aave") {
      // The pool verdict IS this venue's verdict; the venue only has to agree with the pool.
      const mismatch = crossCheckAaveVenue(read, input, p);
      verdicts.push({ venue: read.venue, kind: "aave", assets, healthFactorWad: read.healthFactorWad, valuation: mismatch.length ? { kind: "UNKNOWN", reasons: mismatch } : input.aave });
      continue;
    }
    verdicts.push({ venue: read.venue, kind: "other", assets, healthFactorWad: read.healthFactorWad, valuation: evaluateOtherVenue(read, spec, input, p) });
  }

  // Combine: the Aave pool verdict (always) plus every non-Aave venue. An Aave-kind venue
  // contributes only its cross-check (its verdict is the pool's, counted once).
  const parts: Valuation[] = [input.aave, ...verdicts.filter((v) => v.kind !== "aave").map((v) => v.valuation)];
  for (const v of verdicts) if (v.kind === "aave" && v.valuation.kind === "UNKNOWN") parts.push(v.valuation);
  for (const v of parts) if (v.kind === "UNKNOWN") reasons.push(...v.reasons);
  const oracleDisagreements = verdicts.flatMap((v) =>
    v.valuation.kind === "OK" && v.valuation.oracleDisagreement ? [{ venue: v.venue, disagreement: v.valuation.oracleDisagreement }] : []
  );
  if (reasons.length) return { valuation: { kind: "UNKNOWN", reasons: [...new Set(reasons)] }, aave: input.aave, venues: verdicts, oracleDisagreements };

  const oks = parts.filter((v): v is Extract<Valuation, { kind: "OK" }> => v.kind === "OK");
  if (oks.length === 0) {
    const collateralBase = parts.reduce((acc, v) => acc + (v.kind === "NO_DEBT" ? v.collateralBase : 0n), 0n);
    return { valuation: { kind: "NO_DEBT", collateralBase }, aave: input.aave, venues: verdicts, oracleDisagreements };
  }
  let worst = oks[0];
  for (const v of oks) if (v.hfWad < worst.hfWad) worst = v;
  return { valuation: worst, aave: input.aave, venues: verdicts, oracleDisagreements };
}
