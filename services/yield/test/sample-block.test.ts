import assert from "node:assert/strict";
import { test } from "node:test";
import { AaveSource, blockTag, SEL_GET_INTEREST_RATE_DATA_BPS, SEL_GET_INTEREST_RATE_STRATEGY_ADDRESS, SEL_GET_PAUSED, SEL_GET_RESERVE_CONFIGURATION_DATA, SEL_GET_RESERVE_DATA } from "../src/sources/aave.js";
import { GaugeSource } from "../src/sources/gauges.js";
import { RpcClient } from "../src/sources/rpc.js";
import type { Address } from "../src/types.js";

/**
 * Slice M (2026-09-12): a sample pinned to a block is ONE read. Every `eth_call` the Aave and
 * gauge sources issue for it must carry that block's tag — the ledger read
 * (`scripts/ledger-read.sh <rpc> <block>`) and the demo snapshot are paired with the sample on the
 * strength of that — and without a block the sources still read at `latest`, as the live service
 * does. The fake endpoint below answers with well-formed words and RECORDS the tag of every call.
 */

const RAY = 10n ** 27n;
const word = (v: bigint) => v.toString(16).padStart(64, "0");
const addrWord = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const words = (...vs: bigint[]) => "0x" + vs.map(word).join("");

const STRATEGY = "0x86ab1c62a8bf868e1b3e1ab87d587aba6fbcbdc5";
const GAUGE = "0x6399ed6725cc163d019aa64ff55b22149d7179a8";
const POOL = "0x4e962bb3889bf030368f56810a9c96b83cb3e778" as Address;
/** The ledger block of 2026-09-12; its tag is DERIVED here, never typed. */
const BLOCK = 51_226_072;
const TAG = `0x${BLOCK.toString(16)}`;

interface Seen { method: string; tag: unknown; to?: string }

