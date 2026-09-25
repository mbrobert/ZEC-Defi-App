#!/usr/bin/env node
/**
 * verify-abi — the machine-checked seam between contracts and every other area.
 *
 * Reads the compiled artifacts in contracts/out/ and compares them with the committed
 * contracts/abi/oilskin-abi.json — the ONE file the keeper, the web app and the yield service
 * import (full ABIs plus every function selector, event topic and error selector). Any drift
 * fails with exit code 1 and lists it.
 *
 *   node scripts/verify-abi.mjs           diff artifacts against the committed JSON (CI mode)
 *   node scripts/verify-abi.mjs --write   regenerate the JSON from the artifacts
 *   node scripts/verify-abi.mjs --print   print selectors / topics (human check)
 *
 * Why this exists: the previous project lost this seam twice — the agent encoded selectors from a
 * written document instead of the compiled artifacts, and errors were declared on the wrong
 * contract, so revert paths were misclassified (AUDIT-FINDINGS-2026-09-03 Part 4). Wire this into
 * every area's test script; a missing artifact is a failure, not a skip.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toFunctionSelector, toEventSelector } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const outDir = join(repoRoot, "contracts", "out");
const abiPath = join(repoRoot, "contracts", "abi", "oilskin-abi.json");

/** Every contract and interface another area may encode against. */
const CONTRACTS = [
  "OilskinAccount",
  "OilskinAccountFactory",
  "AaveV3Venue",
  "MorphoBlueVenue",
  "SnuggleLpVenue",
  "CollateralRegistry",
  "AerodromeSwapAdapter",
  "SlipstreamLpVenue",
  "SlipstreamPoolSwapAdapter",
  "StrategyRouter",
  "PythOracleAdapter",
  "HyperliquidPerpVenue",
  "IOilskinAccount",
  "ICollateralVenue",
  "ILpVenue",
  "ISwapAdapter",
  "ISnuggleVault",
  "IAerodromeCLPool",
  "IPermit2",
  "IPyth",
];

const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--print") ? "print" : "check";

function canonicalType(p) {
  if (p.type.startsWith("tuple")) {
    return p.type.replace("tuple", `(${p.components.map(canonicalType).join(",")})`);
  }
  return p.type;
}
function signature(item) {
  return `${item.name}(${item.inputs.map(canonicalType).join(",")})`;
}

function loadArtifact(name) {
  const p = join(outDir, `${name}.sol`, `${name}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function summarize(name, artifact) {
  const functions = {};
  const events = {};
  const errors = {};
  for (const item of artifact.abi) {
    if (item.type === "function") {
      const sig = signature(item);
      functions[sig] = {
        selector: toFunctionSelector(sig),
        stateMutability: item.stateMutability,
        outputs: (item.outputs ?? []).map(canonicalType).join(","),
      };
    } else if (item.type === "event") {
      const sig = signature(item);
      events[sig] = {
        topic0: toEventSelector(sig),
        indexed: item.inputs.map((i) => Boolean(i.indexed)),
      };
    } else if (item.type === "error") {
      const sig = signature(item);
      errors[sig] = { selector: toFunctionSelector(sig) };
    }
  }
  return { name, functions, events, errors, abi: artifact.abi };
}

function build() {
  const contracts = {};
  const missing = [];
  for (const name of CONTRACTS) {
    const artifact = loadArtifact(name);
    if (!artifact) {
      missing.push(name);
      continue;
    }
    contracts[name] = summarize(name, artifact);
  }
  return { contracts, missing };
}

function diff(committed, fresh) {
  const problems = [];
  const names = new Set([...Object.keys(committed.contracts), ...Object.keys(fresh.contracts)]);
  for (const name of names) {
    const a = committed.contracts[name];
    const b = fresh.contracts[name];
    if (!a) {
      problems.push(`${name}: present in artifacts, missing from committed JSON (run --write)`);
      continue;
    }
    if (!b) {
      problems.push(`${name}: in committed JSON but no artifact (deleted contract? run --write)`);
      continue;
    }
    for (const kind of ["functions", "events", "errors"]) {
      const keys = new Set([...Object.keys(a[kind]), ...Object.keys(b[kind])]);
      for (const sig of keys) {
        const x = a[kind][sig];
        const y = b[kind][sig];
        if (!x) problems.push(`${name}.${kind} ${sig}: NEW in artifact`);
        else if (!y) problems.push(`${name}.${kind} ${sig}: REMOVED from artifact`);
        else if (JSON.stringify(x) !== JSON.stringify(y)) {
          problems.push(`${name}.${kind} ${sig}: changed ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
        }
      }
    }
  }
  return problems;
}

const fresh = build();
if (fresh.missing.length) {
  console.error(`verify-abi: missing artifacts for ${fresh.missing.join(", ")} — run 'forge build' in contracts/`);
  process.exit(1);
}

if (mode === "write") {
  mkdirSync(dirname(abiPath), { recursive: true });
  const payload = {
    generatedFrom: "contracts/out (forge build, solc 0.8.24, via-ir)",
    note: "Generated by scripts/verify-abi.mjs --write. Do not edit by hand; every area imports this file.",
    contracts: fresh.contracts,
  };
  writeFileSync(abiPath, JSON.stringify(payload, null, 2) + "\n");
  let fns = 0, evs = 0, errs = 0;
  for (const c of Object.values(fresh.contracts)) {
    fns += Object.keys(c.functions).length;
    evs += Object.keys(c.events).length;
    errs += Object.keys(c.errors).length;
  }
  console.log(`verify-abi: wrote ${abiPath} — ${Object.keys(fresh.contracts).length} contracts, ${fns} functions, ${evs} events, ${errs} errors`);
  process.exit(0);
}

if (mode === "print") {
  for (const c of Object.values(fresh.contracts)) {
    console.log(`\n== ${c.name}`);
    for (const [sig, f] of Object.entries(c.functions)) console.log(`  fn    ${f.selector}  ${sig} → (${f.outputs}) [${f.stateMutability}]`);
    for (const [sig, e] of Object.entries(c.events)) console.log(`  event ${e.topic0}  ${sig}`);
    for (const [sig, e] of Object.entries(c.errors)) console.log(`  error ${e.selector}  ${sig}`);
  }
  process.exit(0);
}

if (!existsSync(abiPath)) {
  console.error(`verify-abi: ${abiPath} does not exist — run with --write once and commit it`);
  process.exit(1);
}
const committed = JSON.parse(readFileSync(abiPath, "utf8"));
const problems = diff(committed, fresh);
let checks = 0;
for (const c of Object.values(fresh.contracts)) {
  checks += Object.keys(c.functions).length + Object.keys(c.events).length + Object.keys(c.errors).length;
}
if (problems.length) {
  for (const p of problems) console.error(`verify-abi: DRIFT ${p}`);
  console.error(`verify-abi: ${problems.length} drift(s) across ${checks} checks — regenerate with --write and update every consumer`);
  process.exit(1);
}
console.log(`verify-abi: ${checks} selectors/topics/errors across ${Object.keys(fresh.contracts).length} contracts match contracts/abi/oilskin-abi.json`);
