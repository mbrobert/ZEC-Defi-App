import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEES,
  BPS_DENOMINATOR,
  netOfPerformance,
  performanceFeeOn,
  feeBreakdown,
  performanceFeeAtomic,
  netAprAfterFees,
} from "../dist/index.js";

test("FEES is the single source and is within its own cap", () => {
  assert.deepEqual(FEES, { performanceBps: 1000, maxPerformanceBps: 2000, curatorBps: 1000, orchestrationBps: 0 });
  assert.ok(FEES.performanceBps <= FEES.maxPerformanceBps);
  assert.equal(BPS_DENOMINATOR, 10_000);
});

test("netOfPerformance / performanceFeeOn / netAprAfterFees", () => {
  assert.equal(netOfPerformance(100), 90);
  assert.equal(performanceFeeOn(100), 10);
  assert.equal(netOfPerformance(0), 0);
  assert.equal(netAprAfterFees(12.5), 11.25);
  assert.ok(Math.abs(netOfPerformance(33.3) + performanceFeeOn(33.3) - 33.3) < 1e-12);
});

test("feeBreakdown itemises gross → fee → net", () => {
  assert.deepEqual(feeBreakdown(250), { gross: 250, performanceBps: 1000, performanceFee: 25, net: 225 });
  const b = feeBreakdown(0.07);
  assert.ok(Math.abs(b.performanceFee + b.net - b.gross) < 1e-12);
});

test("performanceFeeAtomic mirrors on-chain floor arithmetic and rejects bps above the cap", () => {
  assert.equal(performanceFeeAtomic(1_000_000n), 100_000n);
  assert.equal(performanceFeeAtomic(9n), 0n); // floors like Solidity
  assert.equal(performanceFeeAtomic(1_000_000n, 2000), 200_000n);
  assert.equal(performanceFeeAtomic(1_000_000n, 0), 0n);
  assert.throws(() => performanceFeeAtomic(1n, 2001), RangeError);
  assert.throws(() => performanceFeeAtomic(1n, -1), RangeError);
  assert.throws(() => performanceFeeAtomic(1n, 10.5), RangeError);
});
