/**
 * Sizing a `protect` (design §5, "policy"): the reserve first at every rung, size only where the reserve does not
 * reach, capped at the de-risk fraction and the grant's budgets, the whole short at the emergency rung; every clamp
 * named; the reduce sized for the worst fill the grant allows. Pinned to the Foundry suite's sizing numbers.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_SHORT_DISTANCE_BPS, PERP_RUNG_INDEX, distanceBpsForHfBps, reduceForDistance, topUpE6ForDistance, type HfRungId } from "@zyo/shared";
import { planPerpProtect, reduceForDistanceWithSlippage, worstFillLossE6, type PerpGrantBounds, type PerpPlanInput } from "../src/perps/policy.js";
import { evaluatePerps, type PerpsValuationParams } from "../src/perps/valuation.js";
import { A0, A_10, A_20, A_40, MARK, MARK_10, MARK_20, MARK_40, MMR, RESERVE0, SZ, SZ_DEC, rung0, sceneSnapshot, type SceneOpts } from "./perpsFixtures.js";

const P: PerpsValuationParams = { independentMaxAgeS: 120, oracleDeviationBps: 200, requireIndependent: false };
const MARGIN = 50;
const ok = (o: SceneOpts) => {
  const v = evaluatePerps(sceneSnapshot({ independentMark: null, ...o }), P);
  assert.equal(v.kind, "OK");
  if (v.kind !== "OK") throw new Error("unreachable");
  return v;
};
const grant = (over: Partial<PerpGrantBounds> = {}): PerpGrantBounds => ({ live: true, allowedRungs: 0b1110, topUpLeft: 10_000_000_000n, reduceLeft: 500n, reduceAllowed: true, maxSlippageBps: 50, ...over });
const rung = (id: HfRungId) => ({ index: PERP_RUNG_INDEX[id], disarmHfBps: rung0(id).disarmHfBps });
const input = (v: ReturnType<typeof ok>, r: ReturnType<typeof rung>, over: Partial<PerpPlanInput> = {}): PerpPlanInput => ({ valuation: v, rung: r, grant: grant(), deriskFractionBps: 3_333, marginBps: MARGIN, ...over });
/** The distance the plan aims at: the disarm level plus the margin, as a distance. */
const targetD = (id: HfRungId) => distanceBpsForHfBps(Math.ceil(rung0(id).disarmHfBps * (1 + MARGIN / 10_000)));
const reads = (mark: bigint, a: bigint) => ({ accountValueE6: a, szi: -SZ, markRaw: mark, szDecimals: SZ_DEC, mmrBps: MMR });

describe("the sizing identities the plan rests on — the Foundry suite's numbers", () => {
  it("the top-up rung's disarm is a 35.89 % up-move and the de-risk rung's 25.92 %; the reduces that reach them at +10 % / +20 % are 67 and 104 raw (SZ − 433, SZ − 396)", () => {
    assert.equal(distanceBpsForHfBps(rung0("repay").disarmHfBps), 3589);
    assert.equal(distanceBpsForHfBps(rung0("derisk").disarmHfBps), 2592);
    assert.equal(reduceForDistance(reads(MARK_10, A_10), 3589), 67n);
    assert.equal(reduceForDistance(reads(MARK_20, A_20), 2592), 104n);
  });

  it("the worst fill of a reduce-only buy is charged to the account value, and the slippage-aware reduce is never smaller than the plain one", () => {
    assert.equal(worstFillLossE6(100n, MARK_20, SZ_DEC, 500), 92_336_500n, "100 raw × 18,467,300 × 5 % = 92.3365 USDC");
    assert.equal(worstFillLossE6(100n, MARK_20, SZ_DEC, 0), 0n);
    const plain = reduceForDistance(reads(MARK_20, A_20), 2592);
    const aware = reduceForDistanceWithSlippage(reads(MARK_20, A_20), 2592, 500);
    assert.ok(aware > plain, `${aware} > ${plain}`);
    assert.equal(reduceForDistanceWithSlippage(reads(MARK_20, A_20), 2592, 0), plain);
  });
});

