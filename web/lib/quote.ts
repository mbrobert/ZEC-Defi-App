/**
 * The swap quote an unwind must carry.
 *
 * `ISwapAdapter.swap` no longer takes a bare `minOut`: it takes
 * `(quotedIn, quotedOut, maxSlippageBps)` and enforces
 *
 *     amountIn × quotedOut / quotedIn × (10000 − maxSlippageBps) / 10000
 *
 * on the amount ACTUALLY swapped, capped at 500 bps on chain. "Accept one base
 * unit" cannot be expressed any more — and the web's old
 * `swapMinOut: minOutUsdc > 0n ? minOutUsdc : 1n` fallback, which silently
 * degraded a missing indexer value into "accept anything", is gone with it.
 *
 * So this module FETCHES a real quote before anything is signed:
 *
 *   • the pool's live sqrtPriceX96 is the quote — it is the price the swap
 *     will actually execute near, so the floor is tight and the transaction
 *     does not revert for no reason. A sandwich happens AFTER this read, and
 *     the floor is exactly what bounds it;
 *   • the Aave oracle (Chainlink under the hood) is a cross-check. When the
 *     pool and the oracle disagree by more than MAX_QUOTE_DIVERGENCE the pool
 *     is not a safe thing to quote from — a price somebody has already moved —
 *     so we refuse and say so in plain words instead of signing into it;
 *   • the floor itself is READ from `AerodromeSwapAdapter.minOutFor`, the same
 *     pure code the swap enforces, so the number shown is the number applied.
 *
 * Every failure here is a refusal with a sentence, never a smaller number.
 */
import type { Address } from "viem";
import { AAVE_V3, BASE_TOKENS } from "@zyo/shared";
import { AAVE_ORACLE_ABI, ERC20_ABI } from "./abi/aave";
import { AERODROME_CLPOOL_ABI, SWAP_ADAPTER_ABI } from "./abi/oilskin";
import { encodeRouteData, MAX_SWAP_SLIPPAGE_BPS, type Deployment, type QuotedSwap } from "./plan";
import { safeMulticall, type ReadClient } from "./reads";
import { Q96 } from "./tickmath";

/**
 * How far the pool may sit from the oracle before we refuse to quote from it.
 * 3% — wider than any honest spread on the curated pools, far narrower than a
 * profitable manipulation.
 */
export const MAX_QUOTE_DIVERGENCE = 0.03;

export class QuoteRefused extends Error {
  constructor(public readonly plain: string) {
    super(plain);
    this.name = "QuoteRefused";
  }
}

const USDC = BASE_TOKENS.USDC;

function sameAddress(a: unknown, b: string): boolean {
  return typeof a === "string" && a.toLowerCase() === b.toLowerCase();
}

/**
 * Human price of token1 in units of token0 from sqrtPriceX96 — i.e. how many
 * token1 one token0 buys, decimals-adjusted. Kept in floating point on
 * purpose: it becomes an integer `quotedOut` immediately below, and the CHAIN
 * does the exact arithmetic from that integer.
 */
export function poolPriceToken0InToken1(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const s = Number(sqrtPriceX96) / Number(Q96);
  return s * s * Math.pow(10, decimals0 - decimals1);
}

export interface QuoteInputs {
  read: ReadClient;
  deployment: Deployment;
  poolAddress: Address;
  /** bps; clamped to the product cap, which is itself under the chain's 500. */
  maxSlippageBps: number;
}

/**
 * Quote the non-USDC leg of an LP position into USDC.
 * Throws `QuoteRefused` (with a plain sentence) rather than returning a weak quote.
 */
