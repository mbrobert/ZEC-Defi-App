import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, toFunctionSelector, type Hex } from "viem";
import { PERMIT2, BASE_TOKENS } from "@zyo/shared";
import { ABI_STATUS, ACCOUNT_ABI, FACTORY_ABI, ROUTER_ABI, LP_VENUE_ABI } from "../lib/abi/oilskin";
import {
  DEADLINE_MINUTES,
  DEMO_DEPLOYMENT,
  KEEPER_GRANT_EXPIRY_DAYS,
  MAX_SWAP_SLIPPAGE_BPS,
  UNWIND_SELECTOR,
  buildClaimPlan,
  buildOpenPlan,
  buildRevokeAllPlan,
  buildUnwindPlan,
  deadlineFromNow,
  encodeClaimWrite,
  encodeGrantWrite,
  encodeOpenWrite,
  encodeUnwindWrite,
  permitTypedData,
  planIsSignable,
  validateSwapQuote,
  type Deployment,
  type OpenPlanInput,
  type QuotedSwap,
} from "../lib/plan";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
const POOL = "0x0ea72f44ccaf524e3fda5e4a6682fda7a79e42dc2858ee27be311e9337aa72a8" as const;
const LIVE: Deployment = { ...DEMO_DEPLOYMENT, demo: false, keeper: "0x9999999999999999999999999999999999999999" };
const SIG = ("0x" + "ab".repeat(65)) as Hex;
const BAND = { minSqrtPriceX96: 1_000_000n, maxSqrtPriceX96: 1_020_000n };
const ROUTE_100 = ("0x" + "0".repeat(62) + "64") as Hex; // abi.encode(int24 100)
const QUOTE: QuotedSwap = {
  quotedIn: 10n ** 18n,
  quotedOut: 2_453_450_000n,
  maxSlippageBps: 100,
  routeData: ROUTE_100,
  tokenSymbol: "WETH",
  tokenAddress: BASE_TOKENS.WETH.address,
  tokenDecimals: 18,
  tickSpacing: 100,
  source: "pool-spot",
  crossCheckDelta: 0.001,
  minOutForQuotedIn: 2_428_915_500n,
};

const base: OpenPlanInput = {
  owner: OWNER,
  strategy: "lp",
  accountDeployed: false,
  predictedAccount: ACCOUNT,
  collateral: "cbBTC",
  collateralAmount: "0.5",
  borrowUsdc: 15926.178,
  enginePoolId: POOL,
  poolLabel: "WETH/USDC",
  lpParams: { rangeWidthBps: 1500, rebalanceDelayHours: 12, autoCompoundEnabled: true },
  deployment: LIVE,
  deadline: 1_800_000_000,
  bandToleranceBps: 100,
  keeperProtection: true,
};

test("ABI is verified (generated from the artifact bundle)", () => {
  assert.equal(ABI_STATUS, "verified");
});

test("open plan (first-time, lp): approve → permit signature → ONE createAccountAndExec → keeper grant", () => {
  const calls = buildOpenPlan(base);
  assert.deepEqual(
    calls.map((c) => c.kind),
    ["approve", "permit-signature", "open", "grant"],
  );
  assert.deepEqual(
    calls.map((c) => c.wallet),
    ["transaction", "signature", "transaction", "transaction"],
  );
  assert.ok(calls.every((c) => c.required));
  assert.equal(calls[2].functionName, "createAccountAndExec");
  assert.ok(calls[3].plain.includes(`${KEEPER_GRANT_EXPIRY_DAYS} days`), "the grant step states its expiry up front");
  assert.equal(calls[2].toLabel, "Oilskin account factory");
  assert.ok(planIsSignable(calls));
});

test("open plan (existing account): execWithCallback on the account; hold goes through openBorrowOnly; no keeper step when off", () => {
  const lp = buildOpenPlan({ ...base, accountDeployed: true, keeperProtection: false });
  assert.deepEqual(
    lp.map((c) => c.kind),
    ["approve", "permit-signature", "open"],
  );
  assert.equal(lp[2].functionName, "execWithCallback");
  const hold = buildOpenPlan({ ...base, accountDeployed: true, strategy: "hold", enginePoolId: undefined, keeperProtection: false });
  assert.equal(hold[2].functionName, "execWithCallback");
  assert.ok(hold[2].plain.includes("keeps the USDC in your account"));
  // The hold path is the ROUTER's, not a hand-built batch: the batch skipped the
  // entry health-factor floor and now reverts at the venue.
  assert.ok(hold[2].note.includes("openBorrowOnly"), hold[2].note);
  assert.ok(!hold[2].note.includes("execBatch"));
});

