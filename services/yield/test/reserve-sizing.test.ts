/**
 * The reserve-sizing model (`src/reserveSizing.ts`): the arithmetic on hand-built candles, the ladder walk on
 * paths whose outcome is known by construction, and — at the end — the headline numbers of the dated sample
 * `docs/MODEL-RESERVE-2026-09-19.md` quotes, so the document cannot drift from what the script prints.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ladderFor, reserveFractionFor } from "@zyo/shared";
import {
  demean, frequencyOfDrop, ladderGeometry, logReturns, parseKrakenOhlc, quantile, realizedVol, rng, simulateLadder, stdev, worstDropWithin,
  type Candle,
} from "../src/reserveSizing.js";

const candle = (c: number, l = c, h = c, t = 0): Candle => ({ t, o: c, h, l, c });

test("log returns, stdev, quantile and realized vol are the textbook definitions", () => {
  const cs = [100, 110, 99, 99].map((c) => candle(c));
  const r = logReturns(cs);
  assert.equal(r.length, 3);
  assert.ok(Math.abs(r[0]! - Math.log(1.1)) < 1e-12);
  assert.equal(r[2], 0);
  assert.ok(Math.abs(stdev([1, 2, 3, 4]) - Math.sqrt(5 / 3)) < 1e-12);
  assert.deepEqual(demean([1, 2, 3]), [-1, 0, 1]);
  assert.deepEqual(demean([]), []);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.99), 5);
  const v = realizedVol({ intervalMin: 60, candles: cs });
  assert.equal(v.n, 3);
  assert.ok(Math.abs(v.annualized - v.perBar * Math.sqrt(8760)) < 1e-9);
});

test("the worst drop within a window is close-to-low, per start bar, and the frequency counts the threshold inclusively", () => {
  // closes 100, 100, 100, 100; the second bar wicks to 80, the fourth to 95
  const cs = [candle(100), candle(100, 80), candle(100), candle(100, 95)];
  const w1 = worstDropWithin(cs, 1);
  assert.deepEqual(w1.drops.map((d) => +d.toFixed(4)), [0.2, 0, 0.05]);
  assert.ok(Math.abs(w1.worst - 0.2) < 1e-12);
  const w2 = worstDropWithin(cs, 2);
  assert.deepEqual(w2.drops.map((d) => +d.toFixed(4)), [0.2, 0.05]);
  assert.equal(frequencyOfDrop(w1.drops, 0.05), 2 / 3);
  assert.equal(frequencyOfDrop(w1.drops, 0.21), 0);
});

test("the ladder geometry at 1.625 is the derived ladder's, and the reserve is shared's rung-2 requirement", () => {
  const g = ladderGeometry(1.625);
  assert.deepEqual(g.rungs, ladderFor(1.625));
  assert.equal(g.reserveFraction, reserveFractionFor(1.625));
  assert.ok(Math.abs(g.reserveFraction - 0.0411) < 5e-4);
  // repay at 1.40 from 1.625 is a −13.85 % move; de-risk at 1.23 from the 1.46 disarm level is −15.75 %
  assert.ok(Math.abs(g.fromEntryPct.repay! - 13.846) < 0.01);
  assert.ok(Math.abs(g.fromDisarm2Pct.derisk! - 15.753) < 0.01);
  assert.ok(Math.abs(g.liquidationFromEntryPct - 38.46) < 0.01);
});

test("a flat path touches no rung; a straight fall reaches liquidation with no reserve able to stop it", () => {
  const flat = simulateLadder({ returns: [0, 0, 0], bars: 48, paths: 50, seed: 1, blockLen: 6, scale: 1, entryHf: 1.625, lt: 0.65, reserveMultiple: 1, landingBars: 1 });
  assert.equal(flat.reachedRepay, 0);
  assert.equal(flat.zecSold, 0);
  assert.equal(flat.avgRepays, 0);
  // −5 % every bar: 1.625 → HF < 1 after ceil(ln(1/1.625)/ln(0.95)) = 10 bars, whatever the reserve does in between
  const crash = simulateLadder({ returns: [Math.log(0.95)], bars: 48, paths: 20, seed: 2, blockLen: 6, scale: 1, entryHf: 1.625, lt: 0.65, reserveMultiple: 1, landingBars: Infinity });
  assert.equal(crash.reachedRepay, 1);
  assert.equal(crash.zecSold, 1);
});

test("one rung-2 episode: a reserve of exactly one requirement is short by the tick's overshoot, so a top-up is requested; two requirements are not short", () => {
  // −7.5 % twice takes HF from 1.625 to 1.39 — past the rung at 1.40 — then +8 % twice recovers. Blocks of 4, a path of 4 bars.
  const returns = [Math.log(0.925), Math.log(0.925), Math.log(1.08), Math.log(1.08)];
  const base = { returns, bars: 4, paths: 1, seed: 3, blockLen: 4, scale: 1, entryHf: 1.625, lt: 0.65, landingBars: Infinity, mode: "replay" as const };
  const k1 = simulateLadder({ ...base, reserveMultiple: 1 });
  assert.equal(k1.reachedRepay, 1);
  assert.equal(k1.reachedDerisk, 0);
  assert.equal(k1.zecSold, 0);
  assert.equal(k1.avgRepays, 1);
  assert.equal(k1.bridgeNeeded, 1, "R lifts 1.40 → 1.46 exactly; the tick found 1.39, so R is short and a top-up is requested");
  const k2 = simulateLadder({ ...base, reserveMultiple: 2 });
  assert.equal(k2.avgRepays, 1);
  assert.equal(k2.bridgeNeeded, 0);
});

test("a monotone fall to rung 3 sells only the ZEC that lifts HF to rung 3's disarm level, and a bigger reserve cannot help inside one episode", () => {
  // Nine bars of −4 %: 1.625 × 0.96^9 = 1.13 < 1.23. Rung 2 fires once at bar 4 and, HF never regaining 1.46, stays fired —
  // one repay per episode is the hysteresis the keeper runs — so five requirements idle buy exactly one bar over one
  // (the full first repay lands on 1.46; the partial one on 1.44), and both positions sell ZEC at rung 3.
  const returns = Array(9).fill(Math.log(0.96));
  const base = { returns, bars: 9, paths: 1, seed: 4, blockLen: 9, scale: 1, entryHf: 1.625, lt: 0.65, landingBars: Infinity, mode: "replay" as const };
  const k1 = simulateLadder({ ...base, reserveMultiple: 1 });
  const k5 = simulateLadder({ ...base, reserveMultiple: 5 });
  for (const o of [k1, k5]) {
    assert.equal(o.reachedDerisk, 1);
    assert.equal(o.avgRepays, 1);
    assert.ok(o.avgSoldShareWhenSold > 0 && o.avgSoldShareWhenSold < 1, "de-risk sells part of the collateral, not all");
  }
  assert.equal(k1.bridgeNeeded, 1);
  assert.equal(k5.bridgeNeeded, 0);
});

test("replay walks the series in order, one rolling window per path, and refuses a window that runs off the end", () => {
  const d = Math.log(0.925);
  const returns = [0, 0, d, d, 0, 0]; // the fall sits at indices 2–3
  const base = { returns, bars: 2, seed: 1, blockLen: 2, scale: 1, entryHf: 1.625, lt: 0.65, reserveMultiple: 1, landingBars: Infinity, mode: "replay" as const };
  assert.equal(simulateLadder({ ...base, paths: 1, startIndex: 2 }).reachedRepay, 1, "the window on the fall");
  assert.equal(simulateLadder({ ...base, paths: 1, startIndex: 0 }).reachedRepay, 0, "the window before it");
  assert.equal(simulateLadder({ ...base, paths: 5, startIndex: 0 }).reachedRepay, 1 / 5, "five rolling windows, one of which holds the whole fall");
  assert.throws(() => simulateLadder({ ...base, paths: 6, startIndex: 0 }), RangeError);
});

test("across two episodes with a bounce between them, one requirement is short the second time and three are not", () => {
  // fall to the rung (−7.5 % ×2 → 1.39), bounce above the disarm level (+6 % ×2 → 1.63), fall to the rung again (−6 % ×3 → 1.35).
  const d = Math.log(0.925), u = Math.log(1.06), d2 = Math.log(0.94);
  const returns = [d, d, u, u, d2, d2, d2];
  const base = { returns, bars: 7, paths: 1, seed: 5, blockLen: 7, scale: 1, entryHf: 1.625, lt: 0.65, landingBars: Infinity, mode: "replay" as const };
  const k1 = simulateLadder({ ...base, reserveMultiple: 1 });
  assert.equal(k1.avgRepays, 1, "the second episode finds nothing idle");
  assert.equal(k1.bridgeNeeded, 1);
  assert.equal(k1.zecSold, 0, "rung 3 is not reached; the position simply waits for the bridge");
  const k3 = simulateLadder({ ...base, reserveMultiple: 3 });
  assert.equal(k3.avgRepays, 2);
  assert.equal(k3.bridgeNeeded, 0);
});

test("the seeded generator is deterministic and uniform enough to resample with", () => {
  const a = rng(7), b = rng(7);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05);
});

test("Kraken rows parse as numbers, the open candle is dropped, and a bad row is refused", () => {
  const rows = [["1", "10", "11", "9", "10.5"], ["2", "10.5", "12", "10", "11"], ["3", "11", "11", "11", "11"]];
  const cs = parseKrakenOhlc(rows);
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[1], { t: 2, o: 10.5, h: 12, l: 10, c: 11 });
  assert.equal(parseKrakenOhlc(rows, { dropOpenCandle: false }).length, 3);
  assert.throws(() => parseKrakenOhlc([["1", "10", "11", "0", "10"]]), RangeError);
  assert.throws(() => parseKrakenOhlc([["1", "x", "11", "9", "10"]]), RangeError);
});

/* ── the pin: the dated sample reproduces the numbers the document quotes ── */
const SAMPLE = new URL("../../samples/zec-usd-kraken-2026-09-19.json", import.meta.url);
test("MODEL-RESERVE-2026-09-19.md's headline numbers come out of the committed sample", { skip: !existsSync(SAMPLE) && "sample not present" }, () => {
  const s = JSON.parse(readFileSync(SAMPLE, "utf8")) as { series: Record<string, { rows: string[][] }> };
  const hourly = parseKrakenOhlc(s.series["60"]!.rows);
  const daily = parseKrakenOhlc(s.series["1440"]!.rows);
  assert.equal(hourly.length, 720);
  assert.equal(daily.length, 720);
  const PIN = JSON.parse(readFileSync(new URL("../../samples/reserve-sizing-pin-2026-09-19.json", import.meta.url), "utf8")) as {
    hourlyVolPct: number; dailyVolAnnualizedPct: number; worst24hPct: number; worst1dPct: number; freq24hAtGap: number; k1Never30dZecSold: number; k3Never30dZecSold: number;
  };
  const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs pinned ${b}`);
  near(realizedVol({ intervalMin: 60, candles: hourly }).perBar * 100, PIN.hourlyVolPct, 0.005, "hourly σ");
  near(realizedVol({ intervalMin: 1440, candles: daily }).annualized * 100, PIN.dailyVolAnnualizedPct, 0.5, "daily σ annualized");
  const g = ladderGeometry(1.625);
  const w24 = worstDropWithin(hourly, 24);
  near(w24.worst * 100, PIN.worst24hPct, 0.05, "worst 24 h drop");
  near(frequencyOfDrop(w24.drops, g.fromDisarm2Pct.derisk! / 100) * 100, PIN.freq24hAtGap, 0.05, "24 h windows at the rung-2→3 gap");
  near(worstDropWithin(daily, 1).worst * 100, PIN.worst1dPct, 0.05, "worst 1 d drop");
  const mc = (k: number) => simulateLadder({ returns: demean(logReturns(hourly)), bars: 720, paths: 10_000, seed: 20260919 + k, blockLen: 6, scale: 1, entryHf: 1.625, lt: 0.65, reserveMultiple: k, landingBars: Infinity });
  near(mc(1).zecSold * 100, PIN.k1Never30dZecSold, 1e-9, "k=1, never lands, 30 d: ZEC sold");
  near(mc(3).zecSold * 100, PIN.k3Never30dZecSold, 1e-9, "k=3, never lands, 30 d: ZEC sold");
});
