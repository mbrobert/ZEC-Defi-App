import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toFunctionSelector, type AbiFunction } from "viem";
import {
  ABI_BUNDLE_SHA256,
  ABI_STATUS,
  ACCOUNT_ABI,
  AAVE_VENUE_ABI,
  COLLATERAL_REGISTRY_ABI,
  FACTORY_ABI,
  LP_VENUE_ABI,
  PERMIT2_ABI,
  ROUTER_ABI,
  SELECTORS,
  SNUGGLE_VAULT_ABI,
} from "../lib/abi/oilskin";

/**
 * The ABI seam (AUDIT-FINDINGS Part 4): the web encodes only from the
 * generated file; this test re-reads the compiled artifact bundle and fails
 * on any drift. When the bundle is absent (contracts not built in this
 * checkout) it SKIPS loudly; VERIFY_ABI_STRICT=1 makes that fatal.
 */
const BUNDLE = join(__dirname, "../../contracts/abi/oilskin-abi.json");
const strict = process.env.VERIFY_ABI_STRICT === "1";

function canonicalType(p: { type: string; components?: unknown[] }): string {
  if (p.type.startsWith("tuple")) {
    const inner = `(${(p.components as { type: string; components?: unknown[] }[]).map(canonicalType).join(",")})`;
    return p.type.replace("tuple", inner);
  }
  return p.type;
}
const sig = (f: AbiFunction) => `${f.name}(${f.inputs.map((i) => canonicalType(i as never)).join(",")})`;

const OURS: Record<string, readonly unknown[]> = {
  OilskinAccountFactory: FACTORY_ABI,
  OilskinAccount: ACCOUNT_ABI,
  StrategyRouter: ROUTER_ABI,
  SnuggleLpVenue: LP_VENUE_ABI,
  ISnuggleVault: SNUGGLE_VAULT_ABI,
  AaveV3Venue: AAVE_VENUE_ABI,
  CollateralRegistry: COLLATERAL_REGISTRY_ABI,
  IPermit2: PERMIT2_ABI,
};

test("ABI_STATUS is verified and the generated file carries the bundle hash", () => {
  assert.equal(ABI_STATUS, "verified");
  assert.match(ABI_BUNDLE_SHA256, /^[0-9a-f]{64}$/);
});

test("every function the web encodes exists in the artifact bundle with an identical signature and selector", (t) => {
  if (!existsSync(BUNDLE)) {
    if (strict) assert.fail("contracts/abi/oilskin-abi.json missing (VERIFY_ABI_STRICT=1)");
    t.skip("contracts/abi/oilskin-abi.json not present in this checkout — run the contracts build, then scripts/sync-abi.mjs");
    return;
  }
  const raw = readFileSync(BUNDLE, "utf8");
  assert.equal(createHash("sha256").update(raw).digest("hex"), ABI_BUNDLE_SHA256, "generated file is stale — run node scripts/sync-abi.mjs");
  const bundle = JSON.parse(raw) as { contracts: Record<string, { abi: AbiFunction[]; functions: Record<string, { selector: string }> }> };
  let checks = 0;
  for (const [name, ours] of Object.entries(OURS)) {
    const theirs = bundle.contracts[name];
    assert.ok(theirs, `bundle lacks ${name}`);
    const theirSigs = new Map(theirs.abi.filter((x) => x.type === "function").map((x) => [sig(x), x]));
    for (const item of ours as AbiFunction[]) {
      if (item.type !== "function") continue;
      const s = sig(item);
      assert.ok(theirSigs.has(s), `${name}.${s} not in artifact`);
      const expected = theirs.functions[s]?.selector;
      assert.equal(toFunctionSelector(s), expected, `${name}.${s} selector`);
      assert.equal((SELECTORS as Record<string, Record<string, string>>)[name]?.[s], expected, `${name}.${s} pinned selector`);
      // output layout must match too (we decode returns)
      assert.deepEqual(item.outputs.map((o) => canonicalType(o as never)), theirSigs.get(s)!.outputs.map((o) => canonicalType(o as never)), `${name}.${s} outputs`);
      checks++;
    }
  }
  assert.ok(checks >= 50, `${checks} functions verified`);
});

test("the selectors CONTRACT-ABI.md documents for the calls we sign match the bundle", () => {
  assert.equal(SELECTORS.StrategyRouter["openLeveragedLp((address,uint256,(uint256,uint256,bytes),uint256,bytes32,uint24,uint64,bool,(uint160,uint160),uint256))"], "0x3c2639d6");
  assert.equal(SELECTORS.StrategyRouter["unwind((address,uint256[],(uint160,uint160),uint256,bytes,uint256,uint256,uint256))"], "0xebf64f1c");
  assert.equal(SELECTORS.OilskinAccount["exec(address,uint256,bytes)"], "0x0565bb67");
  assert.equal(SELECTORS.OilskinAccount["execBatch((address,uint256,bytes)[])"], "0x0b8707f6");
  assert.equal(SELECTORS.OilskinAccountFactory["createAccountAndExec((address,uint256,bytes)[])"], "0x2e154f02");
  assert.equal(SELECTORS.OilskinAccountFactory["accountOf(address)"], "0x8086b8ba");
  assert.equal(SELECTORS.SnuggleLpVenue["positionsOf(address)"], "0xf867d46b");
  assert.equal(SELECTORS.SnuggleLpVenue["claim(uint256[])"], "0x6ba4c138");
  assert.equal(SELECTORS.ISnuggleVault["userPositions(address,uint256)"], "0x5e1b4d99");
  assert.equal(SELECTORS.ISnuggleVault["positions(uint256)"], "0x99fbab88");
  assert.equal(SELECTORS.IPermit2["permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)"], "0x30f28b7a");
});
