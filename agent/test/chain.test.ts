import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AAVE_V3, AAVE_V3_RESERVES, BASE_TOKENS, CHAINLINK_FEEDS } from "@zyo/shared";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import { AccountDiscovery } from "../src/services/discovery.js";
import { DeadlineError } from "../src/services/deadline.js";
import { evaluateSnapshot } from "../src/engine/valuation.js";
import { accountCreatedEvent } from "../src/abi/oilskin.js";
import { MAX_UINT256 } from "../src/types/evm.js";
import { ACCOUNT_A, ACCOUNT_B, CBBTC, FACTORY, OWNER_A, OWNER_B, USDC, WETH, cbBtcPosition, newMockChain } from "./fixtures.js";

const PARAMS = { priceMaxAgeS: 3 * 3600, oracleDeviationBps: 300, hfToleranceBps: 100 };

function reader(chain = newMockChain(), deadlineMs = 500) {
  const progress = { n: 0 };
  const r = new AaveReader(chain.publicClient(), aaveAddressesFromShared(), reserveSpecsFromShared(), {
    deadlineMs,
    onProgress: () => progress.n++,
  });
  return { chain, r, progress };
}

describe("reserve specs from shared", () => {
  it("covers every Aave reserve with the right token address, decimals and an independent feed", () => {
    const specs = reserveSpecsFromShared();
    assert.deepEqual(specs.map((s) => s.symbol), [...AAVE_V3_RESERVES]);
    for (const s of specs) {
      assert.equal(s.asset, BASE_TOKENS[s.symbol].address);
      assert.equal(s.decimals, BASE_TOKENS[s.symbol].decimals);
      assert.ok(s.feed, `${s.symbol} must have a Chainlink feed`);
    }
    const bySym = Object.fromEntries(specs.map((s) => [s.symbol, s.feed]));
    assert.equal(bySym.cbBTC, CHAINLINK_FEEDS.cbBTC_USD.address);
    assert.equal(bySym.WETH, CHAINLINK_FEEDS.ETH_USD.address);
    assert.equal(bySym.USDC, CHAINLINK_FEEDS.USDC_USD.address);
    assert.deepEqual(aaveAddressesFromShared(), { pool: AAVE_V3.pool, dataProvider: AAVE_V3.poolDataProvider, oracle: AAVE_V3.oracle });
  });
});

