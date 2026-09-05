import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObserveOnlyDispatcher } from "../src/dispatch/observeOnly.js";
import { DeadlineError } from "../src/services/deadline.js";
import { Logger, memorySink } from "../src/log.js";
import type { DispatchRecord } from "../src/store/keeperStore.js";
import { ACCOUNT_A } from "./fixtures.js";

function rec(action: string): DispatchRecord {
  const t = "2026-09-05T01:00:00.000Z";
  return { key: `${ACCOUNT_A}:1:1:${action}`, account: ACCOUNT_A, episode: 1, seq: 1, action, rung: "x", hf: 1.2, status: "PENDING", attempts: 0, createdAt: t, updatedAt: t };
}

describe("ObserveOnlyDispatcher (no keeper key)", () => {
  it("delivers notify, refuses every on-chain action, never confirms", async () => {
    const m = memorySink();
    const notified: string[] = [];
    const d = new ObserveOnlyDispatcher(new Logger(m.sink, "debug"), (r) => void notified.push(r.key));
    assert.deepEqual(await d.dispatch({ record: rec("notify"), valuation: null }), { status: "NOTIFIED" });
    assert.deepEqual(notified, [rec("notify").key]);
    for (const a of ["repay", "derisk", "emergency-unwind"]) {
      const r = await d.dispatch({ record: rec(a), valuation: null });
      assert.equal(r.status, "REFUSED");
      assert.match((r as { reason: string }).reason, /observe-only/);
    }
    assert.equal((await d.confirm()).status, "REFUSED");
    assert.ok(m.lines.some((l) => l.includes("NOTIFY: health warning")));
  });

  it("a hanging notify hook is bounded by the deadline / tick signal", async () => {
    const d = new ObserveOnlyDispatcher(new Logger(memorySink().sink, "error"), () => new Promise<void>(() => undefined), 30);
    await assert.rejects(d.dispatch({ record: rec("notify"), valuation: null }), DeadlineError);
    const c = new AbortController();
    const p = new ObserveOnlyDispatcher(new Logger(memorySink().sink, "error"), () => new Promise<void>(() => undefined), 10_000).dispatch({ record: rec("notify"), valuation: null }, c.signal);
    setTimeout(() => c.abort(new Error("watchdog")), 5);
    await assert.rejects(p, /aborted/);
  });
});
