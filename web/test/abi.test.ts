import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeFunctionData, toFunctionSelector, type AbiFunction, type Hex } from "viem";
import { BASE_TOKENS } from "@zyo/shared";
import {
  DEMO_DEPLOYMENT,
  UNWIND_SELECTOR,
  encodeClaimWrite,
  encodeGrantWrite,
  encodeOpenWrite,
  encodeRevokeAllWrite,
  encodeUnwindWrite,
  peripheralCall,
  plainCall,
  type Deployment,
  type OpenPlanInput,
} from "../lib/plan";
import {
  ABI_BUNDLE_SHA256,
  ABI_STATUS,
  ACCOUNT_ABI,
  AAVE_VENUE_ABI,
  COLLATERAL_REGISTRY_ABI,
  COLLATERAL_VENUE_ABI,
  FACTORY_ABI,
  DIRECT_LP_VENUE_ABI,
  LP_VENUE_ABI,
  POOL_SWAP_ADAPTER_ABI,
  PERMIT2_ABI,
  ROUTER_ABI,
  SELECTORS,
  SNUGGLE_VAULT_ABI,
  SWAP_ADAPTER_ABI,
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
  ICollateralVenue: COLLATERAL_VENUE_ABI,
  IPermit2: PERMIT2_ABI,
  AerodromeSwapAdapter: SWAP_ADAPTER_ABI,
  SlipstreamLpVenue: DIRECT_LP_VENUE_ABI,
  SlipstreamPoolSwapAdapter: POOL_SWAP_ADAPTER_ABI,
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

test("the selectors the web actually encodes are the artifact's, byte for byte", () => {
  assert.equal(SELECTORS.StrategyRouter["openLeveragedLp((address,uint256,(uint256,uint256,bytes),uint256,bytes32,uint24,uint64,bool,(uint160,uint160),uint256))"], "0x3c2639d6");
  assert.equal(SELECTORS.StrategyRouter["openBorrowOnly((address,uint256,(uint256,uint256,bytes),uint256,uint256))"], "0x16e05d79");
  assert.equal(SELECTORS.StrategyRouter["unwind((address,uint256[],(uint160,uint160),(uint256,uint256,uint16,bytes),uint256,uint256,uint256))"], "0x08435e75");
  assert.equal(SELECTORS.StrategyRouter["sweep(address[])"], "0x780469bb");
  assert.equal(SELECTORS.OilskinAccount["exec(address,uint256,bytes)"], "0x0565bb67");
  assert.equal(SELECTORS.OilskinAccount["execWithCallback(address,uint256,bytes)"], "0x0401f576");
  assert.equal(SELECTORS.OilskinAccount["execBatch((address,uint256,bytes,bool)[])"], "0xe82a13d1");
  assert.equal(SELECTORS.OilskinAccount["grant(address,(address,bytes4,uint256,(address,uint256)[],uint40,uint40,bool))"], "0x6429b6ce");
  assert.equal(SELECTORS.OilskinAccount["grantOf(address,address,bytes4)"], "0x6e58f6bc");
  assert.equal(SELECTORS.OilskinAccount["revokeAll()"], "0xa340fff4");
  assert.equal(SELECTORS.OilskinAccountFactory["createAccountAndExec((address,uint256,bytes,bool)[])"], "0xbc8b9a9f");
  assert.equal(SELECTORS.OilskinAccountFactory["accountOf(address)"], "0x8086b8ba");
  assert.equal(SELECTORS.SnuggleLpVenue["positionsOf(address)"], "0xf867d46b");
  assert.equal(SELECTORS.SnuggleLpVenue["claim(uint256[],(uint160,uint160),uint256)"], "0x388a2c47");
  assert.equal(SELECTORS.CollateralRegistry["pendingVenue(address)"], "0x5e043289");
  assert.equal(SELECTORS.AerodromeSwapAdapter["minOutFor(uint256,uint256,uint256,uint16)"], "0xea6f620b");
  assert.equal(SELECTORS.ISnuggleVault["userPositions(address,uint256)"], "0x5e1b4d99");
  assert.equal(SELECTORS.ISnuggleVault["positions(uint256)"], "0x99fbab88");
  assert.equal(SELECTORS.IPermit2["permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)"], "0x30f28b7a");
});

/**
 * The selector-drift test the audit asked for: build every write the product
 * can actually send and compare its FIRST FOUR BYTES with the compiled
 * artifact's own selector table — not with the generated TypeScript, and not
 * with anything typed in this file. If a struct is reshaped under us again,
 * this fails before a user is ever asked to sign it.
 */
test("every call the product builds starts with the selector the artifact bundle publishes", (t) => {
  if (!existsSync(BUNDLE)) {
    if (strict) assert.fail("contracts/abi/oilskin-abi.json missing (VERIFY_ABI_STRICT=1)");
    t.skip("artifact bundle not present in this checkout");
    return;
  }
  const bundle = JSON.parse(readFileSync(BUNDLE, "utf8")) as { contracts: Record<string, { functions: Record<string, { selector: string }> }> };
  const selectorOf = (contract: string, signature: string) => {
    const sel = bundle.contracts[contract]?.functions?.[signature]?.selector;
    assert.ok(sel, `${contract}.${signature} not in the artifact bundle`);
    return sel!;
  };

  const OWNER = "0x1111111111111111111111111111111111111111" as const;
  const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
  const LIVE: Deployment = { ...DEMO_DEPLOYMENT, demo: false, keeper: "0x9999999999999999999999999999999999999999" };
  const SIG = ("0x" + "ab".repeat(65)) as Hex;
  const BAND = { minSqrtPriceX96: 1_000_000n, maxSqrtPriceX96: 1_020_000n };
  const permit = { nonce: 7n, deadline: 1_800_000_000n, signature: SIG };
  const open: OpenPlanInput = {
    owner: OWNER,
    strategy: "lp",
    accountDeployed: true,
    predictedAccount: ACCOUNT,
    collateral: "cbBTC",
    collateralAmount: "0.5",
    borrowUsdc: 1000,
    enginePoolId: `0x${"1e".repeat(32)}`,
    lpParams: { rangeWidthBps: 1500, rebalanceDelayHours: 12, autoCompoundEnabled: true },
    deployment: LIVE,
    deadline: 1_800_000_000,
    bandToleranceBps: 100,
    keeperProtection: true,
  };
  const quote = {
    quotedIn: 10n ** 18n,
    quotedOut: 2_453_450_000n,
    maxSlippageBps: 100,
    routeData: "0x0000000000000000000000000000000000000000000000000000000000000064" as Hex,
    tokenSymbol: "WETH",
    tokenAddress: BASE_TOKENS.WETH.address,
    tokenDecimals: 18,
    tickSpacing: 100,
    source: "pool-spot" as const,
    crossCheckDelta: 0,
    minOutForQuotedIn: 2_428_915_500n,
  };

  const cases: { name: string; data: Hex; contract: string; signature: string }[] = [
    { name: "open lp, existing account", data: encodeOpenWrite(open, permit, BAND).data, contract: "OilskinAccount", signature: "execWithCallback(address,uint256,bytes)" },
    { name: "open lp, first time", data: encodeOpenWrite({ ...open, accountDeployed: false }, permit, BAND).data, contract: "OilskinAccountFactory", signature: "createAccountAndExec((address,uint256,bytes,bool)[])" },
    { name: "hold, existing account", data: encodeOpenWrite({ ...open, strategy: "hold", enginePoolId: undefined }, permit, BAND).data, contract: "OilskinAccount", signature: "execWithCallback(address,uint256,bytes)" },
    {
      name: "unwind",
      data: encodeUnwindWrite({ account: ACCOUNT, positionIds: [42n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote }, BAND).data,
      contract: "OilskinAccount",
      signature: "execWithCallback(address,uint256,bytes)",
    },
    {
      name: "claim",
      data: encodeClaimWrite({ account: ACCOUNT, positionIds: [7n], sweepTokens: [{ symbol: "AERO", address: BASE_TOKENS.AERO.address }], deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100 }, BAND).data,
      contract: "OilskinAccount",
      signature: "execBatch((address,uint256,bytes,bool)[])",
    },
    {
      name: "grant",
      data: encodeGrantWrite({ account: ACCOUNT, deployment: LIVE, tokenLimits: [{ token: BASE_TOKENS.USDC.address, amountPerPeriod: 1n }], nowSeconds: 1_700_000_000 }).data,
      contract: "OilskinAccount",
      signature: "grant(address,(address,bytes4,uint256,(address,uint256)[],uint40,uint40,bool))",
    },
    { name: "revokeAll", data: encodeRevokeAllWrite(ACCOUNT).data, contract: "OilskinAccount", signature: "revokeAll()" },
  ];
  for (const c of cases) assert.equal(c.data.slice(0, 10), selectorOf(c.contract, c.signature), `${c.name} outer selector`);

  // …and the INNER router / venue calldata, decoded out of the wrapper.
  const inner = (data: Hex) => (decodeFunctionData({ abi: ACCOUNT_ABI, data }).args[2] as Hex).slice(0, 10);
  assert.equal(
    inner(encodeOpenWrite(open, permit, BAND).data),
    selectorOf("StrategyRouter", "openLeveragedLp((address,uint256,(uint256,uint256,bytes),uint256,bytes32,uint24,uint64,bool,(uint160,uint160),uint256))"),
    "openLeveragedLp",
  );
  assert.equal(inner(encodeOpenWrite({ ...open, strategy: "hold", enginePoolId: undefined }, permit, BAND).data), selectorOf("StrategyRouter", "openBorrowOnly((address,uint256,(uint256,uint256,bytes),uint256,uint256))"), "openBorrowOnly");
  assert.equal(
    inner(encodeUnwindWrite({ account: ACCOUNT, positionIds: [42n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote }, BAND).data),
    selectorOf("StrategyRouter", "unwind((address,uint256[],(uint160,uint160),(uint256,uint256,uint16,bytes),uint256,uint256,uint256))"),
    "unwind",
  );
  const claimBatch = decodeFunctionData({
    abi: ACCOUNT_ABI,
    data: encodeClaimWrite({ account: ACCOUNT, positionIds: [7n], sweepTokens: [{ symbol: "AERO", address: BASE_TOKENS.AERO.address }], deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100 }, BAND).data,
  }).args[0] as unknown as { data: Hex; callback: boolean }[];
  assert.equal(claimBatch[0].data.slice(0, 10), selectorOf("SnuggleLpVenue", "claim(uint256[],(uint160,uint160),uint256)"), "claim");
  assert.equal(claimBatch[1].data.slice(0, 10), selectorOf("StrategyRouter", "sweep(address[])"), "sweep");

  // The grant's selector field IS the unwind selector — not a typed constant.
  assert.equal(UNWIND_SELECTOR, selectorOf("StrategyRouter", "unwind((address,uint256[],(uint160,uint160),(uint256,uint256,uint16,bytes),uint256,uint256,uint256))"));
  const perm = decodeFunctionData({ abi: ACCOUNT_ABI, data: encodeGrantWrite({ account: ACCOUNT, deployment: LIVE, tokenLimits: [{ token: BASE_TOKENS.USDC.address, amountPerPeriod: 1n }], nowSeconds: 0 }).data }).args[1] as Record<string, unknown>;
  assert.equal(perm.selector, UNWIND_SELECTOR);
});

/**
 * The peripheral opt-in (CONTRACT-ABI-DELTA §1): `callback` defaults FALSE and
 * is set ONLY for the router / venues, never for a token, a pool or Permit2.
 */
test("only the router and the venues are given peripheral rights; nothing else is", () => {
  const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
  const LIVE: Deployment = { ...DEMO_DEPLOYMENT, demo: false, keeper: "0x9999999999999999999999999999999999999999" };
  const BAND = { minSqrtPriceX96: 1_000_000n, maxSqrtPriceX96: 1_020_000n };
  assert.equal(plainCall(BASE_TOKENS.USDC.address, "0x1234").callback, false);
  assert.equal(peripheralCall(LIVE.router, "0x1234").callback, true);
  const claim = decodeFunctionData({
    abi: ACCOUNT_ABI,
    data: encodeClaimWrite({ account: ACCOUNT, positionIds: [7n], sweepTokens: [], deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100 }, BAND).data,
  }).args[0] as unknown as { target: string; callback: boolean }[];
  assert.deepEqual(
    claim.map((c) => [c.target, c.callback]),
    [
      [LIVE.lpVenue, true],
      [LIVE.router, true],
    ],
  );
});
