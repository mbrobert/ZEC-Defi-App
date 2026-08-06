import type { CuratedPool } from "./types.js";

/**
 * Curated pool registry (v3 — every entry VERIFIED against the live engine).
 *
 * On 2026-08-06 we enumerated the MaxFi/Snuggle engine's on-chain
 * `approvedPools` registry (vault proxy 0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55,
 * Base): 206 approved pools, 47 on major pairs. Each entry below carries the
 * engine's bytes32 `enginePoolId` (what depositSingleSided takes) and the
 * underlying `poolAddress`, both read from that registry.
 *
 * Liquidity context (GeckoTerminal snapshot 2026-08-05): Uni WETH/USDC 0.05%
 * ~$114M TVL / ~$46M day; Aero cbBTC/USDC ~$72M day; Aero WETH/USDC ~$42M day.
 * Figures drift — they are selection rationale, not display data.
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
    feeTierBps: 5,
    entryAsset: "USDC",
    riskTag: "BLUE_CHIP",
    description:
      "Highest-volume BTC pool on Base (~$72M/day) — outstanding fee capture per dollar.",
    poolAddress: "0x4e962bb3889bf030368f56810a9c96b83cb3e778",
    enginePoolId: "0xb1830be2f9077713501ee7b52c92f6c8307ea8ceb16309d1f7fb1ad2643837e6",
  },
  {
    id: "aero-usdc-weth-5",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "WETH",
    token1: "USDC",
    feeTierBps: 5,
    entryAsset: "USDC",
    riskTag: "BLUE_CHIP",
    description:
      "Aerodrome's flagship ETH pool (~$10M TVL, ~$42M/day). High volume-to-TVL ratio.",
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
    description:
      "0.30% BTC pool — wider effective ranges, calmer companion to the tight cbBTC venue.",
    poolAddress: "0xec558e484cc9f2210714e345298fdc53b253c27d",
    enginePoolId: "0xdf0833111a892124c686f451f63fd1a091a082c40239bf6904b89a6dc3d0cfce",
  },
  {
    id: "aero-usdt-usdc",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "USDT",
    token1: "USDC",
    feeTierBps: 1,
    entryAsset: "USDC",
    riskTag: "STABLE",
    description:
      "Stable/stable (~$6.5M/day) — minimal IL, single-tick ranges viable.",
    poolAddress: "0xd56da2b74ba826f19015e6b7dd9dae1903e85da1",
    enginePoolId: "0x340448ede292a520b375b6a70455b662b943ea368c05bb261d9c584e8def8f48",
  },
  {
    id: "cbeth-weth",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "cbETH",
    token1: "WETH",
    feeTierBps: 1,
    entryAsset: "WETH",
    riskTag: "STABLE",
    description:
      "Correlated LST pair — cbETH/WETH tracks the staking rate, near-zero IL. Conservative WETH entry.",
    poolAddress: "0xa9dafa443a02fbc907cb0093276b3e6f4ef02a46",
    enginePoolId: "0x81360d12bc3f67f51051cc7c7b14457d30d2490ba7b71be47468982781ec4e71",
  },
  {
    id: "aero-aero-weth",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "WETH",
    token1: "AERO",
    feeTierBps: 30,
    entryAsset: "WETH",
    riskTag: "VOLATILE",
    description:
      "Incentivized AERO pair (~$2.6M/day) — higher APR, real volatility.",
    poolAddress: "0x82321f3beb69f503380d6b233857d5c43562e2d0",
    enginePoolId: "0x6d9490cf9c55426c33c1259073a54bcd6ac78bc43d62796ac62154188ee4c1d1",
  },
  {
    id: "aero-aero-cbbtc",
    protocol: "SNUGGLEFI",
    dex: "AERODROME",
    token0: "AERO",
    token1: "cbBTC",
    feeTierBps: 30,
    entryAsset: "cbBTC",
    riskTag: "VOLATILE",
    description:
      "AERO against BTC (~$2.4M/day) — for cbBTC borrowers chasing incentives.",
    poolAddress: "0xdfe5f275020def30993f042174fc2d335678b626",
    enginePoolId: "0xa893d6d3bc3a29d7424223766ebfb8aed8d3b1ec5329d3ae1d7624b0e96d9bfc",
  },
];

/**
 * Registry-wide facts from the 2026-08-06 enumeration:
 *   • 206 approved pools, all active; 47 on major pairs
 *   • also engine-supported (not curated v1): EURC/USDC (4 venues), WETH/EURC,
 *     EURC/cbBTC, cbETH/cbBTC, WETH/wstETH — natural expansion candidates
 *   • USDT/WETH is NOT in the registry (dropped from our list for that reason)
 *   • a handful of entries share pool 0xd0b53d92… with fee=9999 — anomalous
 *     placeholder rows we exclude; re-verify against a fresh enumeration
 */
export const ENGINE_REGISTRY_SNAPSHOT = {
  vaultProxy: "0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55",
  enumeratedAt: "2026-08-06",
  totalPools: 206,
  majorPairPools: 47,
} as const;

export function poolById(id: string): CuratedPool | undefined {
  return CURATED_POOLS.find((p) => p.id === id);
}

export function poolsForEntryAsset(asset: CuratedPool["entryAsset"]): CuratedPool[] {
  return CURATED_POOLS.filter((p) => p.entryAsset === asset);
}
