import type { PublicClient } from "viem";
import { BASE_TOKENS, BORROW_ASSET, CHAINS } from "@zyo/shared";
import type { ChainTable, TokenInfo, TokenSymbol } from "@zyo/shared";
import { aaveOracleAbi, aavePoolAbi, aavePoolDataProviderAbi, chainlinkAggregatorAbi } from "../abi/aave.js";
import type { AccountSnapshot, ChainlinkRead, ReserveRow } from "../engine/valuation.js";
import type { Address } from "../types/evm.js";
import { withDeadline } from "./deadline.js";

/**
 * Read side of the keeper, on viem.
 *
 * Every call has a deadline and honours the tick's AbortSignal. Nothing here
 * decides anything: it produces an `AccountSnapshot` — raw words plus a list
 * of what could not be read — and `engine/valuation.ts` decides whether that
 * snapshot supports a verdict. A failed read is recorded, never defaulted.
 *
 * Per-tick reserve context (LT, decimals, Aave price, Chainlink round) is read
 * once per asset and shared across accounts; per-account reads are
 * `getUserAccountData` plus one `getUserReserveData` per reserve.
 */

export interface ReserveSpec {
  symbol: TokenSymbol;
  asset: Address;
  decimals: number;
  /** Independent Chainlink USD aggregator, or null when none exists on Base. */
  feed: Address | null;
}

export interface AaveAddresses {
  pool: Address;
  dataProvider: Address;
  oracle: Address;
}

/** The Aave addresses of one chain's table (packages/shared `CHAINS`, slice 6). */
export function aaveAddressesFor(chain: ChainTable): AaveAddresses {
  return { pool: chain.aave.pool, dataProvider: chain.aave.poolDataProvider, oracle: chain.aave.oracle };
}

/**
 * The reserves the keeper can value on one chain, with the feed each is priced by: the chain's
 * collateral feeds for cbBTC / WETH (on Base Sepolia cbBTC is Aave's test WBTC priced by BTC/USD),
 * the chain's USDC/USD feed for the borrow asset. `tokens` carries the resolved addresses.
 */
export function reserveSpecsFor(chain: ChainTable, tokens: Readonly<Record<TokenSymbol, TokenInfo>>): ReserveSpec[] {
  return chain.aaveReserves.map((symbol) => {
    const token = tokens[symbol];
    let feed: Address | null = null;
    if (symbol === "cbBTC" || symbol === "WETH") feed = chain.collateralFeeds[symbol].address;
    else if (symbol === BORROW_ASSET) feed = chain.feeds.USDC_USD.address;
    return { symbol, asset: token.address, decimals: token.decimals, feed };
  });
}

/** Base mainnet, as before slice 6 — what the tests and the mock chain are built on. */
export function aaveAddressesFromShared(): AaveAddresses {
  return aaveAddressesFor(CHAINS[8453]);
}

/** Base mainnet reserves, as before slice 6. */
export function reserveSpecsFromShared(): ReserveSpec[] {
  return reserveSpecsFor(CHAINS[8453], BASE_TOKENS);
}

export interface ReserveContext {
  spec: ReserveSpec;
  liquidationThresholdBps: bigint;
  aavePrice: bigint;
  chainlink: ChainlinkRead | null;
}

/**
 * A failed context still carries the independent Chainlink read when THAT leg answered: a venue that
 * is not the Aave pool (the Morpho venue) is priced from this same feed by the venue-aware valuation
 * (engine/venueValuation.ts), and an Aave reserve being frozen or mis-decoded must not blind the
 * keeper to a position held elsewhere. `chainlink` is absent, not null, when the feed itself failed.
 */
export type ReserveContextResult = { ok: true; ctx: ReserveContext } | { ok: false; reason: string; chainlink?: ChainlinkRead | null };

/** One published aggregator round, reduced to what a cadence probe needs. */
export interface RoundRead {
  roundId: bigint;
  updatedAt: bigint;
}

