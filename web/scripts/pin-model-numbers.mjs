#!/usr/bin/env node
/**
 * Regenerate lib/demo-gate.json — the demo-mode /v1/gate payload — from the
 * yield engineer's model output (services/yield/samples/lp-model-*.json, the
 * same generated source behind /tmp/build/MODEL-NUMBERS.md). Demo mode must
 * show exactly the numbers the model produced, never a placeholder.
 *
 *   node scripts/pin-model-numbers.mjs [path/to/lp-model.json]
 *
 * test/snapshot.test.ts asserts the committed JSON equals MODEL-NUMBERS.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(process.argv[2] ?? join(here, "../../services/yield/samples/lp-model-2026-09-05.json"));
const model = JSON.parse(readFileSync(src, "utf8"));

const SETTINGS = [
  { id: "sheltered", preset: "CONSERVATIVE" },
  { id: "steady", preset: "MODERATE" },
  { id: "working", preset: "AGGRESSIVE" },
];
const COLLATERALS = ["cbBTC", "WETH", "cbZEC"];
const borrowAprPct = model.inputs?.borrowAprPct ?? model.inputs?.borrow?.aprPct;
if (typeof borrowAprPct !== "number") throw new Error("model.inputs.borrowAprPct missing");
const collateralInputs = model.inputs?.collateral ?? {};
const supply = Object.fromEntries(Object.entries(collateralInputs).map(([k, v]) => [k, v.supplyAprPct]));
const lts = Object.fromEntries(Object.entries(collateralInputs).map(([k, v]) => [k, v.liquidationThresholdBps]));
const engineFeeBps = model.inputs?.fees?.engineFeeBps ?? null;

const round2 = (x) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 100) / 100 : null);
const verdicts = [];
for (const [poolId, bySetting] of Object.entries(model.results)) {
  for (const s of SETTINGS) {
    const cell = bySetting[s.id];
    if (!cell) continue;
    for (const collateral of COLLATERALS) {
      const enabled = collateral !== "cbZEC";
      const userNetCell = cell.userNet?.[collateral];
      const userNet = userNetCell
        ? ["p30", "p40", "top"].map((k) => ({ ltvBps: userNetCell[k].ltvBps, offerable: userNetCell[k].offerable, userNetPct: round2(userNetCell[k].userNetPct) }))
        : [];
      verdicts.push({
        poolId,
        setting: s.id,
        preset: s.preset,
        collateral,
        rangeWidthBps: cell.rangeWidthBps,
        halfWidth: cell.halfWidth,
        qualifies: enabled ? cell.qualifies === true : false,
        reason: enabled ? (cell.qualifies ? null : cell.reason) : "collateral_disabled",
        emissionsGrossPct: enabled ? round2(cell.emissionsGrossPct) : null,
        emissionsNetPct: enabled ? round2(cell.emissionsNetPct) : null,
        emissionsRealizedPct: enabled ? round2(cell.emissionsRealizedPct) : null,
        dragPct: enabled ? round2(cell.dragPct) : null,
        lpNetPct: enabled ? round2(cell.lpNetPct) : null,
        borrowAprPct: enabled ? borrowAprPct : null,
        collateralSupplyAprPct: enabled ? (supply[collateral] ?? null) : null,
        sigma: enabled ? (cell.sigma ?? null) : null,
        breakEvenSigma: enabled ? round2(cell.breakEvenSigma) : null,
        breakEvenEmissionsMultiple: enabled ? round2(cell.breakEvenEmissionsMultiple) : null,
        userNet: enabled ? userNet : [],
      });
    }
  }
}

const out = {
  pinnedFrom: src.replace(/^.*\/(services\/yield\/samples\/[^/]+)$/, "$1"),
  modelGeneratedAt: model.generatedAt,
  borrowAprPct,
  liquidationThresholdBps: lts,
  /** External protocol parameter carried by the yield model (services/yield/src/model.ts), for the fee breakdown only. */
  engineFeeBps,
  borrowSource: model.inputs?.borrowSource ?? null,
  ratesSampledAt: "2026-09-05T01:00:00Z",
  emissionsSampledAt: model.inputs?.gaugeSample?.sampledAt ?? null,
  volatilityAsOf: model.inputs?.volatility?.asOf ?? null,
  settings: SETTINGS.map((s) => ({ ...s, rebalanceDelayHours: Object.values(model.results)[0]?.[s.id]?.rebalanceDelayHours ?? null })),
  verdicts,
  qualifying: verdicts.filter((v) => v.qualifies).map((v) => ({ poolId: v.poolId, setting: v.setting, collateral: v.collateral })),
  generatedAt: model.generatedAt,
};
const dest = join(here, "../lib/demo-gate.json");
writeFileSync(dest, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${dest}: ${verdicts.length} verdicts, ${out.qualifying.length} qualifying, borrow ${borrowAprPct}%`);
