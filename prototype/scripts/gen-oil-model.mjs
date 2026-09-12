#!/usr/bin/env node
/**
 * gen-oil-model — re-pins the prototypes' OIL_MODEL block (prototype/simple.html and
 * prototype/index.html, byte-equal between the two) from the yield model's own output.
 *
 *   node prototype/scripts/gen-oil-model.mjs services/yield/samples/lp-model-<date>.json
 *
 * Reads the lp-model JSON `scripts/lp-sim.py` wrote (inputs, results, calibration, boundaryGuard),
 * the gauge sample it names, and the pages themselves. Nothing numeric is typed here: every
 * σ, fee, emissions figure, verdict, coefficient and boundary row is copied from the model; the
 * per-pool STATIC fields (name, tag, pair class, entry asset, icons, engine id, address) are taken
 * from the pages' existing block, never retyped. `prototype/test/verify-toggle.mjs` then checks
 * the result against /tmp/build/MODEL-NUMBERS.md row by row.
 *
 * Before 2026-09-12 (slice K) the block was edited by hand; this generator exists so the pin can
 * move with every model run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const modelPath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: gen-oil-model.mjs <services/yield/samples/lp-model-<date>.json>");
  process.exit(2);
}
const model = JSON.parse(readFileSync(modelPath, "utf8"));
const samplePath = resolve(dirname(modelPath), "..", model.inputs.gaugeSample.file.replace(/^samples\//, "samples/"));
const sample = JSON.parse(readFileSync(samplePath, "utf8"));

const SETTINGS = ["sheltered", "steady", "working"];
const r2 = (v) => (v === null || v === undefined || Number.isNaN(v) ? null : Math.round(v * 100) / 100);
const fmt2 = (v) => (v === null ? "null" : v.toFixed(2));
const num = (v) => (v === null || v === undefined ? "null" : String(v));

const pages = ["simple.html", "index.html"].map((f) => join(repo, "prototype", f));
const START = "/* ── OIL_MODEL — pinned to";

/** The existing block of one page: [before, block, after]. */
function split(text) {
  const s = text.indexOf(START);
  if (s < 0) throw new Error("OIL_MODEL start marker not found");
  const e = text.indexOf("\n});\n", s);
  if (e < 0) throw new Error("OIL_MODEL end not found");
  return [text.slice(0, s), text.slice(s, e + "\n});\n".length), text.slice(e + "\n});\n".length)];
}

/**
 * The static parts of each pool line, keyed by id: the prefix up to ` sigma:` (name, tag, pair
 * class, entry asset, icons, engine id, address) and the trailing hand-written fields after the
 * emissions table (`note`, and flags such as `tracked` / `direct` that the page's fee logic reads).
 * Also the line's recorded `epochActive`, so a note can be reworded when that state flips.
 */
function staticPools(block) {
  const out = new Map();
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^    \{ id:"([^"]+)",(.*?)\s+sigma:.*?epochActive: (true|false), emissions: \{[^}]*\}(.*)$/);
    if (!m) continue;
    // Trailing fields sit either on this line (`, note:"…", tracked:true },`) or, for a lapsed-epoch
    // entry, on the continuation lines (`sampledAprByHalfWidth` is regenerated; `note` is kept).
    let trail = m[4].replace(/\s*\},?\s*$/, "").replace(/^,\s*/, "");
    if (m[4].trim() === "," || m[4].trim() === "") {
      // A lapsed-epoch entry continues over a comment, the raw-reading table and a final
      // `note:"…" },` line (with any flags after the note); the note and the flags are kept.
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const n = lines[j].match(/^\s+(note:"[^"]*".*?)\s*\},?\s*$/);
        if (n) { trail = n[1].replace(/,\s*$/, ""); break; }
      }
    }
    out.set(m[1], { prefix: `    { id:"${m[1]}",${m[2]}`, trail, epochActive: m[3] === "true" });
  }
  return out;
}
function keepLine(block, key) {
  const m = block.match(new RegExp(`^  ${key}: .*$`, "m"));
  if (!m) throw new Error(`${key} line not found in the existing block`);
  return m[0];
}

