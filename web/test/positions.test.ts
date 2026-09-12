import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeIndexed } from "../lib/indexer";
import { fromDemo, mergePositions } from "../lib/positions";
import { DEMO_ACCOUNT_STATE, DEMO_MARKET } from "../lib/demo";
import type { LpPositionRead } from "../lib/reads";
import { CURATED_POOLS } from "@zyo/shared";

const chainPos = (id: bigint, poolId: string, over: Partial<LpPositionRead> = {}): LpPositionRead => {
  const pool = CURATED_POOLS.find((p) => p.id === poolId);
  return {
    positionId: id,
    enginePoolId: (pool?.enginePoolId ?? "0x" + "0".repeat(64)) as `0x${string}`,
    pool,
    venue: "engine",
    rangeWidthBps: 1500,
    tickLower: -199_200,
    tickUpper: -197_700,
    tick: -198_407,
    inRange: true,
    rebalanceDelayHours: 12,
    autoCompound: true,
    openedAt: "2026-08-30T14:03:00Z",
    cumulativeRewardsAtomic: 96_400_000_000_000_000_000n,
    totalRebalances: 3,
    ...over,
  };
};

const cache = normalizeIndexed(
  {
    account: "0x2222222222222222222222222222222222222222",
    indexedAt: "2026-09-05T01:00:00Z",
    block: 50_700_000,
    positions: [
      { positionId: "7", poolId: "aero-usdc-weth-5", rangeWidthBps: 1500, valueUsd: 16_000, entryUsdc: 15_926.178, inRange: true, accruedRewardsUsd: 31.6, openedAt: "2026-08-30T14:03:00Z" },
      { positionId: "8", poolId: "aero-cbbtc-usdc", rangeWidthBps: 300, valueUsd: 999 }, // NOT on chain any more
      { poolId: "aero-cbbtc-usdc" }, // unreadable row
    ],
    activity: [{ at: "2026-09-04T20:11:00Z", kind: "rebalance", text: "rebalanced" }, { kind: "x" }],
  },
  "0x1111111111111111111111111111111111111111",
)!;

test("normalizeIndexed keeps readable rows only", () => {
  assert.equal(cache.positions.length, 2);
  assert.equal(cache.activity.length, 1);
  assert.equal(cache.block, 50_700_000);
  assert.equal(normalizeIndexed(null, "0x"), null);
  assert.equal(normalizeIndexed("nope", "0x"), null);
});

test("mergePositions: chain rows are the authority (width/range/flags from the engine); the cache adds USD marks and cannot invent a position", () => {
  const rows = mergePositions([chainPos(7n, "aero-usdc-weth-5"), chainPos(9n, "aero-cbbtc-usdc", { rangeWidthBps: 300, inRange: false, tick: null })], cache);
  assert.deepEqual(
    rows.map((r) => r.positionId),
    [7n, 9n],
  );
  const seven = rows[0];
  assert.equal(seven.source, "chain");
  assert.equal(seven.detailSource, "cache");
  assert.equal(seven.pool?.id, "aero-usdc-weth-5");
  assert.equal(seven.preset, "MODERATE"); // 1500 bps on an UNCORRELATED pair — from the CHAIN width
  assert.equal(seven.valueUsd, 16_000); // from the cache
  assert.equal(seven.inRange, true); // chain wins over cache
  assert.equal(seven.tickLower, -199_200);
  assert.ok(Math.abs((seven.cumulativeRewardsAero ?? 0) - 96.4) < 1e-9);
  const nine = rows[1];
  assert.equal(nine.detailSource, "none"); // on chain, not yet indexed
  assert.equal(nine.preset, "AGGRESSIVE");
  assert.equal(nine.inRange, false);
  assert.equal(nine.valueUsd, undefined);
  assert.ok(!rows.some((r) => r.positionId === 8n), "cached #8 not on chain → dropped");
  assert.deepEqual(mergePositions([], cache), [], "chain says none → cache cannot invent");
});

test("mergePositions: chain unavailable → cache rows shown, labelled cache", () => {
  const rows = mergePositions(null, cache);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.source === "cache"));
  assert.equal(rows[1].preset, "AGGRESSIVE"); // 300 bps uncorrelated
});

test("mergePositions with nothing → empty", () => {
  assert.deepEqual(mergePositions([], null), []);
  assert.deepEqual(mergePositions(null, null), []);
});

test("demo positions: debt equals what the wizard would borrow at 40% for 0.5 cbBTC", () => {
  const p = fromDemo(DEMO_ACCOUNT_STATE.positions[0]);
  assert.equal(p.source, "demo");
  assert.equal(p.preset, "MODERATE");
  const expected = 0.5 * DEMO_MARKET.reserves.cbBTC!.priceUsd * 0.4;
  assert.ok(Math.abs(DEMO_ACCOUNT_STATE.debtUsdc - expected) < 1e-9);
  assert.ok(Math.abs((p.entryUsdc ?? 0) - expected) < 1e-9);
});
