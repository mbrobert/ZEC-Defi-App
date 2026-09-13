import type { CuratedPool } from "./types.js";
import { AERODROME } from "./base.js";

/**
 * Curated pool registry (v4 — every entry VERIFIED against the live engine).
 *
 * Re-enumerated 2026-08-27 (vault proxy
 * 0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55, Base): 209 approved pools,
 * 63 active on Aerodrome Slipstream. Each entry carries the engine's bytes32
 * `enginePoolId` (what depositSingleSided takes) and the underlying
 * `poolAddress`, both read from that registry via approvedPools(bytes32).
 *
 * v4 changes (Matt's calls 2026-08-27):
 *   • v1 product menu = the 8 AERODROME entries only (Snuggle-staked, earn
 *     AERO in lieu of trading fees). Uniswap entries stay recorded for the
 *     backfill/history pipeline but are NOT offered in either UI.
 *   • cbeth-weth CORRECTED: the old entry pointed at a different venue's
 *     pool (0xa9dafa…/0x81360d12…); the engine-registry pool for the pair is
 *     0x47ca96ea…/0xcfdea513… (verified active on-chain 2026-08-28).
 *   • aero-usdt-usdc CORRECTED the same way: 0xd56da2b7…/0x340448ed… →
 *     0xa41bc0af…/0x0ff8167e… (verified active on-chain 2026-08-28).
 *   • NEW: aero-weth-cbbtc, aero-weth-link (blue-chip additions).
 *   • Aerodrome Slipstream fees are DYNAMIC (pool.fee() moves with
 *     volatility). `feeTierBps` for AERODROME entries is the on-chain fee()
 *     sampled 2026-08-27 — refresh it when re-sampling, and prefer reading
 *     fee() live where possible. Uniswap tiers are static.
 *
 * Note: the `dex` tag is best-effort for display; the engine abstracts the
 * venue via its per-pool position adapters, and `enginePoolId` is the only
 * identifier deposits actually use.
 */
