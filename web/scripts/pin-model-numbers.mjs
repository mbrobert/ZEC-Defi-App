#!/usr/bin/env node
/**
 * Refresh lib/demo-gate.json — the demo-mode /v1/gate payload.
 *
 *   node scripts/pin-model-numbers.mjs
 *
 * This script no longer BUILDS the payload. It copies the one the yield
 * service generates by running the real gate:
 *
 *   cd services/yield && npm run model && npm run demo-gate
 *
 * which writes services/yield/samples/demo-gate.json and mirrors it here.
 *
 * WHY (audit wave 1, lens D MED-1 and MED-7). This file used to reshape
 * services/yield/samples/lp-model-*.json cell by cell. That made demo mode a
 * SECOND implementation of the gate's decision, and the two diverged in both
 * directions: the simulator trusted the gauge sample's recorded `epochActive`
 * boolean where the gate re-derives it from `periodFinish` (78 cells across 15
 * of 27 rows disagreeing), and it published fields the gate returns before
 * ever computing (24 numbers on refused cells, including a user-net ladder and
 * an "LP net −18.18 %" line for a pool live mode will not price). Demo mode is
 * the first thing a user sees; it has to be a recording of the gate, not a
 * reconstruction of it. services/yield/test/demo-gate.test.ts re-runs
 * evaluateGate over the committed payload and asserts they match field for
 * field, so this can never silently drift again.
 */
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(process.argv[2] ?? join(here, "../../services/yield/samples/demo-gate.json"));
const dest = join(here, "../lib/demo-gate.json");

if (!existsSync(src)) {
  console.error(
    `${src} not found.\n` +
      "Generate it first:  cd services/yield && npm run model && npm run demo-gate"
  );
  process.exit(1);
}

const payload = JSON.parse(readFileSync(src, "utf8"));
if (!Array.isArray(payload.verdicts) || !payload.verdicts.length) {
  console.error(`${src} carries no verdicts — refusing to pin an empty demo payload`);
  process.exit(1);
}
if (!String(payload.generatedBy ?? "").includes("evaluateGate")) {
  console.error(
    `${src} was not produced by the real gate (generatedBy: ${payload.generatedBy ?? "—"}).\n` +
      "Demo mode must be a recording of evaluateGate, never a reformat of the simulator."
  );
  process.exit(1);
}

copyFileSync(src, dest);
console.log(
  `pinned ${dest}: ${payload.verdicts.length} verdicts, ${payload.qualifying.length} qualifying, ` +
    `borrow ${payload.borrowAprPct}%, as of ${payload.asOf}`
);
