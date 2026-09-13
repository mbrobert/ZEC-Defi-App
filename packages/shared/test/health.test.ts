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

test("ladder constants are the pinned values: the 1.25 floor's ladder 1.23 / 1.16 / 1.09 / 1.05, disarming at rung + 0.02 (the hysteresis minimum)", () => {
  assert.equal(ENTRY_HF_FLOOR, 1.25);
  assert.equal(HF_HYSTERESIS, 0.05, "the hysteresis SCALE (0.05 at a 1.55 entry); the floor's own hysteresis is hysteresisFor(1.25)");
  assert.equal(hysteresisFor(ENTRY_HF_FLOOR), 0.02);
  assert.deepEqual(
    HF_LADDER.map((r) => [r.id, r.hf, r.disarmHf, r.severity, r.action]),
    [
      ["warn", 1.23, 1.25, 1, "notify"],
      ["repay", 1.16, 1.18, 2, "repay"],
      ["derisk", 1.09, 1.11, 3, "derisk"],
      ["emergency", 1.05, 1.07, 4, "emergency-unwind"],
    ],
  );
  for (const r of HF_LADDER) {
    assert.equal(r.disarmHf, Number((r.hf + hysteresisFor(ENTRY_HF_FLOOR)).toFixed(2)), `${r.id} disarm`);
  }
  for (let i = 1; i < HF_LADDER.length; i++) {
    assert.ok(HF_LADDER[i].hf < HF_LADDER[i - 1].hf);
    assert.ok(HF_LADDER[i].severity > HF_LADDER[i - 1].severity);
  }
  assert.ok(HF_LADDER[0].hf < ENTRY_HF_FLOOR, "warn sits under the floor — a position never opens inside its own alarm");
  assert.ok(Object.isFrozen(HF_LADDER));
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
  assert.equal(rungFor(1.23), null, "boundary: hf == warn is not below warn");
  assert.equal(rungFor(1.2299)?.id, "warn");
  assert.equal(rungFor(1.16)?.id, "warn");
  assert.equal(rungFor(1.1599)?.id, "repay");
  assert.equal(rungFor(1.09)?.id, "repay");
  assert.equal(rungFor(1.0899)?.id, "derisk");
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
  assert.equal(isRungCleared("warn", 1.23), false);
  assert.equal(isRungCleared("warn", 1.2499), false);
  assert.equal(isRungCleared("warn", 1.25), true);
  assert.equal(isRungCleared(rungById("emergency"), 1.07), true);
  assert.equal(isRungCleared("emergency", 1.069), false);
  assert.equal(isRungCleared("repay", NaN), false, "fail closed");
});

