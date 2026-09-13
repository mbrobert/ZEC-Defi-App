/**
 * Kamino Lend (klend) on Solana — the ZCASH market's two reserves, the market's flags and the Scope prices the
 * reserves read, fetched in ONE `getMultipleAccounts` and decoded strictly at byte offsets. Zero dependencies
 * (fetch + Buffer + node:crypto), like every other source here.
 *
 * Every offset below was computed from klend-sdk 12.0.0's borsh layouts (`Reserve.layout.offsetOf`, …) and
 * checked against a mainnet capture at slot 446,506,191 (test/fixtures/solana-mainnet-2026-09-12.json) and the
 * live LendingMarket at slot 446,591,426 (test/fixtures/solana-lending-market-2026-09-13.json): the raw read at
 * each offset equals the SDK's decode of the same bytes, and the numbers equal VERIFIED-SOLANA-FACTS.md. The
 * keeper (`agent/src/solana/layouts.ts`) carries the subset it needs of the same table; both are pinned to the
 * same capture, so a klend layout change fails both seams.
 *
 * What the numbers are for (SOLANA-ARCHITECTURE.md §7 under BUILD-PLAN-2026-09-12 D4/D5): a borrow on Kamino
 * moves the USDC pool's utilisation and therefore the rate every borrower pays. The site SHOWS the rate after
 * this borrow, the pool's depth and the account's share; it REFUSES only for safety — venue paused, borrowing
 * disabled, a borrow the pool cannot fund or its limits forbid, a deposit above the reserve's cap, a stale
 * read, a stale or out-of-band oracle (`solanaBorrow.ts`).
 */
import { createHash } from "node:crypto";
import { KAMINO_ZCASH_MARKET, SOLANA_PROGRAMS, SOLANA_TOKENS, type SolanaTokenSymbol } from "@zyo/shared";
import { RpcClient } from "./rpc.js";

// ---------------------------------------------------------------------------
// Layouts (byte offsets INCLUDING the 8-byte anchor discriminator)
// ---------------------------------------------------------------------------

export const KLEND_RESERVE_LEN = 8624;
export const KLEND_MARKET_LEN = 4664;
/** Scope `OraclePrices`: 8 + 32 + 512 × 56. */
export const SCOPE_PRICES_LEN = 28_712;
export const SF_ONE = 1n << 60n;
/** Scope entries are `DatedPrice { price { value u64, exp u64 }, last_updated_slot u64, unix_timestamp u64, … }` of 56 bytes from byte 40. */
export const SCOPE_ENTRY_BASE = 40;
export const SCOPE_ENTRY_SIZE = 56;

export const KLEND_RESERVE = {
  lastUpdateSlot: 16,
  lastUpdateStale: 24,
  lastUpdatePriceStatus: 25,
  lendingMarket: 32,
  liquidityMint: 128,
  liquidityAvailable: 224, // u64  `totalAvailableAmount`
  liquidityBorrowedSf: 232, // u128 scaled by 2^60
  liquidityMarketPriceSf: 248, // u128
  liquidityMintDecimals: 272, // u64
  collateralMintTotalSupply: 2592, // u64
  configStatus: 4856, // u8: 0 active
  configLoanToValuePct: 4872, // u8
  configLiquidationThresholdPct: 4873, // u8
  configBorrowRateCurve: 4920, // 11 × { utilizationRateBps u32, borrowRateBps u32 }
  configBorrowRateCurvePoints: 11,
  configBorrowFactorPct: 5008, // u64
  configDepositLimit: 5016, // u64, liquidity units
  configBorrowLimit: 5024, // u64, liquidity units
  tokenInfoName: 5032, // [u8; 32]
  tokenInfoHeuristicLower: 5064, // u64 (× 10^-exp USD)
  tokenInfoHeuristicUpper: 5072, // u64
  tokenInfoHeuristicExp: 5080, // u64
  tokenInfoMaxTwapDivergenceBps: 5088, // u64
  tokenInfoMaxAgePriceSeconds: 5096, // u64
  tokenInfoMaxAgeTwapSeconds: 5104, // u64
  scopePriceFeed: 5112, // pubkey
  scopePriceChain0: 5144, // u16 (of [u16; 4]; 65535 = unused)
  scopeTwapChain0: 5152, // u16
  /** `WithdrawalCaps { configCapacity i64, currentTotal i64, lastIntervalStartTimestamp u64, configIntervalLengthSeconds u64 }` — withdrawals of deposits per interval (deposits subtract). */
  configDepositWithdrawalCap: 5416,
  /** Same shape — borrows per interval (repayments subtract). */
  configDebtWithdrawalCap: 5448,
  configUtilizationLimitBlockBorrowingAbovePct: 5501, // u8, 0 = off
} as const;

