/**
 * Collateral registry (off-chain mirror of CollateralRegistry.sol).
 *
 * Deliberately carries NO liquidation threshold, NO LTV, NO health factor.
 * Those are read from the venue at call time and passed into the pure
 * functions below. The only typed numbers here are token decimals and the
 * product policy constants (ENTRY_HF_FLOOR via health.ts, the 50% cap).
 */
import { AAVE_V3, BASE_TOKENS, CHAINLINK_FEEDS, type TokenSymbol } from "./base.js";
import type { Address } from "./evm.js";
import { ENTRY_HF_FLOOR, entryHfForLtv, liquidationDropPct, assertBps, entryHfAtLtvBps } from "./health.js";
import { ZEC_FORMS, type ZecForm, type ZecFormId } from "./zecForms.js";

export type CollateralSymbol = "cbBTC" | "WETH" | "cbZEC";
export type CollateralVenueId = "aave-v3" | "morpho-blue";

export type PriceFeedRef =
  | { kind: "chainlink"; address: Address; description: string; decimals: number }
  | { kind: "pyth"; contract: Address; priceId: `0x${string}`; description: string };

export interface CollateralAsset {
  symbol: CollateralSymbol;
  address: Address;
  decimals: number;
  /** Venue whose liquidation threshold / LTV drive this asset. Read live from it. */
  venue: CollateralVenueId;
  /** Venue contract to query for risk params (Aave: PoolDataProvider). */
  venueDataSource: Address;
  /** Price feed the UI and keeper use for display; the venue uses its own oracle. */
  feed: PriceFeedRef;
  enabled: boolean;
  /** Shown verbatim in the UI when enabled is false. */
  disabledReason?: string;
  /** Extra risk facts the UI must state (B20 rebase, peg, etc.). */
  riskNotes: readonly string[];
  /**
   * The form of ZEC (ZEC = Zcash's native coin) this row represents, when it represents one.
   * Present on exactly the rows that are a ZEC representation, absent on cbBTC and WETH.
   *
   * This pointer is what makes cbZEC *a* ZEC rather than *the* ZEC
   * (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §2): the form's own facts — custody, who can freeze
   * it, whether identity is required, which venue lends against it, why it is disabled — live once,
   * in `zecForms.ts`, next to the `verifiedIn` row that proves them. What this file adds is only
   * what is true of the row *as Base collateral*: the venue, the data source, the display feed.
   * `zecFormRowFaults()` below fails the suite if the two ever disagree.
   */
  zecForm?: ZecFormId;
}

export const COLLATERAL_ASSETS: Readonly<Record<CollateralSymbol, CollateralAsset>> = {
  cbBTC: {
    symbol: "cbBTC",
    address: BASE_TOKENS.cbBTC.address,
    decimals: BASE_TOKENS.cbBTC.decimals,
    venue: "aave-v3",
    venueDataSource: AAVE_V3.poolDataProvider,
    feed: { kind: "chainlink", ...CHAINLINK_FEEDS.cbBTC_USD },
    enabled: true,
    riskNotes: ["Custodial wrapper issued by Coinbase; issuer policy applies to the underlying BTC."],
  },
  WETH: {
    symbol: "WETH",
    address: BASE_TOKENS.WETH.address,
    decimals: BASE_TOKENS.WETH.decimals,
    venue: "aave-v3",
    venueDataSource: AAVE_V3.poolDataProvider,
    feed: { kind: "chainlink", ...CHAINLINK_FEEDS.ETH_USD },
    enabled: true,
    riskNotes: [],
  },
  cbZEC: {
    symbol: "cbZEC",
    address: BASE_TOKENS.cbZEC.address,
    decimals: BASE_TOKENS.cbZEC.decimals,
    venue: "aave-v3",
    venueDataSource: AAVE_V3.poolDataProvider,
    /**
     * Chainlink `ZEC / USD`, not Pyth — the founder's decision of 2026-09-13, "use chainlink zec/usd
     * exclusively until a cbZEC/USD source is available", which `ChainlinkOracleAdapter` implements
     * and which retired `PythOracleAdapter`. Before that day this row said Pyth because no Chainlink
     * ZEC feed was known to exist on Base; `VERIFIED-BASE-FACTS.md` Addendum 16 superseded that.
     *
     * Two hazards travel with this feed and both are carried in the data rather than in a comment:
     * it reports **18 decimals** where every other Chainlink feed here reports 8, so `decimals` must
     * be read and never assumed; and it prices **ZEC**, while the product holds **cbZEC**, so any
     * surface valuing cbZEC with it also owes the Aerodrome cbZEC/USDC cross-check the adapter does
     * on chain (its `PegBreak`). Stated in `riskNotes` below, because a user sees those.
     */
    feed: { kind: "chainlink", ...CHAINLINK_FEEDS.ZEC_USD },
    zecForm: "cbzec-base",
    // Derived, never retyped. Until 2026-09-15 this row kept its own copy and the copy had gone
    // wrong: it said cbZEC collateral was "Planned for v1.1 once the Oilskin cbZEC/USDC market
    // ships", which decision D3 of 2026-09-12 reversed — Oilskin does not create that market and
    // waits for an external one. A second copy of a reason is a second chance to be out of date.
    enabled: ZEC_FORMS["cbzec-base"].enabled,
    disabledReason: ZEC_FORMS["cbzec-base"].disabledReason,
    riskNotes: [
      ...ZEC_FORMS["cbzec-base"].riskNotes,
      // The form's own notes say what cbZEC is; this one says what *this registry* does with it,
      // which is a fact about Base collateral rather than about the form, and so belongs here.
      "Priced by Chainlink's ZEC/USD feed, which prices ZEC and not cbZEC: if the wrapper ever traded below ZEC, that feed would still quote ZEC's price and overvalue it. The on-chain oracle compares it against the Aerodrome cbZEC/USDC pool and refuses a price that has drifted too far; the feed's own aggregator has no usable circuit breaker of its own.",
    ],
  },
};

