#!/usr/bin/env node
/**
 * Regenerate the demo-mode `/v1/gate` payload BY RUNNING THE REAL GATE.
 *
 *   npm run demo-gate      # → samples/demo-gate.json (+ web/lib/demo-gate.json)
 *
 * Demo mode is the payload a first-time user sees before connecting a wallet
 * (`web/lib/demo.ts`), so it has to be the gate's own answer on the recorded
 * inputs — not a reformatting of the simulator's output.
 *
 * WHY (audit wave 1, lens D MED-1 and MED-7). The old generator
 * (`web/scripts/pin-model-numbers.mjs`) reshaped `lp-model-*.json` cell by
 * cell, so every place the simulator computed something the gate returns
 * BEFORE reaching became a number demo mode published and live mode left
 * null: 24 such disagreements, including a full three-row user-net ladder and
 * an "LP net −18.18 % vs borrow 4.828 %" line on a pool the live gate will not
 * price at all. Worse, the simulator trusted the sample's recorded
 * `epochActive` boolean while the gate re-derives it from `periodFinish`, so
 * 78 cells across 15 of the 27 pool × setting rows disagreed outright with
 * what the shipped gate answers on the same words. Calling `evaluateGate`
 * makes both classes structurally impossible: there is only one implementation
 * of the decision, and demo mode is a recording of it.
 *
 * Every input below is read from a committed file. The only judgement is the
 * `--as-of` instant the gate is evaluated at, which must sit inside the gauge
 * epoch the sample recorded — the same instant `npm run model` uses.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_TOKENS,
  COLLATERAL_SYMBOLS,
  CURATED_POOLS,
  poolById,
} from "@zyo/shared";
import { evaluateGate, MIN_GATE_STAKED_SAMPLES } from "../dist/src/gate.js";
import { calibrationIndex, loadMcCalibration } from "../dist/src/mc-calibration.js";
import { ENGINE_FEE_BPS, emissionsAprPct, modelWidthsBps, priceHalfWidth, round2, SETTINGS } from "../dist/src/model.js";

const here = dirname(fileURLToPath(import.meta.url));
const samples = resolve(here, "../samples");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const samplePath = resolve(arg("sample", join(samples, "gauge-emissions-2026-09-12.json")));
const modelPath = resolve(arg("model", join(samples, "lp-model-2026-09-12.json")));
const volPath = resolve(arg("vol", join(samples, "volatility.json")));
const calPath = resolve(arg("calibration", join(samples, "mc-calibration.json")));
const outPath = resolve(arg("out", join(samples, "demo-gate.json")));

const sample = JSON.parse(readFileSync(samplePath, "utf8"));
const model = JSON.parse(readFileSync(modelPath, "utf8"));
const volatility = JSON.parse(readFileSync(volPath, "utf8"));
const mcCalibration = loadMcCalibration(calPath);
if (!mcCalibration) throw new Error(`no MC calibration at ${calPath} — run \`npm run model\` first`);
const mcIndex = calibrationIndex(mcCalibration);

const asOfIso = arg("as-of", model.inputs?.asOf);
if (!asOfIso) throw new Error("--as-of required (or an lp-model with inputs.asOf)");
const nowSeconds = Math.floor(Date.parse(asOfIso) / 1000);
if (!Number.isFinite(nowSeconds)) throw new Error(`--as-of is not a timestamp: ${asOfIso}`);

const borrowAprPct = model.inputs?.borrowAprPct;
if (typeof borrowAprPct !== "number") throw new Error("lp-model inputs.borrowAprPct missing");
const collateralInputs = model.inputs?.collateral ?? {};

/** The Aave sample the gate reads, rebuilt from the recorded live figures. */
const reserve = (symbol, over) => ({
  symbol,
  address: BASE_TOKENS[symbol]?.address?.toLowerCase() ?? "0x",
  supplyAprPct: 0,
  variableBorrowAprPct: 0,
  ltvBps: 0,
  liquidationThresholdBps: 0,
  liquidationBonusBps: 0,
  usageAsCollateralEnabled: true,
  borrowingEnabled: true,
  isActive: true,
  isFrozen: false,
  isPaused: false,
  ...over,
});
const rates = {
  source: "aave-v3-base",
  dataProvider: model.inputs?.dataProvider ?? "0x",
  borrow: reserve("USDC", { variableBorrowAprPct: borrowAprPct }),
  collateral: Object.fromEntries(
    Object.entries(collateralInputs).map(([symbol, c]) => [
      symbol,
      reserve(symbol, {
        supplyAprPct: c.supplyAprPct,
        liquidationThresholdBps: c.liquidationThresholdBps,
      }),
    ])
  ),
  sampledAt: model.inputs?.ratesSampledAt ?? asOfIso,
  stale: false,
};

/**
 * The emissions sample the gate reads, rebuilt from the raw chain words with
 * the SAME formula `sources/gauges.ts` uses (`emissionsAprPct` per width) —
 * never the sample's own precomputed `aprByWidthPct` table, whose keys are
 * half-widths rather than the bps the gate looks up.
 *
 * `corroborated`/`samples`: the recorded words are one verified block read, so
 * there is no rolling history to corroborate against. Demo mode is a recording
 * of a warm service, so the sample is marked corroborated and the provenance
 * below says exactly what that means. A LIVE service still has to earn it.
 */
