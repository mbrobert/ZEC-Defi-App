import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { ENTRY_HF_FLOOR, HF_LADDER, hysteresisFor, rungFor as sharedRungFor } from "@zyo/shared";
import { INITIAL_LADDER_STATE, LadderShapeError, rungFor, stepLadder, validateLadder, type LadderRung, type LadderState } from "../src/engine/ladder.js";

const L = HF_LADDER;
const by = (id: string) => L.find((r) => r.id === id)!;

describe("ladder — shape", () => {
  it("accepts the shared ladder as-is (no typed thresholds in the keeper)", () => {
    validateLadder(L);
    assert.equal(L.length, 4);
    for (const r of L) assert.ok(r.disarmHf > r.hf, `${r.id} has hysteresis`);
    // The floor's ladder carries the hysteresis derived for the floor (the 0.02 minimum at 1.25), not the 0.05 scale.
    assert.ok(Math.abs(by("warn").disarmHf - by("warn").hf - hysteresisFor(ENTRY_HF_FLOOR)) < 1e-9);
  });

  it("rejects a ladder with zero hysteresis (the audited bug), duplicates, or non-monotone rungs", () => {
    const flat: LadderRung[] = [{ id: "warn", hf: 1.35, disarmHf: 1.35, severity: 1, action: "notify" }];
    assert.throws(() => validateLadder(flat), LadderShapeError);
    const dup = [
      { id: "a", hf: 1.5, disarmHf: 1.55, severity: 1, action: "x" },
      { id: "a", hf: 1.3, disarmHf: 1.35, severity: 2, action: "y" },
    ];
    assert.throws(() => validateLadder(dup), /duplicate/);
    const nonmono = [
      { id: "a", hf: 1.3, disarmHf: 1.35, severity: 1, action: "x" },
      { id: "b", hf: 1.5, disarmHf: 1.55, severity: 2, action: "y" },
    ];
    assert.throws(() => validateLadder(nonmono), /strictly decrease/);
    assert.throws(() => validateLadder([]), /empty/);
  });
});

describe("ladder — stepping", () => {
  it("healthy HF fires nothing and starts no episode", () => {
    const s = stepLadder(L, INITIAL_LADDER_STATE, 2.0);
    assert.equal(s.fire, null);
    assert.equal(s.episodeStarted, false);
    assert.deepEqual([...s.next.fired], []);
  });

  it("crossing warn fires warn and starts an episode; sitting there fires nothing more", () => {
    const s1 = stepLadder(L, INITIAL_LADDER_STATE, 1.22);
    assert.equal(s1.fire?.id, "warn");
    assert.equal(s1.episodeStarted, true);
    const s2 = stepLadder(L, s1.next, 1.21);
    assert.equal(s2.fire, null);
    assert.equal(s2.episodeStarted, false);
  });

  it("a gap down through several rungs fires the MOST severe and marks all crossed", () => {
    const s = stepLadder(L, INITIAL_LADDER_STATE, 1.0);
    assert.equal(s.fire?.id, "emergency");
    assert.deepEqual(s.crossed.map((r) => r.id), ["warn", "repay", "derisk", "emergency"]);
    assert.deepEqual([...s.next.fired].sort(), ["derisk", "emergency", "repay", "warn"]);
    // Nothing fires "late" on the way further down.
    assert.equal(stepLadder(L, s.next, 0.9).fire, null);
  });

  it("hysteresis: rung re-arms only at hf + hysteresis, then fires again on the next crossing", () => {
    let st: LadderState = stepLadder(L, INITIAL_LADDER_STATE, 1.22).next; // warn fired
    // Bouncing between 1.22 and 1.24 (under the warn disarm 1.25) must not re-fire (the 13-cycles-in-6000-ticks bug).
    let fires = 0;
    for (let i = 0; i < 6000; i++) {
      const step = stepLadder(L, st, i % 2 ? 1.24 : 1.22);
      if (step.fire) fires++;
      st = step.next;
    }
    assert.equal(fires, 0);
    // At 1.25 it re-arms…
    const rearm = stepLadder(L, st, 1.25);
    assert.deepEqual(rearm.rearmed.map((r) => r.id), ["warn"]);
    assert.equal(rearm.episodeEnded, true);
    // …and fires again when crossed again (new episode).
    const again = stepLadder(L, rearm.next, 1.22);
    assert.equal(again.fire?.id, "warn");
    assert.equal(again.episodeStarted, true);
  });

  it("re-arm after a top-up: deep episode, HF restored above all disarms, then a fresh drop protects again (no one-way latch)", () => {
    const deep = stepLadder(L, INITIAL_LADDER_STATE, 1.0); // everything fired
    const topUp = stepLadder(L, deep.next, 1.6); // above warn.disarmHf 1.25
    assert.equal(topUp.episodeEnded, true);
    assert.deepEqual([...topUp.next.fired], []);
    const drop = stepLadder(L, topUp.next, 1.08);
    assert.equal(drop.fire?.id, "derisk");
    assert.equal(drop.episodeStarted, true);
  });

  it("partial recovery re-arms only the rungs whose disarm was reached", () => {
    const deep = stepLadder(L, INITIAL_LADDER_STATE, 1.0);
    const partial = stepLadder(L, deep.next, 1.13); // ≥ derisk.disarm 1.11 and emergency.disarm 1.07; < repay.disarm 1.18
    assert.deepEqual(partial.rearmed.map((r) => r.id).sort(), ["derisk", "emergency"]);
    assert.deepEqual([...partial.next.fired].sort(), ["repay", "warn"]);
    assert.equal(partial.episodeEnded, false);
    // Falling back below derisk now fires derisk again (new dispatch, same episode).
    assert.equal(stepLadder(L, partial.next, 1.08).fire?.id, "derisk");
  });

  it("+Infinity (no debt) re-arms everything", () => {
    const deep = stepLadder(L, INITIAL_LADDER_STATE, 1.0);
    const s = stepLadder(L, deep.next, Number.POSITIVE_INFINITY);
    assert.deepEqual([...s.next.fired], []);
    assert.equal(s.episodeEnded, true);
  });

  it("unreadable HF throws — never treated as healthy", () => {
    assert.throws(() => stepLadder(L, INITIAL_LADDER_STATE, Number.NaN), LadderShapeError);
    assert.throws(() => stepLadder(L, INITIAL_LADDER_STATE, -1), LadderShapeError);
    assert.throws(() => rungFor(L, Number.NaN), LadderShapeError);
  });

  it("rungFor agrees with the shared package's rungFor everywhere", () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 3, noNaN: true }), (hf) => {
        assert.equal(rungFor(L, hf)?.id ?? null, sharedRungFor(hf)?.id ?? null);
      }),
      { numRuns: 2000 }
    );
  });
});

