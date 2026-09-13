import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ENTRY_HF_FLOOR, hfFromWad, poolById } from "@zyo/shared";
import { aaveBorrowAprAfterPct, aaveVariableBorrowAprPct, availableUnits, evaluateForecast, evaluateForecastPool, hfIdentity, MAX_ENTRY_HF, type ForecastInputs, venueBorrowAprAfterPct, type ForecastVenueBorrow } from "../src/forecast.js";
import { evaluateGate } from "../src/gate.js";
import { SETTINGS } from "../src/model.js";
import { YieldServer } from "../src/server.js";
import type { YieldConfig } from "../src/config.js";
import type { AaveSource } from "../src/sources/aave.js";
import type { GaugeSource } from "../src/sources/gauges.js";
import type { GeckoSource } from "../src/sources/gecko.js";
import type { RegistrySource } from "../src/sources/registry.js";
import type { EmissionsSample, ForecastCell, ForecastResponse } from "../src/types.js";
import { borrowCurveFixture, emissionsFixture, mcCalibrationDocFixture, mcCalibrationFixture, NOW_MS, NOW_S, ratesFixture, reserve, volatilityFixture } from "./fixtures/model.js";

const cbbtcUsdc = poolById("aero-cbbtc-usdc")!;
const sheltered = SETTINGS.find((s) => s.id === "sheltered")!;
/** cbBTC/USDC in-range APRs from the 2026-08-31 words at the served widths (the gate tests' fixture). */
const CBBTC_APR = { "4500": 14.131, "2356": 27.9, "1500": 44.6286, "784": 86.0, "300": 226.8496, "150": 456.0 };

