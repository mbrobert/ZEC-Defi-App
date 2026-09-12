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

// ---------------------------------------------------------------------------
// The derived ladder (BUILD-PLAN-2026-09-12 §2b, step A4)
// ---------------------------------------------------------------------------
import { ladderFor, hysteresisFor, hfFromWad, ltvForEntryHfBps, drawdownToLiquidationPct, HF_MARKS, MIN_LADDER_ENTRY_HF, LADDER_RUNG_FACTORS, EMERGENCY_HF_MIN, HF_HYSTERESIS_MIN } from "../dist/index.js";

test("ladderFor(1.55) IS today's ladder, rung for rung — HF_LADDER is the floor's derived case", () => {
  assert.deepEqual(ladderFor(1.55), HF_LADDER);
  assert.deepEqual(
    ladderFor(1.55).map((r) => [r.id, r.hf, r.disarmHf]),
    [["warn", 1.5, 1.55], ["repay", 1.35, 1.4], ["derisk", 1.2, 1.25], ["emergency", 1.05, 1.1]],
  );
  assert.equal(hysteresisFor(1.55), HF_HYSTERESIS);
  assert.deepEqual(LADDER_RUNG_FACTORS, { warn: 0.91, repay: 0.64, derisk: 0.36, emergency: 0.09 });
  assert.ok(Object.isFrozen(ladderFor(1.55)) && Object.isFrozen(ladderFor(1.55)[0]));
});

test("the worked rows of BUILD-PLAN §2b: e = 1.30 → 1.27 / 1.19 / 1.11 / 1.05, e = 1.25 → 1.23 / 1.16 / 1.09 / 1.05; hysteresis 0.03 and 0.02", () => {
  assert.deepEqual(ladderFor(1.3).map((r) => r.hf), [1.27, 1.19, 1.11, 1.05]);
  assert.deepEqual(ladderFor(1.25).map((r) => r.hf), [1.23, 1.16, 1.09, 1.05]);
  assert.equal(hysteresisFor(1.3), 0.03);
  assert.equal(hysteresisFor(1.25), 0.02);
  assert.deepEqual(ladderFor(1.3).map((r) => r.disarmHf), [1.3, 1.22, 1.14, 1.08]);
  assert.deepEqual(ladderFor(1.25).map((r) => r.disarmHf), [1.25, 1.18, 1.11, 1.07]);
  // Kamino's top on ZEC (LT 65 % at its 40 % cap): every rung sits above today's fixed ladder.
  assert.deepEqual(ladderFor(1.625).map((r) => r.hf), [1.57, 1.4, 1.23, 1.06]);
  // A generous position: the emergency rung follows the buffer, never the 1.05 floor alone.
  assert.deepEqual(ladderFor(2.6).map((r) => r.hf), [2.46, 2.02, 1.58, 1.14]);
  assert.equal(hysteresisFor(2.6), 0.15);
});

test("ladderFor: rungs strictly decrease, disarm sits above every trigger, the emergency rung never falls under 1.05, and the entry is never born fired", () => {
  for (let e = MIN_LADDER_ENTRY_HF; e <= 5; e = Math.round((e + 0.01) * 100) / 100) {
    const L = ladderFor(e);
    assert.equal(L.length, 4, String(e));
    for (let i = 0; i < 4; i++) {
      assert.ok(L[i].disarmHf > L[i].hf, `${e} ${L[i].id} disarm`);
      if (i > 0) assert.ok(L[i].hf < L[i - 1].hf, `${e} ${L[i].id} order`);
      assert.ok(L[i].severity === i + 1);
    }
    assert.ok(L[3].hf >= EMERGENCY_HF_MIN, `${e} emergency`);
    assert.ok(L[0].hf < e, `${e} warn under the entry`);
    assert.ok(hysteresisFor(e) >= HF_HYSTERESIS_MIN);
  }
  // the collapse band: below MIN_LADDER_ENTRY_HF the four rungs do not fit and the call refuses
  assert.throws(() => ladderFor(1.09), RangeError);
  assert.throws(() => ladderFor(1.0), RangeError);
  assert.throws(() => ladderFor(NaN), RangeError);
  assert.throws(() => ladderFor(Infinity), RangeError);
  // near the bottom the clamp lifts the rungs 0.01 apart
  assert.deepEqual(ladderFor(1.1).map((r) => r.hf), [1.09, 1.07, 1.06, 1.05]);
});

