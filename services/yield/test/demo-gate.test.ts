/**
 * FIX D-MED-1 / D-MED-7 — demo mode IS the gate.
 *
 * `samples/demo-gate.json` (mirrored to `web/lib/demo-gate.json`) is the
 * payload a first-time user sees before connecting a wallet. It used to be a
 * reformatting of the simulator's output, which produced two families of
 * silent divergence from the shipped gate:
 *
 *   MED-1: the simulator trusted the sample's recorded `epochActive` boolean
 *          while the gate re-derives it from `periodFinish`, so 78 cells
 *          across 15 of the 27 pool × setting rows disagreed outright.
 *   MED-7: the simulator computed fields the gate returns BEFORE reaching, so
 *          24 numbers were published on cells the live gate leaves null —
 *          including a three-row user-net ladder and an "LP net −18.18 % vs
 *          borrow 4.828 %" line on a pool live mode will not price at all.
 *
 * `scripts/gen-demo-gate.mjs` now produces the file by calling `evaluateGate`.
 * This suite re-runs that decision here and asserts the committed file equals
 * it field for field, so a regenerated demo can never drift from the gate.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BASE_TOKENS, COLLATERAL_SYMBOLS, CURATED_POOLS, poolById } from "@zyo/shared";
import { evaluateGate } from "../src/gate.js";
import { emissionsAprPct, ENGINE_FEE_BPS, modelWidthsBps, priceHalfWidth, round2, SETTINGS } from "../src/model.js";
import { MIN_STAKED_SAMPLES } from "../src/sources/gauges.js";
import type { AaveRatesSample, AaveReserve, Address, EmissionsSample, GateVerdict } from "../src/types.js";
import { borrowCurveFixture, mcCalibrationFixture, volatilityFixture } from "./fixtures/model.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const DEMO = read("../../samples/demo-gate.json") as {
  asOf: string;
  borrowAprPct: number;
  engineFeeBps: number;
  emissionsSampledAt: string;
  volatilityAsOf: string;
  stale: boolean;
  verdicts: GateVerdict[];
  qualifying: unknown[];
  liquidationThresholdBps: Record<string, number>;
};
const SAMPLE = read("../../samples/gauge-emissions-2026-09-12.json") as {
  sampledAt: string;
  aeroUsd: number;
  pools: Record<string, {
    pool: string; gauge: string; rewardRateWeiPerSec: string; periodFinish: number; sqrtPriceX96: string;
    stakedLiquidity: string | null; dec1: number; token1Usd: number; feeBpsLive: number; wholePoolAprPct: number;
  }>;
};
const MODEL = read("../../samples/lp-model-2026-09-12.json") as {
  inputs: { borrowAprPct: number; collateral: Record<string, { supplyAprPct: number; liquidationThresholdBps: number }> };
};

const VOL = volatilityFixture();
const MC = mcCalibrationFixture();
const NOW_S = Math.floor(Date.parse(DEMO.asOf) / 1000);

function reserveOf(symbol: string, over: Partial<AaveReserve> = {}): AaveReserve {
  return {
    symbol,
    address: (BASE_TOKENS[symbol as keyof typeof BASE_TOKENS]?.address?.toLowerCase() ?? "0x") as Address,
    supplyAprPct: 0, variableBorrowAprPct: 0, ltvBps: 0, liquidationThresholdBps: 0, liquidationBonusBps: 0,
    usageAsCollateralEnabled: true, borrowingEnabled: true, isActive: true, isFrozen: false, isPaused: false,
    // The gate reads none of these three (they feed the forecast's liquidity refusal and post-borrow
    // rate only); the demo file predates them. Stand-ins, labelled as such.
    decimals: 0, totalATokenUnits: "1", totalVariableDebtUnits: "0",
    ...over,
  };
}

const rates: AaveRatesSample & { stale: boolean } = {
  source: "aave-v3-base",
  dataProvider: "0x" as Address,
  borrow: reserveOf("USDC", { variableBorrowAprPct: MODEL.inputs.borrowAprPct }),
  collateral: Object.fromEntries(
    Object.entries(MODEL.inputs.collateral).map(([s, c]) => [
      s,
      reserveOf(s, { supplyAprPct: c.supplyAprPct, liquidationThresholdBps: c.liquidationThresholdBps }),
    ])
  ),
  borrowCurve: borrowCurveFixture(),
  sampledAt: DEMO.asOf,
  stale: false,
};

/** The emissions sample the generator builds, rebuilt independently here. */
function emissionsFor(poolId: string): (EmissionsSample & { stale: boolean }) | null {
  const s = SAMPLE.pools[poolId];
  if (!s) return null;
  const rewardRate = BigInt(s.rewardRateWeiPerSec);
  const sqrtPriceX96 = BigInt(s.sqrtPriceX96);
  const epochActive = rewardRate > 0n && s.periodFinish > NOW_S;
  const staked = Number(s.stakedLiquidity ?? 0);
  let aprByWidthPct: Record<string, number> | null = {};
  if (!epochActive) {
    for (const bps of modelWidthsBps()) aprByWidthPct[String(bps)] = 0;
  } else if (staked > 0) {
    for (const bps of modelWidthsBps()) {
      const apr = emissionsAprPct({
        rewardRateWeiPerSec: rewardRate, aeroUsd: SAMPLE.aeroUsd, stakedLiquidity: staked,
        sqrtPriceX96, token1Decimals: s.dec1, token1Usd: s.token1Usd, halfWidth: priceHalfWidth(bps),
      });
      if (apr === null) { aprByWidthPct = null; break; }
      aprByWidthPct[String(bps)] = round2(apr);
    }
  } else {
    aprByWidthPct = null;
  }
  return {
    poolId, pool: s.pool as Address, gauge: s.gauge as Address,
    rewardRateWeiPerSec: s.rewardRateWeiPerSec, periodFinish: s.periodFinish, epochActive,
    wholePoolAprPct: aprByWidthPct === null ? null : round2(s.wholePoolAprPct ?? 0),
    aprByWidthPct, stakedLiquidity: String(s.stakedLiquidity ?? "0"),
    samples: MIN_STAKED_SAMPLES, corroborated: true, outlier: false,
    sqrtPriceX96: s.sqrtPriceX96, feePips: Math.round(s.feeBpsLive * 100), aeroUsd: SAMPLE.aeroUsd,
    sampledAt: SAMPLE.sampledAt, stale: false,
  };
}

