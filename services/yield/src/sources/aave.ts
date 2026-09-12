/**
 * Aave v3 (Base) rates + risk parameters from the PoolDataProvider.
 *
 * Reads, per reserve, in one batched eth_call round:
 *   getReserveData(address)              → liquidityRate / variableBorrowRate (ray)
 *   getReserveConfigurationData(address) → LTV / liquidation threshold / bonus (bps),
 *                                          collateral + borrowing flags
 *   getPaused(address)                   → the guardian pause flag
 *   getInterestRateStrategyAddress(USDC) → the borrow reserve's strategy, then on it
 *   getInterestRateDataBps(USDC)         → the two-slope curve (forecast: rate after a borrow)
 *   and, from getReserveData's words 2 and 4, totalAToken / totalVariableDebt (forecast:
 *   pool liquidity, the "cannot fund" hard-refusal). Added 2026-09-12, BUILD-PLAN A3.
 *
 * `getPaused` is a SEPARATE call on purpose: the 10-word configuration tuple
 * carries isActive and isFrozen but NOT isPaused, so before it was read a
 * paused reserve decoded as active-and-unfrozen and the gate kept quoting its
 * borrow rate while every supply/borrow reverted on chain — fail-closed at
 * the contract, wrong at the surface (audit wave 1, lens D LOW-1).
 *
 * Addresses come ONLY from @zyo/shared AAVE_V3 / BASE_TOKENS
 * (docs/VERIFIED-BASE-FACTS.md, read live 2026-09-05: USDC variable borrow
 * 4.828%, cbBTC LT 78.00%, WETH LT 83.00%). Selectors are pinned constants
 * and re-derived from the signatures in test/aave.test.ts with the vendored
 * keccak.
 *
 * STRICT DECODING: each return must be exactly the word count the ABI
 * declares (12 words for getReserveData on v3.x, 10 for the configuration
 * tuple). A short, empty, or reverted return throws — the caller keeps the
 * previous sample (served stale) or 503s. Nothing is ever read as zero.
 *
 * STALENESS CONTRACT: the sample carries `sampledAt` only. `stale` is
 * computed by the server at serve time from the sample's age, so a source
 * that stops answering can never keep a payload "fresh" (audit Lens F).
 */

import { AAVE_V3, BASE_TOKENS, COLLATERAL_SYMBOLS, COLLATERAL_ASSETS, BORROW_ASSET } from "@zyo/shared";
import type { RpcClient } from "./rpc.js";
import type { AaveBorrowCurve, AaveRatesSample, AaveReserve, Address } from "../types.js";

/** keccak("getReserveData(address)")[:4] — pinned in test/aave.test.ts. */
export const SEL_GET_RESERVE_DATA = "0x35ea6a75";
/** keccak("getReserveConfigurationData(address)")[:4] — pinned in test/aave.test.ts. */
export const SEL_GET_RESERVE_CONFIGURATION_DATA = "0x3e150141";
/** keccak("getPaused(address)")[:4] — pinned in test/aave.test.ts. */
export const SEL_GET_PAUSED = "0xb55d9904";
/**
 * keccak("getInterestRateStrategyAddress(address)")[:4] — pinned in test/aave.test.ts.
 * The Pool's per-reserve strategy; on Base USDC it is DefaultReserveInterestRateStrategyV2
 * 0x86AB1C62A8bf868E1b3E1ab87d587Aba6fbCbDC5 (read 2026-09-12, block 51,227,701,
 * docs/VERIFIED-BASE-FACTS.md Addendum 13) — read live every sample, never pinned.
 */
export const SEL_GET_INTEREST_RATE_STRATEGY_ADDRESS = "0x6744362a";
/**
 * keccak("getInterestRateDataBps(address)")[:4] — pinned in test/aave.test.ts. On the V2
 * strategy: (uint16 optimalUsageRatio, uint32 baseVariableBorrowRate, uint32 variableRateSlope1,
 * uint32 variableRateSlope2), all bps, ABI-encoded as four words.
 */
