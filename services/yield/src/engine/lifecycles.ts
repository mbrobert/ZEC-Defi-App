/**
 * Fold the decoded event stream into per-position lifecycles.
 *
 * Flow accounting (methodology v2 — "closed-position-flows"):
 *   entry   = entryFlows (owner→vault inflows of the deposit tx)
 *   refunds = entryRefunds of the deposit tx, ATTRIBUTED here:
 *             a vault→owner leg counts only when its token is one of the
 *             position's pool tokens or a token the owner deposited. Any
 *             other vault→owner leg in that tx is unrelated to this
 *             position (wave 2: one such leg produced a +36,496,350 % band)
 *             — ignored and counted in `unattributedRefundLegs`.
 *   ambiguous = the deposit tx created more than one position → refused.
 *   exit    = PositionWithdrawn amounts (token0/token1, resolved via the
 *             engine pool registry) + FeesHarvested amounts +
 *             StakingRewardsClaimed amounts
 * PerformanceFeeCollected is NOT subtracted — the engine skims BEFORE the
 * owner-facing amounts are emitted, so measured exits are already
 * post-engine-fee. Rebalance events only increment counters (their token
 * movements are internal to the position, not owner flows).
 */

import type {
  Address,
  EngineEvent,
  Hex,
  PositionLifecycle,
} from "../types.js";

/** token0/token1 per engine poolId — from approvedPools (registry sync). */
export type PoolTokenMap = Map<Hex, { token0: Address; token1: Address }>;

function addFlow(rec: Record<Address, string>, token: Address, amount: string): void {
  const t = token.toLowerCase() as Address;
  const prev = BigInt(rec[t] ?? "0");
  rec[t] = (prev + BigInt(amount)).toString();
}

export interface FoldResult {
  lifecycles: PositionLifecycle[];
  /** Events referencing tokenIds with no PositionCreated in the store (pre-backfill history). */
  orphanEvents: number;
}

/**
 * Attribute the raw same-tx refunds of a deposit to the position: keep only
 * legs in the pool's tokens or in a deposited token. Returns the kept
 * refunds and the number of legs ignored.
 */
export function attributeRefunds(
  entryFlows: Record<Address, string>,
  rawRefunds: Record<Address, string>,
  poolTokens: { token0: Address; token1: Address } | undefined
): { refunds: Record<Address, string>; ignored: number } {
  const allowed = new Set<string>(Object.keys(entryFlows).map((t) => t.toLowerCase()));
  if (poolTokens) {
    allowed.add(poolTokens.token0.toLowerCase());
    allowed.add(poolTokens.token1.toLowerCase());
  }
  const refunds: Record<Address, string> = {};
  let ignored = 0;
  for (const [token, amount] of Object.entries(rawRefunds)) {
    if (BigInt(amount) <= 0n) continue;
    if (allowed.has(token.toLowerCase())) addFlow(refunds, token as Address, amount);
    else ignored++;
  }
  return { refunds, ignored };
}

export function foldLifecycles(events: EngineEvent[], poolTokens: PoolTokenMap): FoldResult {
  const byToken = new Map<string, PositionLifecycle>();
  /**
   * Rebalances RE-KEY the position (SnuggleRebalanced(oldId, newId, …) —
   * verified live 2026-08-27 / 2026-09-03): alias every successor id back
   * to the root PositionCreated id so one economic position stays one
   * lifecycle.
   */
  const alias = new Map<string, string>();
  const resolve = (id: string): string => {
    let cur = id;
    const seen = new Set<string>();
    while (alias.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = alias.get(cur)!;
    }
    return cur;
  };
  let orphanEvents = 0;

  for (const e of events) {
    if (e.kind === "PositionCreated") {
      // Re-used tokenIds are not expected (engine mints sequential ids);
      // if one recurs, the later Created starts a fresh lifecycle keyed by
      // tokenId@block to avoid cross-contamination.
      const key = byToken.has(e.tokenId) ? `${e.tokenId}@${e.blockNumber}` : e.tokenId;
      const entryFlows = { ...(e.entryFlows ?? {}) };
      const { refunds, ignored } = attributeRefunds(entryFlows, e.entryRefunds ?? {}, poolTokens.get(e.poolId));
      byToken.set(key, {
        tokenId: e.tokenId,
        poolId: e.poolId,
        owner: e.owner,
        openedBlock: e.blockNumber,
        openedAt: e.timestamp,
        entryFlows,
        entryRefunds: refunds,
        ambiguousEntry: (e.entryTxPositions ?? 1) > 1,
        unattributedRefundLegs: ignored,
        exitFlows: {},
        harvests: 0,
        rebalances: 0,
      });
      continue;
    }

    const root = resolve(e.tokenId);
    if (e.kind === "SnuggleRebalanced" && e.newTokenId !== e.tokenId) {
      alias.set(e.newTokenId, root);
    }
    const lc = byToken.get(root);
    if (!lc) {
      orphanEvents++;
      continue;
    }

    switch (e.kind) {
      case "PositionWithdrawn": {
        const tokens = poolTokens.get(lc.poolId);
        if (tokens) {
          if (e.amount0 !== "0") addFlow(lc.exitFlows, tokens.token0, e.amount0);
          if (e.amount1 !== "0") addFlow(lc.exitFlows, tokens.token1, e.amount1);
        }
        lc.closedBlock = e.blockNumber;
        lc.closedAt = e.timestamp;
        break;
      }
      case "FeesHarvested": {
        const tokens = poolTokens.get(lc.poolId);
        if (tokens) {
          if (e.amount0 !== "0") addFlow(lc.exitFlows, tokens.token0, e.amount0);
          if (e.amount1 !== "0") addFlow(lc.exitFlows, tokens.token1, e.amount1);
        }
        lc.harvests++;
        break;
      }
      case "StakingRewardsClaimed": {
        if (e.amount !== "0") addFlow(lc.exitFlows, e.rewardToken, e.amount);
        lc.harvests++;
        break;
      }
      case "SnuggleRebalanced":
        lc.rebalances++;
        break;
      case "PerformanceFeeCollected":
        break; // informational — already netted out of owner flows
    }
  }

  return { lifecycles: [...byToken.values()], orphanEvents };
}
