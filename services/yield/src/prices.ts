/**
 * USD pricing for flow valuation — day-granularity closes per token.
 *
 * Design: stables are pinned (documented approximation, ±peg noise is far
 * inside the band width we report); every other token maps to a REFERENCE
 * POOL on Gecko whose per-day USD closes price it. The side (base/quote)
 * is DETECTED at runtime by matching the token address against the pool's
 * token relationship ids — a config typo therefore fails loudly instead of
 * silently pricing the wrong asset.
 *
 * A flow whose token has no registry entry (or whose day is missing from
 * the series) marks the position `unpriced` — excluded from bands and
 * COUNTED in the band's `excluded` figure. No silent guesses.
 */

import { BASE_TOKENS } from "@zyo/shared";
import type { GeckoSource } from "./sources/gecko.js";
import type { Address } from "./types.js";

export interface TokenInfo {
  symbol: string;
  decimals: number;
  /** Fixed USD price (stables) — mutually exclusive with refPool. */
  fixedUsd?: number;
  /** Reference pool whose OHLCV prices this token. */
  refPool?: Address;
}

/**
 * Token registry. USDC/cbBTC/WETH addresses come from @zyo/shared
 * BASE_TOKENS (verified against the engine registry + fork suite).
 * AERO/cbETH/USDT entries were address-verified 2026-08-27 by matching
 * each against its reference pool's token relationships on GeckoTerminal
 * (the runtime side-detection re-checks on every refresh).
 */
export function defaultTokenRegistry(): Map<Address, TokenInfo> {
  const m = new Map<Address, TokenInfo>();
  const add = (addr: string, t: TokenInfo) => m.set(addr.toLowerCase() as Address, t);

  add(BASE_TOKENS.USDC.address, { symbol: "USDC", decimals: BASE_TOKENS.USDC.decimals, fixedUsd: 1 });
  add("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", { symbol: "USDT", decimals: 6, fixedUsd: 1 });
  add(BASE_TOKENS.WETH.address, {
    symbol: "WETH",
    decimals: BASE_TOKENS.WETH.decimals,
    refPool: "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59" as Address, // Aero WETH/USDC 0.05%
  });
  add(BASE_TOKENS.cbBTC.address, {
    symbol: "cbBTC",
    decimals: BASE_TOKENS.cbBTC.decimals,
    refPool: "0x4e962bb3889bf030368f56810a9c96b83cb3e778" as Address, // Aero cbBTC/USDC 0.05%
  });
  add("0x940181a94A35A4569E4529A3CDfB74e38FD98631", {
    symbol: "AERO",
    decimals: 18,
    refPool: "0x82321f3beb69f503380d6b233857d5c43562e2d0" as Address, // Aero AERO/WETH
  });
  add("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", {
    symbol: "cbETH",
    decimals: 18,
    refPool: "0xa9dafa443a02fbc907cb0093276b3e6f4ef02a46" as Address, // Aero cbETH/WETH
  });
  return m;
}

export class PriceBook {
  /** token(lower) → day(YYYY-MM-DD) → USD close. */
  private series = new Map<Address, Map<string, number>>();
  private sides = new Map<Address, "base" | "quote">();

  constructor(
    private readonly gecko: GeckoSource,
    private readonly registry: Map<Address, TokenInfo> = defaultTokenRegistry()
  ) {}

  tokenInfo(token: Address): TokenInfo | undefined {
    return this.registry.get(token.toLowerCase() as Address);
  }

  /** Load `days` of daily closes for every ref-pool token in the registry. */
  async load(days: number): Promise<void> {
    for (const [token, info] of this.registry) {
      if (!info.refPool) continue;
      const side = await this.detectSide(token, info.refPool);
      this.series.set(token, await this.gecko.dailyUsdCloses(info.refPool, side, days));
    }
  }

  private async detectSide(token: Address, refPool: Address): Promise<"base" | "quote"> {
    const cached = this.sides.get(token);
    if (cached) return cached;
    const p = await this.gecko.pool(refPool);
    let side: "base" | "quote";
    if (p.baseTokenAddress === token) side = "base";
    else if (p.quoteTokenAddress === token) side = "quote";
    else
      throw new Error(
        `price registry: token ${token} is on neither side of its reference pool ${refPool}`
      );
    this.sides.set(token, side);
    return side;
  }

  /**
   * USD value of an atomic amount at a unix timestamp (day close), or null
   * when the token/day cannot be priced.
   */
  usdValue(token: Address, atomicAmount: string, unixSeconds: number): number | null {
    const info = this.tokenInfo(token);
    if (!info) return null;
    const units = Number(BigInt(atomicAmount)) / 10 ** info.decimals;
    if (info.fixedUsd !== undefined) return units * info.fixedUsd;
    const day = new Date(unixSeconds * 1000).toISOString().slice(0, 10);
    const bySeries = this.series.get(token.toLowerCase() as Address);
    const px = bySeries?.get(day) ?? this.nearestBefore(bySeries, day);
    return px === undefined ? null : units * px;
  }

  /** Fall back ≤3 days back (weekend gaps in thin series), else undefined. */
  private nearestBefore(
    series: Map<string, number> | undefined,
    day: string
  ): number | undefined {
    if (!series) return undefined;
    const d = new Date(`${day}T00:00:00Z`);
    for (let i = 1; i <= 3; i++) {
      d.setUTCDate(d.getUTCDate() - 1);
      const hit = series.get(d.toISOString().slice(0, 10));
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
}
