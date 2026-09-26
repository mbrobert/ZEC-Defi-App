/**
 * Hyperliquid perps — the venue facts, the HyperCore byte layouts and the health math the perps module
 * runs on (BUILD-PLAN Stream D; `docs/PERPS-DESIGN-2026-09-25.md` §2–§6). ONE source for the venue
 * adapter's tests, the keeper's perps path, the wizard and the D0b testnet script: no surface may type a
 * scaling, an action id or a margin rate of its own.
 *
 * SOURCE OF TRUTH: `docs/VERIFIED-PERPS-FACTS-2026-09-14.md` (§2–§6) and the HyperEVM reads of
 * 2026-09-25 recorded in `docs/research/hyperevm-reads-2026-09-25.json` — every address, index, struct
 * layout and scaling below was read from the venue's API or from chain 999 by `eth_call`, at a stated
 * block, and where the API answered at the same moment the two agree. Two things are still taken from
 * Hyperliquid's documentation and marked **[doc]**: the limit-order tuple of CoreWriter action 1 and the
 * `usdClassTransfer` tuple of action 7 (the ENCODING RULE itself — version byte, three-byte id, ABI words —
 * and action 13's tuple were read from a live `RawAction` log). `scripts/perps-d0b-testnet.mjs` proves the
 * two on testnet; until it has, nothing here is a promise that an order will be accepted.
 *
 * Health of a short (design §4): a short is liquidated when the price RISES. Under cross margin with one
 * position the venue's own rule gives the up-move to liquidation `d = (A / (P·s) − mmr) / (1 + mmr)`; the
 * shared ladder runs on the EQUIVALENT health factor `1 / (1 − d)`, so a borrow and a short share one set
 * of rungs. The formula was checked against the venue's own `liquidationPx` for every short sampled on
 * 2026-09-25 (0.001 %); it is the venue's number, not a model.
 *
 * Deliberately carries NO funding rate as a live number: funding is a measured history, shown with its
 * variance (`fundingStats`), never a rate and never the word the copy rules refuse.
 */
import type { Address } from "./evm.js";
import { CCTP_DOMAINS } from "./cctp.js";
import {
  MAX_LADDER_ENTRY_HF_BPS,
  MIN_LADDER_ENTRY_HF,
  ladderBpsFor,
  type HfRungBps,
  type HfRungId,
} from "./health.js";

// ---------------------------------------------------------------------------
// The venue, as read
// ---------------------------------------------------------------------------

/** HyperEVM (chain 999) and HyperCore facts. Read 2026-09-14 (facts §4) and 2026-09-25 (research JSON). */
export const HYPERLIQUID = {
  chainId: 999,
  rpc: "https://rpc.hyperliquid.xyz/evm",
  infoApi: "https://api.hyperliquid.xyz/info",
  /** Hyperliquid's HyperEVM page, read 2026-09-25: testnet chain id 998, its RPC. The testnet API URL is NOT on that page. */
  testnet: { chainId: 998, rpc: "https://rpc.hyperliquid-testnet.xyz/evm" },
  /** CoreWriter: 544 bytes of code, `sendRawAction(bytes)` in its dispatch table (facts §4, 2026-09-14). */
  coreWriter: "0x3333333333333333333333333333333333333333" as Address,
  coreWriterSendRawActionSelector: "0x17938e13",
  /** The event CoreWriter emits per action (live log, tx 0xeaf2…acb9, block 46,887,881; name from openchain). */
  coreWriterRawActionEvent: "RawAction(address,bytes)",
  coreWriterRawActionTopic0: "0x8c7f585fb295f7eb1e6aeb8fba61b23a4fe60beda405f0045073b185c74412e3",
  /** ZEC perp: index 214 of the `meta` universe; `perpAssetInfo(214)` on chain says the same (2026-09-25). */
  zec: { index: 214, coin: "ZEC", szDecimals: 2, maxLeverage: 10, marginTableId: 52 },
  /** `meta.marginTables[52]` "tiered 10x (2)": 10× to $20 M notional, 5× above (facts §6). */
  marginTable52: [
    { lowerBoundUsd: 0, maxLeverage: 10 },
    { lowerBoundUsd: 20_000_000, maxLeverage: 5 },
  ],
  usdc: {
    /** HyperCore token 0 (`meta.collateralToken`, `spotMeta.tokens[0]`, `tokenInfo(0)` on chain). */
    tokenIndex: 0,
    /** `weiDecimals` 8: a HyperCore USDC spot balance and a `sendAsset` `wei` are in 10^8. */
    weiDecimals: 8,
    /** `evm_extra_wei_decimals` −2: the ERC-20 on HyperEVM has 8 − 2 = 6 decimals (read: `decimals()` = 6). */
    evmDecimals: 6,
    /** Circle's USDC on HyperEVM — Circle's address page AND `TokenMinterV2.getLocalToken(6, Base USDC)` on chain 999 agree. */
    circleUsdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f" as Address,
    /** Circle's USDC on HyperEVM TESTNET (Circle's address page, testnet table, 2026-09-25). */
    circleUsdcTestnet: "0x2B3370eE501B4a559b57D449569354196457D8Ab" as Address,
    /**
     * The contract HyperCore names as token 0's `evmContract`: a Circle-style proxy that HOLDS Circle's USDC
     * (674.76 M on 2026-09-25) and exposes `deposit(uint256 amount, uint32 destinationDex)`, `transfer`,
     * `token()`, `paused()`, `owner()` — not `balanceOf`/`decimals` (they revert). A live deposit (tx
     * 0xeaf2…acb9) pulled Circle USDC from the caller, emitted the linked `Transfer` to the system address,
     * and sent the wei to the CALLER's chosen dex through CoreWriter action 13.
     */
    adapter: "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24" as Address,
    adapterDepositSelector: "0x2b2dfd2c",
    adapterDepositSignature: "deposit(uint256,uint32)",
    /** Token 0's system address: first byte 0x20, then the token index big-endian (docs rule; balance/code read empty). */
    systemAddress: "0x2000000000000000000000000000000000000000" as Address,
  },
  /** Circle's CCTP V2 on HyperEVM — the same three addresses as Base; `localDomain()` = 19 read at block 46,887,589. */
  cctp: {
    domain: CCTP_DOMAINS.hyperevm,
    tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" as Address,
    messageTransmitterV2: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64" as Address,
    tokenMinterV2: "0xfd78EE919681417d192449715b2594ab58f5D002" as Address,
    /**
     * Fast Transfer INTO HyperEVM is offered: `/v2/burn/USDC/fees/6/19` prices threshold 1000 at 1.3 bp (Base → Solana's
     * schedule), so the keeper's `chooseCctpFinality` applies to the inbound leg unchanged. OUT of HyperEVM it is not:
     * Circle's supported-blockchains table marks Fast "N/A" for HyperEVM as a source and `/fees/19/6` prices both
     * thresholds at 0 — the burn home is Standard, minutes (facts §6, corrected 2026-09-25 22:31 UTC).
     */
    fastTransferIn: true,
    fastTransferOut: false,
    fastFeeInBps: 1.3,
    burnLimitPerMessageUsdc: 10_000_000,
  },
} as const;

