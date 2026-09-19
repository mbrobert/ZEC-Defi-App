/* Shared harness for the prototype suites: Playwright loader, localhost http
   server for /prototype, a page factory that captures console errors, and a
   tiny named-check runner. Run any suite with:
     node prototype/test/verify-simple.mjs
   Playwright's own Chromium is used unless CHROMIUM_PATH names one that exists. */
import { createRequire } from "node:module";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
let pw;
try { pw = await import("playwright"); } catch { pw = require("/home/claude/.npm-global/lib/node_modules/playwright"); }

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(ROOT, "..");

export async function serve(root = ROOT) {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\//, "") || "simple.html";
    const f = path.join(root, rel);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": rel.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return { url: (file) => `http://127.0.0.1:${port}/${file}`, close: () => srv.close() };
}

/**
 * A CHROMIUM_PATH that does not exist is IGNORED rather than passed on to Playwright.
 * The suites were written in a container where Chromium lives at /opt/pw-browsers/chromium; on a
 * machine without that directory Playwright's own bundled browser is correct, and forwarding a
 * dead path turns every suite into "executable doesn't exist" — which is exactly how
 * `run-all.mjs` failed on macOS while each suite passed when run directly.
 */
function chromiumPath() {
  const p = process.env.CHROMIUM_PATH;
  if (!p) return undefined;
  if (fs.existsSync(p)) return p;
  console.error(`  (CHROMIUM_PATH=${p} does not exist — using Playwright's own Chromium)`);
  return undefined;
}

export async function browser() {
  return pw.chromium.launch({ executablePath: chromiumPath(), args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
}

/** New page in a fresh context (own localStorage) with console/page errors captured on page.__errors. */
export async function openPage(b, url, { width = 1100, height = 900, context } = {}) {
  const ctx = context || await b.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  page.__errors = [];
  page.on("console", m => { if (m.type() === "error") page.__errors.push(m.text()); });
  page.on("pageerror", e => page.__errors.push("PAGEERROR " + e.message));
  await page.goto(url);
  await page.waitForFunction(() => !!window.__oil);
  await page.waitForTimeout(150);
  page.__ctx = ctx;
  return page;
}

/**
 * `[scrollWidth, clientWidth]` of the document once the layout has settled: polled every 50 ms for up
 * to `ms`, returning the last reading either way. The 390 px probes used to sample ONCE after a fixed
 * 80–200 ms sleep, which on a busy machine can read a layout mid-way through a viewport change (the
 * two timing reds of backlog T-1). "No horizontal overflow" means the layout SETTLES with none; a page
 * that still overflows after `ms` fails by the same name, with the same numbers.
 */
export async function settledWidths(page, ms = 3000) {
  const read = () => page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  const deadline = Date.now() + ms;
  let w = await read();
  while (w[0] > w[1] && Date.now() < deadline) { await page.waitForTimeout(50); w = await read(); }
  return w;
}

/**
 * Backlog T-1. On 2026-09-16 one run of these suites under `npm run status` took 1,069 s against
 * ~30 s alone and ended WITHOUT a summary line, so nothing said which suite stalled or after which
 * check. Playwright bounds every navigation and locator action at 30 s, but `page.evaluate` and
 * `browser.close()` carry no timeout, and a suite stuck in either prints nothing at all. The runner
 * therefore remembers the last check that completed; if no check completes for `stallS` seconds
 * (OIL_STALL_S, default 90 — the slowest suite takes about 10 s alone) it prints that name and exits
 * 124, and Playwright's own exit handler kills the browser it launched. `done()` also lists every gap
 * of ten seconds or more between checks, so a slow-but-green run says where the time went.
 */
const DEFAULT_STALL_S = Number(process.env.OIL_STALL_S || 90);
const SLOW_GAP_MS = 10_000;

export function runner(suiteName, { stallS = DEFAULT_STALL_S } = {}) {
  const results = [];
  let pass = 0, fail = 0;
  const t0 = Date.now();
  let last = { name: "(suite start)", at: t0 };
  const slow = [];
  const watchdog = setInterval(() => {
    const idle = Date.now() - last.at;
    if (idle < stallS * 1000) return;
    console.log(`${suiteName}: STALLED — no check completed in ${Math.round(idle / 1000)} s; last completed: "${last.name}" (${results.length} checks so far, ${pass} passed, ${fail} failed)`);
    process.exit(124);
  }, 1000);
  watchdog.unref();
  const check = (name, cond, detail = "") => {
    const now = Date.now();
    if (now - last.at >= SLOW_GAP_MS) slow.push({ name, gap: now - last.at });
    last = { name, at: now };
    const ok = !!cond;
    results.push({ name, ok, detail });
    if (ok) pass++; else { fail++; console.log(`  ✗ ${name}${detail ? " — " + String(detail).slice(0, 300) : ""}`); }
    return ok;
  };
  const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
  const done = () => {
    clearInterval(watchdog);
    for (const g of slow) console.log(`  (slow) ${(g.gap / 1000).toFixed(1)} s passed before "${g.name}"`);
    console.log(`${suiteName}: ${pass} passed, ${fail} failed (${results.length} checks, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    return { suite: suiteName, pass, fail, total: results.length, results };
  };
  return { check, near, done, results };
}

/** Removed-vocabulary guard shared by the suites: none of these may appear in a shipped prototype. */
export const FORBIDDEN = [
  /\bNEAR\b/, /\bRhea\b/i, /1-Click/i, /oneClick|one_click/i, /Intents/i, /shielded/i, /payout address/i, /payoutHash/i,
  /\bt1[A-Za-z0-9]{33}\b/, /\bzs1[a-z0-9]{20,}/, /\bu1[a-z0-9]{40,}/, /ZIP-321/i, /Zodl|Zashi|Ywallet|Zingo/i, /nearblocks/i, /zcashexplorer/i,
  /non-custodial/i, /Burrow/i, /\bMCA\b/, /describeZaddr|checkAddr\(|ZADDR_RE/, /locked payout/i,
];
export function forbiddenHits(text) {
  const hits = [];
  for (const re of FORBIDDEN) { const m = text.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")); if (m) hits.push(`${re} ×${m.length}`); }
  return hits;
}
