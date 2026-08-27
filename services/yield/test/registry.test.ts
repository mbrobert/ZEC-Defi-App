import assert from "node:assert/strict";
import { test } from "node:test";
import { syncEngineRegistry } from "../src/engine/registry.js";
import { RpcClient } from "../src/sources/rpc.js";
import { APPROVED_POOLS_AWETH } from "./fixtures/engine.js";
import { SEL } from "../src/abi.js";
import type { Address } from "../src/types.js";

const VAULT = "0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55" as Address;
const AWETH_ID = "0x0ea72f44ccaf524e3fda5e4a6682fda7a79e42dc2858ee27be311e9337aa72a8";

class StubRpc extends RpcClient {
  constructor() { super("http://unused.invalid"); }
  override async callMany<T>(calls: { method: string; params: unknown[] }[]): Promise<T[]> {
    return calls.map((c) => {
      const data = (c.params[0] as { data: string }).data;
      assert.ok(data.startsWith(SEL.approvedPools));
      // Serve the REAL captured return for the aweth pool; empty for others
      return (data.includes(AWETH_ID.slice(2)) ? APPROVED_POOLS_AWETH : "0x") as T;
    });
  }
}

test("registry sync decodes the real approvedPools return and cross-checks the pool address", async () => {
  const { pools, tokenMap, mismatches } = await syncEngineRegistry(new StubRpc(), VAULT);
  const aweth = pools.find((p) => p.curatedId === "aero-usdc-weth-5")!;
  assert.equal(aweth.pool, "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59");
  assert.equal(aweth.token0, "0x4200000000000000000000000000000000000006");
  assert.equal(aweth.token1, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
  assert.equal(aweth.engineFeeRaw, 100); // raw word — units differ per DEX, never used as bps
  assert.equal(aweth.active, true);
  assert.deepEqual(tokenMap.get(AWETH_ID as never), {
    token0: "0x4200000000000000000000000000000000000006",
    token1: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  });
  // pools the stub returned "0x" for are reported, not silently dropped
  assert.ok(mismatches.length >= 1);
  // and none of the reported mismatches is the aweth pool
  assert.ok(!mismatches.some((m) => m.startsWith("aero-usdc-weth-5:")));
});