/** The read precompiles that answered on 2026-09-14 / 2026-09-25, with the input and output shapes that answered. */
export const HYPERCORE_PRECOMPILES = {
  /** `(address user, uint16 perp)` → `(int64 szi, uint64 entryNtl, int64 isolatedRawUsd, uint32 leverage, bool isIsolated)`. */
  position: "0x0000000000000000000000000000000000000800" as Address,
  /** `(address user, uint64 token)` → `(uint64 total, uint64 hold, uint64 entryNtl)`, in `weiDecimals`. */
  spotBalance: "0x0000000000000000000000000000000000000801" as Address,
  /** `(address user)` → `(uint64 withdrawable)`, 10^6 USDC. */
  withdrawable: "0x0000000000000000000000000000000000000803" as Address,
  /** `(uint32 perp)` → `uint64`, scaled 10^(6 − szDecimals). */
  markPx: "0x0000000000000000000000000000000000000806" as Address,
  oraclePx: "0x0000000000000000000000000000000000000807" as Address,
  /** `()` → `uint64` HyperCore block number. */
  l1BlockNumber: "0x0000000000000000000000000000000000000809" as Address,
  /** `(uint32 perp)` → `(string coin, uint32 marginTableId, uint8 szDecimals, uint8 maxLeverage, bool onlyIsolated)`. */
  perpAssetInfo: "0x000000000000000000000000000000000000080a" as Address,
  /** `(uint32 token)` → `(string name, uint64[] spots, uint64 deployerTradingFeeShare, address deployer, address evmContract, uint8 szDecimals, uint8 weiDecimals, int8 evmExtraWeiDecimals)`. */
  tokenInfo: "0x000000000000000000000000000000000000080c" as Address,
  /** `(uint32 perpDex, address user)` → `(int64 accountValue, uint64 marginUsed, uint64 ntlPos, int64 rawUsd)`, 10^6 USDC. */
  accountMarginSummary: "0x000000000000000000000000000000000000080f" as Address,
  /** `(address user)` → `bool`. A contract that has never touched HyperCore reads false (the CCTP messenger did). */
  coreUserExists: "0x0000000000000000000000000000000000000810" as Address,
} as const;

/** CoreWriter action ids (the docs' table, quoted in facts §6; 13's encoding read from a live log). */
export const CORE_ACTIONS = { limitOrder: 1, usdClassTransfer: 7, sendAsset: 13 } as const;
export const CORE_ACTION_VERSION = 1;
/** `encodedTif` for action 1 [doc]: 1 = add-liquidity-only, 2 = good-till-cancel, 3 = immediate-or-cancel. */
export const CORE_TIF = { alo: 1, gtc: 2, ioc: 3 } as const;
/** `source_dex` / `destination_dex` for SPOT in action 13: uint32::MAX (docs, and the live log's 0xffffffff). */
export const CORE_SPOT_DEX = 0xffffffff;
/** The perp dex the ZEC market lives on (the `clearinghouseState` / `accountMarginSummary(0, …)` dex). */
export const CORE_PERP_DEX = 0;
/** Action 1's `limitPx` and `sz` are 10^8 × the human value [doc] — NOT the precompiles' 10^(6 − szDecimals). */
export const CORE_ORDER_SCALE_DECIMALS = 8;

/**
 * The venue's order rules [doc] (hyperliquid.gitbook.io/hyperliquid-docs, read 2026-09-26 16:33 UTC; facts §7.7):
 * "Prices can have up to 5 significant figures, but no more than MAX_DECIMALS − szDecimals decimal places where
 * MAX_DECIMALS is 6 for perps … Integer prices are always allowed" (tick-and-lot-size), and "Order must have minimum
 * value of $10." (the exchange-endpoint page's own error example). HyperCore REJECTS an order that breaks either,
 * and a rejected CoreWriter order is silent — AUDIT-2026-09-26 P-1 / P-2. `HyperCoreLib` is the Solidity twin.
 */
export const HYPERLIQUID_ORDER_RULES = { maxSignificantFigures: 5, perpPxMaxDecimals: 6, minOrderValueUsd: 10 } as const;
/** The minimum order value in 10^6 USDC. */
export const MIN_ORDER_VALUE_E6 = 10_000_000n;

/**
 * A price in 10^8 rounded to the venue's precision — at most 5 significant figures AND at most (6 − szDecimals)
 * decimals, integers always allowed — DOWN, or UP when `roundUp`. The caller picks the direction that stays inside
 * its band: a sell's floor rounds up, a buy's ceiling rounds down (`HyperCoreLib.roundOrderPxE8`, value for value).
 */
