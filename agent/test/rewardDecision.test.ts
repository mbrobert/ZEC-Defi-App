import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideReward } from "../src/engine/rewardDecision.js";

const base = {
  minCostMultiple: 3,
  minAbsoluteUsd: 5,
  maxHoldDays: 30,
};

describe("decideReward", () => {
  it("waits when nothing accrued", () => {
    const d = decideReward({ ...base, accruedUsd: 0, gasUsd: 1, bridgeFeeUsd: 1 });
    assert.equal(d.action, "WAIT");
  });

  it("claims when accrued clears multiple and floor", () => {
    const d = decideReward({ ...base, accruedUsd: 30, gasUsd: 2, bridgeFeeUsd: 3 });
    // costs=5, 3x=15, accrued 30 ≥ 15 and ≥ $5 floor
    assert.equal(d.action, "CLAIM");
    assert.equal(d.netUsd, 25);
  });

  it("waits below the cost multiple even above the floor", () => {
    const d = decideReward({ ...base, accruedUsd: 10, gasUsd: 2, bridgeFeeUsd: 3 });
    assert.equal(d.action, "WAIT");
    assert.match(d.reason, /3×/);
  });

  it("waits below the absolute floor even with tiny costs", () => {
    const d = decideReward({ ...base, accruedUsd: 3, gasUsd: 0.1, bridgeFeeUsd: 0 });
    assert.equal(d.action, "WAIT");
    assert.match(d.reason, /floor/);
  });

  it("bridge fee counts toward costs (zcash route pricier than compound)", () => {
    const compound = decideReward({ ...base, accruedUsd: 12, gasUsd: 2, bridgeFeeUsd: 0 });
    const zcash = decideReward({ ...base, accruedUsd: 12, gasUsd: 2, bridgeFeeUsd: 4 });
    assert.equal(compound.action, "CLAIM"); // 12 ≥ 6
    assert.equal(zcash.action, "WAIT"); // 12 < 18
  });

  it("max-hold override claims once net positive", () => {
    const d = decideReward({
      ...base,
      accruedUsd: 10,
      gasUsd: 2,
      bridgeFeeUsd: 3,
      accrualAgeDays: 31,
    });
    assert.equal(d.action, "CLAIM");
    assert.match(d.reason, /max hold/);
  });

  it("max-hold does NOT claim at a net loss", () => {
    const d = decideReward({
      ...base,
      accruedUsd: 4,
      gasUsd: 3,
      bridgeFeeUsd: 3,
      accrualAgeDays: 90,
    });
    assert.equal(d.action, "WAIT");
  });
});
