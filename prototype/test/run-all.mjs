/* run-all — runs every prototype suite in sequence and exits non-zero if any fails.
   node prototype/test/run-all.mjs
   (Set CHROMIUM_PATH only to override Playwright's own Chromium; a path that does not exist is
   ignored by _harness.mjs rather than forwarded. This file used to FORCE the container's
   /opt/pw-browsers/chromium when the variable was unset, which failed every suite on macOS.) */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
for (const f of ["verify-simple.mjs", "verify-advanced.mjs", "verify-toggle.mjs", "fuzz.mjs"]) {
  const r = spawnSync(process.execPath, [path.join(dir, f), ...process.argv.slice(2)], { stdio: "inherit", env: { ...process.env } });
  if (r.status !== 0) failed++;
}
console.log(failed ? `run-all: ${failed} suite(s) failed` : "run-all: every suite green");
process.exit(failed ? 1 : 0);