export function roundOrderPxE8(pxE8: bigint, szDecimals: number, roundUp: boolean): bigint {
  assertSmallInt(szDecimals, "szDecimals", 0, 6);
  if (typeof pxE8 !== "bigint" || pxE8 < 0n) throw new RangeError(`pxE8 must be a non-negative bigint, got ${String(pxE8)}`);
  if (pxE8 === 0n) return 0n;
  const digits = pxE8.toString().length;
  let exp = 8 - HYPERLIQUID_ORDER_RULES.perpPxMaxDecimals + szDecimals;
  if (digits > HYPERLIQUID_ORDER_RULES.maxSignificantFigures && digits - HYPERLIQUID_ORDER_RULES.maxSignificantFigures > exp) exp = digits - HYPERLIQUID_ORDER_RULES.maxSignificantFigures;
  if (exp > 8) exp = 8;
  const q = 10n ** BigInt(exp);
  const down = (pxE8 / q) * q;
  return !roundUp || down === pxE8 ? down : down + q;
}

/** Whether HyperCore accepts `pxE8` as an order price: unchanged by rounding down. */
export function isValidOrderPxE8(pxE8: bigint, szDecimals: number): boolean {
  return roundOrderPxE8(pxE8, szDecimals, false) === pxE8;
}

/**
 * The venue's own order price for a mark (`HyperliquidPerpVenue._toE8Px`): the precompile's mark in 10^8, shaded by
 * the band — down for a sell, up for a buy — then rounded inside the band. What the D0b script sends and what the
 * keeper expects to see in a `RawAction`.
 */
export function orderPxE8ForMark(markRaw: bigint, szDecimals: number, bandBps: number, isBuy: boolean): bigint {
  assertSmallInt(bandBps, "bandBps", 0, 10_000);
  if (markRaw <= 0n) throw new RangeError(`mark must be positive, got ${markRaw}`);
  const scaled = markRaw * 10n ** BigInt(CORE_ORDER_SCALE_DECIMALS - perpPxDecimals(szDecimals));
  const px = isBuy ? (scaled * BigInt(10_000 + bandBps)) / 10_000n : (scaled * BigInt(10_000 - bandBps)) / 10_000n;
  return roundOrderPxE8(px, szDecimals, !isBuy);
}

/** A raw size (10^szDecimals) as action 1's `sz` (10^8): always a valid lot. */
export function orderSzE8(szRaw: bigint, szDecimals: number): bigint {
  assertSmallInt(szDecimals, "szDecimals", 0, 6);
  if (szRaw <= 0n) throw new RangeError(`sz must be positive, got ${szRaw}`);
  return szRaw * 10n ** BigInt(CORE_ORDER_SCALE_DECIMALS - szDecimals);
}

/** The smallest raw size whose value at `markRaw` meets the venue's $10 minimum (rounded up). */
export function minOrderSzRaw(markRaw: bigint, szDecimals: number): bigint {
  const unit = unitNotionalE6(markRaw, szDecimals);
  return (MIN_ORDER_VALUE_E6 + unit - 1n) / unit;
}

// ---------------------------------------------------------------------------
// Scalings — each pinned by test to a raw read beside the API's number
// ---------------------------------------------------------------------------

/** Price decimals of a perp's mark / oracle precompile and `entryPx`: 6 − szDecimals (facts §4: 10^4 for ZEC). */
export function perpPxDecimals(szDecimals: number): number {
  assertSmallInt(szDecimals, "szDecimals", 0, 6);
  return 6 - szDecimals;
}

/** Maintenance margin rate of tier 0 of a market whose max leverage is `maxLeverage`: half the initial margin at max leverage. */
export function maintenanceMarginRateBps(maxLeverage: number): number {
  assertSmallInt(maxLeverage, "maxLeverage", 1, 200);
  const twice = 2 * maxLeverage;
  if (10_000 % twice !== 0) throw new RangeError(`maintenance margin rate 1/(2×${maxLeverage}) is not a whole number of basis points`);
  return 10_000 / twice;
}

/** A decimal string ("1535.1438", "-51.76") as an integer in `decimals` units, exactly — no float in the money path. */
export function parseDecimalToUnits(value: string, decimals: number): bigint {
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value.trim())) throw new RangeError(`not a decimal string: ${String(value)}`);
  assertSmallInt(decimals, "decimals", 0, 30);
  const s = value.trim();
  const negative = s.startsWith("-");
  const [whole, frac = ""] = (negative ? s.slice(1) : s).split(".");
  if (frac.length > decimals) throw new RangeError(`${value} has more than ${decimals} decimals`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  return negative ? -units : units;
}

/** The inverse: units → a decimal string with exactly `decimals` places (trailing zeros kept, sign kept). */
export function formatUnits(units: bigint, decimals: number): string {
  assertSmallInt(decimals, "decimals", 0, 30);
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0");
  return `${neg ? "-" : ""}${whole}${decimals ? "." + frac : ""}`;
}

// ---------------------------------------------------------------------------
// CoreWriter encoding — version byte, three-byte action id, ABI words
// ---------------------------------------------------------------------------

export type Hex = `0x${string}`;

function word(v: bigint, bits: number, name: string, signed = false): string {
  if (typeof v !== "bigint") throw new TypeError(`${name}: expected a bigint`);
  const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  if (v < min || v > max) throw new RangeError(`${name} out of range for ${signed ? "int" : "uint"}${bits}: ${v}`);
  const u = v < 0n ? (1n << 256n) + v : v;
  return u.toString(16).padStart(64, "0");
}

function addressWord(a: string, name: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new TypeError(`${name}: not an address: ${a}`);
  return a.slice(2).toLowerCase().padStart(64, "0");
}

