import { test } from "node:test";
import assert from "node:assert/strict";
import { HF_LADDER } from "@zyo/shared";
import { alertRungFor, bannerStateFor, shouldNotify } from "../lib/notify";

test("alertRungFor: healthy / no-debt / unreadable HF all mean no alert", () => {
  assert.equal(alertRungFor(2.0), null);
  assert.equal(alertRungFor(1.5), null); // warn fires strictly below 1.5
  assert.equal(alertRungFor(Number.POSITIVE_INFINITY), null); // Aave's no-debt sentinel
  assert.equal(alertRungFor(Number.NaN), null); // dashboard mid-load — never throw
  assert.equal(alertRungFor(-1), null);
  assert.equal(alertRungFor(null), null);
  assert.equal(alertRungFor(undefined), null);
});

test("alertRungFor: returns the same rung the keeper's ladder would fire, most severe crossed", () => {
  assert.equal(alertRungFor(1.49)?.id, "warn");
  assert.equal(alertRungFor(1.34)?.id, "repay");
  assert.equal(alertRungFor(1.19)?.id, "derisk");
  assert.equal(alertRungFor(1.04)?.id, "emergency");
});

test("alertRungFor never invents a threshold — it is exactly HF_LADDER from @zyo/shared", () => {
  for (const r of HF_LADDER) {
    assert.equal(alertRungFor(r.hf - 0.001)?.id, r.id);
  }
});

test("shouldNotify: fires once per distinct rung id, not on every poll of the same rung", () => {
  const warn = HF_LADDER.find((r) => r.id === "warn")!;
  const repay = HF_LADDER.find((r) => r.id === "repay")!;
  assert.equal(shouldNotify(warn, null), true);
  assert.equal(shouldNotify(warn, "warn"), false); // already notified for this rung
  assert.equal(shouldNotify(repay, "warn"), true); // worsened to a new rung
  assert.equal(shouldNotify(null, "warn"), false); // recovered — nothing to notify
});

test("N-MED-2: bannerStateFor — a failed read is an 'unreadable' alert, a rung is a rung, healthy is nothing", () => {
  assert.deepEqual(bannerStateFor(null), { kind: "unreadable" });
  assert.deepEqual(bannerStateFor(undefined), { kind: "unreadable" });
  assert.deepEqual(bannerStateFor(Number.NaN), { kind: "unreadable" });
  assert.equal(bannerStateFor(2.0), null);
  assert.equal(bannerStateFor(Number.POSITIVE_INFINITY), null, "no debt is healthy, not unreadable");
  const s = bannerStateFor(1.1);
  assert.equal(s?.kind, "rung");
  assert.equal(s?.kind === "rung" ? s.rung.id : null, "derisk");
});
