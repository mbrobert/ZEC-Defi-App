import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchExitQuote, zecExitClosedReason, zecExitOffered } from "../lib/exit";

const ROOT = join(__dirname, "..");

test("Door 1 is off in this build, and being off means no request leaves the browser", () => {
  // NEXT_PUBLIC_ZEC_EXIT_ENABLED is unset in the test environment, which is how it ships
  // (docs/ZEC-FORMS-AND-DOORS-2026-09-15.md §6: nothing user-visible before the flag flips).
  assert.equal(zecExitOffered(), false);
  assert.ok(zecExitClosedReason().length > 20);
});

test("a quote request while the flag is off is refused locally — fetch is never called", async () => {
  // A dark feature that still pings an endpoint is not dark. If this ever calls through, the
  // assertion below fires rather than the request silently going out.
  let called = 0;
  const spy = (async () => {
    called += 1;
    throw new Error("fetch must not be called while Door 1 is off");
  }) as unknown as typeof fetch;

  const r = await fetchExitQuote({ usdcInAtomic: "1000000", destination: "u1whatever" }, spy);
  assert.equal(called, 0);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refusal.error, "zec_exit_unavailable");
  assert.equal(r.refusal.blockedBy, "flag-off");
  assert.ok(r.refusal.reason.trim().length > 20);
});

test("the dark step renders nothing at all — not a disabled control", () => {
  // §6: "Nothing user-visible before the flag flips." A greyed-out button is user-visible, so the
  // component returns null before it renders anything. Pinned by reading the source, because the
  // failure mode is a later edit moving the guard below the markup.
  const src = readFileSync(join(ROOT, "components", "ZecExitStep.tsx"), "utf8");
  const guard = src.indexOf("if (!zecExitOffered()) return null;");
  assert.ok(guard > 0, "the guard is gone");
  assert.ok(guard < src.indexOf("<section"), "the guard must come before any markup");
});

test("the web half holds no endpoint of its own: the route is the service's, and the address rules are Step Z1's", () => {
  const src = readFileSync(join(ROOT, "lib", "exit.ts"), "utf8");
  // §3.1 — the service proxies a LIVE quote and caches no rate into code. The browser may know the
  // service's path and nothing further; a bridge URL appearing here would mean the browser had
  // started talking to the route directly.
  assert.doesNotMatch(src, /https?:\/\/(?!\s)/, "a hard-coded URL appeared in the web's exit library");
  assert.match(src, /\/v1\/exit-quote/);
  assert.doesNotMatch(src, /(fee|rate|slippage|bps)[A-Za-z]*\s*[:=]\s*\d/i, "a number was typed for something nobody read");
});
