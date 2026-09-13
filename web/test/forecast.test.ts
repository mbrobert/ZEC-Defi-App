import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRY_HF_FLOOR } from "@zyo/shared";
import { DEMO_FORECAST_RAW, demoForecast } from "../lib/demo";
import {
  acknowledgmentText,
  bestPerPool,
  cellsFor,
  DISCLOSURE_TEXT,
  entryFromCell,
  findCell,
  forecastPath,
  KNOWN_REFUSALS,
  KNOWN_UNPRICED,
  normalizeForecast,
  refusalPlain,
  unpricedPlain,
  userNetAtLtv,
} from "../lib/forecast";

/** The service's unions (services/yield/src/types.ts) — pinned here so the words never lag the numbers. */
const SERVICE_REFUSALS = ["entry_hf_below_floor", "collateral_disabled", "rates_unavailable", "rates_stale", "collateral_not_active", "collateral_paused", "borrow_paused", "venue_ltv_exceeded", "pool_cannot_fund"];
const SERVICE_UNPRICED = ["rates_unavailable", "rates_stale", "emissions_unavailable", "emissions_stale", "no_emissions", "staked_liquidity_outlier", "insufficient_samples", "no_staked_liquidity", "emissions_implausible", "no_volatility_input", "net_out_of_bounds"];
const SERVICE_DISCLOSURES = ["forecast_not_advice", "model_uncertainty", "no_forecast", "emissions_dilutable", "borrow_rate_moves", "liquidation_at_chosen_hf", "impermanent_loss"];

test("demo forecast = evaluateForecast on the 2026-09-12 recording: 81 cells at the floor, 27 priced, 54 allowed, none beats the borrow on both models — and every number the wizard shows is there", () => {
  const f = demoForecast();
  assert.equal(f.source, "demo");
  assert.equal(f.entryHf, ENTRY_HF_FLOOR);
  assert.equal(f.entryHfFloor, ENTRY_HF_FLOOR);
  assert.equal(f.borrowAprPct, 4.5174);
  assert.equal(f.engineFeeBps, 1500);
  assert.equal(f.stale, false);
  assert.equal(f.cells.length, 81);
  assert.equal(f.cells.filter((c) => c.lpPriced).length, 27);
  assert.equal(f.cells.filter((c) => c.allowed).length, 54);
  assert.equal(f.cells.filter((c) => c.clearsBorrow.both === true).length, 0);
  const best = findCell(f, { poolId: "aero-cbbtc-usdc", setting: "sheltered", collateral: "cbBTC" })!;
  assert.equal(best.lpNetPct, -10.92);
  assert.equal(best.mcLpNetPct, -10.89);
  assert.equal(best.modelGapPts, -0.02, "lpNet − mcLpNet from the unrounded forms: −10.92 and −10.89 round from a 0.024-point gap");
  assert.equal(best.dragPct, -15.25);
  assert.equal(best.breakEvenEmissionsMultiple, 4.56);
  assert.equal(best.ltvAtEntryBps, 6240, "LT 78 % ÷ the pinned 1.25 floor");
  assert.equal(best.drawdownToLiquidationPct, 20);
  assert.equal(best.userNetBorrowBasis, "now");
  assert.equal(best.borrowAprAfterPct, null, "the recording has no deposit size, so no post-borrow rate");
  assert.equal(Math.round(best.poolAvailableUsd!), 24_768_504);
  assert.deepEqual(best.refusals, []);
  assert.ok(best.allowed);
  assert.deepEqual([...best.disclosures].sort(), ["borrow_rate_moves", "emissions_dilutable", "forecast_not_advice", "impermanent_loss", "liquidation_at_chosen_hf", "model_uncertainty"]);
  // The raw file is the same recording the service's own test pins.
  assert.equal((DEMO_FORECAST_RAW as { usdcReserveBlock: number }).usdcReserveBlock, 51_227_701);
});

test("user net at the chosen LTV is the identity supply + LTV × (lpNet − borrow), reproducing the model's ladder", () => {
  const f = demoForecast();
  const best = findCell(f, { poolId: "aero-cbbtc-usdc", setting: "sheltered", collateral: "cbBTC" })!;
  // MODEL-NUMBERS-2026-09-12: −4.62 / −6.16 / −9.62 at 30 / 40 / 62.4 % (the top at the pinned 1.25 floor).
  assert.equal(Math.round(userNetAtLtv(best, 3000)! * 100) / 100, -4.62);
  assert.equal(Math.round(userNetAtLtv(best, 4000)! * 100) / 100, -6.16);
  assert.equal(Math.round(userNetAtLtv(best, 6240)! * 100) / 100, -9.62);
  assert.equal(userNetAtLtv({ ...best, lpNetPct: null }, 4000), null);
  // An unpriced cell has no user net, and sorts last.
  const cells = cellsFor(f, "cbBTC", 4000);
  assert.equal(cells.length, 27);
  assert.equal(cells[0]!.poolId, "aero-cbbtc-usdc");
  assert.equal(cells[0]!.setting, "sheltered");
  assert.ok(cells.slice(-18).every((c) => !c.lpPriced), "the 6 σ-less pools × 3 settings come last");
  const perPool = bestPerPool(cells, 4000);
  assert.equal(perPool.length, 9);
  assert.equal(perPool[0]!.poolId, "aero-cbbtc-usdc");
  assert.ok(new Set(perPool.map((c) => c.poolId)).size === 9);
});

