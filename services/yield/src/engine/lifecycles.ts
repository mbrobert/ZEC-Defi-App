/**
 * Fold the decoded event stream into per-position lifecycles.
 *
 * Flow accounting (methodology v1 — "closed-position-flows"):
 *   entry  = entryFlows from the deposit tx (receipts pass)
 *   exit   = PositionWithdrawn amounts (token0/token1, resolved via the
 *            engine pool registry) + FeesHarvested amounts +
 *            StakingRewardsClaimed amounts
 * PerformanceFeeCollected is NOT subtracted — the engine skims BEFORE the
 * owner-facing amounts are emitted, so measured exits are already
 * post-engine-fee. Rebalance events only increment counters (their token
 * movements are internal to the position, not owner flows).
 *
 * Attribution honesty:
 *   • A pool missing from the registry map means exit amounts CANNOT be
 *     attributed to tokens. The lifecycle is marked `unattributed` and the
 *     valuation layer treats it as unpriced (excluded + counted) — it must
 *     never appear as a fake −100% total loss.
 *   • FeesHarvested flows count as owner exits ONLY when the event's
 *     recipient IS the owner. Auto-compounded harvests pay an internal
 *     recipient and re-enter the position — counting them would double-count
 *     value that later leaves via the final withdrawal. They increment
 *     `internalHarvests` instead, surfaced in fold output.
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

export function foldLifecycles(events: EngineEvent[], poolTokens: PoolTokenMap): FoldResult {
  const byToken = new Map<string, PositionLifecycle>();
  /**
   * Rebalances RE-KEY the position (SnuggleRebalanced(oldId, newId, …) —
   * verified live 2026-08-27): alias every successor id back to the root
   * PositionCreated id so one economic position stays one lifecycle.
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
  /**
   * Re-used tokenIds: root id → the map key of its LATEST lifecycle. Events
   * arrive block-ordered, so after a second PositionCreated for the same id,
   * later events belong to the fresh lifecycle — routing them to the first
   * one merged two positions' flows into a single bogus APR.
   */
  const currentKey = new Map<string, string>();
  let orphanEvents = 0;

  for (const e of events) {
    if (e.kind === "PositionCreated") {
      // Re-used tokenIds are not expected (engine mints sequential ids);
      // if one recurs, the later Created starts a fresh lifecycle keyed by
      // tokenId@block to avoid cross-contamination.
      const key = byToken.has(e.tokenId) ? `${e.tokenId}@${e.blockNumber}` : e.tokenId;
      currentKey.set(e.tokenId, key);
      byToken.set(key, {
        tokenId: e.tokenId,
        poolId: e.poolId.toLowerCase() as Hex,
        owner: e.owner,
        openedBlock: e.blockNumber,
        openedAt: e.timestamp,
        entryFlows: { ...(e.entryFlows ?? {}) },
        exitFlows: {},
        harvests: 0,
        internalHarvests: 0,
        rebalances: 0,
      });
      continue;
    }

    const root = resolve(e.tokenId);
    if (e.kind === "SnuggleRebalanced" && e.newTokenId !== e.tokenId) {
      alias.set(e.newTokenId, root);
    }
    // Route to the LATEST lifecycle for this root id (see currentKey).
    const lc = byToken.get(currentKey.get(root) ?? root);
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
        } else if (e.amount0 !== "0" || e.amount1 !== "0") {
          // Real value left the position but we cannot attribute it to
          // tokens. Mark the lifecycle so valuation excludes it — dropping
          // the flows silently would fabricate a total loss.
          lc.unattributed = true;
        }
        lc.closedBlock = e.blockNumber;
        lc.closedAt = e.timestamp;
        break;
      }
      case "FeesHarvested": {
        if (e.recipient.toLowerCase() !== lc.owner.toLowerCase()) {
          // Internal recipient (auto-compound leg) — value re-enters the
          // position, it is NOT an owner exit flow.
          lc.internalHarvests++;
          break;
        }
        const tokens = poolTokens.get(lc.poolId);
        if (tokens) {
          if (e.amount0 !== "0") addFlow(lc.exitFlows, tokens.token0, e.amount0);
          if (e.amount1 !== "0") addFlow(lc.exitFlows, tokens.token1, e.amount1);
        } else if (e.amount0 !== "0" || e.amount1 !== "0") {
          lc.unattributed = true;
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