export const SEL_GET_INTEREST_RATE_DATA_BPS = "0xc79ce42e";

/** Word counts the calls MUST return (strict decoding). */
export const RESERVE_DATA_WORDS = 12;
export const RESERVE_CONFIG_WORDS = 10;
export const PAUSED_WORDS = 1;
export const STRATEGY_ADDRESS_WORDS = 1;
export const RATE_DATA_WORDS = 4;
/** A slope or base above this (bps) is not a plausible Aave curve — refuse rather than quote. */
export const MAX_CURVE_BPS = 1_000_000;

const RAY = 10n ** 27n;
/** ray → percent with 4-decimal precision (4.828% ↔ 0.04828 ray-fraction). */
function rayToPct(ray: bigint): number {
  // (ray × 1e6) / 1e27 = percent × 1e4 → integer division keeps it exact to 1e-4 %.
  return Number((ray * 1_000_000n) / RAY) / 10_000;
}

function encodeAddressArg(addr: string): string {
  return addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

function wordAt(raw: string, i: number): string {
  return raw.slice(i * 64, (i + 1) * 64);
}

export class AaveDecodeError extends Error {
  constructor(what: string, detail: string) {
    super(`aave ${what}: ${detail}`);
    this.name = "AaveDecodeError";
  }
}

/** Reject anything but exactly `words` 32-byte words. */
export function strictWords(raw: string | undefined, words: number, what: string): string {
  const hex = (raw ?? "").replace(/^0x/, "");
  if (!hex) throw new AaveDecodeError(what, "empty return (reverted or wrong address)");
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new AaveDecodeError(what, "non-hex return");
  if (hex.length !== words * 64) {
    throw new AaveDecodeError(what, `expected ${words} words, got ${hex.length / 64}`);
  }
  return hex;
}

function boolWord(w: string, what: string): boolean {
  const v = BigInt(`0x${w}`);
  if (v !== 0n && v !== 1n) throw new AaveDecodeError(what, `bool word is ${v}`);
  return v === 1n;
}

function bpsWord(w: string, what: string): number {
  const v = BigInt(`0x${w}`);
  if (v > 10_000n) throw new AaveDecodeError(what, `bps word ${v} > 10000`);
  return Number(v);
}

export function decodeReserve(
  symbol: string,
  address: Address,
  reserveDataRaw: string | undefined,
  configRaw: string | undefined,
  pausedRaw: string | undefined
): AaveReserve {
  const rd = strictWords(reserveDataRaw, RESERVE_DATA_WORDS, `${symbol}.getReserveData`);
  const cf = strictWords(configRaw, RESERVE_CONFIG_WORDS, `${symbol}.getReserveConfigurationData`);
  const pz = strictWords(pausedRaw, PAUSED_WORDS, `${symbol}.getPaused`);
  // getReserveData: (unbacked, accruedToTreasuryScaled, totalAToken,
  //   totalStableDebt, totalVariableDebt, liquidityRate, variableBorrowRate,
  //   stableBorrowRate, averageStableBorrowRate, liquidityIndex,
  //   variableBorrowIndex, lastUpdateTimestamp)
  const totalAToken = BigInt(`0x${wordAt(rd, 2)}`);
  const totalVariableDebt = BigInt(`0x${wordAt(rd, 4)}`);
  const liquidityRate = BigInt(`0x${wordAt(rd, 5)}`);
  const variableBorrowRate = BigInt(`0x${wordAt(rd, 6)}`);
  // Debt above supply is not a state Aave can be in; a decode that says so is a wrong address or ABI.
  if (totalVariableDebt > totalAToken) {
    throw new AaveDecodeError(`${symbol}.getReserveData`, `totalVariableDebt ${totalVariableDebt} > totalAToken ${totalAToken}`);
  }
  // A rate above 100% APR (1 ray) is not a plausible Aave reserve state —
  // refuse rather than quote it.
  if (liquidityRate > RAY || variableBorrowRate > RAY) {
    throw new AaveDecodeError(`${symbol}.getReserveData`, "rate exceeds 1 ray (100%)");
  }
  // getReserveConfigurationData: (decimals, ltv, liquidationThreshold,
  //   liquidationBonus, reserveFactor, usageAsCollateralEnabled,
  //   borrowingEnabled, stableBorrowRateEnabled, isActive, isFrozen)
  const w = (i: number) => wordAt(cf, i);
  const bonusRaw = BigInt(`0x${w(3)}`);
  // Aave encodes the bonus as 10000 + bonus bps (10750 = 7.5%); 0 = unlisted.
  if (bonusRaw !== 0n && (bonusRaw < 10_000n || bonusRaw > 20_000n)) {
    throw new AaveDecodeError(`${symbol}.config`, `liquidationBonus word ${bonusRaw} out of range`);
  }
  const decimals = Number(BigInt(`0x${w(0)}`));
  if (!(decimals >= 0 && decimals <= 36)) throw new AaveDecodeError(`${symbol}.config`, `decimals word ${decimals} out of range`);
  return {
    symbol,
    address,
    supplyAprPct: rayToPct(liquidityRate),
    variableBorrowAprPct: rayToPct(variableBorrowRate),
    decimals,
    totalATokenUnits: totalAToken.toString(),
    totalVariableDebtUnits: totalVariableDebt.toString(),
    ltvBps: bpsWord(w(1), `${symbol}.ltv`),
    liquidationThresholdBps: bpsWord(w(2), `${symbol}.liquidationThreshold`),
    liquidationBonusBps: bonusRaw === 0n ? 0 : Number(bonusRaw - 10_000n),
    usageAsCollateralEnabled: boolWord(w(5), `${symbol}.usageAsCollateralEnabled`),
    borrowingEnabled: boolWord(w(6), `${symbol}.borrowingEnabled`),
    isActive: boolWord(w(8), `${symbol}.isActive`),
    isFrozen: boolWord(w(9), `${symbol}.isFrozen`),
    isPaused: boolWord(pz, `${symbol}.getPaused`),
  };
}

/** The strategy's four-word rate data, strictly decoded and bounded. */
export function decodeBorrowCurve(strategy: Address, rateDataRaw: string | undefined): AaveBorrowCurve {
  const rd = strictWords(rateDataRaw, RATE_DATA_WORDS, "USDC.getInterestRateDataBps");
  const n = (i: number, what: string, max: bigint): number => {
    const v = BigInt(`0x${wordAt(rd, i)}`);
    if (v > max) throw new AaveDecodeError("USDC.getInterestRateDataBps", `${what} ${v} > ${max}`);
    return Number(v);
  };
  const optimalUsageBps = n(0, "optimalUsageRatio", 10_000n);
  if (optimalUsageBps === 0) throw new AaveDecodeError("USDC.getInterestRateDataBps", "optimalUsageRatio is 0");
  return {
    strategy,
    optimalUsageBps,
    baseVariableBorrowRateBps: n(1, "baseVariableBorrowRate", BigInt(MAX_CURVE_BPS)),
    variableRateSlope1Bps: n(2, "variableRateSlope1", BigInt(MAX_CURVE_BPS)),
    variableRateSlope2Bps: n(3, "variableRateSlope2", BigInt(MAX_CURVE_BPS)),
  };
}

/** One address word → checksum-free lowercase address; the zero address is a wrong ABI, not a strategy. */
export function decodeStrategyAddress(raw: string | undefined): Address {
  const w = strictWords(raw, STRATEGY_ADDRESS_WORDS, "USDC.getInterestRateStrategyAddress");
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(w)) throw new AaveDecodeError("USDC.getInterestRateStrategyAddress", "not an address word");
  const addr = `0x${w.slice(24).toLowerCase()}` as Address;
  if (addr === `0x${"0".repeat(40)}`) throw new AaveDecodeError("USDC.getInterestRateStrategyAddress", "zero address");
  return addr;
}

