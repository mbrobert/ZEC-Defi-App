import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { BASE_TOKENS, CHAIN_ID, PERMIT2 } from "@zyo/shared";
import { grantTokenLimits, runClaim, runOpen, runUnwind, type RunContext, type StepEvent } from "../lib/execute";
import { buildOpenPlan, DEMO_DEPLOYMENT, type Deployment, type OpenPlanInput } from "../lib/plan";
import { assessGas, estimateForWrite } from "../lib/gas";
import { bandFromSqrtPrice, isInRange, isqrt, token1ShareOfValue, usdcShareOfValue } from "../lib/tickmath";
import { clearInflight, isInterrupted, loadInflight, nextPendingStep, saveInflight, type InflightFlow } from "../lib/inflight";
import { recommend } from "../lib/recommend";
import { demoGate } from "../lib/demo";
import type { WriteSpec } from "../lib/plan";

const OWNER = "0x1111111111111111111111111111111111111111" as const;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as const;
const LIVE: Deployment = { ...DEMO_DEPLOYMENT, demo: false, keeper: "0x9999999999999999999999999999999999999999" };
const SIG = ("0x" + "cd".repeat(65)) as Hex;
const HASH = ("0x" + "11".repeat(32)) as Hex;

const openInput: OpenPlanInput = {
  owner: OWNER,
  strategy: "lp",
  accountDeployed: false,
  predictedAccount: ACCOUNT,
  collateral: "cbBTC",
  collateralAmount: "0.5",
  borrowUsdc: 15926.178,
  enginePoolId: "0x0ea72f44ccaf524e3fda5e4a6682fda7a79e42dc2858ee27be311e9337aa72a8",
  poolLabel: "WETH/USDC",
  lpParams: { rangeWidthBps: 1500, rebalanceDelayHours: 12, autoCompoundEnabled: true },
  deployment: LIVE,
  deadline: 1_800_000_000,
  bandToleranceBps: 100,
  keeperProtection: true,
};

function fakeCtx(over: Partial<{ chainId: number; balance: bigint; estimateThrows: string; sqrtP: bigint; receipt: "success" | "reverted" }> = {}) {
  const writes: WriteSpec[] = [];
  const signed: unknown[] = [];
  const ctx: RunContext = {
    wallet: {
      chainId: over.chainId ?? CHAIN_ID,
      writeContract: async (spec) => {
        writes.push(spec);
        return HASH;
      },
      signTypedData: async (td) => {
        signed.push(td);
        return SIG;
      },
      waitForReceipt: async () => ({ status: over.receipt ?? "success" }),
    },
    read: {
      multicall: async () => [],
      readContract: async (a) => {
        if (a.functionName === "poolSqrtPriceX96") return over.sqrtP ?? 3_897_149_340_279_738_881_397_267n;
        if (a.functionName === "slot0") return [0n, -198_407, 0, 0, 0, 0, true];
        if (a.functionName === "tickSpacing") return 100;
        throw new Error(`unexpected read ${a.functionName}`);
      },
      getCode: async () => "0x6080",
    },
    gas: {
      estimateGas: async () => {
        if (over.estimateThrows) throw new Error(over.estimateThrows);
        return 500_000n;
      },
      getGasPrice: async () => 10_000_000n, // 0.01 gwei
      getBalance: async () => over.balance ?? 10n ** 16n, // 0.01 ETH
    },
    owner: OWNER,
    ethPriceUsd: 2453.45,
    nowSeconds: () => 1_700_000_000,
  };
  return { ctx, writes, signed };
}

const collect = () => {
  const events: StepEvent[] = [];
  return { events, emit: (e: StepEvent) => events.push(e) };
};

