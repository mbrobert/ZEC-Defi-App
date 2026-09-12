/**
 * Collateral registry (off-chain mirror of CollateralRegistry.sol).
 *
 * Deliberately carries NO liquidation threshold, NO LTV, NO health factor.
 * Those are read from the venue at call time and passed into the pure
 * functions below. The only typed numbers here are token decimals and the
 * product policy constants (ENTRY_HF_FLOOR via health.ts, the 50% cap).
 */
import { AAVE_V3, BASE_TOKENS, CHAINLINK_FEEDS, PYTH, type TokenSymbol } from "./base.js";
import type { Address } from "./evm.js";
import { ENTRY_HF_FLOOR, entryHfForLtv, liquidationDropPct, assertBps } from "./health.js";

export type CollateralSymbol = "cbBTC" | "WETH" | "cbZEC";
export type CollateralVenueId = "aave-v3" | "morpho-blue";

export type PriceFeedRef =
  | { kind: "chainlink"; address: Address; description: string; decimals: 8 }
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
    feed: {
      kind: "pyth",
      contract: PYTH.contract,
      priceId: PYTH.priceIds.ZEC_USD,
      description: "Crypto.ZEC/USD (pull-based; stale unless updated in-tx)",
    },
    enabled: false,
    disabledReason:
      "No lending market accepts cbZEC as collateral on Base yet (not listed on Aave v3, no Morpho market). Planned for v1.1 once the Oilskin cbZEC/USDC market ships.",
    riskNotes: [
      "B20 precompile: balances can rebase via a live multiplier and transfers can be blocked by the issuer.",
      "No Chainlink feed; Pyth price is only as fresh as the last posted update.",
      "Thin DEX depth (~$0.7M) — peg to ZEC can break under stress.",
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
// Offered LTV — derived, never typed
// ---------------------------------------------------------------------------

/** Product-wide ceiling on the LTV we will ever offer, whatever the venue allows. */
export const MAX_OFFERED_LTV_CAP_BPS = 5000;

/** A floor expressed in hundredths so the floor division is exact integer math. */
function floorHundredths(entryHfFloor: number): number {
  if (typeof entryHfFloor !== "number" || !Number.isFinite(entryHfFloor) || entryHfFloor <= 1) {
    throw new RangeError(`entryHfFloor must be a finite number > 1, got ${String(entryHfFloor)}`);
  }
  return Math.round(entryHfFloor * 100);
}

/**
 * Highest LTV we offer for an asset whose venue liquidation threshold is
 * `liquidationThresholdBps`: min(cap, floor(LT / entryHfFloor)). The floor is the registry's
 * (`entryHfFloorWad`, read live where a surface can); the shared ENTRY_HF_FLOOR is the deploy
 * default. Integer arithmetic so 7800 → 5032 → 5000 and 6000 → 3870 exactly at 1.55.
 * Mirrors CollateralRegistry.maxOfferedLtvBps on-chain.
 */
export function maxOfferedLtvBps(liquidationThresholdBps: number, entryHfFloor: number = ENTRY_HF_FLOOR): number {
  assertBps(liquidationThresholdBps, "liquidationThresholdBps");
  const derived = Math.floor((liquidationThresholdBps * 100) / floorHundredths(entryHfFloor));
  return Math.min(MAX_OFFERED_LTV_CAP_BPS, derived);
}

/**
 * Whole-percent "stop" for UI selectors: maxOfferedLtvBps floored to the
 * nearest 100 bps so web and prototypes round the same way.
 * 7000 → 4516 → 4500; 7800 → 5000.
 */
export function maxOfferedLtvStopBps(liquidationThresholdBps: number, entryHfFloor: number = ENTRY_HF_FLOOR): number {
  return Math.floor(maxOfferedLtvBps(liquidationThresholdBps, entryHfFloor) / 100) * 100;
}

export type LtvPresetId = "p30" | "p40" | "top";

export interface LtvPreset {
  id: LtvPresetId;
  label: string;
  ltvBps: number;
  /** ltvBps floored to a whole percent (nearest 100 bps) — what a selector displays. */
  ltvStopBps: number;
  /** false when this LTV would open below ENTRY_HF_FLOOR for this asset. */
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