export class AaveSource {
  readonly dataProvider: Address = AAVE_V3.poolDataProvider.toLowerCase() as Address;

  constructor(
    private readonly rpc: RpcClient,
    /** Injectable clock for tests. */
    private readonly now: () => number = () => Date.now()
  ) {}

  /** The reserves v1 reads: the borrow asset + every ENABLED collateral. */
  reserves(): { symbol: string; address: Address }[] {
    const out: { symbol: string; address: Address }[] = [
      { symbol: BORROW_ASSET, address: BASE_TOKENS[BORROW_ASSET].address.toLowerCase() as Address },
    ];
    for (const s of COLLATERAL_SYMBOLS) {
      const c = COLLATERAL_ASSETS[s];
      if (!c.enabled || c.venue !== "aave-v3") continue;
      out.push({ symbol: s, address: c.address.toLowerCase() as Address });
    }
    return out;
  }

  /**
   * One sample. Throws on ANY unreadable reserve — a half-read sample would
   * let the gate run on a borrow rate whose collateral side is missing.
   */
  async sample(): Promise<AaveRatesSample> {
    const reserves = this.reserves();
    const calls = reserves.flatMap((r) => [
      {
        method: "eth_call",
        params: [{ to: this.dataProvider, data: SEL_GET_RESERVE_DATA + encodeAddressArg(r.address) }, "latest"],
      },
      {
        method: "eth_call",
        params: [
          { to: this.dataProvider, data: SEL_GET_RESERVE_CONFIGURATION_DATA + encodeAddressArg(r.address) },
          "latest",
        ],
      },
      {
        method: "eth_call",
        params: [{ to: this.dataProvider, data: SEL_GET_PAUSED + encodeAddressArg(r.address) }, "latest"],
      },
    ]);
    // The borrow reserve's strategy address rides in the same round; its rate data needs a second
    // round because the target is the strategy itself. Both are strict: a sample without the curve
    // would let the forecast quote "the rate after this borrow" from nothing.
    const borrowAddress = reserves[0]!.address;
    calls.push({
      method: "eth_call",
      params: [{ to: this.dataProvider, data: SEL_GET_INTEREST_RATE_STRATEGY_ADDRESS + encodeAddressArg(borrowAddress) }, "latest"],
    });
    const results = await this.rpc.callMany<string>(calls);
    if (results.length !== calls.length) {
      throw new AaveDecodeError("batch", `expected ${calls.length} results, got ${results.length}`);
    }
    const decoded = reserves.map((r, i) =>
      decodeReserve(r.symbol, r.address, results[3 * i], results[3 * i + 1], results[3 * i + 2])
    );
    const borrow = decoded[0]!;
    if (!borrow.borrowingEnabled || !borrow.isActive || borrow.isFrozen) {
      throw new AaveDecodeError(BORROW_ASSET, "reserve is not borrowable (flags) — refusing to quote a borrow rate");
    }
    const strategy = decodeStrategyAddress(results[calls.length - 1]);
    const rateData = await this.rpc.callMany<string>([
      { method: "eth_call", params: [{ to: strategy, data: SEL_GET_INTEREST_RATE_DATA_BPS + encodeAddressArg(borrowAddress) }, "latest"] },
    ]);
    if (rateData.length !== 1) throw new AaveDecodeError("batch", `expected 1 strategy result, got ${rateData.length}`);
    const borrowCurve = decodeBorrowCurve(strategy, rateData[0]);
    const collateral: Record<string, AaveReserve> = {};
    for (const r of decoded.slice(1)) collateral[r.symbol] = r;
    return {
      source: "aave-v3-base",
      dataProvider: this.dataProvider,
      borrow,
      collateral,
      borrowCurve,
      sampledAt: new Date(this.now()).toISOString(),
    };
  }
}
