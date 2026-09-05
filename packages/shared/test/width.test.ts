import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RANGE_WIDTH_BOUNDS,
  REBALANCE_DELAY_BOUNDS,
  RANGE_PRESETS,
  rangePresetDef,
  presetWidthBps,
  presetToLpParams,
  presetForParams,
  halfWidthFromBps,
  bpsFromHalfWidth,
  formatHalfWidthPct,
  spanPriceRatio,
  LN_TICK_BASE,
  rebalanceDelayHoursToSeconds,
  lpParamsToChain,
  validateLpParams,
} from "../dist/index.js";

test("bounds are total tick span [150, 5000] and delay [0, 168 h]", () => {
  assert.deepEqual(RANGE_WIDTH_BOUNDS, { min: 150, max: 5000 });
  assert.deepEqual(REBALANCE_DELAY_BOUNDS, { minHours: 0, maxHours: 168 });
});

test("presets: 4500/1500/300 uncorrelated, 2356/784/150 correlated, delays 48/12/2", () => {
  assert.deepEqual(
    RANGE_PRESETS.map((p) => [p.preset, p.rangeWidthBps.UNCORRELATED, p.rangeWidthBps.CORRELATED, p.defaultRebalanceDelayHours]),
    [
      ["CONSERVATIVE", 4500, 2356, 48],
      ["MODERATE", 1500, 784, 12],
      ["AGGRESSIVE", 300, 150, 2],
    ],
  );
  assert.ok(Object.isFrozen(RANGE_PRESETS));
  assert.equal(presetWidthBps("MODERATE"), 1500);
  assert.equal(presetWidthBps("MODERATE", "CORRELATED"), 784);
  assert.equal(rangePresetDef("AGGRESSIVE").label, "Aggressive");
  assert.throws(() => rangePresetDef("CUSTOM" as any));
  // every preset width is inside the bounds and validates
  for (const p of RANGE_PRESETS) {
    for (const cls of ["UNCORRELATED", "CORRELATED"] as const) {
      const w = p.rangeWidthBps[cls];
      assert.ok(w >= RANGE_WIDTH_BOUNDS.min && w <= RANGE_WIDTH_BOUNDS.max, `${p.preset}/${cls}`);
      assert.deepEqual(validateLpParams(presetToLpParams(p.preset, cls)), []);
    }
  }
});

test("derived-number rule: no preset object carries a typed ±, %, HF or LTV", () => {
  const forbiddenKeys = /half|pct|percent|hf|ltv|plusminus|min|max|default(?!RebalanceDelayHours)/i;
  for (const p of RANGE_PRESETS) {
    for (const k of Object.keys(p)) assert.doesNotMatch(k, forbiddenKeys, `${p.preset}.${k}`);
    assert.equal(p.description.includes("±"), false, `${p.preset} description has ±`);
    assert.equal(p.description.includes("%"), false, `${p.preset} description has %`);
    assert.equal(/\d/.test(p.description), false, `${p.preset} description has a number`);
    assert.equal(/\d/.test(p.label), false);
    assert.equal(JSON.stringify(p).includes("±"), false);
  }
});

test("presetToLpParams / presetForParams round-trip", () => {
  assert.deepEqual(presetToLpParams("CONSERVATIVE"), { rangeWidthBps: 4500, rebalanceDelayHours: 48, autoCompoundEnabled: true });
  assert.deepEqual(presetToLpParams("AGGRESSIVE", "CORRELATED"), { rangeWidthBps: 150, rebalanceDelayHours: 2, autoCompoundEnabled: true });
  assert.equal(presetForParams(presetToLpParams("MODERATE")), "MODERATE");
  assert.equal(presetForParams(presetToLpParams("MODERATE", "CORRELATED"), "CORRELATED"), "MODERATE");
  assert.equal(presetForParams({ rangeWidthBps: 999, rebalanceDelayHours: 1, autoCompoundEnabled: false }), "CUSTOM");
});

