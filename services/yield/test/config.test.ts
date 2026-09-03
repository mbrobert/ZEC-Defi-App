import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbsolute, join, resolve, sep } from "node:path";
import { loadConfig, packageRoot } from "../src/config.js";

test("Y-08: default dataDir is anchored on the @zyo/yield package root (same from src and dist)", () => {
  const root = packageRoot();
  assert.ok(root.endsWith(join("services", "yield")), `unexpected root ${root}`);
  const cfg = loadConfig({});
  assert.equal(cfg.dataDir, join(root, "data"));
  assert.ok(!cfg.dataDir.includes(`${sep}dist${sep}`)); // never inside the build output
});

test("Y-08: env-relative YIELD_DATA_DIR resolves against cwd; absolute passes through", () => {
  const rel = loadConfig({ YIELD_DATA_DIR: "some/rel/dir" });
  assert.equal(rel.dataDir, resolve(process.cwd(), "some/rel/dir"));
  assert.ok(isAbsolute(rel.dataDir));
  const abs = loadConfig({ YIELD_DATA_DIR: "/var/data/yield" });
  assert.equal(abs.dataDir, "/var/data/yield");
});

test("Y-14: ENGINE_VAULT_ADDRESS must be a 20-byte hex address (it becomes a filename + RPC filter)", () => {
  assert.throws(() => loadConfig({ ENGINE_VAULT_ADDRESS: "/../x" }), /ENGINE_VAULT_ADDRESS/);
  assert.throws(() => loadConfig({ ENGINE_VAULT_ADDRESS: "0x1234" }), /ENGINE_VAULT_ADDRESS/);
  const mixed = loadConfig({ ENGINE_VAULT_ADDRESS: "0x7D27CDFBFCC878F7E7349E216D44204BFD2AFD55" });
  assert.equal(mixed.engineVault, "0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55"); // lowercased
});

test("Y-14: YIELD_PORT is capped at 65535 (server.listen used to throw at runtime)", () => {
  assert.throws(() => loadConfig({ YIELD_PORT: "70000" }), /YIELD_PORT/);
  assert.equal(loadConfig({ YIELD_PORT: "65535" }).port, 65_535);
});

test("Y-12: empty/garbage YIELD_COHORT_WINDOWS is a config error, not Math.max() = -Infinity", () => {
  assert.throws(() => loadConfig({ YIELD_COHORT_WINDOWS: "," }), /YIELD_COHORT_WINDOWS/);
  assert.throws(() => loadConfig({ YIELD_COHORT_WINDOWS: "abc,-5" }), /YIELD_COHORT_WINDOWS/);
  assert.deepEqual(loadConfig({ YIELD_COHORT_WINDOWS: "7, 30" }).cohortWindows, [7, 30]);
});

test("Y-12: YIELD_START_BLOCK must be a non-negative integer when set", () => {
  assert.throws(() => loadConfig({ YIELD_START_BLOCK: "abc" }), /YIELD_START_BLOCK/);
  assert.throws(() => loadConfig({ YIELD_START_BLOCK: "-5" }), /YIELD_START_BLOCK/);
  assert.equal(loadConfig({ YIELD_START_BLOCK: "50530000" }).startBlock, 50_530_000);
  assert.equal(loadConfig({}).startBlock, undefined);
});
