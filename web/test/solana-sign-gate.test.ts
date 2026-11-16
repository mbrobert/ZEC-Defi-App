import { test } from "node:test";
import assert from "node:assert/strict";
import { canSignWithMarketSource, canSignWithView } from "../lib/solana/sign-gate";
import { demoSolanaBorrow, normalizeSolanaBorrow, unavailableSolanaBorrow } from "../lib/solana/yield";

test("live session: the demo snapshot (the hook's fallback) can never lead to a signature, though it says stale:false and allowed:true", () => {
  const d = demoSolanaBorrow();
  assert.equal(d.stale, false);
  assert.equal(d.allowed, true);
  assert.equal(canSignWithView(d, "live"), false);
});

test("live session: unavailable and stale live views are blocked; a fresh live view passes", () => {
  assert.equal(canSignWithView(unavailableSolanaBorrow("kamino_unavailable"), "live"), false);
  assert.equal(canSignWithView(normalizeSolanaBorrow({ stale: true }, "live"), "live"), false);
  assert.equal(canSignWithView(normalizeSolanaBorrow({ stale: false }, "live"), "live"), true);
});

test("demo session: unchanged, never blocked here", () => {
  assert.equal(canSignWithView(demoSolanaBorrow(), "demo"), true);
});

test("Base market: a snapshot cannot size a live signature", () => {
  assert.equal(canSignWithMarketSource("snapshot", "live"), false);
  assert.equal(canSignWithMarketSource("live", "live"), true);
  assert.equal(canSignWithMarketSource("snapshot", "demo"), true);
});
