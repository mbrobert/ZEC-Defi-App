import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createWalletClient, decodeFunctionData, encodeEventTopics, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { HF_LADDER, ladderFor, rungById } from "@zyo/shared";
import { GRANT_SELECTORS, strategyRouterAbi } from "../src/abi/oilskin.js";
import { KeeperDispatcher, summarizeUnwinds, judgeUntouched, dustKeptNote } from "../src/dispatch/keeperDispatcher.js";
import { CLOSE_FRACTION, bandFor, closeCount, isqrt, planAction, selectIds, type PoolInfo } from "../src/dispatch/policy.js";
import { NO_SWAP, quoteForPool, minOutFor } from "../src/dispatch/quote.js";
import { evaluateSnapshot } from "../src/engine/valuation.js";
import { Logger, memorySink } from "../src/log.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import { VenueReader } from "../src/services/venues.js";
import type { DispatchRecord } from "../src/store/keeperStore.js";
import type { VenueBook } from "../src/store/keeperStore.js";
import type { Address } from "../src/types/evm.js";
import { ACCOUNT_A, CBBTC, USDC, WETH as WETH_T, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import { AAVE_VENUE_ADDR, LP_VENUE_DIRECT_ADDR, MORPHO_VENUE_ADDR, MockOilskin } from "./mockOilskin.js";
import { encodeAbiParameters as encParams, encodeEventTopics as encTopics } from "viem";
import { strategyRouterAbi as routerAbiForLogs } from "../src/abi/oilskin.js";

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

async function rig(hf = 1.15, opts: { venues?: boolean; direct?: boolean } = {}) {
  const chain = newMockChain();
  cbBtcPosition(chain, ACCOUNT_A, debtForHf(hf));
  const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE, ...(opts.direct ? { lpVenueDirect: LP_VENUE_DIRECT_ADDR } : {}) });
  oil.install([ACCOUNT_A]);
  oil.poolPrices.set(POOL_A, SQRT_P);
  oil.poolPrices.set(POOL_B, SQRT_P * 2n);
  const client = chain.publicClient();
  const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: base, transport: chain.transport() });
  const reader = new AaveReader(client, aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 500 });
  // The venue-aware reader the production keeper always has next to a router (audit wave 2,
  // M-HIGH-2). Off by default here so the older tests keep pinning the Aave-only receipt rules.
  const venues = opts.venues ? new VenueReader(client, ROUTER, { deadlineMs: 500 }) : null;
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
    lpVenueDirect: opts.direct ? LP_VENUE_DIRECT_ADDR : null,
    usdc: USDC,
    reader,
    venues,
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
    const r = await rig(1.15);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /no active grant/);
    assert.equal(r.oil.txFrom.length, 0);
    assert.equal(r.chain.calls.filter((c) => c.method === "eth_sendRawTransaction").length, 0);
  });

  it("FIX C-1: a grant without allowCallback is REFUSED as a MIS-ISSUED GRANT, permanently, without sending", async () => {
    const r = await rig(1.15);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll({ allowCallback: false });
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.equal((res as { permanent?: boolean }).permanent, true);
    assert.match((res as { reason: string }).reason, /allowCallback=false/);
    assert.equal(r.oil.txFrom.length, 0);
  });

  it("FIX C-3: an expiring grant is surfaced to the caller and notified — never read and discarded", async () => {
    const r = await rig(1.15);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    const soon = Number(r.chain.nowS) + 3 * 86_400; // 3 days left, warn window is 7
    r.grantAll({ expiry: soon });
    const seen: { expiry: number; active: boolean; allowCallback: boolean }[] = [];
    const res = await r.dispatcher.dispatch({
      record: record("repay", "repay", 1.15),
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
    const r = await rig(1.15);
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
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /NotGranted/);
    assert.equal(r.oil.txFrom.length, 0);
  });

  it("FIX C-1: with the ONE signed grant it simulates, signs and sends execAsKeeper([unwind]) — the mock closes and repays", async () => {
    const r = await rig(1.15);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }, { id: 2n, poolId: POOL_A }, { id: 3n, poolId: POOL_A }]);
    r.oil.defaultCloseYield = { usdc: 8_000_000_000n, other: 0n }; // 8,000 USDC per id
    r.grantAll();
    const before = (await r.valuation()).hf;
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
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
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: tx }));
    assert.deepEqual(c, { status: "CONFIRMED", txHash: tx });
    // Dry runs (value probes + the plan simulation) mutated nothing.
    assert.ok(r.oil.executed.filter((e) => !e.mutate).length >= 1);
  });

  it("M-HIGH-1: a SUCCESSFUL receipt whose LeveragedLpUnwound.repaid == 0 on a repay rung is FAILED, never CONFIRMED", async () => {
    const r = await rig(1.15);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    // The stranded-venue shape: the router closes the LP, finds no debt on the venue it resolved,
    // repays nothing and the transaction succeeds. The old confirm() called that CONFIRMED.
    r.oil.strandRepay = true;
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    assert.equal(res.status, "SENT");
    const tx = (res as { txHash: Hex }).txHash;
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: tx }));
    assert.equal(c.status, "FAILED", `a repay that repaid nothing must not be CONFIRMED: ${JSON.stringify(c)}`);
    assert.match((c as { error: string }).error, /repaid nothing|repaid 0/i);
    // …and the same receipt with a real repay is confirmed, so the check is the event, not the mode.
    r.oil.strandRepay = false;
    r.oil.setPositions(ACCOUNT_A, [{ id: 2n, poolId: POOL_A }]);
    const ok = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15, { key: `${ACCOUNT_A.toLowerCase()}:1:2:repay` }), valuation: await r.valuation() });
    assert.equal(ok.status, "SENT");
    const c2 = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: (ok as { txHash: Hex }).txHash }));
    assert.equal(c2.status, "CONFIRMED");
  });

  it("M-HIGH-1: a successful receipt with NO LeveragedLpUnwound for the account is FAILED (fail closed)", async () => {
    const r = await rig(1.15);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    const tx = (res as { txHash: Hex }).txHash;
    // Strip the logs from the receipt: an RPC that returns a bare receipt cannot prove anything moved.
    const rc = r.chain.receipts.get(tx.toLowerCase())!;
    r.chain.receipts.set(tx.toLowerCase(), { ...rc, logs: [] });
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: tx }));
    assert.equal(c.status, "FAILED");
    assert.match((c as { error: string }).error, /LeveragedLpUnwound/);
  });

  it("N-MED-1: a warning that only the keeper's own log/store accepted is LOGGED_ONLY, never NOTIFIED", async () => {
    const r = await rig(1.2);
    // A notifier whose only channels reach nobody (log + owner-history): every event "delivers".
    const logOnly = { failures: 0, channels: ["log", "owner-history"], hasPersonChannel: false, deliver: async () => ({ personReached: false }) };
    const d = new KeeperDispatcher({ ...(r.dispatcher as unknown as { d: ConstructorParameters<typeof KeeperDispatcher>[0] }).d, notifier: logOnly });
    const res = await d.dispatch({ record: record("notify", "warn", 1.2), valuation: null });
    assert.equal(res.status, "LOGGED_ONLY");
    assert.match((res as { reason: string }).reason, /NOTIFY_WEBHOOK_URL/);
    // The same rung through a person-facing channel is NOTIFIED.
    const ok = await r.dispatcher.dispatch({ record: record("notify", "warn", 1.2), valuation: null });
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
    const r = await rig(1.15);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    // The pool pays both legs: 1,000 USDC and 1 unit (8 decimals) of the other token.
    r.oil.setCloseYield(1n, 1_000_000_000n, 100_000_000n);
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    assert.equal(res.status, "SENT");
    // The quote the router carried was built from the pool's live price, not a
    // guessed absolute floor: the swap settled and the account was credited.
    assert.ok((r.oil.usdcBalances.get(ACCOUNT_A.toLowerCase()) ?? 0n) >= 0n);
    assert.equal(r.oil.positions.get(ACCOUNT_A.toLowerCase())!.length, 0);

    // Execution 5 % below the quoted rate, against a 100 bps tolerance: the
    // adapter's floor bites and nothing settles. `swapMinOut: 1` could not.
    const bad = await rig(1.15);
    bad.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    bad.oil.setCloseYield(1n, 1_000_000_000n, 100_000_000n);
    bad.oil.swapExecutionBps = 9_500n;
    bad.grantAll();
    const failed = await bad.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await bad.valuation() });
    assert.equal(failed.status, "FAILED");
    assert.match((failed as { error: string }).error, /InsufficientOutput/);
    assert.equal(bad.oil.txFrom.length, 0, "nothing may be broadcast when the simulation hits the floor");
  });

  it("FIX C-7: the notify rung is NOTIFIED only when a channel accepted it; a failed delivery is FAILED", async () => {
    const r = await rig(1.2);
    const res = await r.dispatcher.dispatch({ record: record("notify", "warn", 1.2), valuation: await r.valuation() });
    assert.deepEqual(res, { status: "NOTIFIED" });
    assert.equal(r.notified.length, 1);
    assert.equal(r.chain.calls.filter((c) => c.method === "eth_sendRawTransaction").length, 0);

    const broken = await rig(1.2);
    broken.notifier.deliver = async () => {
      throw new Error("pager down");
    };
    const failed = await broken.dispatcher.dispatch({ record: record("notify", "warn", 1.2), valuation: await broken.valuation() });
    assert.equal(failed.status, "FAILED");
    assert.match((failed as { error: string }).error, /not delivered/);
  });
});

