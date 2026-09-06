import { encodeFunctionData, type Hex } from "viem";
import { strategyRouterAbi } from "../abi/oilskin.js";
import type { Address } from "../types/evm.js";
import { MAX_UINT256 } from "../types/evm.js";
import { NO_SWAP, type SwapQuote } from "./quote.js";

/**
 * Keeper action policy — pure planning from chain-read inputs to the exact
 * `Call[]` handed to `execAsKeeper`. No I/O here; every number in a plan is
 * read from chain (ids, per-id proceeds, pool prices, balances, the account's
 * own debt) or is a keeper policy fraction.
 *
 * ONE ROOT CALL PER POOL, AND NOTHING ELSE (fix round 1, D5 / audit C-HIGH-1).
 * The plan used to open with a root `SnuggleLpVenue.closeMany`, which the
 * user's single signed `Permission` (target = StrategyRouter, selector =
 * unwind) does not cover, so the dispatcher refused every protective rung and
 * an LP account rode from healthy to HF 0.97 with nothing broadcast.
 * `StrategyRouter.unwind` closes the ids itself through the nested path, so
 * every call the keeper makes is now the one call the user signed for.
 *
 * What each rung does (the only three things the keeper can do on-chain):
 *   repay            — close enough LP VALUE to lift HF to the rung's disarm,
 *                      capped at ⅓ of the account's LP value, then repay every
 *                      USDC the account holds, up to its debt;
 *   derisk           — the same, capped at ⅔;
 *   emergency-unwind — close everything, then repay.
 * Collateral is NEVER withdrawn by the keeper (withdrawAmount = 0): it cannot
 * improve the health factor and it moves the user's principal.
 *
 * SIZED BY VALUE, NOT BY ID COUNT (audit C-MED-2). `positions[i].valueUsdc` is
 * the USDC the router would actually hand back for that id, taken from a real
 * `eth_call` simulation of the same unwind — so "close ⅓" means ⅓ of the
 * position's value, not ⅓ of an arbitrary enumeration order in which the first
 * ids can be dust. A rung that fires, reports success and repays $20 against a
 * $47,700 debt is not a protection.
 *
 * The band is the pool's live sqrtPriceX96 ± bandToleranceBps of PRICE (so
 * ± tolerance/2 on the sqrt), both bounds non-zero, failing closed when the
 * price cannot be read. The swap quote is built from the same live pool price
 * (see quote.ts); `swapMinOut: 1` is not expressible any more and no absolute
 * floor is guessed.
 */

/** Fraction of the account's LP VALUE closed per action, as an exact rational [num, den]. */
export const CLOSE_FRACTION: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  repay: [1, 3],
  derisk: [2, 3],
  "emergency-unwind": [1, 1],
});

export interface PlannedPosition {
  id: bigint;
  poolId: Hex;
  /**
   * USDC the router would return for this id, from a simulated single-id
   * unwind. `null` when it could not be probed (probe budget spent, or the
   * simulation reverted) — those ids sort last and are only used to make up a
   * shortfall.
   */
  valueUsdc: bigint | null;
}

export interface PoolInfo {
  /** Live pool price; 0 / missing = unreadable ⇒ the plan fails closed. */
  sqrtPriceX96: bigint;
  /** Quote for the pool's non-USDC leg, or NO_SWAP when the pool is USDC-only. */
  swap: SwapQuote;
  /** True when the pool has a non-USDC leg that will need swapping. */
  needsSwap: boolean;
}

export interface PlanInput {
  account: Address;
  action: string;
  collateralAsset: Address;
  router: Address;
  /** Every LP id the account owns, with the pool it lives in and its probed value. */
  positions: PlannedPosition[];
  /** Per-poolId price + swap quote, read this dispatch. */
  pools: Map<Hex, PoolInfo>;
  /** Idle USDC in the account (repaid by the same call, before anything is closed). */
  idleUsdc: bigint;
  /**
   * USDC that must reach the debt to lift HF to the rung's disarm, from the
   * live valuation. `null` when it cannot be derived — the fraction alone then
   * sizes the action.
   */
  usdcNeeded: bigint | null;
  bandToleranceBps: number;
  /** Unix seconds, read from the chain head (never the host clock). */
  nowS: bigint;
  txDeadlineS: number;
  /**
   * False = close only, repay nothing. Used by the VALUE PROBE, which
   * simulates a single-id close to learn what that id is worth; a probe must
   * not carry a repay leg it does not intend to measure. Defaults to true.
   */
  repay?: boolean;
}

export interface KeeperCall {
  target: Address;
  value: bigint;
  data: Hex;
  /**
   * Peripheral opt-in on the `Call` tuple. The account IGNORES this on the
   * keeper path and reads `Permission.allowCallback` from the grant instead,
   * so the keeper always sends false and the dispatcher checks the grant.
   */
  callback: boolean;
}

