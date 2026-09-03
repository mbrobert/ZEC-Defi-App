import assert from "node:assert/strict";
import { test } from "node:test";
import { RpcClient } from "../src/sources/rpc.js";
import {
  AERODROME_VOTER,
  EMISSION_WIDTHS,
  GaugeSource,
  onchainToken1,
  widthBracket,
} from "../src/sources/gauges.js";
import type { Address } from "../src/types.js";

/**
 * REAL on-chain reference (captured 2026-08-31, block 50675328 — see
 * services/yield/samples/gauge-emissions-2026-08-31.json): Aerodrome
 * WETH/USDC 0.05% pool + its CL gauge. The mocked transport below replays
 * exactly these words; the APR assertions pin the model against the numbers
 * computed independently at capture time.
 */
const POOL = "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59" as Address;
const GAUGE = "0xf33a96b5932d9e9b9a0eda447abd8c9d48d2e0c8" as Address;
const REWARD_RATE = 340364640583415175n; // AERO wei / sec
const PERIOD_FINISH = 1_788_393_600n;
const SQRT_PRICE_X96 = 3897149340279738881397267n;
const STAKED_LIQUIDITY = 5678459724668201957n;
const LIQUIDITY = 6204617012087730117n;
const FEE_PIPS = 364n;
const SAMPLE_NOW = 1_756_604_072; // 2026-08-31T01:34:32Z (epoch active)

const PRICES = {
  aeroUsd: 0.478221898577248,
  poolTvlUsd: 7_898_285.87,
  token1Usd: 0.997135511846634,
  token1Decimals: 6,
  nowSeconds: SAMPLE_NOW,
};

const word = (v: bigint) => v.toString(16).padStart(64, "0");

/**
 * fetch mock speaking JSON-RPC: answers eth_call by (to, selector). Handles
 * both single and batched request bodies, counts voter lookups.
 */
function makeTransport(overrides?: { stakedLiquidity?: bigint; periodFinish?: bigint }) {
  const staked = overrides?.stakedLiquidity ?? STAKED_LIQUIDITY;
  const periodFinish = overrides?.periodFinish ?? PERIOD_FINISH;
  const counts = { voterCalls: 0, ethCalls: 0 };
  const answer = (params: unknown[]): string => {
    const { to, data } = params[0] as { to: string; data: string };
    counts.ethCalls++;
    const sel = data.slice(0, 10);
    const target = to.toLowerCase();
    if (target === AERODROME_VOTER && sel === "0xb9a09fd5") {
      counts.voterCalls++;
      assert.equal(data.slice(10), POOL.slice(2).padStart(64, "0")); // pool arg encoded
      return `0x${GAUGE.slice(2).padStart(64, "0")}`;
    }
    if (target === GAUGE && sel === "0x7b0a47ee") return `0x${word(REWARD_RATE)}`;
    if (target === GAUGE && sel === "0xebe2b12b") return `0x${word(periodFinish)}`;
    if (target === POOL && sel === "0x3850c7bd") {
      // slot0(): sqrtPriceX96, tick, observationIndex, cardinality, cardinalityNext, unlocked
      return `0x${word(SQRT_PRICE_X96)}${word(0xfcf879n)}${word(0n)}${word(100n)}${word(100n)}${word(1n)}`;
    }
    if (target === POOL && sel === "0x1a686502") return `0x${word(LIQUIDITY)}`;
    if (target === POOL && sel === "0x3ab04b20") return `0x${word(staked)}`;
    if (target === POOL && sel === "0xddca3f43") return `0x${word(FEE_PIPS)}`;
    throw new Error(`unexpected eth_call to=${to} sel=${sel}`);
  };
  const fetchImpl = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(init?.body ?? "{}") as
      | { id: number; method: string; params: unknown[] }
      | { id: number; method: string; params: unknown[] }[];
    const reply = (r: { id: number; method: string; params: unknown[] }) => ({
      jsonrpc: "2.0",
      id: r.id,
      result: answer(r.params),
    });
    const out = Array.isArray(body) ? body.map(reply) : reply(body);
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, counts };
}