/** `0x` + version (1 byte) + action id (3 bytes, big-endian) + the ABI words — the rule a live RawAction log showed. */
export function encodeCoreAction(actionId: number, words: readonly string[]): Hex {
  assertSmallInt(actionId, "actionId", 1, 0xffffff);
  const id = actionId.toString(16).padStart(6, "0");
  return `0x${CORE_ACTION_VERSION.toString(16).padStart(2, "0")}${id}${words.join("")}` as Hex;
}

export interface LimitOrderAction {
  asset: number;
  isBuy: boolean;
  /** 10^8 × the human price [doc]. */
  limitPxE8: bigint;
  /** 10^8 × the human size [doc]. */
  szE8: bigint;
  reduceOnly: boolean;
  tif: (typeof CORE_TIF)[keyof typeof CORE_TIF];
  cloid?: bigint;
}

/** Action 1 [doc]: `(uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, bool reduceOnly, uint8 encodedTif, uint128 cloid)`. */
export function encodeLimitOrder(o: LimitOrderAction): Hex {
  assertSmallInt(o.asset, "asset", 0, 0xffffffff);
  if (![1, 2, 3].includes(o.tif)) throw new RangeError(`tif must be 1 (alo), 2 (gtc) or 3 (ioc), got ${String(o.tif)}`);
  if (o.szE8 <= 0n) throw new RangeError(`sz must be positive, got ${o.szE8}`);
  if (o.limitPxE8 <= 0n) throw new RangeError(`limitPx must be positive, got ${o.limitPxE8}`);
  return encodeCoreAction(CORE_ACTIONS.limitOrder, [
    word(BigInt(o.asset), 32, "asset"),
    word(o.isBuy ? 1n : 0n, 8, "isBuy"),
    word(o.limitPxE8, 64, "limitPx"),
    word(o.szE8, 64, "sz"),
    word(o.reduceOnly ? 1n : 0n, 8, "reduceOnly"),
    word(BigInt(o.tif), 8, "encodedTif"),
    word(o.cloid ?? 0n, 128, "cloid"),
  ]);
}

/** Action 7 [doc]: `(uint64 ntl, bool toPerp)` — spot ↔ perp USDC within the same HyperCore account. `ntl` units are D0b's to prove. */
export function encodeUsdClassTransfer(ntl: bigint, toPerp: boolean): Hex {
  if (ntl <= 0n) throw new RangeError(`ntl must be positive, got ${ntl}`);
  return encodeCoreAction(CORE_ACTIONS.usdClassTransfer, [word(ntl, 64, "ntl"), word(toPerp ? 1n : 0n, 8, "toPerp")]);
}

export interface SendAssetAction {
  destination: Address;
  subAccount?: Address;
  sourceDex: number;
  destinationDex: number;
  token: number;
  /** In the token's `weiDecimals` (USDC: 10^8). */
  wei: bigint;
}

/** Action 13, read from a live log: `(address destination, address subAccount, uint32 sourceDex, uint32 destinationDex, uint64 token, uint64 wei)`. */
export function encodeSendAsset(a: SendAssetAction): Hex {
  assertSmallInt(a.sourceDex, "sourceDex", 0, 0xffffffff);
  assertSmallInt(a.destinationDex, "destinationDex", 0, 0xffffffff);
  assertSmallInt(a.token, "token", 0, Number.MAX_SAFE_INTEGER);
  if (a.wei <= 0n) throw new RangeError(`wei must be positive, got ${a.wei}`);
  return encodeCoreAction(CORE_ACTIONS.sendAsset, [
    addressWord(a.destination, "destination"),
    addressWord(a.subAccount ?? "0x0000000000000000000000000000000000000000", "subAccount"),
    word(BigInt(a.sourceDex), 32, "sourceDex"),
    word(BigInt(a.destinationDex), 32, "destinationDex"),
    word(BigInt(a.token), 64, "token"),
    word(a.wei, 64, "wei"),
  ]);
}

/** ABI-encoded precompile inputs (no selector: the precompiles take raw words). */
export const encodePrecompileInput = {
  position: (user: Address, perp: number): Hex => `0x${addressWord(user, "user")}${word(BigInt(perp), 16, "perp")}` as Hex,
  spotBalance: (user: Address, token: number): Hex => `0x${addressWord(user, "user")}${word(BigInt(token), 64, "token")}` as Hex,
  withdrawable: (user: Address): Hex => `0x${addressWord(user, "user")}` as Hex,
  px: (perp: number): Hex => `0x${word(BigInt(perp), 32, "perp")}` as Hex,
  perpAssetInfo: (perp: number): Hex => `0x${word(BigInt(perp), 32, "perp")}` as Hex,
  tokenInfo: (token: number): Hex => `0x${word(BigInt(token), 32, "token")}` as Hex,
  accountMarginSummary: (perpDex: number, user: Address): Hex => `0x${word(BigInt(perpDex), 32, "perpDex")}${addressWord(user, "user")}` as Hex,
  coreUserExists: (user: Address): Hex => `0x${addressWord(user, "user")}` as Hex,
};

// ---------------------------------------------------------------------------
// Precompile decoding — fail closed: a read that does not decode is not a number
// ---------------------------------------------------------------------------

export class PrecompileDecodeError extends Error {
  constructor(readonly precompile: string, detail: string) {
    super(`${precompile}: ${detail} — the keeper refuses to act on a read it cannot decode (design §8 risk 6)`);
    this.name = "PrecompileDecodeError";
  }
}

function wordsOf(hex: string, precompile: string, expected?: number): string[] {
  if (typeof hex !== "string" || !/^0x([0-9a-fA-F]{64})*$/.test(hex)) throw new PrecompileDecodeError(precompile, `not whole 32-byte words: ${String(hex).slice(0, 80)}`);
  const body = hex.slice(2);
  const out: string[] = [];
  for (let i = 0; i < body.length; i += 64) out.push(body.slice(i, i + 64));
  if (expected !== undefined && out.length !== expected) throw new PrecompileDecodeError(precompile, `expected ${expected} words, got ${out.length}`);
  return out;
}

