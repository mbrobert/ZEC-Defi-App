import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { BASE_TOKENS, CHAIN_ID, PERMIT2 } from "@zyo/shared";
import { grantPoolTokenPricing, grantTokenLimits, poolImpliedUsdPrices, runClaim, runGrant, runOpen, runRevokeAll, runUnwind, type RunContext, type StepEvent } from "../lib/execute";
import { MAX_QUOTE_DIVERGENCE } from "../lib/quote";
import { buildOpenPlan, DEMO_DEPLOYMENT, type Deployment, type OpenPlanInput } from "../lib/plan";
import { assessGas, estimateForWrite } from "../lib/gas";
import { bandFromSqrtPrice, isInRange, isqrt, token1ShareOfValue, usdcShareOfValue } from "../lib/tickmath";
import { clearInflight, isInterrupted, loadInflight, nextPendingStep, saveInflight, type InflightFlow } from "../lib/inflight";
import { recommend } from "../lib/recommend";
import { DEMO_MARKET, demoGate, demoForecast } from "../lib/demo";
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

/**
 * A fake chain. `multicall` throws so every read goes through the documented
 * per-call fallback — which is also what a chain with a missing Multicall3
 * does, so the tests exercise the path a real user could hit.
 */
function fakeCtx(
  over: Partial<{
    chainId: number;
    balance: bigint;
    estimateThrows: string;
    sqrtP: bigint;
    receipt: "success" | "reverted";
    /** Aave oracle answers, 8-dp USD. Set null to make the oracle unreadable. */
    oracle: Record<string, bigint | null>;
    poolSqrtP: bigint;
    minOut: bigint | null;
  }> = {},
) {
  const writes: WriteSpec[] = [];
  const signed: unknown[] = [];
  const WETH = BASE_TOKENS.WETH.address.toLowerCase();
  const USDC = BASE_TOKENS.USDC.address.toLowerCase();
  // A WETH/USDC Slipstream pool priced at ~2453.45 USDC per WETH.
  // token0 = WETH (18 dp), token1 = USDC (6 dp) → sqrtP = sqrt(price · 10^(d0−d1)) · 2^96.
  const POOL_SQRT_P = 3_924_354_119_174_829_377_585_152n;
  const read = {
    multicall: async () => {
      throw new Error("no multicall in this fake");
    },
    readContract: async (a: { address: string; functionName: string; args?: readonly unknown[] }) => {
      switch (a.functionName) {
        case "poolSqrtPriceX96":
          return over.sqrtP ?? 3_897_149_340_279_738_881_397_267n;
        case "slot0":
          return [over.poolSqrtP ?? POOL_SQRT_P, -198_407, 0, 0, 0, 0, true];
        case "tickSpacing":
          return 100;
        case "token0":
          return BASE_TOKENS.WETH.address;
        case "token1":
          return BASE_TOKENS.USDC.address;
        case "decimals":
          return String(a.args?.[0] ?? "").toLowerCase() === USDC ? 6 : 18;
        case "symbol":
          return "WETH";
        case "getAssetPrice": {
          const t = String(a.args?.[0] ?? "").toLowerCase();
          const table = over.oracle ?? { [WETH]: 245_345_000_000n, [USDC]: 100_000_000n };
          const v = table[t];
          if (v === null || v === undefined) throw new Error("oracle unreadable");
          return v;
        }
        case "minOutFor": {
          if (over.minOut === null) throw new Error("adapter unreadable");
          if (over.minOut !== undefined) return over.minOut;
          const [amountIn, quotedIn, quotedOut, bps] = a.args as [bigint, bigint, bigint, number];
          return (((amountIn * quotedOut) / quotedIn) * BigInt(10_000 - bps)) / 10_000n;
        }
        default:
          throw new Error(`unexpected read ${a.functionName}`);
      }
    },
    getCode: async () => "0x6080" as const,
  };
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
    read: read as never,
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
  const res = await runOpen(ctx, openInput, calls, emit, grantTokenLimits(15926.178, { address: BASE_TOKENS.cbBTC.address, symbol: "cbBTC", decimals: 8, priceUsd: 79630.89 }, []));
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
  const { ctx, writes } = fakeCtx({ estimateThrows: "execution reverted: EntryHfTooLow(1200000000000000000, 1250000000000000000)" });
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

test("runOpen (hold): no band read — the router's openBorrowOnly enforces the entry floor instead", async () => {
  const { ctx, writes } = fakeCtx();
  const input: OpenPlanInput = { ...openInput, strategy: "hold", enginePoolId: undefined, accountDeployed: true, keeperProtection: false };
  const res = await runOpen(ctx, input, buildOpenPlan(input), collect().emit);
  assert.ok(res);
  assert.equal(writes[1].functionName, "execWithCallback");
});

const POS = { enginePoolId: openInput.enginePoolId!, poolAddress: "0xb2cc224c1c9fee385f8ad6a55b4d94e92359dc59" as Address };
const UNWIND_IN = { account: ACCOUNT, positionIds: [7n], collateral: "cbBTC" as const, deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100 };

test("runUnwind: fetches a REAL quote, reads the enforced floor from the adapter, then signs execWithCallback", async () => {
  const { ctx, writes } = fakeCtx();
  const ev = collect();
  const hash = await runUnwind(ctx, UNWIND_IN, POS, ev.emit);
  assert.equal(hash, HASH);
  assert.equal(writes[0].functionName, "execWithCallback");
  const q = (ev.events.find((e) => e.type === "quoted") as { quote: { quotedIn: bigint; quotedOut: bigint; maxSlippageBps: number; minOutForQuotedIn: bigint; tickSpacing: number } }).quote;
  assert.equal(q.quotedIn, 10n ** 18n, "one whole WETH");
  // ~2453.45 USDC per WETH from the pool's own sqrtPrice, 6 dp.
  assert.ok(q.quotedOut > 2_400_000_000n && q.quotedOut < 2_500_000_000n, String(q.quotedOut));
  assert.equal(q.maxSlippageBps, 100);
  assert.equal(q.tickSpacing, 100);
  // The floor is the adapter's own arithmetic, not ours.
  assert.equal(q.minOutForQuotedIn, (q.quotedOut * 9_900n) / 10_000n);
  assert.ok(q.minOutForQuotedIn > 0n);
});

test("runUnwind refuses — it never degrades to a 1-base-unit minimum — when the pool price is unreadable", async () => {
  const { ctx, writes } = fakeCtx({ poolSqrtP: 0n });
  const ev = collect();
  assert.equal(await runUnwind(ctx, UNWIND_IN, POS, ev.emit), null);
  assert.equal(writes.length, 0);
  assert.match((ev.events[0] as { reason: string }).reason, /no honest minimum/);
});

test("runUnwind refuses when the pool is far from the Chainlink price Aave uses (a manipulated pool is not a quote)", async () => {
  const WETH = BASE_TOKENS.WETH.address.toLowerCase();
  const USDC = BASE_TOKENS.USDC.address.toLowerCase();
  // Oracle says WETH is worth 20% more than the pool does.
  const { ctx, writes } = fakeCtx({ oracle: { [WETH]: 294_414_000_000n, [USDC]: 100_000_000n } });
  const ev = collect();
  assert.equal(await runUnwind(ctx, UNWIND_IN, POS, ev.emit), null);
  assert.equal(writes.length, 0);
  const reason = (ev.events[0] as { reason: string }).reason;
  assert.match(reason, /Chainlink/);
  assert.match(reason, /nothing was signed/i);
  assert.ok(MAX_QUOTE_DIVERGENCE > 0 && MAX_QUOTE_DIVERGENCE < 0.1);
});

test("runUnwind refuses when the swap adapter will not confirm the floor it will enforce", async () => {
  const { ctx, writes } = fakeCtx({ minOut: null });
  const ev = collect();
  assert.equal(await runUnwind(ctx, UNWIND_IN, POS, ev.emit), null);
  assert.equal(writes.length, 0);
  assert.match((ev.events[0] as { reason: string }).reason, /would not confirm the minimum/);
});

test("runUnwind still quotes when the oracle is unreadable — the pool price is the quote, the oracle only cross-checks", async () => {
  const { ctx, writes } = fakeCtx({ oracle: {} });
  const ev = collect();
  assert.equal(await runUnwind(ctx, UNWIND_IN, POS, ev.emit), HASH);
  assert.equal(writes.length, 1);
  const q = (ev.events.find((e) => e.type === "quoted") as { quote: { crossCheckDelta: number | null } }).quote;
  assert.equal(q.crossCheckDelta, null);
});

test("runClaim goes through the account as execBatch, with a band quoted from the pool", async () => {
  const { ctx, writes } = fakeCtx();
  const input = { account: ACCOUNT, positionIds: [7n], sweepTokens: [{ symbol: "AERO", address: BASE_TOKENS.AERO.address }], deployment: LIVE, deadline: 1_800_000_000, bandToleranceBps: 100 };
  const hash = await runClaim(ctx, input, openInput.enginePoolId!, collect().emit);
  assert.equal(hash, HASH);
  assert.equal(writes[0].functionName, "execBatch");
  assert.equal(writes[0].address, ACCOUNT);
  // A claim without a pool cannot be band-bounded, and the engine may compound
  // (and therefore swap) inside it — so it is refused, not sent unbounded.
  const ev = collect();
  assert.equal(await runClaim(ctx, input, null, ev.emit), null);
  assert.match((ev.events[0] as { reason: string }).reason, /price limit/);
});

test("the keeper grant can be renewed and every permission revoked, each as its own guarded write", async () => {
  const { ctx, writes } = fakeCtx();
  const limits = grantTokenLimits(1_000, { address: BASE_TOKENS.cbBTC.address, symbol: "cbBTC", decimals: 8, priceUsd: 80_000 }, []);
  assert.equal(await runGrant(ctx, { account: ACCOUNT, deployment: LIVE, tokenLimits: limits }, collect().emit), HASH);
  assert.equal(writes[0].functionName, "grant");
  assert.equal(await runRevokeAll(ctx, ACCOUNT, collect().emit), HASH);
  assert.equal(writes[1].functionName, "revokeAll");
  assert.equal(writes[1].address, ACCOUNT);
});

test("grantTokenLimits lists USDC, the collateral, AERO and every pool token exactly once", () => {
  const l = grantTokenLimits(10_000, { address: BASE_TOKENS.cbBTC.address, symbol: "cbBTC", decimals: 8, priceUsd: 80_000 }, [
    { address: BASE_TOKENS.WETH.address, symbol: "WETH", decimals: 18, priceUsd: 2_000 },
    { address: BASE_TOKENS.USDC.address, symbol: "USDC", decimals: 6, priceUsd: 1 },
  ]);
  assert.deepEqual(
    l.map((x) => x.token),
    [BASE_TOKENS.USDC.address, BASE_TOKENS.cbBTC.address, BASE_TOKENS.AERO.address, BASE_TOKENS.WETH.address],
  );
  assert.equal(l[0].amountPerPeriod, 20_000_000_000n); // 2 × 10,000 USDC
  assert.equal(l[1].amountPerPeriod, 25_000_000n); // 2 × 10,000 / 80,000 BTC = 0.25 cbBTC
  assert.equal(l[3].amountPerPeriod, 10n * 10n ** 18n); // 2 × 10,000 / 2,000 = 10 WETH, in wei
});

/**
 * Audit wave 2, G-HIGH-1. The pool-token line used to be the COLLATERAL's number reused for a
 * different token: a cbBTC user in the WETH/USDC pool signed a WETH budget of ~7.5e-11 WETH, the
 * keeper's swap approve failed TokenBudgetExceeded on every rung, and the panel said "active".
 */
test("G-HIGH-1: a pool token is sized in ITS OWN decimals and price, never the collateral's", () => {
  // cbBTC $79,593.77, debt 30,000 USDC, LP in WETH/USDC at $2,453.45 (VERIFIED-BASE-FACTS 2026-09-05).
  const l = grantTokenLimits(30_000, { address: BASE_TOKENS.cbBTC.address, symbol: "cbBTC", decimals: 8, priceUsd: 79_593.77 }, [
    { address: BASE_TOKENS.WETH.address, symbol: "WETH", decimals: 18, priceUsd: 2_453.45 },
    { address: BASE_TOKENS.USDC.address, symbol: "USDC", decimals: 6, priceUsd: 1 },
  ]);
  const weth = l.find((x) => x.token.toLowerCase() === BASE_TOKENS.WETH.address.toLowerCase())!;
  const cbbtc = l.find((x) => x.token.toLowerCase() === BASE_TOKENS.cbBTC.address.toLowerCase())!;
  // 2 × 30,000 / 2,453.45 = 24.455… WETH → in wei, not in cbBTC base units.
  assert.equal(weth.amountPerPeriod, BigInt(Math.ceil((60_000 / 2_453.45) * 1e18)));
  assert.ok(weth.amountPerPeriod > 24n * 10n ** 18n && weth.amountPerPeriod < 25n * 10n ** 18n, `WETH line is ${weth.amountPerPeriod} wei`);
  assert.notEqual(weth.amountPerPeriod, cbbtc.amountPerPeriod, "the WETH line is not the cbBTC line reused");
  // A 6.11 WETH leg (half of a $30k LP) fits comfortably inside the line the keeper will need.
  assert.ok(weth.amountPerPeriod > 611n * 10n ** 16n);
});

test("G-HIGH-1: a pool token this app does not know, or has no USD price for, is refused — never a wrong line", () => {
  const coll = { address: BASE_TOKENS.cbBTC.address, symbol: "cbBTC", decimals: 8, priceUsd: 79_593.77 };
  assert.throws(() => grantPoolTokenPricing(["USDT", "USDC"], DEMO_MARKET), /USDT.*not a token this app knows/);
  assert.throws(() => grantTokenLimits(30_000, coll, [{ address: BASE_TOKENS.cbZEC.address, symbol: "cbZEC", decimals: 8, priceUsd: NaN }]), /no USD price for cbZEC/);
  // …and the collateral itself: a NaN price used to become a 1-base-unit line that read as "listed".
  assert.throws(() => grantTokenLimits(30_000, { ...coll, priceUsd: NaN }, []), /no USD price for cbBTC/);
  // The two offerable pools resolve from the market read: USDC at $1, cbBTC and WETH from their reserves.
  const priced = grantPoolTokenPricing(["WETH", "USDC"], DEMO_MARKET);
  assert.deepEqual(
    priced.map((p) => [p.symbol, p.decimals, p.priceUsd]),
    [
      ["WETH", 18, DEMO_MARKET.reserves.WETH!.priceUsd],
      ["USDC", 6, 1],
    ],
  );
  // With no debt there is nothing to size against: one base unit per line, never zero (the chain refuses zero).
  const idle = grantTokenLimits(0, coll, []);
  assert.ok(idle.every((x) => x.amountPerPeriod > 0n));
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

test("recommend: with the model's forecast nothing beats the borrow → the least bad cell, named as a loss; a positive cell → the best user net; nothing priced → hold", () => {
  const f = demoForecast();
  const r = recommend(f, "cbBTC", 4000);
  assert.equal(r.kind, "lp");
  if (r.kind === "lp") {
    assert.equal(r.cell.poolId, "aero-cbbtc-usdc");
    assert.equal(r.positive, false);
    assert.match(r.why, /4\.52% borrow rate/);
    assert.match(r.why, /still a loss/);
  }
  const best = f.cells.find((c) => c.poolId === "aero-cbbtc-usdc" && c.setting === "sheltered" && c.collateral === "cbBTC")!;
  const other = f.cells.find((c) => c.poolId === "aero-usdc-weth-5" && c.setting === "sheltered" && c.collateral === "cbBTC")!;
  // lpNet 12 at 40 % LTV against the recorded borrow 4.5174 and supply 0.0115: 0.0115 + 0.4 × (12 − 4.5174) = 3.00
  const view = { ...f, cells: f.cells.map((c) => (c === best ? { ...c, lpNetPct: 12, mcLpNetPct: 11 } : c === other ? { ...c, lpPriced: true, lpNetPct: 8, mcLpNetPct: 7 } : c)) };
  const r2 = recommend(view, "cbBTC", 4000);
  assert.equal(r2.kind, "lp");
  if (r2.kind === "lp") {
    assert.equal(r2.cell.poolId, "aero-cbbtc-usdc");
    assert.equal(r2.positive, true);
    assert.ok(Math.abs(r2.userNetPct - (0.0115 + 0.4 * (12 - 4.5174))) < 1e-9);
    assert.match(r2.why, /highest forecast net return/);
  }
  const none = { ...f, cells: f.cells.map((c) => ({ ...c, lpPriced: false, lpNetPct: null, lpUnpricedReason: "emissions_unavailable" })) };
  const r3 = recommend(none, "cbBTC", 4000);
  assert.equal(r3.kind, "hold");
  if (r3.kind === "hold") assert.match(r3.why, /could not price any pool/);
});

/**
 * Audit wave 3, W3-MED-1. cbZEC has no Aave reserve, so `grantPoolTokenPricing` priced it NaN and
 * `grantTokenLimits` threw: a cbZEC/USDC position could never get a keeper grant — at open ("grant it
 * later") and later from the dashboard alike — while the keeper's unwind for that pool needs a cbZEC
 * budget (the pool-direct callback pays the pool by `transfer`; `SlipstreamLpVenue.t.sol`
 * `test_keeperUnwindOnTheDirectPoolIsBudgeted`). The pool's own USDC price now sizes that line.
 */
test("W3-MED-1: a pool token Aave does not list is refused without a pool price (the pre-fix product outcome), and sized from the pool's own price with one", () => {
  const cbbtc = { address: BASE_TOKENS.cbBTC.address, symbol: "cbBTC", decimals: 8, priceUsd: 79_593.77 };
  // Before the fix this is the only path: cbZEC → NaN → the grant cannot be built.
  const noPrice = grantPoolTokenPricing(["USDC", "cbZEC"], DEMO_MARKET);
  assert.ok(Number.isNaN(noPrice.find((t) => t.symbol === "cbZEC")!.priceUsd));
  assert.throws(() => grantTokenLimits(30_000, cbbtc, noPrice), /no USD price for cbZEC/);
  // With the pool-implied price (1,075.5 USDC per cbZEC on 2026-09-10) the line is sized in cbZEC's 8 decimals.
  const priced = grantPoolTokenPricing(["USDC", "cbZEC"], DEMO_MARKET, { cbZEC: 1_075.5 });
  const l = grantTokenLimits(30_000, cbbtc, priced);
  const zec = l.find((x) => x.token.toLowerCase() === BASE_TOKENS.cbZEC.address.toLowerCase())!;
  assert.ok(zec, "a cbZEC line exists");
  assert.equal(zec.amountPerPeriod, BigInt(Math.ceil(((30_000 * 2) / 1_075.5) * 1e8)));
  // An Aave price, when there is one, still wins over the pool's.
  const both = grantPoolTokenPricing(["cbBTC"], DEMO_MARKET, { cbBTC: 1 });
  assert.ok(Math.abs(both[0].priceUsd - DEMO_MARKET.reserves.cbBTC!.priceUsd) < 1e-6);
});

test("W3-MED-1: poolImpliedUsdPrices reads the pool's slot0 and token order; an unreadable pool contributes nothing", async () => {
  const POOL = "0x0fc47c17af86078d809358db1b4db2debc988566" as const;
  // sqrtPriceX96 at tick −23,756 (2026-09-10 read): ≈ 1,075.5 USDC per cbZEC with USDC as token0.
  const sqrtP = 24_158_478_068_572_882_064_475_621_010n;
  const read = {
    async multicall({ contracts }: { contracts: readonly { address: string; functionName: string }[] }) {
      return contracts.map((c) => {
        if (c.address.toLowerCase() !== POOL) return { status: "failure" as const };
        if (c.functionName === "slot0") return { status: "success" as const, result: [sqrtP, -23_756, 0, 1, 1, true] };
        if (c.functionName === "token0") return { status: "success" as const, result: BASE_TOKENS.USDC.address };
        return { status: "failure" as const };
      });
    },
    async readContract() {
      throw new Error("unused");
    },
    async getCode() {
      return "0x";
    },
  };
  const prices = await poolImpliedUsdPrices(read as never, [
    { poolAddress: POOL, token0: "USDC", token1: "cbZEC" },
    { poolAddress: "0x1111111111111111111111111111111111111111", token0: "WETH", token1: "USDC" },
  ]);
  assert.ok(prices.cbZEC !== undefined && Math.abs(prices.cbZEC - 1_075.5) < 1, `pool-implied cbZEC price ${prices.cbZEC}`);
  assert.equal(prices.WETH, undefined, "an unreadable pool contributes nothing — the grant refuses that token by name");
});
