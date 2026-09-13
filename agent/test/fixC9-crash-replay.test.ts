import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { HF_LADDER } from "@zyo/shared";
import { GRANT_SELECTORS } from "../src/abi/oilskin.js";
import { KeeperDispatcher, usdcNeededFor } from "../src/dispatch/keeperDispatcher.js";
import type { DispatchRecord } from "../src/store/keeperStore.js";
import { evaluateSnapshot } from "../src/engine/valuation.js";
import { Logger, memorySink } from "../src/log.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import type { Address } from "../src/types/evm.js";
import { ACCOUNT_A, USDC, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";

/**
 * HARVESTED FROM /tmp/audit2/C/poc4-crash.test.js (tests 3–5) and
 * poc10-fraction.test.js — expectations FLIPPED.
 *
 * poc10 (the sizing bug that caused the replay damage):
 *     per tick (hf, fired/dispatch): ["1.3000 repay/SENT","1.3005 -/-",…]
 *     ids closed: [1, 2]        (two $10 leftovers; ids 3-6 are worth $12,000 each)
 *     dispatch: repay:CONFIRMED    ladder latched: ["repay","warn"]  final HF: 1.3005
 *     => a CONFIRMED protective action that repaid $20 against a ~$47,700 debt.
 *
 * poc4 (what that then costs after a crash):
 *     crash after send, HF improved but still under disarm:
 *       broadcasts: 1 -> 2   LP ids: [3,4,5,6] -> [5,6]
 *       <- 4 of 6 ids closed for one `repay` crossing (2 were called for)
 *
 * The rung is now sized by VALUE and capped by the USDC actually NEEDED to
 * reach the rung's disarm, so the first action works and the replay finds
 * nothing left to do.
 */

const KEY = ("0x" + "42".repeat(32)) as Hex;
const ROUTER = getAddress("0x2000000000000000000000000000000000000001") as Address;
const LP_VENUE = getAddress("0x2000000000000000000000000000000000000002") as Address;
const KEEPER = privateKeyToAccount(KEY).address;
const POOL = ("0x" + "aa".repeat(32)) as Hex;

const CFG = {
  deadlineMs: 1_000,
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

function record(action: string, rung: string, hf: number, over: Partial<DispatchRecord> = {}): DispatchRecord {
  const now = "2026-09-06T00:00:00.000Z";
  return {
    key: `${ACCOUNT_A.toLowerCase()}:1:1:${action}`,
    account: ACCOUNT_A.toLowerCase() as Address,
    episode: 1,
    seq: 1,
    action,
    rung,
    hf,
    status: "PENDING",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** The PoC's account: two dust ids enumerated FIRST, four big ones after. */
async function dustFirstRig(hf = 1.15) {
  const chain = newMockChain();
  cbBtcPosition(chain, ACCOUNT_A, debtForHf(hf));
  const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
  oil.install([ACCOUNT_A]);
  oil.poolPrices.set(POOL, 10n ** 30n);
  oil.setPositions(
    chain.users.has(ACCOUNT_A.toLowerCase()) ? ACCOUNT_A : ACCOUNT_A,
    [1n, 2n, 3n, 4n, 5n, 6n].map((id) => ({ id, poolId: POOL }))
  );
  oil.setCloseYield(1n, 10_000_000n); // $10
  oil.setCloseYield(2n, 10_000_000n); // $10
  for (const id of [3n, 4n, 5n, 6n]) oil.setCloseYield(id, 12_000_000_000n); // $12,000
  oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);

  const client = chain.publicClient();
  const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: base, transport: chain.transport() });
  const reader = new AaveReader(client, aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 1_000 });
  const sink = memorySink();
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
  });
  const valuation = async () => {
    const ctx = await reader.readReserveContexts();
    const snap = await reader.readAccount(ACCOUNT_A, ctx, chain.blockNumber);
    const v = evaluateSnapshot(snap, { nowS: chain.nowS, ...CFG });
    if (v.kind !== "OK") throw new Error(`expected OK, got ${v.kind}`);
    return v;
  };
  const idsLeft = () => (oil.positions.get(ACCOUNT_A.toLowerCase()) ?? []).map((p) => Number(p.id));
  return { chain, oil, dispatcher, valuation, idsLeft, sink };
}