describe("AaveReader — reads against real ABI encoding", () => {
  it("reads chain id, block number, reserve contexts and an account snapshot; valuation is OK", async () => {
    const { chain, r, progress } = reader();
    cbBtcPosition(chain, ACCOUNT_A, 30_000);
    assert.equal(await r.chainId(), 8453);
    assert.equal(await r.blockNumber(), 1000n);
    const ctx = await r.readReserveContexts();
    for (const sym of AAVE_V3_RESERVES) {
      const c = ctx.get(sym)!;
      assert.ok(c.ok, `${sym}: ${c.ok ? "" : c.reason}`);
      if (c.ok) assert.ok(c.ctx.chainlink);
    }
    const cb = ctx.get("cbBTC")!;
    assert.equal(cb.ok ? cb.ctx.liquidationThresholdBps : null, 7800n);
    const snap = await r.readAccount(ACCOUNT_A, ctx, 1000n);
    assert.equal(snap.unreadableReserves.length, 0);
    assert.equal(snap.totalDebtBase, 30_000n * 100_000_000n);
    const v = evaluateSnapshot(snap, { nowS: chain.nowS, ...PARAMS });
    assert.equal(v.kind, "OK");
    if (v.kind === "OK") assert.ok(Math.abs(v.hf - (79_600 * 0.78) / 30_000) < 1e-6);
    assert.ok(progress.n >= 2 + 12 + 4, `progress ${progress.n}`);
  });

  it("empty account → NO_DEBT with MAX_UINT HF straight from the pool", async () => {
    const { chain, r } = reader();
    const ctx = await r.readReserveContexts();
    const snap = await r.readAccount(ACCOUNT_B, ctx, 1n);
    assert.equal(snap.healthFactorWad, MAX_UINT256);
    assert.equal(evaluateSnapshot(snap, { nowS: chain.nowS, ...PARAMS }).kind, "NO_DEBT");
  });

  it("a hanging RPC hits the deadline and becomes an unreadable reserve → UNKNOWN (never HEALTHY)", async () => {
    const { chain, r } = reader(newMockChain(), 60);
    cbBtcPosition(chain, ACCOUNT_A, 30_000);
    chain.faults.set(`getUserReserveData(USDC,${ACCOUNT_A.toLowerCase()})`, { kind: "hang" });
    const ctx = await r.readReserveContexts();
    const snap = await r.readAccount(ACCOUNT_A, ctx, 1n);
    assert.equal(snap.unreadableReserves.length, 1);
    assert.match(snap.unreadableReserves[0].reason, /DeadlineError/);
    assert.equal(evaluateSnapshot(snap, { nowS: chain.nowS, ...PARAMS }).kind, "UNKNOWN");
  });

  it("a hanging pool-level read throws (nothing to value) with the deadline error", async () => {
    const { chain, r } = reader(newMockChain(), 60);
    chain.faults.set(`getUserAccountData(${ACCOUNT_A.toLowerCase()})`, { kind: "hang" });
    const ctx = await r.readReserveContexts();
    await assert.rejects(r.readAccount(ACCOUNT_A, ctx, 1n), DeadlineError);
  });

  it("a reverting / garbage reserve context is recorded per asset, other assets still read", async () => {
    const { chain, r } = reader();
    chain.faults.set("getAssetPrice(WETH)", { kind: "revert", message: "oracle down" });
    chain.faults.set("latestRoundData(USDC)", { kind: "garbage" });
    const ctx = await r.readReserveContexts();
    assert.equal(ctx.get("cbBTC")!.ok, true);
    assert.equal(ctx.get("WETH")!.ok, false);
    assert.equal(ctx.get("USDC")!.ok, false);
    // Account with exposure only in cbBTC + USDC: USDC context missing ⇒ unreadable ⇒ UNKNOWN.
    cbBtcPosition(chain, ACCOUNT_A, 1_000);
    const snap = await r.readAccount(ACCOUNT_A, ctx, 1n);
    assert.deepEqual(snap.unreadableReserves.map((u) => u.symbol), ["USDC"]);
    assert.equal(evaluateSnapshot(snap, { nowS: chain.nowS, ...PARAMS }).kind, "UNKNOWN");
  });

  it("a broken context for a reserve with NO exposure does not poison the account", async () => {
    const { chain, r } = reader();
    chain.faults.set("getReserveConfigurationData(WETH)", { kind: "revert" });
    cbBtcPosition(chain, ACCOUNT_A, 1_000);
    const ctx = await r.readReserveContexts();
    const snap = await r.readAccount(ACCOUNT_A, ctx, 1n);
    assert.equal(snap.unreadableReserves.length, 0);
    assert.equal(evaluateSnapshot(snap, { nowS: chain.nowS, ...PARAMS }).kind, "OK");
  });

  it("reserve decimals that disagree with shared, or an inactive reserve, make the context unreadable", async () => {
    const { chain, r } = reader();
    chain.reserves.get(WETH.toLowerCase())!.decimals = 6;
    chain.reserves.get(CBBTC.toLowerCase())!.isActive = false;
    const ctx = await r.readReserveContexts();
    assert.match((ctx.get("WETH") as { reason: string }).reason, /decimals 6 ≠ expected 18/);
    assert.match((ctx.get("cbBTC") as { reason: string }).reason, /not active/);
  });

  it("the audited bug end-to-end: Aave price 0 on the debt asset ⇒ UNKNOWN through the real reader", async () => {
    const { chain, r } = reader();
    cbBtcPosition(chain, ACCOUNT_A, 9_500);
    chain.reserves.get(USDC.toLowerCase())!.aavePrice = 0n;
    const ctx = await r.readReserveContexts();
    const snap = await r.readAccount(ACCOUNT_A, ctx, 1n);
    // The pool (mock, Aave-style) now reports NO debt and HF = ∞…
    assert.equal(snap.totalDebtBase, 0n);
    assert.equal(snap.healthFactorWad, MAX_UINT256);
    // …and the keeper still refuses to call it healthy.
    const v = evaluateSnapshot(snap, { nowS: chain.nowS, ...PARAMS });
    assert.equal(v.kind, "UNKNOWN");
  });

  it("the tick signal aborts in-flight reads", async () => {
    const { chain, r } = reader(newMockChain(), 5_000);
    chain.faults.set("eth_blockNumber", { kind: "hang" });
    const c = new AbortController();
    const p = r.blockNumber(c.signal);
    setTimeout(() => c.abort(new Error("watchdog")), 10);
    await assert.rejects(p, /aborted/);
  });
});