test("open plan: every step has a plain sentence, a labelled target, and no bare hex", () => {
  const calls = buildOpenPlan(base);
  for (const c of calls) {
    assert.ok(c.plain.length > 40 && /[.]$/.test(c.plain), `${c.kind} plain sentence`);
    assert.ok(c.toLabel && !/^0x[0-9a-f]{40}$/i.test(c.toLabel), `${c.kind} target labelled`);
    for (const a of c.args) {
      // any hex in an arg value must sit next to words (a label), never alone
      if (/0x[0-9a-fA-F]{8,}/.test(a.value)) assert.ok(/[A-Za-z]{3,}/.test(a.value.replace(/0x[0-9a-fA-F]+/g, "")), `${c.kind}.${a.name} hex is labelled: ${a.value}`);
    }
  }
});

test("open plan: approve is skipped when the Permit2 allowance already covers the amount; lp without a pool throws", () => {
  const enough = buildOpenPlan({ ...base, permit2Allowance: 60_000_000n });
  assert.equal(enough[0].kind, "approve");
  assert.equal(enough[0].required, false);
  assert.equal(buildOpenPlan({ ...base, permit2Allowance: 49_999_999n })[0].required, true);
  assert.throws(() => buildOpenPlan({ ...base, enginePoolId: undefined }), RangeError);
  assert.throws(() => buildOpenPlan({ ...base, lpParams: { rangeWidthBps: 100, rebalanceDelayHours: 1, autoCompoundEnabled: true } }), RangeError);
});

test("open plan is not signable without a live deployment (demo deployment / null)", () => {
  assert.equal(planIsSignable(buildOpenPlan({ ...base, deployment: DEMO_DEPLOYMENT })), false);
  assert.equal(planIsSignable(buildOpenPlan({ ...base, deployment: null })), false);
  assert.equal(planIsSignable(buildOpenPlan({ ...base, predictedAccount: null })), false);
});

test("permit typed data: spender is the ACCOUNT, domain is Permit2 on Base", () => {
  const td = permitTypedData(BASE_TOKENS.cbBTC.address, 50_000_000n, ACCOUNT, 7n, 1_800_000_000n);
  assert.equal(td.domain.verifyingContract, PERMIT2);
  assert.equal(td.domain.chainId, 8453);
  assert.equal(td.message.spender, ACCOUNT);
  assert.equal(td.message.permitted.amount, 50_000_000n);
  assert.equal(td.primaryType, "PermitTransferFrom");
});

test("encodeOpenWrite (first-time, lp): factory.createAccountAndExec([{router, 0, openLeveragedLp(p)}]) with the exact OpenParams", () => {
  const w = encodeOpenWrite(base, { nonce: 7n, deadline: 1_800_000_000n, signature: SIG }, BAND);
  assert.equal(w.address, LIVE.factory);
  assert.equal(w.functionName, "createAccountAndExec");
  assert.ok(w.data.startsWith(toFunctionSelector("createAccountAndExec((address,uint256,bytes,bool)[])")));
  const outer = decodeFunctionData({ abi: FACTORY_ABI, data: w.data });
  const calls = outer.args[0] as readonly { target: string; value: bigint; data: Hex; callback: boolean }[];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, LIVE.router);
  assert.equal(calls[0].value, 0n);
  assert.equal(calls[0].callback, true, "the router needs peripheral rights; nothing else in this batch would");
  const inner = decodeFunctionData({ abi: ROUTER_ABI, data: calls[0].data });
  assert.equal(inner.functionName, "openLeveragedLp");
  const p = inner.args[0] as Record<string, unknown>;
  assert.equal(p.collateralAsset, BASE_TOKENS.cbBTC.address);
  assert.equal(p.collateralAmount, 50_000_000n);
  assert.deepEqual(p.permit, { nonce: 7n, deadline: 1_800_000_000n, signature: SIG });
  assert.equal(p.borrowAmount, 15_926_178_000n);
  assert.equal(p.poolId, POOL);
  assert.equal(p.rangeWidthBps, 1500);
  assert.equal(p.rebalanceDelay, 43_200n);
  assert.equal(p.autoCompound, true);
  assert.deepEqual(p.band, { minSqrtPriceX96: 1_000_000n, maxSqrtPriceX96: 1_020_000n });
  assert.equal(p.deadline, 1_800_000_000n);
});

