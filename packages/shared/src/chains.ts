/**
 * Per-chain address tables (slice 6, 2026-09-10). Base mainnet (8453) is the product; Base Sepolia
 * (84532) exists so the keeper and the web can be pointed at a testnet deployment WITHOUT silently
 * reading mainnet addresses — the failure the 2026-09-07 audit's S-MED-1 described.
 *
 * SOURCE OF TRUTH: docs/VERIFIED-BASE-FACTS.md — the top sections for 8453 (unchanged objects from
 * base.ts), the "Base Sepolia" addenda (read 2026-09-07, blocks 46,488,145 and 46,512,825) for
 * 84532; the Sepolia constants are the ones `contracts/script/DeploySepolia.s.sol`
 * (`BaseSepoliaAddresses`) deploys against, and `contracts/test/DeploySepolia.t.sol` pins them to
 * the facts document.
 *
 * What a Sepolia run proves, and what it cannot: real Aave v3 (its own test USDC and test WBTC,
 * the WETH predeploy), real Chainlink BTC/ETH/USDC feeds, real Pyth, Permit2, Multicall3, Morpho
 * Blue (no markets). There is NO cbBTC — Aave's test WBTC stands in under the cbBTC role — NO
 * cbZEC and NO AERO (DeploySepolia deploys doubles whose addresses are deploy-time facts, supplied
 * by env and refused by name when missing), NO Aerodrome and NO MaxFi/Snuggle engine (mocks).
 * Nothing read on Sepolia says anything about the live engine, the live Slipstream router, or
 * cbBTC's own feed.
 */
import { AAVE_V3, BASE_TOKENS, CHAINLINK_FEEDS, MORPHO_BLUE, PERMIT2, PYTH, type ChainlinkFeed, type TokenInfo, type TokenSymbol } from "./base.js";
import { COLLATERAL_ASSETS, COLLATERAL_SYMBOLS, type CollateralAsset, type CollateralSymbol } from "./collateral.js";
import { toChecksumAddress, type Address } from "./evm.js";

export type SupportedChainId = 8453 | 84532;
export const SUPPORTED_CHAIN_IDS: readonly SupportedChainId[] = [8453, 84532];

export interface ChainAave {
  poolAddressesProvider: Address;
  pool: Address;
  poolDataProvider: Address;
  oracle: Address;
}

export interface ChainFeeds {
  BTC_USD: ChainlinkFeed;
  ETH_USD: ChainlinkFeed;
  USDC_USD: ChainlinkFeed;
  /** Base mainnet has a cbBTC/USD feed; Base Sepolia has none (the WBTC stand-in IS BTC there). */
  cbBTC_USD: ChainlinkFeed | null;
}

export interface ChainTable {
  id: SupportedChainId;
  name: string;
  explorerUrl: string;
  /** Public read endpoint, no key; the operator overrides it per deploy. */
  rpcDefault: string;
  /**
   * Tokens by the ROLE they play in the product. `null` = no fixed address on this chain: a
   * deploy-time double that `resolveTokens` must be given, or refuses by name.
   */
  tokens: Readonly<Record<TokenSymbol, TokenInfo | null>>;
  aave: ChainAave;
  aaveReserves: readonly TokenSymbol[];
  feeds: ChainFeeds;
  /** The Chainlink feed the keeper and the web price each Aave-listed collateral by. */
  collateralFeeds: Readonly<Record<"cbBTC" | "WETH", ChainlinkFeed>>;
  pyth: Address;
  permit2: Address;
  morphoBlue: Address;
  multicall3: Address;
  /** What a run on this chain proves and does not; logged at keeper start, shown by the web. */
  notes: readonly string[];
}

const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

const BASE_MAINNET: ChainTable = {
  id: 8453,
  name: "Base",
  explorerUrl: "https://basescan.org",
  rpcDefault: "https://mainnet.base.org",
  tokens: BASE_TOKENS,
  aave: {
    poolAddressesProvider: AAVE_V3.poolAddressesProvider,
    pool: AAVE_V3.pool,
    poolDataProvider: AAVE_V3.poolDataProvider,
    oracle: AAVE_V3.oracle,
  },
  aaveReserves: ["cbBTC", "WETH", "USDC"],
  feeds: {
    BTC_USD: CHAINLINK_FEEDS.BTC_USD,
    ETH_USD: CHAINLINK_FEEDS.ETH_USD,
    USDC_USD: CHAINLINK_FEEDS.USDC_USD,
    cbBTC_USD: CHAINLINK_FEEDS.cbBTC_USD,
  },
  collateralFeeds: { cbBTC: CHAINLINK_FEEDS.cbBTC_USD, WETH: CHAINLINK_FEEDS.ETH_USD },
  pyth: PYTH.contract,
  permit2: PERMIT2,
  morphoBlue: MORPHO_BLUE.address,
  multicall3: MULTICALL3,
  notes: ["The product chain: every address here is in docs/VERIFIED-BASE-FACTS.md and is what the contracts deploy against."],
};

