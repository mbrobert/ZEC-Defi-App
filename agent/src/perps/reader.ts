/**
 * Read side of the perps keeper — the third chain's twin of `services/chain.ts` (Base) and
 * `solana/reader.ts` (BUILD-PLAN Stream D step D4; `docs/PERPS-DESIGN-2026-09-25.md` §5).
 *
 * Every number the health of a short rests on comes from HyperCore's read precompiles, reached by a plain
 * `eth_call` on HyperEVM (chain 999) — the same reads `HyperliquidPerpVenue._live` makes inside `protect`,
 * so the keeper values what the venue will judge. Every read of one snapshot is pinned to ONE block, so the
 * mark, the position and the account summary are the same instant's. A precompile that does not answer, or
 * answers a shape `packages/shared` does not decode, is recorded as a failure — never defaulted — and the
 * valuation turns it into UNKNOWN by name (design §8 risk 6).
 *
 * The independent price is the venue's own API (`metaAndAssetCtxs`), read as the mark of the same perp:
 * a check that the precompile is honest, not that the venue is right — there is no other ZEC perp to check
 * against (design §5, RISKS §23). Pluggable; declared-absent on testnet, never silent.
 *
 * A forked HyperEVM cannot execute the precompiles (facts §7; the cbZEC B20 lesson), so this reader is tested
 * against scripted doubles at the precompile addresses and proven on testnet (D3).
 */
import type { PublicClient } from "viem";
import {
  CORE_PERP_DEX,
  HYPERCORE_PRECOMPILES,
  PrecompileDecodeError,
  decodeAccountMarginSummary,
  decodePerpAssetInfo,
  decodePosition,
  decodePx,
  decodeSpotBalance,
  decodeWithdrawable,
  encodePrecompileInput,
  maintenanceMarginRateBps,
  parseDecimalToUnits,
  perpPxDecimals,
  type AccountMarginSummary,
  type PerpAssetInfo,
  type PerpPosition,
  type SpotBalance,
} from "@zyo/shared";
import { PERP_GRANT_SELECTORS, hyperliquidPerpVenueAbi, oilskinAccountAbi } from "../abi/oilskin.js";
import type { Address, Hex } from "../types/evm.js";
import { withDeadline } from "../services/deadline.js";

/** The venue's deploy-time immutables, read once at startup and cross-checked against the shared facts. */
export interface PerpsVenueParams {
  venue: Address;
  perpAsset: number;
  szDecimals: number;
  maxLeverage: number;
  /** Tier-0 maintenance margin rate, bps — `maintenanceMarginRateBps(maxLeverage)` (ZEC: 500). */
  mmrBps: number;
  usdcTokenIndex: number;
  usdcWeiDecimals: number;
  usdcEvmDecimals: number;
  /** The venue's own mark-versus-oracle bound: beyond it `protect` reverts `MarkOracleDeviation`. */
  maxMarkOracleDeviationBps: number;
  /** The entry floor as an up-move (the venue's `minEntryDistanceBps()`); the floor's ladder derives from it. */
  minEntryDistanceBps: number;
  maxNotionalE6: bigint;
  defaultReserveMultipleBps: number;
}

/** `entryOf(account)` — the owner's last intent (D9); null when `at` is zero. */
export interface PerpsEntry {
  distanceBps: number;
  hfBps: number;
  sz: bigint;
  reserveE6: bigint;
  at: number;
}

export interface PerpsIndependentMark {
  /** In 10^(6 − szDecimals), the precompile's own unit. */
  markRaw: bigint;
  atS: number;
  source: string;
}

export interface PerpsIndependentPriceSource {
  name: string;
  mark(pxDecimals: number, signal?: AbortSignal): Promise<PerpsIndependentMark>;
}

/**
 * The venue's own API as the independent mark: `{"type":"metaAndAssetCtxs"}` answers `[meta, ctxs]` with
 * `ctxs[i].markPx` a decimal string for `meta.universe[i]` (facts §2, §7). The coin at the index is checked
 * by name so a re-ordered universe cannot hand the keeper another market's price.
 */
