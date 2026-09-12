#!/usr/bin/env node
/**
 * Regenerate the demo-mode `/v1/forecast` payload BY RUNNING THE REAL EVALUATOR.
 *
 *   npm run demo-forecast   # → samples/demo-forecast.json (+ web/lib/demo-forecast.json)
 *
 * The twin of gen-demo-gate.mjs (2026-09-12, BUILD-PLAN A3): demo mode is what a first-time user
 * sees before connecting a wallet, so it must be `evaluateForecast`'s own answer on the recorded
 * inputs — every pool × setting × collateral, at the registry floor, with no deposit size (the
 * site re-prices user net at the LTV the user picks from the cell's numbers; the post-borrow rate
 * needs a deposit and is a live-only figure). Inputs are the SAME committed files the gate generator
 * reads, plus the USDC reserve read (curve + totals) that the forecast's liquidity picture needs.
 */
import { writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COLLATERAL_SYMBOLS, CURATED_POOLS, ENTRY_HF_FLOOR } from "@zyo/shared";
import { evaluateForecast } from "../dist/src/forecast.js";
import { calibrationIndex, loadMcCalibration } from "../dist/src/mc-calibration.js";
import { ENGINE_FEE_BPS, SETTINGS } from "../dist/src/model.js";
import { emissionsFromSample, ratesFromModel, readJson, relSample, STAKED_LIQUIDITY_PROVENANCE } from "./demo-inputs.mjs";

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
const reservePath = resolve(arg("reserve", join(samples, "aave-usdc-reserve-2026-09-12.json")));
const outPath = resolve(arg("out", join(samples, "demo-forecast.json")));

const sample = readJson(samplePath);
const model = readJson(modelPath);
const volatility = readJson(volPath);
const reserveRead = readJson(reservePath);
const mcCalibration = loadMcCalibration(calPath);
if (!mcCalibration) throw new Error(`no MC calibration at ${calPath} — run \`npm run model\` first`);
const mcIndex = calibrationIndex(mcCalibration);

const asOfIso = arg("as-of", model.inputs?.asOf);
if (!asOfIso) throw new Error("--as-of required (or an lp-model with inputs.asOf)");
const nowSeconds = Math.floor(Date.parse(asOfIso) / 1000);
if (!Number.isFinite(nowSeconds)) throw new Error(`--as-of is not a timestamp: ${asOfIso}`);

// The gate generator's rates (the model's recorded borrow and collateral figures), completed with the
// venue flags the gauge sample recorded and the curve + totals from the reserve read. Two reads, two
// dates, both named in the payload.
const base = ratesFromModel(model, asOfIso);
const sampledAave = sample.aave ?? {};
const complete = (r, recorded) => ({ ...r, ...(recorded ? { ltvBps: recorded.ltvBps, liquidationBonusBps: recorded.liquidationBonusBps } : {}) });
const rd = reserveRead.getReserveData;
const rates = {
  ...base,
  borrow: {
    ...complete(base.borrow, sampledAave.borrow),
    decimals: reserveRead.decimals,
    totalATokenUnits: rd.totalAToken,
    totalVariableDebtUnits: rd.totalVariableDebt,
  },
  collateral: Object.fromEntries(
    Object.entries(base.collateral).map(([s, r]) => [
      s,
      { ...complete(r, sampledAave.collateral?.[s]), decimals: 0, totalATokenUnits: "1", totalVariableDebtUnits: "0" },
    ])
  ),
  borrowCurve: { strategy: reserveRead.strategy.toLowerCase(), ...reserveRead.getInterestRateDataBps },
};

const cells = [];
for (const pool of CURATED_POOLS.filter((p) => p.dex === "AERODROME")) {
  const emissions = emissionsFromSample(sample, pool, nowSeconds);
  for (const setting of SETTINGS) {
    for (const collateral of COLLATERAL_SYMBOLS) {
      cells.push(
        evaluateForecast({
          pool, setting, collateral, rates, emissions, volatility, mcCalibration: mcIndex, nowSeconds,
          entryHf: ENTRY_HF_FLOOR, entryHfFloor: ENTRY_HF_FLOOR, depositUsd: null,
          // No live price sample in the recording; the site prices liquidation from its own chain read.
          collateralPriceUsd: null,
        })
      );
    }
  }
}

const out = {
  generatedBy: "services/yield/scripts/gen-demo-forecast.mjs — evaluateForecast() on the recorded inputs, at the registry floor, no deposit size",
  pinnedFrom: {
    gaugeSample: relSample(samplePath),
    volatility: relSample(volPath),
    mcCalibration: relSample(calPath),
    lpModel: relSample(modelPath),
    usdcReserve: relSample(reservePath),
  },
  asOf: asOfIso,
  stakedLiquidityProvenance: STAKED_LIQUIDITY_PROVENANCE,
  usdcReserveReadAt: reserveRead.readAt,
  usdcReserveBlock: reserveRead.block,
  modelGeneratedAt: model.generatedAt,
  entryHf: ENTRY_HF_FLOOR,
  entryHfFloor: ENTRY_HF_FLOOR,
  depositUsd: null,
  borrowAprPct: model.inputs.borrowAprPct,
  ratesSampledAt: rates.sampledAt,
  emissionsSampledAt: sample.sampledAt,
  volatilityAsOf: volatility.asOf,
  engineFeeBps: ENGINE_FEE_BPS,
  stale: false,
  mcCalibrationGeneratedAt: mcCalibration.generatedAt,
  settings: SETTINGS.map((s) => ({ id: s.id, preset: s.preset, rebalanceDelayHours: s.rebalanceDelayHours })),
  cells,
  generatedAt: model.generatedAt,
  methodologyUrl: "https://github.com/mbrobert/ZEC-Defi-App/blob/main/docs/YIELD-SERVICE.md",
};

writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
const priced = cells.filter((c) => c.lpPriced).length;
const allowed = cells.filter((c) => c.allowed).length;
const clears = cells.filter((c) => c.clearsBorrow.both).length;
console.log(`wrote ${outPath}: ${cells.length} cells, ${priced} priced, ${allowed} allowed, ${clears} clear the borrow on both forms, borrow ${out.borrowAprPct}%`);

const webDest = resolve(here, "../../../web/lib/demo-forecast.json");
if (existsSync(dirname(webDest))) {
  writeFileSync(webDest, JSON.stringify(out, null, 2) + "\n");
  console.log(`mirrored → ${webDest}`);
}