export const CURATED_POOLS: CuratedPool[] = [
  {
    id: "uni-weth-usdc-5",
    protocol: "MAXFI",
    dex: "UNISWAP_V3",
    token0: "WETH",
    token1: "USDC",
    feeTierBps: 5,
    entryAsset: "USDC",
    riskTag: "BLUE_CHIP",
    pairClass: "UNCORRELATED",
    description:
      "The deepest pool on Base (~$114M TVL, ~$46M/day). Workhorse ETH exposure with maximum depth.",
    poolAddress: "0xd0b53d9277642d899df5c87a3966a349a798f224",
    enginePoolId: "0x12fc2fd09d3d3bfeca3b2a731167f3740c3a543755afa8d0d93fd95889e41796",
  },
  {
    id: "aero-cbbtc-usdc",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "USDC",
    token1: "cbBTC",
    feeTierBps: 4.4, // dynamic — on-chain fee() 0.044%, sampled 2026-08-27
    entryAsset: "USDC",
    riskTag: "BLUE_CHIP",
    pairClass: "UNCORRELATED",
    description:
      "Hardest-working BTC pool on Base ($5.7M TVL, $21.1M/day sampled 2026-08-27) — outstanding fee capture per dollar.",
    poolAddress: "0x4e962bb3889bf030368f56810a9c96b83cb3e778",
    enginePoolId: "0xb1830be2f9077713501ee7b52c92f6c8307ea8ceb16309d1f7fb1ad2643837e6",
  },
  {
    id: "aero-usdc-weth-5",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "WETH",
    token1: "USDC",
    feeTierBps: 5.6, // dynamic — on-chain fee() 0.056%, sampled 2026-08-27
    entryAsset: "USDC",
    riskTag: "BLUE_CHIP",
    pairClass: "UNCORRELATED",
    description:
      "Aerodrome's flagship ETH pool ($8.8M TVL, $31.8M/day sampled 2026-08-27). High volume-to-TVL ratio.",
    poolAddress: "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59",
    enginePoolId: "0x0ea72f44ccaf524e3fda5e4a6682fda7a79e42dc2858ee27be311e9337aa72a8",
  },
  {
    id: "uni-cbbtc-weth-30",
    protocol: "MAXFI",
    dex: "UNISWAP_V3",
    token0: "WETH",
    token1: "cbBTC",
    feeTierBps: 30,
    entryAsset: "cbBTC",
    riskTag: "BLUE_CHIP",
    pairClass: "CORRELATED",
    description:
      "ETH/BTC ratio pair (~$5M TVL, ~$13M/day) — correlated majors, softer IL profile.",
    poolAddress: "0x8c7080564b5a792a33ef2fd473fba6364d5495e5",
    enginePoolId: "0xd00032c5356ba77952924467593bd81eb2d0fee239d8ac8ca15873f1453095e1",
  },
  {
    id: "uni-usdc-weth-30",
    protocol: "MAXFI",
    dex: "UNISWAP_V3",
    token0: "WETH",
    token1: "USDC",
    feeTierBps: 30,
    entryAsset: "USDC",
    riskTag: "BLUE_CHIP",
    pairClass: "UNCORRELATED",
    description:
      "Secondary Uni ETH pool (~$10M TVL, ~$9M/day) at the 0.30% tier — higher fee per trade.",
    poolAddress: "0x6c561b446416e1a00e8e93e221854d6ea4171372",
    enginePoolId: "0x022308ba60b98b6699d60756ceb9f1a231ad765711a6cb9ddc445cee23e9c5b6",
  },
  {
    id: "uni-usdc-cbbtc-30",
    protocol: "MAXFI",
    dex: "UNISWAP_V3",
    token0: "USDC",
    token1: "cbBTC",
    feeTierBps: 30,
    entryAsset: "USDC",
    riskTag: "BLUE_CHIP",
    pairClass: "UNCORRELATED",
    description:
      "0.30% BTC pool — wider effective ranges, calmer companion to the tight cbBTC venue.",
    poolAddress: "0xec558e484cc9f2210714e345298fdc53b253c27d",
    enginePoolId: "0xdf0833111a892124c686f451f63fd1a091a082c40239bf6904b89a6dc3d0cfce",
  },
  {
    id: "aero-weth-cbbtc",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "WETH",
    token1: "cbBTC",
    feeTierBps: 25.3, // dynamic — on-chain fee() 0.253%, sampled 2026-08-27
    entryAsset: "cbBTC",
    riskTag: "BLUE_CHIP",
    pairClass: "CORRELATED",
    description:
      "ETH/BTC ratio pair ($15.4M TVL, $5.5M/day sampled 2026-08-27) — correlated majors, softer IL profile.",
    poolAddress: "0x70acdf2ad0bf2402c957154f944c19ef4e1cbae1",
    enginePoolId: "0xc97cb5ca633aa7364b3c5789cb0b59b6de362ec48a09b5e4c8e805cedd99c35f",
  },
  {
    id: "aero-weth-link",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "WETH",
    token1: "LINK",
    feeTierBps: 25, // dynamic — on-chain fee() 0.25%, sampled 2026-08-27
    entryAsset: "WETH",
    riskTag: "BLUE_CHIP",
    pairClass: "UNCORRELATED",
    description:
      "Top-15 LINK against ETH ($1.7M TVL, $0.6M/day sampled 2026-08-27) — the only blue-chip LINK venue the engine supports.",
    poolAddress: "0x72be417afb0abea66913141c605d313bb389b59c",
    enginePoolId: "0x477c2374e9cc1a6d42b8ad7a59ffbc2769932d7f659162824276c0b396f7ab24",
  },
  {
    id: "aero-usdt-usdc",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "USDT",
    token1: "USDC",
    feeTierBps: 0.1, // dynamic — on-chain fee() 0.001%, sampled 2026-08-27
    entryAsset: "USDC",
    riskTag: "STABLE",
    pairClass: "CORRELATED",
    description:
      "Stable/stable ($1.3M TVL, $3.7M/day sampled 2026-08-27) — minimal IL, thin fees.",
    poolAddress: "0xa41bc0affba7fd420d186b84899d7ab2ac57fcd1",
    enginePoolId: "0x0ff8167e00d9a34d07034a4a6a8a6dec2ef8caffca0a5178ec940f7fb76babd7",
  },
  {
    id: "cbeth-weth",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "cbETH",
    token1: "WETH",
    feeTierBps: 0.7, // dynamic — on-chain fee() 0.007%, sampled 2026-08-27
    entryAsset: "WETH",
    riskTag: "STABLE",
    pairClass: "CORRELATED",
    description:
      "Correlated LST pair ($3.7M TVL, $5.9M/day sampled 2026-08-27) — tracks the staking rate, near-zero IL. Conservative WETH entry.",
    poolAddress: "0x47ca96ea59c13f72745928887f84c9f52c3d7348",
    enginePoolId: "0xcfdea513927b5d64e00e0096e4263b6b67f4e209017f1dde6f9f82856805d419",
  },
  {
    id: "aero-aero-weth",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "WETH",
    token1: "AERO",
    feeTierBps: 30, // dynamic — on-chain fee() 0.30%, sampled 2026-08-27 (the old "1%" label was wrong)
    entryAsset: "WETH",
    riskTag: "VOLATILE",
    pairClass: "UNCORRELATED",
    description:
      "The venue's own token ($1.4M TVL, $1.1M/day sampled 2026-08-27) — big sampled fees, brutal IL.",
    poolAddress: "0x82321f3beb69f503380d6b233857d5c43562e2d0",
    enginePoolId: "0x6d9490cf9c55426c33c1259073a54bcd6ac78bc43d62796ac62154188ee4c1d1",
  },
  {
    id: "aero-aero-cbbtc",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "AERO",
    token1: "cbBTC",
    feeTierBps: 7.5, // dynamic — on-chain fee() 0.075%, sampled 2026-08-27 (the old "0.6%" label was wrong)
    entryAsset: "cbBTC",
    riskTag: "VOLATILE",
    pairClass: "UNCORRELATED",
    description:
      "AERO against BTC ($1.3M TVL, $3.9M/day sampled 2026-08-27) — extreme sampled fees on thin TVL, brutal IL.",
    poolAddress: "0xdfe5f275020def30993f042174fc2d335678b626",
    enginePoolId: "0xa893d6d3bc3a29d7424223766ebfb8aed8d3b1ec5329d3ae1d7624b0e96d9bfc",
  },
  {
    /**
     * DIRECT: held through Oilskin's own `SlipstreamLpVenue` on the pool's second-deployment
     * position manager and gauge (docs/CBZEC-PATH-2026-09.md option 1, decided 2026-09-10, built
     * 2026-09-11) — the engine does not list this pool and the verified SwapRouter cannot reach
     * it. Its gauge received its first emissions vote in the epoch that began 2026-09-10
     * (VERIFIED-BASE-FACTS Addendum 8); the vote is re-cast every epoch, so the yield service reads
     * `rewardRate()` / `periodFinish()` live and refuses the pool whenever the epoch has no vote.
     * Not in the Snuggle engine registry (no enginePoolId): its LP pool id is the pool address,
     * left-padded (`directPoolId`).
     */
    id: "aero-cbzec-usdc",
    protocol: "DIRECT",
    dex: "AERODROME",
    token0: AERODROME.pools.cbZEC_USDC.token0,
    token1: AERODROME.pools.cbZEC_USDC.token1,
    feeTierBps: AERODROME.pools.cbZEC_USDC.feePips / 100, // 2000 pips = 0.2% = 20 bps; dynamic — read fee() live
    entryAsset: "USDC",
    riskTag: "VOLATILE",
    pairClass: "UNCORRELATED",
    description:
      "cbZEC against USDC on Aerodrome Slipstream, held directly (no engine, no engine fee): a two-sided range centred on the price and staked in the pool's gauge for AERO. The gauge's emissions are voted epoch by epoch; the pool itself (~$0.9M on 2026-09-10) is the depth.",
    poolAddress: AERODROME.pools.cbZEC_USDC.address,
    gauge: AERODROME.pools.cbZEC_USDC.gauge,
    tickSpacing: AERODROME.pools.cbZEC_USDC.tickSpacing,
    note:
      "Emissions here exist only while the weekly Aerodrome vote sends them (first vote: the epoch of 2026-09-10; re-voted every Thursday) — the gate reads the gauge live and refuses this pool in any epoch without one. The range is static: if the price leaves it the position earns nothing until closed and re-opened. Unstaking within ten seconds of staking forfeits all AERO earned to Aerodrome's minter (gauge factory, read 2026-09-11). cbZEC is a Coinbase B20 token the issuer can pause or block.",
  },
];

