/**
 * The committed cross-chain demo forecast (samples/demo-forecast-crosschain.json, mirrored into web/lib/solana) is
 * `evaluateForecast`'s own output with the borrow side read from the recorded Kamino capture through
 * `venueBorrowFromKamino` — the function the server runs on its live sample. Pinned the way demo-forecast.test.ts
 * pins the Base snapshot, so demo mode cannot show a loop number the live service would not.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CURATED_POOLS } from "@zyo/shared";
import { SETTINGS } from "../src/model.js";
import { venueBorrowFromKamino } from "../src/solanaBorrow.js";
import type { ForecastCell } from "../src/types.js";
import { kaminoSampleFixture } from "./fixtures/kamino.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEMO = JSON.parse(readFileSync(join(here, "../../samples/demo-forecast-crosschain.json"), "utf8")) as {
  asOf: string;
  entryHf: number;
  entryHfFloor: number;
  borrowAprPct: number;
  venueBorrow: { venue: string; borrowAprNowPct: number; liquidationThresholdBps: number; venueMaxLtvBps: number; refusals: string[] };
  cells: ForecastCell[];
};

test("the cross-chain snapshot is one cell per Aerodrome pool × setting, every one priced by Kamino's side", () => {
  const pools = CURATED_POOLS.filter((p) => p.dex === "AERODROME");
  assert.equal(DEMO.cells.length, pools.length * SETTINGS.length);
  // at the cap's HF, not the floor's: at 1.25 the LTV is 52 % against Kamino's 40 % and every cell is refused
  assert.equal(DEMO.entryHf, 1.625);
  assert.equal(DEMO.entryHfFloor, 1.25);
  assert.ok(DEMO.cells.some((c) => c.allowed && c.lpPriced), "a demo the wizard can choose from");
  assert.ok(DEMO.cells.every((c) => !c.refusals.includes("venue_ltv_exceeded")));
  for (const c of DEMO.cells) {
    assert.equal(c.entryHf, 1.625);
    assert.equal(c.ltvAtEntryBps, 4000);
    assert.equal(c.borrowVenue, "kamino", `${c.poolId}/${c.setting}`);
    assert.equal(c.liquidationThresholdBps, 6500, "ZEC's LT on the ZCASH market");
    assert.equal(c.venueMaxLtvBps, 4000, "Kamino's own cap");
    assert.equal(c.collateralSupplyAprPct, 0, "collateral-only reserve: deposited ZEC earns nothing");
    assert.equal(c.borrowAprNowPct, DEMO.borrowAprPct);
  }
});

test("Kamino's side of the snapshot is what venueBorrowFromKamino reads from the capture today", () => {
  const v = venueBorrowFromKamino({ ...kaminoSampleFixture(Date.parse(DEMO.asOf)), stale: false });
  assert.equal(v.venue, "kamino");
  assert.deepEqual(v.refusals, [], "the capture is a healthy market");
  assert.equal(v.borrowAprNowPct, DEMO.venueBorrow.borrowAprNowPct);
  assert.equal(v.liquidationThresholdBps, DEMO.venueBorrow.liquidationThresholdBps);
  assert.equal(v.venueMaxLtvBps, DEMO.venueBorrow.venueMaxLtvBps);
  assert.equal(DEMO.venueBorrow.refusals.length, 0);
  // a stale sample is carried as stale — the evaluator refuses it and derives nothing from it (FORECAST-LOW-1)
  assert.equal(venueBorrowFromKamino({ ...kaminoSampleFixture(Date.parse(DEMO.asOf)), stale: true }).stale, true);
});