export const KLEND_MARKET = {
  lendingMarketOwner: 24, // pubkey
  emergencyMode: 122, // u8
  autodeleverageEnabled: 123, // u8
  borrowDisabled: 124, // u8
} as const;

/** Anchor account discriminators: sha256("account:<Name>")[0..8]. */
const disc = (name: string): Buffer => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
export const KLEND_DISCRIMINATOR = { reserve: disc("Reserve"), lendingMarket: disc("LendingMarket") } as const;

// ---------------------------------------------------------------------------
// Decoders — every one refuses a wrong-sized, wrong-discriminator or wrong-address buffer
// ---------------------------------------------------------------------------

export class KaminoDecodeError extends Error {
  constructor(what: string, detail: string) {
    super(`kamino ${what}: ${detail}`);
    this.name = "KaminoDecodeError";
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Base58 of a 32-byte key (the only base58 this module needs; no dependency for it). */
export function pubkeyBase58(b: Buffer): string {
  if (b.length !== 32) throw new KaminoDecodeError("pubkey", `${b.length} bytes`);
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

const u64 = (b: Buffer, o: number): bigint => b.readBigUInt64LE(o);
const i64 = (b: Buffer, o: number): bigint => b.readBigInt64LE(o);
const u128 = (b: Buffer, o: number): bigint => b.readBigUInt64LE(o) + (b.readBigUInt64LE(o + 8) << 64n);
const pk = (b: Buffer, o: number): string => pubkeyBase58(b.subarray(o, o + 32));

export interface WithdrawalCaps {
  configCapacity: bigint;
  currentTotal: bigint;
  lastIntervalStartTimestamp: bigint;
  configIntervalLengthSeconds: bigint;
}

export interface KaminoReserveView {
  address: string;
  symbol: SolanaTokenSymbol;
  lendingMarket: string;
  liquidityMint: string;
  lastUpdateSlot: bigint;
  lastUpdateStale: boolean;
  lastUpdatePriceStatus: number;
  /** Liquidity units (10^decimals per token). */
  availableUnits: bigint;
  /** floor(borrowedAmountSf / 2^60), liquidity units. */
  borrowedUnits: bigint;
  borrowedSf: bigint;
  /** Kamino's own cached price, USD (scaled fraction). */
  marketPriceUsd: number;
  mintDecimals: number;
  collateralTotalSupply: bigint;
  status: number;
  loanToValuePct: number;
  liquidationThresholdPct: number;
  borrowFactorPct: number;
  /** Deduplicated (utilisation bps, borrow APR bps) points, ascending in utilisation. */
  borrowRateCurve: [number, number][];
  depositLimitUnits: bigint;
  borrowLimitUnits: bigint;
  heuristicLowerUsd: number;
  heuristicUpperUsd: number;
  maxTwapDivergenceBps: number;
  maxAgePriceSeconds: number;
  maxAgeTwapSeconds: number;
  scopePriceFeed: string;
  scopePriceChain0: number;
  scopeTwapChain0: number;
  depositWithdrawalCap: WithdrawalCaps;
  debtWithdrawalCap: WithdrawalCaps;
  utilizationLimitBlockBorrowingAbovePct: number;
}

export interface KaminoMarketView {
  address: string;
  owner: string;
  emergencyMode: number;
  autodeleverageEnabled: number;
  borrowDisabled: number;
}

export interface ScopePriceView {
  index: number;
  value: bigint;
  exp: number;
  priceUsd: number;
  lastUpdatedSlot: bigint;
  unixTimestamp: bigint;
}

function caps(b: Buffer, o: number): WithdrawalCaps {
  return { configCapacity: i64(b, o), currentTotal: i64(b, o + 8), lastIntervalStartTimestamp: u64(b, o + 16), configIntervalLengthSeconds: u64(b, o + 24) };
}

export function decodeKaminoReserve(b: Buffer, expect: { address: string; symbol: SolanaTokenSymbol }): KaminoReserveView {
  if (b.length !== KLEND_RESERVE_LEN) throw new KaminoDecodeError(`reserve ${expect.symbol}`, `${b.length} bytes, want ${KLEND_RESERVE_LEN}`);
  if (!b.subarray(0, 8).equals(KLEND_DISCRIMINATOR.reserve)) throw new KaminoDecodeError(`reserve ${expect.symbol}`, "not a klend Reserve (discriminator)");
  const R = KLEND_RESERVE;
  const lendingMarket = pk(b, R.lendingMarket);
  if (lendingMarket !== KAMINO_ZCASH_MARKET.lendingMarket) throw new KaminoDecodeError(`reserve ${expect.symbol}`, `belongs to market ${lendingMarket}, not the ZCASH market`);
  const liquidityMint = pk(b, R.liquidityMint);
  if (liquidityMint !== SOLANA_TOKENS[expect.symbol].mint) throw new KaminoDecodeError(`reserve ${expect.symbol}`, `mint ${liquidityMint} is not ${expect.symbol}'s`);
  const mintDecimals = Number(u64(b, R.liquidityMintDecimals));
  if (mintDecimals !== SOLANA_TOKENS[expect.symbol].decimals) throw new KaminoDecodeError(`reserve ${expect.symbol}`, `decimals ${mintDecimals}, want ${SOLANA_TOKENS[expect.symbol].decimals}`);
  const raw: [number, number][] = [];
  for (let i = 0; i < R.configBorrowRateCurvePoints; i++) {
    const o = R.configBorrowRateCurve + i * 8;
    raw.push([b.readUInt32LE(o), b.readUInt32LE(o + 4)]);
  }
  const borrowRateCurve = raw.filter((p, i) => i === 0 || p[0] !== raw[i - 1][0] || p[1] !== raw[i - 1][1]);
  for (let i = 1; i < borrowRateCurve.length; i++) {
    if (borrowRateCurve[i][0] < borrowRateCurve[i - 1][0]) throw new KaminoDecodeError(`reserve ${expect.symbol}`, "borrow curve not sorted by utilisation");
  }
  if (borrowRateCurve[0][0] !== 0 || borrowRateCurve[borrowRateCurve.length - 1][0] !== 10_000) throw new KaminoDecodeError(`reserve ${expect.symbol}`, "borrow curve does not span 0–100 % utilisation");
  const exp = Number(u64(b, R.tokenInfoHeuristicExp));
  const scopePriceChain0 = b.readUInt16LE(R.scopePriceChain0);
  const shared = KAMINO_ZCASH_MARKET.reserves[expect.symbol];
  if (scopePriceChain0 !== shared.scopePriceChain[0]) throw new KaminoDecodeError(`reserve ${expect.symbol}`, `Scope chain ${scopePriceChain0}, shared says ${shared.scopePriceChain[0]}`);
  const scopePriceFeed = pk(b, R.scopePriceFeed);
  if (scopePriceFeed !== KAMINO_ZCASH_MARKET.scopeOraclePrices) throw new KaminoDecodeError(`reserve ${expect.symbol}`, `Scope feed ${scopePriceFeed} is not the market's OraclePrices`);
  const borrowedSf = u128(b, R.liquidityBorrowedSf);
  return {
    address: expect.address,
    symbol: expect.symbol,
    lendingMarket,
    liquidityMint,
    lastUpdateSlot: u64(b, R.lastUpdateSlot),
    lastUpdateStale: b[R.lastUpdateStale] !== 0,
    lastUpdatePriceStatus: b[R.lastUpdatePriceStatus],
    availableUnits: u64(b, R.liquidityAvailable),
    borrowedUnits: borrowedSf / SF_ONE,
    borrowedSf,
    marketPriceUsd: Number((u128(b, R.liquidityMarketPriceSf) * 1_000_000n) / SF_ONE) / 1e6,
    mintDecimals,
    collateralTotalSupply: u64(b, R.collateralMintTotalSupply),
    status: b[R.configStatus],
    loanToValuePct: b[R.configLoanToValuePct],
    liquidationThresholdPct: b[R.configLiquidationThresholdPct],
    borrowFactorPct: Number(u64(b, R.configBorrowFactorPct)),
    borrowRateCurve,
    depositLimitUnits: u64(b, R.configDepositLimit),
    borrowLimitUnits: u64(b, R.configBorrowLimit),
    heuristicLowerUsd: Number(u64(b, R.tokenInfoHeuristicLower)) / 10 ** exp,
    heuristicUpperUsd: Number(u64(b, R.tokenInfoHeuristicUpper)) / 10 ** exp,
    maxTwapDivergenceBps: Number(u64(b, R.tokenInfoMaxTwapDivergenceBps)),
    maxAgePriceSeconds: Number(u64(b, R.tokenInfoMaxAgePriceSeconds)),
    maxAgeTwapSeconds: Number(u64(b, R.tokenInfoMaxAgeTwapSeconds)),
    scopePriceFeed,
    scopePriceChain0,
    scopeTwapChain0: b.readUInt16LE(R.scopeTwapChain0),
    depositWithdrawalCap: caps(b, R.configDepositWithdrawalCap),
    debtWithdrawalCap: caps(b, R.configDebtWithdrawalCap),
    utilizationLimitBlockBorrowingAbovePct: b[R.configUtilizationLimitBlockBorrowingAbovePct],
  };
}

export function decodeKaminoMarket(b: Buffer, address: string): KaminoMarketView {
  if (b.length !== KLEND_MARKET_LEN) throw new KaminoDecodeError("market", `${b.length} bytes, want ${KLEND_MARKET_LEN}`);
  if (!b.subarray(0, 8).equals(KLEND_DISCRIMINATOR.lendingMarket)) throw new KaminoDecodeError("market", "not a klend LendingMarket (discriminator)");
  if (address !== KAMINO_ZCASH_MARKET.lendingMarket) throw new KaminoDecodeError("market", `${address} is not the ZCASH market`);
  return {
    address,
    owner: pk(b, KLEND_MARKET.lendingMarketOwner),
    emergencyMode: b[KLEND_MARKET.emergencyMode],
    autodeleverageEnabled: b[KLEND_MARKET.autodeleverageEnabled],
    borrowDisabled: b[KLEND_MARKET.borrowDisabled],
  };
}

export function decodeScopePrice(b: Buffer, index: number): ScopePriceView {
  if (b.length !== SCOPE_PRICES_LEN) throw new KaminoDecodeError("scope", `${b.length} bytes, want ${SCOPE_PRICES_LEN}`);
  if (!Number.isInteger(index) || index < 0 || index >= 512) throw new KaminoDecodeError("scope", `entry ${index} out of range`);
  const o = SCOPE_ENTRY_BASE + index * SCOPE_ENTRY_SIZE;
  const value = u64(b, o);
  const exp = Number(u64(b, o + 8));
  if (exp > 18) throw new KaminoDecodeError("scope", `entry ${index} exponent ${exp}`);
  return { index, value, exp, priceUsd: Number(value) / 10 ** exp, lastUpdatedSlot: u64(b, o + 16), unixTimestamp: u64(b, o + 24) };
}

// ---------------------------------------------------------------------------
// The source
// ---------------------------------------------------------------------------

export interface KaminoSample {
  sampledAt: string;
  /** Slot the accounts were read at (the RPC's context slot) and the chain time of that slot. */
  slot: number;
  chainTimeS: number;
  market: KaminoMarketView;
  zec: KaminoReserveView;
  usdc: KaminoReserveView;
  scopeZec: ScopePriceView;
  scopeUsdc: ScopePriceView;
  source: "solana-rpc";
}

interface RpcAccount {
  data: [string, string];
  owner: string;
  executable: boolean;
  lamports: number;
}
interface MultipleAccounts {
  context: { slot: number };
  value: (RpcAccount | null)[];
}

/** Reads the four accounts in one call. Constructed only when `SOLANA_RPC_URL` is set. */
export class KaminoSource {
  private readonly rpc: RpcClient;
  constructor(
    rpcUrl: string,
    private readonly now: () => number = () => Date.now(),
    opts: { fetchImpl?: typeof fetch; timeoutMs?: number; retries?: number } = {}
  ) {
    this.rpc = new RpcClient(rpcUrl, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs ?? 20_000, retries: opts.retries ?? 2, batchSize: 1 });
  }

  async sample(): Promise<KaminoSample> {
    const addresses = [KAMINO_ZCASH_MARKET.lendingMarket, KAMINO_ZCASH_MARKET.reserves.ZEC.address, KAMINO_ZCASH_MARKET.reserves.USDC.address, KAMINO_ZCASH_MARKET.scopeOraclePrices];
    const res = await this.rpc.call<MultipleAccounts>("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }]);
    if (!res || !Array.isArray(res.value) || res.value.length !== 4) throw new KaminoDecodeError("rpc", "getMultipleAccounts returned an unexpected shape");
    const [m, z, u, s] = res.value;
    const bytes = (a: RpcAccount | null, what: string, owner: string): Buffer => {
      if (!a) throw new KaminoDecodeError(what, "account absent");
      if (a.owner !== owner) throw new KaminoDecodeError(what, `owned by ${a.owner}, want ${owner}`);
      if (!Array.isArray(a.data) || a.data[1] !== "base64") throw new KaminoDecodeError(what, "not base64");
      return Buffer.from(a.data[0], "base64");
    };
    const market = decodeKaminoMarket(bytes(m, "market", SOLANA_PROGRAMS.klend), KAMINO_ZCASH_MARKET.lendingMarket);
    const zec = decodeKaminoReserve(bytes(z, "reserve ZEC", SOLANA_PROGRAMS.klend), { address: KAMINO_ZCASH_MARKET.reserves.ZEC.address, symbol: "ZEC" });
    const usdc = decodeKaminoReserve(bytes(u, "reserve USDC", SOLANA_PROGRAMS.klend), { address: KAMINO_ZCASH_MARKET.reserves.USDC.address, symbol: "USDC" });
    const scope = bytes(s, "scope", SOLANA_PROGRAMS.scope);
    const scopeZec = decodeScopePrice(scope, zec.scopePriceChain0);
    const scopeUsdc = decodeScopePrice(scope, usdc.scopePriceChain0);
    const slot = res.context.slot;
    const chainTime = await this.rpc.call<number | null>("getBlockTime", [slot]);
    if (typeof chainTime !== "number") throw new KaminoDecodeError("rpc", `no block time for slot ${slot}`);
    return { sampledAt: new Date(this.now()).toISOString(), slot, chainTimeS: chainTime, market, zec, usdc, scopeZec, scopeUsdc, source: "solana-rpc" };
  }
}
