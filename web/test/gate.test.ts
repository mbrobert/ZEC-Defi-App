import { test } from "node:test";
import assert from "node:assert/strict";
import { findVerdict, normalizeGate, offeredEntries, reasonText, rejectedEntries, unavailableGate, verdictsFor } from "../lib/gate";
import { DEMO_GATE_RAW, demoGate } from "../lib/demo";

const verdict = (over: Record<string, unknown>) => ({
  poolId: "aero-usdc-weth-5",
  setting: "steady",
  preset: "MODERATE",
  collateral: "cbBTC",
  rangeWidthBps: 1500,
  halfWidth: 0.0779,
  qualifies: true,
  reason: null,
  emissionsGrossPct: 40,
  emissionsNetPct: 30.6,
  emissionsRealizedPct: 20,
  dragPct: -10,
  lpNetPct: 10,
  borrowAprPct: 4.828,
  collateralSupplyAprPct: 0.012,
  sigma: 0.55,
  breakEvenSigma: null,
  breakEvenEmissionsMultiple: null,
  userNet: [{ ltvBps: 4000, offerable: true, userNetPct: 2.08 }],
  ...over,
});

const SETTINGS = [
  { id: "sheltered", preset: "CONSERVATIVE", rebalanceDelayHours: 48 },
  { id: "steady", preset: "MODERATE", rebalanceDelayHours: 12 },
  { id: "working", preset: "AGGRESSIVE", rebalanceDelayHours: 2 },
];

test("normalizeGate re-derives `qualifies` from lpNet vs borrow, never trusting the flag alone", () => {
  const v = normalizeGate(
    {
      generatedAt: "2026-09-05T01:00:00Z",
      borrowAprPct: 4.828,
      settings: SETTINGS,
      verdicts: [
        verdict({}),
        // service says qualifies but the served numbers say no → NOT offered
        verdict({ poolId: "aero-cbbtc-usdc", lpNetPct: 3, qualifies: true }),
        // numbers say yes but the service refused (e.g. stale emissions) → NOT offered, reason kept
        verdict({ setting: "working", preset: "AGGRESSIVE", lpNetPct: 50, qualifies: false, reason: "emissions_stale" }),
      ],
    },
    "live",
  );
  assert.equal(v.source, "live");
  assert.equal(v.borrowAprPct, 4.828);
  assert.equal(v.verdicts.length, 3);
  assert.deepEqual(
    v.verdicts.map((e) => e.qualifies),
    [true, false, false],
  );
  assert.equal(v.verdicts[0].rebalanceDelayHours, 12);
  assert.equal(v.verdicts[1].reason, "net_below_borrow");
  assert.equal(v.verdicts[2].reason, "emissions_stale");
  assert.equal(offeredEntries(v, "cbBTC").length, 1);
  assert.equal(rejectedEntries(v, "cbBTC").length, 2);
  assert.equal(offeredEntries(v, "WETH").length, 0);
});

test("normalizeGate drops verdicts it cannot read (unknown pool, bad setting/preset, missing width)", () => {
  const v = normalizeGate(
    {
      borrowAprPct: 4.8,
      settings: SETTINGS,
      verdicts: [verdict({ poolId: "not-a-pool" }), verdict({ setting: "wide" }), verdict({ preset: "WIDE" }), verdict({ rangeWidthBps: undefined }), verdict({ halfWidth: "x" })],
    },
    "live",
  );
  assert.equal(v.verdicts.length, 0);
});

test("normalizeGate: stale payload → nothing qualifies; unreadable borrow → nothing qualifies", () => {
  const stale = normalizeGate({ borrowAprPct: 4.8, stale: true, settings: SETTINGS, verdicts: [verdict({})] }, "live");
  assert.equal(stale.stale, true);
  assert.equal(stale.verdicts[0].qualifies, false);
  const noBorrow = normalizeGate({ settings: SETTINGS, verdicts: [verdict({ borrowAprPct: undefined })] }, "live");
  assert.equal(noBorrow.verdicts[0].qualifies, false);
  assert.ok(Number.isNaN(noBorrow.borrowAprPct));
});

test("unavailableGate (503) offers nothing and carries the reason", () => {
  const g = unavailableGate("rates_stale", "live");
  assert.equal(g.verdicts.length, 0);
  assert.equal(g.unavailableReason, "rates_stale");
  assert.equal(reasonText("rates_stale"), "borrow rate sample is stale");
  assert.equal(reasonText("something_new"), "something new");
});

test("verdictsFor sorts best lpNet first; findVerdict matches pool × setting × collateral", () => {
  const v = normalizeGate(
    { borrowAprPct: 4.8, settings: SETTINGS, verdicts: [verdict({ lpNetPct: -5, qualifies: false, reason: "net_below_borrow" }), verdict({ poolId: "aero-cbbtc-usdc", lpNetPct: 1, qualifies: false, reason: "net_below_borrow" }), verdict({ collateral: "WETH" })] },
    "live",
  );
  assert.deepEqual(
    verdictsFor(v, "cbBTC").map((e) => e.poolId),
    ["aero-cbbtc-usdc", "aero-usdc-weth-5"],
  );
  assert.equal(findVerdict(v, { poolId: "aero-usdc-weth-5", setting: "steady", collateral: "WETH" })?.qualifies, true);
  assert.equal(findVerdict(v, { poolId: "aero-usdc-weth-5", setting: "working", collateral: "WETH" }), undefined);
});

test("demo gate = the yield model's verdict: NOTHING clears at 4.828%; cbZEC pool refused for no emissions; cbZEC collateral disabled", () => {
  const g = demoGate();
  assert.equal(g.source, "demo");
  assert.equal(g.borrowAprPct, 4.828);
  assert.equal(g.engineFeeBps, 1500);
  assert.equal(DEMO_GATE_RAW.qualifying.length, 0);
  assert.equal(g.verdicts.filter((v) => v.qualifies).length, 0);
  assert.equal(offeredEntries(g, "cbBTC").length, 0);
  assert.equal(offeredEntries(g, "WETH").length, 0);
  const cbzec = g.verdicts.find((v) => v.poolId === "aero-cbzec-usdc" && v.collateral === "cbBTC");
  assert.ok(cbzec, "cbZEC pool is tracked");
  assert.equal(cbzec!.qualifies, false);
  assert.equal(cbzec!.reason, "no_emissions");
  assert.ok(g.verdicts.filter((v) => v.collateral === "cbZEC").every((v) => v.reason === "collateral_disabled"));
  // The best cell in the doc: cbBTC/USDC sheltered, lpNet −5.29, break-even 2.02×
  const best = g.verdicts.find((v) => v.poolId === "aero-cbbtc-usdc" && v.setting === "sheltered" && v.collateral === "cbBTC")!;
  assert.equal(best.lpNetPct, -5.29);
  assert.equal(best.breakEvenEmissionsMultiple, 2.02);
  assert.equal(best.userNet.find((u) => u.ltvBps === 4000)?.userNetPct, -4.03);
});
