import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURATED_POOLS, poolById } from "@zyo/shared";
import { DEMO_ID_MAP, YieldServer } from "../src/server.js";
import { ENGINE_FEE_BPS } from "../src/model.js";
import { onchainToken1 } from "../src/sources/gauges.js";
import type { YieldConfig } from "../src/config.js";
import type { AaveSource } from "../src/sources/aave.js";
import type { GaugeSource } from "../src/sources/gauges.js";
import type { GeckoSource } from "../src/sources/gecko.js";
import type { EmissionsSample, GateVerdict, PoolBands, PoolsResponse } from "../src/types.js";
import { emissionsFixture, mcCalibrationDocFixture, NOW_MS, ratesFixture, volatilityFixture } from "./fixtures/model.js";

const STALE_AFTER = 600_000;

function cfg(dataDir: string): YieldConfig {
  return {
    baseRpcUrl: undefined, blockscoutKey: undefined, engineVault: "0x" + "0".repeat(40),
    port: 0, dataDir, samplesDir: dataDir, refreshMs: 60_000, staleAfterMs: STALE_AFTER,
    cohortWindows: [30, 60, 90], minDaysOpen: 1, logChunk: 5_000,
  };
}

const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
/** Every pool's live sample carries AERO as base and its on-chain token1 as quote (with a price). */
const geckoStub = {
  liveSample: async (poolId: string, poolAddress: string, feeTierBps: number) => {
    const p = poolById(poolId)!;
    const t1 = onchainToken1(p.token0, p.token1);
    return {
      poolId, poolAddress: poolAddress as `0x${string}`, tvlUsd: 1_000_000, volume24hUsd: 500_000,
      feeTierBps, grossFeeAprPct: 50, sampledAt: new Date().toISOString(),
      baseTokenAddress: AERO as `0x${string}`, quoteTokenAddress: (t1?.address ?? "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913") as `0x${string}`,
      baseTokenPriceUsd: 0.478, quoteTokenPriceUsd: 1,
      source: "geckoterminal" as const,
    };
  },
} as unknown as GeckoSource;

/** cbBTC/USDC in-range APRs from the 2026-08-31 words at the S4 widths. */
const CBBTC_APR = { "4500": 14.131, "2356": 27.9, "1500": 44.6286, "784": 86.0, "300": 226.8496, "150": 456.0 };

/** Clock the tests control; every sample's `at` and every serve-time `stale` read it. */
function clock(start = NOW_MS) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
}

function aaveStub(c: ReturnType<typeof clock>, fail: { v: boolean } = { v: false }): AaveSource {
  return {
    sample: async () => {
      if (fail.v) throw new Error("rpc down");
      return ratesFixture({}, c.now());
    },
  } as unknown as AaveSource;
}

function gaugesStub(c: ReturnType<typeof clock>, fail: { v: boolean } = { v: false }): GaugeSource {
  return {
    sample: async (poolId: string): Promise<EmissionsSample> => {
      if (fail.v) throw new Error("rpc down");
      if (poolId === "aero-cbzec-usdc") {
        return emissionsFixture(poolId, null, { rewardRateWeiPerSec: "0", periodFinish: 0, epochActive: false, aprByWidthPct: { "4500": 0, "2356": 0, "1500": 0, "784": 0, "300": 0, "150": 0 } }, c.now());
      }
      if (poolId === "aero-cbbtc-usdc") return emissionsFixture(poolId, CBBTC_APR, {}, c.now());
      return emissionsFixture(poolId, { "4500": 1, "2356": 1, "1500": 2, "784": 2, "300": 3, "150": 3 }, {}, c.now());
    },
  } as unknown as GaugeSource;
}

function bandsFixture(): PoolBands[] {
  const mk = (poolId: string): PoolBands => ({
    poolId, enginePoolId: ("0x" + "aa".repeat(32)) as `0x${string}`,
    computedAt: new Date().toISOString(), asOfBlock: 1,
    methodology: "closed-position-flows-v2",
    bands: [30, 60, 90].map((w) => ({
      windowDays: w, n: 12, excluded: 1, totalPrincipalUsd: 250_000, meanDaysOpen: 9,
      excludedReasons: { unpriced: 1, ambiguous_entry: 0, short_position: 0, dust_principal: 0, absurd_outcome: 0 },
      p10: -10, p25: 18, p50: 34, p75: 55, p90: 90, medianUnweighted: 30,
    })),
  });
  return [mk("aero-usdc-weth-5"), mk("aero-cbbtc-usdc")];
}

async function get(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}

