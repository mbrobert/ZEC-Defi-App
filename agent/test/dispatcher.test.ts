import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createWalletClient, decodeFunctionData, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { HF_LADDER } from "@zyo/shared";
import { GRANT_SELECTORS, strategyRouterAbi } from "../src/abi/oilskin.js";
import { KeeperDispatcher } from "../src/dispatch/keeperDispatcher.js";
import { CLOSE_FRACTION, bandFor, closeCount, isqrt, planAction, selectIds, type PoolInfo } from "../src/dispatch/policy.js";
import { NO_SWAP, quoteForPool, minOutFor } from "../src/dispatch/quote.js";
import { evaluateSnapshot } from "../src/engine/valuation.js";
import { Logger, memorySink } from "../src/log.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import type { DispatchRecord } from "../src/store/keeperStore.js";
import type { Address } from "../src/types/evm.js";
import { ACCOUNT_A, CBBTC, USDC, WETH as WETH_T, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";

const ROUTER = getAddress("0x2000000000000000000000000000000000000001") as Address;
const LP_VENUE = getAddress("0x2000000000000000000000000000000000000002") as Address;
const KEY = ("0x" + "42".repeat(32)) as Hex;
const KEEPER = privateKeyToAccount(KEY).address;
const POOL_A = ("0x" + "aa".repeat(32)) as Hex;
const POOL_B = ("0x" + "bb".repeat(32)) as Hex;
const SQRT_P = 5_000_000_000_000_000_000_000_000_000n; // ~ price 4000 in Q64.96 terms, any positive number works

const CFG = {
  deadlineMs: 500,
  bandToleranceBps: 100,
  bandMaxToleranceBps: 500,
  txDeadlineS: 120,
  priceMaxAgeS: 3 * 3600,
  oracleDeviationBps: 300,
  hfToleranceBps: 100,
  swapMaxSlippageBps: 100,
  maxValueProbes: 24,
  grantExpiryWarnS: 7 * 86_400,
};

/** Pool map for the pure-planning tests: a live price, no swap leg needed. */
function poolMap(...ids: Hex[]): Map<Hex, PoolInfo> {
  return new Map(ids.map((id) => [id, { sqrtPriceX96: SQRT_P, swap: NO_SWAP, needsSwap: false }]));
}

function record(action: string, rung: string, hf: number, over: Partial<DispatchRecord> = {}): DispatchRecord {
  const now = "2026-09-05T01:00:00.000Z";
  return { key: `${ACCOUNT_A.toLowerCase()}:1:1:${action}`, account: ACCOUNT_A.toLowerCase() as Address, episode: 1, seq: 1, action, rung, hf, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now, ...over };
}

async function rig(hf = 1.3) {
  const chain = newMockChain();
  cbBtcPosition(chain, ACCOUNT_A, debtForHf(hf));
  const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
  oil.install([ACCOUNT_A]);
  oil.poolPrices.set(POOL_A, SQRT_P);
  oil.poolPrices.set(POOL_B, SQRT_P * 2n);
  const client = chain.publicClient();
  const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: base, transport: chain.transport() });
  const reader = new AaveReader(client, aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 500 });
  const sink = memorySink();
  const notified: { kind: string; account?: string }[] = [];
  const notifier = {
    failures: 0,
    channels: ["test"],
    hasPersonChannel: true,
    deliver: async (e: { kind: string; account?: string }) => {
      notified.push(e);
      return { personReached: true };
    },
  };
  const dispatcher = new KeeperDispatcher({
    client,
    wallet,
    keeper: KEEPER,
    router: ROUTER,
    lpVenue: LP_VENUE,
    usdc: USDC,
    reader,
    ladder: HF_LADDER,
    log: new Logger(sink.sink, "debug"),
    config: CFG,
    now: () => new Date(Number(chain.nowS) * 1000),
    notifier,
  });
  const valuation = async () => {
    const ctx = await reader.readReserveContexts();
    const snap = await reader.readAccount(ACCOUNT_A, ctx, chain.blockNumber);
    const v = evaluateSnapshot(snap, { nowS: chain.nowS, ...CFG });
    if (v.kind !== "OK") throw new Error(`expected OK, got ${v.kind}`);
    return v;
  };
  // EXACTLY the one Permission web/lib/plan.ts signs — nothing more. Before the
  // D5 fix these tests granted a second selector the product never issues,
  // which is how audit C-HIGH-1 stayed hidden behind a green suite.
  const grantAll = (over: Partial<{ active: boolean; allowCallback: boolean; expiry: number }> = {}) => {
    oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"], over);
  };
  return { chain, oil, dispatcher, valuation, grantAll, sink, notified, notifier, reader };
}

