import { encodeAbiParameters, type Hex } from "viem";
import type { Address } from "../types/evm.js";

/**
 * Swap quotes for the router's `UnwindParams.swap`.
 *
 * The contracts replaced `swapMinOut` (an absolute amount for a quantity that
 * is unknown before the LP close, which is why the keeper used to pass 0 with
 * an empty `positionIds`) with a RATE:
 *
 *     minOut = amountIn × quotedOut / quotedIn × (10000 − maxSlippageBps) / 10000
 *
 * computed by the adapter on the amount ACTUALLY swapped. So the keeper does
 * not have to know the size in advance — it has to know the PRICE, and be
 * honest about how far below it it will accept.
 *
 * The price here comes from the pool the swap will execute in: the venue's
 * `poolSqrtPriceX96(poolId)`, read in the same dispatch that builds the band.
 * `sqrtPriceX96` is √(token1/token0) × 2^96, so:
 *
 *     token0 → token1:  out = in × sqrtP² / 2^192
 *     token1 → token0:  out = in × 2^192 / sqrtP²
 *
 * Nothing here is typed from a doc: the only inputs are the live pool price,
 * the pool's own token order, the tokens' own `decimals()`, and the keeper's
 * declared slippage tolerance (bounded by the adapter's on-chain cap).
 */

export interface SwapQuote {
  quotedIn: bigint;
  quotedOut: bigint;
  maxSlippageBps: number;
  routeData: Hex;
}

/** The adapter's on-chain ceiling (`AerodromeSwapAdapter.MAX_SLIPPAGE_BPS`). A quote above it reverts. */
export const ADAPTER_MAX_SLIPPAGE_BPS = 500;

const Q192 = 1n << 192n;

export class QuoteError extends Error {
  constructor(msg: string) {
    super(`swap quote: ${msg}`);
    this.name = "QuoteError";
  }
}

/** `abi.encode(int24 tickSpacing)` — the adapter's Slipstream route. */
export function routeDataFor(tickSpacing: number): Hex {
  if (!Number.isInteger(tickSpacing) || tickSpacing === 0) throw new QuoteError(`tickSpacing must be a non-zero integer, got ${tickSpacing}`);
  return encodeAbiParameters([{ type: "int24" }], [tickSpacing]);
}

/** Raw `amountOut` for `amountIn` at the pool's live price, in the pool's token order. */
export function amountOutAtPrice(amountIn: bigint, sqrtPriceX96: bigint, zeroForOne: boolean): bigint {
  if (sqrtPriceX96 <= 0n) throw new QuoteError("pool sqrtPrice is 0 — refusing to quote");
  if (amountIn < 0n) throw new QuoteError("negative amountIn");
  const p = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne ? (amountIn * p) / Q192 : (amountIn * Q192) / p;
}

export interface QuoteInput {
  sqrtPriceX96: bigint;
  token0: Address;
  token1: Address;
  /** The debt asset the router swaps INTO. */
  usdc: Address;
  /** `decimals()` of the pool's non-USDC token, read from the token itself. */
  nonUsdcDecimals: number;
  maxSlippageBps: number;
  tickSpacing: number;
}

/**
 * A quote for one whole unit of the pool's non-USDC token (scaled up until the
 * quoted output is non-zero, so a token worth less than one base unit of USDC
 * still gets a representable rate — `quotedOut == 0` reverts `ZeroQuote()`).
 */
export function quoteForPool(input: QuoteInput): { quote: SwapQuote; nonUsdcToken: Address } {
  const usdc = input.usdc.toLowerCase();
  const t0 = input.token0.toLowerCase();
  const t1 = input.token1.toLowerCase();
  if (t0 !== usdc && t1 !== usdc) throw new QuoteError("pool has no USDC leg — the router cannot settle it");
  if (t0 === t1) throw new QuoteError("degenerate pool: token0 == token1");
  const nonUsdcIsToken0 = t0 !== usdc;
  const nonUsdcToken = (nonUsdcIsToken0 ? input.token0 : input.token1) as Address;
  if (!Number.isInteger(input.nonUsdcDecimals) || input.nonUsdcDecimals < 0 || input.nonUsdcDecimals > 36) {
    throw new QuoteError(`non-USDC token decimals ${input.nonUsdcDecimals} out of range`);
  }
  if (!Number.isInteger(input.maxSlippageBps) || input.maxSlippageBps <= 0 || input.maxSlippageBps > ADAPTER_MAX_SLIPPAGE_BPS) {
    throw new QuoteError(`maxSlippageBps must be in [1, ${ADAPTER_MAX_SLIPPAGE_BPS}], got ${input.maxSlippageBps}`);
  }

  let quotedIn = 10n ** BigInt(input.nonUsdcDecimals);
  let quotedOut = amountOutAtPrice(quotedIn, input.sqrtPriceX96, nonUsdcIsToken0);
  // A cheap token quoted in a 6-decimal output can round to zero: scale the
  // reference size up (never the price) until the rate is representable.
  for (let i = 0; i < 24 && quotedOut === 0n; i++) {
    quotedIn *= 10n;
    quotedOut = amountOutAtPrice(quotedIn, input.sqrtPriceX96, nonUsdcIsToken0);
  }
  if (quotedOut === 0n) throw new QuoteError("pool price quotes 0 USDC out for any representable input — refusing to swap");

  return {
    nonUsdcToken,
    quote: {
      quotedIn,
      quotedOut,
      maxSlippageBps: input.maxSlippageBps,
      routeData: routeDataFor(input.tickSpacing),
    },
  };
}

/**
 * The floor the adapter will enforce for `amountIn` — the same arithmetic as
 * `AerodromeSwapAdapter.minOutFor`, for logging only. Never used as a bound:
 * the bound is on chain.
 */
export function minOutFor(amountIn: bigint, q: SwapQuote): bigint {
  if (q.quotedIn === 0n) return 0n;
  return ((amountIn * q.quotedOut) / q.quotedIn) * BigInt(10_000 - q.maxSlippageBps) / 10_000n;
}

/** A quote that expresses "no swap will happen" (empty ids, or an all-USDC pool). */
export const NO_SWAP: SwapQuote = Object.freeze({ quotedIn: 0n, quotedOut: 0n, maxSlippageBps: 0, routeData: "0x" as Hex });