const SEPOLIA_BTC_USD: ChainlinkFeed = { description: "BTC / USD", address: "0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298", decimals: 8 };
const SEPOLIA_ETH_USD: ChainlinkFeed = { description: "ETH / USD", address: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1", decimals: 8 };
const SEPOLIA_USDC_USD: ChainlinkFeed = { description: "USDC / USD", address: "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165", decimals: 8 };

const BASE_SEPOLIA: ChainTable = {
  id: 84532,
  name: "Base Sepolia",
  explorerUrl: "https://sepolia.basescan.org",
  rpcDefault: "https://sepolia.base.org",
  tokens: {
    USDC: {
      symbol: "USDC",
      name: "USDC (Aave's Base Sepolia test token — the reserve its pool lends; NOT Circle's testnet USDC)",
      address: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
      decimals: 6,
      kind: "erc20",
    },
    WETH: { symbol: "WETH", name: "Wrapped Ether", address: "0x4200000000000000000000000000000000000006", decimals: 18, kind: "erc20" },
    cbBTC: {
      symbol: "cbBTC",
      name: "WBTC (Aave's test token, standing in for cbBTC — collateral-enabled, not borrowable)",
      address: "0x54114591963CF60EF3aA63bEfD6eC263D98145a4",
      decimals: 8,
      kind: "erc20",
    },
    cbZEC: null,
    AERO: null,
  },
  aave: {
    poolAddressesProvider: "0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00",
    pool: "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27",
    poolDataProvider: "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b",
    oracle: "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF",
  },
  aaveReserves: ["cbBTC", "WETH", "USDC"],
  feeds: { BTC_USD: SEPOLIA_BTC_USD, ETH_USD: SEPOLIA_ETH_USD, USDC_USD: SEPOLIA_USDC_USD, cbBTC_USD: null },
  collateralFeeds: { cbBTC: SEPOLIA_BTC_USD, WETH: SEPOLIA_ETH_USD },
  pyth: "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729",
  permit2: PERMIT2,
  morphoBlue: MORPHO_BLUE.address,
  multicall3: MULTICALL3,
  notes: [
    "Base Sepolia is a rehearsal chain: real Aave v3 (test USDC, test WBTC standing in for cbBTC, WETH), real Chainlink BTC/ETH/USDC feeds (1,200 s heartbeats, not mainnet's), real Pyth (nobody pushes ZEC/USD there), Permit2, Multicall3, Morpho Blue with no market.",
    "It proves the account → factory → registry → AaveV3Venue → router path and the keeper's Aave valuation end to end; it proves NOTHING about the live MaxFi/Snuggle engine, the live Aerodrome Slipstream router, cbBTC, cbZEC or AERO — those are mocks or absent (docs/DEPLOY-SEPOLIA.md §1).",
    "cbZEC and AERO are deploy-time doubles: their addresses come from CBZEC_ADDRESS / AERO_ADDRESS (keeper) and NEXT_PUBLIC_CBZEC_ADDRESS / NEXT_PUBLIC_AERO_ADDRESS (web), never from this table.",
  ],
};

export const CHAINS: Readonly<Record<SupportedChainId, ChainTable>> = { 8453: BASE_MAINNET, 84532: BASE_SEPOLIA };

export class UnsupportedChainError extends Error {
  readonly chainId: unknown;
  constructor(chainId: unknown) {
    super(`unsupported chain ${String(chainId)}: packages/shared has address tables for ${SUPPORTED_CHAIN_IDS.join(", ")} only — Base mainnet (8453) is the product, Base Sepolia (84532) the rehearsal; nothing else has verified addresses`);
    this.name = "UnsupportedChainError";
    this.chainId = chainId;
  }
}

export function isSupportedChainId(id: unknown): id is SupportedChainId {
  return id === 8453 || id === 84532;
}

/** The table for a chain id (number or decimal string); throws `UnsupportedChainError` by name. */
export function chainTable(id: number | string | null | undefined): ChainTable {
  const n = typeof id === "string" && /^\d+$/.test(id.trim()) ? Number(id) : id;
  if (!isSupportedChainId(n)) throw new UnsupportedChainError(id);
  return CHAINS[n];
}

/** A token the chain's table leaves to a deploy-time double was not supplied. Names the variable to set. */
export class MissingChainAddressError extends Error {
  constructor(
    readonly chainId: SupportedChainId,
    readonly symbol: TokenSymbol,
    readonly variable: string
  ) {
    super(
      `no ${symbol} address for chain ${chainId} in packages/shared — it is a deploy-time double on this chain; set ${variable} to the address DeploySepolia printed (docs/DEPLOY-SEPOLIA.md), or nothing will run there`
    );
    this.name = "MissingChainAddressError";
  }
}

/** An override was given for a token the chain's table pins. Refused: pinned addresses are never redirected by env. */
export class PinnedChainAddressError extends Error {
  constructor(
    readonly chainId: SupportedChainId,
    readonly symbol: TokenSymbol,
    readonly variable: string,
    readonly pinned: Address
  ) {
    super(`${variable} is set, but ${symbol} on chain ${chainId} is pinned to ${pinned} by packages/shared (docs/VERIFIED-BASE-FACTS.md) — remove the override`);
    this.name = "PinnedChainAddressError";
  }
}

export type TokenOverrides = Partial<Record<TokenSymbol, string | undefined>>;

/**
 * The full token table for a chain: the pinned ones from the table, the deploy-time doubles from
 * `overrides` (checksummed here). A double that is missing throws `MissingChainAddressError`; an
 * override for a pinned token throws `PinnedChainAddressError`. Nothing is defaulted, on any chain.
 */
export function resolveTokens(
  table: ChainTable,
  overrides: TokenOverrides,
  variableFor: (symbol: TokenSymbol) => string
): Readonly<Record<TokenSymbol, TokenInfo>> {
  const symbols = Object.keys(table.tokens) as TokenSymbol[];
  // Every token pinned and nothing overridden (Base mainnet): the table's own record, the same
  // object base.ts exports — "unchanged" is literal, not a copy.
  if (symbols.every((s) => table.tokens[s] !== null && (overrides[s] === undefined || overrides[s] === ""))) {
    return table.tokens as Readonly<Record<TokenSymbol, TokenInfo>>;
  }
  const out = {} as Record<TokenSymbol, TokenInfo>;
  for (const symbol of symbols) {
    const pinned = table.tokens[symbol];
    const given = overrides[symbol];
    if (pinned) {
      if (given !== undefined && given !== "") throw new PinnedChainAddressError(table.id, symbol, variableFor(symbol), pinned.address);
      out[symbol] = pinned;
      continue;
    }
    if (given === undefined || given === "") throw new MissingChainAddressError(table.id, symbol, variableFor(symbol));
    const mainnet = BASE_TOKENS[symbol];
    out[symbol] = { ...mainnet, address: toChecksumAddress(given), name: `${mainnet.name} (double on ${table.name})` };
  }
  return out;
}

/**
 * The collateral table for a chain: the same rows as `COLLATERAL_ASSETS` (policy, notes, enabled
 * flags), with the chain's addresses, the chain's Aave data provider and the chain's feeds.
 * On 8453 it is `COLLATERAL_ASSETS` itself.
 */
export function collateralAssetsFor(table: ChainTable, tokens: Readonly<Record<TokenSymbol, TokenInfo>>): Readonly<Record<CollateralSymbol, CollateralAsset>> {
  if (table.id === 8453) return COLLATERAL_ASSETS;
  const out = {} as Record<CollateralSymbol, CollateralAsset>;
  for (const symbol of COLLATERAL_SYMBOLS) {
    const base = COLLATERAL_ASSETS[symbol];
    const token = tokens[symbol];
    const feed: CollateralAsset["feed"] =
      symbol === "cbZEC"
        ? { kind: "pyth", contract: table.pyth, priceId: PYTH.priceIds.ZEC_USD, description: "Crypto.ZEC/USD (pull-based; nobody pushes it on Base Sepolia)" }
        : { kind: "chainlink", ...table.collateralFeeds[symbol] };
    out[symbol] = { ...base, address: token.address, decimals: token.decimals, venueDataSource: table.aave.poolDataProvider, feed };
  }
  return out;
}