export const COLLATERAL_SYMBOLS: readonly CollateralSymbol[] = ["cbBTC", "WETH", "cbZEC"];

/** Assets a user may actually pick in v1. */
export function enabledCollateral(): CollateralAsset[] {
  return COLLATERAL_SYMBOLS.map((s) => COLLATERAL_ASSETS[s]).filter((a) => a.enabled);
}

export function collateralBySymbol(symbol: string): CollateralAsset | undefined {
  return (COLLATERAL_SYMBOLS as readonly string[]).includes(symbol)
    ? COLLATERAL_ASSETS[symbol as CollateralSymbol]
    : undefined;
}

export function collateralByAddress(address: string): CollateralAsset | undefined {
  const lower = String(address).toLowerCase();
  return COLLATERAL_SYMBOLS.map((s) => COLLATERAL_ASSETS[s]).find((a) => a.address.toLowerCase() === lower);
}

export function isCollateralSymbol(value: unknown): value is CollateralSymbol {
  return typeof value === "string" && (COLLATERAL_SYMBOLS as readonly string[]).includes(value);
}

export function tokenForCollateral(symbol: CollateralSymbol): (typeof BASE_TOKENS)[TokenSymbol] {
  return BASE_TOKENS[symbol];
}

// ---------------------------------------------------------------------------
// The seam to the ZEC form registry (`zecForms.ts`)
// ---------------------------------------------------------------------------

/**
 * Why `CollateralSymbol` was NOT widened to carry `ZecFormId`, which
 * `docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §2.3 rule 4 offered as the alternative and left to
 * whichever produced the smaller diff.
 *
 * `COLLATERAL_ASSETS` is the off-chain mirror of `CollateralRegistry.sol` **on Base**, and
 * `Record<CollateralSymbol, …>` is consumed as a Base table throughout: `tokenForCollateral` indexes
 * `BASE_TOKENS`, the keeper builds `venueOf` / `isEnabled` calls from it, the yield service reads
 * Aave reserves by it, the web builds multicalls from it. A key like `"zec-solana-bridged"` — a
 * Solana SPL mint with no Base address, no Aave reserve and no EVM venue — cannot mean anything in
 * those tables; widening the union would have put a category error into the type and then asked
 * roughly eighty consumer sites to exclude it again by hand.
 *
 * The pointer keeps the two registries in the shape each is actually in: `zecForms.ts` lists forms
 * of ZEC on any chain; this file lists what Base will take as collateral. A Base-chain form must
 * appear in both, and `zecFormRowFaults()` proves it did not drift. Adding a second Base ZEC wrapper
 * is: pin it in `BASE_TOKENS`, add its form row with `verifiedIn`, add its collateral row pointing
 * at that form. Nothing about it is blocked by this union being closed — `BASE_TOKENS` is the pin
 * that actually governs, and a Base token with no pinned address was never addable anyway.
 */

/** The ZEC form a collateral row represents, or undefined when the row is not a ZEC representation. */
export function zecFormForCollateral(symbol: CollateralSymbol): ZecForm | undefined {
  const id = COLLATERAL_ASSETS[symbol].zecForm;
  return id === undefined ? undefined : ZEC_FORMS[id];
}

