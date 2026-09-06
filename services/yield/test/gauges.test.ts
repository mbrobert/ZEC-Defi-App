import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { AERODROME, keccak256Hex } from "@zyo/shared";
import { modelWidthsBps } from "../src/model.js";
import { RpcClient } from "../src/sources/rpc.js";
import {
  AERODROME_VOTER,
  GaugeDecodeError,
  GaugeSource,
  MIN_STAKED_SAMPLES,
  onchainToken1,
  OUTLIER_FACTOR,
  SEL,
} from "../src/sources/gauges.js";
import type { Address } from "../src/types.js";

/**
 * REAL on-chain reference (captured 2026-08-31, block 50675328 —
 * samples/gauge-emissions-2026-08-31.json, sha256 5fbf03e5…): Aerodrome
 * WETH/USDC 0.05% pool + its CL gauge. The mocked transport replays exactly
 * these words; the APR assertions pin the model against the numbers the
 * Python sim computed independently from the same words at the S4 widths.
 */
const SAMPLE = JSON.parse(readFileSync(new URL("../../samples/gauge-emissions-2026-08-31.json", import.meta.url), "utf8")) as {
  aeroUsd: number;
  pools: Record<string, { pool: string; gauge: string; rewardRateWeiPerSec: string; periodFinish: number; sqrtPriceX96: string; liquidity: string; stakedLiquidity: string; poolTvlUsd: number; token1Usd: number; dec1: number; feeBpsLive: number }>;
};
const AWETH = SAMPLE.pools["aero-usdc-weth-5"]!;
const POOL = AWETH.pool as Address;
const GAUGE = AWETH.gauge as Address;
const REWARD_RATE = BigInt(AWETH.rewardRateWeiPerSec);
const PERIOD_FINISH = BigInt(AWETH.periodFinish);
const SQRT_PRICE_X96 = BigInt(AWETH.sqrtPriceX96);
const STAKED_LIQUIDITY = BigInt(AWETH.stakedLiquidity);
const FEE_PIPS = BigInt(Math.round(AWETH.feeBpsLive * 100));
const SAMPLE_NOW = 1_756_604_072; // 2026-08-31T01:34:32Z (epoch active)

const PRICES = {
  aeroUsd: SAMPLE.aeroUsd,
  poolTvlUsd: AWETH.poolTvlUsd,
  token1Usd: AWETH.token1Usd,
  token1Decimals: AWETH.dec1,
  nowSeconds: SAMPLE_NOW,
};

const word = (v: bigint) => v.toString(16).padStart(64, "0");

interface Overrides {
  stakedLiquidity?: bigint;
  periodFinish?: bigint;
  rewardRate?: bigint;
  gauge?: string;
  /** Return a raw override for (target, selector) — used to break shapes. */
  raw?: (target: string, sel: string) => string | undefined;
}

/** fetch mock speaking JSON-RPC: answers eth_call by (to, selector). */
function makeTransport(o: Overrides = {}) {
  const staked = o.stakedLiquidity ?? STAKED_LIQUIDITY;
  const periodFinish = o.periodFinish ?? PERIOD_FINISH;
  const rewardRate = o.rewardRate ?? REWARD_RATE;
  const gauge = (o.gauge ?? GAUGE).toLowerCase();
  const counts = { voterCalls: 0, ethCalls: 0 };
  const answer = (params: unknown[]): string => {
    const { to, data } = params[0] as { to: string; data: string };
    counts.ethCalls++;
    const sel = data.slice(0, 10);
    const target = to.toLowerCase();
    const raw = o.raw?.(target, sel);
    if (raw !== undefined) return raw;
    if (target === AERODROME_VOTER && sel === SEL.gauges) {
      counts.voterCalls++;
      assert.equal(data.slice(10), POOL.slice(2).padStart(64, "0")); // pool arg encoded
      return `0x${gauge.slice(2).padStart(64, "0")}`;
    }
    if (target === gauge && sel === SEL.rewardRate) return `0x${word(rewardRate)}`;
    if (target === gauge && sel === SEL.periodFinish) return `0x${word(periodFinish)}`;
    if (target === POOL && sel === SEL.slot0) {
      // slot0(): sqrtPriceX96, tick, observationIndex, cardinality, cardinalityNext, unlocked
      return `0x${word(SQRT_PRICE_X96)}${word(0xfcf879n)}${word(0n)}${word(100n)}${word(100n)}${word(1n)}`;
    }
    if (target === POOL && sel === SEL.stakedLiquidity) return `0x${word(staked)}`;
    if (target === POOL && sel === SEL.fee) return `0x${word(FEE_PIPS)}`;
    throw new Error(`unexpected eth_call to=${to} sel=${sel}`);
  };
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const reply = (r: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: r.id, result: answer(r.params) });
    const out = Array.isArray(body) ? body.map(reply) : reply(body);
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, counts };
}