test("runOpen: approve → sign permit (spender = account) → band quoted → createAccountAndExec → grant; every tx gas-checked first", async () => {
  const { ctx, writes, signed } = fakeCtx();
  const { events, emit } = collect();
  const calls = buildOpenPlan(openInput);
  const res = await runOpen(ctx, openInput, calls, emit, grantTokenLimits(15926.178, { address: BASE_TOKENS.cbBTC.address, decimals: 8, priceUsd: 79630.89 }, []));
  assert.deepEqual(res, { account: ACCOUNT });
  assert.equal(writes.length, 3, "approve, open, grant");
  assert.equal(writes[0].functionName, "approve");
  assert.equal(writes[1].functionName, "createAccountAndExec");
  assert.equal(writes[2].functionName, "grant");
  assert.equal(signed.length, 1);
  assert.equal((signed[0] as { message: { spender: string } }).message.spender, ACCOUNT);
  // gas assessed before each transaction, and "signing" only after the gas check passed
  const kinds = events.map((e) => e.type);
  assert.deepEqual(kinds, ["gas", "signing", "submitted", "done", "signing", "done", "gas", "signing", "submitted", "done", "gas", "signing", "submitted", "done"]);
  assert.ok(events.filter((e) => e.type === "gas").every((e) => e.type === "gas" && e.gas.ok));
});

test("runOpen: wrong network is blocked before any wallet prompt", async () => {
  const { ctx, writes } = fakeCtx({ chainId: 1 });
  const { events, emit } = collect();
  const res = await runOpen(ctx, openInput, buildOpenPlan(openInput), emit);
  assert.equal(res, null);
  assert.equal(writes.length, 0);
  assert.equal(events[0].type, "blocked");
  assert.match((events[0] as { reason: string }).reason, /switch it to Base/);
});

test("runOpen: not enough ETH for the fee is blocked with a plain sentence, wallet never asked", async () => {
  const { ctx, writes } = fakeCtx({ balance: 1_000n });
  const { events, emit } = collect();
  const res = await runOpen(ctx, openInput, buildOpenPlan(openInput), emit);
  assert.equal(res, null);
  assert.equal(writes.length, 0);
  const blocked = events.find((e) => e.type === "blocked") as { reason: string };
  assert.match(blocked.reason, /add at least/);
});

test("runOpen: a transaction the network says would revert is blocked before the wallet, with the reason", async () => {
  const { ctx, writes } = fakeCtx({ estimateThrows: "execution reverted: EntryHfTooLow(1500000000000000000, 1550000000000000000)" });
  const { events, emit } = collect();
  await runOpen(ctx, openInput, buildOpenPlan(openInput), emit);
  assert.equal(writes.length, 0);
  assert.match((events.find((e) => e.type === "blocked") as { reason: string }).reason, /EntryHfTooLow/);
});

test("runOpen: a reverted receipt is reported as failed; approve skipped when allowance suffices; band quote failure blocks the open", async () => {
  const { ctx } = fakeCtx({ receipt: "reverted" });
  const { events, emit } = collect();
  await runOpen(ctx, openInput, buildOpenPlan(openInput), emit);
  assert.ok(events.some((e) => e.type === "failed"));

  const c2 = fakeCtx();
  const input2 = { ...openInput, permit2Allowance: 10n ** 18n };
  await runOpen(c2.ctx, input2, buildOpenPlan(input2), collect().emit);
  assert.equal(c2.writes[0].functionName, "createAccountAndExec");

  const c3 = fakeCtx({ sqrtP: 0n });
  const ev3 = collect();
  await runOpen(c3.ctx, openInput, buildOpenPlan(openInput), ev3.emit);
  assert.ok(ev3.events.some((e) => e.type === "blocked" && /pool price unreadable/.test(e.reason)));
  assert.equal(c3.writes.length, 1, "only the approve went out");
});

test("runOpen (hold): no band read, execBatch through the account", async () => {
  const { ctx, writes } = fakeCtx();
  const input: OpenPlanInput = { ...openInput, strategy: "hold", enginePoolId: undefined, accountDeployed: true, keeperProtection: false };
  const res = await runOpen(ctx, input, buildOpenPlan(input), collect().emit);
  assert.ok(res);
  assert.equal(writes[1].functionName, "execBatch");
});

