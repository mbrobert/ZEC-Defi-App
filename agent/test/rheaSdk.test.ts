import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessHealth } from "../src/engine/health.js";
import { mapPortfolioToState } from "../src/services/rheaSdk.js";

const t = { warning: 1.5, critical: 1.2 };

/**
 * A-04: the SDK boundary must FAIL CLOSED. A portfolio with debt but a
 * missing/garbled/absurd healthFactor must reach assessHealth as NaN
 * (→ CRITICAL/NOTIFY), never as +Infinity (→ HEALTHY = protection off).
 */
describe("mapPortfolioToState health-factor boundary (A-04)", () => {
  it("debt + missing healthFactor field → NaN → CRITICAL/NOTIFY, not HEALTHY", () => {
    const st = mapPortfolioToState(
      "mca",
      { supplied: [], borrowed: [{ symbol: "USDC", balance: "5000000000" }] },
      {},
      {}
    );
    assert.ok(Number.isNaN(st.healthFactor));
    const a = assessHealth("s", st.healthFactor, t);
    assert.equal(a.band, "CRITICAL");
    assert.equal(a.suggestedAction, "NOTIFY");
  });

  it("debt + unparseable healthFactor ('n/a') → NaN → CRITICAL", () => {
    const st = mapPortfolioToState("mca", { healthFactor: "n/a", borrowed: [{ balance: "1" }] }, {}, {});
    assert.ok(Number.isNaN(st.healthFactor));
    assert.equal(assessHealth("s", st.healthFactor, t).band, "CRITICAL");
  });

  it("no debt + missing healthFactor → Infinity → HEALTHY (genuinely no borrow leg)", () => {
    const st = mapPortfolioToState("mca", { supplied: [], borrowed: [] }, {}, {});
    assert.equal(st.healthFactor, Infinity);
    assert.equal(assessHealth("s", st.healthFactor, t).band, "HEALTHY");
  });

  it("bounds check: bps-unit feeds (10500) and absurd magnitudes → NaN, never silently healthy", () => {
    const bps = mapPortfolioToState("mca", { healthFactor: 10500, borrowed: [{ balance: "1" }] }, {}, {});
    assert.ok(Number.isNaN(bps.healthFactor));
    const neg = mapPortfolioToState("mca", { healthFactor: -2, borrowed: [{ balance: "1" }] }, {}, {});
    assert.ok(Number.isNaN(neg.healthFactor));
    const zero = mapPortfolioToState("mca", { healthFactor: 0, borrowed: [{ balance: "1" }] }, {}, {});
    assert.ok(Number.isNaN(zero.healthFactor));
  });

  it("a plausible fraction-unit HF passes through (health_factor snake_case too)", () => {
    const st = mapPortfolioToState("mca", { health_factor: "1.42", borrowed: [{ balance: "1" }] }, {}, {});
    assert.equal(st.healthFactor, 1.42);
    assert.equal(assessHealth("s", st.healthFactor, t).band, "WARNING");
  });

  it("unparseable borrow amounts count as debt (fail closed)", () => {
    const st = mapPortfolioToState("mca", { borrowed: [{ balance: "wat" }] }, {}, {});
    assert.ok(Number.isNaN(st.healthFactor)); // hasDebt=true + no HF → NaN
  });
});