test("entryFromCell: the wizard's entry shape — qualifies means beats-the-borrow-on-both, reason names why not or why unpriced, the LTV ladder is re-priced", () => {
  const f = demoForecast();
  const best = findCell(f, { poolId: "aero-cbbtc-usdc", setting: "sheltered", collateral: "cbBTC" })!;
  const e = entryFromCell(best);
  assert.equal(e.qualifies, false);
  assert.equal(e.reason, "net_below_borrow");
  assert.equal(e.lpNetPct, -10.92);
  assert.equal(e.borrowAprPct, 4.5174);
  assert.deepEqual(e.userNet.map((u) => u.ltvBps), [3000, 4000, 6240], "the registry presets: 30 / 40 / top = LT ÷ 1.25");
  assert.equal(Math.round(e.userNet[1]!.userNetPct * 100) / 100, -6.16);
  const unpriced = findCell(f, { poolId: "aero-aero-weth", setting: "sheltered", collateral: "cbBTC" })!;
  assert.equal(unpriced.lpPriced, false);
  assert.equal(entryFromCell(unpriced).reason, unpriced.lpUnpricedReason);
  const clearing = entryFromCell({ ...best, clearsBorrow: { closedForm: true, monteCarlo: true, both: true } });
  assert.equal(clearing.qualifies, true);
  assert.equal(clearing.reason, null);
  const uncertain = entryFromCell({ ...best, clearsBorrow: { closedForm: true, monteCarlo: false, both: false } });
  assert.equal(uncertain.reason, "within_model_uncertainty");
  const stale = entryFromCell({ ...best, stale: true, clearsBorrow: { closedForm: true, monteCarlo: true, both: true } });
  assert.equal(stale.qualifies, false, "stale never qualifies");
});

test("the words cover the service's unions, none is a bare code, and the acknowledgment names the position's numbers", () => {
  assert.deepEqual([...KNOWN_REFUSALS].sort(), [...SERVICE_REFUSALS].sort());
  assert.deepEqual([...KNOWN_UNPRICED].sort(), [...SERVICE_UNPRICED].sort());
  assert.deepEqual(Object.keys(DISCLOSURE_TEXT).sort(), [...SERVICE_DISCLOSURES].sort());
  for (const r of SERVICE_REFUSALS) assert.ok(refusalPlain(r).length > 30 && !refusalPlain(r).includes("_"), r);
  for (const u of SERVICE_UNPRICED) assert.ok(unpricedPlain(u).length > 30 && !unpricedPlain(u).includes("_"), u);
  for (const d of Object.values(DISCLOSURE_TEXT)) assert.ok(d.length > 40 && !/\bguarantee|risk-free|no risk\b/i.test(d));
  assert.ok(refusalPlain("something_new").length > 30, "an unknown refusal still gets a sentence");
  const f = demoForecast();
  const best = findCell(f, { poolId: "aero-cbbtc-usdc", setting: "sheltered", collateral: "cbBTC" })!;
  const lp = acknowledgmentText({ strategy: "lp", collateral: "cbBTC", cell: best, borrowAprPct: 4.828, drawdownToLiquidationPct: 48.7 });
  assert.match(lp, /USDC\/cbBTC/);
  assert.match(lp, /−10\.92%/);
  assert.match(lp, /stricter model says −10\.89%/);
  assert.match(lp, /4\.83% a year today and that rate moves/);
  assert.match(lp, /48\.7% fall in cbBTC would liquidate/);
  assert.match(lp, /nothing here is advice or a promise/);
  assert.ok(!lp.includes("_"));
  const unpriced = findCell(f, { poolId: "aero-aero-weth", setting: "sheltered", collateral: "cbBTC" })!;
  assert.match(acknowledgmentText({ strategy: "lp", collateral: "cbBTC", cell: unpriced, borrowAprPct: 4.828, drawdownToLiquidationPct: 48.7 }), /could not price WETH\/AERO today, so I am opening it without a forecast/);
  const hold = acknowledgmentText({ strategy: "hold", collateral: "WETH", cell: null, borrowAprPct: 4.5174, drawdownToLiquidationPct: 51.8 });
  assert.match(hold, /4\.52% a year today/);
  assert.match(hold, /51\.8% fall in WETH/);
  assert.ok(!/forecast:/.test(hold));
});

test("normalizeForecast: unreadable cells are dropped, `allowed` is re-derived from the refusals and a stale payload allows nothing; the query path carries only what was given", () => {
  const raw = DEMO_FORECAST_RAW as { cells: unknown[] };
  const good = normalizeForecast(raw, "live");
  assert.equal(good.cells.length, 81);
  const withJunk = normalizeForecast({ ...raw, cells: [...raw.cells, { poolId: "nope" }, { poolId: "aero-cbbtc-usdc", setting: "sheltered", preset: "CONSERVATIVE", collateral: "cbBTC" }] }, "live");
  assert.equal(withJunk.cells.length, 81, "an unknown pool and a cell without its geometry are dropped");
  const flagLies = normalizeForecast({ ...raw, cells: raw.cells.map((c) => ({ ...(c as object), allowed: true, refusals: ["borrow_paused"] })) }, "live");
  assert.ok(flagLies.cells.every((c) => c.allowed === false), "the flag is never trusted over the list");
  const stale = normalizeForecast({ ...raw, stale: true }, "live");
  assert.ok(stale.stale && stale.cells.every((c) => !c.allowed && c.stale));
  assert.equal(forecastPath({}), "/v1/forecast");
  assert.equal(forecastPath({ collateral: "cbBTC", entryHf: 1.55, depositUsd: 39815.445 }), "/v1/forecast?collateral=cbBTC&entryHf=1.55&deposit=39815.445");
  assert.equal(forecastPath({ collateral: "WETH", depositUsd: 0, pool: "acbbtc", setting: "steady" }), "/v1/forecast?collateral=WETH&pool=acbbtc&setting=steady");
});
