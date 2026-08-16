import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INTENTS_ASSET_IDS } from "@zyo/shared";
import { RewardExecutor, type RewardContext } from "../src/executors/rewardExecutor.js";
import type { ChainService, OnchainPosition } from "../src/services/chain.js";
import type { OneClickClient, QuoteRequest, QuoteResponse } from "../src/services/oneClick.js";
import { spy } from "./helpers.js";

const ZADDR = "t1KrbA8XLcmZUsSdcXhkpKUWX5rMctSH5dP";
const DEPOSIT = "0x2222222222222222222222222222222222222222";

const policy = {
  minCostMultiple: 3,
  minAbsoluteUsd: 5,
  maxHoldDays: 30,
  slippageToleranceBps: 100,
  quoteDeadlineMinutes: 15,
};

function makePosition(rewardPref: 0 | 1): OnchainPosition {
  return {
    owner: "0x9999999999999999999999999999999999999999",
    adapter: "0x8888888888888888888888888888888888888888",
    poolKey: "0x1f2e3d4c5b6a79880102030405060708090a0b0c0d0e0f10111213141516171f",
    token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    shares: 10_000_000_000n,
    params: { rangeWidthBps: 800, rebalanceDelay: 43_200, autoCompound: true },
    rewardPref,
    zcashAddress: rewardPref === 1 ? ZADDR : "",
    createdAt: 0n,
    active: true,
  };
}