/**
 * The LP pool id a router `openLeveragedLp` / venue `open` takes for a curated pool: the engine's
 * bytes32 for an engine pool, the pool address left-padded to 32 bytes for a DIRECT pool
 * (`SlipstreamLpVenue.POOL_ID`). Undefined for a pool the product cannot open on either venue.
 */
export function lpPoolId(pool: CuratedPool): `0x${string}` | undefined {
  if (pool.enginePoolId) return pool.enginePoolId as `0x${string}`;
  if (pool.protocol === "DIRECT" && pool.poolAddress) return directPoolId(pool.poolAddress);
  return undefined;
}

/** `bytes32(uint256(uint160(pool)))` — how the direct venue names its one pool. */
export function directPoolId(poolAddress: string): `0x${string}` {
  const hex = poolAddress.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new RangeError(`not an address: ${poolAddress}`);
  return `0x${"0".repeat(24)}${hex}`;
}

/** The pool a direct pool id names, if it is a curated DIRECT pool. */
export function poolByLpPoolId(id: string): CuratedPool | undefined {
  const k = id.toLowerCase();
  return CURATED_POOLS.find((p) => lpPoolId(p)?.toLowerCase() === k);
}

/** Pools the engine (Snuggle/MaxFi) can deposit into — every entry has an enginePoolId. */
export function enginePools(): CuratedPool[] {
  return CURATED_POOLS.filter((p) => p.protocol !== "DIRECT" && !!p.enginePoolId);
}