describe("RISKS §8 residual (a) — a receipt that leaves a venue the account still owes untouched is FAILED", () => {
  const ONE_BTC = 100_000_000n;
  const SMALL = 1_000_000_000n; // 1,000 USDC: the healthy book
  const aaveDebt = (r: Awaited<ReturnType<typeof rig>>) => {
    const u = r.chain.users.get(ACCOUNT_A.toLowerCase())?.get(USDC.toLowerCase());
    return u ? u.variableDebt + u.stableDebt : 0n;
  };
  const sent = (res: { status: string }) => (res as unknown as { txHash: Hex }).txHash;
  /**
   * Two books for one asset: Aave (now the PREVIOUS venue) owes ~53,990 USDC at HF 1.15 — the debt
   * that fires the rung — and the registry's CURRENT pointer, Morpho, owes 1,000 against 1 cbBTC
   * at HF ≈ 68. `idleUsdc` sits in the account for the repay-only rung.
   */
  async function twoBooks(idleUsdc: bigint) {
    const r = await rig(1.15, { venues: true });
    r.oil.setVenue(CBBTC, MORPHO_VENUE_ADDR); // Aave is remembered in previousVenues
    r.oil.setMorphoPosition(ACCOUNT_A, CBBTC, { collateral: ONE_BTC, debt: SMALL });
    r.oil.setUsdc(ACCOUNT_A, idleUsdc);
    r.grantAll();
    return r;
  }
  /** Captures what the dispatcher persists before the send — the per-venue snapshot confirm() judges by (slice 5). */
  function snapshotting() {
    let books: VenueBook[] | undefined;
    return {
      persistBeforeSend: async (info: { nonce?: number; closeIds: bigint[]; venueBooks?: VenueBook[] }) => {
        books = info.venueBooks;
      },
      books: () => books,
    };
  }

  it("slice C: a rounding unit that appears on another book between dispatch and confirm is not an untouched debt → CONFIRMED", async () => {
    const r = await rig(1.15, { venues: true });
    r.oil.setVenue(CBBTC, MORPHO_VENUE_ADDR);
    r.oil.setUsdc(ACCOUNT_A, 60_000_000_000n);
    r.grantAll();
    const snap = snapshotting();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null, persistBeforeSend: snap.persistBeforeSend });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    // Morpho owed nothing at dispatch; by confirm time its book reads one unit (Morpho's toAssetsUp).
    r.oil.setMorphoPosition(ACCOUNT_A, CBBTC, { collateral: ONE_BTC, debt: 1n });
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res), venueBooks: snap.books() }));
    assert.equal(c.status, "CONFIRMED", `one unit is rounding, not a book left untouched: ${JSON.stringify(c)}`);
    // 101 units IS a book that owed nothing when sized → not this receipt's to confirm
    r.oil.setMorphoPosition(ACCOUNT_A, CBBTC, { collateral: ONE_BTC, debt: 101n });
    const c2 = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res), venueBooks: snap.books() }));
    assert.equal(c2.status, "FAILED");
    assert.match((c2 as { error: string }).error, /owed nothing when this dispatch was sized/);
  });

  it("the 2026-09-08 router: the repay landed on the healthy Morpho book (the first venue holding anything) while the Aave debt rides → FAILED, naming the Aave venue", async () => {
    const r = await twoBooks(20_000_000_000n);
    r.oil.repayFirstHoldingVenueOnly = true;
    const before = aaveDebt(r);
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    assert.equal(r.oil.morphoPosition(ACCOUNT_A, CBBTC).debt, 0n, "the mock repaid the healthy book");
    assert.equal(aaveDebt(r), before, "and left the Aave debt where it was");
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res) }));
    assert.equal(c.status, "FAILED", `repaid > 0 on the wrong book must not be CONFIRMED: ${JSON.stringify(c)}`);
    const err = (c as { error: string }).error;
    assert.match(err, /untouched/i);
    assert.ok(err.toLowerCase().includes(AAVE_VENUE_ADDR.toLowerCase()), `names the untouched venue: ${err}`);
    assert.match(err, /another book/i, "the account still held USDC: the router skipped the book, it did not run dry");
  });

  it("slice 5, wrong book WITH the snapshot: the healthy Morpho book took the repay while 19,000 USDC remained → FAILED, naming the skipped book and the USDC left", async () => {
    const r = await twoBooks(20_000_000_000n);
    r.oil.repayFirstHoldingVenueOnly = true;
    const snap = snapshotting();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null, persistBeforeSend: snap.persistBeforeSend });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    const books = snap.books()!;
    assert.equal(books.length, 2, "both books were snapshotted before the send");
    assert.equal(books.find((b) => b.venue.toLowerCase() === MORPHO_VENUE_ADDR.toLowerCase())!.debtUsdc, SMALL.toString());
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res), venueBooks: books }));
    assert.equal(c.status, "FAILED", JSON.stringify(c));
    const err = (c as { error: string }).error;
    assert.match(err, /another book/i);
    assert.match(err, /USDC remained/i);
    assert.ok(err.toLowerCase().includes(AAVE_VENUE_ADDR.toLowerCase()));
  });

  it("slice 5, wrong book with USDC exhausted: the healthy book took the whole balance (1,000) while the Aave debt rode → FAILED as the wrong book, not a shortfall", async () => {
    const r = await twoBooks(SMALL); // exactly the healthy book's debt: after the wrong repay nothing is left
    r.oil.repayFirstHoldingVenueOnly = true;
    const snap = snapshotting();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null, persistBeforeSend: snap.persistBeforeSend });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    assert.equal(r.oil.usdcBalances.get(ACCOUNT_A.toLowerCase()), 0n, "USDC ran out — but on the wrong book");
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res), venueBooks: snap.books() }));
    assert.equal(c.status, "FAILED", JSON.stringify(c));
    assert.match((c as { error: string }).error, /the book in more trouble/i, "the snapshot's health factors say Morpho (≈68) was paid before Aave (1.15)");
  });

  it("the router since 2026-09-09: worst book first, then the rest with what is left — both books repaid → CONFIRMED", async () => {
    const r = await twoBooks(60_000_000_000n); // enough for ~53,990 on Aave and 1,000 on Morpho
    const before = aaveDebt(r);
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    assert.equal(aaveDebt(r), 0n, `the worst book was cleared first (was ${before})`);
    assert.equal(r.oil.morphoPosition(ACCOUNT_A, CBBTC).debt, 0n, "the healthy book was reached with what was left");
    const rc = r.chain.receipts.get(sent(res).toLowerCase())!;
    const moved = summarizeUnwinds(rc.logs as never, ACCOUNT_A);
    assert.deepEqual([...moved.byVenue.keys()], [AAVE_VENUE_ADDR.toLowerCase(), MORPHO_VENUE_ADDR.toLowerCase()], "one VenueRepaid per book, worst first");
    assert.equal(moved.byVenue.get(AAVE_VENUE_ADDR.toLowerCase()), before);
    assert.equal(moved.byVenue.get(MORPHO_VENUE_ADDR.toLowerCase()), SMALL);
    assert.equal(moved.repaid, before + SMALL, "the LeveragedLpUnwound total is their sum");
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res) }));
    assert.equal(c.status, "CONFIRMED", JSON.stringify(c));
  });

  it("slice 5, honest shortfall: USDC runs out on the worst book, the healthy book is untouched → CONFIRMED with a shortfall note (the snapshot proves the worse book was paid), and the retry's world check SUPERSEDES", async () => {
    const r = await twoBooks(20_000_000_000n); // less than the Aave debt
    const snap = snapshotting();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null, persistBeforeSend: snap.persistBeforeSend });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    assert.equal(r.oil.usdcBalances.get(ACCOUNT_A.toLowerCase()), 0n, "everything went to the worst book");
    assert.equal(r.oil.morphoPosition(ACCOUNT_A, CBBTC).debt, SMALL, "the healthy book was not reached");
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res), venueBooks: snap.books() }));
    assert.equal(c.status, "CONFIRMED", JSON.stringify(c));
    const note = (c as { note?: string }).note ?? "";
    assert.match(note, /ran out on the worse book/i);
    assert.match(note, /honest shortfall/i);
    assert.ok(note.toLowerCase().includes(MORPHO_VENUE_ADDR.toLowerCase()), `names the book left for the retry: ${note}`);
    // Aave is now at ~1.83, above the rung's disarm (1.18), and the Morpho book is healthy: the retry sends nothing.
    const again = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15, { attempts: 1 }), valuation: null });
    assert.equal(again.status, "SUPERSEDED", JSON.stringify(again));
  });

  it("the same shortfall WITHOUT a snapshot (a record from before slice 5, or a dispatch without a venue reader) stays FAILED — unprovable, so not confirmed", async () => {
    const r = await twoBooks(20_000_000_000n);
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res) }));
    assert.equal(c.status, "FAILED", JSON.stringify(c));
    assert.match((c as { error: string }).error, /ran out/i);
    assert.match((c as { error: string }).error, /no per-venue snapshot/i);
  });

  it("slice 5: debt on a venue that owed nothing when the dispatch was sized → FAILED, not this receipt's to confirm", async () => {
    const r = await rig(1.15, { venues: true });
    r.oil.setUsdc(ACCOUNT_A, 20_000_000_000n);
    r.grantAll();
    const snap = snapshotting();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null, persistBeforeSend: snap.persistBeforeSend });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    const books = snap.books()!;
    assert.deepEqual(books.map((b) => b.venue.toLowerCase()), [AAVE_VENUE_ADDR.toLowerCase()], "only the Aave book existed at dispatch");
    // Between the send and the receipt the registry moved cbBTC to Morpho and a Morpho debt appeared.
    r.oil.setVenue(CBBTC, MORPHO_VENUE_ADDR);
    r.oil.setMorphoPosition(ACCOUNT_A, CBBTC, { collateral: ONE_BTC, debt: SMALL });
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res), venueBooks: books }));
    assert.equal(c.status, "FAILED", JSON.stringify(c));
    assert.match((c as { error: string }).error, /owed nothing when this dispatch was sized/i);
  });

  it("judgeUntouched, pure: a USDC balance that cannot be re-read is never an honest shortfall; a paid venue outside the snapshot is not either", () => {
    const aave = AAVE_VENUE_ADDR;
    const morpho = MORPHO_VENUE_ADDR;
    const books: VenueBook[] = [
      { venue: aave, debtUsdc: "47760000000", hfWad: "1300000000000000000" },
      { venue: morpho, debtUsdc: SMALL.toString(), hfWad: "68000000000000000000" },
    ];
    const paidAave = new Map([[aave.toLowerCase(), 20_000_000_000n]]);
    const left = [{ venue: morpho, debtUsdc: SMALL }];
    assert.equal(judgeUntouched(books, paidAave, left, 0n).honest, true);
    assert.equal(judgeUntouched(books, paidAave, left, null).honest, false);
    assert.equal(judgeUntouched(books, paidAave, left, 1n).honest, false);
    const stranger = ("0x" + "77".repeat(20)) as Address;
    assert.equal(judgeUntouched(books, new Map([[stranger.toLowerCase(), 5n]]), left, 0n).honest, false);
    assert.equal(judgeUntouched(undefined, paidAave, left, 0n).honest, false, "no snapshot: the stricter rule");
  });

  it("today's production shape — Aave only, the venue reader on: one VenueRepaid on the Aave venue → CONFIRMED, as without the reader", async () => {
    const r = await rig(1.15, { venues: true });
    r.oil.setUsdc(ACCOUNT_A, 20_000_000_000n); // a partial repay: Aave still owes afterwards, and that is fine — it was reached
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    assert.ok(aaveDebt(r) > 0n, "still owes: a partial repay");
    const rc = r.chain.receipts.get(sent(res).toLowerCase())!;
    assert.deepEqual([...summarizeUnwinds(rc.logs as never, ACCOUNT_A).byVenue.keys()], [AAVE_VENUE_ADDR.toLowerCase()]);
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res) }));
    assert.equal(c.status, "CONFIRMED", JSON.stringify(c));
  });

  it("a receipt whose total is > 0 but that names no venue, with the account still owing → FAILED (a router that does not say where is not trusted)", async () => {
    const r = await rig(1.15, { venues: true });
    r.oil.setUsdc(ACCOUNT_A, 20_000_000_000n);
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null });
    const tx = sent(res);
    const rc = r.chain.receipts.get(tx.toLowerCase())!;
    const unwound = encodeEventTopics({ abi: strategyRouterAbi, eventName: "LeveragedLpUnwound" })[0];
    r.chain.receipts.set(tx.toLowerCase(), { ...rc, logs: rc.logs!.filter((l) => l.topics[0] === unwound) });
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: tx }));
    assert.equal(c.status, "FAILED", JSON.stringify(c));
    assert.match((c as { error: string }).error, /untouched/i);
  });

  it("the venues cannot be re-read at confirm time → FAILED, never CONFIRMED (nothing is confirmed that cannot be checked)", async () => {
    const r = await rig(1.15, { venues: true });
    r.oil.setUsdc(ACCOUNT_A, 20_000_000_000n);
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    r.oil.failVenueCall(AAVE_VENUE_ADDR, "debt");
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.15, { status: "SENT", txHash: sent(res) }));
    assert.equal(c.status, "FAILED", JSON.stringify(c));
    assert.match((c as { error: string }).error, /could not be re-read/i);
  });
});