function emissionsFor(pool) {
  const s = sample.pools?.[pool.id];
  if (!s) return null;
  const rewardRate = BigInt(s.rewardRateWeiPerSec);
  const sqrtPriceX96 = BigInt(s.sqrtPriceX96);
  const periodFinish = Number(s.periodFinish ?? 0);
  const epochActive = rewardRate > 0n && periodFinish > nowSeconds;
  const staked = Number(s.stakedLiquidity ?? 0);
  let aprByWidthPct = {};
  if (epochActive && staked > 0) {
    for (const bps of modelWidthsBps()) {
      const apr = emissionsAprPct({
        rewardRateWeiPerSec: rewardRate,
        aeroUsd: sample.aeroUsd,
        stakedLiquidity: staked,
        sqrtPriceX96,
        token1Decimals: s.dec1,
        token1Usd: s.token1Usd,
        halfWidth: priceHalfWidth(bps),
      });
      if (apr === null) {
        aprByWidthPct = null;
        break;
      }
      aprByWidthPct[String(bps)] = round2(apr);
    }
  } else if (!epochActive) {
    for (const bps of modelWidthsBps()) aprByWidthPct[String(bps)] = 0;
  } else {
    aprByWidthPct = null;
  }
  return {
    poolId: pool.id,
    pool: s.pool,
    gauge: s.gauge,
    rewardRateWeiPerSec: s.rewardRateWeiPerSec,
    periodFinish,
    epochActive,
    wholePoolAprPct: aprByWidthPct === null ? null : round2(s.wholePoolAprPct ?? 0),
    aprByWidthPct,
    stakedLiquidity: String(s.stakedLiquidity ?? "0"),
    samples: MIN_GATE_STAKED_SAMPLES,
    corroborated: true,
    outlier: false,
    sqrtPriceX96: s.sqrtPriceX96,
    feePips: Math.round(s.feeBpsLive * 100),
    aeroUsd: sample.aeroUsd,
    sampledAt: sample.sampledAt,
    stale: false,
  };
}

const verdicts = [];
for (const pool of CURATED_POOLS.filter((p) => p.dex === "AERODROME")) {
  const emissions = emissionsFor(pool);
  for (const setting of SETTINGS) {
    for (const collateral of COLLATERAL_SYMBOLS) {
      verdicts.push(
        evaluateGate({ pool, setting, collateral, rates, emissions, volatility, mcCalibration: mcIndex, nowSeconds })
      );
    }
  }
}

const emissionsSampledAt = sample.sampledAt;
const out = {
  generatedBy: "services/yield/scripts/gen-demo-gate.mjs — evaluateGate() on the recorded inputs, not a reformat of lp-model",
  pinnedFrom: {
    gaugeSample: samplePath.replace(/^.*\/(services\/yield\/samples\/[^/]+)$/, "$1"),
    volatility: volPath.replace(/^.*\/(services\/yield\/samples\/[^/]+)$/, "$1"),
    mcCalibration: calPath.replace(/^.*\/(services\/yield\/samples\/[^/]+)$/, "$1"),
    lpModel: modelPath.replace(/^.*\/(services\/yield\/samples\/[^/]+)$/, "$1"),
  },
  asOf: asOfIso,
  stakedLiquidityProvenance:
    "one verified block read; marked corroborated because demo mode records a warm service. " +
    "A live sample must earn corroboration from MIN_STAKED_SAMPLES independent readings.",
  modelGeneratedAt: model.generatedAt,
  mcCalibrationGeneratedAt: mcCalibration.generatedAt,
  borrowAprPct,
  liquidationThresholdBps: Object.fromEntries(
    Object.entries(collateralInputs).map(([k, v]) => [k, v.liquidationThresholdBps])
  ),
  engineFeeBps: ENGINE_FEE_BPS,
  borrowSource: model.inputs?.borrowSource ?? null,
  ratesSampledAt: rates.sampledAt,
  emissionsSampledAt,
  volatilityAsOf: volatility.asOf,
  stale: false,
  settings: SETTINGS.map((s) => ({ id: s.id, preset: s.preset, rebalanceDelayHours: s.rebalanceDelayHours })),
  verdicts,
  qualifying: verdicts
    .filter((v) => v.qualifies)
    .map((v) => ({ poolId: v.poolId, setting: v.setting, collateral: v.collateral })),
  generatedAt: model.generatedAt,
};

writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
const reasons = [...new Set(verdicts.map((v) => v.reason).filter(Boolean))].sort();
console.log(
  `wrote ${outPath}: ${verdicts.length} verdicts, ${out.qualifying.length} qualifying, ` +
    `borrow ${borrowAprPct}%, reasons served: ${reasons.join(", ")}`
);

// Mirror into the web app so demo mode and the gate can never drift apart.
const webDest = resolve(here, "../../../web/lib/demo-gate.json");
if (existsSync(dirname(webDest))) {
  writeFileSync(webDest, JSON.stringify(out, null, 2) + "\n");
  console.log(`mirrored → ${webDest}`);
}
