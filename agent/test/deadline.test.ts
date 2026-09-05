import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AbortedError, DeadlineError, mapBounded, sleep, withDeadline } from "../src/services/deadline.js";

describe("withDeadline", () => {
  it("resolves a fast promise", async () => {
    assert.equal(await withDeadline("x", 100, undefined, async () => 42), 42);
  });

  it("rejects with DeadlineError when the work never settles", async () => {
    await assert.rejects(
      withDeadline("slowcall", 20, undefined, () => new Promise<never>(() => undefined)),
      (e: unknown) => e instanceof DeadlineError && /slowcall: no answer within 20ms/.test((e as Error).message)
    );
  });

  it("rejects immediately on an aborted signal and on abort mid-flight", async () => {
    const c = new AbortController();
    c.abort();
    await assert.rejects(withDeadline("x", 1000, c.signal, async () => 1), AbortedError);
    const c2 = new AbortController();
    const p = withDeadline("y", 1000, c2.signal, () => new Promise<never>(() => undefined));
    setTimeout(() => c2.abort(new Error("stall")), 5);
    await assert.rejects(p, (e: unknown) => e instanceof AbortedError && /stall/.test((e as Error).message));
  });

  it("propagates the work's own rejection and refuses ms ≤ 0", async () => {
    await assert.rejects(withDeadline("x", 100, undefined, async () => { throw new Error("nope"); }), /nope/);
    await assert.rejects(withDeadline("x", 0, undefined, async () => 1), RangeError);
  });
});

describe("mapBounded", () => {
  it("never exceeds the concurrency limit and preserves order", async () => {
    let inFlight = 0;
    let peak = 0;
    const res = await mapBounded([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
      if (n === 4) throw new Error("four");
      return n * 10;
    });
    assert.equal(peak, 3);
    assert.deepEqual(
      res.map((r) => (r.status === "fulfilled" ? r.value : "ERR")),
      [10, 20, 30, "ERR", 50, 60, 70]
    );
  });

  it("isolates failures per item and stops scheduling after abort", async () => {
    const c = new AbortController();
    let started = 0;
    const res = await mapBounded(
      [1, 2, 3, 4, 5, 6],
      1,
      async (n) => {
        started++;
        if (n === 2) c.abort(new Error("stop"));
        return n;
      },
      c.signal
    );
    assert.equal(started, 2);
    assert.equal(res[0].status, "fulfilled");
    assert.equal(res[1].status, "fulfilled");
    for (const r of res.slice(2)) {
      assert.equal(r.status, "rejected");
      assert.ok((r as PromiseRejectedResult).reason instanceof AbortedError);
    }
  });
});
