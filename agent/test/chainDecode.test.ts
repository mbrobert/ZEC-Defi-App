import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RpcReadOnlyChainService } from "../src/services/chain.js";
import { jsonResponse, spy } from "./helpers.js";

/**
 * ABI-decoding fixtures generated with Foundry's `cast abi-encode` (i.e. the
 * exact bytes a Solidity node would return), so the hand-rolled decoder is
 * checked against production encoding, not against itself.
 *
 * 2026-09-02: the embedded zcashAddress string bytes were spliced (same
 * 35-byte length, offsets unchanged) to the checksum-valid generated test
 * vector t1Le9mTDaqQUX1ANKaeDchpJsxEY4h5LQCX — the old fixture address
 * failed real Base58Check validation.
 */

// f((address,address,bytes32,address,uint256,(uint24,uint64,bool),uint8,string,uint64,bool))
// values: owner 0x99…, adapter 0x88…, poolKey 0x1f2e…171f, token USDC-Base,
// shares 10000000000, params (800, 43200, true), rewardPref 1,
// "t1Le9mTDaqQUX1ANKaeDchpJsxEY4h5LQCX", createdAt 1722900000, active true
const POS_FIXTURE =
  "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000999999999999999999999999999999999999999900000000000000000000000088888888888888888888888888888888888888881f2e3d4c5b6a79880102030405060708090a0b0c0d0e0f10111213141516171f000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda0291300000000000000000000000000000000000000000000000000000002540be4000000000000000000000000000000000000000000000000000000000000000320000000000000000000000000000000000000000000000000000000000000a8c00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000001800000000000000000000000000000000000000000000000000000000066b15e200000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002374314c65396d5444617151555831414e4b6165446368704a737845593468354c5143580000000000000000000000000000000000000000000000000000000000";

// f(address[],uint256[]) — [USDC-Base, AERO], [250000000, 5e18]
const REWARDS_FIXTURE =
  "0x000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000002000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000940181a94a35a4569e4529a3cdfb74e38fd986310000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000ee6b2800000000000000000000000000000000000000000000000004563918244f40000";

const BOOL_TRUE = "0x0000000000000000000000000000000000000000000000000000000000000001";

const VAULT = "0x4444444444444444444444444444444444444444" as const;
const ADAPTER = "0x8888888888888888888888888888888888888888" as const;

function rpcWith(result: string) {
  return spy(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    return jsonResponse({ jsonrpc: "2.0", id: body.id, result });
  });
}

describe("RpcReadOnlyChainService", () => {
  it("decodes getPosition including nested params and dynamic string", async () => {
    const fetchImpl = rpcWith(POS_FIXTURE);
    const svc = new RpcReadOnlyChainService(
      "https://rpc.example",
      VAULT,
      fetchImpl as unknown as typeof fetch
    );

    const p = await svc.getPosition(7n);

    assert.equal(p.owner, "0x9999999999999999999999999999999999999999");
    assert.equal(p.adapter, "0x8888888888888888888888888888888888888888");
    assert.equal(
      p.poolKey,
      "0x1f2e3d4c5b6a79880102030405060708090a0b0c0d0e0f10111213141516171f"
    );
    assert.equal(p.token, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    assert.equal(p.shares, 10_000_000_000n);
    assert.deepEqual(p.params, {
      rangeWidthBps: 800,
      rebalanceDelay: 43_200,
      autoCompound: true,
    });
    assert.equal(p.rewardPref, 1);
    assert.equal(p.zcashAddress, "t1Le9mTDaqQUX1ANKaeDchpJsxEY4h5LQCX");
    assert.equal(p.createdAt, 1_722_900_000n);
    assert.equal(p.active, true);

    // Correct call target + selector-prefixed calldata.
    const [, init] = fetchImpl.calls[0] as unknown as [string, RequestInit];
    const req = JSON.parse(init.body as string);
    assert.equal(req.method, "eth_call");
    assert.equal(req.params[0].to, VAULT);
    assert.match(req.params[0].data, /^0x[0-9a-f]{8}0{63}7$/); // selector + uint256(7)
  });

  it("decodes pendingRewards token/amount arrays", async () => {
    const svc = new RpcReadOnlyChainService(
      "https://rpc.example",
      VAULT,
      rpcWith(REWARDS_FIXTURE) as unknown as typeof fetch
    );

    const { tokens, amounts } = await svc.getPendingRewards(ADAPTER, 7n);

    assert.deepEqual(tokens, [
      "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      "0x940181a94a35a4569e4529a3cdfb74e38fd98631",
    ]);
    assert.deepEqual(amounts, [250_000_000n, 5_000_000_000_000_000_000n]);
  });

  it("decodes inRange bool", async () => {
    const svc = new RpcReadOnlyChainService(
      "https://rpc.example",
      VAULT,
      rpcWith(BOOL_TRUE) as unknown as typeof fetch
    );
    assert.equal(await svc.isInRange(ADAPTER, 7n), true);
  });

  it("surfaces RPC errors with context", async () => {
    const fetchImpl = spy(async () =>
      jsonResponse({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } })
    );
    const svc = new RpcReadOnlyChainService(
      "https://rpc.example",
      VAULT,
      fetchImpl as unknown as typeof fetch
    );
    await assert.rejects(svc.isInRange(ADAPTER, 1n), /execution reverted/);
  });

  it("refuses writes with an instructive error", async () => {
    const svc = new RpcReadOnlyChainService("https://rpc.example", VAULT);
    await assert.rejects(svc.compound(), /viem/);
    await assert.rejects(svc.routeToZcash(), /viem/);
  });
});
