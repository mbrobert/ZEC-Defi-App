import { encodeFunctionData, type Hex } from "viem";
import { lpVenueAbi, strategyRouterAbi } from "../abi/oilskin.js";
import type { Address } from "../types/evm.js";
import { MAX_UINT256 } from "../types/evm.js";

/**
 * Keeper action policy — pure planning from chain-read inputs to the exact
 * `Call[]` handed to `execAsKeeper`. No I/O here; every number in a plan is
 * read from chain (ids, pool prices, balances) or is a keeper policy fraction.
 *
 * What each rung does (the only three things the keeper can do on-chain):
 *   repay            — close ⅓ of the account's LP ids (rounded up), then
 *                      repay every USDC the account holds, up to its debt;
 *   derisk           — close ⅔, then repay;
 *   emergency-unwind — close all, then repay.
 * Collateral is NEVER withdrawn by the keeper (withdrawAmount = 0): it cannot
 * improve the health factor and it moves the user's principal. The non-USDC
 * leg of a closed position stays in the account (owned by the user); the
 * router's in-tx swap is not used because its `swapMinOut` is an absolute
 * amount for a quantity unknown before the close — a floor the keeper cannot
 * set honestly (see done-KEEPER.md, ABI seam risk).
 *
 * Root calls (each must match an active grant for the keeper):
 *   • SnuggleLpVenue.closeMany(ids, band)   — one per pool the ids live in
 *   • StrategyRouter.unwind({ positionIds: [], repayAmount: MAX, … })
 * The price band is the pool's live sqrtPriceX96 ± bandToleranceBps of PRICE
 * (so ± tolerance/2 on the sqrt), both bounds non-zero, failing closed when
 * the price cannot be read.
 */

/** Fraction of the account's LP ids closed per action, as an exact rational [num, den]. */
export const CLOSE_FRACTION: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  repay: [1, 3],
  derisk: [2, 3],
  "emergency-unwind": [1, 1],
});

export interface PlanInput {
  account: Address;
  action: string;
  collateralAsset: Address;
  router: Address;
  lpVenue: Address;
  /** Every LP id the account owns, with the pool it lives in. */
  positions: { id: bigint; poolId: Hex }[];
  /** Live sqrtPriceX96 per poolId (0 / missing = unreadable). */
  poolSqrtPrice: Map<Hex, bigint>;
  /** Idle USDC in the account. */
  idleUsdc: bigint;
  bandToleranceBps: number;
  /** Unix seconds. */
  nowS: bigint;
  txDeadlineS: number;
}

export interface KeeperCall {
  target: Address;
  value: bigint;
  data: Hex;
}

export interface GrantNeeded {
  target: Address;
  selector: Hex;
}

export type Plan =
  | { kind: "CALLS"; calls: KeeperCall[]; closeIds: bigint[]; grantsNeeded: GrantNeeded[] }
  | { kind: "NOTHING"; reason: string }
  | { kind: "REFUSE"; reason: string };

const BPS = 10_000n;

/** Integer sqrt (floor). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Band on sqrtPrice for a ± `tolBps` band on PRICE: sqrtP × sqrt(1 ∓ tol). */
export function bandFor(sqrtPriceX96: bigint, tolBps: number): { minSqrtPriceX96: bigint; maxSqrtPriceX96: bigint } {
  if (sqrtPriceX96 <= 0n) throw new RangeError("sqrtPrice must be > 0");
  if (!(tolBps > 0) || tolBps >= 10_000) throw new RangeError("tolBps must be in (0, 10000)");
  const t = BigInt(tolBps);
  // sqrt((BPS ∓ t)/BPS) scaled by 1e9 for precision.
  const scale = 1_000_000_000n;
  const lo = isqrt((BPS - t) * scale * scale / BPS);
  const hi = isqrt((BPS + t) * scale * scale / BPS) + 1n; // round the upper bound up
  const min = (sqrtPriceX96 * lo) / scale;
  const max = (sqrtPriceX96 * hi) / scale;
  if (min <= 0n || max <= min) throw new RangeError("degenerate band");
  const U160 = (1n << 160n) - 1n;
  if (max > U160) throw new RangeError("band exceeds uint160");
  return { minSqrtPriceX96: min, maxSqrtPriceX96: max };
}

/** ceil(n × num/den) in integer arithmetic — no 3334-bps rounding artefacts. */
export function closeCount(n: number, action: string): number {
  const frac = CLOSE_FRACTION[action];
  if (frac === undefined) throw new RangeError(`no close policy for action ${action}`);
  if (!Number.isInteger(n) || n <= 0) return 0;
  const [num, den] = frac;
  return Math.min(n, Math.floor((n * num + den - 1) / den));
}

export function planAction(input: PlanInput): Plan {
  if (!(input.action in CLOSE_FRACTION)) return { kind: "REFUSE", reason: `unknown keeper action ${input.action}` };
  const n = input.positions.length;
  const k = closeCount(n, input.action);
  const toClose = input.positions.slice(0, k);

  if (toClose.length === 0 && input.idleUsdc === 0n) {
    return {
      kind: "NOTHING",
      reason: "no LP positions to close and no idle USDC to repay — only the owner can add collateral or repay",
    };
  }

  const calls: KeeperCall[] = [];
  const grantsNeeded: GrantNeeded[] = [];
  const closeIds: bigint[] = [];

  // Group by pool, preserving enumeration order.
  const byPool = new Map<Hex, bigint[]>();
  for (const p of toClose) {
    const arr = byPool.get(p.poolId) ?? [];
    arr.push(p.id);
    byPool.set(p.poolId, arr);
  }
  // One band per pool; the unwind call below needs some band value — reuse the first.
  let firstBand: { minSqrtPriceX96: bigint; maxSqrtPriceX96: bigint } | null = null;
  for (const [poolId, ids] of byPool) {
    const price = input.poolSqrtPrice.get(poolId);
    if (price === undefined || price <= 0n) {
      return { kind: "REFUSE", reason: `pool ${poolId} sqrtPrice unreadable or zero — refusing to close without a price band` };
    }
    let band;
    try {
      band = bandFor(price, input.bandToleranceBps);
    } catch (e) {
      return { kind: "REFUSE", reason: `cannot build price band for ${poolId}: ${(e as Error).message}` };
    }
    firstBand ??= band;
    calls.push({
      target: input.lpVenue,
      value: 0n,
      data: encodeFunctionData({ abi: lpVenueAbi, functionName: "closeMany", args: [ids, band] }),
    });
    closeIds.push(...ids);
  }
  if (calls.length) grantsNeeded.push({ target: input.lpVenue, selector: calls[0].data.slice(0, 10) as Hex });

  const deadline = input.nowS + BigInt(input.txDeadlineS);
  const unwind = encodeFunctionData({
    abi: strategyRouterAbi,
    functionName: "unwind",
    args: [
      {
        collateralAsset: input.collateralAsset,
        positionIds: [],
        band: firstBand ?? { minSqrtPriceX96: 1n, maxSqrtPriceX96: 2n }, // unused when positionIds is empty
        swapMinOut: 0n, // no swap happens: positionIds is empty
        swapRouteData: "0x",
        repayAmount: MAX_UINT256, // min(debt, USDC held) inside the router
        withdrawAmount: 0n, // the keeper never moves collateral
        deadline,
      },
    ],
  });
  calls.push({ target: input.router, value: 0n, data: unwind });
  grantsNeeded.push({ target: input.router, selector: unwind.slice(0, 10) as Hex });

  return { kind: "CALLS", calls, closeIds, grantsNeeded };
}
