/**
 * Concentrated-liquidity arithmetic the web needs for quoting (pure, tested):
 *   • the PriceBand every deposit/close carries (CONTRACT-ABI.md "Price band"),
 *     from the pool's live sqrtPriceX96 ± a tolerance;
 *   • the value split of an in-range position from its ticks alone (the USDC
 *     leg is not swapped on unwind, the other is), for display and sizing.
 *     The unwind's swap FLOOR is no longer computed here: it comes from a
 *     fetched quote and is read back from the adapter — see lib/quote.ts.
 * Q64.96 fixed point as Aerodrome Slipstream / Uniswap v3 use it.
 */

export const Q96 = 2n ** 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

export interface PriceBand {
  minSqrtPriceX96: bigint;
  maxSqrtPriceX96: bigint;
}

/** Integer square root (floor) for bigint. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of negative");
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  // Newton refinement — the float seed can be off for large n.
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) {
      // settle: ensure floor
      while (x * x > n) x -= 1n;
      while ((x + 1n) * (x + 1n) <= n) x += 1n;
      return x;
    }
    x = y;
  }
}

/**
 * Band = sqrtP × sqrt(1 ∓ tol). Tolerance in bps of PRICE (not sqrt price):
 * 100 bps ⇒ the trade reverts if the pool price moved more than 1% either way
 * between quote and execution. Both bounds non-zero, min ≤ max (the venue
 * reverts BandRequired otherwise).
 */
export function bandFromSqrtPrice(sqrtPriceX96: bigint, toleranceBps: number): PriceBand {
  if (sqrtPriceX96 <= 0n) throw new RangeError("sqrtPriceX96 must be positive");
  if (!Number.isInteger(toleranceBps) || toleranceBps < 1 || toleranceBps >= 10_000) throw new RangeError(`toleranceBps ${toleranceBps} outside [1, 9999]`);
  const SCALE = 10n ** 18n;
  const lo = isqrt(((10_000n - BigInt(toleranceBps)) * SCALE * SCALE) / 10_000n); // sqrt(1−tol) × 1e18
  const hi = isqrt(((10_000n + BigInt(toleranceBps)) * SCALE * SCALE) / 10_000n); // sqrt(1+tol) × 1e18
  const min = (sqrtPriceX96 * lo) / SCALE;
  const max = (sqrtPriceX96 * hi) / SCALE + 1n;
  if (min <= 0n) throw new RangeError("band min underflow");
  return { minSqrtPriceX96: min, maxSqrtPriceX96: max };
}

/** Float sqrt(1.0001^tick) — enough precision for value-split estimates. */
export function sqrtRatioAtTick(tick: number): number {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick ${tick} out of range`);
  return Math.pow(1.0001, tick / 2);
}

export function isInRange(tick: number, tickLower: number, tickUpper: number): boolean {
  return tick >= tickLower && tick < tickUpper;
}

/**
 * Share (0–1) of a position's VALUE held in token1, from ticks alone:
 *   amount0 = L(1/√P − 1/√U), amount1 = L(√P − √L), value1 = amount1, value0 = amount0·P.
 * Below the range everything is token0; above, everything is token1.
 */
export function token1ShareOfValue(tick: number, tickLower: number, tickUpper: number): number {
  if (tickLower >= tickUpper) throw new RangeError("tickLower must be < tickUpper");
  if (tick < tickLower) return 0;
  if (tick >= tickUpper) return 1;
  const sP = sqrtRatioAtTick(tick);
  const sL = sqrtRatioAtTick(tickLower);
  const sU = sqrtRatioAtTick(tickUpper);
  const amount1 = sP - sL;
  const amount0 = 1 / sP - 1 / sU;
  const value0 = amount0 * sP * sP;
  const total = value0 + amount1;
  return total > 0 ? amount1 / total : 0;
}

/** Share of value held in USDC given which side USDC is on. */
export function usdcShareOfValue(tick: number, tickLower: number, tickUpper: number, usdcIsToken0: boolean): number {
  const t1 = token1ShareOfValue(tick, tickLower, tickUpper);
  return usdcIsToken0 ? 1 - t1 : t1;
}

/** Human price of token1 per token0 from sqrtPriceX96, adjusting decimals (for display). */
export function priceFromSqrtPriceX96(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  const s = Number(sqrtPriceX96) / Number(Q96);
  return s * s * Math.pow(10, decimals0 - decimals1);
}
