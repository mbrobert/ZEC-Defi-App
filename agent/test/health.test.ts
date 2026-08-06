import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessHealth } from "../src/engine/health.js";

const t = { warning: 1.5, critical: 1.2 };

describe("assessHealth", () => {
  it("healthy above warning", () => {
    assert.equal(assessHealth("s1", 2.0, t).band, "HEALTHY");
    assert.equal(assessHealth("s1", 1.51, t).band, "HEALTHY");
  });

  it("healthy when no debt (infinite HF)", () => {
    assert.equal(assessHealth("s1", Infinity, t).band, "HEALTHY");
  });

  it("warning band notifies", () => {
    const a = assessHealth("s1", 1.35, t);
    assert.equal(a.band, "WARNING");
    assert.equal(a.suggestedAction, "NOTIFY");
  });

  it("critical band deleverages", () => {
    const a = assessHealth("s1", 1.1, t);
    assert.equal(a.band, "CRITICAL");
    assert.equal(a.suggestedAction, "REDUCE_LEVERAGE");
  });

  it("near-liquidation unwinds", () => {
    const a = assessHealth("s1", 1.02, t);
    assert.equal(a.band, "CRITICAL");
    assert.equal(a.suggestedAction, "EMERGENCY_UNWIND");
  });

  it("boundaries: exactly warning → WARNING, exactly critical → CRITICAL", () => {
    assert.equal(assessHealth("s1", 1.5, t).band, "WARNING");
    assert.equal(assessHealth("s1", 1.2, t).band, "CRITICAL");
  });
});