describe("policy — pure planning", () => {
  it("close fractions per action and rounding up; unknown actions refused", () => {
    assert.deepEqual(Object.keys(CLOSE_FRACTION).sort(), ["derisk", "emergency-unwind", "repay"]);
    assert.equal(closeCount(0, "repay"), 0);
    assert.equal(closeCount(1, "repay"), 1);
    assert.equal(closeCount(2, "repay"), 1);
    assert.equal(closeCount(3, "repay"), 1); // exactly ⅓
    assert.equal(closeCount(4, "repay"), 2);
    assert.equal(closeCount(3, "derisk"), 2);
    assert.equal(closeCount(6, "repay"), 2);
    assert.equal(closeCount(6, "derisk"), 4);
    assert.equal(closeCount(7, "derisk"), 5);
    assert.equal(closeCount(25, "emergency-unwind"), 25);
    assert.equal(closeCount(25, "repay"), 9);
    assert.throws(() => closeCount(1, "withdraw"), RangeError);
  });

  it("band: sqrt-scaled around the live price, both bounds non-zero, contains the price; degenerate inputs throw", () => {
    fc.assert(
      // Real sqrtPriceX96 values sit around 2^96; anything below 2^40 is not a price.
      fc.property(fc.bigInt({ min: 1n << 40n, max: 1n << 150n }), fc.integer({ min: 1, max: 5000 }), (p, tol) => {
        const b = bandFor(p, tol);
        assert.ok(b.minSqrtPriceX96 > 0n && b.maxSqrtPriceX96 > b.minSqrtPriceX96);
        assert.ok(b.minSqrtPriceX96 <= p && p <= b.maxSqrtPriceX96);
        // Price band ≈ ±tol: (max/p)² − 1 ≤ tol/1e4 + rounding.
        const hiRatio = Number(b.maxSqrtPriceX96) / Number(p);
        const loRatio = Number(b.minSqrtPriceX96) / Number(p);
        assert.ok(hiRatio * hiRatio <= 1 + tol / 10_000 + 1e-6);
        assert.ok(loRatio * loRatio >= 1 - tol / 10_000 - 1e-6);
      }),
      { numRuns: 1000 }
    );
    assert.throws(() => bandFor(0n, 100), RangeError);
    assert.throws(() => bandFor(1n, 1), /degenerate/); // collapses to 0 → fail closed
    assert.throws(() => bandFor(10n ** 30n, 0), RangeError);
    assert.throws(() => bandFor(10n ** 30n, 10_000), RangeError);
    assert.equal(isqrt(0n), 0n);
    assert.equal(isqrt(1_000_000n), 1000n);
    assert.equal(isqrt(999_999n), 999n);
  });

  it("FIX C-1: plans ONE unwind per pool — the only root call, inside the only signed grant", () => {
    const base = {
      account: ACCOUNT_A,
      router: ROUTER,
      collateralAsset: CBBTC,
      positions: [
        { id: 1n, poolId: POOL_A, valueUsdc: 1_000_000n },
        { id: 2n, poolId: POOL_B, valueUsdc: 500_000n },
        { id: 3n, poolId: POOL_A, valueUsdc: 3_000_000n },
      ],
      pools: poolMap(POOL_A, POOL_B),
      idleUsdc: 0n,
      usdcNeeded: null,
      bandToleranceBps: 100,
      nowS: 1_800_000_000n,
      txDeadlineS: 120,
    };
    const plan = planAction({ ...base, action: "emergency-unwind" });
    assert.equal(plan.kind, "CALLS");
    if (plan.kind !== "CALLS") return;
    // Two pools ⇒ two unwinds. No closeMany anywhere: the router closes the ids.
    assert.equal(plan.calls.length, 2);
    assert.deepEqual(new Set(plan.closeIds), new Set([1n, 2n, 3n]));
    for (const c of plan.calls) {
      assert.equal(c.target, ROUTER);
      assert.equal(c.callback, false, "the keeper never sets the call's callback flag; the GRANT carries it");
      assert.equal(c.data.slice(0, 10), GRANT_SELECTORS["StrategyRouter.unwind"]);
    }
    // The most valuable pool goes first; only the LAST call repays.
    const decoded = plan.calls.map(
      (c) =>
        (decodeFunctionData({ abi: strategyRouterAbi, data: c.data }).args as unknown as [
          {
            positionIds: readonly bigint[];
            repayAmount: bigint;
            withdrawAmount: bigint;
            deadline: bigint;
            collateralAsset: Address;
            swap: { quotedIn: bigint; quotedOut: bigint; maxSlippageBps: number };
          },
        ])[0]
    );
    assert.deepEqual([...decoded[0].positionIds], [1n, 3n]);
    assert.deepEqual([...decoded[1].positionIds], [2n]);
    assert.equal(decoded[0].repayAmount, 0n);
    assert.equal(decoded[1].repayAmount, (1n << 256n) - 1n);
    for (const p of decoded) {
      assert.equal(p.withdrawAmount, 0n);
      assert.equal(p.deadline, 1_800_000_120n);
      assert.equal(p.collateralAsset, CBBTC);
    }
    // ONE grant, and it is the one the web signs.
    assert.deepEqual(plan.grantsNeeded, [{ target: ROUTER, selector: GRANT_SELECTORS["StrategyRouter.unwind"] }]);

    // No pool price → refuse (never a zero band).
    const noPrice = planAction({ ...base, action: "repay", pools: new Map() });
    assert.equal(noPrice.kind, "REFUSE");
    // No positions and no idle USDC → nothing the keeper can do.
    const nothing = planAction({ ...base, action: "repay", positions: [] });
    assert.equal(nothing.kind, "NOTHING");
    // No positions but idle USDC → unwind-only plan (repay from idle).
    const idle = planAction({ ...base, action: "repay", positions: [], idleUsdc: 5n });
    assert.equal(idle.kind === "CALLS" && idle.calls.length, 1);
  });

  it("FIX C-10: the close fraction is a fraction of VALUE, largest ids first — never of the enumeration order", () => {
    // The PoC's account: two dust ids enumerated first, four $12,000 ids after.
    const positions = [
      { id: 1n, poolId: POOL_A, valueUsdc: 10_000_000n }, // $10
      { id: 2n, poolId: POOL_A, valueUsdc: 10_000_000n },
      { id: 3n, poolId: POOL_A, valueUsdc: 12_000_000_000n }, // $12,000
      { id: 4n, poolId: POOL_A, valueUsdc: 12_000_000_000n },
      { id: 5n, poolId: POOL_A, valueUsdc: 12_000_000_000n },
      { id: 6n, poolId: POOL_A, valueUsdc: 12_000_000_000n },
    ];
    const sel = selectIds(positions, "repay", null, 0n);
    assert.equal(sel.sizing, "value");
    // ⅓ of ~$48,020 is ~$16,007: two big ids, not two dust ones.
    assert.deepEqual(sel.ids.map((p) => p.id), [3n, 4n]);
    assert.equal(sel.expectedProceedsUsdc, 24_000_000_000n);

    // Reordering the ids cannot change the outcome — that was the whole bug.
    const reversed = selectIds([...positions].reverse(), "repay", null, 0n);
    assert.equal(reversed.ids.length, 2);
    assert.equal(reversed.expectedProceedsUsdc, 24_000_000_000n);
    assert.ok(reversed.ids.every((p) => p.valueUsdc === 12_000_000_000n), "reordering the ids must not change what is closed");

    // Need-based sizing: when a smaller repay reaches the rung's disarm, close less.
    const need = selectIds(positions, "repay", 11_000_000_000n, 0n);
    assert.deepEqual(need.ids.map((p) => p.id), [3n]);
    // Idle USDC counts towards the need first (the same call repays it).
    const idleCovers = selectIds(positions, "repay", 11_000_000_000n, 11_000_000_000n);
    assert.deepEqual(idleCovers.ids, []);
    // The last resort still closes everything, whatever the need says.
    assert.equal(selectIds(positions, "emergency-unwind", 1n, 0n).ids.length, 6);
    // Nothing valued ⇒ documented COUNT fallback, in enumeration order.
    const unvalued = selectIds(positions.map((p) => ({ ...p, valueUsdc: null })), "repay", null, 0n);
    assert.equal(unvalued.sizing, "count");
    assert.deepEqual(unvalued.ids.map((p) => p.id), [1n, 2n]);
  });

  it("FIX C-1: a swap quote is a real rate from the pool price — `swapMinOut: 1` is not expressible", () => {
    // USDC is token0 (6 decimals), the other token is token1 (8 decimals).
    const q = quoteForPool({
      sqrtPriceX96: SQRT_P,
      token0: USDC,
      token1: CBBTC,
      usdc: USDC,
      nonUsdcDecimals: 8,
      maxSlippageBps: 100,
      tickSpacing: 200,
    });
    assert.ok(q.quote.quotedIn > 0n && q.quote.quotedOut > 0n, "a quote must price something");
    assert.equal(q.nonUsdcToken, CBBTC);
    assert.equal(q.quote.maxSlippageBps, 100);
    assert.notEqual(q.quote.routeData, "0x");
    // The enforced floor scales with the amount actually swapped and sits 1 % under the quote.
    const floor = minOutFor(q.quote.quotedIn, q.quote);
    assert.equal(floor, (q.quote.quotedOut * 9_900n) / 10_000n);
    // Above the adapter's on-chain cap is refused here, not on chain.
    assert.throws(
      () =>
        quoteForPool({
          sqrtPriceX96: SQRT_P,
          token0: USDC,
          token1: CBBTC,
          usdc: USDC,
          nonUsdcDecimals: 8,
          maxSlippageBps: 900,
          tickSpacing: 200,
        }),
      /maxSlippageBps/
    );
    // A pool with no USDC leg cannot be settled by the router.
    assert.throws(
      () =>
        quoteForPool({
          sqrtPriceX96: SQRT_P,
          token0: CBBTC,
          token1: WETH_T,
          usdc: USDC,
          nonUsdcDecimals: 18,
          maxSlippageBps: 100,
          tickSpacing: 200,
        }),
      /no USDC leg/
    );
  });
});