export interface GrantNeeded {
  target: Address;
  selector: Hex;
}

export type Plan =
  | {
      kind: "CALLS";
      calls: KeeperCall[];
      closeIds: bigint[];
      grantsNeeded: GrantNeeded[];
      /** What the plan expects the closes to return, for the log and the escalation. */
      expectedProceedsUsdc: bigint | null;
      sizing: "value" | "count";
    }
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
  const lo = isqrt(((BPS - t) * scale * scale) / BPS);
  const hi = isqrt(((BPS + t) * scale * scale) / BPS) + 1n; // round the upper bound up
  const min = (sqrtPriceX96 * lo) / scale;
  const max = (sqrtPriceX96 * hi) / scale;
  if (min <= 0n || max <= min) throw new RangeError("degenerate band");
  const U160 = (1n << 160n) - 1n;
  if (max > U160) throw new RangeError("band exceeds uint160");
  return { minSqrtPriceX96: min, maxSqrtPriceX96: max };
}

/** ceil(n × num/den) in integer arithmetic — the COUNT fallback when no id could be valued. */
export function closeCount(n: number, action: string): number {
  const frac = CLOSE_FRACTION[action];
  if (frac === undefined) throw new RangeError(`no close policy for action ${action}`);
  if (!Number.isInteger(n) || n <= 0) return 0;
  const [num, den] = frac;
  return Math.min(n, Math.floor((n * num + den - 1) / den));
}

/** ceil(v × num/den) for a bigint value. */
function fractionOf(v: bigint, [num, den]: readonly [number, number]): bigint {
  const n = BigInt(num);
  const d = BigInt(den);
  return (v * n + d - 1n) / d;
}

export interface Selection {
  ids: PlannedPosition[];
  sizing: "value" | "count";
  /** Σ of the selected ids' probed values, or null under the count fallback. */
  expectedProceedsUsdc: bigint | null;
}

/**
 * Choose which ids to close.
 *
 *   • the most severe action (fraction 1/1) always closes everything;
 *   • otherwise the target is `min(fraction of total LP value, USDC still
 *     needed to reach the rung's disarm after the idle balance is repaid)`,
 *     and the ids are taken largest-value first until the target is met.
 *
 * Taking the minimum is what stops a crash-replay from compounding (audit
 * C-MED-1): after a lost transaction that already repaid, the live valuation
 * needs less, so the replay closes less — instead of another ⅓ of whatever is
 * left. Taking the LARGEST ids first is what stops a rung from firing on dust,
 * reporting CONFIRMED and latching (audit C-MED-2).
 */
export function selectIds(
  positions: readonly PlannedPosition[],
  action: string,
  usdcNeeded: bigint | null,
  idleUsdc: bigint
): Selection {
  const frac = CLOSE_FRACTION[action];
  if (frac === undefined) throw new RangeError(`no close policy for action ${action}`);
  if (positions.length === 0) return { ids: [], sizing: "value", expectedProceedsUsdc: 0n };

  // The last resort closes the position, not a slice of it.
  if (frac[0] === frac[1]) {
    const total = positions.every((p) => p.valueUsdc !== null)
      ? positions.reduce((a, p) => a + (p.valueUsdc ?? 0n), 0n)
      : null;
    return { ids: [...positions], sizing: total === null ? "count" : "value", expectedProceedsUsdc: total };
  }

  const valued = positions.filter((p) => p.valueUsdc !== null && p.valueUsdc > 0n);
  if (valued.length === 0) {
    // Nothing could be valued: fall back to the id COUNT, in enumeration order,
    // and say so — the caller logs `sizing` so a fleet-wide fallback is visible.
    const k = closeCount(positions.length, action);
    return { ids: positions.slice(0, k), sizing: "count", expectedProceedsUsdc: null };
  }

  const sorted = [...positions].sort((a, b) => {
    const av = a.valueUsdc ?? -1n;
    const bv = b.valueUsdc ?? -1n;
    return bv > av ? 1 : bv < av ? -1 : 0;
  });
  const totalValue = sorted.reduce((acc, p) => acc + (p.valueUsdc ?? 0n), 0n);
  const cap = fractionOf(totalValue, frac);
  const need = usdcNeeded === null ? cap : usdcNeeded > idleUsdc ? usdcNeeded - idleUsdc : 0n;
  const target = need < cap ? need : cap;

  const chosen: PlannedPosition[] = [];
  let acc = 0n;
  for (const p of sorted) {
    if (acc >= target) break;
    chosen.push(p);
    acc += p.valueUsdc ?? 0n;
  }
  return { ids: chosen, sizing: "value", expectedProceedsUsdc: acc };
}

