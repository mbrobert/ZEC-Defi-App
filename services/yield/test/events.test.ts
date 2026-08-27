import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeEngineLog, TOPICS } from "../src/engine/events.js";
import { LOGS } from "./fixtures/engine.js";
import type {
  FeesHarvestedEvent,
  PerformanceFeeCollectedEvent,
  PositionCreatedEvent,
  PositionWithdrawnEvent,
  SnuggleRebalancedEvent,
  StakingRewardsClaimedEvent,
} from "../src/types.js";

// Expected values below were computed INDEPENDENTLY of the decoder (plain
// BigInt arithmetic on the captured hex) — see the capture log 2026-08-27.

test("decodes every captured live log to the right kind", () => {
  const decoded = LOGS.map((l) => decodeEngineLog(l));
  assert.equal(decoded.filter(Boolean).length, LOGS.length);
  const kinds = decoded.map((e) => e!.kind);
  for (const k of [
    "PositionCreated",
    "PositionWithdrawn",
    "FeesHarvested",
    "StakingRewardsClaimed",
    "PerformanceFeeCollected",
    "SnuggleRebalanced",
  ]) {
    assert.equal(kinds.filter((x) => x === k).length, 2, k);
  }
});

test("PositionCreated: ids, owner, pool, negative ticks, liquidity", () => {
  const e = decodeEngineLog(LOGS[0]) as PositionCreatedEvent;
  assert.equal(e.tokenId, "5889519");
  assert.equal(e.owner, "0x6bdd1ea8b71e02bae5046b3f45c3e8a3806af24a");
  assert.equal(e.poolId, "0x7bfcb140f957ab39bbd0f52a30c5e04a4b64ae6a75aec219877ded724150d20d");
  assert.equal(e.tickLower, -198544);
  assert.equal(e.tickUpper, -197410);
  assert.equal(e.liquidity, "702795170145553");
  assert.equal(e.staked, true);

  const e2 = decodeEngineLog(LOGS[1]) as PositionCreatedEvent;
  assert.equal(e2.tokenId, "75740612");
  assert.equal(e2.liquidity, "487816825870026");
  // the aweth flagship pool key
  assert.equal(e2.poolId, "0x0ea72f44ccaf524e3fda5e4a6682fda7a79e42dc2858ee27be311e9337aa72a8");
});

test("PositionWithdrawn: amounts", () => {
  const e = decodeEngineLog(LOGS[2]) as PositionWithdrawnEvent;
  assert.equal(e.tokenId, "5875787");
  assert.equal(e.amount0, "14955569011356961686");
  assert.equal(e.amount1, "32320008056900");
});

test("FeesHarvested: amounts", () => {
  const e = decodeEngineLog(LOGS[4]) as FeesHarvestedEvent;
  assert.equal(e.tokenId, "5875787");
  assert.equal(e.amount0, "130459184686422618");
  assert.equal(e.amount1, "38023538890470");
});

test("StakingRewardsClaimed: AERO reward token + amount", () => {
  const e = decodeEngineLog(LOGS[6]) as StakingRewardsClaimedEvent;
  assert.equal(e.tokenId, "75673443");
  assert.equal(e.rewardToken, "0x940181a94a35a4569e4529a3cdfb74e38fd98631");
  assert.equal(e.amount, "40899107511085816858");
});

test("PerformanceFeeCollected: amounts", () => {
  const e = decodeEngineLog(LOGS[8]) as PerformanceFeeCollectedEvent;
  assert.equal(e.tokenId, "2097166");
  assert.equal(e.amountA, "361916455803875");
  assert.equal(e.amountC, "0");
});

test("SnuggleRebalanced: old→new re-key ids, ticks, count", () => {
  const e = decodeEngineLog(LOGS[10]) as SnuggleRebalancedEvent;
  assert.equal(e.tokenId, "75212787"); // old id
  assert.equal(e.newTokenId, "75736335"); // successor id
  assert.equal(e.pool, "0x632e4f1cd0b7c0371007f2c45b94fcbbf66234e3");
  assert.equal(e.tickLower, 91600);
  assert.equal(e.tickUpper, 92400);
  assert.equal(e.amount0, "234533593008949");
  assert.equal(e.amount1, "1248279562705103393");
  assert.equal(e.flag, false);
  assert.equal(e.count, 21);
});

test("unknown topics return null", () => {
  assert.equal(
    decodeEngineLog({ ...LOGS[0], topics: ["0x" + "ab".repeat(32) as never] }),
    null
  );
});

test("topic constants are well-formed and distinct", () => {
  const vals = Object.values(TOPICS);
  assert.equal(new Set(vals).size, vals.length);
  for (const v of vals) assert.match(v, /^0x[0-9a-f]{64}$/);
});
