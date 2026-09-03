import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { HealthMonitor } from "../src/monitors/healthMonitor.js";
import type { RheaService } from "../src/services/rhea.js";
import type { StrategyStore } from "../src/store/strategyStore.js";
import type { HealthAssessment } from "@zyo/shared";
import { spy } from "./helpers.js";

const thresholds = { warning: 1.5, critical: 1.2, emergency: 1.05 };

function makeStrategy() {
  return {
    id: "s1",
    owner: { zcashAddress: "t1Le9mTDaqQUX1ANKaeDchpJsxEY4h5LQCX" },
    mode: "FULL_STRATEGY",
    status: "ACTIVE",
    rewardPreference: "COMPOUND",
    lending: { mcaId: "mca.1", suppliedZecAtomic: "100000000", borrowedAmountAtomic: "500000000" },
    createdAt: "0",
    updatedAt: "0",
  };
}

/** Rhea fake that returns a scripted health factor per tick. */
function makeRhea(sequence: number[]) {
  let i = 0;
  const getAccountState = spy(async (_mca: string) => ({
    healthFactor: sequence[Math.min(i++, sequence.length - 1)],
  }));
  return { service: { getAccountState } as unknown as RheaService, getAccountState };
}

function makeStore() {
  const update = spy(async (_id: string, _patch: unknown) => makeStrategy());
  const list = spy(async () => [makeStrategy()]);
  return { service: { list, update } as unknown as StrategyStore, list, update };
}

