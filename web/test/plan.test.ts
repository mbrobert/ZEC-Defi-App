import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, toFunctionSelector, type Hex } from "viem";
import { PERMIT2, BASE_TOKENS } from "@zyo/shared";
import { ABI_STATUS, ACCOUNT_ABI, FACTORY_ABI, ROUTER_ABI, PERMIT2_ABI, AAVE_VENUE_ABI, LP_VENUE_ABI } from "../lib/abi/oilskin";
import {
  DEADLINE_MINUTES,
  DEMO_DEPLOYMENT,
  buildClaimPlan,
  buildOpenPlan,
  buildUnwindPlan,
  deadlineFromNow,
  encodeClaimWrite,
  encodeGrantWrite,
  encodeOpenWrite,
  encodeUnwindWrite,
  permitTypedData,
  planIsSignable,
  type Deployment,
  type OpenPlanInput,
} from "../lib/plan";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
const POOL = "0x0ea72f44ccaf524e3fda5e4a6682fda7a79e42dc2858ee27be311e9337aa72a8" as const;
const LIVE: Deployment = { ...DEMO_DEPLOYMENT, demo: false, keeper: "0x9999999999999999999999999999999999999999" };
const SIG = ("0x" + "ab".repeat(65)) as Hex;
const BAND = { minSqrtPriceX96: 1_000_000n, maxSqrtPriceX96: 1_020_000n };

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
  assert.equal(calls[2].toLabel, "Oilskin account factory");
  assert.ok(planIsSignable(calls));
});

test("open plan (existing account): exec on the account; hold = execBatch; no keeper step when off", () => {
  const lp = buildOpenPlan({ ...base, accountDeployed: true, keeperProtection: false });
  assert.deepEqual(
    lp.map((c) => c.kind),
    ["approve", "permit-signature", "open"],
  );
  assert.equal(lp[2].functionName, "exec");
  const hold = buildOpenPlan({ ...base, accountDeployed: true, strategy: "hold", enginePoolId: undefined, keeperProtection: false });
  assert.equal(hold[2].functionName, "execBatch");
  assert.ok(hold[2].plain.includes("keeps the USDC in your account"));
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
  assert.ok(w.data.startsWith(toFunctionSelector("createAccountAndExec((address,uint256,bytes)[])")));
  const outer = decodeFunctionData({ abi: FACTORY_ABI, data: w.data });
  const calls = outer.args[0] as { target: string; value: bigint; data: Hex }[];
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target, LIVE.router);
  assert.equal(calls[0].value, 0n);
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

test("encodeOpenWrite (existing account, lp): account.exec(router, 0, data)", () => {
  const w = encodeOpenWrite({ ...base, accountDeployed: true }, { nonce: 7n, deadline: 1_800_000_000n, signature: SIG }, BAND);
  assert.equal(w.address, ACCOUNT);
  assert.equal(w.functionName, "exec");
  const d = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data });
  assert.equal(d.args[0], LIVE.router);
  assert.equal(d.args[1], 0n);
  assert.equal(decodeFunctionData({ abi: ROUTER_ABI, data: d.args[2] as Hex }).functionName, "openLeveragedLp");
});

test("encodeOpenWrite (hold): execBatch of Permit2 pull → venue.supply → venue.borrow, spender/to = account", () => {
  const w = encodeOpenWrite({ ...base, accountDeployed: true, strategy: "hold", enginePoolId: undefined }, { nonce: 9n, deadline: 1_800_000_000n, signature: SIG }, BAND);
  assert.equal(w.functionName, "execBatch");
  const calls = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data }).args[0] as unknown as { target: string; data: Hex }[];
  assert.equal(calls.length, 3);
  assert.equal(calls[0].target, PERMIT2);
  const pull = decodeFunctionData({ abi: PERMIT2_ABI, data: calls[0].data });
  assert.equal(pull.functionName, "permitTransferFrom");
  const [permit, details, owner, sig] = pull.args as unknown as [Record<string, unknown>, Record<string, unknown>, string, Hex];
  assert.deepEqual(permit, { permitted: { token: BASE_TOKENS.cbBTC.address, amount: 50_000_000n }, nonce: 9n, deadline: 1_800_000_000n });
  assert.deepEqual(details, { to: ACCOUNT, requestedAmount: 50_000_000n });
  assert.equal(owner, OWNER);
  assert.equal(sig, SIG);
  assert.equal(calls[1].target, LIVE.aaveVenue);
  const supply = decodeFunctionData({ abi: AAVE_VENUE_ABI, data: calls[1].data });
  assert.equal(supply.functionName, "supply");
  assert.deepEqual(supply.args, [BASE_TOKENS.cbBTC.address, 50_000_000n]);
  const borrow = decodeFunctionData({ abi: AAVE_VENUE_ABI, data: calls[2].data });
  assert.equal(borrow.functionName, "borrow");
  assert.deepEqual(borrow.args, [BASE_TOKENS.USDC.address, 15_926_178_000n]);
});

