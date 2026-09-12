#!/usr/bin/env node
/**
 * run-model — runs scripts/lp-sim.py with EVERY input lifted from one gauge sample file: the
 * as-of instant is the sample's own, and the borrow rate, the supply rates and the liquidation
 * thresholds are the Aave words the same sample carries. Nothing numeric is typed here or in
 * package.json (before 2026-09-12 the `model` script carried "--borrow 4.828 --supply
 * cbBTC=0.012,WETH=1.843 --lt cbBTC=7800,WETH=8300" by hand — copied from a document, which is
 * the one thing CLAUDE.md rule 3 forbids).
 *
 *   node scripts/run-model.mjs --sample samples/gauge-emissions-<date>.json [--paths N] [--seed N]
 *
 * Writes samples/lp-model-<date>.json, samples/MODEL-NUMBERS.md and samples/mc-calibration.json,
 * exactly as `npm run model` always did. Run `npm run model-inputs` first (package.json does).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const yieldDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const samplePath = arg("sample");
if (!samplePath) {
  console.error("usage: run-model.mjs --sample samples/gauge-emissions-<date>.json [--paths N] [--seed N]");
  process.exit(2);
}
const sample = JSON.parse(readFileSync(resolve(yieldDir, samplePath), "utf8"));
const rates = sample.aave ?? sample.rates;
if (!rates?.borrow || typeof rates.borrow.variableBorrowAprPct !== "number") {
  console.error(`${samplePath}: no Aave rates (aave.borrow.variableBorrowAprPct) in the sample`);
  process.exit(2);
}
// The as-of instant: the sample's own, rounded UP to the next whole second — lp-sim.py keeps unix
// seconds, and a truncated as-of would sit milliseconds BEFORE the words it evaluates (the
// demo-gate test refuses a gate evaluated before its inputs exist).
const asOf = new Date(Math.ceil(Date.parse(sample.sampledAt) / 1000) * 1000).toISOString().replace(".000Z", "Z");
const date = asOf.slice(0, 10);
const collateral = rates.collateral ?? rates.reserves ?? {};
const symbols = Object.keys(collateral).filter((s) => s !== "USDC");
if (symbols.length === 0) {
  console.error(`${samplePath}: no collateral reserves in the sample`);
  process.exit(2);
}
const supply = symbols.map((s) => `${s}=${collateral[s].supplyAprPct}`).join(",");
const lt = symbols.map((s) => `${s}=${collateral[s].liquidationThresholdBps}`).join(",");
const borrowSource =
  `Aave v3 Base PoolDataProvider getReserveData(USDC) variableBorrowRate, read live ${rates.sampledAt ?? asOf}` +
  ` at block ${sample.block} (${samplePath})`;

const args = [
  "scripts/lp-sim.py",
  "--sample", samplePath,
  "--vol", "samples/volatility.json",
  "--inputs", "samples/model-inputs.json",
  "--as-of", asOf,
  "--borrow", String(rates.borrow.variableBorrowAprPct),
  "--borrow-source", borrowSource,
  "--supply", supply,
  "--lt", lt,
  "--out", `samples/lp-model-${date}.json`,
  "--md", "samples/MODEL-NUMBERS.md",
  "--calibration", "samples/mc-calibration.json",
];
for (const k of ["paths", "seed"]) {
  const v = arg(k);
  if (v !== undefined) args.push(`--${k}`, v);
}
console.log(`run-model: as-of ${asOf}, borrow ${rates.borrow.variableBorrowAprPct}%, supply ${supply}, LT ${lt} → samples/lp-model-${date}.json`);
const r = spawnSync("python3", args, { cwd: yieldDir, stdio: "inherit" });
process.exit(r.status ?? 1);
