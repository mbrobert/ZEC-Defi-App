import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INTENTS_ASSET_IDS, RHEA } from "@zyo/shared";
import { assessHealth } from "../src/engine/health.js";
import { decideReward } from "../src/engine/rewardDecision.js";
import { RpcReadOnlyChainService } from "../src/services/chain.js";
import { OneClickClient } from "../src/services/oneClick.js";
import { RewardExecutor, type RewardContext } from "../src/executors/rewardExecutor.js";
import type { ChainService, OnchainPosition } from "../src/services/chain.js";
import type { OneClickClient as OCC, QuoteRequest } from "../src/services/oneClick.js";
import { spy } from "./helpers.js";

const VAULT = "0x4444444444444444444444444444444444444444" as const;
const ADAPTER = "0x8888888888888888888888888888888888888888" as const;
const ZADDR = "t1KrbA8XLcmZUsSdcXhkpKUWX5rMctSH5dP";
const DEPOSIT = "0x2222222222222222222222222222222222222222";

// ---------------------------------------------------------------------------
// 1. RPC transport adversity: timeouts, HTTP errors, JSON-RPC errors, garbage,
//    truncated payloads, wrong-id responses. The read client must FAIL LOUD,
//    never silently return a wrong-but-plausible value.
// ---------------------------------------------------------------------------
describe("RpcReadOnlyChainService — hostile transport", () => {
  const mk = (impl: () => Promise<Response>) =>
    new RpcReadOnlyChainService(
      "https://rpc.example",
      VAULT,
      (spy(impl) as unknown) as typeof fetch
    );

  it("throws on HTTP 500", async () => {
    const s = mk(async () => new Response("bad gateway", { status: 500 }));
    await assert.rejects(s.isInRange(ADAPTER, 1n), /rpc http 500/);
  });

  it("throws on HTTP 429 (rate limit) rather than returning stale data", async () => {
    const s = mk(async () => new Response("slow down", { status: 429 }));
    await assert.rejects(s.isInRange(ADAPTER, 1n), /rpc http 429/);
  });

  it("throws on JSON-RPC error envelope", async () => {
    const s = mk(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "execution reverted" } }), {
        status: 200,
      })
    );
    await assert.rejects(s.isInRange(ADAPTER, 1n), /execution reverted/);
  });

  it("does not misread an empty result as a real position", async () => {
    // result "0x" → all fields decode to zero/empty; must not throw but must
    // yield an obviously-empty position (active=false), never a false active.
    const s = mk(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + "00".repeat(32) }), { status: 200 })
    );
    // getPosition on all-zero tuple offset → reads zeros; active must be false.
    const s2 = new RpcReadOnlyChainService(
      "https://rpc.example",
      VAULT,
      (spy(async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            // offset points at word 1 (0x20); tuple all zero → active=false
            result:
              "0x" + "0000000000000000000000000000000000000000000000000000000000000020" + "00".repeat(32 * 12),
          }),
          { status: 200 }
        )
      ) as unknown) as typeof fetch
    );
    const p = await s2.getPosition(1n);
    assert.equal(p.active, false);
    assert.equal(p.shares, 0n);
    void s;
  });

  it("surfaces malformed JSON instead of hanging", async () => {
    const s = mk(async () => new Response("{not json", { status: 200 }));
    await assert.rejects(s.isInRange(ADAPTER, 1n));
  });

  it("write methods stay disabled under all conditions (no key = no signing)", async () => {
    const s = mk(async () => new Response("{}", { status: 200 }));
    await assert.rejects(s.compound(), /viem/);
    await assert.rejects(s.routeToZcash(), /viem/);
  });
});