function src(t: ReturnType<typeof makeTransport>, maxSamples?: number): GaugeSource {
  return new GaugeSource(new RpcClient("http://mock.invalid", { fetchImpl: t.fetchImpl, retries: 0 }), maxSamples);
}

test("selectors are keccak prefixes of the Voter/gauge/pool signatures; voter is the verified address", () => {
  const sig: Record<keyof typeof SEL, string> = {
    gauges: "gauges(address)", rewardRate: "rewardRate()", periodFinish: "periodFinish()",
    slot0: "slot0()", liquidity: "liquidity()", stakedLiquidity: "stakedLiquidity()", fee: "fee()",
  };
  for (const [k, s] of Object.entries(sig) as [keyof typeof SEL, string][]) {
    assert.equal(SEL[k], "0x" + keccak256Hex(s).slice(0, 8), k);
  }
  assert.equal(AERODROME_VOTER, AERODROME.voter.toLowerCase());
});

test("onchainToken1 sorts by address (display order is wrong for USDT/USDC and cbZEC/USDC)", () => {
  const stab = onchainToken1("USDT", "USDC")!;
  assert.equal(stab.address, "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"); // USDT
  assert.equal(stab.decimals, 6);
  const weth = onchainToken1("WETH", "USDC")!;
  assert.equal(weth.address, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"); // USDC
  // cbZEC/USDC: verified 2026-09-05 token0 = USDC, token1 = cbZEC (8 dec)
  const zec = onchainToken1("USDC", "cbZEC")!;
  assert.equal(zec.address, "0xb2000000000000000000008501b13360000cb2ec");
  assert.equal(zec.decimals, 8);
  assert.equal(onchainToken1("WETH", "WAT"), null); // unknown symbol → null, never guessed
});

test("gauge APR model reproduces the live 2026-08-31 words at the S4 widths (4500 ≈ 7.63 %, 1500 ≈ 24.08 %, 300 ≈ 122.41 %)", async () => {
  const t = makeTransport();
  const g = src(t);
  // The anchor has to be corroborated before any APR is published, so read
  // MIN_STAKED_SAMPLES times; identical readings agree with each other.
  let s = await g.sample("aero-usdc-weth-5", POOL, PRICES);
  assert.equal(s.aprByWidthPct, null, "no APR is published on an uncorroborated anchor");
  for (let i = 1; i < MIN_STAKED_SAMPLES; i++) s = await g.sample("aero-usdc-weth-5", POOL, PRICES);

  assert.equal(s.gauge, GAUGE);
  assert.equal(s.poolId, "aero-usdc-weth-5");
  assert.equal(s.epochActive, true);
  assert.equal(s.outlier, false);
  assert.equal(s.corroborated, true);
  assert.equal(s.samples, MIN_STAKED_SAMPLES);
  assert.equal(s.rewardRateWeiPerSec, AWETH.rewardRateWeiPerSec);
  assert.equal(s.feePips, Number(FEE_PIPS));
  assert.ok(Math.abs(s.wholePoolAprPct! - 64.99) < 0.06, `wholePool ${s.wholePoolAprPct}`);
  // Expected values computed independently by scripts/lp-sim.py from the same words.
  assert.ok(Math.abs(s.aprByWidthPct!["4500"]! - 7.625) < 0.01, `4500 → ${s.aprByWidthPct!["4500"]}`);
  assert.ok(Math.abs(s.aprByWidthPct!["1500"]! - 24.0813) < 0.01, `1500 → ${s.aprByWidthPct!["1500"]}`);
  assert.ok(Math.abs(s.aprByWidthPct!["300"]! - 122.4065) < 0.01, `300 → ${s.aprByWidthPct!["300"]}`);
  // every shared preset width (both pair classes) is quoted; narrower always yields more
  assert.deepEqual(new Set(Object.keys(s.aprByWidthPct!)), new Set(modelWidthsBps().map(String)));
  const aprs = modelWidthsBps().map((b) => s.aprByWidthPct![String(b)]!);
  for (let i = 1; i < aprs.length; i++) assert.ok(aprs[i]! > aprs[i - 1]!);
  assert.equal(t.counts.voterCalls, 1);
  assert.equal("stale" in s, false); // never stored on a sample
});

test("gauge address is cached; a registry-recorded gauge that disagrees with the voter fails closed", async () => {
  const t = makeTransport();
  const g = src(t);
  await g.sample("aero-usdc-weth-5", POOL, PRICES);
  await g.sample("aero-usdc-weth-5", POOL, PRICES);
  assert.equal(t.counts.voterCalls, 1); // resolved once, cached
  const other = ("0x" + "ab".repeat(20)) as Address;
  await assert.rejects(() => src(makeTransport()).sample("x", POOL, PRICES, other), /voter says .* registry says/);
  // a voter answer that matches the registry is accepted
  const ok = await src(makeTransport()).sample("x", POOL, PRICES, GAUGE);
  assert.equal(ok.gauge, GAUGE);
});

test("stakedLiquidity is rolling-averaged across accepted samples (noise damping), samples count exposed", async () => {
  const g = src(makeTransport({ stakedLiquidity: STAKED_LIQUIDITY }));
  const swap = (t: ReturnType<typeof makeTransport>) => {
    (g as unknown as { rpc: RpcClient }).rpc = new RpcClient("http://mock.invalid", { fetchImpl: t.fetchImpl, retries: 0 });
  };
  let s1!: Awaited<ReturnType<typeof g.sample>>;
  for (let i = 0; i < MIN_STAKED_SAMPLES; i++) s1 = await g.sample("p", POOL, PRICES);
  assert.equal(s1.samples, MIN_STAKED_SAMPLES);
  // A fourth reading at 2x (inside the outlier band): the average of
  // [1x, 1x, 1x, 2x] is 1.25x → the APR falls to 1/1.25 of the first.
  swap(makeTransport({ stakedLiquidity: STAKED_LIQUIDITY * 2n }));
  const s2 = await g.sample("p", POOL, PRICES);
  assert.equal(s2.samples, MIN_STAKED_SAMPLES + 1);
  assert.equal(s2.outlier, false);
  const expected = s1.aprByWidthPct!["1500"]! / 1.25;
  assert.ok(Math.abs(s2.aprByWidthPct!["1500"]! - expected) < 0.05, `averaged APR ${s2.aprByWidthPct!["1500"]} vs ${expected}`);
  assert.equal(s2.wholePoolAprPct, s1.wholePoolAprPct); // TVL-based, unchanged
});

test("outlier gate: a reading > OUTLIER_FACTOR× away from the MEDIAN of the corroborated history is flagged and kept out of the average", async () => {
  const g = src(makeTransport());
  const swap = (t: ReturnType<typeof makeTransport>) => {
    (g as unknown as { rpc: RpcClient }).rpc = new RpcClient("http://mock.invalid", { fetchImpl: t.fetchImpl, retries: 0 });
  };
  let s1!: Awaited<ReturnType<typeof g.sample>>;
  for (let i = 0; i < MIN_STAKED_SAMPLES; i++) s1 = await g.sample("p", POOL, PRICES);
  swap(makeTransport({ stakedLiquidity: STAKED_LIQUIDITY * BigInt(OUTLIER_FACTOR) * 2n }));
  const big = await g.sample("p", POOL, PRICES);
  assert.equal(big.outlier, true);
  assert.equal(big.samples, MIN_STAKED_SAMPLES); // not averaged in
  // an outlier reading publishes NO APR: the number it would produce is the
  // fabrication the flag exists to catch
  assert.equal(big.aprByWidthPct, null);
  assert.equal(big.wholePoolAprPct, null);
  swap(makeTransport({ stakedLiquidity: STAKED_LIQUIDITY / (BigInt(OUTLIER_FACTOR) * 2n) }));
  const small = await g.sample("p", POOL, PRICES);
  assert.equal(small.outlier, true);
  // back inside the band → accepted again, and the anchor is unchanged
  swap(makeTransport({ stakedLiquidity: (STAKED_LIQUIDITY * 3n) / 2n }));
  const fine = await g.sample("p", POOL, PRICES);
  assert.equal(fine.outlier, false);
  assert.equal(fine.samples, MIN_STAKED_SAMPLES + 1);
  assert.ok(fine.aprByWidthPct!["1500"]! < s1.aprByWidthPct!["1500"]!); // bigger base, smaller APR
});

test("lapsed epoch (periodFinish ≤ now): zeros with epochActive:false, never a stale APR", async () => {
  const s = await src(makeTransport({ periodFinish: BigInt(SAMPLE_NOW - 10) })).sample("p", POOL, PRICES);
  assert.equal(s.epochActive, false);
  assert.equal(s.wholePoolAprPct, 0);
  assert.ok(Object.values(s.aprByWidthPct!).every((v) => v === 0));
});

test("cbZEC/USDC-shaped gauge (rewardRate 0, periodFinish 0): epochActive:false, every APR 0", async () => {
  const s = await src(makeTransport({ rewardRate: 0n, periodFinish: 0n, gauge: AERODROME.pools.cbZEC_USDC.gauge })).sample(
    "aero-cbzec-usdc", POOL, PRICES, AERODROME.pools.cbZEC_USDC.gauge as Address
  );
  assert.equal(s.epochActive, false);
  assert.equal(s.rewardRateWeiPerSec, "0");
  assert.equal(s.periodFinish, 0);
  assert.equal(s.wholePoolAprPct, 0);
  assert.deepEqual(new Set(Object.values(s.aprByWidthPct!)), new Set([0]));
});

test("rewardRate > 0 with periodFinish in the past is NOT active (rewardRate alone proves nothing)", async () => {
  const s = await src(makeTransport({ periodFinish: 1n })).sample("p", POOL, PRICES);
  assert.equal(s.epochActive, false);
});

test("no staked liquidity with an active epoch: aprByWidthPct is null (no division by zero served)", async () => {
  const s = await src(makeTransport({ stakedLiquidity: 0n })).sample("p", POOL, PRICES);
  assert.equal(s.epochActive, true);
  assert.equal(s.aprByWidthPct, null);
});

test("STRICT decoding: empty / short / wrong-shape returns throw instead of decoding to zeros", async () => {
  const cases: [string, (target: string, sel: string) => string | undefined][] = [
    ["empty rewardRate", (t, s) => (s === SEL.rewardRate ? "0x" : undefined)],
    ["short slot0", (t, s) => (s === SEL.slot0 ? `0x${word(SQRT_PRICE_X96)}` : undefined)],
    ["two-word stakedLiquidity", (t, s) => (s === SEL.stakedLiquidity ? `0x${word(1n)}${word(2n)}` : undefined)],
    ["non-hex fee", (t, s) => (s === SEL.fee ? "0xzz" : undefined)],
    ["zero gauge", (t, s) => (s === SEL.gauges ? `0x${word(0n)}` : undefined)],
    ["uninitialized pool (sqrtPrice 0)", (t, s) => (s === SEL.slot0 ? `0x${word(0n)}${word(0n)}${word(0n)}${word(0n)}${word(0n)}${word(0n)}` : undefined)],
  ];
  for (const [name, raw] of cases) {
    await assert.rejects(() => src(makeTransport({ raw })).sample("p", POOL, PRICES), GaugeDecodeError, name);
  }
});

test("unusable price inputs refuse loudly (no NaN APRs served)", async () => {
  await assert.rejects(() => src(makeTransport()).sample("p", POOL, { ...PRICES, aeroUsd: NaN }), /price inputs/);
  await assert.rejects(() => src(makeTransport()).sample("p", POOL, { ...PRICES, poolTvlUsd: 0 }), /price inputs/);
  await assert.rejects(() => src(makeTransport()).sample("p", POOL, { ...PRICES, token1Usd: -1 }), /price inputs/);
});

test("FIX D-HIGH-2: the first reading is never an anchor — a tiny first stakedLiquidity publishes NO APR and cannot pin the filter", async () => {
  // The recorded attack: one first reading 2,000× low anchored the filter at
  // the anomaly, was served with `outlier:false` because there was nothing to
  // compare it against (7,599.64 % against a true 3.80 %), and then rejected
  // every subsequent CORRECT reading as an outlier — for the life of the
  // process. Two things had to change: no APR until the anchor is corroborated,
  // and a wrong anchor that keeps being contradicted must be dropped.
  const TINY = STAKED_LIQUIDITY / 2000n;
  const g = src(makeTransport({ stakedLiquidity: TINY }));
  const swap = (t: ReturnType<typeof makeTransport>) => {
    (g as unknown as { rpc: RpcClient }).rpc = new RpcClient("http://mock.invalid", { fetchImpl: t.fetchImpl, retries: 0 });
  };

  // 1. The anomalous FIRST reading publishes nothing at all.
  const first = await g.sample("p", POOL, PRICES);
  assert.equal(first.corroborated, false);
  assert.equal(first.samples, 1);
  assert.equal(first.aprByWidthPct, null, "an uncorroborated anchor may not produce an APR");
  assert.equal(first.wholePoolAprPct, null);
  assert.equal(first.outlier, false); // honest: there is nothing to test it against

  // 2. The TRUE readings arrive. They disagree with the anomalous anchor, but
  //    a run of them proves the ANCHOR is what was wrong: the history is
  //    dropped and re-corroborated on the readings that agree with each other.
  swap(makeTransport({ stakedLiquidity: STAKED_LIQUIDITY }));
  let s!: Awaited<ReturnType<typeof g.sample>>;
  for (let i = 0; i < 2 * MIN_STAKED_SAMPLES; i++) s = await g.sample("p", POOL, PRICES);
  assert.equal(s.corroborated, true);
  assert.equal(s.outlier, false);

  // 3. The published APR is the TRUE one, not the 2,000×-overstated one.
  const truth = await (async () => {
    const clean = src(makeTransport({ stakedLiquidity: STAKED_LIQUIDITY }));
    let t!: Awaited<ReturnType<typeof clean.sample>>;
    for (let i = 0; i < MIN_STAKED_SAMPLES; i++) t = await clean.sample("q", POOL, PRICES);
    return t;
  })();
  assert.ok(
    Math.abs(s.aprByWidthPct!["1500"]! - truth.aprByWidthPct!["1500"]!) < 0.01,
    `served ${s.aprByWidthPct!["1500"]} vs true ${truth.aprByWidthPct!["1500"]}`
  );
  // and it is nowhere near the ~2,000× figure the old anchor would have served
  assert.ok(s.aprByWidthPct!["1500"]! < truth.aprByWidthPct!["1500"]! * 2);
});

test("FIX D-HIGH-2: a single anomalous reading inside a corroborated history is rejected and cannot move the anchor", async () => {
  const g = src(makeTransport({ stakedLiquidity: STAKED_LIQUIDITY }));
  const swap = (t: ReturnType<typeof makeTransport>) => {
    (g as unknown as { rpc: RpcClient }).rpc = new RpcClient("http://mock.invalid", { fetchImpl: t.fetchImpl, retries: 0 });
  };
  let good!: Awaited<ReturnType<typeof g.sample>>;
  for (let i = 0; i < MIN_STAKED_SAMPLES; i++) good = await g.sample("p", POOL, PRICES);
  // One flash-unstake reading, then the truth returns before the streak
  // reaches MIN_STAKED_SAMPLES: the anchor must survive untouched.
  swap(makeTransport({ stakedLiquidity: STAKED_LIQUIDITY / 2000n }));
  assert.equal((await g.sample("p", POOL, PRICES)).outlier, true);
  swap(makeTransport({ stakedLiquidity: STAKED_LIQUIDITY }));
  const back = await g.sample("p", POOL, PRICES);
  assert.equal(back.outlier, false);
  assert.equal(back.corroborated, true);
  assert.equal(back.aprByWidthPct!["1500"], good.aprByWidthPct!["1500"]);
});

test("FIX D-LOW-6: no staked liquidity nulls the whole-pool APR too, not just the per-width table", async () => {
  const g = src(makeTransport({ stakedLiquidity: 0n }));
  let s!: Awaited<ReturnType<typeof g.sample>>;
  for (let i = 0; i < MIN_STAKED_SAMPLES; i++) s = await g.sample("p", POOL, PRICES);
  assert.equal(s.epochActive, true);
  assert.equal(s.aprByWidthPct, null);
  assert.equal(s.wholePoolAprPct, null, "a pool APR nobody can earn is not published");
});