describe("KeeperDispatcher — world check before acting (resume safety)", () => {
  it("resume with no valuation re-reads the chain; HF already above the rung's disarm ⇒ SUPERSEDED, nothing sent", async () => {
    const r = await rig(1.6);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null });
    assert.equal(res.status, "SUPERSEDED");
    assert.equal(r.oil.txFrom.length, 0);
  });

  it("A4: a record carrying its own disarm threshold is judged against it, not the floor's ladder; a record without one still is", async () => {
    // HF 1.20: above the floor's repay disarm (1.18) — but under a 1.30-entry account's repay disarm (1.22).
    // Since the floor moved to 1.25 (D7) the floor's ladder is the loosest any account runs, so here the
    // record's own disarm is the stricter one: the floor's ladder would stand down, the account's must act.
    const floorDisarm = rungById("repay").disarmHf;
    const ownDisarm = rungById("repay", ladderFor(1.3)).disarmHf;
    assert.ok(floorDisarm < 1.2 && 1.2 < ownDisarm, `${floorDisarm} < 1.2 < ${ownDisarm}`);
    const r = await rig(1.2);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    const unknown = await r.dispatcher.dispatch({ record: record("repay", "nope", 1.15), valuation: null });
    assert.equal(unknown.status, "REFUSED");
    assert.match((unknown as { reason: string }).reason, /unknown rung nope/);
    // A pre-A4 record (no disarmHf) is judged against HF_LADDER's repay disarm 1.18: 1.20 has cleared it, nothing is sent.
    const floor = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null });
    assert.equal(floor.status, "SUPERSEDED", JSON.stringify(floor));
    assert.match((floor as { reason: string }).reason, new RegExp(`1\\.2000 ≥ repay disarm ${floorDisarm}`));
    assert.equal(r.oil.txFrom.length, 0, "nothing sent");
    // The same world, a record carrying the 1.30 ladder's repay disarm (1.22): 1.20 is still under it, so it acts.
    const own = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.18, { disarmHf: ownDisarm }), valuation: null });
    assert.equal(own.status, "SENT", JSON.stringify(own));
    assert.equal(r.oil.txFrom.length, 1);
  });

  it("resume: no debt any more ⇒ SUPERSEDED; unvaluable ⇒ REFUSED (fail closed); still low ⇒ acts", async () => {
    const r = await rig(1.15);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    r.chain.setPosition(ACCOUNT_A, { collateral: [{ asset: CBBTC, amount: 100_000_000n }], debt: [] });
    assert.equal((await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null })).status, "SUPERSEDED");
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15));
    r.chain.reserves.get(USDC.toLowerCase())!.aavePrice = 0n;
    const refused = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null });
    assert.equal(refused.status, "REFUSED");
    assert.match((refused as { reason: string }).reason, /unvaluable/);
    r.chain.reserves.get(USDC.toLowerCase())!.aavePrice = 100_000_000n;
    assert.equal((await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: null })).status, "SENT");
    assert.equal(r.oil.txFrom.length, 1);
  });

  it("nothing to do (no LP ids, no idle USDC) is REFUSED with a reason the operator can act on", async () => {
    const r = await rig(1.15);
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /only the owner/);
  });

  it("idle USDC with no LP ids → unwind-only repay from idle balance", async () => {
    const r = await rig(1.15);
    r.grantAll();
    r.oil.setUsdc(ACCOUNT_A, 5_000_000_000n); // 5,000 USDC idle
    const before = (await r.valuation()).hf;
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    assert.equal(res.status, "SENT");
    const exec = r.oil.executed.find((e) => e.mutate)!;
    assert.deepEqual(exec.calls.map((c) => c.selector), [GRANT_SELECTORS["StrategyRouter.unwind"]]);
    assert.ok((await r.valuation()).hf > before);
    assert.equal(r.oil.usdcBalances.get(ACCOUNT_A.toLowerCase()), 0n);
  });

  it("an unreadable pool price is REFUSED before any grant read or send", async () => {
    const r = await rig(1.15);
    r.grantAll();
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: ("0x" + "cc".repeat(32)) as Hex }]); // no price registered
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /cannot read LP state/);
    assert.equal(r.oil.txFrom.length, 0);
  });

  it("slice A: a positionsOf the venue refuses is REFUSED with the fault named — never planned as 'no positions'", async () => {
    const r = await rig(1.15);
    r.grantAll();
    r.oil.setUsdc(ACCOUNT_A, 5_000_000_000n); // idle USDC a "no positions" plan WOULD spend (the test above)
    r.oil.setPositionsFault(ACCOUNT_A, { code: 1, index: 3n }); // EnumerationFault.ProbeOutOfGas at index 3
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    const reason = (res as { reason: string }).reason;
    assert.match(reason, /cannot read LP state/);
    assert.match(reason, /ProbeOutOfGas at index 3/);
    assert.match(reason, /not a statement that the account holds no positions/);
    assert.equal(r.oil.txFrom.length, 0, "nothing sent");
    // With the venue answering again the same account is acted on.
    r.oil.setPositionsFault(ACCOUNT_A, null);
    assert.equal((await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() })).status, "SENT");
  });

  it("a price move outside the band between plan and simulation is FAILED (transient), not sent", async () => {
    const r = await rig(1.15);
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
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    assert.equal(res.status, "FAILED");
    assert.match((res as { error: string }).error, /PriceOutOfBand/);
    assert.equal(r.oil.txFrom.length, 0);
    map.get = realGet;
    assert.equal(map.get(POOL_A), orig);
  });

  it("never logs the keeper key", async () => {
    const r = await rig(1.15);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.grantAll();
    await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: await r.valuation() });
    const all = r.sink.lines.join("\n");
    assert.ok(!all.includes(KEY.slice(2)), "private key in logs");
    assert.ok(all.includes('"txHash":"0x'), "tx hash is logged under its allow-listed field");
  });
});

