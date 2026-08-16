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
    owner: { zcashAddress: "t1KrbA8XLcmZUsSdcXhkpKUWX5rMctSH5dP" },
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
    assert.equal(actions[0].suggestedAction, "REDUCE_LEVERAGE");
    assert.equal(actions[1].suggestedAction, "EMERGENCY_UNWIND");
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