describe("HealthMonitor", () => {
  it("dispatches the emergency unwind even when already CRITICAL (band-only dedup would swallow it)", async () => {
    const rhea = makeRhea([1.15, 1.02]); // CRITICAL/REDUCE → CRITICAL/EMERGENCY_UNWIND
    const store = makeStore();
    const actions: HealthAssessment[] = [];
    const onAction = spy(async (a: HealthAssessment) => {
      actions.push(a);
    });
    const mon = new HealthMonitor(rhea.service, store.service, thresholds, onAction);

    await mon.tick(); // 1.15 → REDUCE_LEVERAGE
    await mon.tick(); // 1.02 → EMERGENCY_UNWIND (must NOT be deduped as "same CRITICAL band")

    assert.equal(actions.length, 2);
    assert.equal(actions[0]!.suggestedAction, "REDUCE_LEVERAGE");
    assert.equal(actions[1]!.suggestedAction, "EMERGENCY_UNWIND");
  });

  it("does not re-dispatch a stable state every tick", async () => {
    const rhea = makeRhea([1.15, 1.15, 1.15]);
    const store = makeStore();
    const onAction = spy(async (_a: HealthAssessment) => {});
    const mon = new HealthMonitor(rhea.service, store.service, thresholds, onAction);

    await mon.tick();
    await mon.tick();
    await mon.tick();

    assert.equal(onAction.calls.length, 1); // only the first entry into REDUCE_LEVERAGE
  });

  it("retries dispatch next tick when the handler throws (marker not advanced on failure)", async () => {
    const rhea = makeRhea([1.15, 1.15]);
    const store = makeStore();
    let first = true;
    const onAction = spy(async (_a: HealthAssessment) => {
      if (first) {
        first = false;
        throw new Error("handler blew up");
      }
    });
    const mon = new HealthMonitor(rhea.service, store.service, thresholds, onAction);

    await mon.tick(); // throws inside handler; caught by tick's try/catch
    await mon.tick(); // same CRITICAL state must be retried, not deduped

    assert.equal(onAction.calls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// A-06 / A-15: dispatch markers set BEFORE the handler, persisted to the
// store, restart-safe; hysteresis on the improving edge.
// ---------------------------------------------------------------------------

import type { Strategy } from "@zyo/shared";

/** Store fake with a REAL record the patch functions apply to. */
function makeRealStore(initial?: Partial<Strategy>) {
  let record: Strategy = { ...(makeStrategy() as unknown as Strategy), ...initial };
  const list = spy(async () => [record]);
  const update = spy(
    async (_id: string, patch: ((s: Strategy) => Strategy) | Partial<Strategy>) => {
      record = typeof patch === "function" ? patch(record) : { ...record, ...patch };
      return record;
    }
  );
  return {
    service: { list, update } as unknown as StrategyStore,
    list,
    update,
    get record() {
      return record;
    },
  };
}

describe("HealthMonitor dispatch persistence (A-06/A-15)", () => {
  it("persists lastDispatchedAction BEFORE the handler runs and sets UNWINDING for emergencies", async () => {
    const rhea = makeRhea([1.01]);
    const store = makeRealStore();
    let statusAtDispatch: string | undefined;
    let markerAtDispatch: string | undefined;
    const mon = new HealthMonitor(rhea.service, store.service, thresholds, async () => {
      statusAtDispatch = store.record.status;
      markerAtDispatch = store.record.lastDispatchedAction;
    });

    await mon.tick();

    // The marker + UNWINDING status were already durable when the handler ran
    // — a crash inside the handler cannot re-dispatch after restart.
    assert.equal(markerAtDispatch, "CRITICAL:EMERGENCY_UNWIND");
    assert.equal(statusAtDispatch, "UNWINDING");
    assert.equal(store.record.inflightActionId, "CRITICAL:EMERGENCY_UNWIND");
  });

  it("a restarted monitor seeds markers from the store and does NOT re-dispatch", async () => {
    const rhea = makeRhea([1.01, 1.01]);
    const store = makeRealStore({
      status: "UNWINDING",
      lastDispatchedAction: "CRITICAL:EMERGENCY_UNWIND",
      inflightActionId: "CRITICAL:EMERGENCY_UNWIND",
    } as Partial<Strategy>);
    const onAction = spy(async (_a: HealthAssessment) => {});
    // Fresh monitor instance = restarted agent process.
    const mon = new HealthMonitor(rhea.service, store.service, thresholds, onAction);

    await mon.tick();
    await mon.tick();

    assert.equal(onAction.calls.length, 0); // action already in flight pre-crash
  });

  it("rolls the persisted marker back when the handler throws, so retry survives a restart too", async () => {
    const rhea = makeRhea([1.15, 1.15]);
    const store = makeRealStore();
    let first = true;
    const onAction = spy(async () => {
      if (first) {
        first = false;
        throw new Error("handler blew up");
      }
    });
    const mon = new HealthMonitor(rhea.service, store.service, thresholds, onAction);

    await mon.tick(); // dispatch fails → marker rolled back in memory AND store
    assert.equal(store.record.lastDispatchedAction, undefined);
    await mon.tick(); // retried
    assert.equal(onAction.calls.length, 2);
    assert.equal(store.record.lastDispatchedAction, "CRITICAL:REDUCE_LEVERAGE");
  });
});

describe("HealthMonitor hysteresis (A-15)", () => {
  it("HF flapping across the critical threshold does not re-alert every oscillation", async () => {
    // 1.19 → CRITICAL; 1.21 is above critical but NOT above critical+0.05 →
    // stays CRITICAL (no HEALTHY/CRITICAL alert ping-pong); 1.19 again → no
    // NEW dispatch (same sticky state); 1.26 clears the margin → WARNING band
    // applies (1.26 < warning 1.5) → WARNING/NOTIFY dispatch.
    const rhea = makeRhea([1.19, 1.21, 1.19, 1.26]);
    const store = makeRealStore();
    const actions: HealthAssessment[] = [];
    const mon = new HealthMonitor(rhea.service, store.service, thresholds, async (a) => {
      actions.push(a);
    });

    await mon.tick(); // 1.19 CRITICAL:REDUCE_LEVERAGE
    await mon.tick(); // 1.21 sticky CRITICAL — no new dispatch
    await mon.tick(); // 1.19 CRITICAL again — deduped
    await mon.tick(); // 1.26 > 1.2+0.05 → leaves CRITICAL → WARNING:NOTIFY

    assert.deepEqual(
      actions.map((a) => `${a.band}:${a.suggestedAction}`),
      ["CRITICAL:REDUCE_LEVERAGE", "WARNING:NOTIFY"]
    );
  });

  it("worsening always applies immediately (no hysteresis on the way down)", async () => {
    const rhea = makeRhea([1.3, 1.19]);
    const store = makeRealStore();
    const actions: HealthAssessment[] = [];
    const mon = new HealthMonitor(rhea.service, store.service, thresholds, async (a) => {
      actions.push(a);
    });
    await mon.tick(); // WARNING
    await mon.tick(); // CRITICAL — instant
    assert.deepEqual(
      actions.map((a) => `${a.band}:${a.suggestedAction}`),
      ["WARNING:NOTIFY", "CRITICAL:REDUCE_LEVERAGE"]
    );
  });

  it("leaving the emergency rung also needs margin (no unwind/deleverage flapping)", async () => {
    const rhea = makeRhea([1.02, 1.07, 1.12]);
    const store = makeRealStore();
    const actions: HealthAssessment[] = [];
    const mon = new HealthMonitor(rhea.service, store.service, thresholds, async (a) => {
      actions.push(a);
    });
    await mon.tick(); // 1.02 → EMERGENCY_UNWIND
    await mon.tick(); // 1.07 ≤ 1.05+0.05 → sticky EMERGENCY_UNWIND, no new dispatch
    await mon.tick(); // 1.12 > 1.10 → de-escalates to REDUCE_LEVERAGE
    assert.deepEqual(
      actions.map((a) => a.suggestedAction),
      ["EMERGENCY_UNWIND", "REDUCE_LEVERAGE"]
    );
  });
});