test("halfWidthFromBps is GEOMETRIC (tick span), matching the live-engine vectors from AUDIT-FINDINGS Part 1 FACT 3", () => {
  assert.ok(Math.abs(LN_TICK_BASE - Math.log(1.0001)) < 1e-18);
  // live engine positions (ticks → observed ±%), 2 dp
  const vectors: Array<[number, number]> = [
    [1000, 5.13],
    [300, 1.51],
    [1398, 7.24],
    [1823, 9.54],
    [953, 4.88],
  ];
  for (const [ticks, pct] of vectors) {
    assert.equal(halfWidthFromBps(ticks).toFixed(2), pct.toFixed(2), `${ticks} ticks`);
  }
  // NOT linear: 4500/200 would be 22.5, the engine's actual half-width is 25.23
  assert.equal(halfWidthFromBps(4500).toFixed(2), "25.23");
  assert.notEqual(halfWidthFromBps(4500).toFixed(2), (4500 / 200).toFixed(2));
  // the closed form
  for (const t of [150, 300, 953, 1500, 4500, 5000]) {
    assert.ok(Math.abs(halfWidthFromBps(t) - (Math.exp((t * Math.log(1.0001)) / 2) - 1) * 100) < 1e-12);
  }
  assert.equal(halfWidthFromBps(0), 0);
  assert.ok(Math.abs(spanPriceRatio(4500) - Math.pow(1.0001, 4500)) < 1e-9);
  assert.ok(Math.abs(spanPriceRatio(4500) - 1.5683) < 5e-4);
});

test("preset half-widths: 4500→25.23, 1500→7.79, 300→1.51; correlated 2356→12.50, 784→4.00, 150→0.75", () => {
  const expected: Record<number, string> = { 4500: "25.23", 1500: "7.79", 300: "1.51", 2356: "12.50", 784: "4.00", 150: "0.75" };
  for (const [ticks, pct] of Object.entries(expected)) {
    assert.equal(halfWidthFromBps(Number(ticks)).toFixed(2), pct, `${ticks} ticks`);
  }
});

test("bpsFromHalfWidth is the exact inverse and round-trips every integer span in bounds", () => {
  for (let t = RANGE_WIDTH_BOUNDS.min; t <= RANGE_WIDTH_BOUNDS.max; t++) {
    assert.equal(bpsFromHalfWidth(halfWidthFromBps(t)), t, `round-trip ${t}`);
  }
  // from the closed form directly
  assert.equal(bpsFromHalfWidth(25.232), 4500);
  assert.equal(bpsFromHalfWidth(5.127), 1000);
  assert.equal(bpsFromHalfWidth(1.5113), 300);
  assert.equal(bpsFromHalfWidth(0), 0);
  // the linear inverse would be wrong by hundreds of ticks at the wide end
  assert.notEqual(bpsFromHalfWidth(25.23), Math.round(25.23 * 200));
});

test("formatHalfWidthPct: 2 dp under ±2 %, 1 dp otherwise — confirmed for every preset", () => {
  // every preset, both pair classes
  assert.equal(formatHalfWidthPct(presetWidthBps("CONSERVATIVE")), "±25.2%");
  assert.equal(formatHalfWidthPct(presetWidthBps("MODERATE")), "±7.8%");
  assert.equal(formatHalfWidthPct(presetWidthBps("AGGRESSIVE")), "±1.51%");
  assert.equal(formatHalfWidthPct(presetWidthBps("CONSERVATIVE", "CORRELATED")), "±12.5%");
  assert.equal(formatHalfWidthPct(presetWidthBps("MODERATE", "CORRELATED")), "±4.0%");
  assert.equal(formatHalfWidthPct(presetWidthBps("AGGRESSIVE", "CORRELATED")), "±0.75%");
  // live-engine vectors
  assert.equal(formatHalfWidthPct(1000), "±5.1%");
  assert.equal(formatHalfWidthPct(1398), "±7.2%");
  assert.equal(formatHalfWidthPct(1823), "±9.5%");
  assert.equal(formatHalfWidthPct(953), "±4.9%");
  // the 2-dp / 1-dp switch sits at exactly ±2 %: 1.0001^(t/2) = 1.02 → t = 2·ln(1.02)/ln(1.0001) ≈ 396.06
  assert.equal(formatHalfWidthPct(396), "±2.00%"); // 1.9997 → still 2 dp
  assert.equal(formatHalfWidthPct(397), "±2.0%"); // 2.0048 → 1 dp
  assert.equal(formatHalfWidthPct(RANGE_WIDTH_BOUNDS.min), "±0.75%");
  assert.equal(formatHalfWidthPct(RANGE_WIDTH_BOUNDS.max), "±28.4%");
});