test("runUnwind: sizes swapMinOut from the ticks' value split and the tolerance; blocks without a USD value", async () => {
  const { ctx, writes } = fakeCtx();
  const pos = { enginePoolId: openInput.enginePoolId!, tickLower: -199_200, tickUpper: -197_700, poolAddress: "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59" as Address, usdcIsToken0: false, valueUsd: 16_000 };
  const hash = await runUnwind(ctx, { account: ACCOUNT, positionIds: [7n], collateral: "cbBTC", deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100 }, pos, collect().emit);
  assert.equal(hash, HASH);
  assert.equal(writes[0].functionName, "exec");
  // the non-USDC (WETH, token0) share at tick −198407 inside [−199200, −197700)
  const share = 1 - usdcShareOfValue(-198_407, -199_200, -197_700, false);
  assert.ok(share > 0.3 && share < 0.7, `share ${share}`);

  const ev = collect();
  const blocked = await runUnwind(ctx, { account: ACCOUNT, positionIds: [7n], collateral: "cbBTC", deployment: LIVE, deadline: 1, bandToleranceBps: 100 }, { ...pos, valueUsd: null }, ev.emit);
  assert.equal(blocked, null);
  assert.match((ev.events[0] as { reason: string }).reason, /not known yet/);
});

test("runClaim goes through the account as execBatch", async () => {
  const { ctx, writes } = fakeCtx();
  const hash = await runClaim(ctx, { account: ACCOUNT, positionIds: [7n], sweepTokens: [{ symbol: "AERO", address: BASE_TOKENS.AERO.address }], deployment: LIVE }, collect().emit);
  assert.equal(hash, HASH);
  assert.equal(writes[0].functionName, "execBatch");
  assert.equal(writes[0].address, ACCOUNT);
});

test("grantTokenLimits lists USDC, the collateral, AERO and every pool token exactly once", () => {
  const l = grantTokenLimits(10_000, { address: BASE_TOKENS.cbBTC.address, decimals: 8, priceUsd: 80_000 }, [BASE_TOKENS.WETH.address, BASE_TOKENS.USDC.address]);
  assert.deepEqual(
    l.map((x) => x.token),
    [BASE_TOKENS.USDC.address, BASE_TOKENS.cbBTC.address, BASE_TOKENS.AERO.address, BASE_TOKENS.WETH.address],
  );
  assert.equal(l[0].amountPerPeriod, 20_000_000_000n); // 2 × 10,000 USDC
  assert.equal(l[1].amountPerPeriod, 25_000_000n); // 2 × 10,000 / 80,000 BTC = 0.25 cbBTC
});

test("gas: assessGas headroom, plain sentences, estimateForWrite surfaces reverts", async () => {
  const ok = assessGas(500_000n, 10_000_000n, 10n ** 16n, 2453.45);
  assert.equal(ok.ok, true);
  assert.equal(ok.costWei, (500_000n * 10_000_000n * 15_000n) / 10_000n);
  assert.match(ok.plain, /enough/);
  const short = assessGas(500_000n, 10_000_000n, 1_000n, null);
  assert.equal(short.ok, false);
  assert.match(short.plain, /add at least/);
  assert.equal(short.costUsd, null);
  const r = await estimateForWrite({ estimateGas: async () => { throw new Error("execution reverted: AssetDisabled(cbZEC)\nmore"); }, getGasPrice: async () => 1n, getBalance: async () => 1n }, OWNER, { address: PERMIT2, data: "0x" }, null);
  assert.ok("revert" in r && /AssetDisabled/.test(r.revert));
});

