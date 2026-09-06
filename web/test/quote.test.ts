import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { AAVE_V3, BASE_TOKENS } from "@zyo/shared";
import { MAX_QUOTE_DIVERGENCE, QuoteRefused, poolPriceToken0InToken1, quoteUnwindSwap } from "../lib/quote";
import { DEMO_DEPLOYMENT, MAX_SWAP_SLIPPAGE_BPS, type Deployment } from "../lib/plan";
import type { ReadClient } from "../lib/reads";

const LIVE: Deployment = { ...DEMO_DEPLOYMENT, demo: false };
const POOL = "0x4e962bb3889bf030368f56810a9c96b83cb3e778" as Address;
const Q96 = 2 ** 96;

/** sqrtPriceX96 for a pool whose token0/token1 price is `p`, decimals-adjusted. */
function sqrtX96(price: number, decimals0: number, decimals1: number): bigint {
  return BigInt(Math.round(Math.sqrt(price / 10 ** (decimals0 - decimals1)) * Q96));
}

/**
 * A pool with USDC as token0 and cbBTC as token1 — the inverse of the WETH/USDC
 * ordering exercised in execute.test.ts, and the one the curated cbBTC pool
 * actually uses. Getting this branch backwards would produce a floor 6 × 10^9
 * times too low, which is exactly the class of mistake `swapMinOut: 1` used to
 * hide.
 */
function usdcToken0Client(over: { oracleTok?: bigint | null; minOut?: bigint | null; btcUsdc?: number } = {}): ReadClient {
  const btcInUsdc = over.btcUsdc ?? 79_630.89;
  // token0 = USDC (6dp), token1 = cbBTC (8dp): price of USDC in cbBTC.
  const price01 = 1 / btcInUsdc;
  return {
    multicall: async () => {
      throw new Error("no multicall");
    },
    readContract: async (a: { functionName: string; args?: readonly unknown[] }) => {
      switch (a.functionName) {
        case "slot0":
          return [sqrtX96(price01, 6, 8), 0, 0, 0, 0, 0, true];
        case "tickSpacing":
          return 100;
        case "token0":
          return BASE_TOKENS.USDC.address;
        case "token1":
          return BASE_TOKENS.cbBTC.address;
        case "decimals":
          return 8;
        case "symbol":
          return "cbBTC";
        case "getAssetPrice": {
          const t = String(a.args?.[0] ?? "").toLowerCase();
          if (t === BASE_TOKENS.USDC.address.toLowerCase()) return 100_000_000n;
          if (over.oracleTok === null) throw new Error("no oracle");
          return over.oracleTok ?? BigInt(Math.round(btcInUsdc * 1e8));
        }
        case "minOutFor": {
          if (over.minOut !== undefined) {
            if (over.minOut === null) throw new Error("adapter unreadable");
            return over.minOut;
          }
          const [amountIn, quotedIn, quotedOut, bps] = a.args as [bigint, bigint, bigint, number];
          return (((amountIn * quotedOut) / quotedIn) * BigInt(10_000 - bps)) / 10_000n;
        }
        default:
          throw new Error(`unexpected read ${a.functionName}`);
      }
    },
    getCode: async () => "0x60" as const,
  };
}

test("poolPriceToken0InToken1 inverts decimals the way Slipstream stores them", () => {
  // 1 WETH (18dp) = 2453.45 USDC (6dp), USDC as token1.
  const p = poolPriceToken0InToken1(sqrtX96(2453.45, 18, 6), 18, 6);
  assert.ok(Math.abs(p - 2453.45) / 2453.45 < 1e-6, String(p));
  // …and the same pool read the other way round.
  const inv = poolPriceToken0InToken1(sqrtX96(1 / 2453.45, 6, 18), 6, 18);
  assert.ok(Math.abs(1 / inv - 2453.45) / 2453.45 < 1e-6, String(inv));
});

