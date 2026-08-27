import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEMO_ID_MAP, YieldServer } from "../src/server.js";
import type { YieldConfig } from "../src/config.js";
import type { GeckoSource } from "../src/sources/gecko.js";
import type { RheaRates } from "../src/rhea.js";
import type { PoolBands, PoolsResponse } from "../src/types.js";

function cfg(dataDir: string): YieldConfig {
  return {
    baseRpcUrl: undefined, blockscoutKey: undefined,
    nearRpcUrl: "http://unused.invalid", rheaLendingContract: "x", rheaUsdcTokenId: "y",
    rheaZecTokenId: "z", engineVault: "0x" + "0".repeat(40),
    port: 0, dataDir, refreshMs: 60_000, staleAfterMs: 600_000,
    cohortWindows: [30, 60, 90], minDaysOpen: 1, logChunk: 5_000,
  };
}

const geckoStub = {
  liveSample: async (poolId: string, poolAddress: string, feeTierBps: number) => ({
    poolId, poolAddress: poolAddress as `0x${string}`, tvlUsd: 1_000_000, volume24hUsd: 500_000,
    feeTierBps, grossFeeAprPct: 50, sampledAt: new Date().toISOString(),
    source: "geckoterminal" as const,
  }),
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
    assert.equal(aweth.bands!.bands[0].p50, 34);
    const noBands = payload.pools.find((p) => p.id === "uni-weth-usdc-5")!;
    assert.equal(noBands.bands, null);
    assert.equal(noBands.bandsUnavailableReason, "backfill_pending");
    assert.equal(payload.rates!.borrowAprPct, 13.56);

    const rates = await get(port, "/v1/rates");
    assert.equal(rates.status, 200);

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

test("stale-while-revalidate: failing sources keep last good data flagged stale", async () => {
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

    const server = new YieldServer(cfg(dir), { gecko: flaky, rhea: rheaFlaky });
    await server.refresh();
    fail = true;
    await server.refresh(); // sources down — previous values must survive
    const http = await server.start();
    const port = (http.address() as { port: number }).port;
    const pools = (await get(port, "/v1/pools")).body as PoolsResponse;
    assert.ok(pools.pools.some((p) => p.live !== null));
    assert.equal(pools.rates!.borrowAprPct, 13.56);
    server.stop();
    http.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