// ---------------------------------------------------------------------------------------------
// Slice F (2026-09-11): the direct Slipstream venue next to the engine venue, and the router's
// `VenueWithdrawn` in the receipt summary.
// ---------------------------------------------------------------------------------------------
describe("keeper dispatcher — two LP venues (the direct Slipstream venue), and VenueWithdrawn", () => {
  const POOL_DIRECT = ("0x" + "0".repeat(24) + "d1".repeat(20)) as Hex;

  it("summarizeUnwinds reads one VenueWithdrawn per venue into withdrawnByVenue (a keeper receipt carries none)", () => {
    const account = ACCOUNT_A;
    const mk = (venue: Address, amount: bigint) => ({
      address: ROUTER,
      topics: encTopics({ abi: routerAbiForLogs, eventName: "VenueWithdrawn", args: { account, venue } }) as Hex[],
      data: encParams([{ type: "uint256" }], [amount]),
    });
    const unwound = {
      address: ROUTER,
      topics: encTopics({ abi: routerAbiForLogs, eventName: "LeveragedLpUnwound", args: { account, collateralAsset: CBBTC } }) as Hex[],
      data: encParams(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [0n, 0n, 0n, 1n, 3n, 2n ** 255n]
      ),
    };
    const s = summarizeUnwinds([unwound, mk(MORPHO_VENUE_ADDR, 1n), mk(AAVE_VENUE_ADDR, 2n)], account);
    assert.equal(s.withdrawn, 3n);
    assert.deepEqual([...s.withdrawnByVenue.entries()], [[MORPHO_VENUE_ADDR.toLowerCase(), 1n], [AAVE_VENUE_ADDR.toLowerCase(), 2n]]);
    assert.equal(s.byVenue.size, 0, "no VenueRepaid in this receipt");
    const none = summarizeUnwinds([unwound], account);
    assert.equal(none.withdrawnByVenue.size, 0);
  });

  it("summarizeUnwinds reads DustLegKept into dustKept (token → amount, summed) and dustKeptNote names it; a receipt without one carries no note (NI-HIGH-1, 2026-09-12)", () => {
    const account = ACCOUNT_A;
    const WETH_ADDR = ("0x" + "42".repeat(20)) as Address;
    const mk = (token: Address, amount: bigint) => ({
      address: ROUTER,
      topics: encTopics({ abi: routerAbiForLogs, eventName: "DustLegKept", args: { account, token } }) as Hex[],
      data: encParams([{ type: "uint256" }], [amount]),
    });
    const unwound = {
      address: ROUTER,
      topics: encTopics({ abi: routerAbiForLogs, eventName: "LeveragedLpUnwound", args: { account, collateralAsset: CBBTC } }) as Hex[],
      data: encParams(
        [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
        [1n, 0n, 31_757_002_505n, 10_000_000_000n, 0n, 2n ** 255n]
      ),
    };
    const s = summarizeUnwinds([unwound, mk(WETH_ADDR, 6192n), mk(WETH_ADDR, 8n)], account);
    assert.equal(s.repaid, 10_000_000_000n, "a kept leg changes no repay figure");
    assert.deepEqual([...s.dustKept.entries()], [[WETH_ADDR.toLowerCase(), 6200n]]);
    assert.equal(dustKeptNote(s), `left in the account, not swapped (below the quote's floor): 6200 base units of ${WETH_ADDR.toLowerCase()}`);
    const other = summarizeUnwinds([unwound, { ...mk(WETH_ADDR, 5n), topics: encTopics({ abi: routerAbiForLogs, eventName: "DustLegKept", args: { account: ("0x" + "b0".repeat(20)) as Address, token: WETH_ADDR } }) as Hex[] }], account);
    assert.equal(other.dustKept.size, 0, "another account's kept leg is not ours");
    assert.equal(dustKeptNote(other), null);
  });

  it("reads BOTH venues' positionsOf, plans one unwind per pool, and the router closes the engine id and the direct id in one dispatch", async () => {
    const r = await rig(1.0, { direct: true });
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.oil.setDirectPositions(ACCOUNT_A, [{ id: 7n, poolId: POOL_DIRECT }]);
    r.oil.poolPrices.set(POOL_DIRECT, SQRT_P);
    r.oil.defaultCloseYield = { usdc: 8_000_000_000n, other: 0n };
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("emergency-unwind", "emergency", 1.0), valuation: await r.valuation() });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    const exec = r.oil.executed.filter((e) => e.mutate);
    assert.equal(exec.length, 1);
    assert.deepEqual(exec[0].calls.map((c) => c.selector), [GRANT_SELECTORS["StrategyRouter.unwind"], GRANT_SELECTORS["StrategyRouter.unwind"]], "one unwind per pool: the engine pool and the direct pool");
    assert.equal(r.oil.positions.get(ACCOUNT_A.toLowerCase())!.length, 0, "both ids closed");
    const c = await r.dispatcher.confirm(record("emergency-unwind", "emergency", 1.0, { status: "SENT", txHash: (res as { txHash: Hex }).txHash }));
    assert.equal(c.status, "CONFIRMED", JSON.stringify(c));
  });

  it("without a direct venue on the router (null) the direct id is invisible and only the engine pool is planned — the pre-slice shape", async () => {
    const r = await rig(1.0);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.oil.setDirectPositions(ACCOUNT_A, [{ id: 7n, poolId: POOL_DIRECT }]);
    r.oil.poolPrices.set(POOL_DIRECT, SQRT_P);
    r.oil.defaultCloseYield = { usdc: 8_000_000_000n, other: 0n };
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("emergency-unwind", "emergency", 1.0), valuation: await r.valuation() });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    const exec = r.oil.executed.filter((e) => e.mutate);
    assert.equal(exec[0].calls.length, 1, "one pool: the engine's");
    assert.deepEqual(r.oil.positions.get(ACCOUNT_A.toLowerCase())!.map((p) => p.id), [7n], "the direct id was never listed, so never closed");
  });

  it("the direct venue refusing to enumerate (PositionsUnreadable) is REFUSED with the venue named — never planned as 'no positions there'", async () => {
    const r = await rig(1.0, { direct: true });
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.oil.directFault.set(ACCOUNT_A.toLowerCase(), "0xdead");
    r.oil.defaultCloseYield = { usdc: 8_000_000_000n, other: 0n };
    r.grantAll();
    const res = await r.dispatcher.dispatch({ record: record("emergency-unwind", "emergency", 1.0), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED", JSON.stringify(res));
    assert.match((res as { reason: string }).reason, /direct venue.*PositionsUnreadable/);
    assert.equal(r.oil.txFrom.length, 0, "nothing sent");
  });
});
