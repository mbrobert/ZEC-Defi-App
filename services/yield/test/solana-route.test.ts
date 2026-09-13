/**
 * GET /v1/solana/borrow and the Kamino entry in /healthz: served from the last sample, stale by age at serve time,
 * honest about an unconfigured source, and keeping the last good sample through a failed read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { YieldConfig } from "../src/config.js";
import { YieldServer } from "../src/server.js";
import type { GeckoSource } from "../src/sources/gecko.js";
import type { KaminoSource } from "../src/sources/kamino.js";
import { kaminoSampleFixture } from "./fixtures/kamino.js";
import { mcCalibrationDocFixture, NOW_MS, volatilityFixture } from "./fixtures/model.js";

const STALE_AFTER = 600_000;
const cfg = (dataDir: string): YieldConfig => ({
  baseRpcUrl: undefined, blockscoutKey: undefined, engineVault: "0x" + "0".repeat(40), solanaRpcUrl: undefined,
  port: 0, dataDir, samplesDir: dataDir, refreshMs: 60_000, staleAfterMs: STALE_AFTER, cohortWindows: [30], minDaysOpen: 1, logChunk: 5_000,
});
const geckoOff = { liveSample: async () => { throw new Error("gecko off in this test"); } } as unknown as GeckoSource;
function clock(start = NOW_MS) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
function kaminoStub(c: ReturnType<typeof clock>, fail: { v: boolean } = { v: false }): KaminoSource {
  return { sample: async () => { if (fail.v) throw new Error("solana rpc down"); return kaminoSampleFixture(c.now()); } } as unknown as KaminoSource;
}
async function get(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}
async function withServer<T>(fn: (dir: string, track: (s: YieldServer, h: import("node:http").Server) => void) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "yield-solana-"));
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
const port = (h: import("node:http").Server) => (h.address() as { port: number }).port;

test("/v1/solana/borrow: the pool view from the last sample, the chosen-HF view with Kamino's cap named, the floor's source said", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const server = new YieldServer(cfg(dir), { gecko: geckoOff, registry: null, kamino: kaminoStub(c), volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    const http = await server.start();
    track(server, http);
    const pool = await get(port(http), "/v1/solana/borrow");
    assert.equal(pool.status, 200);
    assert.equal(pool.body.configured, true);
    assert.equal(pool.body.chain, "solana");
    assert.equal(pool.body.slot, 446_506_191);
    assert.equal(pool.body.stale, false);
    assert.deepEqual(pool.body.refusals, []);
    assert.equal(pool.body.allowed, true);
    assert.equal(pool.body.poolAvailableUsdc, 355_599.95);
    assert.equal(pool.body.entryHfFloorSource, "shared");
    assert.equal(pool.body.sampledAt, new Date(NOW_MS).toISOString());
    assert.match(pool.body.methodologyUrl, /SOLANA-ARCHITECTURE/);
    const chosen = await get(port(http), "/v1/solana/borrow?collateral=10&entryHf=1.55");
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.bindingCap, "venue_max_ltv");
    assert.ok(Math.abs(chosen.body.hfAtEntry - 1.625) < 0.001);
    assert.ok(chosen.body.disclosures.includes("liquidation_at_chosen_hf"));
    const typed = await get(port(http), "/v1/solana/borrow?collateral=10&amount=100000");
    assert.equal(typed.status, 200);
    assert.ok(typed.body.refusals.includes("venue_ltv_exceeded"));
    assert.equal(typed.body.allowed, false);
    const health = await get(port(http), "/healthz");
    assert.equal(health.body.sources.kamino.slot, 446_506_191);
    assert.equal(health.body.sources.kamino.stale, false);
    assert.ok(!health.body.degraded.some((d: string) => d.startsWith("kamino")));
  });
});

test("/v1/solana/borrow: malformed parameters are 400 with a plain message, never a 500", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const server = new YieldServer(cfg(dir), { gecko: geckoOff, registry: null, kamino: kaminoStub(c), volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    const http = await server.start();
    track(server, http);
    for (const [qs, re] of [["collateral=abc", /collateral/], ["amount=-5", /amount/], ["entryHf=0.5", /entryHf/], ["collateral=0", /collateral/]] as const) {
      const r = await get(port(http), `/v1/solana/borrow?${qs}`);
      assert.equal(r.status, 400, qs);
      assert.match(r.body.error, re);
    }
  });
});

test("staleness is decided at serve time: past staleAfterMs the view refuses kamino_stale and /healthz degrades; a failed read keeps the last good sample", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const fail = { v: false };
    const server = new YieldServer(cfg(dir), { gecko: geckoOff, registry: null, kamino: kaminoStub(c, fail), volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    const http = await server.start();
    track(server, http);
    const firstAt = new Date(NOW_MS).toISOString();
    fail.v = true;
    c.advance(120_000);
    await server.refresh();
    const kept = await get(port(http), "/v1/solana/borrow");
    assert.equal(kept.body.sampledAt, firstAt, "the failed read did not erase the last good sample");
    assert.equal(kept.body.stale, false);
    c.advance(STALE_AFTER);
    const stale = await get(port(http), "/v1/solana/borrow?collateral=10&entryHf=1.6");
    assert.equal(stale.status, 200);
    assert.equal(stale.body.stale, true);
    assert.deepEqual(stale.body.refusals, ["kamino_stale"]);
    assert.equal(stale.body.allowed, false);
    assert.equal(stale.body.hfAtEntry, null, "no number is computed from a stale read");
    const health = await get(port(http), "/healthz");
    assert.equal(health.status, 503);
    assert.ok(health.body.degraded.includes("kamino_stale"));
    assert.equal(health.body.sources.kamino.stale, true);
    fail.v = false;
    await server.refresh();
    const again = await get(port(http), "/v1/solana/borrow");
    assert.equal(again.body.stale, false);
    assert.deepEqual(again.body.refusals, []);
  });
});

test("no SOLANA_RPC_URL: the route answers kamino_unavailable and says the source is not configured; /healthz does not count it as degraded", async () => {
  await withServer(async (dir, track) => {
    const c = clock();
    const server = new YieldServer(cfg(dir), { gecko: geckoOff, registry: null, kamino: null, volatility: volatilityFixture(), mcCalibration: mcCalibrationDocFixture(), now: c.now });
    const http = await server.start();
    track(server, http);
    const r = await get(port(http), "/v1/solana/borrow?collateral=10&entryHf=1.55");
    assert.equal(r.status, 200);
    assert.equal(r.body.configured, false);
    assert.deepEqual(r.body.refusals, ["kamino_unavailable"]);
    assert.equal(r.body.allowed, false);
    assert.equal(r.body.zecPriceUsd, null);
    const health = await get(port(http), "/healthz");
    assert.equal(health.body.sources.kamino, "not_configured");
    assert.ok(!health.body.degraded.some((d: string) => d.startsWith("kamino")));
  });
});