test("rungFor / isRungCleared / rungDropPct take a derived ladder; defaults stay the floor's", () => {
  const L = ladderFor(1.3);
  assert.equal(rungFor(1.28, L), null);
  assert.equal(rungFor(1.269, L)?.id, "warn");
  assert.equal(rungFor(1.18, L)?.id, "repay");
  assert.equal(rungFor(1.1, L)?.id, "derisk");
  assert.equal(rungFor(1.04, L)?.id, "emergency");
  assert.equal(rungFor(1.28)?.id, "repay", "the default is still the 1.55 ladder, where 1.28 is already under the repay rung");
  assert.equal(isRungCleared("warn", 1.29, L), false);
  assert.equal(isRungCleared("warn", 1.3, L), true);
  assert.equal(isRungCleared(L[1], 1.22), true, "a rung object carries its own disarm");
  // On cbBTC (LT 78 %) at the LTV that HF 1.30 implies (60 %), warn fires on a 2.3 % fall, emergency on 19.2 %.
  const ltv = ltvForEntryHfBps(7800, 1.3);
  assert.equal(ltv, 6000);
  close(rungDropPct("warn", 7800, ltv, L), (1 - (1.27 * 6000) / 7800) * 100);
  close(rungDropPct(L[3], 7800, ltv), (1 - (1.05 * 6000) / 7800) * 100);
  assert.throws(() => rungById("warn", []), Error);
});

test("the slider identities: LTV = LT ÷ HF floored to bps; drawdown = 1 − 1 ÷ HF; the two marks", () => {
  assert.equal(ltvForEntryHfBps(7800, 1.55), 5032);
  assert.equal(ltvForEntryHfBps(7800, 1.3), 6000);
  assert.equal(ltvForEntryHfBps(7800, 1.25), 6240);
  assert.equal(ltvForEntryHfBps(8300, 1.55), 5354);
  assert.equal(ltvForEntryHfBps(6500, 1.625), 4000);
  assert.equal(ltvForEntryHfBps(7800, 1000), 7);
  close(drawdownToLiquidationPct(1.55), 35.483870967741936);
  close(drawdownToLiquidationPct(1.3), 23.076923076923077);
  close(drawdownToLiquidationPct(1.25), 20);
  close(drawdownToLiquidationPct(2), 50);
  // LTV ↔ HF round-trips within a bp's worth
  for (const hf of [1.25, 1.3, 1.55, 1.95, 2.6]) close(entryHfForLtv(7800, ltvForEntryHfBps(7800, hf)), hf, 0.002);
  assert.throws(() => ltvForEntryHfBps(7800, 0.99), RangeError);
  assert.throws(() => drawdownToLiquidationPct(0.5), RangeError);
  assert.deepEqual(HF_MARKS.map((m) => [m.id, m.hf]), [["sheltered", 1.55], ["expert", 1.3]]);
  assert.ok(Object.isFrozen(HF_MARKS));
});

test("the floor is a parameter everywhere the offered LTV is derived — the shared default is today's 1.55, a 1.25 floor lifts the top on cbBTC to the 50 % cap and on a 6000-LT asset to 48 %", async () => {
  const { maxOfferedLtvBps, maxOfferedLtvStopBps, ltvPresets, isOfferableLtv, MAX_OFFERED_LTV_CAP_BPS } = await import("../dist/index.js");
  assert.equal(maxOfferedLtvBps(7800), 5000);
  assert.equal(maxOfferedLtvBps(7800, 1.55), 5000);
  assert.equal(maxOfferedLtvBps(6000, 1.55), 3870);
  assert.equal(maxOfferedLtvBps(6000, 1.25), 4800);
  assert.equal(maxOfferedLtvBps(7800, 1.25), MAX_OFFERED_LTV_CAP_BPS, "the 50 % cap still binds");
  assert.equal(maxOfferedLtvStopBps(6000, 1.25), 4800);
  assert.equal(ltvPresets(6000, 1.25)[2].ltvBps, 4800);
  assert.equal(isOfferableLtv(6000, 4500, 1.25), true);
  assert.equal(isOfferableLtv(6000, 4500), false);
  assert.throws(() => maxOfferedLtvBps(7800, 1), RangeError);
  assert.throws(() => maxOfferedLtvBps(7800, NaN), RangeError);
});

test("hfFromWad: a router record at 18 decimals becomes the four-decimal number the ladder derives from; 0 stays 0", () => {
  assert.equal(hfFromWad(1_550_080_000_000_000_000n), 1.5500, "1.55008 (the 1.55 choice after the LTV was floored to whole bps) truncates to 1.55");
  assert.equal(hfFromWad(1_300_000_000_000_000_000n), 1.3);
  assert.equal(hfFromWad(1_249_999_999_999_999_999n), 1.2499, "truncated, not rounded");
  assert.equal(hfFromWad(0n), 0);
  assert.deepEqual(ladderFor(hfFromWad(1_300_000_000_000_000_000n)).map((r) => r.hf), [1.27, 1.19, 1.11, 1.05]);
  assert.throws(() => hfFromWad(-1n), RangeError);
});
