import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENTRY_HF_FLOOR,
  HF_HYSTERESIS,
  HF_LADDER,
  rungById,
  entryHfForLtv,
  rungFor,
  isRungCleared,
  liquidationDropPct,
  rungDropPct,
  assertBps,
} from "../dist/index.js";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test("ladder constants are the spec values and disarm at rung + 0.05", () => {
  assert.equal(ENTRY_HF_FLOOR, 1.55);
  assert.equal(HF_HYSTERESIS, 0.05);
  assert.deepEqual(
    HF_LADDER.map((r) => [r.id, r.hf, r.disarmHf, r.severity, r.action]),
    [
      ["warn", 1.5, 1.55, 1, "notify"],
      ["repay", 1.35, 1.4, 2, "repay"],
      ["derisk", 1.2, 1.25, 3, "derisk"],
      ["emergency", 1.05, 1.1, 4, "emergency-unwind"],
    ],
  );
  for (const r of HF_LADDER) {
    assert.equal(r.disarmHf, Number((r.hf + HF_HYSTERESIS).toFixed(2)), `${r.id} disarm`);
  }
  // strictly descending thresholds, strictly ascending severity
  for (let i = 1; i < HF_LADDER.length; i++) {
    assert.ok(HF_LADDER[i].hf < HF_LADDER[i - 1].hf);
    assert.ok(HF_LADDER[i].severity > HF_LADDER[i - 1].severity);
  }
  // a fresh position at the entry floor is never already armed
  assert.ok(ENTRY_HF_FLOOR >= rungById("warn").disarmHf);
  assert.ok(Object.isFrozen(HF_LADDER));
  assert.throws(() => rungById("nope" as any));
});

test("entryHfForLtv = LT / LTV (cbBTC, WETH, a low-LT asset)", () => {
  close(entryHfForLtv(7800, 5000), 1.56);
  close(entryHfForLtv(8300, 5000), 1.66);
  close(entryHfForLtv(7800, 3000), 2.6);
  close(entryHfForLtv(6000, 4000), 1.5);
  assert.equal(entryHfForLtv(7800, 0), Number.POSITIVE_INFINITY);
  assert.throws(() => entryHfForLtv(7800.5, 5000), RangeError);
  assert.throws(() => entryHfForLtv(7800, -1), RangeError);
  assert.throws(() => entryHfForLtv(NaN, 5000), RangeError);
  assert.throws(() => entryHfForLtv(10001, 5000), RangeError);
});

test("rungFor returns the most severe fired rung and is healthy at/above warn", () => {
  assert.equal(rungFor(2.0), null);
  assert.equal(rungFor(1.5), null, "boundary: hf == warn is not below warn");
  assert.equal(rungFor(1.4999)?.id, "warn");
  assert.equal(rungFor(1.35)?.id, "warn");
  assert.equal(rungFor(1.3499)?.id, "repay");
  assert.equal(rungFor(1.2)?.id, "repay");
  assert.equal(rungFor(1.1999)?.id, "derisk");
  assert.equal(rungFor(1.05)?.id, "derisk");
  assert.equal(rungFor(1.0499)?.id, "emergency");
  assert.equal(rungFor(0.5)?.id, "emergency");
  assert.equal(rungFor(0)?.id, "emergency");
  assert.equal(rungFor(Number.POSITIVE_INFINITY), null, "Aave no-debt sentinel is healthy");
});

test("rungFor fails closed on unreadable input", () => {
  assert.throws(() => rungFor(NaN), TypeError);
  assert.throws(() => rungFor(-0.1), TypeError);
  assert.throws(() => rungFor(undefined as any), TypeError);
  assert.throws(() => rungFor("1.4" as any), TypeError);
});

test("hysteresis: a fired rung clears only at disarmHf", () => {
  assert.equal(isRungCleared("warn", 1.5), false);
  assert.equal(isRungCleared("warn", 1.5499), false);
  assert.equal(isRungCleared("warn", 1.55), true);
  assert.equal(isRungCleared(rungById("emergency"), 1.1), true);
  assert.equal(isRungCleared("emergency", 1.09), false);
  assert.equal(isRungCleared("repay", NaN), false, "fail closed");
});

test("liquidationDropPct and rungDropPct", () => {
  close(liquidationDropPct(7800, 5000), (1 - 5000 / 7800) * 100); // ≈ 35.9 %
  close(liquidationDropPct(8300, 5000), (1 - 5000 / 8300) * 100); // ≈ 39.8 %
  close(liquidationDropPct(7800, 3000), (1 - 3000 / 7800) * 100);
  assert.equal(liquidationDropPct(7800, 0), 100);
  assert.equal(liquidationDropPct(0, 5000), 0);
  assert.equal(liquidationDropPct(5000, 6000), 0, "already liquidatable → clamp at 0");
  // warn fires at price × 1.5 × LTV / LT
  close(rungDropPct("warn", 7800, 5000), (1 - (1.5 * 5000) / 7800) * 100); // ≈ 3.8 %
  close(rungDropPct("emergency", 7800, 5000), (1 - (1.05 * 5000) / 7800) * 100);
  assert.ok(rungDropPct("emergency", 7800, 5000) < liquidationDropPct(7800, 5000));
  assert.ok(rungDropPct("warn", 7800, 5000) < rungDropPct("repay", 7800, 5000));
});

test("assertBps", () => {
  assert.doesNotThrow(() => assertBps(0, "x"));
  assert.doesNotThrow(() => assertBps(10000, "x"));
  for (const bad of [-1, 10001, 1.5, NaN, Infinity, "5000"]) {
    assert.throws(() => assertBps(bad as number, "x"), RangeError);
  }
});
