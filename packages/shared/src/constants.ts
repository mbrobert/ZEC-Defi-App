/**
 * Verified integration constants.
 *
 * Asset IDs verified against the live 1-Click token list
 * (GET https://1click.chaindefuser.com/v0/tokens) on 2026-08-05.
 */

/** NEAR Intents 1-Click API. */
export const ONE_CLICK_BASE_URL = "https://1click.chaindefuser.com";

export const ONE_CLICK_ENDPOINTS = {
  tokens: "/v0/tokens",
  quote: "/v0/quote",
  depositSubmit: "/v0/deposit/submit",
  status: "/v0/status",
} as const;

/**
 * Intents asset identifiers (nep141 representation used by 1-Click).
 * NOTE: without a JWT the API applies a 0.2% integrator fee to quotes.
 */
export const INTENTS_ASSET_IDS = {
  /** Native Zcash (8 decimals, blockchain "zec"). Transparent addresses fully supported. */
  ZEC: "nep141:zec.omft.near",
  /** USDC on Base (6 decimals). */
  USDC_BASE: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  /** cbBTC on Base (8 decimals). */
  CBBTC_BASE: "nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near",
  /** WETH on Base (18 decimals). */
  WETH_BASE: "nep141:base-0x4200000000000000000000000000000000000006.omft.near",
  /** Native USDC on NEAR (6 decimals). */
  USDC_NEAR: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
} as const;

/** Canonical ERC-20 addresses on Base mainnet (chainId 8453). */
export const BASE_TOKENS = {
  USDC: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  cbBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", decimals: 8 },
  WETH: { address: "0x4200000000000000000000000000000000000006", decimals: 18 },
} as const;

export const BASE_CHAIN_ID = 8453;

/** ZEC uses 8 decimal places (zatoshis). */
export const ZEC_DECIMALS = 8;

/**
 * Rhea Finance (NEAR) lending.
 * The cross-chain SDK creates a Multi-Chain Account (MCA) per user and
 * supports intent-based ZEC supply, borrow, and health-factor reads.
 */
export const RHEA = {
  /** Hard cap we allow users to select, below protocol max (~60%) for safety. */
  maxUserLtvBps: 5000,
  /** Default suggested LTV. */
  defaultLtvBps: 3500,
  healthFactor: {
    warning: 1.5,
    critical: 1.2,
  },
} as const;

/** Reward-claim economics: claim only when rewards clear costs by this multiple. */
export const REWARD_CLAIM_POLICY = {
  /** accruedUsd must exceed (gasUsd + bridgeUsd) * multiple. */
  minCostMultiple: 3,
  /** ...and always exceed this floor, regardless of costs. */
  minAbsoluteUsd: 5,
  /** Never wait longer than this once anything has accrued. */
  maxHoldDays: 30,
} as const;

/** Basic Zcash address shape checks (full validation happens server-side). */
export const ZCASH_ADDRESS_PATTERNS = {
  /** Transparent P2PKH / P2SH — fully supported by NEAR Intents. */
  transparent: /^t[13][a-zA-Z0-9]{33}$/,
  /** Unified addresses — partially supported; warn in UI. */
  unified: /^u1[a-z0-9]{50,}$/,
} as const;

export function classifyZcashAddress(
  addr: string
): "transparent" | "unified" | "invalid" {
  if (ZCASH_ADDRESS_PATTERNS.transparent.test(addr)) return "transparent";
  if (ZCASH_ADDRESS_PATTERNS.unified.test(addr)) return "unified";
  return "invalid";
}