export function infoApiPriceSource(url: string, perpIndex: number, coin: string, fetchImpl: typeof fetch = fetch, now: () => number = () => Date.now()): PerpsIndependentPriceSource {
  return {
    name: "hyperliquid-info-api",
    async mark(pxDecimals, signal) {
      const res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }), signal });
      if (!res.ok) throw new Error(`info API HTTP ${res.status}`);
      const j = (await res.json()) as unknown;
      if (!Array.isArray(j) || j.length < 2) throw new Error("metaAndAssetCtxs: not a [meta, ctxs] pair");
      const meta = j[0] as { universe?: { name?: string }[] };
      const ctxs = j[1] as { markPx?: string }[];
      const name = meta?.universe?.[perpIndex]?.name;
      if (name !== coin) throw new Error(`metaAndAssetCtxs: universe[${perpIndex}] is ${String(name)}, not ${coin}`);
      const markPx = ctxs?.[perpIndex]?.markPx;
      if (typeof markPx !== "string") throw new Error(`metaAndAssetCtxs: no markPx at index ${perpIndex}`);
      return { markRaw: parseDecimalToUnits(truncateDecimals(markPx, pxDecimals), pxDecimals), atS: Math.floor(now() / 1000), source: "hyperliquid-info-api" };
    },
  };
}

