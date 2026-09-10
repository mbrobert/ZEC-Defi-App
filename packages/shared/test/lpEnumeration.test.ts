import { test } from "node:test";
import assert from "node:assert/strict";
import { LP_ENUMERATION_FAULTS, LP_ENUMERATION_FAULT_TEXT, LP_ENUMERATION_ERRORS, describeLpEnumerationFault } from "../dist/index.js";

test("the fault list is the contract's enum, in order, each with a plain sentence", () => {
  assert.deepEqual([...LP_ENUMERATION_FAULTS], [
    "InsufficientGas",
    "ProbeOutOfGas",
    "CanaryAnswered",
    "TerminalShapeUnknown",
    "InconsistentEnd",
    "LivenessLost",
    "PositionUnreadable",
    "OwnerMismatch",
  ]);
  for (const f of LP_ENUMERATION_FAULTS) {
    assert.equal(typeof LP_ENUMERATION_FAULT_TEXT[f], "string");
    assert.doesNotMatch(LP_ENUMERATION_FAULT_TEXT[f], /[A-Z][a-z]+[A-Z]/, "plain words, no CamelCase codes in the sentence");
  }
  assert.deepEqual([...LP_ENUMERATION_ERRORS], ["EnumerationAmbiguous", "EnumerationFailed", "EngineUnreachable"]);
});

test("every EnumerationAmbiguous code is named, with its index, and never reads as an empty list", () => {
  LP_ENUMERATION_FAULTS.forEach((name, code) => {
    const s = describeLpEnumerationFault("EnumerationAmbiguous", [code, 3n, "0x"])!;
    assert.match(s, new RegExp(`\\(${name} at index 3\\)`));
    assert.match(s, /^LP positions unreadable:/);
    assert.match(s, /not a statement that the account holds no positions/);
    assert.doesNotMatch(s, /owns nothing|no positions under/i);
  });
  const canary = describeLpEnumerationFault("EnumerationAmbiguous", [1n, 2n ** 256n - 1n, "0x"])!;
  assert.match(canary, /ProbeOutOfGas at the canary index/);
});

test("an unknown code, EnumerationFailed and EngineUnreachable are still named; other errors are not ours", () => {
  assert.match(describeLpEnumerationFault("EnumerationAmbiguous", [99n, 0n, "0x"])!, /does not know \(code 99\)/);
  assert.match(describeLpEnumerationFault("EnumerationFailed", ["0x4e487b71"])!, /EnumerationFailed, data 0x4e487b71/);
  assert.match(describeLpEnumerationFault("EngineUnreachable", [])!, /EngineUnreachable/);
  assert.equal(describeLpEnumerationFault("PriceUnreadable", ["0x0000000000000000000000000000000000000001"]), null);
  assert.equal(describeLpEnumerationFault(undefined, undefined), null);
});
