/**
 * FIX D-HIGH-1 — the boundary guard.
 *
 * The closed form `lpNet = (1 − e^{−x})(r/x − 1)` is correct algebra for a
 * position that is ALWAYS in range. It ignores time out of range and the swap
 * cost of every re-centre, so it is optimistic, and the error GROWS WITH THE
 * EMISSIONS LEVEL — smallest in today's deeply-negative cells (where the
 * committed validation run measures it at +0.0 … +4.4 pt) and largest exactly
 * at the boundary where the gate flips. Measured at the boundary: +7.45 pt at
 * aero-cbbtc-usdc/working and +32.02 pt at aero-weth-cbbtc/working, both wider
 * than the 4.828 % borrow rate the gate compares against. Deciding on the
 * closed form alone therefore offers a pool at "+5 % LP net vs 4.828 % borrow"
 * that the product's own Monte Carlo says loses 27 %/yr.
 *
 * The gate now requires BOTH the closed form and the MC-calibrated form to
 * clear the borrow. These tests prove it AT THE DOCUMENT'S OWN PUBLISHED
 * BREAK-EVEN MULTIPLES — the numbers MODEL-NUMBERS.md prints under "What would
 * flip the gate" — because those are precisely the emissions levels the old
 * gate would have flipped at.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { poolById } from "@zyo/shared";
import { evaluateGate, type GateInputs } from "../src/gate.js";
import { keepFactor, modelWidthsBps, SETTINGS, settingWidthBps } from "../src/model.js";
import { applyMcCalibration, calibrationIndex, calibrationKey, loadMcCalibration } from "../src/mc-calibration.js";
import { emissionsFixture, mcCalibrationFixture, NOW_S, ratesFixture, volatilityFixture } from "./fixtures/model.js";

const read = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8"));
const MODEL = read("../../samples/lp-model-2026-09-13.json") as {
  inputs: { borrowAprPct: number };
  results: Record<string, Record<string, { emissionsGrossPct?: number; breakEvenEmissionsMultiple?: number | null; lpNetPct?: number | null; feeBpsLive: number }>>;
  boundaryGuard: {
    pool: string; setting: string; grossEmissionsAtBoundaryPct: number; mcLpNetPct: number;
    optimismPct: number; offeredByClosedFormAlone: boolean; offeredByServedGate: boolean;
  }[];
};
const SAMPLE = read("../../samples/gauge-emissions-2026-09-13.json") as {
  pools: Record<string, { feeBpsLive: number }>;
};

const BORROW = MODEL.inputs.borrowAprPct;
/** The rates the MODEL was generated with (borrow, supply, LT), on the fixture's shape — the fixture's own
 *  words are the 2026-09-05 read and would compare every cell against the wrong borrow. */
const MODEL_INPUTS = (read("../../samples/lp-model-2026-09-13.json") as { inputs: { collateral: Record<string, { supplyAprPct: number; liquidationThresholdBps: number }> } }).inputs;
function ratesFromModel() {
  const base = ratesFixture();
  return {
    ...base,
    borrow: { ...base.borrow, variableBorrowAprPct: BORROW },
    collateral: Object.fromEntries(
      Object.entries(base.collateral).map(([sym, r]) => [sym, { ...r, supplyAprPct: MODEL_INPUTS.collateral[sym]?.supplyAprPct ?? r.supplyAprPct, liquidationThresholdBps: MODEL_INPUTS.collateral[sym]?.liquidationThresholdBps ?? r.liquidationThresholdBps }])
    ),
  };
}
const VOL = volatilityFixture();
const MC = mcCalibrationFixture();
const settingById = (id: string) => SETTINGS.find((s) => s.id === id)!;

/**
 * A gate input for `poolId`/`settingId` whose in-range APR at the SERVED width
 * is exactly `grossPct`. The pool fee is the sample's own, so the calibration
 * needs no fee correction and the comparison is like-for-like.
 */
