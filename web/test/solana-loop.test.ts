// The cross-chain loop's deploy decision (lib/solana/loop.ts): the query flag, the demo snapshot's shape, the reserve
// and crossing arithmetic, the acknowledgment's own sentence, and the crossing's listed steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { reserveFractionFor } from "@zyo/shared";
import { forecastPath } from "../lib/forecast";
import { crossingSteps, DEFAULT_LOOP_CHOICE, demoLoopForecast, LOOP_COLLATERAL_LABEL, loopAcknowledgment, loopCells, loopCellsPerPool, planLoop } from "../lib/solana/loop";
import { planSolanaOpen } from "../lib/solana/plan";
import { demoSolanaBorrow } from "../lib/solana/yield";

const view = demoSolanaBorrow();
const forecast = demoLoopForecast();

test("the forecast path carries crossChain=1 only when asked", () => {
  assert.equal(forecastPath({ collateral: LOOP_COLLATERAL_LABEL, entryHf: 1.625, crossChain: true }), "/v1/forecast?collateral=cbBTC&entryHf=1.625&crossChain=1");
  assert.equal(forecastPath({ collateral: LOOP_COLLATERAL_LABEL, crossChain: false }), "/v1/forecast?collateral=cbBTC");
});

test("the demo snapshot is every Aerodrome pool × setting priced by Kamino's side, labelled demo", () => {
  assert.equal(forecast.source, "demo");
  assert.equal(forecast.cells.length, 27);
  assert.ok(forecast.cells.every((c) => c.borrowVenue === "kamino" && c.liquidationThresholdBps === 6500 && c.venueMaxLtvBps === 4000));
  assert.ok(forecast.cells.some((c) => c.lpPriced), "some cells are priced");
  const all = loopCells(forecast, 4000);
  assert.equal(all.length, 27);
  const priced = all.filter((c) => c.lpPriced);
  assert.ok(priced.length > 0 && all.slice(0, priced.length).every((c) => c.lpPriced), "priced cells first, unpriced last");
  const perPool = loopCellsPerPool(forecast, 4000);
  assert.equal(new Set(perPool.map((c) => c.poolId)).size, perPool.length, "one cell per pool");
  assert.equal(perPool.length, 9);
});

test("keep: the reserve is named but nothing crosses; base: reserve + crossing = the borrow, to the cent", () => {
  const plan = planSolanaOpen({ collateralZec: 10, entryHf: 1.625, view })!;
  assert.ok(plan.borrowUsdc > 0);
  const keep = planLoop(plan, DEFAULT_LOOP_CHOICE, forecast);
  assert.equal(keep.kind, "keep");
  assert.equal(keep.crossUsdc, 0);
  assert.equal(keep.cell, null);
  assert.equal(keep.allowed, false);
  assert.ok(Math.abs(keep.reserveFraction - reserveFractionFor(1.625)) < 1e-12, "the rung-2 requirement");
  assert.ok(Math.abs(keep.reserveFraction - 0.0411) < 5e-4);
  assert.ok(keep.reserveUsdc >= plan.borrowUsdc * keep.reserveFraction, "rounded up, like the program");
  assert.ok(keep.reserveUsdc - plan.borrowUsdc * keep.reserveFraction < 0.01);
  const cell = loopCells(forecast, plan.ltvBps).find((c) => c.lpPriced && c.allowed)!;
  const base = planLoop(plan, { kind: "base", poolId: cell.poolId, setting: cell.setting }, forecast);
  assert.equal(base.kind, "base");
  assert.equal(base.cell, cell);
  assert.equal(base.allowed, true);
  assert.equal(Math.round((base.reserveUsdc + base.crossUsdc) * 100), Math.round(plan.borrowUsdc * 100));
  assert.equal(typeof base.userNetPct, "number");
  // an unknown cell is not a choice
  const unknown = planLoop(plan, { kind: "base", poolId: "nope", setting: "sheltered" }, forecast);
  assert.equal(unknown.kind, "keep");
  assert.equal(unknown.allowed, false);
});

test("no borrow, no loop: nothing crosses and no reserve is required", () => {
  const plan = planSolanaOpen({ collateralZec: 10, entryHf: Number.POSITIVE_INFINITY, view })!;
  assert.equal(plan.borrowUsdc, 0);
  const cell = forecast.cells.find((c) => c.lpPriced)!;
  const lp = planLoop(plan, { kind: "base", poolId: cell.poolId, setting: cell.setting }, forecast);
  assert.equal(lp.kind, "keep");
  assert.equal(lp.reserveUsdc, 0);
  assert.equal(lp.crossUsdc, 0);
});

test("the acknowledgment carries the Base wizard's sentence plus the reserve, the crossing and Circle; the steps are §14.6's four", () => {
  const plan = planSolanaOpen({ collateralZec: 10, entryHf: 1.625, view })!;
  const cell = loopCells(forecast, plan.ltvBps).find((c) => c.lpPriced && c.allowed)!;
  const lp = planLoop(plan, { kind: "base", poolId: cell.poolId, setting: cell.setting }, forecast);
  const ack = loopAcknowledgment(lp, plan, forecast);
  assert.match(ack, /I have read the forecast/);
  assert.match(ack, /stays on Solana as the reserve/);
  assert.match(ack, /through Circle/);
  assert.match(ack, /does not yet sign the crossing/);
  assert.equal(loopAcknowledgment(planLoop(plan, DEFAULT_LOOP_CHOICE, forecast), plan, forecast), "");
  const steps = crossingSteps(lp);
  assert.deepEqual(steps.map((s) => s.id), ["set_base_account", "deposit_for_burn", "receive_and_open", "cross_chain_grant"]);
  assert.match(steps[1]!.title, new RegExp(lp.crossUsdc.toFixed(2)));
  assert.equal(crossingSteps(planLoop(plan, DEFAULT_LOOP_CHOICE, forecast)).length, 0);
});