/**
 * Runs `fn` with a temp data dir and ALWAYS closes whatever server the test
 * started (a failing assertion must not leave a listener alive and hang the
 * runner).
 */
async function withServer<T>(fn: (dir: string, track: (s: YieldServer, h: import("node:http").Server) => void) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "yield-srv-"));
  const started: [YieldServer, import("node:http").Server][] = [];
  try {
    return await fn(dir, (s, h) => started.push([s, h]));
  } finally {
    for (const [s, h] of started) {
      s.stop();
      h.close();
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("/v1/pools: live samples, emissions, gate verdicts per setting × collateral, bands, Aave rates; cbZEC pool tracked and never offered", async () => {
  await withServer(async (dir, track) => {
    writeFileSync(join(dir, "bands.json"), JSON.stringify(bandsFixture()));
    const c = clock();
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, aave: aaveStub(c), gauges: gaugesStub(c), volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;

    const pools = await get(port, "/v1/pools");
    assert.equal(pools.status, 200);
    const payload = pools.body as PoolsResponse;
    assert.equal(payload.stale, false);
    assert.equal(payload.pools.length, CURATED_POOLS.length);
    assert.equal(payload.rates!.borrow.variableBorrowAprPct, 4.828);
    assert.equal(payload.rates!.stale, false);

    const cbbtc = payload.pools.find((p) => p.id === "aero-cbbtc-usdc")!;
    assert.equal(cbbtc.live!.grossFeeAprPct, 50);
    assert.equal(cbbtc.bands!.bands[0]!.p50, 34);
    assert.equal(cbbtc.emissions!.stale, false);
    assert.equal(cbbtc.emissions!.epochActive, true);
    assert.equal(cbbtc.gate.length, 3 * 3); // settings × registry collateral
    const sheltered = cbbtc.gate.find((g: GateVerdict) => g.setting === "sheltered" && g.collateral === "cbBTC")!;
    assert.equal(sheltered.qualifies, false);
    assert.equal(sheltered.reason, "net_below_borrow");
    assert.ok(Math.abs(sheltered.lpNetPct! - -5.29) < 0.02);
    assert.equal(sheltered.userNet.length, 3);

    const zec = payload.pools.find((p) => p.id === "aero-cbzec-usdc")!;
    assert.equal(zec.protocol, "DIRECT");
    assert.ok(zec.note && zec.note.includes("No emissions"));
    assert.equal(zec.emissions!.epochActive, false);
    assert.ok(zec.gate.every((g: GateVerdict) => !g.qualifies));
    assert.ok(zec.gate.filter((g: GateVerdict) => g.collateral !== "cbZEC").every((g: GateVerdict) => g.reason === "no_emissions"));

    const uni = payload.pools.find((p) => p.id === "uni-weth-usdc-5")!;
    assert.equal(uni.bands, null);
    assert.equal(uni.bandsUnavailableReason, "backfill_pending");
    assert.deepEqual(uni.gate, []); // not an Aerodrome pool → no gauge, no gate
    assert.equal(uni.emissions, null);

    const rates = await get(port, "/v1/rates");
    assert.equal(rates.status, 200);
    assert.equal(rates.body.stale, false);
    assert.equal(rates.body.collateral.WETH.liquidationThresholdBps, 8300);

    const health = await get(port, "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.sources.rates.stale, false);
  });
});

test("STALENESS CONTRACT: a dead source can never serve as fresh — stale is derived from sampledAt at serve time", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const fail = { v: false };
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, aave: aaveStub(c, fail), gauges: gaugesStub(c, fail), volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;

    // t0: fresh
    let r = await get(port, "/v1/rates");
    assert.equal(r.body.stale, false);
    let p = (await get(port, "/v1/pools")).body as PoolsResponse;
    assert.equal(p.stale, false);
    assert.equal(p.pools.find((x) => x.id === "aero-cbbtc-usdc")!.emissions!.stale, false);

    // the sources die; refreshes keep the last good values …
    fail.v = true;
    await server.refresh();
    r = await get(port, "/v1/rates");
    assert.equal(r.status, 200);
    assert.equal(r.body.borrow.variableBorrowAprPct, 4.828);
    assert.equal(r.body.stale, false); // still inside the window — honest
    // … and time passes past staleAfterMs with no successful sample: stale flips, without any code storing it
    c.advance(STALE_AFTER + 1);
    await server.refresh(); // fails again
    r = await get(port, "/v1/rates");
    assert.equal(r.status, 200);
    assert.equal(r.body.stale, true);
    p = (await get(port, "/v1/pools")).body as PoolsResponse;
    assert.equal(p.stale, true);
    assert.equal(p.rates!.stale, true);
    const cbbtc = p.pools.find((x) => x.id === "aero-cbbtc-usdc")!;
    assert.equal(cbbtc.emissions!.stale, true);
    // the gate refuses everything on stale inputs
    assert.ok(cbbtc.gate.every((g: GateVerdict) => !g.qualifies && (g.reason === "rates_stale" || g.reason === "collateral_disabled")));
    // /v1/gate fails CLOSED
    const gate = await get(port, "/v1/gate");
    assert.equal(gate.status, 503);
    assert.equal(gate.body.reason, "rates_stale");
    // a serve N times later is still stale (no refresh success can be faked by serving)
    c.advance(10 * STALE_AFTER);
    assert.equal((await get(port, "/v1/rates")).body.stale, true);

    // the source recovers → fresh again, from the NEW sampledAt
    fail.v = false;
    await server.refresh();
    r = await get(port, "/v1/rates");
    assert.equal(r.body.stale, false);
    assert.equal(r.body.sampledAt, new Date(c.now()).toISOString());
    assert.equal((await get(port, "/v1/gate")).status, 200);
  });
});