export async function quoteUnwindSwap(i: QuoteInputs): Promise<QuotedSwap> {
  const slippageBps = Math.min(Math.max(Math.round(i.maxSlippageBps), 1), MAX_SWAP_SLIPPAGE_BPS);
  const [slot0, tickSpacingRaw, token0Raw, token1Raw] = await safeMulticall(i.read, [
    { address: i.poolAddress, abi: AERODROME_CLPOOL_ABI, functionName: "slot0" },
    { address: i.poolAddress, abi: AERODROME_CLPOOL_ABI, functionName: "tickSpacing" },
    { address: i.poolAddress, abi: AERODROME_CLPOOL_ABI, functionName: "token0" },
    { address: i.poolAddress, abi: AERODROME_CLPOOL_ABI, functionName: "token1" },
  ]);
  if (!Array.isArray(slot0) || typeof slot0[0] !== "bigint" || slot0[0] <= 0n) {
    throw new QuoteRefused("The pool's live price could not be read, so there is no honest minimum to protect the swap with. Nothing was signed — try again in a minute.");
  }
  if (tickSpacingRaw === null || token0Raw === null || token1Raw === null) {
    throw new QuoteRefused("The pool's own settings could not be read, so the swap route cannot be built. Nothing was signed — try again in a minute.");
  }
  const sqrtPriceX96 = slot0[0] as bigint;
  const tickSpacing = Number(tickSpacingRaw);
  const token0 = token0Raw as Address;
  const token1 = token1Raw as Address;

  const usdcIsToken0 = sameAddress(token0, USDC.address);
  const usdcIsToken1 = sameAddress(token1, USDC.address);
  if (!usdcIsToken0 && !usdcIsToken1) {
    throw new QuoteRefused("This pool does not hold USDC, so Oilskin cannot close it through the router. Your position is untouched; close it from your account directly.");
  }
  const token = usdcIsToken0 ? token1 : token0;

  const [decRaw, symRaw] = await safeMulticall(i.read, [
    { address: token, abi: ERC20_ABI, functionName: "decimals" },
    { address: token, abi: ERC20_ABI, functionName: "symbol" },
  ]);
  if (decRaw === null) throw new QuoteRefused("The token being sold could not be read, so the swap cannot be quoted. Nothing was signed.");
  const decimals = Number(decRaw);
  const tokenSymbol = typeof symRaw === "string" && symRaw.length > 0 && symRaw.length <= 12 ? symRaw : "the pool token";

  // Price of the non-USDC token in USDC, from the pool itself.
  const p01 = poolPriceToken0InToken1(sqrtPriceX96, usdcIsToken0 ? USDC.decimals : decimals, usdcIsToken0 ? decimals : USDC.decimals);
  const poolPriceUsdc = usdcIsToken0 ? (p01 > 0 ? 1 / p01 : 0) : p01;
  if (!Number.isFinite(poolPriceUsdc) || poolPriceUsdc <= 0) {
    throw new QuoteRefused("The pool's price came back as zero or unreadable, so there is no honest minimum to protect the swap with. Nothing was signed.");
  }

  // Cross-check against the Aave oracle (both prices are USD, 8 decimals).
  const [tokUsd, usdcUsd] = await safeMulticall(i.read, [
    { address: AAVE_V3.oracle as Address, abi: AAVE_ORACLE_ABI, functionName: "getAssetPrice", args: [token] },
    { address: AAVE_V3.oracle as Address, abi: AAVE_ORACLE_ABI, functionName: "getAssetPrice", args: [USDC.address] },
  ]);
  let crossCheckDelta: number | null = null;
  if (typeof tokUsd === "bigint" && typeof usdcUsd === "bigint" && tokUsd > 0n && usdcUsd > 0n) {
    const oraclePriceUsdc = Number(tokUsd) / Number(usdcUsd);
    crossCheckDelta = Math.abs(poolPriceUsdc - oraclePriceUsdc) / oraclePriceUsdc;
    if (crossCheckDelta > MAX_QUOTE_DIVERGENCE) {
      throw new QuoteRefused(
        `The pool is currently pricing ${tokenSymbol} at ${poolPriceUsdc.toPrecision(6)} USDC while the Chainlink feed Aave uses says ${oraclePriceUsdc.toPrecision(6)} — a ${(crossCheckDelta * 100).toFixed(1)}% gap. ` +
          "Selling into a pool that far from the market is how people lose money to a front-runner, so nothing was signed. Wait a few minutes and try again; your position and your loan are unchanged.",
      );
    }
  }

  const quotedIn = 10n ** BigInt(decimals);
  const quotedOut = BigInt(Math.floor(poolPriceUsdc * 10 ** USDC.decimals));
  if (quotedOut <= 0n) {
    throw new QuoteRefused(`One whole ${tokenSymbol} is worth less than 0.000001 USDC at the pool's price, which cannot be quoted safely. Nothing was signed.`);
  }

  // The floor the adapter will enforce — read from the adapter, not recomputed here.
  const [minOutRaw] = await safeMulticall(i.read, [
    { address: i.deployment.swapAdapter, abi: SWAP_ADAPTER_ABI, functionName: "minOutFor", args: [quotedIn, quotedIn, quotedOut, slippageBps] },
  ]);
  if (typeof minOutRaw !== "bigint" || minOutRaw <= 0n) {
    throw new QuoteRefused("The swap contract would not confirm the minimum it will enforce, so nothing was signed. Try again in a minute.");
  }

  return {
    quotedIn,
    quotedOut,
    maxSlippageBps: slippageBps,
    routeData: encodeRouteData(tickSpacing),
    tokenSymbol,
    tokenAddress: token,
    tokenDecimals: decimals,
    tickSpacing,
    source: "pool-spot",
    crossCheckDelta,
    minOutForQuotedIn: minOutRaw,
  };
}