test("encodeOpenWrite (existing account, lp): account.execWithCallback(router, 0, data) — a plain exec would revert NotActivePeripheral", () => {
  const w = encodeOpenWrite({ ...base, accountDeployed: true }, { nonce: 7n, deadline: 1_800_000_000n, signature: SIG }, BAND);
  assert.equal(w.address, ACCOUNT);
  assert.equal(w.functionName, "execWithCallback");
  const d = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data });
  assert.equal(d.args[0], LIVE.router);
  assert.equal(d.args[1], 0n);
  assert.equal(decodeFunctionData({ abi: ROUTER_ABI, data: d.args[2] as Hex }).functionName, "openLeveragedLp");
});

test("encodeOpenWrite (hold): StrategyRouter.openBorrowOnly — NOT execBatch([permit2, supply, borrow])", () => {
  const w = encodeOpenWrite({ ...base, accountDeployed: true, strategy: "hold", enginePoolId: undefined }, { nonce: 9n, deadline: 1_800_000_000n, signature: SIG }, BAND);
  assert.equal(w.functionName, "execWithCallback");
  const d = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data });
  assert.equal(d.args[0], LIVE.router);
  const inner = decodeFunctionData({ abi: ROUTER_ABI, data: d.args[2] as Hex });
  assert.equal(inner.functionName, "openBorrowOnly");
  const p = inner.args[0] as Record<string, unknown>;
  assert.equal(p.collateralAsset, BASE_TOKENS.cbBTC.address);
  assert.equal(p.collateralAmount, 50_000_000n);
  assert.deepEqual(p.permit, { nonce: 9n, deadline: 1_800_000_000n, signature: SIG });
  assert.equal(p.borrowAmount, 15_926_178_000n);
  assert.equal(p.deadline, 1_800_000_000n);
});

test("the hold flow never builds the old three-call batch that skipped the entry floor", () => {
  for (const deployed of [true, false]) {
    const w = encodeOpenWrite({ ...base, accountDeployed: deployed, strategy: "hold", enginePoolId: undefined }, { nonce: 9n, deadline: 1_800_000_000n, signature: SIG }, BAND);
    const calls = deployed
      ? [{ target: (decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data }).args[0] as string), data: decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data }).args[2] as Hex, callback: true }]
      : (decodeFunctionData({ abi: FACTORY_ABI, data: w.data }).args[0] as readonly { target: string; data: Hex; callback: boolean }[]);
    assert.equal(calls.length, 1, "one router call, not three hand-built ones");
    assert.equal(calls[0].target, LIVE.router);
    assert.equal(calls[0].callback, true);
    assert.equal(decodeFunctionData({ abi: ROUTER_ABI, data: calls[0].data }).functionName, "openBorrowOnly");
  }
});

test("encodeOpenWrite refuses without a live deployment or account", () => {
  assert.throws(() => encodeOpenWrite({ ...base, deployment: DEMO_DEPLOYMENT }, { nonce: 1n, deadline: 1n, signature: SIG }, BAND));
  assert.throws(() => encodeOpenWrite({ ...base, predictedAccount: null }, { nonce: 1n, deadline: 1n, signature: SIG }, BAND));
});