test("liquidationDropPct and rungDropPct", () => {
  close(liquidationDropPct(7800, 5000), (1 - 5000 / 7800) * 100); // ≈ 35.9 %
  close(liquidationDropPct(8300, 5000), (1 - 5000 / 8300) * 100); // ≈ 39.8 %
  close(liquidationDropPct(7800, 3000), (1 - 3000 / 7800) * 100);
  assert.equal(liquidationDropPct(7800, 0), 100);
  assert.equal(liquidationDropPct(0, 5000), 0);
  assert.equal(liquidationDropPct(5000, 6000), 0, "already liquidatable → clamp at 0");
  // warn fires at price × warn.hf × LTV / LT
  close(rungDropPct("warn", 7800, 5000), (1 - (rungById("warn").hf * 5000) / 7800) * 100);
  close(rungDropPct("emergency", 7800, 5000), (1 - (rungById("emergency").hf * 5000) / 7800) * 100);
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
import {
  ladderFor,
  hysteresisFor,
  hfFromWad,
  entryHfAtLtvBps,
  rungDropPctAtHf,
  ladderForRecorded,
  offeredLtvBounds,
  ltvForEntryHfBps,
  drawdownToLiquidationPct,
  HF_MARKS,
  MIN_LADDER_ENTRY_HF,
  LADDER_RUNG_FACTORS,
  EMERGENCY_HF_MIN,
  HF_HYSTERESIS_MIN,
  ladderBpsFor,
  hysteresisBpsFor,
  reserveFractionFor,
  reserveUnitsFor,
  LADDER_RUNG_FACTORS_PCT,
  EMERGENCY_HF_MIN_BPS,
  HF_HYSTERESIS_MIN_BPS,
  HF_HYSTERESIS_SCALE_BPS,
  HF_HYSTERESIS_SPAN_BPS,
} from "../dist/index.js";

test("HF_LADDER is ladderFor(ENTRY_HF_FLOOR) rung for rung — ladderFor(1.25) — and ladderFor(1.55) is the table the product ran before the pin", () => {
  assert.deepEqual(ladderFor(1.25), HF_LADDER);
  assert.deepEqual(
    ladderFor(1.25).map((r) => [r.id, r.hf, r.disarmHf]),
    [["warn", 1.23, 1.25], ["repay", 1.16, 1.18], ["derisk", 1.09, 1.11], ["emergency", 1.05, 1.07]],
  );
  assert.equal(hysteresisFor(1.25), 0.02, "max(0.02, 0.05 × 0.25 ÷ 0.55 = 0.0227) → 0.02");
  assert.deepEqual(
    ladderFor(1.55).map((r) => [r.id, r.hf, r.disarmHf]),
    [["warn", 1.5, 1.55], ["repay", 1.35, 1.4], ["derisk", 1.2, 1.25], ["emergency", 1.05, 1.1]],
  );
  assert.equal(hysteresisFor(1.55), HF_HYSTERESIS);
  assert.ok(Object.isFrozen(ladderFor(1.25)) && Object.isFrozen(ladderFor(1.25)[0]));
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
  assert.equal(rungFor(1.28), null, "the default is the 1.25 floor's ladder, where 1.28 sits above the 1.23 warn rung");
  assert.equal(rungFor(1.28, ladderFor(1.55))?.id, "repay", "on the old 1.55 table 1.28 was already under the repay rung");
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

test("the floor is a parameter everywhere the offered LTV is derived — the shared default is the pinned 1.25 (cbBTC 62.40 %, WETH 66.40 %), and there is no product cap any more", async () => {
  const { maxOfferedLtvBps, maxOfferedLtvStopBps, ltvPresets, isOfferableLtv } = await import("../dist/index.js");
  assert.equal(maxOfferedLtvBps(7800), 6240);
  assert.equal(maxOfferedLtvBps(7800, 1.25), 6240);
  assert.equal(maxOfferedLtvBps(8300), 6640);
  assert.equal(maxOfferedLtvBps(7800, 1.55), 5032, "at the old floor the derived top was 50.32 % — the 50 % cap that used to clip it is gone");
  assert.equal(maxOfferedLtvBps(6000, 1.55), 3870);
  assert.equal(maxOfferedLtvBps(6000, 1.25), 4800);
  assert.equal(maxOfferedLtvStopBps(6000, 1.25), 4800);
  assert.equal(maxOfferedLtvStopBps(7800, 1.55), 5000);
  assert.equal(ltvPresets(7800, 1.55)[2].ltvBps, 5032);
  assert.equal(ltvPresets(7800)[2].ltvBps, 6240);
  assert.equal(isOfferableLtv(7800, 6240), true);
  assert.equal(isOfferableLtv(7800, 6241), false);
  assert.equal(isOfferableLtv(7800, 5100, 1.55), false);
  assert.throws(() => maxOfferedLtvBps(7800, 1), RangeError);
});

test("hfFromWad: a router record at 18 decimals becomes the four-decimal number the ladder derives from; 0 stays 0", () => {
  assert.equal(hfFromWad(1_550_080_000_000_000_000n), 1.5500, "1.55008 (the 1.55 choice after the LTV was floored to whole bps) truncates to 1.55");
  assert.equal(hfFromWad(1_300_000_000_000_000_000n), 1.3);
  assert.equal(hfFromWad(1_249_999_999_999_999_999n), 1.2499, "truncated, not rounded");
  assert.equal(hfFromWad(0n), 0);
  assert.deepEqual(ladderFor(hfFromWad(1_300_000_000_000_000_000n)).map((r) => r.hf), [1.27, 1.19, 1.11, 1.05]);
  assert.throws(() => hfFromWad(-1n), RangeError);
});

test("entryHfAtLtvBps truncates LT ÷ LTV to four decimals — the number the router records and hfFromWad reads back; rungDropPctAtHf is 1 − rung ÷ entry", () => {
  assert.equal(entryHfAtLtvBps(7800, 5032), 1.55, "the 1.55 choice after the LTV was floored: 1.55007… → 1.55");
  assert.equal(entryHfAtLtvBps(7800, 5000), 1.56);
  assert.equal(entryHfAtLtvBps(8300, 5000), 1.66);
  assert.equal(entryHfAtLtvBps(6000, 3870), 1.5503);
  assert.equal(entryHfAtLtvBps(7800, 0), Number.POSITIVE_INFINITY);
  const warn = ladderFor(1.95)[0]!;
  assert.ok(Math.abs(rungDropPctAtHf(warn, 1.95) - 100 * (1 - 1.86 / 1.95)) < 1e-9);
  assert.equal(rungDropPctAtHf(warn, Number.POSITIVE_INFINITY), 100);
  assert.equal(rungDropPctAtHf(warn, 1.5), 0, "a rung above the entry has already fired: no fall needed, never negative");
  assert.throws(() => rungDropPctAtHf(warn, 0.9), RangeError);
});

test("ladderForRecorded is the keeper's fallback rule: a usable record derives its ladder, anything else is the floor's, and it never throws", () => {
  assert.deepEqual(ladderForRecorded(1.3), { ladder: ladderFor(1.3), derived: true });
  assert.deepEqual(ladderForRecorded(1.55).ladder.map((r) => r.hf), [1.5, 1.35, 1.2, 1.05], "a 1.55 record derives the old table");
  assert.deepEqual(ladderForRecorded(1.25), { ladder: HF_LADDER, derived: true });
  for (const bad of [null, undefined, 0, 1.05, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = ladderForRecorded(bad as number | null | undefined);
    assert.equal(r.derived, false, String(bad));
    assert.deepEqual(r.ladder.map((x) => x.hf), [1.23, 1.16, 1.09, 1.05]);
  }
});

test("offeredLtvBounds names what stops the slider — the 1.25 floor on cbBTC (62.40 %) and WETH (66.40 %), Aave's own LTV when it is the smaller, nothing else; a tie names the floor", () => {
  assert.deepEqual(offeredLtvBounds(7800, 7300), { maxLtvBps: 6240, minHf: 1.25, binding: "entry_hf_floor" });
  assert.deepEqual(offeredLtvBounds(8300, 8000), { maxLtvBps: 6640, minHf: 1.25, binding: "entry_hf_floor" });
  assert.deepEqual(offeredLtvBounds(7800, 7300, 1.55), { maxLtvBps: 5032, minHf: 1.55, binding: "entry_hf_floor" }, "at the old floor: 50.32 %, no cap clipping it to 50");
  assert.deepEqual(offeredLtvBounds(6000, 7300), { maxLtvBps: 4800, minHf: 1.25, binding: "entry_hf_floor" });
  assert.deepEqual(offeredLtvBounds(6000, 7300, 1.55), { maxLtvBps: 3870, minHf: 1.5503, binding: "entry_hf_floor" });
  assert.deepEqual(offeredLtvBounds(7800, 4500), { maxLtvBps: 4500, minHf: 1.7333, binding: "venue_max_ltv" });
  assert.deepEqual(offeredLtvBounds(7800, 6000), { maxLtvBps: 6000, minHf: 1.3, binding: "venue_max_ltv" }, "Aave's 60 % under the floor's 62.4 %: the venue binds and the slider stops at 1.30");
  assert.deepEqual(offeredLtvBounds(7800, 0), { maxLtvBps: 0, minHf: Number.POSITIVE_INFINITY, binding: "venue_max_ltv" }, "an LTV→0 deprecation offers nothing");
  // A tie (6250 / 1.25 = 5000 exactly, venue 5000): the floor is named — what the user cannot change comes first.
  assert.equal(offeredLtvBounds(6250, 5000).binding, "entry_hf_floor");
  assert.throws(() => offeredLtvBounds(0.78, 7300), RangeError);
});

test("ladderBpsFor is ladderFor in integers — every entry from 1.10 to 5.00, rung for rung, disarm for disarm (the Solana program's rule)", () => {
  for (let e = MIN_LADDER_ENTRY_HF; e <= 5; e = Math.round((e + 0.01) * 100) / 100) {
    const eBps = Math.round(e * 10_000);
    const L = ladderFor(e);
    const B = ladderBpsFor(eBps);
    assert.equal(hysteresisBpsFor(eBps), Math.round(hysteresisFor(e) * 10_000), `hysteresis at ${e}`);
    for (let i = 0; i < 4; i++) {
      assert.equal(B[i].id, L[i].id);
      assert.equal(B[i].hfBps, Math.round(L[i].hf * 10_000), `${e} ${L[i].id} rung`);
      assert.equal(B[i].disarmHfBps, Math.round(L[i].disarmHf * 10_000), `${e} ${L[i].id} disarm`);
      assert.equal(B[i].severity, L[i].severity);
    }
  }
  assert.deepEqual(ladderBpsFor(16_250).map((r) => [r.hfBps, r.disarmHfBps]), [[15_700, 16_300], [14_000, 14_600], [12_300, 12_900], [10_600, 11_200]]);
  assert.deepEqual(ladderBpsFor(12_500).map((r) => r.hfBps), HF_LADDER.map((r) => Math.round(r.hf * 10_000)));
  assert.throws(() => ladderBpsFor(10_900), RangeError);
  assert.throws(() => ladderBpsFor(12_500.5), RangeError);
  assert.deepEqual(LADDER_RUNG_FACTORS_PCT, [91, 64, 36, 9]);
  assert.equal(EMERGENCY_HF_MIN_BPS, 10_500);
  assert.equal(HF_HYSTERESIS_MIN_BPS, 200);
  assert.equal(HF_HYSTERESIS_SCALE_BPS, 500);
  assert.equal(HF_HYSTERESIS_SPAN_BPS, 5_500);
});

test("the cross-chain reserve is the rung-2 requirement: 4.11 % of the debt at the 1.625 entry, rounded up in base units, zero debt → zero", () => {
  assert.equal(Math.round(reserveFractionFor(1.625) * 10_000) / 10_000, 0.0411, "(1.46 − 1.40) ÷ 1.46");
  assert.equal(Math.round(reserveFractionFor(1.25) * 10_000) / 10_000, 0.0169, "(1.18 − 1.16) ÷ 1.18");
  assert.equal(Math.round(reserveFractionFor(2.6) * 10_000) / 10_000, 0.0691, "(2.17 − 2.02) ÷ 2.17");
  // 4,000 USDC of debt at entry 1.625: ceil(4_000e6 × 600 / 14_600) = ceil(164,383,561.64) = 164,383,562
  assert.equal(reserveUnitsFor(4_000_000_000n, 16_250), 164_383_562n);
  assert.equal(reserveUnitsFor(0n, 16_250), 0n);
  assert.equal(reserveUnitsFor(1n, 16_250), 1n, "rounds up, never to zero for a positive debt");
  // the same number the float rule gives, within one unit
  const f = reserveFractionFor(1.625) * 4_000_000_000;
  assert.ok(Math.abs(Number(reserveUnitsFor(4_000_000_000n, 16_250)) - f) <= 1);
  assert.throws(() => reserveUnitsFor(-1n, 16_250), RangeError);
  assert.throws(() => reserveUnitsFor(5n, 10_000), RangeError);
});
