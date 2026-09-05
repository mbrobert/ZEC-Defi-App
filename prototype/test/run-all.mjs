/* run-all — runs every prototype suite in sequence and exits non-zero if any fails.
   CHROMIUM_PATH=/opt/pw-browsers/chromium node prototype/test/run-all.mjs */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of ["verify-simple.mjs", "verify-advanced.mjs", "verify-toggle.mjs", "fuzz.mjs"]) {
  const r = spawnSync(process.execPath, [path.join(dir, f), ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env, CHROMIUM_PATH: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium" } });
  if (r.status !== 0) failed++;
}
console.log(failed ? `run-all: ${failed} suite(s) failed` : "run-all: every suite green");
process.exit(failed ? 1 : 0);
