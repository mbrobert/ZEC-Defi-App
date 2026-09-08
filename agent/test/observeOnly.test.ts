import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ObserveOnlyDispatcher } from "../src/dispatch/observeOnly.js";
import { Logger, memorySink } from "../src/log.js";
import { MultiNotifier, type KeeperEvent } from "../src/notify/notifier.js";
import type { DispatchRecord } from "../src/store/keeperStore.js";
import { ACCOUNT_A } from "./fixtures.js";

function rec(action: string): DispatchRecord {
  const t = "2026-09-05T01:00:00.000Z";
  return { key: `${ACCOUNT_A}:1:1:${action}`, account: ACCOUNT_A, episode: 1, seq: 1, action, rung: "x", hf: 1.2, status: "PENDING", attempts: 0, createdAt: t, updatedAt: t };
}

describe("ObserveOnlyDispatcher (no keeper key)", () => {
  it("delivers notify, refuses every on-chain action permanently, never confirms", async () => {
    const m = memorySink();
    const log = new Logger(m.sink, "debug");
    const seen: KeeperEvent[] = [];
    const notifier = new MultiNotifier(log, [{ name: "test", reachesAPerson: true, send: async (e) => void seen.push(e) }], 1_000);
    const d = new ObserveOnlyDispatcher(log, notifier);
    assert.deepEqual(await d.dispatch({ record: rec("notify"), valuation: null }), { status: "NOTIFIED" });
    assert.deepEqual(seen.map((e) => e.key), [rec("notify").key]);
    for (const a of ["repay", "derisk", "emergency-unwind"]) {
      const r = await d.dispatch({ record: rec(a), valuation: null });
      assert.equal(r.status, "REFUSED");
      assert.equal((r as { permanent?: boolean }).permanent, true);
      assert.match((r as { reason: string }).reason, /observe-only/);
    }
    assert.equal((await d.confirm()).status, "REFUSED");
    assert.ok(m.lines.some((l) => l.includes("NOTIFY: health warning")));
  });

  it("N-MED-1: channels that reach nobody (the keeper's own log/store) make the rung LOGGED_ONLY, not NOTIFIED", async () => {
    const m = memorySink();
    const log = new Logger(m.sink, "debug");
    const notifier = new MultiNotifier(log, [{ name: "log", reachesAPerson: false, send: async () => undefined }, { name: "owner-history", reachesAPerson: false, send: async () => undefined }], 1_000);
    assert.equal(notifier.hasPersonChannel, false);
    const d = new ObserveOnlyDispatcher(log, notifier);
    const r = await d.dispatch({ record: rec("notify"), valuation: null });
    assert.equal(r.status, "LOGGED_ONLY");
    assert.match((r as { reason: string }).reason, /NOTIFY_WEBHOOK_URL/);
    assert.ok(m.lines.some((l) => l.includes("nobody was told")));
    // With NO notifier at all the answer is the same: nothing reached anyone.
    const none = new ObserveOnlyDispatcher(log);
    assert.equal((await none.dispatch({ record: rec("notify"), valuation: null })).status, "LOGGED_ONLY");
  });

  it("FIX C-7: a hanging channel is bounded and the rung is FAILED — not silently 'NOTIFIED'", async () => {
    const m = memorySink();
    const log = new Logger(m.sink, "error");
    const notifier = new MultiNotifier(log, [{ name: "wedged", reachesAPerson: true, send: () => new Promise<void>(() => undefined) }], 30);
    const d = new ObserveOnlyDispatcher(log, notifier);
    const r = await d.dispatch({ record: rec("notify"), valuation: null });
    assert.equal(r.status, "FAILED");
    assert.match((r as { error: string }).error, /not delivered/);
    assert.equal(notifier.failures, 1);
    assert.ok(m.lines.some((l) => l.includes("NOTIFICATION NOT DELIVERED")), "a nobody-was-told event must be loud");
  });
});
