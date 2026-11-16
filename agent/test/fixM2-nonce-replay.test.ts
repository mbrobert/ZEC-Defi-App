import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, getAddress, keccak256, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { HF_LADDER } from "@zyo/shared";
import { GRANT_SELECTORS } from "../src/abi/oilskin.js";
import { KeeperDispatcher } from "../src/dispatch/keeperDispatcher.js";
import type { DispatchRecord } from "../src/store/keeperStore.js";
import { evaluateSnapshot } from "../src/engine/valuation.js";
import { Logger, memorySink } from "../src/log.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import type { Address } from "../src/types/evm.js";
import { ACCOUNT_A, CBBTC, USDC, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";

/**
 * Audit M-2 (Medium): the pre-send nonce was persisted but never used, and the send was not pinned to it.
 * A send that went out while its record stayed PENDING (a DeadlineError, a watchdog-aborted tick) was
 * re-dispatched on resume; with the first transaction still unmined the world looked untouched and a second
 * full-size execAsKeeper went out under the NEXT nonce — both would land: a double unwind.
 *
 * The rig puts a mempool in front of the mock chain: a send is held unmined until `mine()`, a send under a
 * nonce already in the pool replaces it, `pending` counts the pool, `latest` does not.
 */

const KEY = ("0x" + "42".repeat(32)) as Hex;
const ROUTER = getAddress("0x2000000000000000000000000000000000000001") as Address;
const LP_VENUE = getAddress("0x2000000000000000000000000000000000000002") as Address;
const KEEPER = privateKeyToAccount(KEY).address;
const POOL = ("0x" + "aa".repeat(32)) as Hex;
const RECIPIENT = ("0x" + "22".repeat(32)) as Hex;
const CFG = { deadlineMs: 1_000, bandToleranceBps: 100, bandMaxToleranceBps: 500, txDeadlineS: 120, priceMaxAgeS: 3 * 3600, oracleDeviationBps: 300, hfToleranceBps: 100, swapMaxSlippageBps: 100, maxValueProbes: 24, grantExpiryWarnS: 7 * 86_400 };

function record(action: string, rung: string, hf: number, over: Partial<DispatchRecord> = {}): DispatchRecord {
  const now = "2026-09-06T00:00:00.000Z";
  return { key: `${ACCOUNT_A.toLowerCase()}:1:1:${action}`, account: ACCOUNT_A.toLowerCase() as Address, episode: 1, seq: 1, action, rung, hf, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now, ...over };
}

async function rig(opts: { hf?: number; burn?: boolean } = {}) {
  const chain = newMockChain();
  if (!opts.burn) cbBtcPosition(chain, ACCOUNT_A, debtForHf(opts.hf ?? 1.15));
  const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
  oil.install([ACCOUNT_A]);
  oil.poolPrices.set(POOL, 10n ** 30n);
  oil.setPositions(ACCOUNT_A, [1n, 2n, 3n, 4n].map((id) => ({ id, poolId: POOL })));
  for (const id of [1n, 2n, 3n, 4n]) oil.setCloseYield(id, 12_000_000_000n);
  if (opts.burn) {
    oil.solanaRecipients.set(ACCOUNT_A.toLowerCase(), RECIPIENT);
    oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"]);
  } else {
    oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);
  }

  // The mempool.
  const execute = chain.onSendRawTransaction!;
  const pool = new Map<number, Hex>();
  const broadcasts: number[] = [];
  const faults = { pendingReads: 0, latestReads: 0 };
  const latest = () => chain.txCount.get(KEEPER.toLowerCase()) ?? 0;
  const pending = () => {
    let n = latest();
    while (pool.has(n)) n += 1;
    return n;
  };
  const orig = chain.request.bind(chain);
  chain.request = async (args: { method: string; params?: unknown }) => {
    const p = (args.params ?? []) as unknown[];
    if (args.method === "eth_getTransactionCount" && String(p[0]).toLowerCase() === KEEPER.toLowerCase()) {
      const tag = String(p[1] ?? "latest");
      if (tag === "pending") {
        if (faults.pendingReads > 0) {
          faults.pendingReads -= 1;
          throw new Error("mock: pending nonce read failed");
        }
        return `0x${pending().toString(16)}`;
      }
      if (faults.latestReads > 0) {
        faults.latestReads -= 1;
        throw new Error("mock: latest nonce read failed");
      }
      return `0x${latest().toString(16)}`;
    }
    if (args.method === "eth_sendRawTransaction") {
      const raw = p[0] as Hex;
      const nonce = parseTransaction(raw).nonce ?? 0;
      if (nonce < latest()) throw new Error(`nonce too low: ${nonce} < ${latest()}`);
      broadcasts.push(nonce);
      pool.set(nonce, raw); // same nonce: a replacement — only one of the two can ever land
      return keccak256(raw);
    }
    return orig(args as never);
  };
  const mine = async () => {
    for (let n = latest(); pool.has(n); n = latest()) {
      const raw = pool.get(n)!;
      pool.delete(n);
      await execute(raw);
    }
  };

  const client = chain.publicClient();
  const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: base, transport: chain.transport() });
  const reader = new AaveReader(client, aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 1_000 });
  const sink = memorySink();
  const dispatcher = new KeeperDispatcher({ client, wallet, keeper: KEEPER, router: ROUTER, lpVenue: LP_VENUE, usdc: USDC, reader, ladder: HF_LADDER, log: new Logger(sink.sink, "debug"), config: CFG, now: () => new Date(Number(chain.nowS) * 1000) });
  const valuation = async () => {
    const ctx = await reader.readReserveContexts();
    const snap = await reader.readAccount(ACCOUNT_A, ctx, chain.blockNumber);
    const v = evaluateSnapshot(snap, { nowS: chain.nowS, ...CFG });
    if (v.kind !== "OK") throw new Error(`expected OK, got ${v.kind}`);
    return v;
  };
  const landed = () => oil.executed.filter((e) => e.mutate).length;
  return { chain, oil, dispatcher, valuation, pool, broadcasts, faults, latest, mine, landed };
}