const [, existingBlock] = split(readFileSync(pages[0], "utf8"));
const statics = staticPools(existingBlock);
const keep = keepLine(existingBlock, "keep");
const bounds = keepLine(existingBlock, "bounds");

const inputs = model.inputs;
const gen = model.generatedAt;
const asOf = inputs.asOf;
const asOfZ = asOf.replace("+00:00", "Z");
const sampledAt = inputs.gaugeSample.sampledAt;
const block = inputs.gaugeSample.block;
const aeroUsd = Math.round(inputs.gaugeSample.aeroUsd * 10000) / 10000;
const borrow = inputs.borrowAprPct;
const sigmaOf = (id) => inputs.volatility.sigma[id] ?? null;
const paths = inputs.monteCarlo?.paths ?? model.calibration?.paths ?? 6000;
const seed = inputs.monteCarlo?.seed ?? 7;
const samplePools = new Map(Array.isArray(sample.pools) ? sample.pools.map((p) => [p.id, p]) : Object.entries(sample.pools ?? {}).map(([id, p]) => [id, { id, ...p }]));

// ---- pools --------------------------------------------------------------------------------
const poolLines = [];
for (const id of Object.keys(model.results)) {
  const cells = model.results[id];
  const st = statics.get(id);
  if (!st) throw new Error(`no static fields for pool ${id} in the existing block — add the pool line by hand once`);
  const first = cells[SETTINGS[0]];
  const feeBps = first.feeBpsLive ?? null;
  const epochActive = SETTINGS.every((s) => cells[s].epochActive);
  const emissions = SETTINGS.map((s) => `${cells[s].rangeWidthBps}: ${fmt2(r2(cells[s].emissionsGrossPct))}`).join(", ");
  let line = `${st.prefix} sigma: ${sigmaOf(id) === null ? "null" : sigmaOf(id).toFixed(2)}, feeBps: ${num(feeBps)}, epochActive: ${epochActive}, emissions: { ${emissions} }`;
  // The hand-written trailing fields are kept verbatim; only a note whose epoch state flipped since
  // the block was last written is replaced by a plain statement of the new state.
  let trail = st.trail;
  if (st.epochActive !== epochActive && /note:"/.test(trail)) {
    const newNote = epochActive
      ? `gauge epoch active at the ${sampledAt.slice(0, 10)} sample${sigmaOf(id) === null ? " — no σ calibrated, no forecast" : ""}`
      : `gauge epoch lapsed at the ${sampledAt.slice(0, 10)} sample`;
    trail = trail.replace(/note:"[^"]*"/, `note:"${newNote}"`);
  }
  const sp = samplePools.get(id);
  // The lapsed gauge's would-be reading: the sample's own table when it carries one (the 2026-08-31
  // words did), else the per-cell `emissionsIfRevotedGrossPct` the simulator computes from the same
  // raw words (2026-09-12 onward), keyed by the cell's exact half-width.
  let rawTable = sp ? (sp.aprByWidthPct ?? sp.aprByHalfWidth) : null;
  if (!epochActive && !(rawTable && Object.values(rawTable).some((v) => v > 0))) {
    const fromCells = Object.fromEntries(
      SETTINGS.filter((s) => typeof cells[s].emissionsIfRevotedGrossPct === "number" && cells[s].emissionsIfRevotedGrossPct > 0).map((s) => [String(Math.round(cells[s].halfWidth * 10000) / 10000), cells[s].emissionsIfRevotedGrossPct])
    );
    rawTable = Object.keys(fromCells).length ? fromCells : null;
  }
  if (!epochActive && rawTable && Object.values(rawTable).some((v) => v > 0)) {
    // The epoch had lapsed at the as-of instant: the model publishes 0, the raw reading is kept
    // verbatim keyed by half-width (the real example of a marginal APR the plausibility ceiling
    // exists to refuse).
    const raw = Object.entries(rawTable)
      .map(([k, v]) => `${k}: ${fmt2(r2(v))}`)
      .join(", ");
    const noteLine = /note:"/.test(trail) ? trail.match(/note:"[^"]*"/)[0] : `note:"the gauge epoch had lapsed at the sample"`;
    const flags = trail.replace(/,?\s*note:"[^"]*"/, "").replace(/^,\s*/, "").trim();
    line +=
      `,\n      /* The gauge's epoch had LAPSED at the as-of instant (periodFinish ${cells.sheltered.periodFinish} < ${asOfZ}), so the model publishes 0. The reading the sample actually carried is kept verbatim, keyed by the half-width it was measured at, because it is the real example of a marginal in-range APR that the plausibility ceiling exists to refuse. */\n` +
      `      sampledAprByHalfWidth: { ${raw} },\n      ${noteLine}${flags ? ", " + flags : ""} },`;
  } else {
    line += trail ? `, ${trail} },` : " },";
  }
  poolLines.push(line);
}