describe("ladder — properties", () => {
  const arbHf = fc.oneof(
    fc.double({ min: 0, max: 3, noNaN: true }),
    fc.constantFrom(...L.flatMap((r) => [r.hf, r.disarmHf, r.hf - 1e-9, r.disarmHf - 1e-9])),
    fc.constant(Number.POSITIVE_INFINITY)
  );

  it("invariants hold over random HF paths", () => {
    fc.assert(
      fc.property(fc.array(arbHf, { minLength: 1, maxLength: 200 }), (path) => {
        let st: LadderState = INITIAL_LADDER_STATE;
        let inEpisode = false;
        const firedAtHf = new Map<string, number>();
        for (const hf of path) {
          const step = stepLadder(L, st, hf);
          // (1) a rung fires only when hf < its threshold and it was armed
          for (const r of step.crossed) {
            assert.ok(hf < r.hf);
            assert.ok(!st.fired.includes(r.id));
            firedAtHf.set(r.id, hf);
          }
          // (2) a rung re-arms only when hf ≥ its disarm
          for (const r of step.rearmed) {
            assert.ok(hf >= r.disarmHf);
            assert.ok(st.fired.includes(r.id));
          }
          // (3) fire is the most severe crossed rung
          if (step.crossed.length) assert.equal(step.fire, step.crossed[step.crossed.length - 1]);
          else assert.equal(step.fire, null);
          // (4) the fired set is exactly consistent: everything below hf is fired unless it re-armed... i.e.
          //     after the step, every rung with hf < r.hf is in `fired`.
          for (const r of L) if (hf < r.hf) assert.ok(step.next.fired.includes(r.id), `${r.id} must be fired at ${hf}`);
          //     and every rung with hf ≥ disarm is NOT fired.
          for (const r of L) if (hf >= r.disarmHf) assert.ok(!step.next.fired.includes(r.id));
          // (5) episode bookkeeping matches the fired set transitions
          const nowIn = step.next.fired.length > 0;
          assert.equal(step.episodeStarted, !inEpisode && nowIn);
          assert.equal(step.episodeEnded, inEpisode && !nowIn);
          inEpisode = nowIn;
          st = step.next;
        }
      }),
      { numRuns: 2000 }
    );
  });

  it("a rung never fires twice without an intervening re-arm", () => {
    fc.assert(
      fc.property(fc.array(arbHf, { minLength: 1, maxLength: 300 }), (path) => {
        let st: LadderState = INITIAL_LADDER_STATE;
        const armed = new Map<string, boolean>(L.map((r) => [r.id, true]));
        for (const hf of path) {
          const step = stepLadder(L, st, hf);
          for (const r of step.crossed) {
            assert.equal(armed.get(r.id), true, `${r.id} fired while disarmed`);
            armed.set(r.id, false);
          }
          for (const r of step.rearmed) armed.set(r.id, true);
          st = step.next;
        }
      }),
      { numRuns: 2000 }
    );
  });
});
