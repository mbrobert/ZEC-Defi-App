/**
 * Verified integration constants.
 *
 * Asset IDs verified against the live 1-Click token list
 * (GET https://1click.chaindefuser.com/v0/tokens) on 2026-08-05.
 */

import { sha256 } from "./sha256.js";

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

/**
 * Fee model (decision 2026-08-13, docs/FEEDBACK-ANSWERS.md §2).
 *
 * The engine (MaxFi/SnuggleFi) takes 15% of LP earnings at harvest — verified
 * from the deployed contracts; never touches principal. Our platform fee
 * stacks on the post-engine remainder, netted at the same harvest/claim
 * events, itemized in every UI yield breakdown. Simple lending is free at
 * launch. Performance-only by design: no deposit, withdrawal, or management
 * fees, ever — fee opacity is the #1 documented complaint against ALM
 * incumbents and deposit fees punish principal.
 *
 * Phase 2 (trigger ≈ $25–30M TVL, see the break-even math in the decision
 * doc): run our own position manager and retire the engine's 15%.
 */
export const PLATFORM_FEE = {
  /** Of realized rewards, after the engine's cut. */
  performanceBps: 1000,
  /** Simple-lending mode: free at launch. */
  simpleLendingBps: 0,
  engineFeeBps: 1500,
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

/**
 * Zcash address shapes (full validation happens at the bridge).
 *
 * SETTLEMENT REALITY — probed against the live 1-Click API on 2026-08-08:
 *   • `t1…` transparent recipient  → HTTP 201, quote returned. SETTLEABLE.
 *   • `u1…` unified recipient      → HTTP 400 "recipient is not valid".
 *   • `zs1…` Sapling recipient     → HTTP 400 "recipient is not valid".
 *   • control (malformed t-addr)   → HTTP 400, so the endpoint really validates.
 * NEAR Intents' own chain-support page agrees: Zcash is
 * "Partially supported — Transparent addresses only".
 *
 * This constrains the SETTLEMENT leg only. It does NOT constrain where the
 * user's ZEC comes from: spending from a shielded pool to a transparent
 * address is an ordinary deshielding transaction, so a shielded holder can
 * fund a position today without exposing their coin history. See
 * docs/PRIVACY.md for the full boundary map.
 */
export const ZCASH_ADDRESS_PATTERNS = {
  /**
   * Transparent P2PKH (t1) / P2SH (t3) — the only settleable recipient type.
   * SHAPE ONLY: classifyZcashAddress additionally requires a valid
   * Base58Check checksum (a shape match with a bad checksum is "invalid").
   */
  transparent: /^t[13][a-zA-Z0-9]{33}$/,
  /** Unified address (ZIP-316). Private, but not settleable by the bridge yet. */
  unified: /^u1[a-z0-9]{50,}$/,
  /** Sapling shielded. Private, not settleable by the bridge. */
  sapling: /^zs1[a-z0-9]{70,}$/,
} as const;

// ---------------------------------------------------------------------------
// Base58Check validation for transparent addresses.
//
// A Zcash transparent address is Base58Check over a 26-byte payload:
//   2-byte version prefix (0x1CB8 = t1/P2PKH, 0x1CBD = t3/P2SH)
//   + 20-byte hash160
//   + first 4 bytes of SHA256(SHA256(prefix ‖ hash160)) as checksum.
// A typo'd or truncated address fails the checksum with probability
// ≈ 1 − 2⁻³², so this catches what the old shape-only regex let through.
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode a base58 string to bytes, or null on any non-alphabet character. */
function base58Decode(s: string): Uint8Array | null {
  if (!s.length) return null;
  let n = 0n;
  for (const ch of s) {
    const i = BASE58_ALPHABET.indexOf(ch);
    if (i < 0) return null; // 0, O, I, l and anything non-base58
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  // Leading '1' characters encode leading zero bytes.
  for (const ch of s) {
    if (ch === "1") bytes.unshift(0);
    else break;
  }
  return Uint8Array.from(bytes);
}

/**
 * True iff `addr` (already trimmed) is a Base58Check-valid Zcash transparent
 * address: 26-byte payload, t1/t3 version prefix, double-SHA256 checksum.
 */
export function isValidTransparentAddress(addr: string): boolean {
  const decoded = base58Decode(addr);
  if (!decoded || decoded.length !== 26) return false;
  const prefix = (decoded[0]! << 8) | decoded[1]!;
  if (prefix !== 0x1cb8 && prefix !== 0x1cbd) return false; // t1 / t3
  const payload = decoded.subarray(0, 22);
  const checksum = decoded.subarray(22);
  const digest = sha256(sha256(payload));
  for (let i = 0; i < 4; i++) {
    if (digest[i] !== checksum[i]) return false;
  }
  return true;
}

export type ZcashAddressKind = "transparent" | "unified" | "sapling" | "invalid";

export interface ZcashAddressInfo {
  kind: ZcashAddressKind;
  /**
   * The trimmed address the classification applies to. Callers MUST use this
   * exact string (not their raw input) for anything downstream — quote
   * recipients, on-chain storage, comparisons — so validation and use can
   * never diverge on whitespace.
   */
  normalized: string;
  /** Can NEAR Intents settle a withdrawal to this address today? */
  settleable: boolean;
  /** Are amounts arriving here publicly visible on the Zcash chain? */
  publiclyVisible: boolean;
  /** Short, user-facing explanation — the UI should not invent its own. */
  note: string;
}

export function classifyZcashAddress(addr: string): ZcashAddressKind {
  const a = addr.trim();
  if (ZCASH_ADDRESS_PATTERNS.transparent.test(a)) {
    // Shape alone is not enough: require the real Base58Check checksum so a
    // typo cannot masquerade as a settleable address.
    return isValidTransparentAddress(a) ? "transparent" : "invalid";
  }
  if (ZCASH_ADDRESS_PATTERNS.unified.test(a)) return "unified";
  if (ZCASH_ADDRESS_PATTERNS.sapling.test(a)) return "sapling";
  return "invalid";
}

/** Everything the UI needs to guide a user to a working, private-as-possible setup. */
export function describeZcashAddress(addr: string): ZcashAddressInfo {
  const normalized = addr.trim();
  const kind = classifyZcashAddress(normalized);
  switch (kind) {
    case "transparent":
      return {
        kind,
        normalized,
        settleable: true,
        publiclyVisible: true,
        note:
          "Transparent address — the bridge can deliver here. Arrivals are public on the Zcash chain, so shield the funds once they land and use a fresh address for each position.",
      };
    case "unified":
      return {
        kind,
        normalized,
        settleable: false,
        publiclyVisible: false,
        note:
          "Unified address — private, but the bridge cannot settle to it yet. Paste the transparent receiving address from the same wallet; most wallets can auto-shield the moment funds arrive.",
      };
    case "sapling":
      return {
        kind,
        normalized,
        settleable: false,
        publiclyVisible: false,
        note:
          "Sapling shielded address — private, but the bridge cannot settle to it yet. Use the transparent receiving address from the same wallet and shield on arrival.",
      };
    default:
      return {
        kind,
        normalized,
        settleable: false,
        publiclyVisible: false,
        note: "Not a recognized Zcash address. Expected t1…/t3… (transparent), u1… (unified) or zs1… (shielded).",
      };
  }
}

/** Where the user is funding a deposit FROM — decides the privacy of the inbound leg. */
export type DepositSource = "SHIELDED" | "TRANSPARENT";

/**
 * Getting funds from transparent back into the shielded pool.
 *
 * We never hold the user's Zcash keys, so the platform cannot shield on their
 * behalf — shielding is a transaction their own wallet signs. What we CAN do is
 * route payouts to a wallet that shields automatically, and say exactly how.
 *
 * Verified behaviour: Zashi (now Zodl, the ECC wallet) shields ZEC received into
 * the wallet, and since 2.0.3 its unified address contains shielded receivers
 * only — the transparent address is shown separately on the Receive screen.
 * That separate t-address is the one our payouts must target.
 *
 * For other wallets we deliberately do NOT assert auto-shield behaviour we
 * haven't verified; we point the user at their wallet's own shield action.
 *
 * Economics note: shielding costs a Zcash network fee (ZIP-317, fractions of a
 * cent at normal prices), and wallets skip auto-shielding dust. The existing
 * REWARD_CLAIM_POLICY.minAbsoluteUsd floor ($5) already sits far above any
 * auto-shield threshold, so every payout we make is worth shielding — that
 * floor is doing double duty and should not be lowered without revisiting this.
 */
export interface WalletShieldGuide {
  id: string;
  label: string;
  /** Do we have verified evidence this wallet shields received funds itself? */
  autoShields: boolean | "unverified";
  /** Where to find the transparent receiving address. */
  addressHint: string;
  /** What happens after funds land. */
  shieldHint: string;
  warn?: string;
}

export const WALLET_SHIELD_GUIDES: WalletShieldGuide[] = [
  {
    id: "zashi",
    label: "Zashi / Zodl",
    autoShields: true,
    addressHint:
      "Receive screen → the transparent address is listed separately, below the shielded one. Copy that t-address.",
    shieldHint:
      "Zashi shields ZEC it receives, so your payout spends only moments in the open before it is private again.",
  },
  {
    id: "ywallet",
    label: "Ywallet",
    autoShields: "unverified",
    addressHint: "Receive → switch the address type to transparent and copy it.",
    shieldHint:
      "Ywallet exposes a shield action for transparent balances — run it after a payout lands, or check whether your version does it automatically.",
  },
  {
    id: "zingo",
    label: "Zingo",
    autoShields: "unverified",
    addressHint: "Receive → transparent address.",
    shieldHint:
      "Use the wallet's shield/consolidate action once the payout arrives to move it into the shielded pool.",
  },
  {
    id: "other",
    label: "Another self-custody wallet",
    autoShields: "unverified",
    addressHint:
      "Any transparent (t1…/t3…) receiving address the wallet controls. Generate a new one per position.",
    shieldHint:
      "Check the wallet for a 'shield' action and run it after each payout. If it has none, move the funds to a wallet that does.",
  },
  {
    id: "exchange",
    label: "An exchange account",
    autoShields: false,
    addressHint: "An exchange deposit address.",
    shieldHint: "Exchanges hold the funds; nothing is shielded.",
    warn:
      "Strongly discouraged. Exchange deposits are tied to your verified identity, which links this position — and every future payout to the same address — directly to you. Exchanges also generally do not support shielded withdrawals, so the funds cannot easily be made private again. Use a self-custody wallet instead.",
  },
];


