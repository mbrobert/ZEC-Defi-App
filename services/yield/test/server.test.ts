import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO_ID_MAP, YieldServer } from "../src/server.js";
import type { YieldConfig } from "../src/config.js";
import type { GeckoSource } from "../src/sources/gecko.js";
import { BASE_TOKEN_ADDRESSES, onchainToken1, type GaugeSource } from "../src/sources/gauges.js";
import { CURATED_POOLS } from "@zyo/shared";
import type { RheaRates } from "../src/rhea.js";
import type { Address, PoolBands, PoolsResponse } from "../src/types.js";

function cfg(dataDir: string): YieldConfig {
  return {
    baseRpcUrl: undefined, blockscoutKey: undefined,
    nearRpcUrl: "http://unused.invalid", rheaLendingContract: "x", rheaUsdcTokenId: "y",
    rheaZecTokenId: "z", engineVault: "0x" + "0".repeat(40),
    port: 0, dataDir, refreshMs: 60_000, staleAfterMs: 600_000,
    cohortWindows: [30, 60, 90], minDaysOpen: 1, logChunk: 5_000,
  };
}

/** Fixed USD prices per token address (mirrors the 2026-08-31 gauge sample). */
const PRICES: Record<string, number> = {
  [BASE_TOKEN_ADDRESSES.WETH!]: 2432.52,
  [BASE_TOKEN_ADDRESSES.USDC!]: 0.997135,
  [BASE_TOKEN_ADDRESSES.cbBTC!]: 78036.7,
  [BASE_TOKEN_ADDRESSES.LINK!]: 11.19,
  [BASE_TOKEN_ADDRESSES.USDT!]: 0.9994,
  [BASE_TOKEN_ADDRESSES.cbETH!]: 2778.6,
  [BASE_TOKEN_ADDRESSES.AERO!]: 0.478222,
};

/** Live-sample stub that mirrors real gecko payloads incl. token prices. */
const geckoStub = {
  liveSample: async (poolId: string, poolAddress: string, feeTierBps: number) => {
    const curated = CURATED_POOLS.find((p) => p.id === poolId);
    const t1 = curated ? onchainToken1(curated.token0, curated.token1) : null;
    const a = curated ? BASE_TOKEN_ADDRESSES[curated.token0] : undefined;
    const b = curated ? BASE_TOKEN_ADDRESSES[curated.token1] : undefined;
    const token0 = a && b ? (a < b ? a : b) : undefined;
    return {
      poolId, poolAddress: poolAddress as `0x${string}`, tvlUsd: 1_000_000, volume24hUsd: 500_000,
      feeTierBps, grossFeeAprPct: 50,
      baseTokenAddress: token0, quoteTokenAddress: t1?.address,
      baseTokenPriceUsd: token0 ? PRICES[token0] : undefined,
      quoteTokenPriceUsd: t1 ? PRICES[t1.address] : undefined,
      sampledAt: new Date().toISOString(),
      source: "geckoterminal" as const,
    };
  },
} as unknown as GeckoSource;

const rheaStub = {
  sample: async () => ({
    borrowAprPct: 13.56, supplyAprPct: 8.7, zecSupplyAprPct: 0.04,
    asset: "USDC", market: "contract.main.burrow.near",
    sampledAt: new Date().toISOString(), source: "rhea-burrow" as const,
  }),
} as unknown as RheaRates;

function bandsFixture(): PoolBands[] {
  const mk = (poolId: string): PoolBands => ({
    poolId, enginePoolId: ("0x" + "aa".repeat(32)) as `0x${string}`,
    computedAt: new Date().toISOString(), asOfBlock: 1,
    methodology: "closed-position-flows-v1",
    bands: [30, 60, 90].map((w) => ({
      windowDays: w, n: 12, excluded: 1, totalPrincipalUsd: 250_000, meanDaysOpen: 9,
      p10: -10, p25: 18, p50: 34, p75: 55, p90: 90, medianUnweighted: 30,
    })),
  });
  return [mk("aero-usdc-weth-5"), mk("aero-cbbtc-usdc")];
}

