#!/usr/bin/env node
/**
 * verify-abi — diff the keeper's hand-written ABI fragments against the
 * compiled contract artifacts in contracts/out/. Fails the suite on any
 * selector, event topic or argument-layout drift (AUDIT-FINDINGS Part 4:
 * "the ABI seam broke twice"; this script is the durable fix).
 *
 * Runs as part of `npm test` in agent/. When an artifact is absent (contracts
 * not compiled in this checkout) it reports SKIP for that contract — loudly —
 * rather than passing silently; set VERIFY_ABI_STRICT=1 to make that fatal.
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { toFunctionSelector, toEventSelector, getAbiItem } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(here, "..");
const contractsOut = resolve(agentRoot, "..", "contracts", "out");
const strict = process.env.VERIFY_ABI_STRICT === "1";

const { oilskinAccountAbi, oilskinAccountFactoryAbi, strategyRouterAbi, lpVenueAbi, KEEPER_SELECTORS, GRANT_SELECTORS } = await import(
  join(agentRoot, "dist", "src", "abi", "oilskin.js")
);
const { aavePoolAbi, aavePoolDataProviderAbi, aaveOracleAbi, chainlinkAggregatorAbi } = await import(
  join(agentRoot, "dist", "src", "abi", "aave.js")
);

let failures = 0;
let checks = 0;
let skipped = 0;

function sig(item) {
  const args = item.inputs.map(canonicalType).join(",");
  return `${item.name}(${args})`;
}
function canonicalType(p) {
  if (p.type === "tuple" || p.type.startsWith("tuple")) {
    const inner = `(${p.components.map(canonicalType).join(",")})`;
    return p.type.replace("tuple", inner);
  }
  return p.type;
}

function loadArtifact(name) {
  const p = join(contractsOut, `${name}.sol`, `${name}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function compare(label, ours, artifact) {
  if (!artifact) {
    skipped += 1;
    console.log(`verify-abi: SKIP ${label} — no artifact at contracts/out/${label}.sol/${label}.json`);
    if (strict) failures += 1;
    return;
  }
  const theirs = artifact.abi;
  for (const item of ours) {
    checks += 1;
    if (item.type === "function") {
      const match = theirs.find((t) => t.type === "function" && sig(t) === sig(item));
      if (!match) {
        failures += 1;
        console.log(`verify-abi: FAIL ${label}.${sig(item)} not in artifact (selector ${toFunctionSelector(sig(item))})`);
        continue;
      }
      const oursOut = (item.outputs ?? []).map(canonicalType).join(",");
      const theirsOut = (match.outputs ?? []).map(canonicalType).join(",");
      if (oursOut !== theirsOut) {
        failures += 1;
        console.log(`verify-abi: FAIL ${label}.${sig(item)} outputs differ: ours=(${oursOut}) artifact=(${theirsOut})`);
      }
      if ((item.stateMutability ?? "") !== (match.stateMutability ?? "")) {
        failures += 1;
        console.log(`verify-abi: FAIL ${label}.${sig(item)} stateMutability ${item.stateMutability} ≠ ${match.stateMutability}`);
      }
    } else if (item.type === "event") {
      const match = theirs.find((t) => t.type === "event" && sig(t) === sig(item));
      if (!match) {
        failures += 1;
        console.log(`verify-abi: FAIL ${label} event ${sig(item)} not in artifact (topic ${toEventSelector(sig(item))})`);
        continue;
      }
      const oursIdx = item.inputs.map((i) => `${i.name}:${i.indexed ? "i" : "d"}`).join(",");
      const theirsIdx = match.inputs.map((i) => `${i.name}:${i.indexed ? "i" : "d"}`).join(",");
      if (oursIdx !== theirsIdx) {
        failures += 1;
        console.log(`verify-abi: FAIL ${label} event ${sig(item)} indexed layout differs: ours=${oursIdx} artifact=${theirsIdx}`);
      }
    } else if (item.type === "error") {
      const match = theirs.find((t) => t.type === "error" && sig(t) === sig(item));
      if (!match) {
        failures += 1;
        console.log(`verify-abi: FAIL ${label} error ${sig(item)} not declared on this contract`);
      }
    }
  }
}

compare("OilskinAccount", oilskinAccountAbi, loadArtifact("OilskinAccount"));
compare("OilskinAccountFactory", oilskinAccountFactoryAbi, loadArtifact("OilskinAccountFactory"));
compare("StrategyRouter", strategyRouterAbi, loadArtifact("StrategyRouter"));
compare("SnuggleLpVenue", lpVenueAbi, loadArtifact("SnuggleLpVenue"));

// Grant selectors: the keeper refuses to act unless grantOf(keeper, target, selector) is active
// for exactly these; a drift here would make every dispatch REFUSED (or worse, check the wrong grant).
const grantSources = { "StrategyRouter.unwind": [strategyRouterAbi, "unwind"], "SnuggleLpVenue.closeMany": [lpVenueAbi, "closeMany"] };
for (const [name, sel] of Object.entries(GRANT_SELECTORS ?? {})) {
  checks += 1;
  const [abi, fn] = grantSources[name];
  const item = abi.find((x) => x.type === "function" && x.name === fn);
  const expected = toFunctionSelector(sig(item));
  if (expected !== sel) {
    failures += 1;
    console.log(`verify-abi: FAIL GRANT_SELECTORS.${name} = ${sel}, ABI says ${expected}`);
  }
  // …and the artifact agrees with our fragment (compare() above already checked the signature).
}

// Selectors the keeper hard-codes for grant checks must equal the ABI's.
for (const [name, sel] of Object.entries(KEEPER_SELECTORS ?? {})) {
  checks += 1;
  const item = getAbiItem({ abi: [...oilskinAccountAbi, ...aavePoolAbi], name: name.split(".").pop() });
  if (!item) {
    failures += 1;
    console.log(`verify-abi: FAIL KEEPER_SELECTORS.${name}: no ABI item`);
    continue;
  }
  const expected = toFunctionSelector(sig(item));
  if (expected !== sel) {
    failures += 1;
    console.log(`verify-abi: FAIL KEEPER_SELECTORS.${name} = ${sel}, ABI says ${expected}`);
  }
}

// Aave / Chainlink: no artifacts in-repo; pin the selectors that
// VERIFIED-BASE-FACTS confirmed live (computed with `cast sig`).
const PINNED = {
  "getUserAccountData(address)": "0xbf92857c",
  "getReserveConfigurationData(address)": "0x3e150141",
  "getUserReserveData(address,address)": "0x28dd2d01",
  "getAssetPrice(address)": "0xb3596f07",
  "latestRoundData()": "0xfeaf968c",
  "decimals()": "0x313ce567",
};
for (const abi of [aavePoolAbi, aavePoolDataProviderAbi, aaveOracleAbi, chainlinkAggregatorAbi]) {
  for (const item of abi) {
    if (item.type !== "function") continue;
    checks += 1;
    const s = sig(item);
    const sel = toFunctionSelector(s);
    if (PINNED[s] !== sel) {
      failures += 1;
      console.log(`verify-abi: FAIL pinned selector ${s}: ${sel} ≠ ${PINNED[s]}`);
    }
  }
}

console.log(`verify-abi: ${checks - failures}/${checks} checks passed, ${skipped} contract(s) skipped${strict ? " (strict)" : ""}`);
process.exit(failures ? 1 : 0);