test("encodeOpenWrite refuses without a live deployment or account", () => {
  assert.throws(() => encodeOpenWrite({ ...base, deployment: DEMO_DEPLOYMENT }, { nonce: 1n, deadline: 1n, signature: SIG }, BAND));
  assert.throws(() => encodeOpenWrite({ ...base, predictedAccount: null }, { nonce: 1n, deadline: 1n, signature: SIG }, BAND));
});

test("unwind: plan is only signable once minOut and tick spacing are quoted; encode = exec(router, unwind(u)) with max repay/withdraw", () => {
  const unquoted = buildUnwindPlan({ account: ACCOUNT, positionIds: [42n], collateral: "WETH", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, swapMinOut: 0n, tickSpacing: null, poolLabel: "WETH/USDC" });
  assert.equal(unquoted[0].encodable, false);
  assert.ok(unquoted[0].plain.includes("repays your Aave loan"));
  const quoted = { account: ACCOUNT, positionIds: [42n], collateral: "WETH" as const, deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100, swapMinOut: 1_000_000n, tickSpacing: 100 };
  assert.equal(buildUnwindPlan(quoted)[0].encodable, true);
  const w = encodeUnwindWrite(quoted, BAND);
  assert.equal(w.address, ACCOUNT);
  const d = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data });
  assert.equal(d.args[0], LIVE.router);
  const u = decodeFunctionData({ abi: ROUTER_ABI, data: d.args[2] as Hex });
  assert.equal(u.functionName, "unwind");
  const p = u.args[0] as Record<string, unknown>;
  assert.equal(p.collateralAsset, BASE_TOKENS.WETH.address);
  assert.deepEqual(p.positionIds, [42n]);
  assert.equal(p.swapMinOut, 1_000_000n);
  assert.equal(p.swapRouteData, "0x" + "0".repeat(62) + "64"); // abi.encode(int24 100)
  assert.equal(p.repayAmount, 2n ** 256n - 1n);
  assert.equal(p.withdrawAmount, 2n ** 256n - 1n);
});

test("claim: execBatch([lpVenue.claim(ids), router.sweep(tokens)])", () => {
  const input = { account: ACCOUNT, positionIds: [7n, 9n], sweepTokens: [{ symbol: "AERO", address: BASE_TOKENS.AERO.address }], deployment: LIVE, poolLabel: "WETH/USDC" };
  const plan = buildClaimPlan(input);
  assert.equal(plan[0].encodable, true);
  assert.ok(plan[0].plain.includes("performance fee"));
  const w = encodeClaimWrite(input);
  const calls = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data }).args[0] as unknown as { target: string; data: Hex }[];
  assert.equal(calls[0].target, LIVE.lpVenue);
  const claim = decodeFunctionData({ abi: LP_VENUE_ABI, data: calls[0].data });
  assert.equal(claim.functionName, "claim");
  assert.deepEqual(claim.args, [[7n, 9n]]);
  assert.equal(calls[1].target, LIVE.router);
  const sweep = decodeFunctionData({ abi: ROUTER_ABI, data: calls[1].data });
  assert.equal(sweep.functionName, "sweep");
  assert.deepEqual(sweep.args, [[BASE_TOKENS.AERO.address]]);
});

test("grant: account.grant(keeper, Permission{router, unwind selector, 0 ETH, token limits, 1-day period, 30-day expiry})", () => {
  const w = encodeGrantWrite({ account: ACCOUNT, deployment: LIVE, tokenLimits: [{ token: BASE_TOKENS.USDC.address, amountPerPeriod: 1_000n }], nowSeconds: 1_700_000_000 });
  assert.equal(w.address, ACCOUNT);
  const d = decodeFunctionData({ abi: ACCOUNT_ABI, data: w.data });
  assert.equal(d.functionName, "grant");
  assert.equal(d.args[0], LIVE.keeper);
  const perm = d.args[1] as Record<string, unknown>;
  assert.equal(perm.target, LIVE.router);
  assert.equal(perm.selector, "0xebf64f1c");
  assert.equal(perm.maxValuePerPeriod, 0n);
  assert.equal(perm.period, 86_400);
  assert.equal(perm.expiry, 1_700_000_000 + 30 * 86_400);
  assert.throws(() => encodeGrantWrite({ account: ACCOUNT, deployment: { ...LIVE, keeper: null }, tokenLimits: [], nowSeconds: 0 }));
});

test("deadlineFromNow is DEADLINE_MINUTES ahead, in seconds", () => {
  assert.equal(deadlineFromNow(1_700_000_000_000), 1_700_000_000 + DEADLINE_MINUTES * 60);
});