/** The collateral row for a ZEC form, or undefined when Base holds no row for it (any Solana form). */
export function collateralForZecForm(id: ZecFormId): CollateralAsset | undefined {
  return COLLATERAL_SYMBOLS.map((s) => COLLATERAL_ASSETS[s]).find((a) => a.zecForm === id);
}

/** Every collateral row that represents some form of ZEC, in registry order. */
export function zecCollateral(): CollateralAsset[] {
  return COLLATERAL_SYMBOLS.map((s) => COLLATERAL_ASSETS[s]).filter((a) => a.zecForm !== undefined);
}

/**
 * Where the two registries disagree, as plain sentences (empty = they agree). The companion to
 * `zecFormRegistryFaults()` in `zecForms.ts`: that one checks a form row is well-formed, this one
 * checks Base's collateral table and the form registry still describe the same asset.
 *
 * Returned rather than thrown, for the same reason as there: a surface can report the fault instead
 * of white-screening on it. `collateral.test.ts` asserts the list is empty.
 */
export function zecFormRowFaults(): string[] {
  const faults: string[] = [];
  for (const symbol of COLLATERAL_SYMBOLS) {
    const a = COLLATERAL_ASSETS[symbol];
    if (a.zecForm === undefined) continue;
    const form = ZEC_FORMS[a.zecForm];
    if (form === undefined) {
      faults.push(`${symbol}: points at unknown ZEC form "${String(a.zecForm)}"`);
      continue;
    }
    if (form.chain !== "base") faults.push(`${symbol}: points at ${form.id}, whose chain is "${form.chain}"`);
    if (a.address.toLowerCase() !== form.assetRef.toLowerCase()) {
      faults.push(`${symbol}: address ${a.address} but ${form.id}.assetRef ${form.assetRef}`);
    }
    if (a.decimals !== form.decimals) faults.push(`${symbol}: decimals ${a.decimals} but ${form.id} says ${form.decimals}`);
    if (a.enabled !== form.enabled) faults.push(`${symbol}: enabled ${a.enabled} but ${form.id} says ${form.enabled}`);
    if (a.disabledReason !== form.disabledReason) faults.push(`${symbol}: disabledReason differs from ${form.id}'s`);
    for (const note of form.riskNotes) {
      if (!a.riskNotes.includes(note)) faults.push(`${symbol}: does not carry ${form.id}'s risk note "${note.slice(0, 40)}…"`);
    }
  }
  // The other direction, and the one that matters for a wrapper added later: a form that lives on
  // Base but that Base's collateral table has never heard of would be invisible to every surface
  // that reasons about collateral.
  for (const form of Object.values(ZEC_FORMS)) {
    if (form.chain !== "base") continue;
    const rows = COLLATERAL_SYMBOLS.filter((s) => COLLATERAL_ASSETS[s].zecForm === form.id);
    if (rows.length === 0) faults.push(`${form.id}: a Base form with no row in COLLATERAL_ASSETS`);
    if (rows.length > 1) faults.push(`${form.id}: claimed by ${rows.length} collateral rows (${rows.join(", ")})`);
  }
  return faults;
}

// ---------------------------------------------------------------------------
// Offered LTV — derived, never typed
// ---------------------------------------------------------------------------

/** A floor expressed in hundredths so the floor division is exact integer math. */
function floorHundredths(entryHfFloor: number): number {
  if (typeof entryHfFloor !== "number" || !Number.isFinite(entryHfFloor) || entryHfFloor <= 1) {
    throw new RangeError(`entryHfFloor must be a finite number > 1, got ${String(entryHfFloor)}`);
  }
  return Math.round(entryHfFloor * 100);
}

/**
 * Highest LTV the floor allows for an asset whose venue liquidation threshold is
 * `liquidationThresholdBps`: floor(LT / entryHfFloor), whole bps. There is no product cap any more
 * (founder, 2026-09-12: "remove the cap to the Aave limit") — the only other ceiling is the venue's
 * own max LTV, which `offeredLtvBounds` and `CollateralRegistry.maxOfferedLtvBps` apply. The floor
 * is the registry's (`entryHfFloorWad`, read live where a surface can); the shared ENTRY_HF_FLOOR is
 * the deploy default. Integer arithmetic: 7800 → 6240 and 8300 → 6640 at 1.25; 6000 → 3870 at 1.55.
 */
export function maxOfferedLtvBps(liquidationThresholdBps: number, entryHfFloor: number = ENTRY_HF_FLOOR): number {
  assertBps(liquidationThresholdBps, "liquidationThresholdBps");
  return Math.floor((liquidationThresholdBps * 100) / floorHundredths(entryHfFloor));
}