/** Drop decimal places past `decimals` (the API may print a fifth significant figure the precompile's unit cannot carry). */
export function truncateDecimals(value: string, decimals: number): string {
  const m = /^(-?\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new RangeError(`not a decimal string: ${value}`);
  const frac = (m[2] ?? "").slice(0, decimals);
  return frac.length ? `${m[1]}.${frac}` : m[1]!;
}

export interface PerpsReadFailure {
  what: string;
  reason: string;
}

/** Everything one valuation rests on, read at one block. A missing leg is a failure named in `readFailures`. */
export interface PerpsSnapshot {
  blockNumber: bigint;
  /** Chain time at that block. */
  nowS: bigint;
  params: PerpsVenueParams;
  position: PerpPosition | null;
  spot: SpotBalance | null;
  withdrawableE6: bigint | null;
  markRaw: bigint | null;
  oracleRaw: bigint | null;
  assetInfo: PerpAssetInfo | null;
  summary: AccountMarginSummary | null;
  entry: PerpsEntry | null;
  /** Null when no source is configured (declared absent) or the source failed (named in `readFailures`). */
  independent: PerpsIndependentMark | null;
  readFailures: PerpsReadFailure[];
}

/** The two grants `protect` is judged under: the account's `Permission` on (venue, protect) and the venue's `PerpGrant`. */
export interface PerpsGrantReads {
  permission: { active: boolean; maxValuePerPeriod: bigint; valueSpent: bigint; period: number; expiry: number; periodStart: number; allowCallback: boolean };
  accountEpoch: bigint;
  grant: {
    keeper: Address;
    expiry: number;
    period: number;
    periodStart: number;
    allowedRungs: number;
    topUpUsdcPerPeriod: bigint;
    reduceSzPerPeriod: bigint;
    maxSlippageBps: number;
    topUpSpent: bigint;
    reduceSpent: bigint;
    epoch: bigint;
  };
}

export interface PerpsReaderOptions {
  deadlineMs: number;
  onProgress?: () => void;
  independent: PerpsIndependentPriceSource | null;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
}

export class PerpsReader {
  private params: PerpsVenueParams | null = null;

  constructor(
    readonly client: PublicClient,
    readonly venue: Address,
    private readonly opts: PerpsReaderOptions
  ) {}

  private dl<T>(label: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return withDeadline(label, this.opts.deadlineMs, signal, fn).then((v) => {
      this.opts.onProgress?.();
      return v;
    });
  }

  async chainId(signal?: AbortSignal): Promise<number> {
    return this.dl("eth_chainId", () => this.client.getChainId(), signal);
  }

  /** Chain head with its timestamp: everything time-dependent is measured against CHAIN time (audit C-LOW-1). */
  async head(signal?: AbortSignal): Promise<{ number: bigint; timestamp: bigint }> {
    const b = await this.dl("eth_getBlockByNumber(latest)", () => this.client.getBlock({ blockTag: "latest" }), signal);
    return { number: b.number ?? 0n, timestamp: b.timestamp };
  }

  /** The venue's immutables, read once and cached (a redeploy is a restart). */
  async venueParams(signal?: AbortSignal): Promise<PerpsVenueParams> {
    if (this.params) return this.params;
    const read = <N extends (typeof hyperliquidPerpVenueAbi)[number]["name"]>(functionName: N) =>
      this.dl(`${functionName}()`, () => this.client.readContract({ address: this.venue, abi: hyperliquidPerpVenueAbi, functionName } as never) as Promise<unknown>, signal);
    const [perpAsset, szDecimals, maxLeverage, usdcTokenIndex, usdcWeiDecimals, usdcEvmDecimals, maxDev, minEntry, maxNotional, defaultMultiple] = await Promise.all([
      read("PERP_ASSET"),
      read("SZ_DECIMALS"),
      read("MAX_LEVERAGE"),
      read("USDC_TOKEN_INDEX"),
      read("USDC_WEI_DECIMALS"),
      read("USDC_EVM_DECIMALS"),
      read("MAX_MARK_ORACLE_DEVIATION_BPS"),
      read("minEntryDistanceBps"),
      read("MAX_NOTIONAL_E6"),
      read("DEFAULT_RESERVE_MULTIPLE_BPS"),
    ]);
    const p: PerpsVenueParams = {
      venue: this.venue,
      perpAsset: Number(perpAsset),
      szDecimals: Number(szDecimals),
      maxLeverage: Number(maxLeverage),
      mmrBps: maintenanceMarginRateBps(Number(maxLeverage)),
      usdcTokenIndex: Number(usdcTokenIndex),
      usdcWeiDecimals: Number(usdcWeiDecimals),
      usdcEvmDecimals: Number(usdcEvmDecimals),
      maxMarkOracleDeviationBps: Number(maxDev),
      minEntryDistanceBps: Number(minEntry),
      maxNotionalE6: maxNotional as bigint,
      defaultReserveMultipleBps: Number(defaultMultiple),
    };
    this.params = p;
    return p;
  }

  /** One raw precompile read at `blockNumber`, decoded by shared; any failure becomes a named entry. */
  private async precompile<T>(what: string, to: Address, data: Hex, decode: (hex: string) => T, blockNumber: bigint, failures: PerpsReadFailure[], signal?: AbortSignal): Promise<T | null> {
    try {
      const r = await this.dl(what, () => this.client.call({ to, data, blockNumber }), signal);
      if (!r.data) throw new PrecompileDecodeError(what, "empty answer");
      return decode(r.data);
    } catch (e) {
      failures.push({ what, reason: errMsg(e) });
      return null;
    }
  }

  /**
   * Everything one valuation needs, at ONE block: the seven precompile reads `protect` makes, the entry
   * record, and the independent mark. Nothing here decides anything.
   */
  async snapshot(account: Address, at: { number: bigint; timestamp: bigint }, signal?: AbortSignal): Promise<PerpsSnapshot> {
    const params = await this.venueParams(signal);
    const failures: PerpsReadFailure[] = [];
    const bn = at.number;
    const [position, spot, withdrawableE6, markRaw, oracleRaw, assetInfo, summary, entry] = await Promise.all([
      this.precompile("position(0x800)", HYPERCORE_PRECOMPILES.position, encodePrecompileInput.position(account, params.perpAsset), decodePosition, bn, failures, signal),
      this.precompile("spotBalance(0x801)", HYPERCORE_PRECOMPILES.spotBalance, encodePrecompileInput.spotBalance(account, params.usdcTokenIndex), decodeSpotBalance, bn, failures, signal),
      this.precompile("withdrawable(0x803)", HYPERCORE_PRECOMPILES.withdrawable, encodePrecompileInput.withdrawable(account), decodeWithdrawable, bn, failures, signal),
      this.precompile("markPx(0x806)", HYPERCORE_PRECOMPILES.markPx, encodePrecompileInput.px(params.perpAsset), decodePx, bn, failures, signal),
      this.precompile("oraclePx(0x807)", HYPERCORE_PRECOMPILES.oraclePx, encodePrecompileInput.px(params.perpAsset), decodePx, bn, failures, signal),
      this.precompile("perpAssetInfo(0x80a)", HYPERCORE_PRECOMPILES.perpAssetInfo, encodePrecompileInput.perpAssetInfo(params.perpAsset), decodePerpAssetInfo, bn, failures, signal),
      this.precompile("accountMarginSummary(0x80f)", HYPERCORE_PRECOMPILES.accountMarginSummary, encodePrecompileInput.accountMarginSummary(CORE_PERP_DEX, account), decodeAccountMarginSummary, bn, failures, signal),
      this.readEntry(account, bn, failures, signal),
    ]);

    let independent: PerpsIndependentMark | null = null;
    if (this.opts.independent) {
      try {
        independent = await this.dl(`independent mark (${this.opts.independent.name})`, () => this.opts.independent!.mark(perpPxDecimals(params.szDecimals), signal), signal);
      } catch (e) {
        failures.push({ what: `independent mark (${this.opts.independent.name})`, reason: errMsg(e) });
        independent = null; // P3 names it
      }
    }
    return { blockNumber: bn, nowS: at.timestamp, params, position, spot, withdrawableE6, markRaw, oracleRaw, assetInfo, summary, entry, independent, readFailures: failures };
  }

  private async readEntry(account: Address, blockNumber: bigint, failures: PerpsReadFailure[], signal?: AbortSignal): Promise<PerpsEntry | null> {
    try {
      const e = await this.dl(`entryOf(${account})`, () => this.client.readContract({ address: this.venue, abi: hyperliquidPerpVenueAbi, functionName: "entryOf", args: [account], blockNumber }), signal);
      const [distanceBps, hfBps, sz, reserveE6, at] = e;
      if (Number(at) === 0) return null;
      return { distanceBps: Number(distanceBps), hfBps: Number(hfBps), sz, reserveE6, at: Number(at) };
    } catch (e) {
      failures.push({ what: "entryOf", reason: errMsg(e) });
      return null;
    }
  }

  /** The two grants as `execAsKeeper` → `protect` will judge them, read at one block. Throws: a grant that cannot be read is not a grant. */
  async grants(account: Address, keeper: Address, blockNumber: bigint, signal?: AbortSignal): Promise<PerpsGrantReads> {
    const selector = PERP_GRANT_SELECTORS["HyperliquidPerpVenue.protect"];
    const [perm, epoch, g] = await Promise.all([
      this.dl("grantOf(keeper, venue, protect)", () => this.client.readContract({ address: account, abi: oilskinAccountAbi, functionName: "grantOf", args: [keeper, this.venue, selector], blockNumber }), signal),
      this.dl("grantEpoch()", () => this.client.readContract({ address: account, abi: oilskinAccountAbi, functionName: "grantEpoch", blockNumber }), signal),
      this.dl("perpGrantOf(account)", () => this.client.readContract({ address: this.venue, abi: hyperliquidPerpVenueAbi, functionName: "perpGrantOf", args: [account], blockNumber }), signal),
    ]);
    const [active, maxValuePerPeriod, valueSpent, period, expiry, periodStart, allowCallback] = perm;
    return {
      permission: { active, maxValuePerPeriod, valueSpent, period: Number(period), expiry: Number(expiry), periodStart: Number(periodStart), allowCallback },
      accountEpoch: epoch,
      grant: {
        keeper: g.keeper.toLowerCase() as Address,
        expiry: Number(g.expiry),
        period: Number(g.period),
        periodStart: Number(g.periodStart),
        allowedRungs: Number(g.allowedRungs),
        topUpUsdcPerPeriod: g.topUpUsdcPerPeriod,
        reduceSzPerPeriod: g.reduceSzPerPeriod,
        maxSlippageBps: Number(g.maxSlippageBps),
        topUpSpent: g.topUpSpent,
        reduceSpent: g.reduceSpent,
        epoch: g.epoch,
      },
    };
  }
}
