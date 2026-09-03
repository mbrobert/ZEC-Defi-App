import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

describe("agent config health thresholds (A-08)", () => {
  it("defaults satisfy warning > critical > emergency ≥ 1", () => {
    const c = loadConfig({});
    assert.ok(c.hfWarning > c.hfCritical);
    assert.ok(c.hfCritical > c.hfEmergency);
    assert.ok(c.hfEmergency >= 1);
    assert.equal(c.hfEmergency, 1.05);
  });

  it("HF_EMERGENCY is configurable", () => {
    const c = loadConfig({ HF_EMERGENCY: "1.1" });
    assert.equal(c.hfEmergency, 1.1);
  });

  it("REJECTS inverted rungs (critical above warning made EMERGENCY_UNWIND unreachable)", () => {
    assert.throws(() => loadConfig({ HF_WARNING: "1.2", HF_CRITICAL: "1.5" }), /warning > critical/);
  });

  it("REJECTS a critical rung at/below the emergency rung", () => {
    assert.throws(() => loadConfig({ HF_CRITICAL: "1.0" }), /warning > critical > emergency/);
    assert.throws(() => loadConfig({ HF_CRITICAL: "1.05" }), /warning > critical > emergency/);
  });

  it("REJECTS negative/sub-1 thresholds (everything read as HEALTHY before)", () => {
    assert.throws(() => loadConfig({ HF_WARNING: "-5", HF_CRITICAL: "-9" }), /emergency ≥ 1/);
    assert.throws(
      () => loadConfig({ HF_WARNING: "0.9", HF_CRITICAL: "0.5", HF_EMERGENCY: "0.1" }),
      /emergency ≥ 1/
    );
  });
});