function inputs(over: Partial<ForecastInputs> = {}): ForecastInputs {
  return {
    pool: cbbtcUsdc,
    setting: sheltered,
    collateral: "cbBTC",
    rates: { ...ratesFixture(), stale: false },
    emissions: { ...emissionsFixture(cbbtcUsdc.id, CBBTC_APR), stale: false },
    volatility: volatilityFixture(),
    mcCalibration: mcCalibrationFixture(),
    nowSeconds: NOW_S,
    entryHf: 1.55,
    depositUsd: null,
    collateralPriceUsd: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The identity and the curve — pure arithmetic against chain-read numbers
// ---------------------------------------------------------------------------

test("the identity: LT 78 % at HF 1.55 → LTV 50.32 % and a −35.48 % drawdown; 1.30 → 60 % / −23.08 %; 1.25 → 62.4 % / −20 % (BUILD-PLAN §2b)", () => {
  assert.deepEqual(hfIdentity(7800, 1.55), { ltvAtEntryBps: 5032, drawdownToLiquidationPct: -0 + 35.48 });
  assert.deepEqual(hfIdentity(7800, 1.3), { ltvAtEntryBps: 6000, drawdownToLiquidationPct: 23.08 });
  assert.deepEqual(hfIdentity(7800, 1.25), { ltvAtEntryBps: 6240, drawdownToLiquidationPct: 20 });
  // Kamino ZEC: LT 65 % at the most Kamino allows (HF 1.625) → LTV 40 %, −38.46 %.
  assert.deepEqual(hfIdentity(6500, 1.625), { ltvAtEntryBps: 4000, drawdownToLiquidationPct: 38.46 });
  assert.throws(() => hfIdentity(7800, 0.99), RangeError);
});

test("the Aave curve reproduces the live USDC rate at block 51,227,701 (86.45 % utilisation → 4.5147 % against the 4.5146 % word) and kinks at 90 %", () => {
  const curve = borrowCurveFixture();
  const usdc = reserve("USDC");
  const now = aaveBorrowAprAfterPct(curve, usdc, 0n)!;
  assert.ok(Math.abs(now - 4.5146) <= 0.002, `curve at Δ=0 is ${now}, live word 4.5146 (the strategy's denominator differs from totalAToken by the treasury accrual)`);
  assert.equal(aaveVariableBorrowAprPct(curve, 9000), 4.7, "at the kink the rate is base + slope1");
  assert.equal(aaveVariableBorrowAprPct(curve, 10_000), 14.7, "at 100 % it is base + slope1 + slope2");
  assert.equal(aaveVariableBorrowAprPct(curve, 0), 0);
  // A $1 M borrow moves Base's pool by 0.55 points of utilisation; the rate follows the first slope.
  const after1m = aaveBorrowAprAfterPct(curve, usdc, 1_000_000_000_000n)!;
  assert.ok(after1m > now && after1m - now < 0.05, `+$1 M → ${after1m}`);
  // More than the pool holds cannot be priced — that is the pool_cannot_fund refusal.
  assert.equal(aaveBorrowAprAfterPct(curve, usdc, availableUnits(usdc) + 1n), null);
  assert.equal(aaveBorrowAprAfterPct(curve, usdc, availableUnits(usdc)), 14.7, "borrowing every unit lands exactly at 100 %");
  assert.throws(() => aaveVariableBorrowAprPct(curve, 10_001), RangeError);
});

// ---------------------------------------------------------------------------
// The evaluator
// ---------------------------------------------------------------------------

test("a cell the gate refuses net_below_borrow is PRICED by the forecast, with both forms, the gap, the break-evens and user net — and clearsBorrow false on both", () => {
  const gate = evaluateGate({ ...inputs() });
  assert.equal(gate.qualifies, false);
  assert.equal(gate.reason, "net_below_borrow");
  const f = evaluateForecast(inputs());
  assert.equal(f.lpPriced, true);
  assert.equal(f.lpUnpricedReason, null);
  assert.equal(f.lpNetPct, gate.lpNetPct, "the same closed form as the gate");
  assert.equal(f.mcLpNetPct, gate.mcLpNetPct, "the same Monte-Carlo form as the gate");
  assert.equal(f.dragPct, gate.dragPct);
  assert.equal(f.breakEvenSigma, gate.breakEvenSigma);
  assert.equal(f.breakEvenEmissionsMultiple, gate.breakEvenEmissionsMultiple);
  assert.equal(f.modelGapPts, Math.round((f.lpNetPct! - f.mcLpNetPct!) * 100) / 100);
  assert.deepEqual(f.clearsBorrow, { closedForm: false, monteCarlo: false, both: false });
  assert.equal(f.ltvAtEntryBps, 5032);
  assert.equal(f.userNetBorrowBasis, "now", "no deposit size → today's borrow rate");
  // userNet = supply + LTV × (lpNet − borrow) at the chosen LTV, not at a preset.
  const expected = 0.012 + 0.5032 * (f.lpNetPct! - 4.828);
  assert.ok(Math.abs(f.userNetPct! - expected) < 0.011, `${f.userNetPct} vs ${expected}`);
  assert.deepEqual(f.refusals, []);
  assert.equal(f.allowed, true, "a negative forecast is shown and allowed (D4)");
  assert.ok(f.disclosures.includes("model_uncertainty") && f.disclosures.includes("impermanent_loss") && f.disclosures.includes("emissions_dilutable"));
  assert.ok(!f.disclosures.includes("no_forecast"));
});

test("a cell the gate refuses BEFORE pricing (emissions_below_borrow) is still priced: drag, both forms and a null break-even σ", () => {
  // Emissions far below the borrow at every width.
  const low = { "4500": 0.5, "2356": 1, "1500": 1.5, "784": 2, "300": 3, "150": 4 };
  const g = evaluateGate(inputs({ emissions: { ...emissionsFixture(cbbtcUsdc.id, low), stale: false } }));
  assert.equal(g.reason, "emissions_below_borrow");
  assert.equal(g.lpNetPct, null, "the gate publishes nothing past the borrow check");
  const f = evaluateForecast(inputs({ emissions: { ...emissionsFixture(cbbtcUsdc.id, low), stale: false } }));
  assert.equal(f.lpPriced, true);
  assert.ok(f.lpNetPct! < 0 && f.dragPct! < 0);
  assert.ok(typeof f.mcLpNetPct === "number");
  assert.equal(f.breakEvenSigma, null, "no σ clears the borrow when emissions do not");
  assert.ok(f.breakEvenEmissionsMultiple! > 1);
  assert.deepEqual(f.clearsBorrow, { closedForm: false, monteCarlo: false, both: false });
  assert.equal(f.allowed, true);
});

test("a gauge that pays nothing is a priced cell — the LP slice is the drag alone; a pool with no σ is unpriced by name and still allowed", () => {
  const f = evaluateForecast(inputs({ emissions: { ...emissionsFixture(cbbtcUsdc.id, CBBTC_APR, { rewardRateWeiPerSec: "0", epochActive: false }), stale: false } }));
  assert.equal(f.lpPriced, true);
  assert.equal(f.emissionsNetPct, 0);
  assert.equal(f.lpNetPct, f.dragPct);
  assert.ok(!f.disclosures.includes("emissions_dilutable"));
  const noSigma = evaluateForecast(inputs({ volatility: { asOf: "x", method: "m", pools: {} } }));
  assert.equal(noSigma.lpPriced, false);
  assert.equal(noSigma.lpUnpricedReason, "no_volatility_input");
  assert.equal(noSigma.lpNetPct, null);
  assert.equal(noSigma.allowed, true, "an unpriced cell is shown as unpriced, not refused (D4)");
  assert.ok(noSigma.disclosures.includes("no_forecast"));
  // The position side does not depend on emissions: the identity is still there.
  assert.equal(noSigma.ltvAtEntryBps, 5032);
  assert.equal(noSigma.drawdownToLiquidationPct, 35.48);
});

test("the safety refusals, each by name: below the floor, disabled asset, no rates, stale rates, inactive, paused (both sides), the venue's LTV, and a borrow the pool cannot fund", () => {
  const floor = evaluateForecast(inputs({ entryHf: 1.2 }));   // under the pinned 1.25 floor
  assert.deepEqual(floor.refusals, ["entry_hf_below_floor"]);
  assert.deepEqual(evaluateForecast(inputs({ entryHf: 1.5 })).refusals, [], "1.50 was under the old 1.55 floor; it is allowed at 1.25");
  assert.equal(floor.allowed, false);
  assert.equal(floor.lpPriced, true, "the numbers are still shown beside the refusal");
  assert.deepEqual(evaluateForecast(inputs({ collateral: "cbZEC" })).refusals, ["collateral_disabled", "collateral_not_active"]);
  assert.deepEqual(evaluateForecast(inputs({ rates: null })).refusals, ["rates_unavailable"]);
  assert.deepEqual(evaluateForecast(inputs({ rates: { ...ratesFixture(), stale: true } })).refusals, ["rates_stale"]);
  const frozen = ratesFixture({ collateral: { cbBTC: reserve("cbBTC", { isFrozen: true }), WETH: reserve("WETH") } });
  assert.deepEqual(evaluateForecast(inputs({ rates: { ...frozen, stale: false } })).refusals, ["collateral_not_active"]);
  const paused = ratesFixture({ borrow: reserve("USDC", { isPaused: true }), collateral: { cbBTC: reserve("cbBTC", { isPaused: true }), WETH: reserve("WETH") } });
  assert.deepEqual(evaluateForecast(inputs({ rates: { ...paused, stale: false } })).refusals, ["collateral_paused", "borrow_paused"]);
  // A floor below the venue's own LTV: at HF 1.05 on LT 78 % the LTV (74.28 %) exceeds Aave's 73 %.
  const venue = evaluateForecast(inputs({ entryHf: 1.05, entryHfFloor: 1.0 }));
  assert.deepEqual(venue.refusals, ["venue_ltv_exceeded"]);
  assert.equal(venue.bindingCap, "venue_max_ltv");
  // The pool holds 24,768,504 USDC in the fixture; a $100 M deposit at 50.32 % asks for twice that.
  const big = evaluateForecast(inputs({ depositUsd: 100_000_000 }));
  assert.deepEqual(big.refusals, ["pool_cannot_fund"]);
  assert.equal(big.bindingCap, "pool_liquidity");
  assert.equal(big.borrowAprAfterPct, null);
  assert.equal(Math.round(big.poolAvailableUsd!), 24_768_504);
});

test("with a deposit size the borrow is priced AFTER itself on the venue curve, user net uses that rate, and the liquidation price follows the collateral price", () => {
  const f = evaluateForecast(inputs({ depositUsd: 1_000_000, collateralPriceUsd: 115_000 }));
  assert.equal(f.borrowUsd, 503_200, "$1 M × 50.32 %");
  assert.ok(f.borrowAprAfterPct! > 4.5146 && f.borrowAprAfterPct! < 4.55, `after: ${f.borrowAprAfterPct}`);
  assert.equal(f.userNetBorrowBasis, "after");
  assert.equal(f.liquidationPriceUsd, Math.round((115_000 / 1.55) * 10_000) / 10_000);
  assert.equal(f.bindingCap, "chosen_hf", "1.55 sits above the pinned 1.25 floor: the chosen HF binds");
  assert.equal(evaluateForecast(inputs({ entryHf: 1.25, depositUsd: 1_000_000 })).bindingCap, "entry_hf_floor", "sitting exactly on the floor");
  const looser = evaluateForecast(inputs({ entryHf: 2, depositUsd: 1_000_000 }));
  assert.equal(looser.bindingCap, "chosen_hf");
  assert.equal(looser.ltvAtEntryBps, 3900);
  assert.equal(looser.borrowUsd, 390_000);
  assert.ok(looser.drawdownToLiquidationPct === 50);
});

test("the slider's ends: the floor is the default, the top is 'borrow nothing', and out-of-range inputs throw", () => {
  const top = evaluateForecast(inputs({ entryHf: MAX_ENTRY_HF }));
  assert.equal(top.ltvAtEntryBps, 7, "LT 78 % ÷ 1000 → 7 bps");
  assert.equal(top.drawdownToLiquidationPct, 99.9);
  assert.throws(() => evaluateForecast(inputs({ entryHf: MAX_ENTRY_HF + 1 })), RangeError);
  assert.throws(() => evaluateForecast(inputs({ entryHf: 0.5 })), RangeError);
  assert.throws(() => evaluateForecast(inputs({ depositUsd: 0 })), RangeError);
  assert.equal(evaluateForecast(inputs()).entryHfFloor, ENTRY_HF_FLOOR, "the evaluator's default is shared's; the server passes the registry's when it has read one (the route test below)");
});

test("evaluateForecastPool: every setting × collateral, in the gate's order", () => {
  const { pool: _pool, setting: _setting, collateral: _collateral, ...ctx } = inputs();
  const cells = evaluateForecastPool(cbbtcUsdc, ["cbBTC", "WETH"], ctx);
  assert.equal(cells.length, SETTINGS.length * 2);
  assert.deepEqual(cells.map((c) => `${c.setting}/${c.collateral}`).slice(0, 3), ["sheltered/cbBTC", "sheltered/WETH", "steady/cbBTC"]);
  const weth = cells.find((c) => c.setting === "sheltered" && c.collateral === "WETH")!;
  assert.equal(weth.ltvAtEntryBps, Math.floor(8300 / 1.55), "each collateral at its own live LT");
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

const STALE_AFTER = 600_000;
function cfg(dataDir: string): YieldConfig {
  return {
    baseRpcUrl: undefined, blockscoutKey: undefined, engineVault: "0x" + "0".repeat(40),
    port: 0, dataDir, samplesDir: dataDir, refreshMs: 60_000, staleAfterMs: STALE_AFTER,
    cohortWindows: [30, 60, 90], minDaysOpen: 1, logChunk: 5_000,
  };
}
function clock(start = NOW_MS) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const geckoStub = {
  liveSample: async (poolId: string, poolAddress: string, feeTierBps: number) => ({
    poolId, poolAddress: poolAddress as `0x${string}`, tvlUsd: 1_000_000, volume24hUsd: 500_000,
    feeTierBps, grossFeeAprPct: 50, sampledAt: new Date().toISOString(),
    // cbBTC/USDC's sample carries cbBTC as base at $115,000 — the forecast's liquidation-price input.
    baseTokenAddress: (poolId === "aero-cbbtc-usdc" ? CBBTC : "0x940181a94a35a4569e4529a3cdfb74e38fd98631") as `0x${string}`,
    quoteTokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" as `0x${string}`,
    baseTokenPriceUsd: poolId === "aero-cbbtc-usdc" ? 115_000 : 0.478, quoteTokenPriceUsd: 1,
    source: "geckoterminal" as const,
  }),
} as unknown as GeckoSource;
function aaveStub(c: ReturnType<typeof clock>, fail = { v: false }): AaveSource {
  return { sample: async () => { if (fail.v) throw new Error("rpc down"); return ratesFixture({}, c.now()); } } as unknown as AaveSource;
}
function gaugesStub(c: ReturnType<typeof clock>): GaugeSource {
  return {
    sample: async (poolId: string): Promise<EmissionsSample> =>
      poolId === "aero-cbbtc-usdc"
        ? emissionsFixture(poolId, CBBTC_APR, {}, c.now())
        : emissionsFixture(poolId, { "4500": 1, "2356": 1, "1500": 2, "784": 2, "300": 3, "150": 3 }, {}, c.now()),
  } as unknown as GaugeSource;
}
async function get(port: number, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, body: await res.json() };
}
/** A registry whose floor is `floorWad`; `fail` makes the read throw (the server keeps the last good one). */
function registryStub(floorWad: bigint, c: ReturnType<typeof clock>, fail: { v: boolean } = { v: false }): RegistrySource {
  return {
    entryHfFloor: async () => {
      if (fail.v) throw new Error("rpc down");
      return { floor: hfFromWad(floorWad), wad: floorWad.toString(), sampledAt: new Date(c.now()).toISOString() };
    },
  } as unknown as RegistrySource;
}
async function boot(fail = { v: false }, registry: RegistrySource | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "yield-forecast-"));
  writeFileSync(join(dir, "volatility.json"), JSON.stringify(volatilityFixture()));
  writeFileSync(join(dir, "mc-calibration.json"), JSON.stringify(mcCalibrationDocFixture()));
  const c = clock();
  const srv = new YieldServer(cfg(dir), { gecko: geckoStub, aave: aaveStub(c, fail), gauges: gaugesStub(c), registry, now: c.now });
  const http = await srv.start();
  const port = (http.address() as { port: number }).port;
  return { srv, http, port, dir, c, close: async () => { srv.stop(); await new Promise<void>((r) => http.close(() => r())); rmSync(dir, { recursive: true, force: true }); } };
}

test("GET /v1/forecast: defaults to the floor, filters by pool/setting/collateral, prices every cell, carries the liquidation price from the live sample, never 503s", async () => {
  const b = await boot();
  try {
    const all = await get(b.port, "/v1/forecast");
    assert.equal(all.status, 200);
    const body = all.body as ForecastResponse;
    assert.equal(body.entryHf, ENTRY_HF_FLOOR);
    assert.equal(body.entryHfFloor, ENTRY_HF_FLOOR);
    assert.equal(body.entryHfFloorSource, "shared", "no registry configured: the deploy-default constant, said");
    assert.equal(body.entryHfFloorReadAt, null);
    assert.equal(body.borrowAprPct, 4.828);
    assert.equal(body.stale, false);
    assert.ok(body.cells.length > 0);
    assert.ok(body.cells.every((c) => typeof c.entryHf === "number" && Array.isArray(c.refusals) && Array.isArray(c.disclosures)));
    const one = await get(b.port, "/v1/forecast?pool=acbbtc&setting=sheltered&collateral=cbBTC&entryHf=1.3&deposit=250000");
    assert.equal(one.status, 200);
    const cells = (one.body as ForecastResponse).cells;
    assert.equal(cells.length, 1);
    const c = cells[0]!;
    assert.equal(c.poolId, "aero-cbbtc-usdc");
    assert.equal(c.entryHf, 1.3);
    assert.equal(c.ltvAtEntryBps, 6000);
    assert.equal(c.borrowUsd, 150_000);
    assert.equal(c.collateralPriceUsd, 115_000, "read from the live sample, never typed");
    assert.equal(c.liquidationPriceUsd, Math.round((115_000 / 1.3) * 10_000) / 10_000);
    assert.equal(c.userNetBorrowBasis, "after");
    assert.deepEqual(c.refusals, [], "1.30 is above the shared 1.25 floor this server runs without a registry (the pinned deploy default); with a registry it is judged against the chain's (the next test)");
    const underShared = (await get(b.port, `/v1/forecast?collateral=cbBTC&entryHf=1.2&pool=acbbtc&setting=sheltered`)).body as ForecastResponse;
    assert.deepEqual(underShared.cells[0]!.refusals, ["entry_hf_below_floor"], "1.20 is under 1.25");
    assert.equal(c.lpPriced, true);
    // Malformed queries are 400s, never a guess.
    for (const q of ["entryHf=0.9", "entryHf=abc", "entryHf=1001", "deposit=-1", "deposit=0", "pool=nope", "setting=nope", "collateral=DOGE"]) {
      const r = await get(b.port, `/v1/forecast?${q}`);
      assert.equal(r.status, 400, q);
    }
  } finally {
    await b.close();
  }
});

test("GET /v1/forecast with no rates or stale rates still answers 200: the refusal is inside every cell and the headline says stale", async () => {
  const fail = { v: true };
  const b = await boot(fail);
  try {
    const r = await get(b.port, "/v1/forecast?collateral=cbBTC");
    assert.equal(r.status, 200);
    const body = r.body as ForecastResponse;
    assert.equal(body.borrowAprPct, null);
    assert.equal(body.stale, true);
    assert.ok(body.cells.length > 0);
    assert.ok(body.cells.every((c) => c.refusals.includes("rates_unavailable") && c.allowed === false));
    // The LP slice is still priced from emissions and σ where they exist — the picture is shown beside the refusal.
    const priced = body.cells.find((c) => c.poolId === "aero-cbbtc-usdc" && c.setting === "sheltered")!;
    assert.equal(priced.lpPriced, true);
    assert.equal(priced.userNetPct, null, "no borrow rate → no user net");
    // Gate stays what it was: a 503.
    assert.equal((await get(b.port, "/v1/gate")).status, 503);
  } finally {
    await b.close();
  }
  const b2 = await boot();
  try {
    b2.c.advance(STALE_AFTER + 1);
    const r = await get(b2.port, "/v1/forecast?collateral=cbBTC&pool=acbbtc");
    assert.equal(r.status, 200);
    assert.ok((r.body as ForecastResponse).cells.every((c: ForecastCell) => c.refusals.includes("rates_stale")));
    assert.equal((r.body as ForecastResponse).stale, true);
  } finally {
    await b2.close();
  }
});

test("GET /v1/forecast with a registry (A4.4): the floor is the chain's, said so — a registry raised to 1.35 refuses 1.30 that the shared 1.25 would allow; a read that fails past staleness serves the STRICTER of the last read and shared's, says registry_stale, keeps the read time", async () => {
  const fail = { v: false };
  const c0 = clock();
  const b = await boot({ v: false }, registryStub(1_350_000_000_000_000_000n, c0, fail));
  try {
    const first = await get(b.port, "/v1/forecast?collateral=cbBTC&entryHf=1.3&pool=acbbtc&setting=sheltered&deposit=250000");
    assert.equal(first.status, 200);
    const body = first.body as ForecastResponse;
    assert.equal(body.entryHfFloor, 1.35);
    assert.equal(body.entryHfFloorSource, "registry");
    assert.ok(body.entryHfFloorReadAt, "the read time is carried");
    const cell = body.cells.find((x) => x.collateral === "cbBTC")!;
    assert.deepEqual(cell.refusals, ["entry_hf_below_floor"], "1.30 < 1.35: refused against the chain's floor, not the constant's");
    const above = (await get(b.port, "/v1/forecast?collateral=cbBTC&entryHf=1.4&pool=acbbtc&setting=sheltered&deposit=250000")).body as ForecastResponse;
    assert.deepEqual(above.cells[0]!.refusals, []);
    assert.equal(above.cells[0]!.bindingCap, "chosen_hf");
    // The default entry HF is the served floor, not the constant.
    const dflt = (await get(b.port, "/v1/forecast")).body as ForecastResponse;
    assert.equal(dflt.entryHf, 1.35);

    // The read fails and the clock passes staleAfterMs: the stricter of the last read (1.35) and shared's (1.25) is
    // served — a floor the chain may have raised must not be lowered by going stale — marked registry_stale.
    fail.v = true;
    b.c.advance(STALE_AFTER + 1);
    await b.srv.refresh();
    const stale = (await get(b.port, "/v1/forecast?collateral=cbBTC&entryHf=1.3&pool=acbbtc&setting=sheltered")).body as ForecastResponse;
    assert.equal(stale.entryHfFloor, 1.35);
    assert.equal(stale.entryHfFloorSource, "registry_stale");
    assert.equal(stale.entryHfFloorReadAt, body.entryHfFloorReadAt, "the last good read's time, so the staleness is visible");
    assert.deepEqual(stale.cells[0]!.refusals, ["entry_hf_below_floor"], "still judged against 1.35 — fail closed on the higher floor");
  } finally {
    await b.close();
  }

  // A registry UNDER the shared default (1.15): fresh, the chain's number rules; stale, the stricter shared 1.25 is served.
  const fail2 = { v: false };
  const b2 = await boot({ v: false }, registryStub(1_150_000_000_000_000_000n, clock(), fail2));
  try {
    const fresh = (await get(b2.port, "/v1/forecast?collateral=cbBTC&entryHf=1.2&pool=acbbtc&setting=sheltered")).body as ForecastResponse;
    assert.equal(fresh.entryHfFloor, 1.15);
    assert.deepEqual(fresh.cells[0]!.refusals, []);
    fail2.v = true;
    b2.c.advance(STALE_AFTER + 1);
    await b2.srv.refresh();
    const stale2 = (await get(b2.port, "/v1/forecast?collateral=cbBTC&entryHf=1.2&pool=acbbtc&setting=sheltered")).body as ForecastResponse;
    assert.equal(stale2.entryHfFloor, 1.25);
    assert.equal(stale2.entryHfFloorSource, "registry_stale");
    assert.deepEqual(stale2.cells[0]!.refusals, ["entry_hf_below_floor"]);
  } finally {
    await b2.close();
  }
});

// ---------------------------------------------------------------------------
// The cross-chain cell (BUILD-PLAN D6; CROSSCHAIN-LOOP-2026-09-12 §6 item 1)
// ---------------------------------------------------------------------------

/** Kamino's ZCASH market as the forecast consumes it: ZEC's parameters, USDC's pool and curve. */
function kaminoVenue(over: Partial<ForecastVenueBorrow> = {}): ForecastVenueBorrow {
  return {
    chain: "solana",
    venue: "kamino",
    borrowAprNowPct: 2.78,
    supplyAprPct: 0,
    liquidationThresholdBps: 6500, // ZEC's LT on the ZCASH market
    venueMaxLtvBps: 4000, // Kamino's own 40 % cap
    availableUnits: "355599950997", // ≈ 355,600 USDC available (the 2026-09-12 capture)
    borrowedUnits: "446186304801",
    borrowLimitUnits: "2000000000000",
    decimals: 6,
    borrowCurve: [
      [0, 119],
      [5000, 279],
      [9000, 725],
      [9200, 897],
      [10000, 3860],
    ],
    refusals: [],
    stale: false,
    ...over,
  };
}

test("a cross-chain cell is priced against KAMINO's rate and Kamino's collateral parameters — not Base's", () => {
  const base = evaluateForecast(inputs({ depositUsd: 10_000 }));
  const cross = evaluateForecast(inputs({ depositUsd: 10_000, entryHf: ENTRY_HF_FLOOR, venueBorrow: kaminoVenue() }));
  assert.equal(base.borrowVenue, "aave");
  assert.equal(cross.borrowVenue, "kamino");
  assert.equal(cross.borrowAprNowPct, 2.78, "Kamino's rate, not Aave's");
  assert.notEqual(base.borrowAprNowPct, cross.borrowAprNowPct);
  // The loan is sized by ZEC on Kamino: LT 65 % at the 1.25 floor is 52 % LTV, under Kamino's own 40 % cap…
  assert.equal(cross.liquidationThresholdBps, 6500);
  assert.equal(cross.venueMaxLtvBps, 4000);
  assert.equal(cross.ltvAtEntryBps, 5200);
  assert.deepEqual(cross.refusals, ["venue_ltv_exceeded"], "…so 52 % is above what Kamino allows and is refused by name");
  assert.equal(cross.bindingCap, "venue_max_ltv");
  // At an entry HF Kamino's cap does allow, the cell is allowed and carries Kamino's numbers.
  const ok = evaluateForecast(inputs({ depositUsd: 10_000, entryHf: 1.625, venueBorrow: kaminoVenue() }));
  assert.deepEqual(ok.refusals, []);
  assert.equal(ok.ltvAtEntryBps, 4000, "LT 65 ÷ 1.625 = the cap exactly");
  assert.equal(ok.collateralSupplyAprPct, 0, "ZEC on the ZCASH market is collateral-only and earns nothing");
  assert.ok(ok.borrowAprAfterPct !== null && ok.borrowAprAfterPct > ok.borrowAprNowPct!, "a borrow moves Kamino's curve");
});

test("a borrow Kamino cannot fund is REFUSED, not priced: more than the pool has, and past its borrow limit", () => {
  // The pool holds ≈ 355,600 USDC. At the 40 % cap a $1.2 M deposit borrows $480 K — more than that.
  const tooBig = evaluateForecast(inputs({ depositUsd: 1_200_000, entryHf: 1.625, venueBorrow: kaminoVenue() }));
  assert.ok(tooBig.refusals.includes("pool_cannot_fund"));
  assert.equal(tooBig.allowed, false);
  assert.equal(tooBig.borrowAprAfterPct, null, "no rate is invented for a loan the pool cannot make");
  assert.equal(tooBig.bindingCap, "pool_liquidity");
  // The same amount against a pool with the liquidity but a borrow limit already reached.
  const capped = evaluateForecast(
    inputs({ depositUsd: 10_000, entryHf: 1.625, venueBorrow: kaminoVenue({ borrowLimitUnits: "446186304801" }) })
  );
  assert.ok(capped.refusals.includes("pool_cannot_fund"), "the borrow limit refuses it too");
  // And a borrow the pool CAN fund is priced.
  const fine = evaluateForecast(inputs({ depositUsd: 10_000, entryHf: 1.625, venueBorrow: kaminoVenue() }));
  assert.equal(fine.allowed, true);
  assert.ok(fine.borrowAprAfterPct !== null);
});

test("the venue's own refusals reach the cell, and Base's rates being stale does not refuse a loan that is not Base's", () => {
  const paused = evaluateForecast(inputs({ entryHf: 1.625, venueBorrow: kaminoVenue({ refusals: ["borrow_paused"] }) }));
  assert.deepEqual(paused.refusals, ["borrow_paused"]);
  const staleVenue = evaluateForecast(inputs({ entryHf: 1.625, venueBorrow: kaminoVenue({ stale: true }) }));
  assert.ok(staleVenue.refusals.includes("rates_stale"));
  // Aave's rates are stale, but the loan is Kamino's: the cell is still allowed, and still priced by Kamino.
  const baseStale = evaluateForecast(
    inputs({ entryHf: 1.625, rates: { ...ratesFixture(), stale: true }, venueBorrow: kaminoVenue() })
  );
  assert.deepEqual(baseStale.refusals, [], "Base's borrow rate says nothing about the cost of a Kamino loan");
  assert.equal(baseStale.borrowAprNowPct, 2.78);
  assert.equal(baseStale.lpPriced, true, "and the LP slice, which IS Base's, is still priced");
});

test("venueBorrowAprAfterPct: the curve moves with the borrow, and every way the pool says no is null", () => {
  const v = kaminoVenue();
  const now = venueBorrowAprAfterPct(v, 0);
  const after = venueBorrowAprAfterPct(v, 100_000);
  assert.ok(now !== null && after !== null);
  assert.ok(after! > now!, "borrowing more raises the rate");
  // 355,600 available: one unit more than that cannot be funded.
  assert.equal(venueBorrowAprAfterPct(v, 355_600), null);
  assert.ok(venueBorrowAprAfterPct(v, 355_000) !== null);
  // A borrow limit already at the debt refuses any amount.
  assert.equal(venueBorrowAprAfterPct(kaminoVenue({ borrowLimitUnits: "446186304801" }), 1), null);
  // A limit of zero is "no limit", the way klend reads it.
  assert.ok(venueBorrowAprAfterPct(kaminoVenue({ borrowLimitUnits: "0" }), 1000) !== null);
  // An empty pool funds nothing.
  assert.equal(venueBorrowAprAfterPct(kaminoVenue({ availableUnits: "0", borrowedUnits: "0" }), 1), null);
});