function uintWord(w: string, bits: number, precompile: string, name: string): bigint {
  const v = BigInt("0x" + w);
  if (v >= 1n << BigInt(bits)) throw new PrecompileDecodeError(precompile, `${name} does not fit uint${bits}`);
  return v;
}

function intWord(w: string, bits: number, precompile: string, name: string): bigint {
  let v = BigInt("0x" + w);
  if (v >= 1n << 255n) v -= 1n << 256n;
  const lim = 1n << BigInt(bits - 1);
  if (v < -lim || v >= lim) throw new PrecompileDecodeError(precompile, `${name} does not fit int${bits}`);
  return v;
}

function boolWord(w: string, precompile: string, name: string): boolean {
  const v = BigInt("0x" + w);
  if (v !== 0n && v !== 1n) throw new PrecompileDecodeError(precompile, `${name} is not a bool`);
  return v === 1n;
}

export interface PerpPosition {
  /** Signed size in 10^szDecimals; NEGATIVE for a short (read: −5176 = −51.76 ZEC). */
  szi: bigint;
  /** Entry notional, 10^6 USDC. */
  entryNtl: bigint;
  isolatedRawUsd: bigint;
  leverage: number;
  isIsolated: boolean;
}

export function decodePosition(hex: string): PerpPosition {
  const w = wordsOf(hex, "position(0x800)", 5);
  return {
    szi: intWord(w[0]!, 64, "position", "szi"),
    entryNtl: uintWord(w[1]!, 64, "position", "entryNtl"),
    isolatedRawUsd: intWord(w[2]!, 64, "position", "isolatedRawUsd"),
    leverage: Number(uintWord(w[3]!, 32, "position", "leverage")),
    isIsolated: boolWord(w[4]!, "position", "isIsolated"),
  };
}

export interface SpotBalance {
  /** In the token's `weiDecimals` (USDC: 10^8). */
  total: bigint;
  hold: bigint;
  entryNtl: bigint;
}

export function decodeSpotBalance(hex: string): SpotBalance {
  const w = wordsOf(hex, "spotBalance(0x801)", 3);
  return { total: uintWord(w[0]!, 64, "spotBalance", "total"), hold: uintWord(w[1]!, 64, "spotBalance", "hold"), entryNtl: uintWord(w[2]!, 64, "spotBalance", "entryNtl") };
}

/** 10^6 USDC. */
export function decodeWithdrawable(hex: string): bigint {
  return uintWord(wordsOf(hex, "withdrawable(0x803)", 1)[0]!, 64, "withdrawable", "withdrawable");
}

/** A mark or oracle price in 10^(6 − szDecimals). */
export function decodePx(hex: string): bigint {
  return uintWord(wordsOf(hex, "px(0x806/0x807)", 1)[0]!, 64, "px", "px");
}

export interface AccountMarginSummary {
  /** 10^6 USDC; may be negative. */
  accountValue: bigint;
  /** Initial margin in use (position value ÷ leverage), 10^6 USDC — NOT the maintenance margin. */
  marginUsed: bigint;
  ntlPos: bigint;
  rawUsd: bigint;
}

export function decodeAccountMarginSummary(hex: string): AccountMarginSummary {
  const w = wordsOf(hex, "accountMarginSummary(0x80f)", 4);
  return {
    accountValue: intWord(w[0]!, 64, "accountMarginSummary", "accountValue"),
    marginUsed: uintWord(w[1]!, 64, "accountMarginSummary", "marginUsed"),
    ntlPos: uintWord(w[2]!, 64, "accountMarginSummary", "ntlPos"),
    rawUsd: intWord(w[3]!, 64, "accountMarginSummary", "rawUsd"),
  };
}

export interface PerpAssetInfo {
  coin: string;
  marginTableId: number;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
}

function decodeString(words: string[], offsetWord: string, precompile: string, name: string): string {
  const off = Number(uintWord(offsetWord, 32, precompile, `${name} offset`));
  if (off % 32 !== 0) throw new PrecompileDecodeError(precompile, `${name} offset not word-aligned`);
  const i = off / 32;
  const len = Number(uintWord(words[i] ?? "", 32, precompile, `${name} length`));
  const hex = words.slice(i + 1).join("").slice(0, len * 2);
  if (hex.length !== len * 2) throw new PrecompileDecodeError(precompile, `${name} truncated`);
  return Buffer.from(hex, "hex").toString("utf8");
}

export function decodePerpAssetInfo(hex: string): PerpAssetInfo {
  const all = wordsOf(hex, "perpAssetInfo(0x80a)");
  if (all.length < 6) throw new PrecompileDecodeError("perpAssetInfo(0x80a)", `expected at least 6 words, got ${all.length}`);
  const head = Number(uintWord(all[0]!, 32, "perpAssetInfo", "tuple offset")) / 32;
  const t = all.slice(head);
  return {
    coin: decodeString(t, t[0]!, "perpAssetInfo", "coin"),
    marginTableId: Number(uintWord(t[1]!, 32, "perpAssetInfo", "marginTableId")),
    szDecimals: Number(uintWord(t[2]!, 8, "perpAssetInfo", "szDecimals")),
    maxLeverage: Number(uintWord(t[3]!, 8, "perpAssetInfo", "maxLeverage")),
    onlyIsolated: boolWord(t[4]!, "perpAssetInfo", "onlyIsolated"),
  };
}

export interface HyperCoreTokenInfo {
  name: string;
  spots: number[];
  deployerTradingFeeShare: bigint;
  deployer: Address;
  evmContract: Address;
  szDecimals: number;
  weiDecimals: number;
  evmExtraWeiDecimals: number;
}