export interface ReaderOptions {
  deadlineMs: number;
  /** Called after each completed RPC (feeds the progress watchdog). */
  onProgress?: () => void;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message.split("\n")[0]}`;
  return String(e);
}

/** A reserve-context failure that may still carry the feed read (see ReserveContextResult). */
class ContextError extends Error {
  constructor(
    message: string,
    readonly chainlink: ChainlinkRead | null | undefined
  ) {
    super(message);
    this.name = "ContextError";
  }
}

export class AaveReader {
  constructor(
    private readonly client: PublicClient,
    private readonly addresses: AaveAddresses,
    private readonly reserves: ReserveSpec[],
    private readonly opts: ReaderOptions
  ) {
    if (reserves.length === 0) throw new RangeError("AaveReader: no reserves");
  }

  get reserveSpecs(): readonly ReserveSpec[] {
    return this.reserves;
  }

  private async call<T>(label: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    const v = await withDeadline(label, this.opts.deadlineMs, signal, work);
    this.opts.onProgress?.();
    return v;
  }

  async blockNumber(signal?: AbortSignal): Promise<bigint> {
    return this.call("eth_blockNumber", signal, () => this.client.getBlockNumber({ cacheTime: 0 }));
  }

  /**
   * Chain head with its timestamp. Everything time-dependent — feed staleness,
   * transaction deadlines — is measured against CHAIN time, not the keeper
   * host's clock: a host 10 minutes slow read every feed as "updated in the
   * future" and made every account UNKNOWN (audit C-LOW-1).
   */
  async head(signal?: AbortSignal): Promise<{ number: bigint; timestamp: bigint }> {
    const b = await this.call("eth_getBlockByNumber(latest)", signal, () => this.client.getBlock({ blockTag: "latest" }));
    return { number: b.number ?? 0n, timestamp: b.timestamp };
  }

  async chainId(signal?: AbortSignal): Promise<number> {
    return this.call("eth_chainId", signal, () => this.client.getChainId());
  }

  /** Per-asset context, read once per tick. Failures are recorded per asset. */
  async readReserveContexts(signal?: AbortSignal): Promise<Map<TokenSymbol, ReserveContextResult>> {
    const out = new Map<TokenSymbol, ReserveContextResult>();
    await Promise.all(
      this.reserves.map(async (spec) => {
        try {
          out.set(spec.symbol, { ok: true, ctx: await this.readReserveContext(spec, signal) });
        } catch (e) {
          if (e instanceof ContextError) out.set(spec.symbol, e.chainlink === undefined ? { ok: false, reason: e.message } : { ok: false, reason: e.message, chainlink: e.chainlink });
          else out.set(spec.symbol, { ok: false, reason: errMsg(e) });
        }
      })
    );
    return out;
  }

  private async readReserveContext(spec: ReserveSpec, signal?: AbortSignal): Promise<ReserveContext> {
    // The Aave legs and the Chainlink leg are settled separately so that a failed Aave leg can still
    // hand the feed read to the caller (see ReserveContextResult).
    const [aaveLegs, feedLeg] = await Promise.all([
      Promise.allSettled([
        this.call(`getReserveConfigurationData(${spec.symbol})`, signal, () =>
          this.client.readContract({
            address: this.addresses.dataProvider,
            abi: aavePoolDataProviderAbi,
            functionName: "getReserveConfigurationData",
            args: [spec.asset],
          })
        ),
        this.call(`getAssetPrice(${spec.symbol})`, signal, () =>
          this.client.readContract({
            address: this.addresses.oracle,
            abi: aaveOracleAbi,
            functionName: "getAssetPrice",
            args: [spec.asset],
          })
        ),
      ]),
      spec.feed ? this.readChainlink(spec, spec.feed, signal).then((r) => ({ ok: true as const, r })).catch((e: unknown) => ({ ok: false as const, e })) : Promise.resolve({ ok: true as const, r: null }),
    ]);
    const chainlink = feedLeg.ok ? feedLeg.r : undefined;
    const failed = aaveLegs.find((l): l is PromiseRejectedResult => l.status === "rejected");
    if (failed) throw new ContextError(errMsg(failed.reason), chainlink);
    if (!feedLeg.ok) throw new ContextError(errMsg(feedLeg.e), undefined);
    const [cfg, aavePrice] = aaveLegs.map((l) => (l as PromiseFulfilledResult<unknown>).value) as [
      readonly [bigint, bigint, bigint, bigint, bigint, boolean, boolean, boolean, boolean, boolean],
      bigint,
    ];
    const [decimals, , liquidationThreshold, , , , , , isActive] = cfg;
    if (Number(decimals) !== spec.decimals) {
      throw new ContextError(`reserve decimals ${decimals} ≠ expected ${spec.decimals}`, chainlink);
    }
    if (!isActive) throw new ContextError("reserve is not active", chainlink);
    return { spec, liquidationThresholdBps: liquidationThreshold, aavePrice, chainlink: chainlink ?? null };
  }

  private async readChainlink(spec: ReserveSpec, feed: Address, signal?: AbortSignal): Promise<ChainlinkRead> {
    const [round, decimals] = await Promise.all([
      this.call(`latestRoundData(${spec.symbol})`, signal, () =>
        this.client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" })
      ),
      this.call(`feed.decimals(${spec.symbol})`, signal, () =>
        this.client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "decimals" })
      ),
    ]);
    const [roundId, answer, , updatedAt, answeredInRound] = round;
    return { roundId, answer, updatedAt, answeredInRound, decimals: Number(decimals) };
  }

  /**
   * Walk a feed's own recent rounds, newest first: `latestRoundData` then
   * `getRoundData(roundId − 1 …)`. This is the only on-chain source of a
   * feed's real cadence, and it is what the per-feed staleness bound is built
   * from (engine/feeds.ts). A proxy that reverts on a historical round (phase
   * boundary, unsupported) simply yields fewer samples — never an error.
   */
  async readRoundHistory(spec: ReserveSpec, feed: Address, rounds: number, signal?: AbortSignal): Promise<RoundRead[]> {
    const out: RoundRead[] = [];
    const latest = await this.call(`latestRoundData(${spec.symbol})`, signal, () =>
      this.client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" })
    );
    out.push({ roundId: latest[0], updatedAt: latest[3] });
    for (let i = 1; i < rounds; i++) {
      const id = out[out.length - 1].roundId - 1n;
      if (id <= 0n) break;
      try {
        const r = await this.call(`getRoundData(${spec.symbol},${id})`, signal, () =>
          this.client.readContract({ address: feed, abi: chainlinkAggregatorAbi, functionName: "getRoundData", args: [id] })
        );
        if (r[3] === 0n) break; // unset round: end of this aggregator phase
        out.push({ roundId: r[0], updatedAt: r[3] });
      } catch {
        break;
      }
    }
    return out;
  }

  /**
   * Snapshot one account. Throws only when the pool-level read fails (nothing
   * to value at all); per-reserve failures land in `unreadableReserves`.
   */
  async readAccount(
    account: Address,
    contexts: Map<TokenSymbol, ReserveContextResult>,
    blockNumber: bigint,
    signal?: AbortSignal
  ): Promise<AccountSnapshot> {
    const data = await this.call(`getUserAccountData(${account})`, signal, () =>
      this.client.readContract({
        address: this.addresses.pool,
        abi: aavePoolAbi,
        functionName: "getUserAccountData",
        args: [account],
      })
    );
    const [totalCollateralBase, totalDebtBase, , currentLiquidationThreshold, , healthFactor] = data;

    const reserves: ReserveRow[] = [];
    const unreadableReserves: AccountSnapshot["unreadableReserves"] = [];

    await Promise.all(
      this.reserves.map(async (spec) => {
        let user;
        try {
          user = await this.call(`getUserReserveData(${spec.symbol},${account})`, signal, () =>
            this.client.readContract({
              address: this.addresses.dataProvider,
              abi: aavePoolDataProviderAbi,
              functionName: "getUserReserveData",
              args: [spec.asset, account],
            })
          );
        } catch (e) {
          unreadableReserves.push({ symbol: spec.symbol, reason: errMsg(e) });
          return;
        }
        const [aTokenBalance, stableDebt, variableDebt, , , , , , usingAsCollateral] = user;
        const ctxRes = contexts.get(spec.symbol);
        const hasExposure = aTokenBalance > 0n || stableDebt > 0n || variableDebt > 0n;
        if (!ctxRes || !ctxRes.ok) {
          if (hasExposure) {
            unreadableReserves.push({ symbol: spec.symbol, reason: ctxRes ? ctxRes.reason : "no reserve context" });
            return;
          }
          // No exposure: the row is inert and needs no prices.
          reserves.push({
            asset: spec.asset,
            symbol: spec.symbol,
            decimals: spec.decimals,
            liquidationThresholdBps: 0n,
            aTokenBalance,
            debt: stableDebt + variableDebt,
            usingAsCollateral,
            aavePrice: 0n,
            chainlink: null,
          });
          return;
        }
        reserves.push({
          asset: spec.asset,
          symbol: spec.symbol,
          decimals: spec.decimals,
          liquidationThresholdBps: ctxRes.ctx.liquidationThresholdBps,
          aTokenBalance,
          debt: stableDebt + variableDebt,
          usingAsCollateral,
          aavePrice: ctxRes.ctx.aavePrice,
          chainlink: ctxRes.ctx.chainlink,
        });
      })
    );

    reserves.sort((a, b) => a.symbol.localeCompare(b.symbol));
    return {
      account,
      totalCollateralBase,
      totalDebtBase,
      currentLiquidationThresholdBps: currentLiquidationThreshold,
      healthFactorWad: healthFactor,
      reserves,
      unreadableReserves,
      blockNumber,
    };
  }
}