test("unwind: not signable without a REAL quote; encode = execWithCallback(router, unwind(u)) carrying the SwapQuote", () => {
  const unquoted = buildUnwindPlan({ account: ACCOUNT, positionIds: [42n], collateral: "WETH", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: null, poolLabel: "WETH/USDC" });
  assert.equal(unquoted[0].encodable, false);
  assert.ok(unquoted[0].plain.includes("repays your Aave loan"));
  // NI-HIGH-1 (2026-09-12): the plain sentence says a leg too small for the floor to price is kept, and
  // the technical note names the event — copy that used to be silent about it.
  assert.ok(unquoted[0].plain.includes("stays in your account instead of failing the close"), unquoted[0].plain);
  assert.ok(unquoted[0].note?.includes("DustLegKept"), unquoted[0].note);
  const quoted = { account: ACCOUNT, positionIds: [42n], collateral: "WETH" as const, deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: QUOTE };
  const plan = buildUnwindPlan(quoted);
  assert.equal(plan[0].encodable, true);
  assert.equal(plan[0].functionName, "execWithCallback → StrategyRouter.unwind");
  // The floor is shown as a number, in USDC, before anything is signed.
  assert.ok(plan[0].args.some((a) => a.name === "swap quote" && /2428\.9/.test(a.value)), JSON.stringify(plan[0].args));

  const w = encodeUnwindWrite(quoted, BAND);
  assert.equal(w.address, ACCOUNT);
  assert.equal(w.functionName, "execWithCallback");
  const d = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data });
  assert.equal(d.args[0], LIVE.router);
  const u = decodeFunctionData({ abi: ROUTER_ABI, data: d.args[2] as Hex });
  assert.equal(u.functionName, "unwind");
  const p = u.args[0] as Record<string, unknown>;
  assert.equal(p.collateralAsset, BASE_TOKENS.WETH.address);
  assert.deepEqual(p.positionIds, [42n]);
  assert.deepEqual(p.swap, { quotedIn: 10n ** 18n, quotedOut: 2_453_450_000n, maxSlippageBps: 100, routeData: ROUTE_100 });
  assert.equal(p.repayAmount, 2n ** 256n - 1n);
  assert.equal(p.withdrawAmount, 2n ** 256n - 1n);
});

test("residual (b): a Close that would withdraw collateral is refused while a venue's price is disputed — not signable, says why, and encode throws by name", () => {
  const reason = "venue 0xdddd…dddd reports HF 2.50 but the prices this app reads imply at most 1.72 — its oracle values the collateral higher";
  const quoted = { account: ACCOUNT, positionIds: [42n], collateral: "WETH" as const, deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: QUOTE };
  const plan = buildUnwindPlan({ ...quoted, withdrawRefusedReason: reason });
  assert.equal(plan[0].encodable, false);
  assert.ok(plan[0].args.some((a) => a.name === "withdrawAmount" && a.value.startsWith("refused — ") && a.value.includes("imply at most 1.72")), JSON.stringify(plan[0].args));
  assert.throws(() => encodeUnwindWrite({ ...quoted, withdrawRefusedReason: reason }, BAND), /withdraw refused — venue 0xdddd/);
  // …and with no dispute the same plan is signable, as before.
  assert.equal(buildUnwindPlan({ ...quoted, withdrawRefusedReason: null })[0].encodable, true);
});

test("a swap quote that means 'accept anything' cannot be built or encoded", () => {
  const bad = { account: ACCOUNT, positionIds: [42n], collateral: "WETH" as const, deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100 };
  // quotedOut 0 / quotedIn 0 — the shapes the old `: 1n` fallback degraded into.
  for (const q of [
    { ...QUOTE, quotedOut: 0n },
    { ...QUOTE, quotedIn: 0n },
    { ...QUOTE, maxSlippageBps: MAX_SWAP_SLIPPAGE_BPS + 1 },
    { ...QUOTE, routeData: "0x" as Hex },
  ]) {
    assert.ok(validateSwapQuote(q).length > 0, `${q.quotedIn}/${q.quotedOut}/${q.maxSlippageBps}/${q.routeData}`);
    assert.equal(buildUnwindPlan({ ...bad, quote: q })[0].encodable, false);
    assert.throws(() => encodeUnwindWrite({ ...bad, quote: q }, BAND));
  }
  assert.throws(() => encodeUnwindWrite({ ...bad, quote: null }, BAND), /quoted/);
});