test("STALENESS CONTRACT: a lapsed gauge epoch can never keep serving as active (re-derived at serve time)", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const fail = { v: false };
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, aave: aaveStub(c, fail), gauges: gaugesStub(c, fail), volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    await server.refresh();
    fail.v = true; // gauge RPC dies with an epochActive:true sample in hand
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;
    // jump past periodFinish (5 days in the fixture) — still inside nothing else; the epoch itself lapsed
    c.advance(6 * 86_400_000);
    const p = (await get(port, "/v1/pools")).body as PoolsResponse;
    const cbbtc = p.pools.find((x) => x.id === "aero-cbbtc-usdc")!;
    assert.equal(cbbtc.emissions!.epochActive, false);
    assert.equal(cbbtc.emissions!.stale, true);  });
});

test("/v1/rates is 503 while never sampled (fail closed), with a fixed reason enum — no upstream text", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, aave: aaveStub(c, { v: true }), gauges: gaugesStub(c), volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;
    const r = await get(port, "/v1/rates");
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: "rates_unavailable", reason: "upstream_unavailable" });
    const g = await get(port, "/v1/gate");
    assert.equal(g.status, 503);
    assert.equal(g.body.reason, "rates_unavailable");
    const b = await get(port, "/v1/band?ltv=0.4&mix=acbbtc&collateral=cbBTC");
    assert.equal(b.status, 503);
    // /v1/pools still serves (with null rates, every gate refused)
    const p = (await get(port, "/v1/pools")).body as PoolsResponse;
    assert.equal(p.rates, null);
    assert.equal(p.stale, true);
    assert.ok(p.pools.flatMap((x) => x.gate).every((v: GateVerdict) => !v.qualifies));  });
});

test("/v1/gate: every pool × setting × collateral, filterable; qualifying list is empty at 4.828 % with the recorded sample", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, aave: aaveStub(c), gauges: gaugesStub(c), volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;

    const all = await get(port, "/v1/gate");
    assert.equal(all.status, 200);
    assert.equal(all.body.borrowAprPct, 4.828);
    const aeroPools = CURATED_POOLS.filter((p) => p.dex === "AERODROME").length;
    assert.equal(all.body.verdicts.length, aeroPools * 3 * 3);
    assert.deepEqual(all.body.qualifying, []);
    assert.equal(all.body.settings.length, 3);

    const one = await get(port, "/v1/gate?pool=acbbtc&setting=steady&collateral=WETH");
    assert.equal(one.status, 200);
    assert.equal(one.body.verdicts.length, 1);
    assert.equal(one.body.verdicts[0].poolId, DEMO_ID_MAP.acbbtc);
    assert.equal(one.body.verdicts[0].rangeWidthBps, 1500);
    assert.equal(one.body.verdicts[0].collateralSupplyAprPct, 1.843);
    assert.equal(one.body.verdicts[0].reason, "net_below_borrow");

    const byPreset = await get(port, "/v1/gate?setting=AGGRESSIVE");
    assert.ok(byPreset.body.verdicts.every((v: GateVerdict) => v.preset === "AGGRESSIVE"));

    assert.equal((await get(port, "/v1/gate?pool=nope")).status, 400);
    assert.equal((await get(port, "/v1/gate?setting=nope")).status, 400);
    assert.equal((await get(port, "/v1/gate?collateral=ZEC")).status, 400);
    assert.equal((await get(port, "/v1/gate?pool=__proto__")).status, 400);
  });
});

