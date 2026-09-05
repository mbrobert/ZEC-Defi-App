import type { PublicClient } from "viem";
import { AAVE_V3, AAVE_V3_RESERVES, BASE_TOKENS, BORROW_ASSET, CHAINLINK_FEEDS, COLLATERAL_ASSETS, isCollateralSymbol } from "@zyo/shared";
import type { TokenSymbol } from "@zyo/shared";
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

export function aaveAddressesFromShared(): AaveAddresses {
  return { pool: AAVE_V3.pool, dataProvider: AAVE_V3.poolDataProvider, oracle: AAVE_V3.oracle };
}

/** The reserves the keeper can value, with feed wiring from packages/shared. */
export function reserveSpecsFromShared(): ReserveSpec[] {
  return AAVE_V3_RESERVES.map((symbol) => {
    const token = BASE_TOKENS[symbol];
    let feed: Address | null = null;
    if (isCollateralSymbol(symbol)) {
      const f = COLLATERAL_ASSETS[symbol].feed;
      if (f.kind === "chainlink") feed = f.address;
    } else if (symbol === BORROW_ASSET) {
      feed = CHAINLINK_FEEDS.USDC_USD.address;
    }
    return { symbol, asset: token.address, decimals: token.decimals, feed };
  });
}

export interface ReserveContext {
  spec: ReserveSpec;
  liquidationThresholdBps: bigint;
  aavePrice: bigint;
  chainlink: ChainlinkRead | null;
}

export type ReserveContextResult = { ok: true; ctx: ReserveContext } | { ok: false; reason: string };

export interface ReaderOptions {
  deadlineMs: number;
  /** Called after each completed RPC (feeds the progress watchdog). */
  onProgress?: () => void;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message.split("\n")[0]}`;
  return String(e);
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
          out.set(spec.symbol, { ok: false, reason: errMsg(e) });
        }
      })
    );
    return out;
  }

  private async readReserveContext(spec: ReserveSpec, signal?: AbortSignal): Promise<ReserveContext> {
    const [cfg, aavePrice, chainlink] = await Promise.all([
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
      spec.feed ? this.readChainlink(spec, spec.feed, signal) : Promise.resolve(null),
    ]);
    const [decimals, , liquidationThreshold, , , , , , isActive] = cfg;
    if (Number(decimals) !== spec.decimals) {
      throw new Error(`reserve decimals ${decimals} ≠ expected ${spec.decimals}`);
    }
    if (!isActive) throw new Error("reserve is not active");
    return { spec, liquidationThresholdBps: liquidationThreshold, aavePrice, chainlink };
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
