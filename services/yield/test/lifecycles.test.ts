import assert from "node:assert/strict";
import { test } from "node:test";
import { foldLifecycles, type PoolTokenMap } from "../src/engine/lifecycles.js";
import type { Address, EngineEvent, Hex } from "../src/types.js";

const POOL_A = ("0x" + "aa".repeat(32)) as Hex;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as Address;
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631" as Address;
const OWNER = ("0x" + "11".repeat(20)) as Address;

const tokenMap: PoolTokenMap = new Map([[POOL_A, { token0: WETH, token1: USDC }]]);

let seq = 0;
const base = (block: number) => ({
  blockNumber: block,
  timestamp: 1_787_000_000 + block,
  transactionHash: ("0x" + (++seq).toString(16).padStart(64, "0")) as Hex,
  logIndex: seq,
});

function created(tokenId: string, block: number, entry?: Record<string, string>): EngineEvent {
  return {
    kind: "PositionCreated", tokenId, owner: OWNER, poolId: POOL_A,
    tickLower: -100, tickUpper: 100, liquidity: "1", staked: true,
    entryFlows: entry, ...base(block),
  };
}
function rebalanced(oldId: string, newId: string, block: number): EngineEvent {
  return {
    kind: "SnuggleRebalanced", tokenId: oldId, newTokenId: newId,
    pool: ("0x" + "22".repeat(20)) as Address, tickLower: -50, tickUpper: 50,
    amount0: "0", amount1: "0", flag: false, count: 1, ...base(block),
  };
}
function harvested(tokenId: string, a0: string, a1: string, block: number): EngineEvent {
  return { kind: "FeesHarvested", tokenId, recipient: OWNER, amount0: a0, amount1: a1, ...base(block) };
}
function claimed(tokenId: string, amount: string, block: number): EngineEvent {
  return { kind: "StakingRewardsClaimed", tokenId, recipient: OWNER, rewardToken: AERO, amount, ...base(block) };
}
function withdrawn(tokenId: string, a0: string, a1: string, block: number): EngineEvent {
  return { kind: "PositionWithdrawn", tokenId, owner: OWNER, amount0: a0, amount1: a1, ...base(block) };
}

test("rebalance re-keying: one economic position stays one lifecycle", () => {
  // Created(1) → Rebalanced(1→2) → Harvest(2) → Rebalanced(2→3) → Withdrawn(3)
  const events: EngineEvent[] = [
    created("1", 100, { [USDC]: "1000" }),
    rebalanced("1", "2", 110),
    harvested("2", "5", "7", 120),
    rebalanced("2", "3", 130),
    withdrawn("3", "900", "60", 140),
  ];
  const { lifecycles, orphanEvents } = foldLifecycles(events, tokenMap);
  assert.equal(orphanEvents, 0);
  assert.equal(lifecycles.length, 1);
  const lc = lifecycles[0]!;
  assert.equal(lc.tokenId, "1");
  assert.equal(lc.rebalances, 2);
  assert.equal(lc.harvests, 1);
  assert.equal(lc.closedBlock, 140);
  // exit flows: withdrawn 900 WETH-units + harvest 5 → 905; USDC 60 + 7 → 67
  assert.equal(lc.exitFlows[WETH], "905");
  assert.equal(lc.exitFlows[USDC], "67");
  assert.equal(lc.entryFlows[USDC], "1000");
});

test("harvest on the OLD id in the same tx as the rebalance still lands (order preserved)", () => {
  // Mirrors the live fixture: FeesHarvested(oldId) precedes SnuggleRebalanced(old→new).
  const events: EngineEvent[] = [
    created("10", 100),
    harvested("10", "1", "1", 105),
    rebalanced("10", "11", 105),
    withdrawn("11", "2", "2", 110),
  ];
  const { lifecycles, orphanEvents } = foldLifecycles(events, tokenMap);
  assert.equal(orphanEvents, 0);
  assert.equal(lifecycles[0]!.harvests, 1);
  assert.equal(lifecycles[0]!.closedBlock, 110);
});

test("orphan events (history predating the backfill) are counted, not invented", () => {
  const events: EngineEvent[] = [
    withdrawn("999", "1", "1", 100), // no Created in store
    rebalanced("998", "997", 101),
    withdrawn("997", "1", "1", 102), // chains to unknown root → orphan
  ];
  const { lifecycles, orphanEvents } = foldLifecycles(events, tokenMap);
  assert.equal(lifecycles.length, 0);
  assert.equal(orphanEvents, 3);
});