export function decodeTokenInfo(hex: string): HyperCoreTokenInfo {
  const all = wordsOf(hex, "tokenInfo(0x80c)");
  if (all.length < 9) throw new PrecompileDecodeError("tokenInfo(0x80c)", `expected at least 9 words, got ${all.length}`);
  const head = Number(uintWord(all[0]!, 32, "tokenInfo", "tuple offset")) / 32;
  const t = all.slice(head);
  const spotsOff = Number(uintWord(t[1]!, 32, "tokenInfo", "spots offset")) / 32;
  const spotsLen = Number(uintWord(t[spotsOff] ?? "", 32, "tokenInfo", "spots length"));
  const spots: number[] = [];
  for (let i = 0; i < spotsLen; i++) spots.push(Number(uintWord(t[spotsOff + 1 + i] ?? "", 64, "tokenInfo", `spots[${i}]`)));
  const addr = (w: string, name: string): Address => {
    if (!/^0{24}[0-9a-f]{40}$/i.test(w)) throw new PrecompileDecodeError("tokenInfo", `${name} is not an address word`);
    return `0x${w.slice(24)}` as Address;
  };
  return {
    name: decodeString(t, t[0]!, "tokenInfo", "name"),
    spots,
    deployerTradingFeeShare: uintWord(t[2]!, 64, "tokenInfo", "deployerTradingFeeShare"),
    deployer: addr(t[3]!, "deployer"),
    evmContract: addr(t[4]!, "evmContract"),
    szDecimals: Number(uintWord(t[5]!, 8, "tokenInfo", "szDecimals")),
    weiDecimals: Number(uintWord(t[6]!, 8, "tokenInfo", "weiDecimals")),
    evmExtraWeiDecimals: Number(intWord(t[7]!, 8, "tokenInfo", "evmExtraWeiDecimals")),
  };
}

export function decodeCoreUserExists(hex: string): boolean {
  return boolWord(wordsOf(hex, "coreUserExists(0x810)", 1)[0]!, "coreUserExists", "exists");
}

// ---------------------------------------------------------------------------
// Health of a short — integer twin first (the chain's arithmetic), floats for display
// ---------------------------------------------------------------------------

/** `d` is taken as at most 0.99 (design §4), so the equivalent HF is at most 100. */
export const MAX_SHORT_DISTANCE_BPS = 9_900;

export interface ShortReads {
  /** `accountMarginSummary.accountValue` (10^6 USDC), may be negative. */
  accountValueE6: bigint;
  /** `position.szi` (10^szDecimals); the sign is checked here — a long is refused, it is not this product. */
  szi: bigint;
  /** The mark in 10^(6 − szDecimals). */
  markRaw: bigint;
  szDecimals: number;
  /** Tier-0 maintenance margin rate in bps (`maintenanceMarginRateBps(maxLeverage)`; ZEC: 500). */
  mmrBps: number;
}

function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (a <= 0n) return floorDiv(a, b) + (a % b === 0n ? 0n : 1n);
  return (a + b - 1n) / b;
}

/** The notional of one raw size unit, in 10^6 USDC: markRaw × 10^(6 − szDecimals − pxDecimals) — for ZEC exactly markRaw. */
export function unitNotionalE6(markRaw: bigint, szDecimals: number): bigint {
  const exp = 6 - szDecimals - perpPxDecimals(szDecimals);
  if (exp < 0) throw new RangeError(`szDecimals ${szDecimals}: the notional identity needs szDecimals + pxDecimals ≤ 6`);
  if (markRaw <= 0n) throw new RangeError(`mark must be positive, got ${markRaw}`);
  return markRaw * 10n ** BigInt(exp);
}

/** |szi| × unit notional, 10^6 USDC. */
export function notionalE6(szi: bigint, markRaw: bigint, szDecimals: number): bigint {
  const size = szi < 0n ? -szi : szi;
  return size * unitNotionalE6(markRaw, szDecimals);
}

/**
 * The up-move that liquidates a short, in basis points, from the venue's own rule (design §4):
 *   d = (A / (P·s) − mmr) / (1 + mmr), floored at each division, clamped to [0, MAX_SHORT_DISTANCE_BPS].
 * A non-positive account value or a size of zero is not a short in good standing and throws by name.
 */
export function shortDistanceBps(r: ShortReads): number {
  if (r.szi >= 0n) throw new RangeError(`shortDistanceBps: szi ${r.szi} is not a short — the product opens shorts only (design §11)`);
  assertSmallInt(r.mmrBps, "mmrBps", 1, 9_999);
  const ntl = notionalE6(r.szi, r.markRaw, r.szDecimals);
  const ratioBps = floorDiv(r.accountValueE6 * 10_000n, ntl);
  const d = floorDiv((ratioBps - BigInt(r.mmrBps)) * 10_000n, 10_000n + BigInt(r.mmrBps));
  if (d <= 0n) return 0;
  return d > BigInt(MAX_SHORT_DISTANCE_BPS) ? MAX_SHORT_DISTANCE_BPS : Number(d);
}

/** The short's equivalent health factor in bps: floor(10^8 / (10^4 − dBps)). 4285 → 17497 (HF 1.7497). */
export function equivalentHfBps(distanceBps: number): number {
  assertSmallInt(distanceBps, "distanceBps", 0, MAX_SHORT_DISTANCE_BPS);
  return Number(100_000_000n / BigInt(10_000 - distanceBps));
}

/** A ladder rung's HF back to the up-move it stands for: floor((hf − 1) / hf), bps. 17497 → 4285. */
export function distanceBpsForHfBps(hfBps: number): number {
  assertSmallInt(hfBps, "hfBps", 10_000, Number.MAX_SAFE_INTEGER);
  return Number(floorDiv(BigInt(hfBps - 10_000) * 10_000n, BigInt(hfBps)));
}

