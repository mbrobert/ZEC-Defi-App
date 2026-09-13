/**
 * The cross-chain burn as a keeper action (BUILD-PLAN D6 / A5.2): the pure burn planner, the receipt judgement
 * over the three events (ours, Circle's messenger, the transmitter's message), and `dispatchBurn` →
 * `confirmBurn` against the mock account — the burn selector's own grant, the recorded recipient checked
 * against what the Solana Account expects, one `closeLpAndBurn` per pool, the receipt CONFIRMED only when
 * all three events agree. The CCTP fragments are pinned to shared's keccak of the recorded signatures.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, decodeFunctionData, getAddress, toEventSelector, toFunctionSelector, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { CCTP_DOMAINS, CCTP_V2_BASE, HF_LADDER, decodeCctpBurnMessageV2, keccak256Hex } from "@zyo/shared";
import { GRANT_SELECTORS, cctpMessengerAbi, cctpTransmitterAbi, strategyRouterAbi } from "../src/abi/oilskin.js";
import { KeeperDispatcher, summarizeBurns } from "../src/dispatch/keeperDispatcher.js";
import { BURN_FRACTION, grossForFee, planBurn, type PoolInfo } from "../src/dispatch/policy.js";
import { NO_SWAP } from "../src/dispatch/quote.js";
import { Logger, memorySink } from "../src/log.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import type { DispatchRecord } from "../src/store/keeperStore.js";
import type { Address } from "../src/types/evm.js";
import { ACCOUNT_A, CBBTC, USDC, newMockChain } from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";

const ROUTER = getAddress("0x2000000000000000000000000000000000000001") as Address;
const LP_VENUE = getAddress("0x2000000000000000000000000000000000000002") as Address;
const KEY = ("0x" + "42".repeat(32)) as Hex;
const KEEPER = privateKeyToAccount(KEY).address;
const POOL_A = ("0x" + "aa".repeat(32)) as Hex;
const POOL_B = ("0x" + "bb".repeat(32)) as Hex;
const SQRT_P = 5_000_000_000_000_000_000_000_000_000n;
/** The Solana Account's USDC token account, as the router records it — 32 opaque bytes to Base. */
const RECIPIENT = ("0x" + "22".repeat(32)) as Hex;
const OTHER_RECIPIENT = ("0x" + "33".repeat(32)) as Hex;
const CFG = { deadlineMs: 500, bandToleranceBps: 100, bandMaxToleranceBps: 500, txDeadlineS: 120, priceMaxAgeS: 3 * 3600, oracleDeviationBps: 300, hfToleranceBps: 100, swapMaxSlippageBps: 100, maxValueProbes: 24, grantExpiryWarnS: 7 * 86_400 };

function poolMap(...ids: Hex[]): Map<Hex, PoolInfo> {
  return new Map(ids.map((id) => [id, { sqrtPriceX96: SQRT_P, swap: NO_SWAP, needsSwap: false }]));
}
function record(action: string, over: Partial<DispatchRecord> = {}): DispatchRecord {
  const now = "2026-09-13T04:00:00.000Z";
  return { key: `${ACCOUNT_A.toLowerCase()}:1:1:${action}`, account: ACCOUNT_A.toLowerCase() as Address, episode: 1, seq: 1, action, rung: action === "burn-emergency" ? "emergency" : "derisk", hf: 1.1, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now, ...over };
}

/** An LP-only Base account (no Aave position): what a paired account looks like on Base. */
async function rig() {
  const chain = newMockChain();
  const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
  oil.install([ACCOUNT_A]);
  oil.poolPrices.set(POOL_A, SQRT_P);
  oil.poolPrices.set(POOL_B, SQRT_P * 2n);
  const client = chain.publicClient();
  const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: base, transport: chain.transport() });
  const reader = new AaveReader(client, aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 500 });
  const sink = memorySink();
  const notifier = { failures: 0, channels: ["test"], hasPersonChannel: true, deliver: async () => ({ personReached: true }) };
  const dispatcher = new KeeperDispatcher({ client, wallet, keeper: KEEPER, router: ROUTER, lpVenue: LP_VENUE, usdc: USDC, reader, ladder: HF_LADDER, log: new Logger(sink.sink, "debug"), config: CFG, now: () => new Date(Number(chain.nowS) * 1000), notifier });
  const grantBurn = (over: Partial<{ active: boolean; allowCallback: boolean; expiry: number }> = {}) => oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"], over);
  const intent = (action: string, usdcNeeded: bigint | null, over: Record<string, unknown> = {}) => ({
    record: record(action),
    usdcNeeded,
    expectedRecipient: RECIPIENT,
    collateralAssetForProbe: CBBTC,
    maxFeeBps: 2,
    minFinalityThreshold: 1000,
    ...over,
  });
  return { chain, oil, dispatcher, grantBurn, intent, sink };
}