test("rebalanceDelayHoursToSeconds", () => {
  assert.equal(rebalanceDelayHoursToSeconds(12), 43_200);
  assert.equal(rebalanceDelayHoursToSeconds(0), 0);
  assert.equal(rebalanceDelayHoursToSeconds(0.5), 1800);
  assert.equal(rebalanceDelayHoursToSeconds(168), 604_800);
});

test("lpParamsToChain produces the ILPAdapter tuple with bigint seconds", () => {
  const chain = lpParamsToChain({ rangeWidthBps: 300, rebalanceDelayHours: 12, autoCompoundEnabled: true });
  assert.deepEqual(chain, { rangeWidthBps: 300, rebalanceDelay: 43_200n, autoCompound: true });
  assert.equal(typeof chain.rebalanceDelay, "bigint");
  assert.throws(() => lpParamsToChain({ rangeWidthBps: 100, rebalanceDelayHours: 12, autoCompoundEnabled: true }), RangeError);
  assert.throws(() => lpParamsToChain({ rangeWidthBps: NaN, rebalanceDelayHours: 12, autoCompoundEnabled: true }), RangeError);
});

test("validateLpParams: bounds, NaN/Infinity, non-integers, non-booleans", () => {
  const ok = { rangeWidthBps: 1500, rebalanceDelayHours: 12, autoCompoundEnabled: true };
  assert.deepEqual(validateLpParams(ok), []);
  assert.deepEqual(validateLpParams({ ...ok, rangeWidthBps: 150 }), []);
  assert.deepEqual(validateLpParams({ ...ok, rangeWidthBps: 5000 }), []);
  assert.deepEqual(validateLpParams({ ...ok, rebalanceDelayHours: 0 }), []);
  assert.deepEqual(validateLpParams({ ...ok, rebalanceDelayHours: 168 }), []);

  assert.equal(validateLpParams({ ...ok, rangeWidthBps: 149 }).length, 1);
  assert.equal(validateLpParams({ ...ok, rangeWidthBps: 5001 }).length, 1);
  assert.equal(validateLpParams({ ...ok, rangeWidthBps: 0 }).length, 1);
  assert.equal(validateLpParams({ ...ok, rangeWidthBps: -300 }).length, 1);
  assert.match(validateLpParams({ ...ok, rangeWidthBps: 149 })[0], /150 and 5000/);

  for (const bad of [NaN, Infinity, -Infinity, 300.5, "300", null, undefined]) {
    const errs = validateLpParams({ ...ok, rangeWidthBps: bad as number });
    assert.equal(errs.length, 1, `width ${String(bad)}`);
    assert.match(errs[0], /finite integer/);
  }
  for (const bad of [NaN, Infinity, -1, 169, "12"]) {
    assert.equal(validateLpParams({ ...ok, rebalanceDelayHours: bad as number }).length, 1, `delay ${String(bad)}`);
  }
  assert.equal(validateLpParams({ ...ok, autoCompoundEnabled: "yes" as unknown as boolean }).length, 1);
  // multiple problems are all reported
  assert.equal(validateLpParams({ rangeWidthBps: NaN, rebalanceDelayHours: NaN, autoCompoundEnabled: 1 as any }).length, 3);
  assert.equal(validateLpParams(undefined as any).length, 3);
});
