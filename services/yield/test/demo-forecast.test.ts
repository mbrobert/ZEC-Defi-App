/**
 * The committed demo forecast (samples/demo-forecast.json, mirrored into web/lib) is
 * `evaluateForecast`'s own output on the recorded inputs — pinned cell for cell, the way
 * demo-gate.test.ts pins the gate's snapshot. If the evaluator changes, this test says so before
 * demo mode can show a number the live service would not.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { BASE_TOKENS, COLLATERAL_SYMBOLS, CURATED_POOLS, ENTRY_HF_FLOOR } from "@zyo/shared";
import { evaluateForecast } from "../src/forecast.js";
import { MIN_GATE_STAKED_SAMPLES } from "../src/gate.js";
import { emissionsAprPct, modelWidthsBps, priceHalfWidth, round2, SETTINGS } from "../src/model.js";
import type { AaveRatesSample, AaveReserve, Address, EmissionsSample, ForecastCell } from "../src/types.js";
import { mcCalibrationFixture, volatilityFixture } from "./fixtures/model.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => JSON.parse(readFileSync(join(here, rel), "utf8"));

const DEMO = read("../../samples/demo-forecast.json") as {
  pinnedFrom: Record<string, string>;
  asOf: string;
  entryHf: number;
  entryHfFloor: number;
  borrowAprPct: number;
  usdcReserveBlock: number;
  cells: ForecastCell[];
};
const SAMPLE = read("../../samples/gauge-emissions-2026-09-13.json") as {
  sampledAt: string;
  aeroUsd: number;
  aave: { borrow: AaveReserve; collateral: Record<string, AaveReserve> };
  pools: Record<string, { pool: string; gauge: string; rewardRateWeiPerSec: string; periodFinish: number; sqrtPriceX96: string; stakedLiquidity: string | null; dec1: number; token1Usd: number; feeBpsLive: number; wholePoolAprPct: number }>;
};
const MODEL = read("../../samples/lp-model-2026-09-13.json") as {
  inputs: { asOf: string; borrowAprPct: number; collateral: Record<string, { supplyAprPct: number; liquidationThresholdBps: number }> };
  results: Record<string, Record<string, { reason: string | null }>>;
};
const RESERVE = read("../../samples/aave-usdc-reserve-2026-09-13.json") as {
  block: number;
  decimals: number;
  strategy: string;
  getInterestRateDataBps: { optimalUsageBps: number; baseVariableBorrowRateBps: number; variableRateSlope1Bps: number; variableRateSlope2Bps: number };
  getReserveData: { totalAToken: string; totalVariableDebt: string };
};
const NOW_S = Math.floor(Date.parse(DEMO.asOf) / 1000);

function reserveOf(symbol: string, over: Partial<AaveReserve> = {}): AaveReserve {
  const recorded = symbol === "USDC" ? SAMPLE.aave.borrow : SAMPLE.aave.collateral[symbol];
  return {
    symbol,
    address: (BASE_TOKENS[symbol as keyof typeof BASE_TOKENS]?.address?.toLowerCase() ?? "0x") as Address,
    supplyAprPct: 0, variableBorrowAprPct: 0, ltvBps: recorded?.ltvBps ?? 0, liquidationThresholdBps: 0, liquidationBonusBps: recorded?.liquidationBonusBps ?? 0,
    usageAsCollateralEnabled: true, borrowingEnabled: true, isActive: true, isFrozen: false, isPaused: false,
    decimals: 0, totalATokenUnits: "1", totalVariableDebtUnits: "0",
    ...over,
  };
}

const rates: AaveRatesSample & { stale: boolean } = {
  source: "aave-v3-base",
  dataProvider: "0x" as Address,
  borrow: reserveOf("USDC", {
    variableBorrowAprPct: MODEL.inputs.borrowAprPct,
    decimals: RESERVE.decimals,
    totalATokenUnits: RESERVE.getReserveData.totalAToken,
    totalVariableDebtUnits: RESERVE.getReserveData.totalVariableDebt,
  }),
  collateral: Object.fromEntries(
    Object.entries(MODEL.inputs.collateral).map(([s, c]) => [s, reserveOf(s, { supplyAprPct: c.supplyAprPct, liquidationThresholdBps: c.liquidationThresholdBps })])
  ),
  borrowCurve: { strategy: RESERVE.strategy.toLowerCase() as Address, ...RESERVE.getInterestRateDataBps },
  sampledAt: MODEL.inputs.asOf,
  stale: false,
};

/** The generator's emissions rebuild (scripts/demo-inputs.mjs), repeated here so the pin does not trust the script. */
function emissionsFor(poolId: string): (EmissionsSample & { stale: boolean }) | null {
  const s = SAMPLE.pools[poolId];
  if (!s) return null;
  const rewardRate = BigInt(s.rewardRateWeiPerSec);
  const epochActive = rewardRate > 0n && s.periodFinish > NOW_S;
  const staked = Number(s.stakedLiquidity ?? 0);
  let aprByWidthPct: Record<string, number> | null = {};
  if (epochActive && staked > 0) {
    for (const bps of modelWidthsBps()) {
      const apr = emissionsAprPct({ rewardRateWeiPerSec: rewardRate, aeroUsd: SAMPLE.aeroUsd, stakedLiquidity: staked, sqrtPriceX96: BigInt(s.sqrtPriceX96), token1Decimals: s.dec1, token1Usd: s.token1Usd, halfWidth: priceHalfWidth(bps) });
      if (apr === null) { aprByWidthPct = null; break; }
      aprByWidthPct![String(bps)] = round2(apr);
    }
  } else if (!epochActive) {
    for (const bps of modelWidthsBps()) aprByWidthPct![String(bps)] = 0;
  } else aprByWidthPct = null;
  return {
    poolId, pool: s.pool as Address, gauge: s.gauge as Address, rewardRateWeiPerSec: s.rewardRateWeiPerSec, periodFinish: s.periodFinish, epochActive,
    wholePoolAprPct: aprByWidthPct === null ? null : round2(s.wholePoolAprPct ?? 0), aprByWidthPct, stakedLiquidity: String(s.stakedLiquidity ?? "0"),
    samples: MIN_GATE_STAKED_SAMPLES, corroborated: true, outlier: false, sqrtPriceX96: s.sqrtPriceX96, feePips: Math.round(s.feeBpsLive * 100), aeroUsd: SAMPLE.aeroUsd,
    sampledAt: SAMPLE.sampledAt, stale: false,
  } as EmissionsSample & { stale: boolean };
}