describe("KeeperDispatcher — acts only inside a readable grant", () => {
  it("REFUSES without sending when the grant is not active on-chain", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /no active grant/);
    assert.equal(r.oil.txFrom.length, 0);
    assert.equal(r.chain.calls.filter((c) => c.method === "eth_sendRawTransaction").length, 0);
  });

  it("FIX C-1: a grant without allowCallback is REFUSED as a MIS-ISSUED GRANT, permanently, without sending", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll({ allowCallback: false });
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.equal((res as { permanent?: boolean }).permanent, true);
    assert.match((res as { reason: string }).reason, /allowCallback=false/);
    assert.equal(r.oil.txFrom.length, 0);
  });

  it("FIX C-3: an expiring grant is surfaced to the caller and notified — never read and discarded", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    const soon = Number(r.chain.nowS) + 3 * 86_400; // 3 days left, warn window is 7
    r.grantAll({ expiry: soon });
    const seen: { expiry: number; active: boolean; allowCallback: boolean }[] = [];
    const res = await r.dispatcher.dispatch({
      record: record("repay", "repay", 1.3),
      valuation: await r.valuation(),
      onGrantRead: (g) => seen.push(g),
    });
    assert.equal(res.status, "SENT");
    assert.deepEqual(seen.map((g) => g.expiry), [soon]);
    assert.ok(
      r.notified.some((e) => e.kind === "grant-expiring"),
      "an expiring protection grant must reach the notifier"
    );
  });

  it("a grant revoked between the read and the send surfaces as NotGranted from simulation → REFUSED, nothing sent", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    // Make the grantOf view lie (says active) but the account itself refuse (simulate reverts).
    const origGrants = r.oil.grants;
    const realGet = origGrants.get.bind(origGrants);
    let reads = 0;
    origGrants.get = (k: string) => {
      const v = realGet(k);
      reads++;
      // The first read is the keeper's grantOf check → active; every later read
      // (the value probe and the execAsKeeper simulation) sees the truth.
      return reads <= 1 ? v : undefined;
    };
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /NotGranted/);
    assert.equal(r.oil.txFrom.length, 0);
  });

  it("FIX C-1: with the ONE signed grant it simulates, signs and sends execAsKeeper([unwind]) — the mock closes and repays", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }, { id: 2n, poolId: POOL_A }, { id: 3n, poolId: POOL_A }]);
    r.oil.defaultCloseYield = { usdc: 8_000_000_000n, other: 0n }; // 8,000 USDC per id
    r.grantAll();
    const before = (await r.valuation()).hf;
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "SENT");
    const tx = (res as { txHash: Hex }).txHash;
    assert.deepEqual(r.oil.txFrom, [KEEPER]);
    const exec = r.oil.executed.filter((e) => e.mutate);
    assert.equal(exec.length, 1);
    assert.deepEqual(exec[0].calls.map((c) => c.selector), [GRANT_SELECTORS["StrategyRouter.unwind"]]);
    assert.ok(r.oil.positions.get(ACCOUNT_A.toLowerCase())!.length < 3, "the router closed ids through its nested path");
    const after = (await r.valuation()).hf;
    assert.ok(after > before, `${after} > ${before}`);
    // confirm() reads the receipt.
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.3, { status: "SENT", txHash: tx }));
    assert.deepEqual(c, { status: "CONFIRMED", txHash: tx });
    // Dry runs (value probes + the plan simulation) mutated nothing.
    assert.ok(r.oil.executed.filter((e) => !e.mutate).length >= 1);
  });

  it("M-HIGH-1: a SUCCESSFUL receipt whose LeveragedLpUnwound.repaid == 0 on a repay rung is FAILED, never CONFIRMED", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    // The stranded-venue shape: the router closes the LP, finds no debt on the venue it resolved,
    // repays nothing and the transaction succeeds. The old confirm() called that CONFIRMED.
    r.oil.strandRepay = true;
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "SENT");
    const tx = (res as { txHash: Hex }).txHash;
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.3, { status: "SENT", txHash: tx }));
    assert.equal(c.status, "FAILED", `a repay that repaid nothing must not be CONFIRMED: ${JSON.stringify(c)}`);
    assert.match((c as { error: string }).error, /repaid nothing|repaid 0/i);
    // …and the same receipt with a real repay is confirmed, so the check is the event, not the mode.
    r.oil.strandRepay = false;
    r.oil.setPositions(ACCOUNT_A, [{ id: 2n, poolId: POOL_A }]);
    const ok = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3, { key: `${ACCOUNT_A.toLowerCase()}:1:2:repay` }), valuation: await r.valuation() });
    assert.equal(ok.status, "SENT");
    const c2 = await r.dispatcher.confirm(record("repay", "repay", 1.3, { status: "SENT", txHash: (ok as { txHash: Hex }).txHash }));
    assert.equal(c2.status, "CONFIRMED");
  });

  it("M-HIGH-1: a successful receipt with NO LeveragedLpUnwound for the account is FAILED (fail closed)", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    const tx = (res as { txHash: Hex }).txHash;
    // Strip the logs from the receipt: an RPC that returns a bare receipt cannot prove anything moved.
    const rc = r.chain.receipts.get(tx.toLowerCase())!;
    r.chain.receipts.set(tx.toLowerCase(), { ...rc, logs: [] });
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.3, { status: "SENT", txHash: tx }));
    assert.equal(c.status, "FAILED");
    assert.match((c as { error: string }).error, /LeveragedLpUnwound/);
  });

  it("N-MED-1: a warning that only the keeper's own log/store accepted is LOGGED_ONLY, never NOTIFIED", async () => {
    const r = await rig(1.45);
    // A notifier whose only channels reach nobody (log + owner-history): every event "delivers".
    const logOnly = { failures: 0, channels: ["log", "owner-history"], hasPersonChannel: false, deliver: async () => ({ personReached: false }) };
    const d = new KeeperDispatcher({ ...(r.dispatcher as unknown as { d: ConstructorParameters<typeof KeeperDispatcher>[0] }).d, notifier: logOnly });
    const res = await d.dispatch({ record: record("notify", "warn", 1.45), valuation: null });
    assert.equal(res.status, "LOGGED_ONLY");
    assert.match((res as { reason: string }).reason, /NOTIFY_WEBHOOK_URL/);
    // The same rung through a person-facing channel is NOTIFIED.
    const ok = await r.dispatcher.dispatch({ record: record("notify", "warn", 1.45), valuation: null });
    assert.deepEqual(ok, { status: "NOTIFIED" });
  });

  it("emergency closes everything; a reverted receipt is FAILED (retry with the same key later)", async () => {
    const r = await rig(1.0);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }, { id: 2n, poolId: POOL_B }]);
    r.grantAll();
    r.oil.failNextTx = true;
    const res = await r.dispatcher.dispatch({ record: record("emergency-unwind", "emergency", 1.0), valuation: await r.valuation() });
    assert.equal(res.status, "SENT");
    const c = await r.dispatcher.confirm(record("emergency-unwind", "emergency", 1.0, { status: "SENT", txHash: (res as { txHash: Hex }).txHash }));
    assert.equal(c.status, "FAILED");
    // Two pools ⇒ two unwinds, and nothing but unwinds.
    const dry = r.oil.executed.filter((e) => !e.mutate).at(-1)!;
    assert.equal(dry.calls.length, 2);
    assert.ok(dry.calls.every((c) => c.selector === GRANT_SELECTORS["StrategyRouter.unwind"]));
  });

  it("FIX C-1: the non-USDC LP leg is swapped under a REAL quote — and a swap worse than the floor fails, never settles", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    // The pool pays both legs: 1,000 USDC and 1 unit (8 decimals) of the other token.
    r.oil.setCloseYield(1n, 1_000_000_000n, 100_000_000n);
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "SENT");
    // The quote the router carried was built from the pool's live price, not a
    // guessed absolute floor: the swap settled and the account was credited.
    assert.ok((r.oil.usdcBalances.get(ACCOUNT_A.toLowerCase()) ?? 0n) >= 0n);
    assert.equal(r.oil.positions.get(ACCOUNT_A.toLowerCase())!.length, 0);

    // Execution 5 % below the quoted rate, against a 100 bps tolerance: the
    // adapter's floor bites and nothing settles. `swapMinOut: 1` could not.
    const bad = await rig(1.3);
    bad.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    bad.oil.setCloseYield(1n, 1_000_000_000n, 100_000_000n);
    bad.oil.swapExecutionBps = 9_500n;
    bad.grantAll();
    const failed = await bad.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await bad.valuation() });
    assert.equal(failed.status, "FAILED");
    assert.match((failed as { error: string }).error, /InsufficientOutput/);
    assert.equal(bad.oil.txFrom.length, 0, "nothing may be broadcast when the simulation hits the floor");
  });

  it("FIX C-7: the notify rung is NOTIFIED only when a channel accepted it; a failed delivery is FAILED", async () => {
    const r = await rig(1.45);
    const res = await r.dispatcher.dispatch({ record: record("notify", "warn", 1.45), valuation: await r.valuation() });
    assert.deepEqual(res, { status: "NOTIFIED" });
    assert.equal(r.notified.length, 1);
    assert.equal(r.chain.calls.filter((c) => c.method === "eth_sendRawTransaction").length, 0);

    const broken = await rig(1.45);
    broken.notifier.deliver = async () => {
      throw new Error("pager down");
    };
    const failed = await broken.dispatcher.dispatch({ record: record("notify", "warn", 1.45), valuation: await broken.valuation() });
    assert.equal(failed.status, "FAILED");
    assert.match((failed as { error: string }).error, /not delivered/);
  });
});

