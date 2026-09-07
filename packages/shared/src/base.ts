/**
 * Base mainnet (chain id 8453) — every external address and id the product
 * touches, typed. SOURCE OF TRUTH: docs/VERIFIED-BASE-FACTS.md (read live
 * 2026-09-05). Nothing may be added here that is not in that document; anything
 * else must be probed on-chain first (the rule that would have caught C-2).
 *
 * All addresses are EIP-55 checksummed; test/base.test.ts asserts that.
 */
import type { Address } from "./evm.js";

export const CHAIN_ID = 8453 as const;
/** @deprecated alias kept for the pre-pivot tree; prefer CHAIN_ID. */
export const BASE_CHAIN_ID = CHAIN_ID;

export const BASE_CHAIN = {
  id: CHAIN_ID,
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  /** Public explorer for links in the UI — never used for data. */
  explorerUrl: "https://basescan.org",
} as const;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type TokenSymbol = "USDC" | "WETH" | "cbBTC" | "cbZEC" | "AERO";

export interface TokenInfo {
  symbol: TokenSymbol;
  name: string;
  address: Address;
  decimals: number;
  /**
   * "erc20"  — ordinary contract.
   * "b20"    — Coinbase B20 precompile: eth_getCode returns 0xef, exposes a
   *            live `multiplier()` (rebase), owner()/paused() revert. NEVER
   *            cache a B20 balance across an external call.
   */
  kind: "erc20" | "b20";
}

export const BASE_TOKENS: Readonly<Record<TokenSymbol, TokenInfo>> = {
  USDC: {
    symbol: "USDC",
    name: "USD Coin",
    address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    kind: "erc20",
  },
  WETH: {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    kind: "erc20",
  },
  cbBTC: {
    symbol: "cbBTC",
    name: "Coinbase Wrapped BTC",
    address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
    decimals: 8,
    kind: "erc20",
  },
  cbZEC: {
    symbol: "cbZEC",
    name: "Coinbase Wrapped ZEC",
    address: "0xB2000000000000000000008501b13360000cb2EC",
    decimals: 8,
    kind: "b20",
  },
  AERO: {
    symbol: "AERO",
    name: "Aerodrome",
    address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631",
    decimals: 18,
    kind: "erc20",
  },
};

/** The one asset v1 borrows. */
export const BORROW_ASSET: TokenSymbol = "USDC";

// ---------------------------------------------------------------------------
// Aave v3 (verified via PoolAddressesProvider getters)
// ---------------------------------------------------------------------------

export const AAVE_V3 = {
  poolAddressesProvider: "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D",
  pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  /**
   * NOTE: VERIFIED-BASE-FACTS prints this one with a casing that is NOT a valid
   * EIP-55 checksum (hex digits identical). This is the checksummed form;
   * wallets and viem's getAddress reject the doc's casing.
   */
  poolDataProvider: "0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A",
  oracle: "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156",
  /**
   * Aave's own price-source adapters per reserve (NOT the raw Chainlink
   * aggregators — those are in CHAINLINK_FEEDS). Listed for reconciliation only.
   */
  priceSources: {
    cbBTC: "0x3A932b286715abc4A86a4ACAF68A6cdD89E0d446",
    WETH: "0x9dA00D23465282005DB222a441a663eE7B9dfCc8",
    USDC: "0xf52D010c7d4ecBfda92c2509900593CE34535D86",
  },
} as const satisfies {
  poolAddressesProvider: Address;
  pool: Address;
  poolDataProvider: Address;
  oracle: Address;
  priceSources: Record<"cbBTC" | "WETH" | "USDC", Address>;
};

/**
 * Reserves that exist on Aave v3 Base. Risk parameters (LTV, liquidation
 * threshold, bonus) are DELIBERATELY absent: they are read from
 * PoolDataProvider.getReserveConfigurationData at call time, never typed.
 */
export const AAVE_V3_RESERVES: readonly TokenSymbol[] = ["cbBTC", "WETH", "USDC"];

// ---------------------------------------------------------------------------
// Chainlink (verified description() + latestRoundData())
// ---------------------------------------------------------------------------

export interface ChainlinkFeed {
  description: string;
  address: Address;
  /** Aggregator answer decimals (USD feeds on Base are 8). */
  decimals: 8;
}