function makeCtx(rewardPref: 0 | 1, over: Partial<RewardContext> = {}): RewardContext {
  return {
    positionId: 1n,
    position: makePosition(rewardPref),
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

function makeChain() {
  const compound = spy(async (_id: bigint) => "0xc0mp" as `0x${string}`);
  const routeToZcash = spy(
    async (_id: bigint, _dep: `0x${string}`, _qh: `0x${string}`) => "0xr0ute" as `0x${string}`
  );
  return {
    service: { compound, routeToZcash } as unknown as ChainService,
    compound,
    routeToZcash,
  };
}

function makeOneClick(mutate?: (req: QuoteRequest) => QuoteRequest) {
  const getQuote = spy(async (req: QuoteRequest): Promise<QuoteResponse> => {
    const echoed = mutate ? mutate(structuredClone(req)) : req;
    return {
      quoteRequest: echoed,
      quote: {
        depositAddress: DEPOSIT,
        amountIn: req.amount,
        amountOut: "512345678",
        minAmountOut: "500000000",
        amountOutUsd: "99.5",
      },
    };
  });
  const submitDepositTx = spy(async (_dep: string, _tx: string) => undefined);
  return {
    client: { getQuote, submitDepositTx } as unknown as OneClickClient,
    getQuote,
    submitDepositTx,
  };
}

describe("RewardExecutor", () => {
  it("waits when decision engine says costs not cleared", async () => {
    const chain = makeChain();
    const exec = new RewardExecutor(chain.service, makeOneClick().client, policy);
    const out = await exec.execute(makeCtx(0, { accruedUsd: 2 }));
    assert.equal(out.kind, "WAITED");
    assert.equal(chain.compound.calls.length, 0);
  });

  it("compounds for COMPOUND preference without touching 1-Click", async () => {
    const chain = makeChain();
    const oneClick = makeOneClick();
    const exec = new RewardExecutor(chain.service, oneClick.client, policy);

    const out = await exec.execute(makeCtx(0));

    assert.deepEqual(out, { kind: "COMPOUNDED", txHash: "0xc0mp" });
    assert.equal(oneClick.getQuote.calls.length, 0);
  });

  it("ignores bridge fee for compound but counts it for zcash routes", async () => {
    const chain = makeChain();
    const exec = new RewardExecutor(chain.service, makeOneClick().client, policy);
    // accrued 8: compound costs 1 → 3x=3 OK; zcash costs 3 → 3x=9 → WAIT
    const compoundOut = await exec.execute(makeCtx(0, { accruedUsd: 8 }));
    assert.equal(compoundOut.kind, "COMPOUNDED");

    const zcashOut = await exec.execute(makeCtx(1, { accruedUsd: 8 }));
    assert.equal(zcashOut.kind, "WAITED");
  });

  it("routes to zcash: quote → verify → on-chain transfer → submit tx", async () => {
    const chain = makeChain();
    const oneClick = makeOneClick();
    const exec = new RewardExecutor(chain.service, oneClick.client, policy);

    const out = await exec.execute(makeCtx(1));

    assert.equal(out.kind, "ROUTED_TO_ZCASH");
    if (out.kind !== "ROUTED_TO_ZCASH") return;
    assert.equal(out.depositAddress, DEPOSIT);
    assert.equal(out.expectedZecOut, "512345678");

    // Quote request was built correctly.
    const req = oneClick.getQuote.calls[0][0];
    assert.equal(req.destinationAsset, INTENTS_ASSET_IDS.ZEC);
    assert.equal(req.recipient, ZADDR);
    assert.equal(req.recipientType, "DESTINATION_CHAIN");
    assert.equal(req.amount, "100000000");

    // On-chain call used the quoted deposit address + bound hash.
    assert.deepEqual(chain.routeToZcash.calls[0], [1n, DEPOSIT, out.quoteHash]);
    assert.deepEqual(oneClick.submitDepositTx.calls[0], [DEPOSIT, "0xr0ute"]);
  });

  it("REFUSES to route when quote recipient != stored zcash address", async () => {
    const chain = makeChain();
    const evil = makeOneClick((req) => ({
      ...req,
      recipient: "t1AttackerAAAAAAAAAAAAAAAAAAAAAAAAA",
    }));
    const exec = new RewardExecutor(chain.service, evil.client, policy);

    await assert.rejects(exec.execute(makeCtx(1)), /recipient/);
    assert.equal(chain.routeToZcash.calls.length, 0);
  });

  it("REFUSES to route when the quote output value is far below what we send in", async () => {
    // A tampered/mispriced quote that would route ~$100 of USDC for ~$1 of ZEC.
    const chain = makeChain();
    const evil = makeOneClick();
    (evil.getQuote as unknown as { impl?: unknown }); // keep type shape
    const raw = evil.getQuote;
    const wrapped = spy(async (req: QuoteRequest) => {
      const q = await raw(req);
      q.quote.amountOutUsd = "1.00"; // floor is 95 → reject
      q.quote.minAmountOut = "5000000";
      return q;
    });
    const exec = new RewardExecutor(
      chain.service,
      { getQuote: wrapped, submitDepositTx: spy(async () => undefined) } as unknown as OneClickClient,
      policy
    );

    await assert.rejects(exec.execute(makeCtx(1)), /below floor/);
    assert.equal(chain.routeToZcash.calls.length, 0);
  });

  it("REFUSES to route when the quote has no positive minAmountOut floor", async () => {
    const chain = makeChain();
    const raw = makeOneClick().getQuote;
    const wrapped = spy(async (req: QuoteRequest) => {
      const q = await raw(req);
      q.quote.minAmountOut = "0";
      return q;
    });
    const exec = new RewardExecutor(
      chain.service,
      { getQuote: wrapped, submitDepositTx: spy(async () => undefined) } as unknown as OneClickClient,
      policy
    );

    await assert.rejects(exec.execute(makeCtx(1)), /minAmountOut/);
    assert.equal(chain.routeToZcash.calls.length, 0);
  });

  it("REFUSES to route when destination asset is not native ZEC", async () => {
    const chain = makeChain();
    const evil = makeOneClick((req) => ({
      ...req,
      destinationAsset: INTENTS_ASSET_IDS.USDC_NEAR,
    }));
    const exec = new RewardExecutor(chain.service, evil.client, policy);

    await assert.rejects(exec.execute(makeCtx(1)), /not native ZEC/);
    assert.equal(chain.routeToZcash.calls.length, 0);
  });

  it("REFUSES malformed deposit addresses", async () => {
    const chain = makeChain();
    const getQuote = spy(async (req: QuoteRequest) => ({
      quoteRequest: req,
      quote: { depositAddress: "not-an-evm-address", amountIn: "1", amountOut: "1" },
    }));
    const oneClick = { getQuote, submitDepositTx: spy(async () => undefined) };
    const exec = new RewardExecutor(
      chain.service,
      oneClick as unknown as OneClickClient,
      policy
    );

    await assert.rejects(exec.execute(makeCtx(1)), /deposit address invalid/);
    assert.equal(chain.routeToZcash.calls.length, 0);
  });

  // Shielded recipients: the bridge rejects u1…/zs1… with a generic
  // "recipient is not valid" (probed live 2026-08-08). We must fail fast with a
  // legible reason BEFORE burning a quote — rewards stay accrued and retry.
  for (const [label, addr] of [
    ["unified", "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkyy00c7qqfqfqhqvxr0pmw6snjrg"],
    ["sapling", "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly"],
    ["garbage", "not-an-address"],
  ] as const) {
    it(`refuses to quote a ${label} recipient the bridge cannot settle`, async () => {
      const chain = makeChain();
      const oneClick = makeOneClick();
      const exec = new RewardExecutor(chain.service, oneClick.client, policy);
      const ctx = makeCtx(1);
      ctx.position = { ...ctx.position, zcashAddress: addr };

      await assert.rejects(() => exec.execute(ctx), /cannot settle to/);
      // no quote requested, no funds moved
      assert.equal(oneClick.getQuote.calls.length, 0);
      assert.equal(chain.routeToZcash.calls.length, 0);
    });
  }

  it("accepts a transparent (t3 P2SH) recipient", async () => {
    const chain = makeChain();
    const oneClick = makeOneClick();
    const exec = new RewardExecutor(chain.service, oneClick.client, policy);
    const ctx = makeCtx(1);
    // makeOneClick echoes the request, so invariant #1 (recipient match) holds.
    ctx.position = { ...ctx.position, zcashAddress: "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd" };

    const out = await exec.execute(ctx);
    assert.equal(out.kind, "ROUTED_TO_ZCASH");
  });

  it("still succeeds when deposit/submit nudge fails (solver auto-detects)", async () => {
    const chain = makeChain();
    const oneClick = makeOneClick();
    let first = true;
    const failingSubmit = spy(async () => {
      if (first) {
        first = false;
        throw new Error("503");
      }
    });
    const client = {
      getQuote: oneClick.getQuote,
      submitDepositTx: failingSubmit,
    } as unknown as OneClickClient;
    const exec = new RewardExecutor(chain.service, client, policy);

    const out = await exec.execute(makeCtx(1));
    assert.equal(out.kind, "ROUTED_TO_ZCASH");
  });
});
