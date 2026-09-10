import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LOAN_DUST_UNITS, isLoanDust, isLoanDustHuman, loanDustHuman } from "../dist/index.js";

test("LOAN_DUST_UNITS is in loan-token units, two orders above the measured 1-unit rounding, and the contracts carry the same number", () => {
  assert.equal(LOAN_DUST_UNITS, 100n);
  const sol = readFileSync(new URL("../../../contracts/src/libraries/LoanDust.sol", import.meta.url), "utf8");
  const m = sol.match(/uint256 internal constant UNITS = (\d+);/);
  assert.ok(m, "LoanDust.sol declares UNITS");
  assert.equal(BigInt(m![1]), LOAN_DUST_UNITS);
});

test("isLoanDust: 0, 1 (the measured residual) and 100 are dust; 101 and a negative are not", () => {
  assert.equal(isLoanDust(0n), true);
  assert.equal(isLoanDust(1n), true);
  assert.equal(isLoanDust(100n), true);
  assert.equal(isLoanDust(101n), false);
  assert.equal(isLoanDust(10_000_000_001n), false);
  assert.equal(isLoanDust(-1n), false);
});

test("human-unit form for USDC (6 dp): 0.0001 is the line; NaN is never dust", () => {
  assert.equal(loanDustHuman(6), 0.0001);
  assert.equal(isLoanDustHuman(0.000001, 6), true);
  assert.equal(isLoanDustHuman(0.0001, 6), true);
  assert.equal(isLoanDustHuman(0.000101, 6), false);
  assert.equal(isLoanDustHuman(10_000.000001, 6), false);
  assert.equal(isLoanDustHuman(Number.NaN, 6), false);
  assert.equal(isLoanDustHuman(-0.000001, 6), false);
});