test("demo-forecast.json is evaluateForecast() on the recorded inputs, cell for cell, at the registry floor", () => {
  assert.equal(DEMO.entryHf, ENTRY_HF_FLOOR);
  assert.equal(DEMO.entryHfFloor, ENTRY_HF_FLOOR);
  assert.equal(DEMO.usdcReserveBlock, RESERVE.block, "the payload names the reserve read it used");
  const volatility = read("../../samples/volatility.json");
  const mc = mcCalibrationFixture();
  let n = 0;
  for (const pool of CURATED_POOLS.filter((p) => p.dex === "AERODROME")) {
    const emissions = emissionsFor(pool.id);
    for (const setting of SETTINGS) {
      for (const collateral of COLLATERAL_SYMBOLS) {
        const expected = evaluateForecast({ pool, setting, collateral, rates, emissions, volatility, mcCalibration: mc, nowSeconds: NOW_S, entryHf: ENTRY_HF_FLOOR, entryHfFloor: ENTRY_HF_FLOOR, depositUsd: null, collateralPriceUsd: null });
        const committed = DEMO.cells.find((c) => c.poolId === pool.id && c.setting === setting.id && c.collateral === collateral);
        assert.ok(committed, `${pool.id}/${setting.id}/${collateral} missing from the demo`);
        assert.deepEqual(committed, expected, `${pool.id}/${setting.id}/${collateral}`);
        n++;
      }
    }
  }
  assert.equal(n, DEMO.cells.length, "no orphan cells");
  assert.equal(n, 81);
});