describe("rung 1 — the top-up", () => {
  it("moves exactly what lifts the short to the disarm level plus the margin when the reserve covers it, and nothing else", () => {
    const v = ok({ mark: MARK_10, a: A_10, spotE6: RESERVE0 * 2n });
    const need = topUpE6ForDistance(reads(MARK_10, A_10), targetD("repay"));
    const p = planPerpProtect(input(v, rung("repay")));
    assert.equal(p.kind, "protect");
    if (p.kind !== "protect") return;
    assert.equal(p.rung, 1);
    assert.equal(p.topUpE6, need);
    assert.equal(p.reduceSz, 0n);
    assert.ok(p.expectedHfBps >= rung0("repay").disarmHfBps, `expected ${p.expectedHfBps}`);
    assert.ok(p.expectedHfBps < rung0("repay").disarmHfBps + 300, `sized to the level, not a blanket top-up: ${p.expectedHfBps}`);
    assert.equal(p.note, undefined);
  });

  it("RISKS §23: +10 % in one tick needs about 1.38× the 1× reserve — the reserve binds, the plan moves all of it and says so", () => {
    const v = ok({ mark: MARK_10, a: A_10, spotE6: RESERVE0 });
    const need = topUpE6ForDistance(reads(MARK_10, A_10), targetD("repay"));
    const ratio = Number(need) / Number(RESERVE0);
    assert.ok(ratio > 1.3 && ratio < 1.5, `need / reserve = ${ratio.toFixed(3)}`);
    const p = planPerpProtect(input(v, rung("repay")));
    assert.equal(p.kind, "protect");
    if (p.kind !== "protect") return;
    assert.equal(p.topUpE6, RESERVE0);
    assert.match(p.note ?? "", /the reserve binds: 348\.98 of \d+\.\d\d USDC needed — only the owner can add to it/);
    assert.ok(p.expectedHfBps < rung0("repay").disarmHfBps, "all of the reserve does not reach the level — the rung re-arms after");
  });

  it("refuses, not permanently, an empty reserve or a spent budget — the venue refuses a reduce at this rung", () => {
    const empty = planPerpProtect(input(ok({ mark: MARK_10, a: A_10, spotE6: 0n }), rung("repay")));
    assert.equal(empty.kind, "refused");
    if (empty.kind === "refused") {
      assert.match(empty.reason, /reserve on HyperCore is empty/);
      assert.equal(empty.permanent, false);
    }
    const spent = planPerpProtect(input(ok({ mark: MARK_10, a: A_10 }), rung("repay"), { grant: grant({ topUpLeft: 0n }) }));
    assert.equal(spent.kind, "refused");
    if (spent.kind === "refused") assert.match(spent.reason, /top-up budget for this period is exhausted/);
    const clamped = planPerpProtect(input(ok({ mark: MARK_10, a: A_10, spotE6: RESERVE0 * 2n }), rung("repay"), { grant: grant({ topUpLeft: 100_000_000n }) }));
    assert.equal(clamped.kind, "protect");
    if (clamped.kind === "protect") {
      assert.equal(clamped.topUpE6, 100_000_000n);
      assert.match(clamped.note ?? "", /top-up budget binds: 100\.00 of/);
    }
  });
});

describe("rung 2 — the de-risk", () => {
  it("with no reserve, closes the smallest slice that reaches the level (≥ the plain 104, ≤ a third of 500), sized for the worst fill", () => {
    const v = ok({ mark: MARK_20, a: A_20, spotE6: 0n });
    const p = planPerpProtect(input(v, rung("derisk")));
    assert.equal(p.kind, "protect");
    if (p.kind !== "protect") return;
    assert.equal(p.rung, 2);
    assert.equal(p.topUpE6, 0n);
    assert.ok(p.reduceSz >= 104n && p.reduceSz <= 166n, `reduce ${p.reduceSz}`);
    assert.ok(p.expectedHfBps >= rung0("derisk").disarmHfBps, `expected ${p.expectedHfBps}`);
    assert.match(p.note ?? "", /the reserve on HyperCore is empty \(649\.53 USDC needed\) — only the owner can fund it/, "the empty reserve is said even when size answers the rung");
    const wide = planPerpProtect(input(v, rung("derisk"), { grant: grant({ maxSlippageBps: 500 }) }));
    assert.equal(wide.kind, "protect");
    if (wide.kind === "protect") assert.ok(wide.reduceSz > p.reduceSz, `a wider band needs a larger reduce: ${wide.reduceSz} > ${p.reduceSz}`);
  });

  it("the reserve first: a reserve that covers the lift means no reduce at all; half a reserve means a smaller reduce", () => {
    const need = topUpE6ForDistance(reads(MARK_20, A_20), targetD("derisk"));
    const covered = planPerpProtect(input(ok({ mark: MARK_20, a: A_20, spotE6: need * 2n }), rung("derisk")));
    assert.equal(covered.kind, "protect");
    if (covered.kind === "protect") {
      assert.equal(covered.topUpE6, need);
      assert.equal(covered.reduceSz, 0n, "a reduce un-hedges; the reserve reached the level");
    }
    const half = planPerpProtect(input(ok({ mark: MARK_20, a: A_20, spotE6: need / 2n }), rung("derisk")));
    const none = planPerpProtect(input(ok({ mark: MARK_20, a: A_20, spotE6: 0n }), rung("derisk")));
    assert.equal(half.kind, "protect");
    assert.equal(none.kind, "protect");
    if (half.kind === "protect" && none.kind === "protect") {
      assert.equal(half.topUpE6, need / 2n);
      assert.ok(half.reduceSz > 0n && half.reduceSz < none.reduceSz, `${half.reduceSz} < ${none.reduceSz}`);
      assert.match(half.note ?? "", /the reserve binds/);
    }
  });

  it("the de-risk fraction and the reduce budget clamp and say so; a top-up-only grant with no reserve is refused by the owner's choice, not as exhausted", () => {
    const v = ok({ mark: MARK_20, a: A_20, spotE6: 0n });
    const fraction = planPerpProtect(input(v, rung("derisk"), { deriskFractionBps: 1_000 }));
    assert.equal(fraction.kind, "protect");
    if (fraction.kind === "protect") {
      assert.equal(fraction.reduceSz, 50n);
      assert.match(fraction.note ?? "", /de-risk fraction binds: 50 of \d+ raw size \(10\.00 % of the short\)/);
      assert.ok(fraction.expectedHfBps < rung0("derisk").disarmHfBps, "the clamp leaves the rung to re-arm");
    }
    const budget = planPerpProtect(input(v, rung("derisk"), { grant: grant({ reduceLeft: 30n }) }));
    assert.equal(budget.kind, "protect");
    if (budget.kind === "protect") {
      assert.equal(budget.reduceSz, 30n);
      assert.match(budget.note ?? "", /reduce budget binds: 30 of/);
    }
    const topUpOnly = planPerpProtect(input(v, rung("derisk"), { grant: grant({ reduceLeft: 0n, reduceAllowed: false }) }));
    assert.equal(topUpOnly.kind, "refused");
    if (topUpOnly.kind === "refused") {
      assert.match(topUpOnly.reason, /owner chose top-up-only/);
      assert.doesNotMatch(topUpOnly.reason, /exhausted/);
      assert.equal(topUpOnly.permanent, false);
    }
    const exhausted = planPerpProtect(input(v, rung("derisk"), { grant: grant({ reduceLeft: 0n, reduceAllowed: true }) }));
    assert.equal(exhausted.kind, "refused");
    if (exhausted.kind === "refused") assert.match(exhausted.reason, /reduce budget for this period is exhausted/);
  });
});

