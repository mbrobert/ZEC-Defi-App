import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KNOWN_REASONS, findVerdict, normalizeGate, offeredEntries, reasonPlain, reasonText, rejectedEntries, unavailableGate, verdictsFor } from "../lib/gate";
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
  mcLpNetPct: 9.4,
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

test("normalizeGate re-derives `qualifies` from BOTH models vs borrow, never trusting the flag alone", () => {
  const v = normalizeGate(
    {
      generatedAt: "2026-09-05T01:00:00Z",
      borrowAprPct: 4.828,
      settings: SETTINGS,
      verdicts: [
        verdict({}),
        // service says qualifies but the served closed form says no → NOT offered
        verdict({ poolId: "aero-cbbtc-usdc", lpNetPct: 3, mcLpNetPct: 3, qualifies: true }),
        // numbers say yes but the service refused (e.g. stale emissions) → NOT offered, reason kept
        verdict({ setting: "working", preset: "AGGRESSIVE", lpNetPct: 50, mcLpNetPct: 48, qualifies: false, reason: "emissions_stale" }),
        // the closed form clears, the calibrated one does not → the model-uncertainty band
        verdict({ poolId: "aero-weth-cbbtc", lpNetPct: 6, mcLpNetPct: 1.2, qualifies: true }),
        // no calibration at all → fails CLOSED; a cell priced once is not offered
        verdict({ poolId: "aero-weth-link", lpNetPct: 12, mcLpNetPct: null, qualifies: true }),
      ],
    },
    "live",
  );
  assert.equal(v.source, "live");
  assert.equal(v.borrowAprPct, 4.828);
  assert.equal(v.verdicts.length, 5);
  assert.deepEqual(
    v.verdicts.map((e) => e.qualifies),
    [true, false, false, false, false],
  );
  assert.equal(v.verdicts[0].rebalanceDelayHours, 12);
  assert.equal(v.verdicts[0].mcLpNetPct, 9.4);
  assert.equal(v.verdicts[1].reason, "net_below_borrow");
  assert.equal(v.verdicts[2].reason, "emissions_stale");
  assert.equal(v.verdicts[3].reason, "within_model_uncertainty");
  assert.equal(v.verdicts[4].reason, "mc_calibration_unavailable");
  assert.equal(offeredEntries(v, "cbBTC").length, 1);
  assert.equal(rejectedEntries(v, "cbBTC").length, 4);
  assert.equal(offeredEntries(v, "WETH").length, 0);
});