function at(poolId: string, settingId: string, grossPct: number, over: Partial<GateInputs> = {}): GateInputs {
  const pool = poolById(poolId)!;
  const setting = settingById(settingId);
  const served = settingWidthBps(setting, pool.pairClass);
  const table: Record<string, number> = {};
  for (const bps of modelWidthsBps()) table[String(bps)] = bps === served ? grossPct : 0;
  return {
    pool,
    setting,
    collateral: "cbBTC",
    rates: { ...ratesFromModel(), stale: false },
    emissions: {
      ...emissionsFixture(poolId, table, { feePips: Math.round(SAMPLE.pools[poolId]!.feeBpsLive * 100) }),
      stale: false,
    },
    volatility: VOL,
    mcCalibration: MC,
    nowSeconds: NOW_S,
    ...over,
  };
}

test("FIX D-HIGH-1: at MODEL-NUMBERS' own published break-even multiples the gate REFUSES every cell the Monte Carlo says loses money", () => {
  let proven = 0;
  for (const [poolId, perSetting] of Object.entries(MODEL.results)) {
    for (const [settingId, cell] of Object.entries(perSetting)) {
      const mult = cell.breakEvenEmissionsMultiple;
      if (mult == null || !cell.emissionsGrossPct) continue;
      // Exactly the document's own "needs N× today's net emissions" figure,
      // plus a hair — the level at which the OLD gate flipped to OFFERED.
      const gross = cell.emissionsGrossPct * mult * 1.0001;
      const v = evaluateGate(at(poolId, settingId, gross));
      const where = `${poolId}/${settingId} @ ${mult.toFixed(2)}×`;

      // The published closed form does clear the borrow at this level …
      assert.ok(v.lpNetPct !== null, `${where}: the cell must be priced`);
      assert.ok(v.lpNetPct! > BORROW, `${where}: closed form ${v.lpNetPct} should clear ${BORROW}`);
      // … so the OLD gate (`lpNet > borrow` alone) would have offered it.
      assert.ok(v.mcLpNetPct !== null, `${where}: the MC-calibrated number must be served alongside it`);

      if (v.mcLpNetPct! > BORROW) {
        assert.equal(v.qualifies, true, `${where}: both forms clear, so it is offerable`);
      } else {
        assert.equal(v.qualifies, false, `${where}: the MC says ${v.mcLpNetPct} ≤ ${BORROW} — must NOT be offered`);
        assert.equal(v.reason, "within_model_uncertainty", where);
        proven++;
      }
    }
  }
  // The audit found 7 of 8 such cells; at minimum the two it named by number
  // (aero-weth-cbbtc/steady at 11.86× and aero-cbbtc-usdc/working) must be here.
  assert.ok(proven >= 5, `only ${proven} cells demonstrated the guard biting`);
});

test("FIX D-HIGH-1: the named case, generalised — every PRICED steady cell at its published break-even multiple sits just above the borrow on the closed form and is refused when the Monte Carlo says otherwise (the audit named aero-weth-cbbtc/steady; on 2026-09-13 that cell is below the borrow before drag, so the guard is walked on whichever steady cells the model prices)", () => {
  const steady = Object.entries(MODEL.results).filter(([, cells]) => cells["steady"]?.lpNetPct !== null && cells["steady"]?.lpNetPct !== undefined);
  assert.ok(steady.length >= 1, "at least one priced steady cell");
  let bitten = 0;
  for (const [poolId, cells] of steady) {
    const cell = cells["steady"]!;
    const gross = cell.emissionsGrossPct! * cell.breakEvenEmissionsMultiple! * 1.0001;
    const v = evaluateGate(at(poolId, "steady", gross));
    assert.ok(v.lpNetPct! > BORROW && v.lpNetPct! < BORROW + 0.5, `${poolId}: served headline ${v.lpNetPct} sits on the closed form's boundary`);
    assert.ok(v.mcLpNetPct! < v.lpNetPct!, `${poolId}: the MC-calibrated number is the conservative one`);
    if (v.mcLpNetPct! > BORROW) {
      assert.equal(v.qualifies, true, `${poolId}: both forms clear — offered`);
    } else {
      assert.equal(v.qualifies, false, `${poolId}: the MC says ${v.mcLpNetPct} ≤ ${BORROW} — must NOT be offered`);
      assert.equal(v.reason, "within_model_uncertainty", poolId);
      // The whole point: a user would have been shown a positive number on a position the Monte Carlo
      // prices below the cost of the debt.
      assert.ok(v.userNet.every((u) => u.userNetPct >= 0), `${poolId}: the closed form's user-net ladder does read positive`);
      bitten++;
    }
  }
  assert.ok(bitten >= 1, "the guard bites on at least one steady cell at its own boundary");
});

