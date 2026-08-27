/**
 * GeckoTerminal public API source (no key; ~30 req/min — callers cache).
 *
 * Used for: live pool snapshots (TVL, 24h volume → gross fee APR) and
 * daily USD OHLCV for flow pricing. Endpoint shapes verified live
 * 2026-08-27 against Base pools (see docs/YIELD-SERVICE.md verification
 * log). Every figure this source produces carries its sample timestamp.
 */

import type { Address, PoolLiveSample } from "../types.js";

const BASE = "https://api.geckoterminal.com/api/v2/networks/base";

export interface GeckoPoolInfo {
  address: Address;
  tvlUsd: number;
  volume24hUsd: number;
  baseTokenAddress: Address;
  quoteTokenAddress: Address;
  baseTokenPriceUsd: number;
  quoteTokenPriceUsd: number;
}

export class GeckoSource {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  private async get<T>(path: string): Promise<T> {
    let backoff = 1200;
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.fetchImpl(`${BASE}${path}`, {
        headers: { accept: "application/json", "user-agent": "oilskin-yield/0.1" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, backoff));
        backoff *= 2;
        continue;
      }
      if (!res.ok) throw new Error(`geckoterminal http ${res.status} on ${path}`);
      return (await res.json()) as T;
    }
    throw new Error(`geckoterminal: rate-limited after retries on ${path}`);
  }

  async pool(address: Address): Promise<GeckoPoolInfo> {
    const j = await this.get<{
      data: {
        attributes: {
          reserve_in_usd: string;
          volume_usd: { h24: string };
          base_token_price_usd: string;
          quote_token_price_usd: string;
        };
        relationships: {
          base_token: { data: { id: string } };
          quote_token: { data: { id: string } };
        };
      };
    }>(`/pools/${address}`);
    const a = j.data.attributes;
    const tokenAddr = (id: string) => id.replace(/^base_/, "").toLowerCase() as Address;
    return {
      address: address.toLowerCase() as Address,
      tvlUsd: Number(a.reserve_in_usd),
      volume24hUsd: Number(a.volume_usd.h24),
      baseTokenAddress: tokenAddr(j.data.relationships.base_token.data.id),
      quoteTokenAddress: tokenAddr(j.data.relationships.quote_token.data.id),
      baseTokenPriceUsd: Number(a.base_token_price_usd),
      quoteTokenPriceUsd: Number(a.quote_token_price_usd),
    };
  }

  async liveSample(
    curatedId: string,
    address: Address,
    feeTierBps: number
  ): Promise<PoolLiveSample> {
    const p = await this.pool(address);
    const grossFeeAprPct =
      p.tvlUsd > 0 ? ((p.volume24hUsd * (feeTierBps / 10_000)) / p.tvlUsd) * 365 * 100 : 0;
    return {
      poolId: curatedId,
      poolAddress: p.address,
      tvlUsd: p.tvlUsd,
      volume24hUsd: p.volume24hUsd,
      feeTierBps,
      grossFeeAprPct,
      sampledAt: new Date().toISOString(),
      source: "geckoterminal",
    };
  }

  /**
   * Daily close USD prices for one side of a pool, keyed by UTC day
   * (YYYY-MM-DD). `side` selects which token's series to return.
   */
  async dailyUsdCloses(
    pool: Address,
    side: "base" | "quote",
    days: number
  ): Promise<Map<string, number>> {
    const j = await this.get<{
      data: { attributes: { ohlcv_list: [number, number, number, number, number, number][] } };
    }>(`/pools/${pool}/ohlcv/day?aggregate=1&limit=${Math.min(days, 1000)}&token=${side}`);
    const out = new Map<string, number>();
    for (const [ts, , , , close] of j.data.attributes.ohlcv_list) {
      out.set(new Date(ts * 1000).toISOString().slice(0, 10), close);
    }
    return out;
  }
}
