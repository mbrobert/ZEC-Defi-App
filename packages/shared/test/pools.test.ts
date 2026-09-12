import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CURATED_POOLS,
  ENGINE_REGISTRY_SNAPSHOT,
  poolById,
  poolsForEntryAsset,
  poolsContainingAsset,
  enginePools,
  directPools,
  offerablePools,
  lpMenu,
  lpPoolId,
  directPoolId,
  poolByLpPoolId,
  AERODROME,
  REWARD_CLAIM_POLICY,
  shouldClaim,
  isHexAddress,
} from "../dist/index.js";

test("curated pools keep their verified ids/addresses and gain a pairClass", () => {
  assert.equal(CURATED_POOLS.length, 13);
  const ids = CURATED_POOLS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "ids unique");
  for (const p of CURATED_POOLS) {
    assert.ok(["UNCORRELATED", "CORRELATED"].includes(p.pairClass), `${p.id} pairClass`);
    assert.ok(isHexAddress(p.poolAddress), `${p.id} poolAddress`);
    if (p.protocol !== "DIRECT") assert.match(p.enginePoolId ?? "", /^0x[0-9a-f]{64}$/, `${p.id} enginePoolId`);
  }
  assert.equal(poolById("cbeth-weth")?.pairClass, "CORRELATED");
  assert.equal(poolById("aero-usdt-usdc")?.pairClass, "CORRELATED");
  assert.equal(poolById("aero-weth-cbbtc")?.pairClass, "CORRELATED");
  assert.equal(poolById("aero-cbbtc-usdc")?.pairClass, "UNCORRELATED");
  assert.equal(poolById("aero-cbbtc-usdc")?.poolAddress, "0x4e962bb3889bf030368f56810a9c96b83cb3e778");
  assert.equal(ENGINE_REGISTRY_SNAPSHOT.vaultProxy, "0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55");
});

test("cbZEC/USDC is a DIRECT pool with its gauge: in the LP menu through the direct venue, outside the engine menu", () => {
  const p = poolById("aero-cbzec-usdc");
  assert.ok(p);
  assert.equal(p.protocol, "DIRECT");
  assert.equal(p.dex, "AERODROME");
  assert.equal(p.poolAddress, AERODROME.pools.cbZEC_USDC.address);
  assert.equal(p.gauge, AERODROME.pools.cbZEC_USDC.gauge);
  assert.equal(p.tickSpacing, 200);
  assert.equal(p.feeTierBps, 20);
  assert.equal(p.enginePoolId, undefined);
  assert.match(p.note ?? "", /re-voted every Thursday/i, "the vote is per epoch, never baked in");
  assert.match(p.note ?? "", /static/i, "no rebalancer on the direct venue");
  assert.equal(offerablePools().some((x) => x.id === "aero-cbzec-usdc"), false, "not an engine pool");
  assert.deepEqual(directPools().map((x) => x.id), ["aero-cbzec-usdc"]);
  assert.equal(lpMenu().some((x) => x.id === "aero-cbzec-usdc"), true, "openable through the direct venue");
  assert.equal(lpMenu().length, 9);
  assert.equal(lpPoolId(p), directPoolId(AERODROME.pools.cbZEC_USDC.address));
  assert.equal(lpPoolId(p), "0x0000000000000000000000000fc47c17af86078d809358db1b4db2debc988566");
  assert.equal(lpPoolId(poolById("aero-usdc-weth-5")!), poolById("aero-usdc-weth-5")!.enginePoolId);
  assert.equal(poolByLpPoolId("0x0000000000000000000000000FC47C17AF86078D809358DB1B4DB2DEBC988566")?.id, "aero-cbzec-usdc");
  assert.equal(poolByLpPoolId(poolById("aero-usdc-weth-5")!.enginePoolId!)?.id, "aero-usdc-weth-5");
  assert.throws(() => directPoolId("0x1234"));
  assert.equal(enginePools().length, 12);
  assert.equal(enginePools().every((x) => !!x.enginePoolId), true);
});

test("offerable menu = Aerodrome pools reachable through the engine", () => {
  const menu = offerablePools();
  assert.equal(menu.length, 8);
  assert.equal(menu.every((p) => p.dex === "AERODROME" && p.protocol === "SNUGGLEFI"), true);
});

test("lookups by entry asset / containing asset", () => {
  assert.ok(poolsForEntryAsset("USDC").length >= 5);
  const weth = poolsContainingAsset("WETH").map((p) => p.id);
  for (const id of ["aero-usdc-weth-5", "aero-weth-cbbtc", "cbeth-weth", "aero-aero-weth"]) assert.ok(weth.includes(id), id);
  assert.equal(poolsContainingAsset("cbZEC").map((p) => p.id).join(), "aero-cbzec-usdc");
  assert.equal(poolById("nope"), undefined);
});

test("reward-claim policy and decision", () => {
  assert.deepEqual(REWARD_CLAIM_POLICY, { minCostMultiple: 3, minAbsoluteUsd: 5, maxHoldDays: 30 });
  assert.deepEqual(shouldClaim(4.99, 0.1, 1), { claim: false, reason: "below-floor" });
  assert.deepEqual(shouldClaim(6, 2.5, 1), { claim: false, reason: "gas-too-high" });
  assert.deepEqual(shouldClaim(6, 2, 1), { claim: true, reason: "worth-it" });
  assert.deepEqual(shouldClaim(3, 1, 30), { claim: true, reason: "max-hold-reached" });
  assert.deepEqual(shouldClaim(0.5, 1, 30), { claim: false, reason: "below-floor" }, "never claim when gas exceeds accrual");
  assert.deepEqual(shouldClaim(NaN, 1, 1), { claim: false, reason: "below-floor" }, "fail closed");
});
