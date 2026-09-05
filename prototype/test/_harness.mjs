/* Shared harness for the prototype suites: Playwright loader, localhost http
   server for /prototype, a page factory that captures console errors, and a
   tiny named-check runner. Run any suite with:
     CHROMIUM_PATH=/opt/pw-browsers/chromium node prototype/test/verify-simple.mjs */
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

export async function browser() {
  return pw.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"] });
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

export function runner(suiteName) {
  const results = [];
  let pass = 0, fail = 0;
  const check = (name, cond, detail = "") => {
    const ok = !!cond;
    results.push({ name, ok, detail });
    if (ok) pass++; else { fail++; console.log(`  ✗ ${name}${detail ? " — " + String(detail).slice(0, 300) : ""}`); }
    return ok;
  };
  const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
  const done = () => {
    console.log(`${suiteName}: ${pass} passed, ${fail} failed (${results.length} checks)`);
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