test("onchainToken1 sorts by address (curated display order is wrong for USDT/USDC)", () => {
  // curated aero-usdt-usdc lists token0=USDT token1=USDC; on-chain token1 IS USDT.
  const stab = onchainToken1("USDT", "USDC")!;
  assert.equal(stab.address, "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2"); // USDT
  assert.equal(stab.decimals, 6);
  const weth = onchainToken1("WETH", "USDC")!;
  assert.equal(weth.address, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"); // USDC
  assert.equal(onchainToken1("WETH", "WAT"), null); // unknown symbol → null, never guessed
});

test("gauge APR model reproduces the live 2026-08-31 sample (wholePool ≈65%, w=0.25 ≈7.69%, w=0.015 ≈123.3%)", async () => {
  const { fetchImpl, counts } = makeTransport();
  const src = new GaugeSource(new RpcClient("http://mock.invalid", { fetchImpl, retries: 0 }));

  const s = await src.sample(POOL, PRICES);

  assert.equal(s.gauge, GAUGE);
  assert.equal(s.epochActive, true);
  assert.equal(s.samples, 1);
  assert.ok(Math.abs(s.wholePoolAprPct - 64.99) < 0.06, `wholePool ${s.wholePoolAprPct}`);
  assert.ok(Math.abs(s.aprByWidthPct["0.25"]! - 7.69) < 0.05, `w=0.25 ${s.aprByWidthPct["0.25"]}`);
  assert.ok(Math.abs(s.aprByWidthPct["0.015"]! - 123.32) < 0.4, `w=0.015 ${s.aprByWidthPct["0.015"]}`);
  // every configured width is quoted, and narrower ranges always yield more
  assert.deepEqual(Object.keys(s.aprByWidthPct), EMISSION_WIDTHS.map(String));
  const aprs = EMISSION_WIDTHS.map((w) => s.aprByWidthPct[String(w)]!);
  for (let i = 1; i < aprs.length; i++) assert.ok(aprs[i]! > aprs[i - 1]!);
  assert.equal(counts.voterCalls, 1);
});

test("gauge address is cached: a second sample re-reads state but not the voter", async () => {
  const { fetchImpl, counts } = makeTransport();
  const src = new GaugeSource(new RpcClient("http://mock.invalid", { fetchImpl, retries: 0 }));
  await src.sample(POOL, PRICES);
  await src.sample(POOL, PRICES);
  assert.equal(counts.voterCalls, 1); // resolved once, cached
});

test("stakedLiquidity is rolling-averaged across samples (noise damping), samples count exposed", async () => {
  const first = makeTransport({ stakedLiquidity: STAKED_LIQUIDITY });
  const src = new GaugeSource(new RpcClient("http://mock.invalid", { fetchImpl: first.fetchImpl, retries: 0 }));
  const s1 = await src.sample(POOL, PRICES);

  // Second reading doubles: the averaged V_staked uses (1x + 2x)/2 = 1.5x,
  // so APR falls to 1/1.5 of the first sample's.
  const second = makeTransport({ stakedLiquidity: STAKED_LIQUIDITY * 2n });
  (src as unknown as { rpc: RpcClient }).rpc = new RpcClient("http://mock.invalid", {
    fetchImpl: second.fetchImpl,
    retries: 0,
  });
  const s2 = await src.sample(POOL, PRICES);
  assert.equal(s2.samples, 2);
  const expected = s1.aprByWidthPct["0.04"]! / 1.5;
  assert.ok(
    Math.abs(s2.aprByWidthPct["0.04"]! - expected) < 0.05,
    `averaged APR ${s2.aprByWidthPct["0.04"]} vs expected ${expected}`
  );
  // wholePool uses TVL, not staked liquidity — unchanged.
  assert.equal(s2.wholePoolAprPct, s1.wholePoolAprPct);
});

test("lapsed epoch (periodFinish ≤ now): zeros with epochActive:false, never a stale APR", async () => {
  const { fetchImpl } = makeTransport({ periodFinish: BigInt(SAMPLE_NOW - 10) });
  const src = new GaugeSource(new RpcClient("http://mock.invalid", { fetchImpl, retries: 0 }));
  const s = await src.sample(POOL, PRICES);
  assert.equal(s.epochActive, false);
  assert.equal(s.wholePoolAprPct, 0);
  assert.ok(Object.values(s.aprByWidthPct).every((v) => v === 0));
});

test("unusable price inputs refuse loudly (no NaN APRs served)", async () => {
  const { fetchImpl } = makeTransport();
  const src = new GaugeSource(new RpcClient("http://mock.invalid", { fetchImpl, retries: 0 }));
  await assert.rejects(() => src.sample(POOL, { ...PRICES, aeroUsd: NaN }), /price inputs/);
  await assert.rejects(() => src.sample(POOL, { ...PRICES, poolTvlUsd: 0 }), /price inputs/);
});

test("widthBracket: closed-form spot values", () => {
  // w=0.25 → 2 − √0.75 − 1/√1.25 = 0.23954743…
  assert.ok(Math.abs(widthBracket(0.25) - 0.2395474) < 1e-6);
  assert.ok(Math.abs(widthBracket(0.015) - 0.014945) < 1e-5);
});
