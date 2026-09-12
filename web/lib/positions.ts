/**
 * The dashboard's position model: CHAIN detail (engine `positions(id)` +
 * pool slot0) merged with the indexer CACHE (USD value, entry, accrued
 * rewards in USD). Chain is the authority for which positions exist and for
 * their range/width/flags; the cache only adds what the chain cannot say
 * cheaply (USD marks). A cache row the chain does not list is dropped.
 */
import { CURATED_POOLS, type CuratedPool, presetForParams, type RangePreset } from "@zyo/shared";
import type { DemoPosition } from "./demo";
import type { IndexedAccount } from "./indexer";
import type { LpPositionRead } from "./reads";

export interface PositionView {
  id: string;
  positionId?: bigint;
  pool: CuratedPool | undefined;
  poolId: string;
  enginePoolId?: `0x${string}`;
  /** Which venue holds the position (2026-09-11); undefined for a cache-only row. */
  venue?: "engine" | "direct";
  /** Direct venue: staked in the pool's gauge (earning AERO) or held unstaked in the account. */
  staked?: boolean;
  preset: RangePreset | "UNKNOWN";
  rangeWidthBps?: number;
  tickLower?: number;
  tickUpper?: number;
  tick?: number | null;
  rebalanceDelayHours?: number;
  autoCompound?: boolean;
  totalRebalances?: number;
  /** Lifetime AERO paid to the position, human units. */
  cumulativeRewardsAero?: number;
  openedAt?: string;
  entryUsdc?: number;
  valueUsd?: number;
  inRange?: boolean;
  /** Gross accrued rewards, USD (cache). Fee is derived at render via feeBreakdown. */
  accruedRewardsUsd?: number;
  daysSinceFirstAccrual?: number;
  /** Where the row itself came from. */
  source: "chain" | "cache" | "demo";
  /** Where the USD detail came from. */
  detailSource: "chain" | "cache" | "none" | "demo";
}

export function fromDemo(p: DemoPosition): PositionView {
  const pool = CURATED_POOLS.find((x) => x.id === p.poolId);
  return {
    id: p.id,
    positionId: BigInt(p.id.replace(/\D/g, "") || "0"),
    pool,
    poolId: p.poolId,
    enginePoolId: pool?.enginePoolId as `0x${string}` | undefined,
    preset: p.preset,
    rangeWidthBps: p.rangeWidthBps,
    tickLower: -199_200,
    tickUpper: -197_700,
    tick: -198_407,
    rebalanceDelayHours: 12,
    autoCompound: true,
    totalRebalances: 3,
    cumulativeRewardsAero: 96.4,
    openedAt: p.openedAt,
    entryUsdc: p.entryUsdc,
    valueUsd: p.valueUsd,
    inRange: p.inRange,
    accruedRewardsUsd: p.accruedRewardsUsd,
    daysSinceFirstAccrual: p.daysSinceFirstAccrual,
    source: "demo",
    detailSource: "demo",
  };
}

function presetOf(rangeWidthBps: number | undefined, pool: CuratedPool | undefined): PositionView["preset"] {
  if (rangeWidthBps === undefined || !pool) return "UNKNOWN";
  return presetForParams({ rangeWidthBps, rebalanceDelayHours: 0, autoCompoundEnabled: true }, pool.pairClass);
}

/**
 * Merge chain positions with the cache. `chain` null = the chain read failed
 * (cache rows shown, labelled "cache"); `chain` [] = the account truly has
 * no positions (cache rows are NOT shown).
 */
export function mergePositions(chain: LpPositionRead[] | null, cache: IndexedAccount | null): PositionView[] {
  const byId = new Map<string, IndexedAccount["positions"][number]>();
  for (const p of cache?.positions ?? []) byId.set(p.positionId, p);

  if (chain) {
    return chain.map((c) => {
      const k = byId.get(c.positionId.toString());
      const pool = c.pool ?? (k?.poolId ? CURATED_POOLS.find((x) => x.id === k.poolId) : undefined);
      return {
        id: `pos-${c.positionId}`,
        positionId: c.positionId,
        pool,
        poolId: pool?.id ?? k?.poolId ?? c.enginePoolId,
        enginePoolId: c.enginePoolId,
        venue: c.venue,
        staked: c.staked,
        preset: presetOf(c.rangeWidthBps, pool),
        rangeWidthBps: c.rangeWidthBps,
        tickLower: c.tickLower,
        tickUpper: c.tickUpper,
        tick: c.tick,
        rebalanceDelayHours: c.rebalanceDelayHours,
        autoCompound: c.autoCompound,
        totalRebalances: c.totalRebalances,
        cumulativeRewardsAero: Number(c.cumulativeRewardsAtomic) / 1e18,
        openedAt: c.openedAt ?? k?.openedAt,
        entryUsdc: k?.entryUsdc,
        valueUsd: k?.valueUsd,
        inRange: c.inRange ?? k?.inRange,
        accruedRewardsUsd: k?.accruedRewardsUsd,
        source: "chain",
        detailSource: k ? "cache" : "none",
      };
    });
  }
  return (cache?.positions ?? []).map((k) => {
    const pool = k.pool ?? CURATED_POOLS.find((x) => x.id === k.poolId);
    return {
      id: `pos-${k.positionId}`,
      positionId: /^\d+$/.test(k.positionId) ? BigInt(k.positionId) : undefined,
      pool,
      poolId: k.poolId,
      enginePoolId: pool?.enginePoolId as `0x${string}` | undefined,
      preset: presetOf(k.rangeWidthBps, pool),
      rangeWidthBps: k.rangeWidthBps,
      openedAt: k.openedAt,
      entryUsdc: k.entryUsdc,
      valueUsd: k.valueUsd,
      inRange: k.inRange,
      accruedRewardsUsd: k.accruedRewardsUsd,
      source: "cache",
      detailSource: "cache",
    };
  });
}