test("every refusal reason the yield service can send has both technical and plain UI copy", () => {
  const src = readFileSync(join(__dirname, "../../services/yield/src/types.ts"), "utf8");
  const block = src.slice(src.indexOf("export type GateReason ="));
  const served = [...block.slice(0, block.indexOf(";")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.ok(served.length >= 18, `parsed ${served.length} reasons from the service`);
  for (const r of served) {
    assert.ok(KNOWN_REASONS.includes(r), `no Advanced-mode text for reason "${r}"`);
    const plain = reasonPlain(r);
    assert.ok(plain.length > 30 && /[.]$/.test(plain), `no plain sentence for reason "${r}": ${plain}`);
    assert.ok(!plain.includes("_"), `plain copy for "${r}" leaks the code`);
  }
  // The new ones this round exists for, by name.
  for (const r of ["within_model_uncertainty", "emissions_implausible", "collateral_paused", "borrow_paused", "net_out_of_bounds"]) {
    assert.ok(served.includes(r), `${r} missing from the service union`);
    assert.notEqual(reasonText(r), r.replace(/_/g, " "), `${r} has no written text`);
  }
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
    { borrowAprPct: 4.8, settings: SETTINGS, verdicts: [verdict({ lpNetPct: -5, mcLpNetPct: -5.2, qualifies: false, reason: "net_below_borrow" }), verdict({ poolId: "aero-cbbtc-usdc", lpNetPct: 1, mcLpNetPct: 0.8, qualifies: false, reason: "net_below_borrow" }), verdict({ collateral: "WETH" })] },
    "live",
  );
  assert.deepEqual(
    verdictsFor(v, "cbBTC").map((e) => e.poolId),
    ["aero-cbbtc-usdc", "aero-usdc-weth-5"],
  );
  assert.equal(findVerdict(v, { poolId: "aero-usdc-weth-5", setting: "steady", collateral: "WETH" })?.qualifies, true);
  assert.equal(findVerdict(v, { poolId: "aero-usdc-weth-5", setting: "working", collateral: "WETH" }), undefined);
});

test("demo gate = the yield model's verdict: NOTHING clears at 4.5174%; cbZEC pool refused below the borrow (its gauge is voted since 2026-09-12) or for no σ; cbZEC collateral disabled", () => {
  const g = demoGate();
  assert.equal(g.source, "demo");
  assert.equal(g.borrowAprPct, 4.5174);
  assert.equal(g.engineFeeBps, 1500);
  assert.equal(DEMO_GATE_RAW.qualifying.length, 0);
  assert.equal(g.verdicts.filter((v) => v.qualifies).length, 0);
  assert.equal(offeredEntries(g, "cbBTC").length, 0);
  assert.equal(offeredEntries(g, "WETH").length, 0);
  const cbzec = g.verdicts.find((v) => v.poolId === "aero-cbzec-usdc" && v.collateral === "cbBTC");
  assert.ok(cbzec, "cbZEC pool is tracked");
  assert.equal(cbzec!.qualifies, false);
  // 2026-09-12: the cbZEC/USDC gauge carries an emissions vote (≈ 617 AERO/day), so the sheltered
  // cell is refused for emissions BELOW the borrow, not for having none; the working cell for no σ.
  assert.equal(cbzec!.reason, "emissions_below_borrow");
  assert.equal(g.verdicts.find((v) => v.poolId === "aero-cbzec-usdc" && v.setting === "working" && v.collateral === "cbBTC")!.reason, "no_volatility_input");
  assert.ok(g.verdicts.filter((v) => v.collateral === "cbZEC").every((v) => v.reason === "collateral_disabled"));
  // The best cell in the doc (2026-09-12): cbBTC/USDC sheltered, lpNet −10.92, break-even 4.56×
  const best = g.verdicts.find((v) => v.poolId === "aero-cbbtc-usdc" && v.setting === "sheltered" && v.collateral === "cbBTC")!;
  assert.equal(best.lpNetPct, -10.92);
  assert.equal(best.breakEvenEmissionsMultiple, 4.56);
  // Re-pinned to MODEL-NUMBERS-v2: the sim now rounds the gross APR to 2 dp
  // exactly as sources/gauges.ts does, so the sim and the served gate agree to
  // the last digit instead of the 0.01 pt double-rounding gap they used to
  // carry (audit wave 1 lens D INFO-1).
  assert.equal(best.userNet.find((u) => u.ltvBps === 4000)?.userNetPct, -6.16);
});

// W3-LOW-3 (wave 3): a direct-venue pool is offered only where the deployment has the direct venue.
test("W3-LOW-3: gateForDeployment drops DIRECT-pool verdicts without a direct venue and keeps everything else", async () => {
  const { gateForDeployment } = await import("../lib/gate");
  const { CURATED_POOLS } = await import("@zyo/shared");
  const gate = demoGate();
  const direct = CURATED_POOLS.filter((p) => p.protocol === "DIRECT").map((p) => p.id);
  assert.ok(direct.includes("aero-cbzec-usdc"));
  // Give the demo gate a direct-pool verdict so the filter has something to drop.
  const sample = gate.verdicts[0];
  const cbzec = CURATED_POOLS.find((p) => p.id === "aero-cbzec-usdc")!;
  const withDirect = { ...gate, verdicts: [...gate.verdicts, { ...sample, poolId: cbzec.id, pool: cbzec }] };
  const engineOnly = gate.verdicts.filter((v) => v.pool.protocol !== "DIRECT").length;
  const none = gateForDeployment(withDirect, { lpVenueDirect: null });
  assert.equal(none.verdicts.length, engineOnly, "every direct verdict is dropped");
  assert.ok(none.verdicts.every((v) => v.pool.protocol !== "DIRECT"));
  const nullDeployment = gateForDeployment(withDirect, null);
  assert.equal(nullDeployment.verdicts.length, engineOnly);
  const some = gateForDeployment(withDirect, { lpVenueDirect: "0x1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d" });
  assert.equal(some.verdicts.length, withDirect.verdicts.length, "kept where the venue exists");
  const engineView = { ...gate, verdicts: gate.verdicts.filter((v) => v.pool.protocol !== "DIRECT") };
  assert.strictEqual(gateForDeployment(engineView, null), engineView, "a view without direct verdicts is returned as is");
});