export const CHAINLINK_FEEDS = {
  BTC_USD: { description: "BTC / USD", address: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F", decimals: 8 },
  ETH_USD: { description: "ETH / USD", address: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", decimals: 8 },
  USDC_USD: { description: "USDC / USD", address: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B", decimals: 8 },
  cbBTC_USD: { description: "cbBTC / USD", address: "0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D", decimals: 8 },
} as const satisfies Record<string, ChainlinkFeed>;

/** There is NO Chainlink ZEC/USD feed on Base. cbZEC pricing is Pyth (v1.1). */
export const CHAINLINK_ZEC_USD: null = null;

// ---------------------------------------------------------------------------
// Pyth (pull-based: on-chain price is only as fresh as the last posted update)
// ---------------------------------------------------------------------------

export const PYTH = {
  contract: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
  priceIds: {
    /** Crypto.ZEC/USD */
    ZEC_USD: "0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24",
  },
  /** Hermes endpoint the web/keeper fetch VAAs from before updatePriceFeeds. */
  hermesUrl: "https://hermes.pyth.network",
} as const;

// ---------------------------------------------------------------------------
// Aerodrome
// ---------------------------------------------------------------------------

export interface SlipstreamPoolInfo {
  address: Address;
  token0: TokenSymbol;
  token1: TokenSymbol;
  /** Pool fee in pips (1e-6). 2000 = 0.2%. Slipstream fees are dynamic — read fee() live. */
  feePips: number;
  tickSpacing: number;
  /** Gauge for this pool. rewardRate()/periodFinish() must be read live — see note. */
  gauge: Address;
}

export const AERODROME = {
  voter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
  pools: {
    /**
     * cbZEC/USDC Slipstream pool (EIP-1167 clone). At read time its gauge had
     * rewardRate() = 0 and periodFinish() = 0 — created, never voted. LP here
     * earns NO AERO until an emissions vote lands; the yield gate must read the
     * gauge live and never offer it on a typed assumption.
     */
    cbZEC_USDC: {
      address: "0x0Fc47C17AF86078d809358db1b4db2DeBC988566",
      token0: "USDC",
      token1: "cbZEC",
      feePips: 2000,
      tickSpacing: 200,
      gauge: "0x8779E34E5d38358B0cB957c553B40cC1208C81FB",
    },
  },
} as const satisfies { voter: Address; pools: Record<string, SlipstreamPoolInfo> };

// ---------------------------------------------------------------------------
// Other infrastructure (code presence verified)
// ---------------------------------------------------------------------------

export const MORPHO_BLUE = {
  address: "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb",
  /**
   * The two listed USDC markets, read from `idToMarketParams` on 2026-09-07
   * (block 51,003,524; docs/VERIFIED-BASE-FACTS.md, Morpho addendum). Both 86 %
   * LLTV (liquidation loan-to-value), AdaptiveCurve IRM, Chainlink-fed oracles
   * (cbBTC market: BTC/USD, no cbBTC leg). No cbZEC market exists. The
   * MorphoBlueVenue is built over these; the registry still points at Aave.
   */
  marketIds: {
    cbBTC_USDC: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
    WETH_USDC: "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda",
  },
  /** LLTV of both markets at the read, WAD. Read live from the venue in code; here for display. */
  lltvWad: 860000000000000000n,
} as const;

export const COMPOUND_V3 = {
  /** USDC Comet. baseToken() = USDC. Utilisation was above the kink at read time — read the live rate. */
  usdcComet: "0xb125E6687d4313864e53df431d5425969c15Eb2F",
} as const satisfies Record<string, Address>;

export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export const COW_PROTOCOL = {
  settlement: "0x9008D19f58AAbD9eD0D60971565AA8510560ab41",
  /** GPv2VaultRelayer — the address orders approve. NOT in VERIFIED-BASE-FACTS; web must read it from settlement.vaultRelayer() before use. */
  vaultRelayer: null,
} as const;

/** The pinned cbZEC address. Every counterfeit check compares against this. */
export const CBZEC_ADDRESS: Address = BASE_TOKENS.cbZEC.address;

// ---------------------------------------------------------------------------
// Counterfeit detection
// ---------------------------------------------------------------------------

/**
 * cbZEC's vanity prefix. Scammers deploy look-alikes sharing it; anything
 * that starts with this prefix and is not the pinned address is treated as
 * counterfeit, full stop.
 */
export const COUNTERFEIT_PREFIX = "0xb2000" as const;

export type CbZecAddressClass = "genuine" | "counterfeit" | "unrelated" | "invalid";

/**
 * Classify an address relative to the pinned cbZEC:
 *   genuine     — exactly the pinned cbZEC (case-insensitive)
 *   counterfeit — starts with COUNTERFEIT_PREFIX but is not the pinned cbZEC
 *   unrelated   — a valid address with a different prefix
 *   invalid     — not a 40-hex address at all
 */
export function classifyCbZecAddress(value: unknown): CbZecAddressClass {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return "invalid";
  const lower = value.toLowerCase();
  if (lower === CBZEC_ADDRESS.toLowerCase()) return "genuine";
  if (lower.startsWith(COUNTERFEIT_PREFIX)) return "counterfeit";
  return "unrelated";
}

/** True for any `0xb2000…` address that is not the pinned cbZEC. */
export function isCounterfeitCbZec(value: unknown): boolean {
  return classifyCbZecAddress(value) === "counterfeit";
}

/** True only for the pinned cbZEC address (any casing). */
export function isGenuineCbZec(value: unknown): boolean {
  return classifyCbZecAddress(value) === "genuine";
}

/** Every address constant in this module, flattened for tests and for the abi-verify script. */
export function allVerifiedAddresses(): Readonly<Record<string, Address>> {
  const out: Record<string, Address> = {};
  for (const t of Object.values(BASE_TOKENS)) out[`token.${t.symbol}`] = t.address;
  out["aave.poolAddressesProvider"] = AAVE_V3.poolAddressesProvider;
  out["aave.pool"] = AAVE_V3.pool;
  out["aave.poolDataProvider"] = AAVE_V3.poolDataProvider;
  out["aave.oracle"] = AAVE_V3.oracle;
  for (const [k, v] of Object.entries(AAVE_V3.priceSources)) out[`aave.priceSource.${k}`] = v;
  for (const [k, v] of Object.entries(CHAINLINK_FEEDS)) out[`chainlink.${k}`] = v.address;
  out["pyth.contract"] = PYTH.contract;
  out["aerodrome.voter"] = AERODROME.voter;
  for (const [k, v] of Object.entries(AERODROME.pools)) {
    out[`aerodrome.pool.${k}`] = v.address;
    out[`aerodrome.gauge.${k}`] = v.gauge;
  }
  out["morpho.blue"] = MORPHO_BLUE.address;
  out["compound.usdcComet"] = COMPOUND_V3.usdcComet;
  out["permit2"] = PERMIT2;
  out["cow.settlement"] = COW_PROTOCOL.settlement;
  return out;
}