describe("FIX M-2: a replay never goes out under a second nonce while the first send may still land", () => {
  it("FIX M-2: first send unmined, record still PENDING — the replay broadcasts nothing and only one execAsKeeper ever lands", async () => {
    const r = await rig();
    const rec = record("repay", "repay", 1.15);
    const pre: { nonce?: number }[] = [];
    const first = await r.dispatcher.dispatch({ record: rec, valuation: await r.valuation(), persistBeforeSend: async (i) => void pre.push(i) });
    assert.equal(first.status, "SENT", JSON.stringify(first));
    assert.equal(pre[0].nonce, 0);
    assert.deepEqual(r.broadcasts, [0], "the first send went out under the persisted nonce");
    assert.equal(r.landed(), 0, "and is still unmined");

    // The record never reached SENT; resume re-dispatches it.
    const replay = await r.dispatcher.dispatch({ record: { ...rec, sentNonce: pre[0].nonce }, valuation: null });
    assert.notEqual(replay.status, "SENT", `the replay must wait for nonce 0, not send: ${JSON.stringify(replay)}`);
    assert.deepEqual(r.broadcasts, [0], "nothing under nonce 1");

    await r.mine();
    assert.equal(r.landed(), 1, "one unwind, not two");
  });

  it("FIX M-2: the persisted nonce already consumed (the first send mined) — the replay re-reads the world and is sized by it", async () => {
    const r = await rig();
    const rec = record("repay", "repay", 1.15);
    const pre: { nonce?: number }[] = [];
    const first = await r.dispatcher.dispatch({ record: rec, valuation: await r.valuation(), persistBeforeSend: async (i) => void pre.push(i) });
    assert.equal(first.status, "SENT");
    await r.mine();
    assert.equal(r.landed(), 1);
    const replay = await r.dispatcher.dispatch({ record: { ...rec, sentNonce: pre[0].nonce }, valuation: null });
    assert.equal(replay.status, "SUPERSEDED", `the mined unwind cleared the rung: ${JSON.stringify(replay)}`);
    assert.deepEqual(r.broadcasts, [0]);
  });

  it("FIX M-2: the persisted nonce consumed by something else, the world untouched — the replay acts, pinned to the fresh nonce it persists", async () => {
    const r = await rig();
    r.chain.txCount.set(KEEPER.toLowerCase(), 3); // nonces 0..2 mined by other dispatches
    const pre: { nonce?: number }[] = [];
    const replay = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15, { sentNonce: 1 }), valuation: null, persistBeforeSend: async (i) => void pre.push(i) });
    assert.equal(replay.status, "SENT", JSON.stringify(replay));
    assert.equal(pre[0].nonce, 3);
    assert.deepEqual(r.broadcasts, [3], "the send carries exactly the nonce that was persisted");
  });

  it("FIX M-2: the persisted nonce never reached the node (pending == sentNonce) — the replay goes out pinned at that nonce, so a late first send can only collide with it", async () => {
    const r = await rig();
    r.chain.txCount.set(KEEPER.toLowerCase(), 5);
    const replay = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15, { sentNonce: 5 }), valuation: null });
    assert.equal(replay.status, "SENT", JSON.stringify(replay));
    assert.deepEqual(r.broadcasts, [5]);
  });

  it("FIX M-2: a failed pending-nonce read fails closed — nothing persisted, nothing broadcast", async () => {
    const r = await rig();
    r.faults.pendingReads = 1;
    const pre: unknown[] = [];
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation(), persistBeforeSend: async (i) => void pre.push(i) });
    assert.equal(res.status, "FAILED", JSON.stringify(res));
    assert.equal(pre.length, 0);
    assert.deepEqual(r.broadcasts, []);
  });

  it("FIX M-2: a persisted nonce whose fate cannot be read (latest read fails) fails closed — nothing broadcast", async () => {
    const r = await rig();
    r.faults.latestReads = 1;
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15, { sentNonce: 0 }), valuation: null });
    assert.equal(res.status, "FAILED", JSON.stringify(res));
    assert.deepEqual(r.broadcasts, []);
  });

  it("FIX M-2: the cross-chain burn — first burn unmined, the replay burns nothing more", async () => {
    const r = await rig({ burn: true });
    r.oil.defaultCloseYield = { usdc: 2_000_000_000n, other: 0n };
    const rec = record("burn-emergency", "emergency", 1.1);
    const intent = { record: rec, usdcNeeded: 3_000_000_000n, expectedRecipient: RECIPIENT, collateralAssetForProbe: CBBTC, maxFeeBps: 2, minFinalityThreshold: 1000 };
    const pre: { nonce?: number }[] = [];
    const first = await r.dispatcher.dispatchBurn({ ...intent, persistBeforeSend: async (i) => void pre.push(i) });
    assert.equal(first.status, "SENT", JSON.stringify(first));
    assert.deepEqual(r.broadcasts, [0]);
    const replay = await r.dispatcher.dispatchBurn({ ...intent, record: { ...rec, sentNonce: pre[0].nonce } });
    assert.notEqual(replay.status, "SENT", JSON.stringify(replay));
    assert.deepEqual(r.broadcasts, [0]);
    await r.mine();
    assert.equal(r.landed(), 1);
  });
});