describe("AccountDiscovery", () => {
  it("scans in windows from the cursor, decodes AccountCreated, calls back per window with the last block", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 10n);
    chain.emitAccountCreated(OWNER_B, ACCOUNT_B, 25n);
    const d = new AccountDiscovery(chain.publicClient(), {
      factory: FACTORY,
      event: accountCreatedEvent,
      argNames: { owner: "owner", account: "account" },
      chunkBlocks: 10,
      deadlineMs: 500,
    });
    const windows: { found: string[]; last: bigint }[] = [];
    const res = await d.scan(0n, 30n, async (found, last) => {
      windows.push({ found: found.map((f) => `${f.owner}>${f.account}@${f.blockNumber}`), last });
    });
    assert.equal(res.windows, 4);
    assert.equal(res.found, 2);
    assert.deepEqual(windows.map((w) => w.last), [9n, 19n, 29n, 30n]);
    assert.deepEqual(windows[1].found, [`${OWNER_A}>${ACCOUNT_A}@10`]);
    assert.deepEqual(windows[2].found, [`${OWNER_B}>${ACCOUNT_B}@25`]);
    assert.ok(chain.calls.every((c) => c.method !== "eth_getLogs" || /eth_getLogs\(\d+-\d+\)/.test(c.label)));
  });

  it("ignores logs from other contracts and foreign topics; a getLogs fault throws (cursor not advanced)", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 5n);
    chain.logs.push({ address: "0x9999999999999999999999999999999999999999", topics: chain.logs[0].topics, data: "0x", blockNumber: 6n, logIndex: 1 });
    chain.logs.push({ address: FACTORY, topics: ["0x" + "ee".repeat(32) as `0x${string}`], data: "0x", blockNumber: 7n, logIndex: 2 });
    const d = new AccountDiscovery(chain.publicClient(), {
      factory: FACTORY,
      event: accountCreatedEvent,
      argNames: { owner: "owner", account: "account" },
      chunkBlocks: 100,
      deadlineMs: 500,
    });
    let found = 0;
    await d.scan(0n, 10n, async (f) => void (found += f.length));
    assert.equal(found, 1);
    chain.faults.set("eth_getLogs(0-10)", { kind: "revert" });
    let called = false;
    await assert.rejects(d.scan(0n, 10n, async () => void (called = true)));
    assert.equal(called, false);
  });

  it("stops scanning when the signal aborts", async () => {
    const chain = newMockChain();
    const d = new AccountDiscovery(chain.publicClient(), {
      factory: FACTORY,
      event: accountCreatedEvent,
      argNames: { owner: "owner", account: "account" },
      chunkBlocks: 1,
      deadlineMs: 500,
    });
    const c = new AbortController();
    let windows = 0;
    await d.scan(
      0n,
      100n,
      async () => {
        windows++;
        if (windows === 3) c.abort();
      },
      c.signal
    );
    assert.equal(windows, 3);
  });
});