// ---- mc ------------------------------------------------------------------------------------
const mcCells = (model.calibration ?? []).map(
  (c) =>
    `      ["${c.poolId}", ${c.rangeWidthBps}, ${c.sigma.toFixed(2)}, ${num(c.feeBps)}, ${c.inRangeEmissionsFactor}, ${c.mcDragPct}, ${c.timeInRange}, ${c.rebalancesPerYear}],`
);

// ---- served ----------------------------------------------------------------------------------
const servedLines = [];
for (const id of Object.keys(model.results)) {
  const cells = model.results[id];
  servedLines.push(
    "    " +
      SETTINGS.map((s) => {
        const c = cells[s];
        const lp = c.reason === "ok" || c.lpNetPct !== null && c.lpNetPct !== undefined && ["net_below_borrow", "within_model_uncertainty", "ok"].includes(c.reason) ? fmt2(r2(c.lpNetPct)) : "null";
        return `["${id}", ${c.rangeWidthBps}, ${lp}, "${c.reason}"]`;
      }).join(", ") +
      ","
  );
}

// ---- userNetPinned: the same nine slots the block has always sampled, where still published ----
const SLOTS = [
  ["aero-usdc-weth-5", "sheltered", "cbBTC", "p30"], ["aero-usdc-weth-5", "sheltered", "WETH", "top"], ["aero-usdc-weth-5", "working", "cbBTC", "top"],
  ["aero-cbbtc-usdc", "sheltered", "cbBTC", "p30"], ["aero-cbbtc-usdc", "sheltered", "WETH", "p30"], ["aero-cbbtc-usdc", "steady", "WETH", "p40"], ["aero-cbbtc-usdc", "working", "cbBTC", "top"],
  ["aero-weth-cbbtc", "steady", "WETH", "top"], ["aero-weth-cbbtc", "working", "cbBTC", "top"],
];
const pinned = [];
for (const [id, s, asset, preset] of SLOTS) {
  const c = model.results[id]?.[s];
  const u = c?.userNet?.[asset]?.[preset];
  if (!u) continue;
  pinned.push(`["${id}", ${c.rangeWidthBps}, "${asset}", ${u.ltvBps / 100}, ${fmt2(r2(u.userNetPct))}]`);
}
const pinnedLines = [];
for (let i = 0; i < pinned.length; i += 3) pinnedLines.push("    " + pinned.slice(i, i + 3).join(", ") + ",");

// ---- boundary ---------------------------------------------------------------------------------
const boundaryByPool = new Map();
for (const b of model.boundaryGuard ?? []) {
  const w = model.results[b.pool][b.setting].rangeWidthBps;
  const row = `["${b.pool}", ${w}, ${fmt2(r2(b.grossEmissionsAtBoundaryPct))}, ${fmt2(r2(b.closedFormLpNetPct))}, ${fmt2(r2(b.mcLpNetPct))}]`;
  boundaryByPool.set(b.pool, [...(boundaryByPool.get(b.pool) ?? []), row]);
}
const boundaryLines = [...boundaryByPool.values()].map((rows) => "    " + rows.join(", ") + ",");