/**
 * Whole-percent "stop" for UI selectors: maxOfferedLtvBps floored to the
 * nearest 100 bps so web and prototypes round the same way.
 * 7000 → 5600 at 1.25; 7800 → 6200.
 */
export function maxOfferedLtvStopBps(liquidationThresholdBps: number, entryHfFloor: number = ENTRY_HF_FLOOR): number {
  return Math.floor(maxOfferedLtvBps(liquidationThresholdBps, entryHfFloor) / 100) * 100;
}

/** Which limit stops the slider (BUILD-PLAN-2026-09-12 §2b): named on screen, never silent. */
export type LtvBindingCap = "entry_hf_floor" | "venue_max_ltv";

/**
 * Where the risk slider stops on an asset: the largest LTV Oilskin offers, with the limit that
 * produced it — the registry floor (LT ÷ floor, whole bps) or the venue's own max LTV; nothing
 * else (the 50 % product cap was removed 2026-09-12). A tie names the floor. `minHf` is the entry
 * HF at that LTV (+∞ when nothing is offered, i.e. the venue's LTV is 0). The registry's own
 * `maxOfferedLtvBps` is the same min.
 */
export function offeredLtvBounds(
  liquidationThresholdBps: number,
  venueLtvBps: number,
  entryHfFloor: number = ENTRY_HF_FLOOR
): { maxLtvBps: number; minHf: number; binding: LtvBindingCap } {
  assertBps(liquidationThresholdBps, "liquidationThresholdBps");
  assertBps(venueLtvBps, "venueLtvBps");
  const byFloor = Math.floor((liquidationThresholdBps * 100) / floorHundredths(entryHfFloor));
  const candidates: readonly (readonly [LtvBindingCap, number])[] = [
    ["entry_hf_floor", byFloor],
    ["venue_max_ltv", venueLtvBps],
  ];
  let best = candidates[0]!;
  for (const c of candidates) if (c[1] < best[1]) best = c;
  return { maxLtvBps: best[1], minHf: entryHfAtLtvBps(liquidationThresholdBps, best[1]), binding: best[0] };
}

export type LtvPresetId = "p30" | "p40" | "top";

export interface LtvPreset {
  id: LtvPresetId;
  label: string;
  ltvBps: number;
  /** ltvBps floored to a whole percent (nearest 100 bps) — what a selector displays. */
  ltvStopBps: number;
  /** false when this LTV would open below the entry floor for this asset. */
  offerable: boolean;
  /** LT / LTV. null when ltvBps is 0 (asset unlisted). */
  entryHf: number | null;
  /** Collateral price drop (%) at which liquidation begins. */
  liquidationDropPct: number;
}

/** Fixed rungs of the LTV selector. The third preset is computed per asset. */
export const LTV_PRESET_FIXED_BPS = { p30: 3000, p40: 4000 } as const;

/**
 * The three LTV choices for an asset: 30 %, 40 %, and the per-asset top
 * (= maxOfferedLtvBps). Each carries `offerable` and its computed entry HF.
 * cbBTC (LT 7800) → top 5000; WETH (8300) → 5000; a 6000-LT asset → 3870.
 */
export function ltvPresets(liquidationThresholdBps: number, entryHfFloor: number = ENTRY_HF_FLOOR): LtvPreset[] {
  const max = maxOfferedLtvBps(liquidationThresholdBps, entryHfFloor);
  const make = (id: LtvPresetId, ltvBps: number): LtvPreset => ({
    id,
    label: id === "top" ? "Top" : `${ltvBps / 100}%`,
    ltvBps,
    ltvStopBps: Math.floor(ltvBps / 100) * 100,
    offerable: ltvBps > 0 && ltvBps <= max,
    entryHf: ltvBps === 0 ? null : entryHfForLtv(liquidationThresholdBps, ltvBps),
    liquidationDropPct: liquidationDropPct(liquidationThresholdBps, ltvBps),
  });
  return [make("p30", LTV_PRESET_FIXED_BPS.p30), make("p40", LTV_PRESET_FIXED_BPS.p40), make("top", max)];
}

/** Is a user-chosen LTV within what we offer for this asset? */
export function isOfferableLtv(liquidationThresholdBps: number, ltvBps: number, entryHfFloor: number = ENTRY_HF_FLOOR): boolean {
  assertBps(ltvBps, "ltvBps");
  return ltvBps > 0 && ltvBps <= maxOfferedLtvBps(liquidationThresholdBps, entryHfFloor);
}