/** A fake JSON-RPC endpoint: decodes each request (single or batch), records its block tag, answers by selector / call order. */
function fakeEndpoint(): { fetchImpl: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let poolCallsInBatch = 0;
  const answer = (req: { method: string; params: unknown[] }): unknown => {
    if (req.method !== "eth_call") throw new Error(`unexpected ${req.method}`);
    const [call, tag] = req.params as [{ to: string; data: string }, unknown];
    seen.push({ method: req.method, tag, to: call.to });
    const sel = call.data.slice(0, 10);
    if (sel === SEL_GET_RESERVE_DATA) return words(0n, 0n, 10n ** 12n, 0n, 5n * 10n ** 11n, RAY / 100n, RAY / 20n, 0n, 0n, RAY, RAY, 1_789_241_491n);
    if (sel === SEL_GET_RESERVE_CONFIGURATION_DATA) return words(6n, 7500n, 7800n, 10500n, 1000n, 1n, 1n, 0n, 1n, 0n);
    if (sel === SEL_GET_PAUSED) return words(0n);
    if (sel === SEL_GET_INTEREST_RATE_STRATEGY_ADDRESS) return "0x" + addrWord(STRATEGY);
    if (sel === SEL_GET_INTEREST_RATE_DATA_BPS) return words(9000n, 0n, 470n, 1000n);
    // The gauge source: the voter's gauges(pool) lookup, then the five-call batch in a fixed order.
    if (call.to.toLowerCase() === "0x16613524e02ad97edfef371bc883f2f5d6c480a5") return "0x" + addrWord(GAUGE);
    if (call.to.toLowerCase() === GAUGE) {
      poolCallsInBatch = 0;
      return sel === seen.filter((s) => s.to?.toLowerCase() === GAUGE)[0]?.to ? words(1n) : words(seen.filter((s) => s.to?.toLowerCase() === GAUGE).length % 2 === 1 ? 7_140_520_125_989_201n : 1_789_603_200n);
    }
    if (call.to.toLowerCase() === POOL) {
      poolCallsInBatch += 1;
      if (poolCallsInBatch === 1) return words(23_621_847_466_826_436_891_048_482_815n, (1n << 24n) - 24_205n, 899n, 2048n, 2048n, 1n); // slot0
      if (poolCallsInBatch === 2) return words(4_866_057_281_767n); // stakedLiquidity
      return words(448n); // fee
    }
    throw new Error(`unexpected call to ${call.to} ${sel}`);
  };
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "null");
    const reply = (r: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: r.id, result: answer(r) });
    const out = Array.isArray(body) ? body.map(reply) : reply(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

test("blockTag: a block number becomes its hex tag; none is `latest`; a non-block is refused by name", () => {
  assert.equal(blockTag(BLOCK), TAG);
  assert.equal(blockTag(0), "0x0");
  assert.equal(blockTag(undefined), "latest");
  assert.throws(() => blockTag(-1), /not a block number/);
  assert.throws(() => blockTag(1.5), /not a block number/);
});

test("AaveSource.sample(block): every eth_call of the sample carries the pinned block tag, and the clock injected with it stamps sampledAt", async () => {
  const t = fakeEndpoint();
  const rpc = new RpcClient("http://mock.invalid", { fetchImpl: t.fetchImpl, retries: 0 });
  const src = new AaveSource(rpc, () => 1_789_241_491_000);
  const s = await src.sample(BLOCK);
  assert.ok(t.seen.length >= 5, `${t.seen.length} calls`);
  for (const c of t.seen) assert.equal(c.tag, TAG, `${c.to} read at ${String(c.tag)}`);
  assert.equal(s.sampledAt, "2026-09-12T19:31:31.000Z");
  assert.equal(s.borrow.variableBorrowAprPct, 5);
  assert.equal(s.borrowCurve.strategy, STRATEGY);
});

test("AaveSource.sample(): without a block every eth_call is at `latest` (the live service's read)", async () => {
  const t = fakeEndpoint();
  const src = new AaveSource(new RpcClient("http://mock.invalid", { fetchImpl: t.fetchImpl, retries: 0 }));
  await src.sample();
  assert.ok(t.seen.length >= 5);
  for (const c of t.seen) assert.equal(c.tag, "latest");
});

test("GaugeSource.sample(…, block): the voter lookup and the five pool/gauge reads all carry the block tag; the block's timestamp decides epochActive", async () => {
  const t = fakeEndpoint();
  const g = new GaugeSource(new RpcClient("http://mock.invalid", { fetchImpl: t.fetchImpl, retries: 0 }));
  const e = await g.sample("aero-cbbtc-usdc", POOL, { aeroUsd: 0.5634, poolTvlUsd: 1_000_000, token1Usd: 1, token1Decimals: 6, nowSeconds: 1_789_241_491 }, undefined, BLOCK);
  assert.equal(t.seen.length, 6, "voter.gauges + rewardRate + periodFinish + slot0 + stakedLiquidity + fee");
  for (const c of t.seen) assert.equal(c.tag, TAG, `${c.to} read at ${String(c.tag)}`);
  assert.equal(e.gauge, GAUGE);
  assert.equal(e.periodFinish, 1_789_603_200);
  assert.equal(e.epochActive, true, "periodFinish is after the block's timestamp");
  assert.equal(e.sampledAt, "2026-09-12T19:31:31.000Z");
  // The same source without a block reads at latest (a second pool, so the gauge cache does not hide the lookup).
  const t2 = fakeEndpoint();
  const g2 = new GaugeSource(new RpcClient("http://mock.invalid", { fetchImpl: t2.fetchImpl, retries: 0 }));
  await g2.sample("aero-cbbtc-usdc", POOL, { aeroUsd: 0.5634, poolTvlUsd: 1_000_000, token1Usd: 1, token1Decimals: 6 });
  for (const c of t2.seen) assert.equal(c.tag, "latest");
});

test("RpcClient: batchSize 1 posts one request at a time (the shape a rate-limited public endpoint accepts); paceMs waits between them", async () => {
  const posts: string[] = [];
  const t0 = Date.now();
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    posts.push(init?.body ?? "");
    const body = JSON.parse(init?.body ?? "null");
    assert.ok(!Array.isArray(body), "no batch arrays with batchSize 1");
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1" }), { status: 200 });
  }) as unknown as typeof fetch;
  const rpc = new RpcClient("http://mock.invalid", { fetchImpl, retries: 0, batchSize: 1, paceMs: 30 });
  const r = await rpc.callMany<string>([1, 2, 3, 4].map(() => ({ method: "eth_call", params: [{ to: "0x1", data: "0x" }, "latest"] })));
  assert.deepEqual(r, ["0x1", "0x1", "0x1", "0x1"]);
  assert.equal(posts.length, 4);
  assert.ok(Date.now() - t0 >= 3 * 30 - 5, "three pauses of paceMs between four posts");
});
