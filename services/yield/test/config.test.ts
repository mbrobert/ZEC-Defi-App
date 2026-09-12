import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ENGINE_VAULT_DEFAULT, loadConfig, loadVolatility } from "../src/config.js";

test("loadConfig: defaults, numeric validation, no NEAR/Rhea knobs remain", () => {
  const c = loadConfig({});
  assert.equal(c.engineVault, ENGINE_VAULT_DEFAULT);
  assert.equal(c.port, 8787);
  assert.deepEqual(c.cohortWindows, [30, 60, 90]);
  assert.equal(c.staleAfterMs, 600_000);
  for (const k of Object.keys(c)) {
    assert.ok(!/near|rhea|oneclick|intents/i.test(k), `stale knob ${k}`);
  }
  assert.throws(() => loadConfig({ YIELD_PORT: "abc" }), /YIELD_PORT/);
  assert.throws(() => loadConfig({ YIELD_STALE_AFTER_MS: "1" }), /must be ≥/);
  assert.throws(() => loadConfig({ ENGINE_VAULT_ADDRESS: "nope" }), /not an address/);
  // A4.4: the registry is optional (nothing is deployed yet); when given it must be an address, and it is lower-cased.
  assert.equal(loadConfig({}).collateralRegistry, undefined);
  assert.equal(loadConfig({ COLLATERAL_REGISTRY_ADDRESS: "0x5555555555555555555555555555555555555555" }).collateralRegistry, "0x5555555555555555555555555555555555555555");
  assert.equal(loadConfig({ COLLATERAL_REGISTRY_ADDRESS: "0xABCDEF0000000000000000000000000000000001" }).collateralRegistry, "0xabcdef0000000000000000000000000000000001");
  assert.throws(() => loadConfig({ COLLATERAL_REGISTRY_ADDRESS: "nope" }), /COLLATERAL_REGISTRY_ADDRESS: not an address/);
  assert.equal(loadConfig({ YIELD_COHORT_WINDOWS: "7, 14,x" }).cohortWindows.join(","), "7,14");
});

test("loadVolatility: validates shape, σ range and provenance; a pool absent from the file has no σ", () => {
  const dir = mkdtempSync(join(tmpdir(), "yield-vol-"));
  try {
    const good = join(dir, "vol.json");
    writeFileSync(good, JSON.stringify({ asOf: "2026-08-31", method: "m", pools: { a: { sigma: 0.5, provenance: "x" } } }));
    const v = loadVolatility(good);
    assert.equal(v.pools.a!.sigma, 0.5);
    assert.equal(v.pools.b, undefined);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ asOf: "x", method: "m", pools: { a: { sigma: 0.5 } } }));
    assert.throws(() => loadVolatility(bad), /provenance required/);
    writeFileSync(bad, JSON.stringify({ asOf: "x", method: "m", pools: { a: { sigma: 0, provenance: "p" } } }));
    assert.throws(() => loadVolatility(bad), /sigma must be/);
    writeFileSync(bad, JSON.stringify({ asOf: "x", method: "m", pools: { a: { sigma: 7, provenance: "p" } } }));
    assert.throws(() => loadVolatility(bad), /sigma must be/);
    writeFileSync(bad, "[]");
    assert.throws(() => loadVolatility(bad), /unexpected shape/);
    assert.throws(() => loadVolatility(join(dir, "missing.json")), /not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped samples/volatility.json loads and carries provenance for every calibrated pool", () => {
  const v = loadVolatility(new URL("../../samples/volatility.json", import.meta.url).pathname);
  assert.ok(Object.keys(v.pools).length >= 3);
  for (const [id, e] of Object.entries(v.pools)) assert.ok(e.provenance.length > 20, id);
});