test("/v1/band: requires a collateral; supply and borrow are the LIVE Aave figures for it; math pins", async () => {
  await withServer(async (dir, track) => {
    writeFileSync(join(dir, "bands.json"), JSON.stringify(bandsFixture()));
    const c = clock();
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, aave: aaveStub(c), gauges: gaugesStub(c), volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;

    const r = await get(port, "/v1/band?ltv=0.40&mix=aweth,acbbtc,acbbtc&collateral=WETH");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.mix, [DEMO_ID_MAP.aweth, DEMO_ID_MAP.acbbtc]); // deduped
    assert.equal(r.body.collateralSupplyAprPct, 1.843);
    assert.equal(r.body.borrowAprPct, 4.828);
    const w30 = r.body.windows.find((w: { windowDays: number }) => w.windowDays === 30)!;
    assert.equal(w30.poolsWithData, 2);
    // p50: 1.843 + 0.4 × (34 × 0.9 − 4.828) = 1.843 + 0.4 × 25.772 = 12.1518 → 12.15
    assert.equal(w30.band.p50, 12.15);

    assert.equal((await get(port, "/v1/band?ltv=0.4&mix=aweth")).status, 400); // no collateral
    assert.equal((await get(port, "/v1/band?ltv=0.4&mix=aweth&collateral=cbZEC")).status, 503); // not an Aave collateral in the sample
    assert.equal((await get(port, "/v1/band?ltv=0.9&mix=aweth&collateral=cbBTC")).status, 400);
    assert.equal((await get(port, "/v1/band?ltv=0.4&collateral=cbBTC")).status, 400);
    assert.equal((await get(port, "/v1/band?ltv=0.4&mix=constructor&collateral=cbBTC")).status, 400);
  });
});

test("handler robustness: bad request-targets are 400, unknown paths 404, non-GET 405", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const server = new YieldServer(cfg(dir), { gecko: geckoStub, aave: aaveStub(c), gauges: gaugesStub(c), volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;
    assert.equal((await get(port, "/nope")).status, 404);
    const post = await fetch(`http://127.0.0.1:${port}/v1/pools`, { method: "POST" });
    assert.equal(post.status, 405);  });
});

test("FIX D-MED-5: /v1/pools payload staleness includes EMISSIONS, and each pool's live sample carries its own stale flag", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const gaugesFail = { v: false };
    const server = new YieldServer(cfg(dir), {
      gecko: geckoStub, aave: aaveStub(c), gauges: gaugesStub(c, gaugesFail),
      volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now,
    });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;

    let p = (await get(port, "/v1/pools")).body as PoolsResponse;
    assert.equal(p.stale, false);
    const cbbtc0 = p.pools.find((x) => x.id === "aero-cbbtc-usdc")!;
    assert.equal((cbbtc0.live as unknown as { stale: boolean }).stale, false, "each live sample carries its own stale");

    // Only the GAUGES die. The rates and live samples keep refreshing, so the
    // old payload-level `stale` (rates + live only) read false while the
    // per-pool emissions.stale said true — the headline lied.
    gaugesFail.v = true;
    c.advance(STALE_AFTER + 1);
    await server.refresh();
    p = (await get(port, "/v1/pools")).body as PoolsResponse;
    const cbbtc = p.pools.find((x) => x.id === "aero-cbbtc-usdc")!;
    assert.equal(cbbtc.emissions!.stale, true, "the emissions sample is stale");
    assert.equal(p.rates!.stale, false, "the rates are still fresh");
    assert.equal((cbbtc.live as unknown as { stale: boolean }).stale, false, "the live sample is still fresh");
    assert.equal(p.stale, true, "the headline flag must reflect the stale emissions");
  });
});