// ---------------------------------------------------------------------------
// 2. 1-Click API adversity: every failure the solver network can throw.
// ---------------------------------------------------------------------------
describe("OneClickClient — hostile API", () => {
  const mk = (impl: () => Promise<Response>) =>
    new OneClickClient({ baseUrl: "https://x.example", fetchImpl: (spy(impl) as unknown) as typeof fetch });

  const req: QuoteRequest = {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: INTENTS_ASSET_IDS.USDC_BASE,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: INTENTS_ASSET_IDS.ZEC,
    amount: "1000000",
    refundTo: "0x1111111111111111111111111111111111111111",
    refundType: "ORIGIN_CHAIN",
    recipient: ZADDR,
    recipientType: "DESTINATION_CHAIN",
    deadline: "2026-08-06T00:00:00.000Z",
  };

  for (const status of [400, 401, 403, 429, 500, 503]) {
    it(`getQuote throws typed error on HTTP ${status}`, async () => {
      const c = mk(async () => new Response(JSON.stringify({ error: "x" }), { status }));
      await assert.rejects(c.getQuote(req), (e: Error & { httpStatus?: number }) => {
        assert.equal(e.name, "OneClickError");
        assert.equal(e.httpStatus, status);
        return true;
      });
    });
  }

  it("status poller tolerates every documented state", async () => {
    for (const st of [
      "PENDING_DEPOSIT",
      "KNOWN_DEPOSIT_TX",
      "PROCESSING",
      "SUCCESS",
      "INCOMPLETE_DEPOSIT",
      "REFUNDED",
      "FAILED",
    ]) {
      const c = mk(async () => new Response(JSON.stringify({ status: st }), { status: 200 }));
      const r = await c.getStatus(DEPOSIT);
      assert.equal(r.status, st);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. MEV / malicious-quote resistance in the reward executor. The executor is
//    the ONLY place a swap-like action originates; it must refuse anything that
//    doesn't provably deliver ZEC to the user's own address.
// ---------------------------------------------------------------------------
describe("RewardExecutor — MEV / malicious-quote resistance", () => {
  const policy = {
    minCostMultiple: 3,
    minAbsoluteUsd: 5,
    maxHoldDays: 30,
    slippageToleranceBps: 100,
    quoteDeadlineMinutes: 15,
  };

  function position(): OnchainPosition {
    return {
      owner: "0x9999999999999999999999999999999999999999",
      adapter: ADAPTER,
      poolKey: "0x1f2e3d4c5b6a79880102030405060708090a0b0c0d0e0f10111213141516171f",
      token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      shares: 10_000_000_000n,
      params: { rangeWidthBps: 800, rebalanceDelay: 43_200, autoCompound: true },
      rewardPref: 1,
      zcashAddress: ZADDR,
      createdAt: 0n,
      active: true,
    };
  }
  function ctx(over: Partial<RewardContext> = {}): RewardContext {
    return {
      positionId: 1n,
      position: position(),
      accruedUsd: 100,
      gasUsd: 1,
      bridgeFeeUsd: 2,
      accrualAgeDays: 3,
      accruedAtomic: 100_000_000n,
      originAssetId: INTENTS_ASSET_IDS.USDC_BASE,
      refundAddress: "0x1111111111111111111111111111111111111111",
      ...over,
    };
  }
  const chain = () => {
    const compound = spy(async (_i: bigint) => "0xc0" as `0x${string}`);
    const route = spy(async (_i: bigint, _d: `0x${string}`, _q: `0x${string}`) => "0xr0" as `0x${string}`);
    return { svc: { compound, routeToZcash: route } as unknown as ChainService, compound, route };
  };
  const oc = (mutate?: (r: QuoteRequest) => QuoteRequest, deposit = DEPOSIT) => ({
    getQuote: spy(async (r: QuoteRequest) => ({
      quoteRequest: mutate ? mutate(structuredClone(r)) : r,
      quote: { depositAddress: deposit, amountIn: r.amount, amountOut: "5", minAmountOut: "5" },
    })),
    submitDepositTx: spy(async () => undefined),
  });

  // Attacker tampers the recipient the solver echoes → must refuse.
  it("refuses recipient swapped to attacker", async () => {
    const c = chain();
    const client = oc((r) => ({ ...r, recipient: "t1AttackerAAAAAAAAAAAAAAAAAAAAAAAAA" }));
    const ex = new RewardExecutor(c.svc, client as unknown as OCC, policy);
    await assert.rejects(ex.execute(ctx()), /recipient/);
    assert.equal(c.route.calls.length, 0);
  });

  // Destination asset swapped from ZEC to something else → must refuse.
  it("refuses destination asset that is not native ZEC", async () => {
    const c = chain();
    const client = oc((r) => ({ ...r, destinationAsset: INTENTS_ASSET_IDS.USDC_NEAR }));
    const ex = new RewardExecutor(c.svc, client as unknown as OCC, policy);
    await assert.rejects(ex.execute(ctx()), /native ZEC/);
    assert.equal(c.route.calls.length, 0);
  });

  // Deposit address that isn't a clean EVM address (poison payload) → refuse.
  for (const bad of ["0x", "0xZZZ", "notanaddr", "0x123", ""]) {
    it(`refuses malformed deposit address ${JSON.stringify(bad)}`, async () => {
      const c = chain();
      const ex = new RewardExecutor(c.svc, oc(undefined, bad) as unknown as OCC, policy);
      await assert.rejects(ex.execute(ctx()), /deposit address invalid/);
      assert.equal(c.route.calls.length, 0);
    });
  }

  // Griefing: solver deposit/submit nudge fails — must still complete (solver
  // auto-detects) and never double-send.
  it("completes when deposit/submit nudge fails, transfers exactly once", async () => {
    const c = chain();
    const client = oc();
    (client.submitDepositTx as ReturnType<typeof spy>) = spy(async () => {
      throw new Error("503");
    });
    const ex = new RewardExecutor(c.svc, client as unknown as OCC, policy);
    const out = await ex.execute(ctx());
    assert.equal(out.kind, "ROUTED_TO_ZCASH");
    assert.equal(c.route.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 4. Extreme price fluctuations: the health engine must classify correctly and
//    monotonically across the entire plausible ZEC price range, and the reward
//    engine must never claim at a loss no matter how gas/bridge spike.
// ---------------------------------------------------------------------------
describe("Extreme price & cost fluctuations", () => {
  const t = { warning: RHEA.healthFactor.warning, critical: RHEA.healthFactor.critical };

  it("health band is monotonic as HF sweeps 0.5 → 5.0", () => {
    let prevRank = -1;
    const rank = { CRITICAL: 0, WARNING: 1, HEALTHY: 2 } as const;
    let sawCritical = false;
    let sawHealthy = false;
    for (let hf = 0.5; hf <= 5.0; hf += 0.01) {
      const a = assessHealth("s", hf, t);
      const r = rank[a.band];
      // As HF increases, band rank must never decrease.
      assert.ok(r >= prevRank, `non-monotonic at HF=${hf.toFixed(2)}`);
      prevRank = r;
      if (a.band === "CRITICAL") sawCritical = true;
      if (a.band === "HEALTHY") sawHealthy = true;
    }
    assert.ok(sawCritical && sawHealthy, "range didn't cover both extremes");
  });

  it("emergency unwind only at the very bottom, never above critical", () => {
    for (let hf = 0.5; hf <= 3; hf += 0.01) {
      const a = assessHealth("s", hf, t);
      if (a.suggestedAction === "EMERGENCY_UNWIND") {
        assert.ok(hf <= 1.05 + 1e-9, `emergency too early at HF=${hf.toFixed(3)}`);
      }
    }
  });

  it("reward engine never claims at a net loss across a cost grid", () => {
    for (let accrued = 0; accrued <= 200; accrued += 7) {
      for (const gas of [0.1, 1, 5, 25, 100]) {
        for (const bridge of [0, 2, 10, 50]) {
          for (const age of [0, 10, 40]) {
            const d = decideReward({
              accruedUsd: accrued,
              gasUsd: gas,
              bridgeFeeUsd: bridge,
              minCostMultiple: 3,
              minAbsoluteUsd: 5,
              accrualAgeDays: age,
              maxHoldDays: 30,
            });
            if (d.action === "CLAIM") {
              assert.ok(d.netUsd > 0, `claimed at loss: accrued=${accrued} gas=${gas} bridge=${bridge}`);
            }
          }
        }
      }
    }
  });
});
