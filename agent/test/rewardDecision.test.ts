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

// ---------------------------------------------------------------------------
// A-10: suspect inputs throw; the absolute floor is hard even past max-hold;
// accrued value counts only the token the router can actually move.
// ---------------------------------------------------------------------------

import { accruedForPosition, RewardInputError } from "../src/engine/rewardDecision.js";

describe("decideReward input validation (A-10)", () => {
  it("THROWS on NaN gas (never a silent eternal WAIT)", () => {
    assert.throws(
      () => decideReward({ ...base, accruedUsd: 100, gasUsd: NaN, bridgeFeeUsd: 0 }),
      RewardInputError
    );
  });

  it("THROWS on negative costs (gasUsd=-1 used to CLAIM)", () => {
    assert.throws(
      () => decideReward({ ...base, accruedUsd: 100, gasUsd: -1, bridgeFeeUsd: 0 }),
      /gasUsd/
    );
    assert.throws(
      () => decideReward({ ...base, accruedUsd: 100, gasUsd: 1, bridgeFeeUsd: -0.5 }),
      /bridgeFeeUsd/
    );
  });

  it("THROWS on non-finite accrued and bad age", () => {
    assert.throws(() => decideReward({ ...base, accruedUsd: Infinity, gasUsd: 1, bridgeFeeUsd: 0 }));
    assert.throws(
      () => decideReward({ ...base, accruedUsd: 10, gasUsd: 1, bridgeFeeUsd: 0, accrualAgeDays: NaN })
    );
  });

  it("zero gas from a FAILED estimate is still a decision on valid numbers (0 is allowed)", () => {
    // 0 is finite and ≥ 0 — legitimate (e.g. subsidized gas). The guard is
    // against NaN/negative garbage, not against zero itself.
    const d = decideReward({ ...base, accruedUsd: 30, gasUsd: 0, bridgeFeeUsd: 0 });
    assert.equal(d.action, "CLAIM");
  });
});

describe("max-hold floor hardness (A-10)", () => {
  it("max-hold does NOT bypass the $5 absolute floor (auto-shield economics)", () => {
    // age 31d, accrued $1.20, costs $0.30 → the OLD code claimed (net $0.90).
    const d = decideReward({
      ...base,
      accruedUsd: 1.2,
      gasUsd: 0.2,
      bridgeFeeUsd: 0.1,
      accrualAgeDays: 31,
    });
    assert.equal(d.action, "WAIT");
    assert.match(d.reason, /floor/);
  });

  it("max-hold still relaxes the cost MULTIPLE once the floor is cleared", () => {
    // accrued $10 ≥ floor, but < 3× costs ($15) — claims only via max-hold.
    const early = decideReward({ ...base, accruedUsd: 10, gasUsd: 2, bridgeFeeUsd: 3, accrualAgeDays: 1 });
    assert.equal(early.action, "WAIT");
    const late = decideReward({ ...base, accruedUsd: 10, gasUsd: 2, bridgeFeeUsd: 3, accrualAgeDays: 31 });
    assert.equal(late.action, "CLAIM");
  });
});

describe("accruedForPosition (A-10)", () => {
  const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
  const price = (token: string, amount: bigint) =>
    token.toLowerCase() === USDC.toLowerCase() ? Number(amount) / 1e6 : (Number(amount) / 1e18) * 0.5;

  it("counts ONLY the position's entry token; other tokens land in unmatchedUsd", () => {
    const r = accruedForPosition(
      USDC,
      { tokens: [USDC, AERO], amounts: [250_000_000n, 5_000_000_000_000_000_000n] },
      price
    );
    assert.equal(r.accruedAtomic, 250_000_000n);
    assert.equal(r.accruedUsd, 250);
    assert.equal(r.unmatchedUsd, 2.5); // 5 AERO × $0.50 — visible, not claimable
  });

  it("matching is case-insensitive (checksummed vs lowercase addresses)", () => {
    const r = accruedForPosition(
      USDC.toLowerCase(),
      { tokens: [USDC], amounts: [1_000_000n] },
      price
    );
    assert.equal(r.accruedUsd, 1);
    assert.equal(r.unmatchedUsd, 0);
  });

  it("an AERO-only reward stream yields accrued 0 → decision engine WAITs (no reverting claim)", () => {
    const r = accruedForPosition(USDC, { tokens: [AERO], amounts: [10n ** 18n] }, price);
    assert.equal(r.accruedAtomic, 0n);
    assert.equal(r.accruedUsd, 0);
    assert.equal(r.unmatchedUsd, 0.5);
    const d = decideReward({ ...base, accruedUsd: r.accruedUsd, gasUsd: 1, bridgeFeeUsd: 0 });
    assert.equal(d.action, "WAIT");
  });

  it("THROWS when the price oracle returns NaN (suspect data, not silent zero)", () => {
    assert.throws(
      () => accruedForPosition(USDC, { tokens: [USDC], amounts: [1n] }, () => NaN),
      RewardInputError
    );
  });
});