describe("FIX C-9/C-10: the rung is sized by value and need, so a replay cannot compound", () => {
  it("FIX C-10: a repay with dust at the front of the enumeration closes VALUE, not the first ids", async () => {
    const r = await dustFirstRig(1.15);
    const before = await r.valuation();
    const res = await r.dispatcher.dispatch({ record: record("repay", "repay", 1.15), valuation: before });
    assert.equal(res.status, "SENT");
    const left = r.idsLeft();
    // Was: ids [1,2] closed — $20 repaid against a ~$53,990 debt, CONFIRMED, latched.
    assert.ok(left.includes(1) && left.includes(2), `the dust ids must survive: ${JSON.stringify(left)}`);
    assert.ok(left.length < 6, "something real was closed");
    const after = await r.valuation();
    assert.ok(after.hf > before.hf + 0.05, `HF must actually move: ${before.hf} → ${after.hf}`);
    assert.ok(after.hf >= HF_LADDER.find((x) => x.id === "repay")!.disarmHf, `the repay rung's disarm must be reached: ${after.hf}`);
  });

  it("FIX C-9: a crash between the send and the store write does NOT close another slice", async () => {
    const r = await dustFirstRig(1.15);
    const rec = record("repay", "repay", 1.15);
    // The keeper persists its nonce and the ids BEFORE broadcasting …
    const preSend: { nonce?: number; closeIds: bigint[] }[] = [];
    const res = await r.dispatcher.dispatch({
      record: rec,
      valuation: await r.valuation(),
      persistBeforeSend: async (info) => void preSend.push(info),
    });
    assert.equal(res.status, "SENT");
    assert.equal(preSend.length, 1);
    assert.equal(typeof preSend[0].nonce, "number");
    assert.ok(preSend[0].closeIds.length > 0, "the ids about to be closed are persisted with the key");
    const afterFirst = r.idsLeft();
    const broadcastsAfterFirst = r.oil.txFrom.length;

    // … and now the process dies before the txHash is written. The record is
    // still PENDING, so the next tick resumes it with no valuation.
    const replay = await r.dispatcher.dispatch({ record: { ...rec, status: "PENDING", sentNonce: preSend[0].nonce }, valuation: null });
    // Was: SENT again, closing ⌈⅓⌉ of what remained on top of the lost tx.
    assert.equal(replay.status, "SUPERSEDED", `replay: ${JSON.stringify(replay)}`);
    assert.deepEqual(r.idsLeft(), afterFirst, "the replay must not close one more id");
    assert.equal(r.oil.txFrom.length, broadcastsAfterFirst, "the replay must broadcast nothing");
  });

  it("FIX C-9: when the world is still under the disarm, the replay is sized by what is STILL needed", async () => {
    const r = await dustFirstRig(1.08); // derisk territory (under the 1.09 rung)
    const v = await r.valuation();
    const rung = HF_LADDER.find((x) => x.id === "derisk")!;
    const needBefore = usdcNeededFor(v, rung.disarmHf, USDC)!;
    const res = await r.dispatcher.dispatch({ record: record("derisk", "derisk", v.hf), valuation: v });
    assert.equal(res.status, "SENT");
    const after = await r.valuation();
    const needAfter = usdcNeededFor(after, rung.disarmHf, USDC)!;
    // The need is what shrinks — that is what stops a replay compounding.
    assert.ok(needAfter < needBefore, `${needAfter} < ${needBefore}`);
    assert.ok(after.hf > v.hf);
  });

  it("FIX C-9: the USDC needed for a rung is derived from the account's own debt row, never assumed", () => {
    const v = {
      kind: "OK" as const,
      hf: 1.3,
      hfWad: 1_300_000_000_000_000_000n,
      debtBase: 47_760_00000000n,
      collateralBase: 79_600_00000000n,
      collateral: [],
      debt: [
        {
          asset: USDC,
          symbol: "USDC",
          decimals: 6,
          amount: 47_760_000_000n,
          price8: 1_00000000n,
          valueBase: 47_760_00000000n,
        },
      ],
      dominantCollateral: { asset: USDC, symbol: "USDC", valueBase: 0n, liquidationThresholdBps: 0n },
    };
    // HF 1.30 → a 1.40 target (a 1.55-entry account's repay disarm) on a $47,760 debt: Σ(collateral×LT) = 1.30 × 47,760.
    const need = usdcNeededFor(v, 1.4, USDC)!;
    const expected = 47_760_000_000n - (47_760_000_000n * 13n) / 14n;
    assert.ok(need > 0n && need <= v.debt[0].amount);
    assert.ok(need >= expected - 1_000_000n && need <= expected + 1_000_000n, `${need} ≈ ${expected}`);
    // No USDC debt row ⇒ no need can be derived, and the caller falls back.
    assert.equal(usdcNeededFor({ ...v, debt: [] }, 1.4, USDC), null);
    // Already above the target ⇒ nothing is needed.
    assert.equal(usdcNeededFor(v, 1.0, USDC), 0n);
  });
});