test("FIX D-HIGH-1: the Aggressive cell the audit measured — the served closed form at +5 % is refused, and the optimism exceeds the borrow rate itself", () => {
  const guards = MODEL.boundaryGuard.filter((b) => b.setting === "working");
  assert.ok(guards.length >= 2);
  for (const g of guards) {
    // The sim's boundary table and the shipped gate must agree cell by cell.
    const v = evaluateGate(at(g.pool, g.setting, g.grossEmissionsAtBoundaryPct * 1.0001));
    assert.equal(v.qualifies, g.offeredByServedGate, `${g.pool}/${g.setting} verdict vs the sim's boundary table`);
    assert.ok(Math.abs(v.mcLpNetPct! - g.mcLpNetPct) < 0.05, `${g.pool}/${g.setting} mcLpNet ${v.mcLpNetPct} vs ${g.mcLpNetPct}`);
    assert.equal(g.offeredByClosedFormAlone, true, "the closed form alone would have offered every one of these");
  }
  // aero-weth-cbbtc/working: the audit measured +32 pt of optimism at 150 bps.
  const worst = MODEL.boundaryGuard.reduce((a, b) => (b.optimismPct > a.optimismPct ? b : a));
  assert.ok(worst.optimismPct > BORROW, `worst-case optimism ${worst.optimismPct} must exceed the ${BORROW}% it is compared against`);
  assert.equal(worst.offeredByServedGate, false);
});

test("FIX D-HIGH-1: the gate is NEVER more permissive than the MC-calibrated form, across the whole emissions range", () => {
  for (const poolId of ["aero-cbbtc-usdc", "aero-usdc-weth-5", "aero-weth-cbbtc"]) {
    for (const setting of SETTINGS) {
      for (let gross = 1; gross <= 900; gross *= 1.35) {
        const v = evaluateGate(at(poolId, setting.id, gross));
        if (v.qualifies) {
          assert.ok(v.mcLpNetPct !== null && v.mcLpNetPct > BORROW, `${poolId}/${setting.id}@${gross.toFixed(1)} offered on mcLpNet ${v.mcLpNetPct}`);
          assert.ok(v.lpNetPct! > BORROW);
        }
      }
    }
  }
});