const calibrated = Object.keys(inputs.volatility.sigma).length;
const blockText = `${START} /tmp/build/MODEL-NUMBERS.md (regenerated
   ${gen} by services/yield/scripts/lp-sim.py; what
   /v1/gate serves). Gauge words sampled ${sampledAt} block ${block},
   AERO $${aeroUsd}; σ trailing-realised as of ${inputs.volatility.asOf} (only ${calibrated} pools have a
   calibrated σ — the rest are shown UNPRICED, no_volatility_input; since 2026-09-12
   the gate is information and forecast() below prices every cell it can).
   \`emissions[widthBps]\` = gross emissions APR at that TOTAL tick span; other
   widths derive by the concentration relation E(w) = E(w₀)·f(w₀)/f(w).
   \`epochActive\` is the gauge's own recorded epoch state at the as-of instant
   (rewardRate > 0 AND periodFinish > as-of) — the gate derives no_emissions
   from THAT, never from a rounded APR of 0.00.
   \`mc\` carries the Monte-Carlo calibration the model prices alongside the
   closed form; \`served\` and \`userNetPinned\` are pins the page RECOMPUTES
   and the suites assert — no number on this page is read from them.
   GENERATED by prototype/scripts/gen-oil-model.mjs from ${model.inputs.gaugeSample.file.replace(/gauge-emissions.*/, "lp-model-*.json")} — do not edit by hand. ── */
const OIL_MODEL = Object.freeze({
  source: "MODEL-NUMBERS.md generated ${gen} (services/yield/scripts/lp-sim.py; closed form + Monte-Carlo calibration, ${paths} paths, as of ${asOfZ})",
  sampledAt: "${sampledAt}", sampleBlock: ${block}, aeroUsd: ${aeroUsd}, borrowPctAtGeneration: ${borrow},
  /* The Aave supply rates the user-net rows were generated with (the chain-read block above carries
     the dated ledger read; the suites add the difference back when they reproduce a row). */
  supplyPctAtGeneration: { ${Object.entries(inputs.collateral).map(([c, v]) => `${c}: ${v.supplyAprPct}`).join(", ")} },
${keep}
  /* The model's own bounds (services/yield/src/gate.ts). Bounds, never clamps. */
${bounds}
  pools: [
${poolLines.join("\n")}
  ],
  /* The Monte-Carlo calibration of each priced cell (services/yield/samples/mc-calibration.json).
     mcLpNet = netEmissions × inRangeEmissionsFactor + mcDragPct — affine in the
     emissions rate, because neither the in-range indicator nor the mint value
     depends on it, so two coefficients price the cell at EVERY emissions level
     including the boundary the gate decides at.
     [poolId, widthBps, sigma, feeBps, inRangeEmissionsFactor, mcDragPct, timeInRange, rebalancesPerYear] */
  mc: {
    generatedAt: "${gen}", asOf: "${asOf}", paths: ${paths}, seed: ${seed}, sigmaTolerance: 1e-9,
    cells: [
${mcCells.join("\n")}
    ],
  },
  /* [poolId, widthBps, lpNetPct|null, reason] — the served gate row at each
     preset width. lpNet is null wherever the gate stops BEFORE it prices the
     cell, exactly as /v1/gate leaves it; forecast() prices those cells anyway.
     "ok" would mean it beats the borrow on both forms. */
  served: [
${servedLines.join("\n")}
  ],
  /* [poolId, widthBps, collateral, ltvPct, userNetPct] — a sample of the served
     user-net rows; a slot whose cell the gate stops at before pricing has no row. */
  userNetPinned: [
${pinnedLines.join("\n")}
  ],
  /* The boundary the guard exists for: at each cell's own published break-even
     multiple the closed form lands exactly on the borrow rate. This is what the
     Monte-Carlo-calibrated form says the same position is worth there.
     [poolId, widthBps, grossAtBoundaryPct, closedLpNetPct, mcLpNetPct] */
  boundary: [
${boundaryLines.join("\n")}
  ],
});
`;

for (const p of pages) {
  const [before, , after] = split(readFileSync(p, "utf8"));
  writeFileSync(p, before + blockText + after);
}
console.log(
  `OIL_MODEL re-pinned in both prototypes from ${model.inputs.gaugeSample.file} → generated ${gen}, as of ${asOfZ}, ` +
    `block ${block}, borrow ${borrow}%: ${poolLines.length} pools, ${mcCells.length} mc cells, ${servedLines.length * 3} served, ${pinned.length} userNet pins, ${boundaryLines.length} boundary pools`
);