test("claim: execBatch([lpVenue.claim(ids, band, deadline), router.sweep(tokens)]) — both with peripheral rights", () => {
  const input = { account: ACCOUNT, positionIds: [7n, 9n], sweepTokens: [{ symbol: "AERO", address: BASE_TOKENS.AERO.address }], deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, poolLabel: "WETH/USDC" };
  const plan = buildClaimPlan(input);
  assert.equal(plan[0].encodable, true);
  assert.ok(plan[0].plain.includes("performance fee"));
  const w = encodeClaimWrite(input, BAND);
  const calls = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data }).args[0] as unknown as { target: string; data: Hex; callback: boolean }[];
  assert.equal(calls[0].target, LIVE.lpVenue);
  assert.equal(calls[0].callback, true);
  const claim = decodeFunctionData({ abi: LP_VENUE_ABI, data: calls[0].data });
  assert.equal(claim.functionName, "claim");
  assert.deepEqual(claim.args, [[7n, 9n], BAND, 1_800_000_000n]);
  assert.equal(calls[1].target, LIVE.router);
  assert.equal(calls[1].callback, true);
  const sweep = decodeFunctionData({ abi: ROUTER_ABI, data: calls[1].data });
  assert.equal(sweep.functionName, "sweep");
  assert.deepEqual(sweep.args, [[BASE_TOKENS.AERO.address]]);
});

test("grant: account.grant(keeper, Permission{router, unwind selector, 0 ETH, token limits, 1-day period, 30-day expiry, allowCallback TRUE})", () => {
  const w = encodeGrantWrite({ account: ACCOUNT, deployment: LIVE, tokenLimits: [{ token: BASE_TOKENS.USDC.address, amountPerPeriod: 1_000n }], nowSeconds: 1_700_000_000 });
  assert.equal(w.address, ACCOUNT);
  const d = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data });
  assert.equal(d.functionName, "grant");
  assert.equal(d.args[0], LIVE.keeper);
  const perm = d.args[1] as Record<string, unknown>;
  assert.equal(perm.target, LIVE.router);
  assert.equal(perm.selector, UNWIND_SELECTOR);
  assert.equal(perm.maxValuePerPeriod, 0n);
  assert.equal(perm.period, 86_400);
  assert.equal(perm.expiry, 1_700_000_000 + KEEPER_GRANT_EXPIRY_DAYS * 86_400);
  // Without this the keeper's dispatch reverts NotActivePeripheral inside the
  // router and NOTHING is broadcast while the position rides to liquidation.
  assert.equal(perm.allowCallback, true);
  assert.throws(() => encodeGrantWrite({ account: ACCOUNT, deployment: { ...LIVE, keeper: null }, tokenLimits: [], nowSeconds: 0 }));
});

test("grant refuses the token-limit shapes the chain refuses (zero line, duplicate)", () => {
  assert.throws(
    () => encodeGrantWrite({ account: ACCOUNT, deployment: LIVE, tokenLimits: [{ token: BASE_TOKENS.USDC.address, amountPerPeriod: 0n }], nowSeconds: 0 }),
    /zero/,
  );
  assert.throws(
    () =>
      encodeGrantWrite({
        account: ACCOUNT,
        deployment: LIVE,
        tokenLimits: [
          { token: BASE_TOKENS.USDC.address, amountPerPeriod: 1n },
          { token: BASE_TOKENS.USDC.address, amountPerPeriod: 2n },
        ],
        nowSeconds: 0,
      }),
    /duplicate/,
  );
});

test("revokeAll is a planned call with its own plain sentence and says what stops", () => {
  const [c] = buildRevokeAllPlan({ account: ACCOUNT, deployment: LIVE });
  assert.equal(c.kind, "revoke");
  assert.equal(c.functionName, "revokeAll");
  assert.ok(c.plain.length > 40);
  assert.ok(c.args.some((a) => /nobody acts but you/.test(a.value)));
  assert.equal(buildRevokeAllPlan({ account: ACCOUNT, deployment: DEMO_DEPLOYMENT })[0].encodable, false);
});

test("deadlineFromNow is DEADLINE_MINUTES ahead, in seconds", () => {
  assert.equal(deadlineFromNow(1_700_000_000_000), 1_700_000_000 + DEADLINE_MINUTES * 60);
});

