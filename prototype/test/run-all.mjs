/* run-all — runs every prototype suite in sequence and exits non-zero if any fails.
   node prototype/test/run-all.mjs
   (Set CHROMIUM_PATH only to override Playwright's own Chromium; a path that does not exist is
   ignored by _harness.mjs rather than forwarded. This file used to FORCE the container's
   /opt/pw-browsers/chromium when the variable was unset, which failed every suite on macOS.)

   Each suite runs under its own ceiling — OIL_SUITE_TIMEOUT_S, default 300 s against ~10 s measured
   alone — and one that passes it is killed and reported BY NAME as timed out, with its wall time,
   so a hang costs minutes and says which suite (backlog T-1; the harness's own watchdog inside each
   suite fires first, at 90 s without a completed check, and names the last check that did). */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const dir = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = Number(process.env.OIL_SUITE_TIMEOUT_S || 300) * 1000;
const t0 = Date.now();
const failed = [];
for (const f of ["verify-simple.mjs", "verify-advanced.mjs", "verify-toggle.mjs", "fuzz.mjs"]) {
  const name = f.replace(/\.mjs$/, "");
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f), ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env }, timeout: TIMEOUT_MS, killSignal: "SIGKILL",
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  // spawnSync reports a timeout by setting `error.code` to ETIMEDOUT and leaving `status` null.
  if (r.error && r.error.code === "ETIMEDOUT") {
    console.log(`${name}: TIMED OUT after ${secs} s and was killed (ceiling ${TIMEOUT_MS / 1000} s)`);
    failed.push(`${name} (timed out)`);
  } else if (r.status !== 0) {
    failed.push(`${name} (exit ${r.status}${r.status === 124 ? ", stalled" : ""})`);
  }
}
const total = ((Date.now() - t0) / 1000).toFixed(1);
console.log(failed.length ? `run-all: ${failed.length} suite(s) failed — ${failed.join(", ")} (${total} s)` : `run-all: every suite green (${total} s)`);
process.exit(failed.length ? 1 : 0);