test("FIX D-MED-1/MED-7: every committed demo verdict equals what evaluateGate answers on the same recorded words", () => {
  let checked = 0;
  for (const pool of CURATED_POOLS.filter((p) => p.dex === "AERODROME")) {
    const emissions = emissionsFor(pool.id);
    for (const setting of SETTINGS) {
      for (const collateral of COLLATERAL_SYMBOLS) {
        const expected = evaluateGate({ pool, setting, collateral, rates, emissions, volatility: VOL, mcCalibration: MC, nowSeconds: NOW_S });
        const actual = DEMO.verdicts.find((v) => v.poolId === pool.id && v.setting === setting.id && v.collateral === collateral);
        assert.ok(actual, `${pool.id}/${setting.id}/${collateral} missing from demo-gate.json`);
        assert.deepEqual(actual, expected, `${pool.id}/${setting.id}/${collateral}`);
        checked++;
      }
    }
  }
  assert.equal(checked, DEMO.verdicts.length);
  assert.equal(checked, 81);
});

test("FIX D-MED-7: demo mode publishes NOTHING on a refusal branch the live gate returns before", () => {
  for (const v of DEMO.verdicts) {
    // Refused before the model runs → every model field is null and the
    // user-net ladder is empty. This is what used to leak 24 numbers.
    const beforeTheModel = [
      "collateral_disabled", "collateral_not_active", "collateral_paused", "borrow_paused",
      "rates_unavailable", "rates_stale", "emissions_unavailable", "emissions_stale",
      "no_emissions", "no_staked_liquidity", "insufficient_samples", "staked_liquidity_outlier",
      "emissions_implausible", "emissions_below_borrow", "no_volatility_input",
    ];
    if (v.reason && beforeTheModel.includes(v.reason)) {
      assert.equal(v.lpNetPct, null, `${v.poolId}/${v.setting}/${v.collateral} lpNetPct on ${v.reason}`);
      assert.equal(v.mcLpNetPct, null, `${v.poolId}/${v.setting}/${v.collateral} mcLpNetPct on ${v.reason}`);
      assert.equal(v.dragPct, null);
      assert.equal(v.emissionsRealizedPct, null);
      assert.equal(v.breakEvenSigma, null, `${v.poolId}/${v.setting} breakEvenSigma on ${v.reason}`);
      assert.equal(v.breakEvenEmissionsMultiple, null);
      assert.deepEqual(v.userNet, []);
    }
  }
  // The specific cells the audit named: aero-weth-cbbtc/sheltered is
  // emissions_below_borrow, and the six no_volatility_input cells carried a
  // breakEvenSigma the gate leaves null.
  const wc = DEMO.verdicts.find((v) => v.poolId === "aero-weth-cbbtc" && v.setting === "sheltered" && v.collateral === "cbBTC")!;
  assert.equal(wc.reason, "emissions_below_borrow");
  assert.equal(wc.lpNetPct, null);
  assert.deepEqual(wc.userNet, []);
  const noVol = DEMO.verdicts.filter((v) => v.reason === "no_volatility_input");
  assert.ok(noVol.length >= 6);
  assert.ok(noVol.every((v) => v.breakEvenSigma === null));
});