test("what the recording says on 2026-09-13: 27 cells priced (the three σ-calibrated pools), 54 allowed (every cbBTC/WETH cell), none clears the borrow on both forms — shown, not refused", () => {
  const priced = DEMO.cells.filter((c) => c.lpPriced);
  const allowed = DEMO.cells.filter((c) => c.allowed);
  assert.equal(priced.length, 27);
  assert.equal(allowed.length, 54);
  assert.equal(DEMO.cells.filter((c) => c.clearsBorrow.both === true).length, 0);
  // The only refusals in the recording are cbZEC-as-collateral (disabled in the registry, unlisted on Aave).
  for (const c of DEMO.cells) {
    if (c.collateral === "cbZEC") assert.deepEqual(c.refusals, ["collateral_disabled", "collateral_not_active"]);
    else assert.deepEqual(c.refusals, [], `${c.poolId}/${c.setting}/${c.collateral}`);
  }
  // A priced-negative cell still carries every number the site shows.
  const best = priced.filter((c) => c.collateral === "cbBTC").sort((a, b) => (b.lpNetPct ?? -1e9) - (a.lpNetPct ?? -1e9))[0]!;
  assert.equal(best.poolId, "aero-cbbtc-usdc");
  assert.equal(best.setting, "sheltered");
  for (const k of ["lpNetPct", "mcLpNetPct", "modelGapPts", "dragPct", "breakEvenEmissionsMultiple", "userNetPct", "mcUserNetPct", "drawdownToLiquidationPct", "ltvAtEntryBps", "poolAvailableUsd"] as const) {
    assert.equal(typeof best[k], "number", k);
  }
  assert.equal(best.ltvAtEntryBps, Math.floor(7800 / ENTRY_HF_FLOOR));
  assert.equal(best.drawdownToLiquidationPct, round2(100 * (1 - 1 / ENTRY_HF_FLOOR)));
  assert.ok(best.userNetPct! < 0, "negative, and shown");
  // Unpriced cells say why, by name, and are still allowed.
  const unpriced = DEMO.cells.filter((c) => !c.lpPriced && c.collateral === "cbBTC");
  assert.ok(unpriced.length > 0);
  // The forecast prices EVERY σ-calibrated cell (D4: the gate's "emissions below the borrow" is information,
  // not a stop), so an unpriced cell is one of two things, and which one is the MODEL's call: a reading the
  // gate refuses as implausible (2026-09-13: cbZEC/USDC at the two tighter widths, where the gauge's collapsed
  // stake reads 1,031 % / 5,241 %, above the 1,000 % ceiling), or a pool with no σ — allowed either way, and
  // disclosed as having no forecast.
  for (const c of unpriced) {
    const modelReason = MODEL.results[c.poolId]![c.setting]!.reason;
    assert.equal(c.lpUnpricedReason, modelReason === "emissions_implausible" ? "emissions_implausible" : "no_volatility_input", `${c.poolId}/${c.setting} (model: ${modelReason})`);
    assert.ok(c.allowed && c.disclosures.includes("no_forecast"), `${c.poolId}/${c.setting}`);
  }
  assert.deepEqual([...new Set(unpriced.map((c) => c.lpUnpricedReason))].sort(), ["emissions_implausible", "no_volatility_input"]);
});

test("the web mirror is byte-identical", () => {
  const webPath = join(here, "../../../../web/lib/demo-forecast.json");
  assert.ok(existsSync(webPath), "web/lib/demo-forecast.json missing — run npm run demo-forecast");
  assert.equal(readFileSync(webPath, "utf8"), readFileSync(join(here, "../../samples/demo-forecast.json"), "utf8"));
});
