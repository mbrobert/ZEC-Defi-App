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
import { ENTRY_HF_FLOOR, entryHfForLtv, liquidationDropPct, assertBps, entryHfAtLtvBps } from "./health.js";

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