export function planAction(input: PlanInput): Plan {
  if (!(input.action in CLOSE_FRACTION)) return { kind: "REFUSE", reason: `unknown keeper action ${input.action}` };

  let selection: Selection;
  try {
    selection = selectIds(input.positions, input.action, input.usdcNeeded, input.idleUsdc);
  } catch (e) {
    return { kind: "REFUSE", reason: (e as Error).message };
  }

  if (selection.ids.length === 0 && input.idleUsdc === 0n) {
    return {
      kind: "NOTHING",
      reason: "no LP value to close and no idle USDC to repay — only the owner can add collateral or repay",
    };
  }

  // Group the selected ids by pool, most valuable pool first: the router
  // derives each batch's pool from the first id the account owns, so ids from
  // two pools cannot ride in one call. Each pool is one `unwind` — the same
  // selector, the same single grant.
  const byPool = new Map<Hex, bigint[]>();
  const poolValue = new Map<Hex, bigint>();
  for (const p of selection.ids) {
    const arr = byPool.get(p.poolId) ?? [];
    arr.push(p.id);
    byPool.set(p.poolId, arr);
    poolValue.set(p.poolId, (poolValue.get(p.poolId) ?? 0n) + (p.valueUsdc ?? 0n));
  }
  const pools = [...byPool.keys()].sort((a, b) => {
    const av = poolValue.get(a) ?? 0n;
    const bv = poolValue.get(b) ?? 0n;
    return bv > av ? 1 : bv < av ? -1 : 0;
  });

  const deadline = input.nowS + BigInt(input.txDeadlineS);
  const calls: KeeperCall[] = [];
  const closeIds: bigint[] = [];

  const unwindCall = (
    positionIds: bigint[],
    band: { minSqrtPriceX96: bigint; maxSqrtPriceX96: bigint },
    swap: SwapQuote,
    repayAmount: bigint
  ): KeeperCall => ({
    target: input.router,
    value: 0n,
    callback: false, // the account reads Permission.allowCallback, not this flag
    data: encodeFunctionData({
      abi: strategyRouterAbi,
      functionName: "unwind",
      args: [
        {
          collateralAsset: input.collateralAsset,
          positionIds,
          band,
          swap,
          repayAmount,
          withdrawAmount: 0n, // the keeper never moves collateral
          deadline,
        },
      ],
    }),
  });

  for (let i = 0; i < pools.length; i++) {
    const poolId = pools[i];
    const info = input.pools.get(poolId);
    if (info === undefined || info.sqrtPriceX96 <= 0n) {
      return { kind: "REFUSE", reason: `pool ${poolId} sqrtPrice unreadable or zero — refusing to close without a price band` };
    }
    let band;
    try {
      band = bandFor(info.sqrtPriceX96, input.bandToleranceBps);
    } catch (e) {
      return { kind: "REFUSE", reason: `cannot build price band for ${poolId}: ${(e as Error).message}` };
    }
    if (info.needsSwap && (info.swap.quotedIn === 0n || info.swap.quotedOut === 0n)) {
      // The router will swap this pool's non-USDC leg to USDC and the adapter
      // reverts ZeroQuote on an unpriced quote. Refuse rather than send a
      // transaction that cannot succeed, or (worse) an unbounded swap.
      return { kind: "REFUSE", reason: `pool ${poolId} needs a swap quote and none could be built — refusing to swap unpriced` };
    }
    const ids = byPool.get(poolId)!;
    closeIds.push(...ids);
    // Only the LAST call repays: the earlier closes credit the account first,
    // so one repay sweeps everything they produced plus the idle balance.
    const isLast = i === pools.length - 1 && input.repay !== false;
    calls.push(unwindCall(ids, band, info.needsSwap ? info.swap : NO_SWAP, isLast ? MAX_UINT256 : 0n));
  }

  if (calls.length === 0) {
    if (input.repay === false) return { kind: "NOTHING", reason: "nothing to close and this plan does not repay" };
    // Repay-only: idle USDC is enough (or nothing could be closed). No ids, so
    // the router never reaches the swap and the band is unused.
    calls.push(unwindCall([], { minSqrtPriceX96: 1n, maxSqrtPriceX96: 2n }, NO_SWAP, MAX_UINT256));
  }

  const selector = calls[0].data.slice(0, 10) as Hex;
  return {
    kind: "CALLS",
    calls,
    closeIds,
    // One selector, one target: exactly the Permission the user signed.
    grantsNeeded: [{ target: input.router, selector }],
    expectedProceedsUsdc: selection.expectedProceedsUsdc,
    sizing: selection.sizing,
  };
}