test("staking rewards flow into exitFlows under the reward token", () => {
  const events: EngineEvent[] = [
    created("5", 100, { [USDC]: "100" }),
    claimed("5", "42", 110),
    withdrawn("5", "0", "100", 120),
  ];
  const { lifecycles } = foldLifecycles(events, tokenMap);
  assert.equal(lifecycles[0]!.exitFlows[AERO], "42");
  assert.equal(lifecycles[0]!.exitFlows[USDC], "100");
  // zero-amount withdraw leg is not recorded
  assert.equal(lifecycles[0]!.exitFlows[WETH], undefined);
});

test("independent positions do not cross-contaminate", () => {
  const events: EngineEvent[] = [
    created("1", 100, { [USDC]: "100" }),
    created("2", 101, { [USDC]: "200" }),
    rebalanced("1", "3", 105),
    withdrawn("3", "0", "111", 110),
    withdrawn("2", "0", "222", 111),
  ];
  const { lifecycles } = foldLifecycles(events, tokenMap);
  const byId = new Map(lifecycles.map((l) => [l.tokenId, l]));
  assert.equal(byId.get("1")!.exitFlows[USDC], "111");
  assert.equal(byId.get("2")!.exitFlows[USDC], "222");
});

test("pools missing from the registry map mark the lifecycle unattributed (excluded, never a fake loss)", () => {
  const unknownPool = ("0x" + "bb".repeat(32)) as Hex;
  const events: EngineEvent[] = [
    { ...created("7", 100, { [USDC]: "1000" }), poolId: unknownPool } as EngineEvent,
    withdrawn("7", "10", "10", 120),
  ];
  const { lifecycles } = foldLifecycles(events, tokenMap);
  assert.equal(lifecycles.length, 1);
  // Amounts can't be attributed without token0/token1: flows stay empty AND
  // the lifecycle is flagged so valuation treats it as unpriced. Without the
  // flag, a $1000-entry position with dropped exits would band as a −100%
  // loss (real events, zeroed value).
  assert.equal(lifecycles[0]!.closedBlock, 120);
  assert.deepEqual(lifecycles[0]!.exitFlows, {});
  assert.equal(lifecycles[0]!.unattributed, true);
});

test("FeesHarvested with a NON-owner recipient is an internal harvest, not an owner exit flow", () => {
  const internalRecipient = ("0x" + "99".repeat(20)) as Address;
  const events: EngineEvent[] = [
    created("20", 100, { [USDC]: "1000" }),
    // auto-compound leg: engine harvests to itself, value re-enters the position
    { ...harvested("20", "50", "70", 110), recipient: internalRecipient } as EngineEvent,
    harvested("20", "5", "7", 115), // owner-recipient harvest — real exit
    withdrawn("20", "900", "60", 140),
  ];
  const { lifecycles } = foldLifecycles(events, tokenMap);
  const lc = lifecycles[0]!;
  // Only the owner harvest + withdrawal count: 900+5 WETH-units, 60+7 USDC.
  assert.equal(lc.exitFlows[WETH], "905");
  assert.equal(lc.exitFlows[USDC], "67");
  assert.equal(lc.harvests, 1);
  assert.equal(lc.internalHarvests, 1);
});

test("recipient matching is case-insensitive (checksummed vs lowercase addresses)", () => {
  const events: EngineEvent[] = [
    created("21", 100, { [USDC]: "1000" }),
    { ...harvested("21", "5", "7", 110), recipient: OWNER.toUpperCase().replace("0X", "0x") } as EngineEvent,
    withdrawn("21", "0", "0", 140),
  ];
  const { lifecycles } = foldLifecycles(events, tokenMap);
  assert.equal(lifecycles[0]!.harvests, 1);
  assert.equal(lifecycles[0]!.internalHarvests, 0);
  assert.equal(lifecycles[0]!.exitFlows[WETH], "5");
});

test("re-used tokenId: the SECOND lifecycle receives its own events (no cross-contamination)", () => {
  // Position closes, then the engine (unexpectedly) mints the same id again.
  const events: EngineEvent[] = [
    created("30", 100, { [USDC]: "1000000000" }),
    withdrawn("30", "0", "1100000000", 200),
    created("30", 300, { [USDC]: "2000000000" }),
    withdrawn("30", "0", "2500000000", 400),
  ];
  const { lifecycles } = foldLifecycles(events, tokenMap);
  assert.equal(lifecycles.length, 2);
  const first = lifecycles.find((l) => l.openedBlock === 100)!;
  const second = lifecycles.find((l) => l.openedBlock === 300)!;
  // The OLD fold sent BOTH withdrawals to the first lifecycle (entry 1000,
  // exit 3600 → a fabricated +260% return) and left the second open forever.
  assert.equal(first.exitFlows[USDC], "1100000000");
  assert.equal(first.closedBlock, 200);
  assert.equal(second.exitFlows[USDC], "2500000000");
  assert.equal(second.closedBlock, 400);
});
