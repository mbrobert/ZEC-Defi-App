import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProgressWatchdog } from "../src/watchdog.js";

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const BACKOFF = { initialMs: 1000, maxMs: 8000, factor: 2 };

describe("progress watchdog", () => {
  it("a slow tick that keeps making progress is NEVER aborted, however long it runs", () => {
    const c = clock();
    const wd = new ProgressWatchdog({ stallMs: 100, backoff: BACKOFF, now: c.now });
    const h = wd.beginTick();
    // 10,000 ms of work — 100× the stall window — with a unit completing every 90 ms.
    for (let i = 0; i < 111; i++) {
      c.advance(90);
      h.bump();
      assert.equal(wd.check(), "ok");
    }
    assert.equal(h.signal.aborted, false);
    h.end();
    assert.equal(wd.currentBackoffMs, 0);
    assert.equal(wd.stallCount, 0);
  });

  it("a tick with no progress for stallMs is aborted exactly once and backoff rises", () => {
    const c = clock();
    const stalls: number[] = [];
    const wd = new ProgressWatchdog({ stallMs: 100, backoff: BACKOFF, now: c.now, onStall: (i) => stalls.push(i.backoffMs) });
    const h = wd.beginTick();
    c.advance(99);
    assert.equal(wd.check(), "ok");
    c.advance(1);
    assert.equal(wd.check(), "stalled");
    assert.equal(h.signal.aborted, true);
    assert.match(String(h.signal.reason), /no progress for 100ms/);
    assert.equal(wd.check(), "idle"); // not reported twice
    assert.deepEqual(stalls, [1000]);
    h.end(); // late end from the aborted tick is ignored
    assert.equal(wd.currentBackoffMs, 1000);
  });

  it("exponential backoff, capped; a late bump from an aborted tick is ignored", () => {
    const c = clock();
    const wd = new ProgressWatchdog({ stallMs: 50, backoff: BACKOFF, now: c.now });
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const h = wd.beginTick();
      c.advance(50);
      assert.equal(wd.check(), "stalled");
      h.bump(); // must not count as progress for the next tick
      seen.push(wd.currentBackoffMs);
    }
    assert.deepEqual(seen, [1000, 2000, 4000, 8000, 8000, 8000]);
    assert.equal(wd.stallCount, 6);
  });

  it("any progress in a later tick resets the backoff to zero", () => {
    const c = clock();
    const wd = new ProgressWatchdog({ stallMs: 50, backoff: BACKOFF, now: c.now });
    let h = wd.beginTick();
    c.advance(50);
    wd.check();
    assert.equal(wd.currentBackoffMs, 1000);
    h = wd.beginTick();
    c.advance(10);
    h.bump();
    h.end();
    assert.equal(wd.currentBackoffMs, 0);
    assert.equal(wd.stallCount, 0);
  });

  it("idle between ticks is not a stall; only one tick may be in flight", () => {
    const c = clock();
    const wd = new ProgressWatchdog({ stallMs: 50, backoff: BACKOFF, now: c.now });
    c.advance(10_000);
    assert.equal(wd.check(), "idle");
    const h = wd.beginTick();
    assert.throws(() => wd.beginTick(), /already in flight/);
    h.end();
    assert.equal(wd.tickInFlight, false);
  });

  it("refuses nonsensical parameters", () => {
    assert.throws(() => new ProgressWatchdog({ stallMs: 0, backoff: BACKOFF }), RangeError);
    assert.throws(() => new ProgressWatchdog({ stallMs: 10, backoff: { initialMs: 10, maxMs: 5, factor: 2 } }), RangeError);
    assert.throws(() => new ProgressWatchdog({ stallMs: 10, backoff: { initialMs: 10, maxMs: 50, factor: 1 } }), RangeError);
  });
});