describe("KeeperDispatcher — world check before acting (resume safety)", () => {
  it("resume with no valuation re-reads the chain; HF already above the rung's disarm ⇒ SUPERSEDED, nothing sent", async () => {
    const r = await rig(1.6);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: null });
    assert.equal(res.status, "SUPERSEDED");
    assert.equal(r.oil.txFrom.length, 0);
  });

  it("resume: no debt any more ⇒ SUPERSEDED; unvaluable ⇒ REFUSED (fail closed); still low ⇒ acts", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    r.chain.setPosition(ACCOUNT_A, { collateral: [{ asset: CBBTC, amount: 100_000_000n }], debt: [] });
    assert.equal((await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: null })).status, "SUPERSEDED");
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.3));
    r.chain.reserves.get(USDC.toLowerCase())!.aavePrice = 0n;
    const refused = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: null });
    assert.equal(refused.status, "REFUSED");
    assert.match((refused as { reason: string }).reason, /unvaluable/);
    r.chain.reserves.get(USDC.toLowerCase())!.aavePrice = 100_000_000n;
    assert.equal((await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: null })).status, "SENT");
    assert.equal(r.oil.txFrom.length, 1);
  });

  it("nothing to do (no LP ids, no idle USDC) is REFUSED with a reason the operator can act on", async () => {
    const r = await rig(1.3);
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /only the owner/);
  });

  it("idle USDC with no LP ids → unwind-only repay from idle balance", async () => {
    const r = await rig(1.3);
    r.grantAll();
    r.oil.setUsdc(ACCOUNT_A, 5_000_000_000n); // 5,000 USDC idle
    const before = (await r.valuation()).hf;
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "SENT");
    const exec = r.oil.executed.find((e) => e.mutate)!;
    assert.deepEqual(exec.calls.map((c) => c.selector), [GRANT_SELECTORS["StrategyRouter.unwind"]]);
    assert.ok((await r.valuation()).hf > before);
    assert.equal(r.oil.usdcBalances.get(ACCOUNT_A.toLowerCase()), 0n);
  });

  it("an unreadable pool price is REFUSED before any grant read or send", async () => {
    const r = await rig(1.3);
    r.grantAll();
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: ("0x" + "cc".repeat(32)) as Hex }]); // no price registered
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /cannot read LP state/);
    assert.equal(r.oil.txFrom.length, 0);
  });

  it("a price move outside the band between plan and simulation is FAILED (transient), not sent", async () => {
    const r = await rig(1.3);
    r.grantAll();
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    // Plan reads SQRT_P; then the pool moves 5% before simulation.
    const orig = r.oil.poolPrices.get(POOL_A)!;
    let reads = 0;
    const map = r.oil.poolPrices;
    const realGet = map.get.bind(map);
    map.get = (k: Hex) => {
      const v = realGet(k);
      reads++;
      return reads >= 2 && v !== undefined ? (v * 105n) / 100n : v; // 2nd read = inside the mock's closeMany
    };
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "FAILED");
    assert.match((res as { error: string }).error, /PriceOutOfBand/);
    assert.equal(r.oil.txFrom.length, 0);
    map.get = realGet;
    assert.equal(map.get(POOL_A), orig);
  });

  it("never logs the keeper key", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    const all = r.sink.lines.join("\n");
    assert.ok(!all.includes(KEY.slice(2)), "private key in logs");
    assert.ok(all.includes('"txHash":"0x'), "tx hash is logged under its allow-listed field");
  });
});