/** The entry distance for margin worth `marginBps` of the notional (10_000 = margin equals notional; 5_000 = "2×"). */
export function entryDistanceBpsForMarginBps(marginBps: number, mmrBps: number): number {
  assertSmallInt(marginBps, "marginBps", 1, 1_000_000);
  assertSmallInt(mmrBps, "mmrBps", 1, 9_999);
  const d = floorDiv(BigInt(marginBps - mmrBps) * 10_000n, 10_000n + BigInt(mmrBps));
  if (d <= 0n) return 0;
  return d > BigInt(MAX_SHORT_DISTANCE_BPS) ? MAX_SHORT_DISTANCE_BPS : Number(d);
}

/** The margin (bps of notional) that puts a fresh short at `distanceBps`: ceil(d × (1 + mmr) + mmr). The slider's other direction. */
export function marginBpsForEntryDistanceBps(distanceBps: number, mmrBps: number): number {
  assertSmallInt(distanceBps, "distanceBps", 0, MAX_SHORT_DISTANCE_BPS);
  assertSmallInt(mmrBps, "mmrBps", 1, 9_999);
  return Number(ceilDiv(BigInt(distanceBps) * (10_000n + BigInt(mmrBps)) + BigInt(mmrBps) * 10_000n, 10_000n));
}

/**
 * The account value (10^6 USDC) a short of `notional` needs to stand at `distanceBps`:
 *   A = P·s × (d × (1 + mmr) + mmr), rounded up.
 */
export function accountValueForDistanceE6(ntlE6: bigint, distanceBps: number, mmrBps: number): bigint {
  assertSmallInt(distanceBps, "distanceBps", 0, MAX_SHORT_DISTANCE_BPS);
  assertSmallInt(mmrBps, "mmrBps", 1, 9_999);
  return ceilDiv(ntlE6 * (BigInt(distanceBps) * (10_000n + BigInt(mmrBps)) + BigInt(mmrBps) * 10_000n), 100_000_000n);
}

/** The top-up (10^6 USDC) that lifts a short to `targetDistanceBps` with no size change; 0 when it is already there. */
export function topUpE6ForDistance(r: ShortReads, targetDistanceBps: number): bigint {
  const need = accountValueForDistanceE6(notionalE6(r.szi, r.markRaw, r.szDecimals), targetDistanceBps, r.mmrBps);
  return need > r.accountValueE6 ? need - r.accountValueE6 : 0n;
}

/**
 * The largest size (raw, 10^szDecimals) at which the account value stands at or above `targetDistanceBps`:
 *   s' = floor(A × 10^8 / (unit × (d × (1 + mmr) + mmr × 10^4))). The reduce that reaches the target is |szi| − s'.
 */
export function sizeForDistance(r: ShortReads, targetDistanceBps: number): bigint {
  assertSmallInt(targetDistanceBps, "targetDistanceBps", 0, MAX_SHORT_DISTANCE_BPS);
  if (r.accountValueE6 <= 0n) return 0n;
  const unit = unitNotionalE6(r.markRaw, r.szDecimals);
  const den = unit * (BigInt(targetDistanceBps) * (10_000n + BigInt(r.mmrBps)) + BigInt(r.mmrBps) * 10_000n);
  return (r.accountValueE6 * 100_000_000n) / den;
}

/** The reduce-only buy (raw size) that brings the short to `targetDistanceBps`; 0 when none is needed. */
export function reduceForDistance(r: ShortReads, targetDistanceBps: number): bigint {
  const size = r.szi < 0n ? -r.szi : r.szi;
  const keep = sizeForDistance(r, targetDistanceBps);
  return keep >= size ? 0n : size - keep;
}

/** A rung of the short's ladder: the shared rung, plus the up-move each threshold stands for. */
export interface PerpRung extends HfRungBps {
  distanceBps: number;
  disarmDistanceBps: number;
}

/**
 * The short's ladder for a position opened at `entryDistanceBps` (design §4): `ladderBpsFor(equivalentHfBps(d₀))`
 * with each rung converted back to a distance. The entry must map to an HF of at least MIN_LADDER_ENTRY_HF
 * (a 9.09 % distance) or four rungs do not fit; the caller's floor sits far above that.
 */
export function perpLadderFor(entryDistanceBps: number): readonly PerpRung[] {
  const hf = equivalentHfBps(entryDistanceBps);
  if (hf < MIN_LADDER_ENTRY_HF * 10_000) {
    throw new RangeError(`perpLadderFor(${entryDistanceBps} bps): the equivalent HF ${hf / 10_000} is under MIN_LADDER_ENTRY_HF ${MIN_LADDER_ENTRY_HF} — four rungs do not fit`);
  }
  return Object.freeze(
    ladderBpsFor(hf).map((r) => Object.freeze({ ...r, distanceBps: distanceBpsForHfBps(r.hfBps), disarmDistanceBps: distanceBpsForHfBps(r.disarmHfBps) }))
  );
}

/** The most severe rung whose threshold the LIVE distance is under, or null when healthy. Fail-closed on a bad input. */
export function perpRungFor(distanceBps: number, ladder: readonly PerpRung[]): PerpRung | null {
  assertSmallInt(distanceBps, "distanceBps", 0, MAX_SHORT_DISTANCE_BPS);
  const hf = equivalentHfBps(distanceBps);
  let hit: PerpRung | null = null;
  for (const r of ladder) if (hf < r.hfBps) hit = r;
  return hit;
}

/** Rung ids the venue's `protect` accepts, as the chain numbers them (0 = warn is notify-only and never on chain). */
export const PERP_RUNG_INDEX: Readonly<Record<HfRungId, number>> = Object.freeze({ warn: 0, repay: 1, derisk: 2, emergency: 3 });