test("FIX D-MED-1: epochActive comes from periodFinish, so a lapsed gauge reads no_emissions in demo mode exactly as it does live", () => {
  // Which gauges were lapsed at the as-of instant is read from the SAMPLE'S OWN WORDS
  // (rewardRate > 0 AND periodFinish > as-of), never from a list typed here: on 2026-08-31
  // aero-aero-weth's epoch had ended (2026-05-28) and cbZEC had never been voted; on 2026-09-12
  // the cbZEC gauge carried a vote (slice K).
  const lapsed = Object.entries(SAMPLE.pools)
    .filter(([, p]) => !(BigInt(p.rewardRateWeiPerSec) > 0n && p.periodFinish > NOW_S))
    .map(([id]) => id);
  assert.ok(lapsed.length >= 1, "the sample carries at least one lapsed gauge (aero-aero-weth has since 2026-05-28)");
  for (const poolId of lapsed) {
    const rows = DEMO.verdicts.filter((v) => v.poolId === poolId && v.collateral !== "cbZEC");
    assert.ok(rows.length === 6, `${poolId}: ${rows.length} rows`);
    assert.ok(rows.every((v) => v.reason === "no_emissions"), `${poolId} lapsed at the as-of instant must read no_emissions`);
  }
  for (const poolId of Object.keys(SAMPLE.pools).filter((id) => !lapsed.includes(id))) {
    const rows = DEMO.verdicts.filter((v) => v.poolId === poolId && v.collateral !== "cbZEC");
    assert.ok(rows.every((v) => v.reason !== "no_emissions"), `${poolId} live at the as-of instant must not read no_emissions`);
  }
  // and the pools whose epoch WAS live at the as-of instant are priced
  const priced = DEMO.verdicts.filter((v) => v.lpNetPct !== null);
  assert.ok(priced.length > 0, "the as-of instant must sit inside a live epoch");
  assert.ok(Date.parse(DEMO.asOf) >= Date.parse(SAMPLE.sampledAt), "the gate cannot be evaluated before its inputs exist");
});

test("demo-gate.json carries the surface fields web/lib/gate.ts reads, and nothing qualifies at 4.828 %", () => {
  assert.equal(DEMO.engineFeeBps, ENGINE_FEE_BPS);
  assert.equal(DEMO.borrowAprPct, MODEL.inputs.borrowAprPct);
  assert.equal(DEMO.emissionsSampledAt, SAMPLE.sampledAt);
  assert.equal(DEMO.volatilityAsOf, VOL.asOf);
  assert.equal(DEMO.stale, false);
  assert.deepEqual(DEMO.qualifying, []);
  for (const [sym, lt] of Object.entries(DEMO.liquidationThresholdBps)) {
    assert.equal(lt, MODEL.inputs.collateral[sym]!.liquidationThresholdBps);
  }
  // the mirror the web app imports is byte-identical to the source of truth
  const mirror = readFileSync(new URL("../../../../web/lib/demo-gate.json", import.meta.url), "utf8");
  const source = readFileSync(new URL("../../samples/demo-gate.json", import.meta.url), "utf8");
  assert.equal(mirror, source, "web/lib/demo-gate.json must be a copy of samples/demo-gate.json");
});

test("poolById covers every demo verdict (no orphan pool ids in the committed payload)", () => {
  for (const v of DEMO.verdicts) assert.ok(poolById(v.poolId), v.poolId);
});
