import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { createWalletClient, decodeFunctionData, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { HF_LADDER } from "@zyo/shared";
import { GRANT_SELECTORS, lpVenueAbi, strategyRouterAbi } from "../src/abi/oilskin.js";
import { KeeperDispatcher } from "../src/dispatch/keeperDispatcher.js";
import { CLOSE_FRACTION, bandFor, closeCount, isqrt, planAction } from "../src/dispatch/policy.js";
import { evaluateSnapshot } from "../src/engine/valuation.js";
import { Logger, memorySink } from "../src/log.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import type { DispatchRecord } from "../src/store/keeperStore.js";
import type { Address } from "../src/types/evm.js";
import { ACCOUNT_A, CBBTC, USDC, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";

const ROUTER = getAddress("0x2000000000000000000000000000000000000001") as Address;
const LP_VENUE = getAddress("0x2000000000000000000000000000000000000002") as Address;
const KEY = ("0x" + "42".repeat(32)) as Hex;
const KEEPER = privateKeyToAccount(KEY).address;
const POOL_A = ("0x" + "aa".repeat(32)) as Hex;
const POOL_B = ("0x" + "bb".repeat(32)) as Hex;
const SQRT_P = 5_000_000_000_000_000_000_000_000_000n; // ~ price 4000 in Q64.96 terms, any positive number works

const CFG = { deadlineMs: 500, bandToleranceBps: 100, txDeadlineS: 120, priceMaxAgeS: 3 * 3600, oracleDeviationBps: 300, hfToleranceBps: 100 };

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
  const notified: DispatchRecord[] = [];
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
    notify: (r) => void notified.push(r),
  });
  const valuation = async () => {
    const ctx = await reader.readReserveContexts();
    const snap = await reader.readAccount(ACCOUNT_A, ctx, chain.blockNumber);
    const v = evaluateSnapshot(snap, { nowS: chain.nowS, ...CFG });
    if (v.kind !== "OK") throw new Error(`expected OK, got ${v.kind}`);
    return v;
  };
  const grantAll = () => {
    oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);
    oil.grant(KEEPER, LP_VENUE, GRANT_SELECTORS["SnuggleLpVenue.closeMany"]);
  };
  return { chain, oil, dispatcher, valuation, grantAll, sink, notified, reader };
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

  it("plans closeMany per pool + an unwind that repays MAX and never withdraws; refuses without a pool price", () => {
    const base = {
      account: ACCOUNT_A,
      router: ROUTER,
      lpVenue: LP_VENUE,
      collateralAsset: CBBTC,
      positions: [
        { id: 1n, poolId: POOL_A },
        { id: 2n, poolId: POOL_B },
        { id: 3n, poolId: POOL_A },
      ],
      poolSqrtPrice: new Map([[POOL_A, SQRT_P], [POOL_B, SQRT_P]]),
      idleUsdc: 0n,
      bandToleranceBps: 100,
      nowS: 1_800_000_000n,
      txDeadlineS: 120,
    };
    const plan = planAction({ ...base, action: "emergency-unwind" });
    assert.equal(plan.kind, "CALLS");
    if (plan.kind !== "CALLS") return;
    assert.equal(plan.calls.length, 3); // two pools + unwind
    assert.deepEqual(plan.closeIds, [1n, 3n, 2n]);
    const c0 = decodeFunctionData({ abi: lpVenueAbi, data: plan.calls[0].data });
    assert.equal(c0.functionName, "closeMany");
    assert.deepEqual([...(c0.args as unknown as [readonly bigint[]])[0]], [1n, 3n]);
    const u = decodeFunctionData({ abi: strategyRouterAbi, data: plan.calls[2].data });
    const p = (u.args as unknown as [{ positionIds: readonly bigint[]; repayAmount: bigint; withdrawAmount: bigint; deadline: bigint; collateralAsset: Address }])[0];
    assert.deepEqual([...p.positionIds], []);
    assert.equal(p.repayAmount, (1n << 256n) - 1n);
    assert.equal(p.withdrawAmount, 0n);
    assert.equal(p.deadline, 1_800_000_120n);
    assert.equal(p.collateralAsset, CBBTC);
    assert.deepEqual(plan.grantsNeeded.map((g) => g.selector), [GRANT_SELECTORS["SnuggleLpVenue.closeMany"], GRANT_SELECTORS["StrategyRouter.unwind"]]);
    // repay closes ceil(3/3)=1 → only pool A.
    const repay = planAction({ ...base, action: "repay" });
    assert.equal(repay.kind === "CALLS" && repay.closeIds.length, 1);
    // No pool price → refuse (never a zero band).
    const noPrice = planAction({ ...base, action: "repay", poolSqrtPrice: new Map() });
    assert.equal(noPrice.kind, "REFUSE");
    // No positions and no idle USDC → nothing the keeper can do.
    const nothing = planAction({ ...base, action: "repay", positions: [] });
    assert.equal(nothing.kind, "NOTHING");
    // No positions but idle USDC → unwind-only plan (repay from idle).
    const idle = planAction({ ...base, action: "repay", positions: [], idleUsdc: 5n });
    assert.equal(idle.kind === "CALLS" && idle.calls.length, 1);
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

  it("REFUSES when only one of the two grants exists (partial grant is no grant)", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, new RegExp(LP_VENUE));
    assert.equal(r.oil.txFrom.length, 0);
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
      // First two reads are the keeper's grantOf checks → true; the execAsKeeper path sees the truth (revoked).
      return reads <= 2 ? true : v && !k.includes(LP_VENUE.toLowerCase());
    };
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /NotGranted/);
    assert.equal(r.oil.txFrom.length, 0);
  });

  it("with grants: simulates, signs as the keeper, sends execAsKeeper([closeMany, unwind]) — the mock repays and HF recovers", async () => {
    const r = await rig(1.3);
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }, { id: 2n, poolId: POOL_A }, { id: 3n, poolId: POOL_A }]);
    r.oil.defaultCloseYield = 8_000_000_000n; // 8,000 USDC per id
    r.grantAll();
    const before = (await r.valuation()).hf;
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.3), valuation: await r.valuation() });
    assert.equal(res.status, "SENT");
    const tx = (res as { txHash: Hex }).txHash;
    assert.deepEqual(r.oil.txFrom, [KEEPER]);
    const exec = r.oil.executed.filter((e) => e.mutate);
    assert.equal(exec.length, 1);
    assert.deepEqual(exec[0].calls.map((c) => c.selector), [GRANT_SELECTORS["SnuggleLpVenue.closeMany"], GRANT_SELECTORS["StrategyRouter.unwind"]]);
    assert.equal(r.oil.positions.get(ACCOUNT_A.toLowerCase())!.length, 2); // ceil(3/3) = 1 closed
    const after = (await r.valuation()).hf;
    assert.ok(after > before, `${after} > ${before}`);
    // confirm() reads the receipt.
    const c = await r.dispatcher.confirm(record("repay", "repay", 1.3, { status: "SENT", txHash: tx }));
    assert.deepEqual(c, { status: "CONFIRMED", txHash: tx });
    // Simulation ran exactly once before the send (dry run, no mutation).
    assert.equal(r.oil.executed.filter((e) => !e.mutate).length, 1);
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
    // Plan had both pools + unwind.
    const dry = r.oil.executed.find((e) => !e.mutate)!;
    assert.equal(dry.calls.length, 3);
  });

  it("notify rung delivers the hook and touches no chain", async () => {
    const r = await rig(1.45);
    const res = await r.dispatcher.dispatch({ record: record("notify", "warn", 1.45), valuation: await r.valuation() });
    assert.deepEqual(res, { status: "NOTIFIED" });
    assert.equal(r.notified.length, 1);
    assert.equal(r.chain.calls.filter((c) => c.method === "eth_sendRawTransaction").length, 0);
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