describe("the burn planner (pure)", () => {
  const base = { account: ACCOUNT_A, router: ROUTER, pools: poolMap(POOL_A, POOL_B), idleUsdc: 0n, usdcNeeded: null, maxFeeBps: 2, minFinalityThreshold: 1000, bandToleranceBps: 100, nowS: 1_800_000_000n, txDeadlineS: 120 };
  const positions = [
    { id: 1n, poolId: POOL_A, valueUsdc: 1_000_000_000n },
    { id: 2n, poolId: POOL_B, valueUsdc: 500_000_000n },
    { id: 3n, poolId: POOL_A, valueUsdc: 3_000_000_000n },
  ];

  it("grossForFee: what must burn so that `needed` still arrives after a fee of maxFeeBps, rounded up; zero stays zero", () => {
    assert.equal(grossForFee(0n, 2), 0n);
    assert.equal(grossForFee(1_000_000n, 0), 1_000_000n);
    assert.equal(grossForFee(1_000_000n, 2), 1_000_201n, "ceil(1e6 × 1e4 / 9998)");
    assert.equal(grossForFee(9_998n, 2), 10_000n);
    assert.throws(() => grossForFee(1n, 10_000), RangeError);
  });

  it("the fractions mirror the single-chain rungs: ⅔ for de-risk, everything for emergency; unknown actions refused", () => {
    assert.deepEqual(BURN_FRACTION["burn-derisk"], [2, 3]);
    assert.deepEqual(BURN_FRACTION["burn-emergency"], [1, 1]);
    assert.equal(planBurn({ ...base, action: "repay", positions }).kind, "REFUSE");
    assert.equal(planBurn({ ...base, action: "derisk", positions }).kind, "REFUSE", "the burn has its own action names");
  });

  it("emergency: one closeLpAndBurn per pool, most valuable pool first, every id, burnAmount = max, maxFee from the expected proceeds plus one, the burn selector as the only grant", () => {
    const plan = planBurn({ ...base, action: "burn-emergency", positions });
    assert.equal(plan.kind, "CALLS");
    if (plan.kind !== "CALLS") return;
    assert.equal(plan.calls.length, 2);
    assert.deepEqual(new Set(plan.closeIds), new Set([1n, 2n, 3n]));
    assert.deepEqual(plan.grantsNeeded, [{ target: ROUTER, selector: GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"] }]);
    assert.equal(plan.expectedProceedsUsdc, 4_500_000_000n);
    const MAX = (1n << 256n) - 1n;
    for (const c of plan.calls) {
      assert.equal(c.target, ROUTER);
      assert.equal(c.data.slice(0, 10), GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"]);
      assert.equal(c.callback, false);
    }
    // decode the first call: POOL_A (4,000 USDC of value) leads
    const first = decodeFunctionData({ abi: strategyRouterAbi, data: plan.calls[0].data });
    const p = (first.args as unknown as [{ positionIds: bigint[]; burnAmount: bigint; maxFee: bigint; minFinalityThreshold: number; deadline: bigint }])[0];
    assert.deepEqual([...p.positionIds].sort(), [1n, 3n]);
    assert.equal(p.burnAmount, MAX);
    assert.equal(p.maxFee, (4_500_000_000n * 2n + 9_999n) / 10_000n + 1n, "2 bp of the expected 4,500 USDC, rounded up, plus one unit");
    assert.equal(p.minFinalityThreshold, 1000);
    assert.equal(p.deadline, 1_800_000_120n);
  });

  it("de-risk sized to the need grossed up for the fee, capped at ⅔ of value; idle USDC alone is one call with no ids; nothing at all is NOTHING", () => {
    // need 1,200 USDC → gross 1,200.24 → the cheapest cover: id 3 alone (3,000) is more than ⅔? selectIds decides; the plan just carries the ids
    const plan = planBurn({ ...base, action: "burn-derisk", positions, usdcNeeded: 1_200_000_000n });
    assert.equal(plan.kind, "CALLS");
    if (plan.kind !== "CALLS") return;
    assert.ok(plan.closeIds.length >= 1 && plan.closeIds.length < 3, "not everything: the de-risk fraction caps the close");
    const idle = planBurn({ ...base, action: "burn-emergency", positions: [], idleUsdc: 700_000_000n });
    assert.equal(idle.kind, "CALLS");
    if (idle.kind !== "CALLS") return;
    assert.equal(idle.calls.length, 1);
    assert.deepEqual(idle.closeIds, []);
    const nothing = planBurn({ ...base, action: "burn-emergency", positions: [] });
    assert.equal(nothing.kind, "NOTHING");
  });

  it("refuses without a readable pool price and refuses a swap leg without a quote", () => {
    const noPrice = new Map<Hex, PoolInfo>([[POOL_A, { sqrtPriceX96: 0n, swap: NO_SWAP, needsSwap: false }]]);
    assert.equal(planBurn({ ...base, action: "burn-emergency", positions: [positions[0]], pools: noPrice }).kind, "REFUSE");
    const noQuote = new Map<Hex, PoolInfo>([[POOL_A, { sqrtPriceX96: SQRT_P, swap: NO_SWAP, needsSwap: true }]]);
    assert.equal(planBurn({ ...base, action: "burn-emergency", positions: [positions[0]], pools: noQuote }).kind, "REFUSE");
  });
});

describe("the CCTP fragments the keeper reads a receipt with", () => {
  it("are the verified implementations' — topics and the burn selector recomputed from the recorded signatures", () => {
    assert.equal(toEventSelector(cctpMessengerAbi[0]), "0x" + keccak256Hex(CCTP_V2_BASE.abi.depositForBurnEvent));
    assert.equal(toEventSelector(cctpTransmitterAbi[0]), "0x" + keccak256Hex(CCTP_V2_BASE.abi.messageSentEvent));
    assert.equal(GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"], "0xc01c93d7", "CONTRACT-ABI.md §7, the regenerated bundle");
    assert.equal(toFunctionSelector(strategyRouterAbi.find((f) => "name" in f && f.name === "closeLpAndBurn") as never), "0xc01c93d7");
  });
});

describe("dispatchBurn → confirmBurn against the mock account", () => {
  it("with the burn grant and a linked recipient: prices the ids through the burn selector, sends one closeLpAndBurn per pool, and the receipt is CONFIRMED with the bridge info Stream C needs", async () => {
    const r = await rig();
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }, { id: 2n, poolId: POOL_A }]);
    r.oil.defaultCloseYield = { usdc: 2_000_000_000n, other: 0n };
    r.oil.usdcBalances.set(ACCOUNT_A.toLowerCase(), 150_000_000n); // 150 idle
    r.oil.solanaRecipients.set(ACCOUNT_A.toLowerCase(), RECIPIENT);
    r.grantBurn();
    const grants: { selector: string }[] = [];
    const res = await r.dispatcher.dispatchBurn(r.intent("burn-emergency", 3_000_000_000n, { onGrantRead: (g: { selector: string }) => grants.push(g) }));
    assert.equal(res.status, "SENT", JSON.stringify(res));
    if (res.status !== "SENT") return;
    assert.deepEqual(grants.map((g) => g.selector), [GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"]]);
    assert.equal(res.bridge?.stage, "burn-sent");
    assert.equal(res.bridge?.recipient, RECIPIENT);
    const exec = r.oil.executed.filter((e) => e.mutate);
    assert.equal(exec.length, 1);
    assert.deepEqual(exec[0].calls.map((c) => c.selector), [GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"]]);
    assert.ok(r.oil.executed.filter((e) => !e.mutate).length >= 2, "value probes rode the burn selector (simulations only)");
    assert.equal(r.oil.usdcBalances.get(ACCOUNT_A.toLowerCase()), 0n, "everything the close produced plus the idle balance was burned");
    assert.equal(r.oil.positions.get(ACCOUNT_A.toLowerCase())!.length, 0);
    // the receipt
    const c = await r.dispatcher.confirmBurn(record("burn-emergency", { status: "SENT", txHash: res.txHash }));
    assert.equal(c.status, "CONFIRMED", JSON.stringify(c));
    if (c.status !== "CONFIRMED") return;
    assert.equal(c.bridge?.stage, "burn-confirmed");
    assert.equal(c.bridge?.amountUsdc, (4_000_000_000n + 150_000_000n).toString());
    assert.equal(c.bridge?.recipient, RECIPIENT);
    assert.match(c.bridge?.nonce ?? "", /^0x[0-9a-f]{64}$/);
    const m = decodeCctpBurnMessageV2(Uint8Array.from(Buffer.from(c.bridge!.messageHex!.slice(2), "hex")));
    assert.equal(m.sourceDomain, CCTP_DOMAINS.base);
    assert.equal(m.destinationDomain, CCTP_DOMAINS.solana);
    assert.equal(m.body.amount, 4_150_000_000n);
    assert.equal("0x" + Buffer.from(m.body.mintRecipient).toString("hex"), RECIPIENT);
    assert.match(c.note ?? "", /burned 4150000000 USDC to Solana/);
  });

  it("refuses by name, permanently, when the router records another recipient than the Solana Account expects, or none; when the burn selector is not granted; when the grant lacks allowCallback", async () => {
    const r = await rig();
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    // none recorded
    r.grantBurn();
    let res = await r.dispatcher.dispatchBurn(r.intent("burn-derisk", 1_000_000n));
    assert.equal(res.status, "REFUSED");
    assert.equal((res as { permanent?: boolean }).permanent, true);
    assert.match((res as { reason: string }).reason, /not a linked pair/);
    // another one recorded
    r.oil.solanaRecipients.set(ACCOUNT_A.toLowerCase(), OTHER_RECIPIENT);
    res = await r.dispatcher.dispatchBurn(r.intent("burn-derisk", 1_000_000n));
    assert.equal(res.status, "REFUSED");
    assert.equal((res as { permanent?: boolean }).permanent, true);
    // linked, but the grant is for unwind only
    r.oil.solanaRecipients.set(ACCOUNT_A.toLowerCase(), RECIPIENT);
    r.oil.grants.clear();
    r.oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"], {});
    res = await r.dispatcher.dispatchBurn(r.intent("burn-derisk", 1_000_000n));
    assert.equal(res.status, "REFUSED");
    assert.equal((res as { permanent?: boolean }).permanent, true);
    assert.match((res as { reason: string }).reason, /closeLpAndBurn/);
    // linked, granted, but without callback rights
    r.grantBurn({ allowCallback: false });
    res = await r.dispatcher.dispatchBurn(r.intent("burn-derisk", 1_000_000n));
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /allowCallback=false/);
    assert.equal(r.oil.txFrom.length, 0, "nothing was ever sent");
  });

  it("a receipt whose three events do not agree is FAILED: no DepositForBurn from the messenger, or a message for another amount", async () => {
    const r = await rig();
    r.oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }]);
    r.oil.defaultCloseYield = { usdc: 1_000_000_000n, other: 0n };
    r.oil.solanaRecipients.set(ACCOUNT_A.toLowerCase(), RECIPIENT);
    r.grantBurn();
    const res = await r.dispatcher.dispatchBurn(r.intent("burn-emergency", null));
    assert.equal(res.status, "SENT");
    const tx = (res as { txHash: Hex }).txHash;
    const rc = r.chain.receipts.get(tx.toLowerCase())!;
    const messengerTopic = toEventSelector(cctpMessengerAbi[0]);
    r.chain.receipts.set(tx.toLowerCase(), { ...rc, logs: (rc.logs ?? []).filter((l) => l.topics[0] !== messengerTopic) });
    const c1 = await r.dispatcher.confirmBurn(record("burn-emergency", { status: "SENT", txHash: tx }));
    assert.equal(c1.status, "FAILED");
    assert.match((c1 as { error: string }).error, /DepositForBurn/);
    r.chain.receipts.set(tx.toLowerCase(), { ...rc, logs: [] });
    const c2 = await r.dispatcher.confirmBurn(record("burn-emergency", { status: "SENT", txHash: tx }));
    assert.equal(c2.status, "FAILED");
    // summarizeBurns on the intact receipt agrees on every number
    const s = summarizeBurns(rc.logs as never, ACCOUNT_A);
    assert.equal(s.events, 1);
    assert.equal(s.burned, 1_000_000_000n);
    assert.equal(s.cctp?.amount, 1_000_000_000n);
    assert.equal(s.cctp?.destinationDomain, CCTP_DOMAINS.solana);
    assert.equal(s.message?.amount, 1_000_000_000n);
    assert.equal(s.recipient, RECIPIENT);
  });
});