async function get(port: number, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

test("serves pools with live samples, bands where available, honest reasons elsewhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-srv-"));
  try {
    writeFileSync(join(dir, "bands.json"), JSON.stringify(bandsFixture()));
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, rhea: rheaStub });
    const http = await server.start();
    const port = (http.address() as { port: number }).port;

    const pools = await get(port, "/v1/pools");
    assert.equal(pools.status, 200);
    const payload = pools.body as PoolsResponse;
    assert.equal(payload.stale, false);
    assert.ok(payload.pools.length >= 8);
    const aweth = payload.pools.find((p) => p.id === "aero-usdc-weth-5")!;
    assert.equal(aweth.live!.grossFeeAprPct, 50);
    assert.equal(aweth.bands!.bands[0]!.p50, 34);
    assert.equal(aweth.emissions, null); // no gauge source configured
    const noBands = payload.pools.find((p) => p.id === "uni-weth-usdc-5")!;
    assert.equal(noBands.bands, null);
    assert.equal(noBands.bandsUnavailableReason, "backfill_pending");
    assert.equal(payload.rates!.borrowAprPct, 13.56);

    const rates = await get(port, "/v1/rates");
    assert.equal(rates.status, 200);
    assert.equal((rates.body as { stale: boolean }).stale, false);

    const health = await get(port, "/healthz");
    assert.equal(health.status, 200);

    server.stop();
    http.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("band endpoint: demo ids map, live ZEC supply is used, math pins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-srv-"));
  try {
    writeFileSync(join(dir, "bands.json"), JSON.stringify(bandsFixture()));
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, rhea: rheaStub });
    const http = await server.start();
    const port = (http.address() as { port: number }).port;

    const r = await get(port, "/v1/band?ltv=0.40&mix=aweth,acbbtc");
    assert.equal(r.status, 200);
    const body = r.body as {
      mix: string[]; supplyApyPct: number; borrowAprPct: number;
      windows: { windowDays: number; band: { p50: number } | null; poolsWithData: number }[];
    };
    assert.deepEqual(body.mix, [DEMO_ID_MAP.aweth, DEMO_ID_MAP.acbbtc]);
    assert.equal(body.supplyApyPct, 0.04); // live ZEC supply, not the static 0.8
    const w30 = body.windows.find((w) => w.windowDays === 30)!;
    assert.equal(w30.poolsWithData, 2);
    // p50: 0.04 + 0.4 × (34 × 0.9 − 13.56) = 0.04 + 0.4 × 17.04 = 6.856 → 6.86
    assert.equal(w30.band!.p50, 6.86);

    const bad = await get(port, "/v1/band?ltv=0.9&mix=aweth");
    assert.equal(bad.status, 400);
    const noMix = await get(port, "/v1/band?ltv=0.4");
    assert.equal(noMix.status, 400);

    server.stop();
    http.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("band endpoint input hardening: dupes deduped, prototype keys and unknown ids → 400, caps enforced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-srv-"));
  try {
    writeFileSync(join(dir, "bands.json"), JSON.stringify(bandsFixture()));
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, rhea: rheaStub });
    const http = await server.start();
    const port = (http.address() as { port: number }).port;

    // Duplicate ids must NOT double-weight the pool: same result as single.
    const dup = await get(port, "/v1/band?ltv=0.40&mix=aweth,aweth,acbbtc");
    const single = await get(port, "/v1/band?ltv=0.40&mix=aweth,acbbtc");
    assert.equal(dup.status, 200);
    assert.deepEqual(
      (dup.body as { windows: unknown }).windows,
      (single.body as { windows: unknown }).windows
    );
    assert.deepEqual((dup.body as { mix: string[] }).mix, (single.body as { mix: string[] }).mix);

    // Object-prototype keys must not resolve through the demo map.
    const proto = await get(port, "/v1/band?ltv=0.40&mix=__proto__,constructor");
    assert.equal(proto.status, 400);
    const protoBody = proto.body as { error: string; unknown: string[] };
    assert.deepEqual(protoBody.unknown.sort(), ["__proto__", "constructor"]);

    // Unknown ids are named in a 400, not silently served as empty bands.
    const unk = await get(port, "/v1/band?ltv=0.40&mix=aweth,nope");
    assert.equal(unk.status, 400);
    assert.deepEqual((unk.body as { unknown: string[] }).unknown, ["nope"]);

    // > 16 DISTINCT ids → 400 without echoing the garbage back.
    const many = Array.from({ length: 20 }, (_, i) => `pool${i}`).join(",");
    const capped = await get(port, `/v1/band?ltv=0.40&mix=${many}`);
    assert.equal(capped.status, 400);
    assert.match((capped.body as { error: string }).error, /too many/);

    // ltv below 0.01 rejected (1e-300 was accepted before).
    const tiny = await get(port, "/v1/band?ltv=1e-300&mix=aweth");
    assert.equal(tiny.status, 400);

    server.stop();
    http.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hostile request-targets get 400/500 responses, never a process crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-srv-"));
  try {
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, rhea: rheaStub });
    const http = await server.start();
    const port = (http.address() as { port: number }).port;

    // `GET //` reaches the handler with a request-target WHATWG URL rejects.
    const net = await import("node:net");
    const first = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(port, "127.0.0.1", () => {
        sock.write("GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
      });
      let buf = "";
      sock.on("data", (d) => (buf += d.toString()));
      sock.on("end", () => resolve(buf.split("\r\n")[0] ?? ""));
      sock.on("error", reject);
    });
    assert.match(first, /400/);

    // The server is still alive and serving.
    const ok = await get(port, "/healthz");
    assert.equal(ok.status, 200);

    // An internal throw becomes 500 {error:"internal"} with no message leak.
    const boobyTrapped = server as unknown as { poolsPayload: () => never };
    const orig = Object.getPrototypeOf(boobyTrapped).poolsPayload;
    Object.getPrototypeOf(boobyTrapped).poolsPayload = () => {
      throw new Error("secret internal detail");
    };
    try {
      const r = await get(port, "/v1/pools");
      assert.equal(r.status, 500);
      assert.deepEqual(r.body, { error: "internal" });
    } finally {
      Object.getPrototypeOf(boobyTrapped).poolsPayload = orig;
    }

    server.stop();
    http.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale-while-revalidate: failing sources keep last good data AND flag it stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-srv-"));
  try {
    let fail = false;
    const flaky = {
      liveSample: async (...args: unknown[]) => {
        if (fail) throw new Error("gecko down");
        return (geckoStub as unknown as { liveSample: (...a: unknown[]) => unknown }).liveSample(...args);
      },
    } as unknown as GeckoSource;
    const rheaFlaky = {
      sample: async () => {
        if (fail) throw new Error("near down");
        return (rheaStub as unknown as { sample: () => unknown }).sample();
      },
    } as unknown as RheaRates;

    const conf = { ...cfg(dir), staleAfterMs: 10_000 };
    const server = new YieldServer(conf, { gecko: flaky, rhea: rheaFlaky });
    await server.refresh();
    fail = true;
    await server.refresh(); // sources down — previous values must survive
    const http = await server.start();
    const port = (http.address() as { port: number }).port;

    const fresh = (await get(port, "/v1/pools")).body as PoolsResponse;
    assert.ok(fresh.pools.some((p) => p.live !== null));
    assert.equal(fresh.rates!.borrowAprPct, 13.56);
    assert.equal(fresh.stale, false); // samples are seconds old

    // Age the samples past staleAfterMs while upstreams stay dead: the data
    // keeps serving but MUST now be flagged. (The old implementation reset a
    // global lastRefresh on every refresh — even all-sources-failed ones —
    // so stale was never true after the first success.)
    const aged = server as unknown as {
      live: Map<string, { value: unknown; at: number }>;
      rates: { value: unknown; at: number };
    };
    for (const entry of aged.live.values()) entry.at -= 60_000;
    aged.rates.at -= 60_000;
    await server.refresh(); // all sources fail; ages must not be masked

    const staleRes = (await get(port, "/v1/pools")).body as PoolsResponse;
    assert.ok(staleRes.pools.some((p) => p.live !== null)); // still serving
    assert.equal(staleRes.stale, true); // and honestly flagged

    const rates = await get(port, "/v1/rates");
    assert.equal(rates.status, 200);
    assert.equal((rates.body as { stale: boolean }).stale, true);

    server.stop();
    http.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/v1/rates before any sample: fixed 503 reason enum, no upstream text leak", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-srv-"));
  try {
    const deadRhea = {
      sample: async () => {
        throw new Error("ECONNREFUSED 10.0.0.1:443 <html>proxy said something internal</html>");
      },
    } as unknown as RheaRates;
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, rhea: deadRhea });
    const http = await server.start();
    const port = (http.address() as { port: number }).port;

    const r = await get(port, "/v1/rates");
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: "rates_unavailable", reason: "upstream_unavailable" });

    server.stop();
    http.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh(): re-entrancy guarded — an overlapping call returns without sampling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-srv-"));
  try {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const slowGecko = {
      liveSample: async (poolId: string) => {
        calls++;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight--;
        return {
          poolId, poolAddress: "0x" as `0x${string}`, tvlUsd: 1, volume24hUsd: 1,
          feeTierBps: 5, grossFeeAprPct: 1, sampledAt: new Date().toISOString(),
          source: "geckoterminal" as const,
        };
      },
    } as unknown as GeckoSource;
    const server = new YieldServer(cfg(dir), { gecko: slowGecko, rhea: rheaStub });

    const first = server.refresh();
    const overlapping = server.refresh(); // must be a no-op, not a second loop
    await Promise.all([first, overlapping]);

    const sampleable = CURATED_POOLS.filter((p) => p.poolAddress).length;
    assert.equal(calls, sampleable); // one pass, not two
    assert.ok(maxInFlight <= 3, `bounded concurrency violated: ${maxInFlight}`);
    assert.ok(maxInFlight >= 2, "expected parallel sampling");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh(): whole-run deadline stops sampling instead of running unbounded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-srv-"));
  try {
    let calls = 0;
    const gluedGecko = {
      liveSample: async (poolId: string) => {
        calls++;
        await new Promise((r) => setTimeout(r, 120)); // each pool "hangs"
        return {
          poolId, poolAddress: "0x" as `0x${string}`, tvlUsd: 1, volume24hUsd: 1,
          feeTierBps: 5, grossFeeAprPct: 1, sampledAt: new Date().toISOString(),
          source: "geckoterminal" as const,
        };
      },
    } as unknown as GeckoSource;
    const server = new YieldServer(cfg(dir), {
      gecko: gluedGecko,
      rhea: rheaStub,
      refreshDeadlineMs: 150,
    });
    const t0 = Date.now();
    await server.refresh();
    assert.ok(Date.now() - t0 < 1_000, "refresh did not respect its deadline");
    const sampleable = CURATED_POOLS.filter((p) => p.poolAddress).length;
    assert.ok(calls < sampleable, `deadline should stop new samples (made ${calls}/${sampleable})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/v1/pools carries per-pool gauge emissions for AERODROME pools (null elsewhere/on failure)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-srv-"));
  try {
    const sampled: { pool: string; prices: Record<string, unknown> }[] = [];
    const gaugesStub = {
      sample: async (pool: Address, prices: Record<string, unknown>) => {
        sampled.push({ pool, prices });
        if (pool === "0x72be417afb0abea66913141c605d313bb389b59c") {
          throw new Error("gauge rpc down"); // aero-weth-link fails this round
        }
        return {
          wholePoolAprPct: 64.99,
          aprByWidthPct: { "0.25": 7.69, "0.125": 15.13, "0.08": 23.45, "0.04": 46.51, "0.015": 123.32, "0.0075": 246.19 },
          epochActive: true,
          sampledAt: new Date().toISOString(),
          gauge: "0xf33a96b5932d9e9b9a0eda447abd8c9d48d2e0c8" as Address,
          samples: 1,
        };
      },
    } as unknown as GaugeSource;

    const server = new YieldServer(cfg(dir), { gecko: geckoStub, rhea: rheaStub, gauges: gaugesStub });
    const http = await server.start();
    const port = (http.address() as { port: number }).port;

    const payload = (await get(port, "/v1/pools")).body as PoolsResponse;
    const aweth = payload.pools.find((p) => p.id === "aero-usdc-weth-5")!;
    assert.ok(aweth.emissions, "AERODROME pool must carry emissions");
    assert.equal(aweth.emissions!.wholePoolAprPct, 64.99);
    assert.equal(aweth.emissions!.epochActive, true);
    assert.equal(aweth.emissions!.aprByWidthPct["0.015"], 123.32);
    assert.equal(aweth.emissions!.gauge, "0xf33a96b5932d9e9b9a0eda447abd8c9d48d2e0c8");
    assert.equal(aweth.emissions!.samples, 1);

    const uni = payload.pools.find((p) => p.id === "uni-weth-usdc-5")!;
    assert.equal(uni.emissions, null); // no gauge for Uniswap pools

    const link = payload.pools.find((p) => p.id === "aero-weth-link")!;
    assert.equal(link.emissions, null); // failed sampling → null, not stale garbage

    // Price plumbing: AERO/USD + the pool's REAL on-chain token1 price + TVL.
    const awethCall = sampled.find((s) => s.pool === "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59")!;
    assert.equal(awethCall.prices.aeroUsd, 0.478222);
    assert.equal(awethCall.prices.token1Usd, 0.997135); // USDC (on-chain token1)
    assert.equal(awethCall.prices.token1Decimals, 6);
    assert.equal(awethCall.prices.poolTvlUsd, 1_000_000);
    // aero-usdt-usdc: curated display order says token1=USDC but ON-CHAIN
    // token1 is USDT (address sort) — the server must feed the USDT price.
    const stab = sampled.find((s) => s.pool === "0xa41bc0affba7fd420d186b84899d7ab2ac57fcd1")!;
    assert.equal(stab.prices.token1Usd, 0.9994);
    assert.equal(stab.prices.token1Decimals, 6);

    server.stop();
    http.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