test("quotes the non-USDC leg when USDC is token0 (the cbBTC pool's ordering)", async () => {
  const q = await quoteUnwindSwap({ read: usdcToken0Client(), deployment: LIVE, poolAddress: POOL, maxSlippageBps: 100 });
  assert.equal(q.tokenAddress, BASE_TOKENS.cbBTC.address);
  assert.equal(q.tokenSymbol, "cbBTC");
  assert.equal(q.quotedIn, 10n ** 8n, "one whole cbBTC");
  // ~79,630.89 USDC for one cbBTC, in 6-dp USDC base units.
  assert.ok(q.quotedOut > 79_000_000_000n && q.quotedOut < 80_300_000_000n, String(q.quotedOut));
  assert.equal(q.minOutForQuotedIn, (q.quotedOut * 9_900n) / 10_000n);
  assert.equal(q.maxSlippageBps, 100);
  assert.equal(q.tickSpacing, 100);
  assert.equal(q.routeData, `0x${"0".repeat(62)}64`);
  assert.ok(q.crossCheckDelta !== null && q.crossCheckDelta < 1e-3, String(q.crossCheckDelta));
});

test("the swap tolerance is clamped to the product cap, which is under the chain's 500 bps", async () => {
  const q = await quoteUnwindSwap({ read: usdcToken0Client(), deployment: LIVE, poolAddress: POOL, maxSlippageBps: 9_999 });
  assert.equal(q.maxSlippageBps, MAX_SWAP_SLIPPAGE_BPS);
  assert.ok(MAX_SWAP_SLIPPAGE_BPS <= 500);
  const zero = await quoteUnwindSwap({ read: usdcToken0Client(), deployment: LIVE, poolAddress: POOL, maxSlippageBps: 0 });
  assert.equal(zero.maxSlippageBps, 1, "never zero — a zero tolerance is not a quote, it is a guaranteed revert");
});

test("a pool far from the Chainlink price is refused, with a sentence naming both prices", async () => {
  // Oracle says cbBTC is worth 10% more than the pool does.
  const read = usdcToken0Client({ oracleTok: BigInt(Math.round(79_630.89 * 1.1 * 1e8)) });
  await assert.rejects(
    () => quoteUnwindSwap({ read, deployment: LIVE, poolAddress: POOL, maxSlippageBps: 100 }),
    (e: unknown) => {
      assert.ok(e instanceof QuoteRefused);
      assert.match(e.plain, /Chainlink/);
      assert.match(e.plain, /nothing was signed/i);
      assert.match(e.plain, /your position and your loan are unchanged/);
      return true;
    },
  );
  // Just inside the tolerance still quotes.
  const ok = await quoteUnwindSwap({
    read: usdcToken0Client({ oracleTok: BigInt(Math.round(79_630.89 * (1 + MAX_QUOTE_DIVERGENCE / 2) * 1e8)) }),
    deployment: LIVE,
    poolAddress: POOL,
    maxSlippageBps: 100,
  });
  assert.ok(ok.quotedOut > 0n);
});

test("every failure is a refusal with a plain sentence — never a weaker quote", async () => {
  const cases: [ReadClient, RegExp][] = [
    [usdcToken0Client({ minOut: null }), /would not confirm the minimum/],
    [usdcToken0Client({ minOut: 0n }), /would not confirm the minimum/],
  ];
  for (const [read, re] of cases) {
    await assert.rejects(
      () => quoteUnwindSwap({ read, deployment: LIVE, poolAddress: POOL, maxSlippageBps: 100 }),
      (e: unknown) => {
        assert.ok(e instanceof QuoteRefused, String(e));
        assert.match(e.plain, re);
        return true;
      },
    );
  }
});

test("a pool that does not hold USDC is refused, and says the position is untouched", async () => {
  const read: ReadClient = {
    ...usdcToken0Client(),
    readContract: async (a: { functionName: string; args?: readonly unknown[] }) => {
      if (a.functionName === "token0") return BASE_TOKENS.WETH.address;
      if (a.functionName === "token1") return BASE_TOKENS.cbBTC.address;
      return usdcToken0Client().readContract(a as never);
    },
  };
  await assert.rejects(
    () => quoteUnwindSwap({ read, deployment: LIVE, poolAddress: POOL, maxSlippageBps: 100 }),
    (e: unknown) => {
      assert.ok(e instanceof QuoteRefused);
      assert.match((e as QuoteRefused).plain, /does not hold USDC/);
      assert.match((e as QuoteRefused).plain, /Your position is untouched/);
      return true;
    },
  );
});

test("the cross-check reads the Aave oracle the rest of the app reads", () => {
  assert.match(AAVE_V3.oracle, /^0x[0-9a-fA-F]{40}$/);
});