test("FIX D-MED-5: /healthz fails when the sources are dead, and reports per-source fresh/stale counts", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const fail = { v: false };
    // A gecko that dies with the rest — otherwise the live samples keep
    // refreshing and "every source is dead" is not the scenario under test.
    const gecko = {
      liveSample: async (...args: Parameters<GeckoSource["liveSample"]>) => {
        if (fail.v) throw new Error("gecko down");
        return geckoStub.liveSample(...args);
      },
    } as unknown as GeckoSource;
    const server = new YieldServer(cfg(dir), {
      gecko, aave: aaveStub(c, fail), gauges: gaugesStub(c, fail),
      volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now,
    });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;

    let h = await get(port, "/healthz");
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    assert.deepEqual(h.body.degraded, []);
    assert.ok(h.body.sources.livePools.fresh > 0 && h.body.sources.livePools.stale === 0);
    assert.ok(h.body.sources.emissionsPools.fresh > 0);
    assert.ok(h.body.uptimeS >= 0, "uptime is read from the injected clock, never Date.now()");

    // everything dead for five hours
    fail.v = true;
    c.advance(5 * 60 * 60 * 1000);
    await server.refresh();
    h = await get(port, "/healthz");
    assert.equal(h.status, 503, "a monitor must be able to see a dead service");
    assert.equal(h.body.ok, false);
    for (const d of ["rates_stale", "live_samples_stale", "emissions_stale"]) {
      assert.ok((h.body.degraded as string[]).includes(d), `degraded should name ${d}: ${h.body.degraded}`);
    }
    assert.equal(h.body.sources.rates.stale, true);
    assert.equal(h.body.sources.livePools.fresh, 0);
    assert.ok(h.body.sources.livePools.stale > 0, "stale entries are counted, not just 'has a value'");
    assert.equal(h.body.sources.emissionsPools.fresh, 0);
    assert.ok(h.body.uptimeS >= 5 * 3600);
  });
});

test("FIX D-MED-5: a missing MC calibration is a DEGRADED service — the gate can offer nothing", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const server = new YieldServer(cfg(dir), {
      gecko: geckoStub, aave: aaveStub(c), gauges: gaugesStub(c),
      volatility: volatilityFixture(), mcCalibration: null, now: c.now,
    });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;
    const h = await get(port, "/healthz");
    assert.equal(h.status, 503);
    assert.ok((h.body.degraded as string[]).includes("mc_calibration_unavailable"));
    const g = await get(port, "/v1/gate");
    assert.equal(g.status, 200);
    assert.deepEqual(g.body.qualifying, []);
  });
});

test("FIX D-MED-6: /v1/gate emits stale, emissionsSampledAt and engineFeeBps — the three fields web/lib/gate.ts has always read", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const gaugesFail = { v: false };
    const server = new YieldServer(cfg(dir), {
      gecko: geckoStub, aave: aaveStub(c), gauges: gaugesStub(c, gaugesFail),
      volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now,
    });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;

    const g = (await get(port, "/v1/gate")).body;
    // Without these the client's staleness banner never fires and the
    // `&& !stale` term in its own qualifies re-derivation is dead code.
    assert.equal(typeof g.stale, "boolean");
    assert.equal(g.stale, false);
    assert.equal(typeof g.emissionsSampledAt, "string");
    assert.equal(g.engineFeeBps, ENGINE_FEE_BPS);
    // every key normalizeGate reads is present
    for (const k of ["borrowAprPct", "ratesSampledAt", "emissionsSampledAt", "volatilityAsOf", "engineFeeBps", "stale", "settings", "verdicts", "generatedAt"]) {
      assert.ok(k in g, `/v1/gate payload is missing ${k}`);
    }

    // Emissions staleness is the ONE kind /v1/gate does not 503 on, so it must
    // surface here or it surfaces nowhere.
    gaugesFail.v = true;
    c.advance(STALE_AFTER + 1);
    await server.refresh();
    const s = (await get(port, "/v1/gate")).body;
    assert.equal(s.stale, true, "stale emissions must reach the client");
    assert.ok(s.verdicts.every((v: GateVerdict) => !v.qualifies));
    assert.ok(s.verdicts.some((v: GateVerdict) => v.reason === "emissions_stale"));
  });
});

test("FIX D-HIGH-1: /v1/gate serves mcLpNetPct alongside the published lpNetPct on every priced cell", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const server = new YieldServer(cfg(dir), {
      gecko: geckoStub, aave: aaveStub(c), gauges: gaugesStub(c),
      volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now,
    });
    const http = await server.start();
    track(server, http);
    const port = (http.address() as { port: number }).port;
    const g = (await get(port, "/v1/gate")).body;
    const priced = (g.verdicts as GateVerdict[]).filter((v) => v.lpNetPct !== null);
    assert.ok(priced.length > 0);
    for (const v of priced) {
      assert.ok(v.mcLpNetPct !== null, `${v.poolId}/${v.setting}: priced without an MC number`);
      if (v.qualifies) assert.ok(v.mcLpNetPct! > v.borrowAprPct!);
    }
    assert.equal(typeof g.mcCalibrationGeneratedAt, "string");
  });
});