// ---------------------------------------------------------------------------------------------
// Slice F (2026-09-11): the two-book Close in one transaction, and the direct Slipstream venue.
// ---------------------------------------------------------------------------------------------
test("Close on an account whose collateral sits in two places says so, and says the one transaction returns it from both (RISKS §8 option 1)", () => {
  const one = buildUnwindPlan({ account: ACCOUNT, positionIds: [42n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: QUOTE, collateralPlaces: 1 });
  assert.doesNotMatch(one[0].plain, /places/);
  const two = buildUnwindPlan({ account: ACCOUNT, positionIds: [42n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: QUOTE, collateralPlaces: 2 });
  assert.match(two[0].plain, /sits in 2 places/);
  assert.match(two[0].plain, /returns it from every one of them/);
  assert.match(two[0].plain, /nothing is left behind for a second signature/);
  const withdraw = two[0].args.find((a) => a.name === "withdrawAmount")!;
  assert.match(withdraw.value, /every one of the 2 venues holding it/);
  assert.match(two[0].note, /withdraw from EVERY venue holding your collateral/);
  assert.match(two[0].note, /one VenueWithdrawn per venue/);
  // The encoding is unchanged: one unwind(ids, repay max, withdraw max) — the router iterates.
  const w = encodeUnwindWrite({ account: ACCOUNT, positionIds: [42n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: QUOTE, collateralPlaces: 2 }, BAND);
  const d = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data });
  const u = decodeFunctionData({ abi: ROUTER_ABI, data: d.args[2] as Hex });
  assert.equal(u.functionName, "unwind");
  assert.equal((u.args[0] as Record<string, unknown>).withdrawAmount, 2n ** 256n - 1n);
});

test("a Close on a direct Slipstream position names the venue and the pool-direct swap; the router call is the same unwind", () => {
  const plan = buildUnwindPlan({ account: ACCOUNT, positionIds: [7n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: QUOTE, positionVenue: "direct", poolLabel: "USDC/cbZEC" });
  assert.ok(plan[0].args.some((a) => a.name === "positions" && a.value === "Slipstream position #7"));
  assert.ok(plan[0].args.some((a) => a.name === "swap route" && /pool's own swap/.test(a.value)));
  assert.match(plan[0].note, /SlipstreamLpVenue/);
  assert.match(plan[0].note, /SlipstreamPoolSwapAdapter/);
  assert.equal(plan[0].functionName, "execWithCallback → StrategyRouter.unwind");
});

test("a claim on a direct position targets the direct venue, not the engine's; a deployment without one is not signable and encode throws by name", () => {
  const DIRECT = "0x1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d" as const;
  const live = { ...LIVE, lpVenueDirect: DIRECT };
  const input = { account: ACCOUNT, positionIds: [7n], sweepTokens: [{ symbol: "AERO", address: BASE_TOKENS.AERO.address }], deployment: live, deadline: 1_800_000_000, bandToleranceBps: 100, venue: "direct" as const };
  const plan = buildClaimPlan(input);
  assert.equal(plan[0].encodable, true);
  assert.equal(plan[0].functionName, "execBatch → SlipstreamLpVenue.claim, StrategyRouter.sweep");
  assert.ok(plan[0].args.some((a) => a.name === "band" && /swaps nothing/.test(a.value)));
  const w = encodeClaimWrite(input, BAND);
  const d = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data });
  const calls = d.args[0] as unknown as readonly { target: string; callback: boolean }[];
  assert.equal(calls[0].target.toLowerCase(), DIRECT);
  assert.equal(calls[0].callback, true);
  assert.equal(calls[1].target, live.router);
  // The engine claim still targets the engine venue.
  const engine = encodeClaimWrite({ ...input, venue: "engine" }, BAND);
  const e = decodeFunctionData({ abi: ACCOUNT_ABI, data: engine.data });
  assert.equal((e.args[0] as unknown as readonly { target: string }[])[0].target, live.lpVenue);
  // No direct venue on the deployment: not signable, and the encoder refuses by name.
  const none = buildClaimPlan({ ...input, deployment: LIVE });
  assert.equal(none[0].encodable, false);
  assert.throws(() => encodeClaimWrite({ ...input, deployment: LIVE }, BAND), /no direct Slipstream venue/);
});

test("an open on a direct pool says the position is held directly, part-swapped through the pool, centred and staked — and encodes the padded pool address as the pool id", () => {
  const poolId = "0x0000000000000000000000000fc47c17af86078d809358db1b4db2debc988566" as const;
  const calls = buildOpenPlan({ ...base, strategy: "lp", enginePoolId: poolId, poolVenue: "direct", poolLabel: "USDC/cbZEC" });
  const open = calls.find((c) => c.kind === "open")!;
  assert.ok(open.args.some((a) => a.name === "poolId" && /held directly on Aerodrome Slipstream/.test(a.value) && /staked in the pool's gauge/.test(a.value)));
  assert.match(open.note, /SlipstreamLpVenue\.open/);
  // An existing account: execWithCallback(router, 0, openLeveragedLp(...)).
  const w = encodeOpenWrite({ ...base, accountDeployed: true, keeperProtection: false, strategy: "lp", enginePoolId: poolId, poolVenue: "direct" }, { nonce: 1n, deadline: 1n, signature: SIG }, BAND);
  const d = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data });
  assert.equal(d.functionName, "execWithCallback");
  const inner = decodeFunctionData({ abi: ROUTER_ABI, data: (d.args as unknown as [unknown, unknown, Hex])[2] });
  assert.equal(inner.functionName, "openLeveragedLp");
  assert.equal((inner.args[0] as Record<string, unknown>).poolId, poolId);
});

// W3-LOW-4 (wave 3): the Close plan says when no oracle cross-check was possible for the leg.
test("W3-LOW-4: a quote with an oracle cross-check says how close; a quote without one says Aave has no price for the token", () => {
  const checked = buildUnwindPlan({ account: ACCOUNT, positionIds: [42n], collateral: "WETH", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: QUOTE });
  const withCheck = checked[0].args.find((a) => a.name === "swap quote")!.value;
  assert.match(withCheck, /within 0\.10% of the Chainlink price Aave uses/);
  assert.doesNotMatch(withCheck, /no oracle cross-check/);
  const cbzec: QuotedSwap = { ...QUOTE, tokenSymbol: "cbZEC", tokenAddress: BASE_TOKENS.cbZEC.address, tokenDecimals: 8, tickSpacing: 200, quotedIn: 10n ** 8n, quotedOut: 1_075_500_000n, minOutForQuotedIn: 1_064_745_000n, crossCheckDelta: null };
  const unchecked = buildUnwindPlan({ account: ACCOUNT, positionIds: [7n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: cbzec, positionVenue: "direct" });
  const noCheck = unchecked[0].args.find((a) => a.name === "swap quote")!.value;
  assert.match(noCheck, /no oracle cross-check was possible: Aave has no price for cbZEC/);
  assert.match(noCheck, /the pool's own price is the only one this quote rests on/);
  assert.equal(unchecked[0].encodable, true, "still signable: the floor binds, the wording is honest");
});

// W3-LOW-5 (wave 3): the Close plan states the gauge's early-withdraw penalty while its window is open.
test("W3-LOW-5: a Close inside the gauge's penalty window says what is forfeited and until when; none outside it", () => {
  const cbzec: QuotedSwap = { ...QUOTE, tokenSymbol: "cbZEC", tokenAddress: BASE_TOKENS.cbZEC.address, tokenDecimals: 8, tickSpacing: 200, quotedIn: 10n ** 8n, quotedOut: 1_075_500_000n, minOutForQuotedIn: 1_064_745_000n, crossCheckDelta: null };
  const inside = buildUnwindPlan({ account: ACCOUNT, positionIds: [7n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: cbzec, positionVenue: "direct", earlyPenalty: { bps: 10_000, until: "2026-09-11T20:00:10.000Z" } });
  assert.match(inside[0].plain, /forfeits ALL of the AERO this position has earned so far to the gauge's minter/);
  assert.match(inside[0].plain, /Closing before 2026-09-11 20:00:10 UTC/);
  assert.match(inside[0].plain, /your USDC and cbZEC come back in full either way/);
  assert.equal(inside[0].encodable, true, "stated, not blocked");
  const partial = buildUnwindPlan({ account: ACCOUNT, positionIds: [7n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: cbzec, positionVenue: "direct", earlyPenalty: { bps: 2_500, until: "2026-09-11T20:00:10.000Z" } });
  assert.match(partial[0].plain, /forfeits 25\.00% of the AERO/);
  const outside = buildUnwindPlan({ account: ACCOUNT, positionIds: [7n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, quote: cbzec, positionVenue: "direct", earlyPenalty: null });
  assert.doesNotMatch(outside[0].plain, /forfeits/);
});