describe("rung 3 — the close", () => {
  it("closes the whole short and moves the reserve beside it; the expected distance is the cap once nothing is left", () => {
    const v = ok({ mark: MARK_40, a: A_40, spotE6: RESERVE0 });
    const p = planPerpProtect(input(v, rung("emergency")));
    assert.equal(p.kind, "protect");
    if (p.kind !== "protect") return;
    assert.equal(p.rung, 3);
    assert.equal(p.reduceSz, SZ);
    assert.equal(p.topUpE6, RESERVE0, "the reserve is spent too — if the close does not fill, the top-up still stood");
    assert.equal(p.expectedDistanceBps, MAX_SHORT_DISTANCE_BPS);
  });

  it("the reduce budget binds the close and says so; a top-up-only grant can only top up at this rung, and with nothing to move is refused", () => {
    const v = ok({ mark: MARK_40, a: A_40, spotE6: RESERVE0 });
    const bound = planPerpProtect(input(v, rung("emergency"), { grant: grant({ reduceLeft: 200n }) }));
    assert.equal(bound.kind, "protect");
    if (bound.kind === "protect") {
      assert.equal(bound.reduceSz, 200n);
      assert.match(bound.note ?? "", /reduce budget binds the close: 200 of 500/);
      assert.ok(bound.expectedDistanceBps < MAX_SHORT_DISTANCE_BPS);
    }
    const topUpOnly = planPerpProtect(input(v, rung("emergency"), { grant: grant({ reduceLeft: 0n, reduceAllowed: false }) }));
    assert.equal(topUpOnly.kind, "protect");
    if (topUpOnly.kind === "protect") {
      assert.equal(topUpOnly.reduceSz, 0n);
      assert.equal(topUpOnly.topUpE6, RESERVE0);
      assert.match(topUpOnly.note ?? "", /the venue liquidates at zero distance whatever the keeper may do/);
    }
    const nothing = planPerpProtect(input(ok({ mark: MARK_40, a: A_40, spotE6: 0n }), rung("emergency"), { grant: grant({ reduceLeft: 0n, reduceAllowed: false }) }));
    assert.equal(nothing.kind, "refused");
    if (nothing.kind === "refused") assert.match(nothing.reason, /only the owner can act/);
  });
});

describe("refusals by name", () => {
  it("no live grant and a rung the grant excludes are permanent; a position already at or above the disarm level is not", () => {
    const v = ok({ mark: MARK_10, a: A_10 });
    const dead = planPerpProtect(input(v, rung("repay"), { grant: grant({ live: false }) }));
    assert.equal(dead.kind, "refused");
    if (dead.kind === "refused") assert.equal(dead.permanent, true);
    const excluded = planPerpProtect(input(v, rung("repay"), { grant: grant({ allowedRungs: 0b1100 }) }));
    assert.equal(excluded.kind, "refused");
    if (excluded.kind === "refused") {
      assert.equal(excluded.permanent, true);
      assert.match(excluded.reason, /rung 1 not allowed/);
    }
    const healthy = planPerpProtect(input(ok({ mark: MARK, a: A0 }), rung("repay")));
    assert.equal(healthy.kind, "refused");
    if (healthy.kind === "refused") {
      assert.match(healthy.reason, /already at or above the disarm level/);
      assert.equal(healthy.permanent, false);
    }
    const warn = planPerpProtect(input(v, { index: 0, disarmHfBps: rung0("warn").disarmHfBps }));
    assert.equal(warn.kind, "refused");
    if (warn.kind === "refused") assert.equal(warn.permanent, true);
  });
});