/**
 * The spot-balance reserve (10^6 USDC) the top-up rung needs already on HyperCore (design §6): the top-up that
 * lifts the position from the repay rung to its disarm, sized at the highest price the rung can fire at
 * (P₀ × (1 + d₀)), times `multipleBps / 10^4` (Simple: 10_000 = 1×). Rounded up.
 */
export function perpReserveE6(notionalAtEntryE6: bigint, entryDistanceBps: number, mmrBps: number, multipleBps = 10_000): bigint {
  assertSmallInt(multipleBps, "multipleBps", 1, 1_000_000);
  assertSmallInt(mmrBps, "mmrBps", 1, 9_999);
  const repay = perpLadderFor(entryDistanceBps)[PERP_RUNG_INDEX.repay]!;
  const delta = BigInt(repay.disarmDistanceBps - repay.distanceBps);
  const num = BigInt(multipleBps) * notionalAtEntryE6 * (10_000n + BigInt(entryDistanceBps)) * (10_000n + BigInt(mmrBps)) * delta;
  return ceilDiv(num, 10_000n ** 4n);
}

/** `MAX_LADDER_ENTRY_HF` as a distance: above this entry distance the acting rungs stop deriving (D10). */
export const MAX_LADDER_ENTRY_DISTANCE_BPS = distanceBpsForHfBps(MAX_LADDER_ENTRY_HF_BPS);

// ---------------------------------------------------------------------------
// The slider's marks and the proposed floor — the founder's number, named as proposed
// ---------------------------------------------------------------------------

/** Design §4's marks: margin per dollar of notional. Marks, not modes. */
export const PERP_MARGIN_MARKS: readonly { id: "sheltered" | "expert"; marginBps: number; label: string }[] = Object.freeze([
  { id: "sheltered", marginBps: 6_667, label: "Sheltered" },
  { id: "expert", marginBps: 5_000, label: "Expert" },
]);

/** Design §10 item 1, PROPOSED and not yet the founder's: margin of half the notional (L = 2). The venue takes it as a deploy parameter. */
export const PROPOSED_PERP_ENTRY_FLOOR_MARGIN_BPS = 5_000;

// ---------------------------------------------------------------------------
// Display helpers (floats; never fed back into the money path)
// ---------------------------------------------------------------------------

/** The liquidation price of a short entered at `entryPrice` with up-move `distanceBps`. */
export function shortLiquidationPrice(entryPrice: number, distanceBps: number): number {
  if (!(entryPrice > 0)) throw new RangeError(`entryPrice must be positive`);
  return entryPrice * (1 + distanceBps / 10_000);
}

// ---------------------------------------------------------------------------
// Funding — a measured history with its variance, never a rate
// ---------------------------------------------------------------------------

export interface FundingSample {
  /** Unix ms. */
  time: number;
  /** The hourly rate as the API gives it, a decimal string; positive = longs pay shorts. */
  fundingRate: string;
}

export interface FundingStats {
  samples: number;
  firstIso: string;
  lastIso: string;
  hours: number;
  meanAnnualisedPct: number;
  medianAnnualisedPct: number;
  minAnnualisedPct: number;
  maxAnnualisedPct: number;
  negativeHours: number;
  negativeSharePct: number;
  /** The sum of the hourly rates over the window, percent of notional — what a short actually received. */
  realisedPctOverWindow: number;
  /** The realised carry annualised at the window's own pace. */
  realisedAnnualisedPct: number;
}

/** An hourly funding rate as a percent per year: rate × 24 × 365 × 100 (the venue pays hourly). */
export function annualisedFundingPct(hourlyRate: number): number {
  if (!Number.isFinite(hourlyRate)) throw new RangeError(`hourlyRate must be finite`);
  return hourlyRate * 24 * 365 * 100;
}

/** The measured history's statistics, in the shape the facts file reports them. Throws on an empty or unsorted window. */
export function fundingStats(rows: readonly FundingSample[]): FundingStats {
  if (!Array.isArray(rows) || rows.length === 0) throw new RangeError("fundingStats: no samples");
  const rates = rows.map((r) => {
    const v = Number(r.fundingRate);
    if (!Number.isFinite(v)) throw new RangeError(`fundingStats: bad rate ${String(r.fundingRate)}`);
    return v;
  });
  for (let i = 1; i < rows.length; i++) if (!(rows[i]!.time > rows[i - 1]!.time)) throw new RangeError("fundingStats: samples must be strictly increasing in time");
  const ann = rates.map(annualisedFundingPct);
  const sorted = [...ann].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const sum = rates.reduce((a, b) => a + b, 0);
  const hours = rows.length;
  const negative = rates.filter((r) => r < 0).length;
  return {
    samples: rows.length,
    firstIso: new Date(rows[0]!.time).toISOString(),
    lastIso: new Date(rows[rows.length - 1]!.time).toISOString(),
    hours,
    meanAnnualisedPct: ann.reduce((a, b) => a + b, 0) / ann.length,
    medianAnnualisedPct: median,
    minAnnualisedPct: sorted[0]!,
    maxAnnualisedPct: sorted[sorted.length - 1]!,
    negativeHours: negative,
    negativeSharePct: (100 * negative) / hours,
    realisedPctOverWindow: sum * 100,
    realisedAnnualisedPct: (sum * 100 * 24 * 365) / hours,
  };
}

/**
 * The realised carry on the user's MARGIN over a window, percent: funding is paid on the notional, so a
 * dollar of margin backing `10_000 / marginBps` dollars of notional earns that multiple of the rate.
 */
export function realisedCarryOnMarginPct(rows: readonly FundingSample[], marginBps: number): number {
  assertSmallInt(marginBps, "marginBps", 1, 1_000_000);
  return (fundingStats(rows).realisedPctOverWindow * 10_000) / marginBps;
}

// ---------------------------------------------------------------------------

function assertSmallInt(v: number, name: string, min: number, max: number): void {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${String(v)}`);
  }
}