test("tickmath: isqrt exact; band brackets the price by the tolerance; value split by ticks", () => {
  assert.equal(isqrt(0n), 0n);
  assert.equal(isqrt(15n), 3n);
  assert.equal(isqrt(16n), 4n);
  assert.equal(isqrt(10n ** 36n), 10n ** 18n);
  const sqrtP = 3_897_149_340_279_738_881_397_267n;
  const b = bandFromSqrtPrice(sqrtP, 100);
  // price ratio = (sqrt)^2 → min ≈ 0.99 × P, max ≈ 1.01 × P
  const ratio = (x: bigint) => Number((x * x * 10_000n) / (sqrtP * sqrtP)) / 10_000;
  assert.ok(Math.abs(ratio(b.minSqrtPriceX96) - 0.99) < 0.001);
  assert.ok(Math.abs(ratio(b.maxSqrtPriceX96) - 1.01) < 0.001);
  assert.ok(b.minSqrtPriceX96 < sqrtP && sqrtP < b.maxSqrtPriceX96);
  assert.throws(() => bandFromSqrtPrice(0n, 100), RangeError);
  assert.throws(() => bandFromSqrtPrice(sqrtP, 0), RangeError);
  assert.equal(isInRange(5, 0, 10), true);
  assert.equal(isInRange(10, 0, 10), false);
  assert.equal(token1ShareOfValue(-1000, 0, 100), 0);
  assert.equal(token1ShareOfValue(100, 0, 100), 1);
  const mid = token1ShareOfValue(50, 0, 100);
  assert.ok(mid > 0.45 && mid < 0.55, `mid ${mid}`);
});

test("inflight: save / load / interrupted / next pending (with a fake localStorage)", () => {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } };
  const flow: InflightFlow = {
    id: "open-1",
    kind: "open",
    wallet: OWNER,
    createdAt: "2026-09-05T00:00:00Z",
    updatedAt: "2026-09-05T00:00:00Z",
    summary: "0.5 cbBTC",
    steps: [
      { step: 1, kind: "approve", title: "Approve", state: "done", txHash: HASH },
      { step: 2, kind: "permit-signature", title: "Sign", state: "signing" },
      { step: 3, kind: "open", title: "Open", state: "todo" },
    ],
  };
  assert.equal(loadInflight(), null);
  saveInflight(flow);
  const back = loadInflight()!;
  assert.equal(back.id, "open-1");
  assert.equal(isInterrupted(back), true);
  assert.equal(nextPendingStep(back)?.step, 2);
  saveInflight({ ...flow, steps: flow.steps.map((s) => ({ ...s, state: "done" })), completedAt: "x" });
  assert.equal(isInterrupted(loadInflight()), false);
  clearInflight();
  assert.equal(loadInflight(), null);
  delete (globalThis as { window?: unknown }).window;
});

test("recommend: with the model's verdict nothing clears → hold, with the reason; a clearing verdict → the best userNet", () => {
  const g = demoGate();
  const r = recommend(g, "cbBTC", 4000);
  assert.equal(r.kind, "hold");
  assert.match(r.why, /4\.83% USDC borrow rate/);
  const best = g.verdicts.find((v) => v.poolId === "aero-cbbtc-usdc" && v.setting === "sheltered" && v.collateral === "cbBTC")!;
  const other = g.verdicts.find((v) => v.poolId === "aero-usdc-weth-5" && v.setting === "sheltered" && v.collateral === "cbBTC")!;
  const view = {
    ...g,
    verdicts: g.verdicts.map((v) =>
      v === best ? { ...v, qualifies: true, reason: null, lpNetPct: 12, userNet: v.userNet.map((u) => ({ ...u, userNetPct: 2.9 })) } : v === other ? { ...v, qualifies: true, reason: null, lpNetPct: 8, userNet: v.userNet.map((u) => ({ ...u, userNetPct: 1.2 })) } : v,
    ),
  };
  const r2 = recommend(view, "cbBTC", 4000);
  assert.equal(r2.kind, "lp");
  if (r2.kind === "lp") {
    assert.equal(r2.entry.poolId, "aero-cbbtc-usdc");
    assert.equal(r2.userNetPct, 2.9);
  }
});