/** Pools we hold directly on Aerodrome (no engine). */
export function directPools(): CuratedPool[] {
  return CURATED_POOLS.filter((p) => p.protocol === "DIRECT");
}

/** The engine menu: Aerodrome pools reachable through the Snuggle engine (the eight the prototypes model). */
export function offerablePools(): CuratedPool[] {
  return CURATED_POOLS.filter((p) => p.dex === "AERODROME" && p.protocol !== "DIRECT" && !!p.enginePoolId);
}

/**
 * Every pool the product can open an LP position in: the engine menu plus the DIRECT pools held
 * through `SlipstreamLpVenue` (2026-09-11). Whether any of them is OFFERED on a given day is the
 * yield forecast, read live — this is the list the service prices (and its gate is asked about).
 */
export function lpMenu(): CuratedPool[] {
  return [...offerablePools(), ...directPools().filter((p) => !!p.poolAddress)];
}

/**
 * Registry-wide facts from the 2026-08-27 re-enumeration (Multicall3-batched):
 *   • 209 approved pools; factories: Aerodrome Slipstream 63 active,
 *     Uniswap V3 52, Pancake 15; 67 distinct tokens
 *   • blue-chip Aerodrome qualifiers (both tokens top-50 by market cap,
 *     wrapped forms mapped): 13 pools — the 8 curated above plus thin-TVL
 *     cbETH/cbBTC, cbADA/cbBTC, WETH/cbADA, cbLTC/cbBTC and the dead
 *     WETH/cbXRP ($1 TVL — excluded); full research table in docs/POOLS.md
 *   • borderline (excluded from "blue chip"): AERO pairs (venue token, not
 *     top-50), EURC pairs (fiat-backed, not ranked)
 *   • USDT/WETH is NOT in the registry (dropped from our list for that reason)
 */
export const ENGINE_REGISTRY_SNAPSHOT = {
  vaultProxy: "0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55",
  enumeratedAt: "2026-08-27",
  totalPools: 209,
  activeAerodromePools: 63,
} as const;

export function poolById(id: string): CuratedPool | undefined {
  return CURATED_POOLS.find((p) => p.id === id);
}

export function poolsForEntryAsset(asset: CuratedPool["entryAsset"]): CuratedPool[] {
  return CURATED_POOLS.filter((p) => p.entryAsset === asset);
}

/**
 * Every curated pool CONTAINING the asset on either side — what the deposit
 * wizard lists (feedback 2026-08-13: borrowing WETH must surface WETH/USDC,
 * cbBTC/WETH, cbETH/WETH and AERO/WETH, not just pools whose entry asset is
 * WETH). Single-sided entry via the engine's depositSingleSided makes any
 * side a valid entry.
 */
export function poolsContainingAsset(asset: CuratedPool["token0"] | CuratedPool["token1"]): CuratedPool[] {
  return CURATED_POOLS.filter((p) => p.token0 === asset || p.token1 === asset);
}