test("FIX D-HIGH-1: fail closed — no calibration, a stale calibration or a widened preset refuses rather than falling back to the closed form", () => {
  const cell = MODEL.results["aero-cbbtc-usdc"]!["sheltered"]!;
  const clearing = cell.emissionsGrossPct! * cell.breakEvenEmissionsMultiple! * 1.2;
  // With a calibration this cell is offerable, so the refusals below are the
  // guard acting and not the cell failing on its own merits.
  assert.equal(evaluateGate(at("aero-cbbtc-usdc", "sheltered", clearing)).qualifies, true);

  const empty = evaluateGate(at("aero-cbbtc-usdc", "sheltered", clearing, { mcCalibration: new Map() }));
  assert.equal(empty.qualifies, false);
  assert.equal(empty.reason, "mc_calibration_unavailable");
  assert.equal(empty.mcLpNetPct, null);
  assert.ok(empty.lpNetPct! > BORROW, "the closed form still clears — the guard is what refuses");

  // A calibration taken at a CALMER σ than the live one understates both the
  // drag and the time out of range: refuse rather than extrapolate.
  const calm = new Map(MC);
  for (const [k, c] of calm) calm.set(k, { ...c, sigma: c.sigma / 2 });
  const stale = evaluateGate(at("aero-cbbtc-usdc", "sheltered", clearing, { mcCalibration: calm }));
  assert.equal(stale.qualifies, false);
  assert.equal(stale.reason, "mc_calibration_stale");

  // A calibration for another width is for another position entirely.
  const widened = new Map(MC);
  for (const [k, c] of widened) widened.set(k, { ...c, rangeWidthBps: c.rangeWidthBps + 1 });
  assert.equal(evaluateGate(at("aero-cbbtc-usdc", "sheltered", clearing, { mcCalibration: widened })).reason, "mc_calibration_stale");

  // A calibration at a STORMIER σ than live is conservative — accepted.
  const stormy = new Map(MC);
  for (const [k, c] of stormy) stormy.set(k, { ...c, sigma: c.sigma * 2 });
  assert.equal(evaluateGate(at("aero-cbbtc-usdc", "sheltered", clearing, { mcCalibration: stormy })).qualifies, true);
});

test("FIX D-HIGH-1: a pool fee above the calibrated one is charged as rebalance cost, never silently ignored", () => {
  const cal = MC.get(calibrationKey("aero-cbbtc-usdc", "working"))!;
  const net = 400 * keepFactor("SNUGGLEFI");
  const base = applyMcCalibration({
    index: MC, poolId: "aero-cbbtc-usdc", setting: "working",
    rangeWidthBps: cal.rangeWidthBps, sigma: cal.sigma, liveFeeBps: cal.feeBps, emissionsNetPct: net,
  });
  const dearer = applyMcCalibration({
    index: MC, poolId: "aero-cbbtc-usdc", setting: "working",
    rangeWidthBps: cal.rangeWidthBps, sigma: cal.sigma, liveFeeBps: cal.feeBps + 10, emissionsNetPct: net,
  });
  assert.ok(base.ok && dearer.ok);
  assert.equal(base.feeCorrectionPct, 0);
  // 10 bps more fee × ~388 re-centres/yr, half the position swapped each time
  const expected = (100 * cal.rebalancesPerYear * (10 / 10_000)) / 2;
  assert.ok(Math.abs(dearer.feeCorrectionPct - expected) < 1e-9);
  assert.ok(dearer.mcLpNetPct < base.mcLpNetPct, "a dearer pool must never price better");
  // A CHEAPER pool earns no credit — the calibration is then already conservative.
  const cheaper = applyMcCalibration({
    index: MC, poolId: "aero-cbbtc-usdc", setting: "working",
    rangeWidthBps: cal.rangeWidthBps, sigma: cal.sigma, liveFeeBps: 0, emissionsNetPct: net,
  });
  assert.ok(cheaper.ok && cheaper.mcLpNetPct === base.mcLpNetPct);
});

test("FIX D-HIGH-1: the calibration file is validated on load — a corrupt one throws instead of degrading to 'no calibration'", () => {
  const doc = loadMcCalibration(new URL("../../samples/mc-calibration.json", import.meta.url).pathname)!;
  assert.ok(doc.cells.length >= 9);
  for (const c of doc.cells) {
    assert.ok(c.inRangeEmissionsFactor >= 0 && c.inRangeEmissionsFactor <= 2, `${c.poolId}/${c.setting} factor`);
    assert.ok(c.mcDragPct <= 0, `${c.poolId}/${c.setting} drag must be a drag`);
    assert.ok(c.timeInRange > 0 && c.timeInRange <= 1);
    assert.equal(c.rangeWidthBps, settingWidthBps(settingById(c.setting), poolById(c.poolId)!.pairClass));
  }
  // every calibrated cell is reachable through the index the gate uses
  const idx = calibrationIndex(doc);
  assert.equal(idx.size, doc.cells.length);
  assert.equal(loadMcCalibration("/nonexistent/mc-calibration.json"), null);
});
