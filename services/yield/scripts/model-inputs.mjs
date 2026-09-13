#!/usr/bin/env node
/**
 * Export the shared, non-typed model inputs (range presets, fees, LTV
 * derivation constants, pool classes) to samples/model-inputs.json so
 * scripts/lp-sim.py reads the SAME numbers the service uses. Nothing here
 * is typed by hand: everything is imported from @zyo/shared or the built
 * model. test/model-pin.test.ts fails when the file drifts from the code.
 *
 * Usage: npm run build && node scripts/model-inputs.mjs [out.json]
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CURATED_POOLS,
  ENTRY_HF_FLOOR,
  FEES,
  LTV_PRESET_FIXED_BPS,
  RANGE_PRESETS,
} from "@zyo/shared";
import { MAX_ABS_NET_PCT, MAX_EMISSIONS_APR_PCT } from "../dist/src/gate.js";
import { ENGINE_FEE_BPS, SETTINGS } from "../dist/src/model.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "..", "samples", "model-inputs.json");

const inputs = {
  generatedFrom: "@zyo/shared + services/yield/src/model.ts (scripts/model-inputs.mjs)",
  settings: SETTINGS.map((s) => {
    const def = RANGE_PRESETS.find((p) => p.preset === s.preset);
    return {
      id: s.id,
      preset: s.preset,
      rangeWidthBps: { ...def.rangeWidthBps },
      rebalanceDelayHours: s.rebalanceDelayHours,
    };
  }),
  fees: { performanceBps: FEES.performanceBps, engineFeeBps: ENGINE_FEE_BPS },
  // The floor is the only product-side bound on the top preset (the 50 % cap was removed 2026-09-12);
  // the venue's own max LTV is applied where a venue is read, not here.
  ltv: {
    entryHfFloor: ENTRY_HF_FLOOR,
    fixedBps: { ...LTV_PRESET_FIXED_BPS },
  },
  // gate.ts's plausibility ceiling on a marginal APR and its bound on a net figure, so the sim refuses in
  // the gate's order (`emissions_implausible` before the borrow and σ checks) from the same numbers.
  bounds: { maxEmissionsAprPct: MAX_EMISSIONS_APR_PCT, maxAbsNetPct: MAX_ABS_NET_PCT },
  pools: Object.fromEntries(
    CURATED_POOLS.filter((p) => p.dex === "AERODROME").map((p) => [
      p.id,
      { protocol: p.protocol, pairClass: p.pairClass, token0: p.token0, token1: p.token1 },
    ])
  ),
};
writeFileSync(out, JSON.stringify(inputs, null, 1) + "\n");
console.log(`model inputs → ${out}`);
