/**
 * The Base burner adapter (`agent/src/solana/baseBurner.ts`, 2026-09-25): the piece between the Solana
 * dispatcher's "bridge" route and `KeeperDispatcher.dispatchBurn`. Three things it must get right, each pinned
 * here against a scripted Base dispatcher and the recorded Circle answers: the record the Base side sees names
 * the BASE account (a Solana PDA in `record.account` would have made every burn a permanent "not a linked
 * pair" refusal); Fast or Standard and the fee bound come from Circle's live schedule and ride into the
 * intent; and the pre-send write is forwarded so the Base nonce is on the Solana record before the broadcast.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import { CCTP_FINALITY_POLICY_DEFAULTS, CCTP_IRIS } from "@zyo/shared";
import type { BurnIntent, BurnResult } from "../src/dispatch/types.js";
import type { DispatchRecord } from "../src/store/keeperStore.js";
import { KeeperBaseBurner, burnActionOf, toBaseRecord } from "../src/solana/baseBurner.js";
import { createWalletClient, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base as baseChain } from "viem/chains";
import { HF_LADDER, decodeCctpBurnMessageV2 } from "@zyo/shared";
import { GRANT_SELECTORS } from "../src/abi/oilskin.js";
import { KeeperDispatcher } from "../src/dispatch/keeperDispatcher.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import { ACCOUNT_A, CBBTC as CBBTC_FIXTURE, USDC, newMockChain } from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";
import { CircleFeeClient } from "../src/solana/circleFees.js";
import type { SolanaDispatchRecord } from "../src/solana/dispatcher.js";
import { Logger, memorySink } from "../src/log.js";

const recorded = JSON.parse(readFileSync(new URL("../../../docs/research/cctp-fees-2026-09-25.json", import.meta.url), "utf8")) as { reads: { url: string; body: unknown }[] };
const body = (suffix: string) => recorded.reads.find((r) => r.url.endsWith(suffix))!.body;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const NOW_MS = Date.parse("2026-09-25T21:58:43.744Z");

const BASE = "0x1646587E543bC2f63137bAa86F8598E1274aED78" as const;
const CBBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as const;
const RECIPIENT = ("0x" + "22".repeat(32)) as `0x${string}`;
const BURN_TX = ("0x" + "ab".repeat(32)) as `0x${string}`;
const SOLANA_ACCOUNT = Keypair.generate().publicKey.toBase58();

function solanaRecord(over: Partial<SolanaDispatchRecord> = {}): SolanaDispatchRecord {
  const now = "2026-09-25T22:00:00.000Z";
  return { key: `${SOLANA_ACCOUNT}:1:1:derisk`, account: SOLANA_ACCOUNT, episode: 1, seq: 1, action: "derisk", rung: "derisk", hf: 1.1, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now, disarmHf: 1.4, ...over };
}

/** A scripted Base dispatcher: records what it was asked and answers from the script. */
function fakeBase(script: { dispatch?: (i: BurnIntent) => Promise<BurnResult> | BurnResult; confirm?: (r: DispatchRecord) => Promise<BurnResult> | BurnResult } = {}) {
  const intents: BurnIntent[] = [];
  const confirms: DispatchRecord[] = [];
  return {
    intents,
    confirms,
    base: {
      async dispatchBurn(intent: BurnIntent): Promise<BurnResult> {
        intents.push(intent);
        return script.dispatch ? script.dispatch(intent) : { status: "SENT", txHash: BURN_TX, bridge: { chain: "base", stage: "burn-sent", burnTxHash: BURN_TX, amountUsdc: "0", recipient: RECIPIENT } };
      },
      async confirmBurn(record: DispatchRecord): Promise<BurnResult> {
        confirms.push(record);
        return script.confirm ? script.confirm(record) : { status: "CONFIRMED", txHash: BURN_TX, bridge: { chain: "base", stage: "burn-confirmed", burnTxHash: BURN_TX, amountUsdc: "1000000000", nonce: "0x" + "11".repeat(32), messageHex: "0x00", recipient: RECIPIENT } };
      },
    },
  };
}

function fees(handler: (url: string) => Response = (url) => (url.endsWith("/fees/6/5") ? json(body("/fees/6/5")) : json(body("/allowance")))) {
  return new CircleFeeClient({ baseUrl: CCTP_IRIS.mainnet, deadlineMs: 500, fetchImpl: (async (u: unknown) => handler(String(u))) as unknown as typeof fetch, log: new Logger(memorySink().sink, "debug"), now: () => NOW_MS });
}

function rig(opts: { base?: ReturnType<typeof fakeBase>; fees?: CircleFeeClient | null } = {}) {
  const sink = memorySink();
  const base = opts.base ?? fakeBase();
  const burner = new KeeperBaseBurner({ base: base.base, fees: opts.fees === undefined ? fees() : opts.fees, policy: CCTP_FINALITY_POLICY_DEFAULTS, collateralAssetForProbe: CBBTC, log: new Logger(sink.sink, "debug") });
  return { burner, base, lines: sink.lines as string[] };
}

const input = (over: Partial<Parameters<KeeperBaseBurner["dispatch"]>[0]> = {}): Parameters<KeeperBaseBurner["dispatch"]>[0] => ({ record: solanaRecord(), baseAccount: BASE, expectedRecipient: RECIPIENT, usdcNeeded: 4_500_000_000n, action: "burn-derisk", ...over });

describe("toBaseRecord", () => {
  it("swaps the Solana PDA for the Base account (lowercased, as Base records are keyed), names the BURN action, and lifts the burn hash into txHash; everything else is the same record", () => {
    const rec = solanaRecord({ txHash: "5" + "1".repeat(87), bridge: { chain: "base", stage: "burn-sent", burnTxHash: BURN_TX, amountUsdc: "0" } });
    const out = toBaseRecord(rec, BASE);
    assert.equal(out.account, BASE.toLowerCase());
    assert.equal(out.txHash, BURN_TX, "the Base hash, not the Solana signature");
    assert.equal(out.key, rec.key);
    assert.equal(out.episode, 1);
    assert.equal(out.action, "burn-derisk", "planBurn keys its fraction on this name (AUDIT-2026-09-25 CC-1)");
    assert.equal(out.rung, "derisk");
    assert.equal(out.disarmHf, 1.4);
    assert.deepEqual(out.bridge, rec.bridge);
    const fresh = toBaseRecord(solanaRecord(), BASE);
    assert.equal(fresh.txHash, undefined, "no burn yet: no hash");
    assert.equal(toBaseRecord(solanaRecord({ action: "emergency-unwind" }), BASE).action, "burn-emergency");
    assert.equal(toBaseRecord(solanaRecord(), BASE, "burn-emergency").action, "burn-emergency", "an explicit action wins");
  });

  it("burnActionOf: the Solana rung's action name becomes the Base burn's; anything that is not the emergency is the de-risk fraction", () => {
    assert.equal(burnActionOf("emergency-unwind"), "burn-emergency");
    assert.equal(burnActionOf("burn-emergency"), "burn-emergency");
    assert.equal(burnActionOf("derisk"), "burn-derisk");
    assert.equal(burnActionOf("burn-derisk"), "burn-derisk");
  });
});

// ------------------------------------------------------------------ the adapter over the REAL Base dispatcher

const ROUTER = getAddress("0x2000000000000000000000000000000000000001");
const LP_VENUE = getAddress("0x2000000000000000000000000000000000000002");
const KEY = ("0x" + "42".repeat(32)) as Hex;
const KEEPER_BASE = privateKeyToAccount(KEY).address;
const POOL_A = ("0x" + "aa".repeat(32)) as Hex;
const SQRT_P = 5_000_000_000_000_000_000_000_000_000n;
const CFG = { deadlineMs: 500, bandToleranceBps: 100, bandMaxToleranceBps: 500, txDeadlineS: 120, priceMaxAgeS: 3 * 3600, oracleDeviationBps: 300, hfToleranceBps: 100, swapMaxSlippageBps: 100, maxValueProbes: 24, grantExpiryWarnS: 7 * 86_400 };

/** The burn test's rig: an LP-only Base account on the mock chain, with the burn grant and the linked recipient. */
async function baseRig() {
  const chain = newMockChain();
  const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
  oil.install([ACCOUNT_A]);
  oil.poolPrices.set(POOL_A, SQRT_P);
  const client = chain.publicClient();
  const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: baseChain, transport: chain.transport() });
  const reader = new AaveReader(client, aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 500 });
  const sink = memorySink();
  const notifier = { failures: 0, channels: ["test"], hasPersonChannel: true, deliver: async () => ({ personReached: true }) };
  const dispatcher = new KeeperDispatcher({ client, wallet, keeper: KEEPER_BASE, router: ROUTER, lpVenue: LP_VENUE, usdc: USDC, reader, ladder: HF_LADDER, log: new Logger(sink.sink, "debug"), config: CFG, now: () => new Date(Number(chain.nowS) * 1000), notifier });
  oil.setPositions(ACCOUNT_A, [{ id: 1n, poolId: POOL_A }, { id: 2n, poolId: POOL_A }]);
  oil.defaultCloseYield = { usdc: 2_000_000_000n, other: 0n };
  oil.usdcBalances.set(ACCOUNT_A.toLowerCase(), 150_000_000n);
  oil.solanaRecipients.set(ACCOUNT_A.toLowerCase(), RECIPIENT);
  oil.grant(KEEPER_BASE, ROUTER, GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"], {});
  return { chain, oil, dispatcher, sink };
}

describe("KeeperBaseBurner over the real KeeperDispatcher (mock chain)", () => {
  it("AUDIT-2026-09-25 CC-1: a Solana record for a linked pair becomes ONE closeLpAndBurn with the chosen finality, and the receipt is judged on the Base account the bridge record carries", async () => {
    const b = await baseRig();
    const burner = new KeeperBaseBurner({ base: b.dispatcher, fees: fees(), policy: CCTP_FINALITY_POLICY_DEFAULTS, collateralAssetForProbe: CBBTC_FIXTURE, log: new Logger(memorySink().sink, "debug") });
    const out = await burner.dispatch(input({ baseAccount: ACCOUNT_A, action: "burn-emergency", usdcNeeded: 3_000_000_000n }));
    assert.equal(out.status, "SENT", JSON.stringify(out));
    if (out.status !== "SENT") return;
    assert.equal(out.bridge?.stage, "burn-sent");
    assert.equal(out.bridge?.baseAccount, ACCOUNT_A);
    assert.equal(out.bridge?.minFinalityThreshold, 1000);
    assert.equal(out.bridge?.maxFeeBps, 2);
    const exec = b.oil.executed.filter((e) => e.mutate);
    assert.equal(exec.length, 1, "one burn was sent");
    assert.deepEqual(exec[0]!.calls.map((c) => c.selector), [GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"]]);
    assert.equal(b.oil.usdcBalances.get(ACCOUNT_A.toLowerCase()), 0n, "the emergency fraction: everything the close produced plus the idle balance was burned");
    // the receipt, judged through the adapter on the Base account the bridge record carries
    const rec = solanaRecord({ status: "SENT", attempts: 1, bridge: out.bridge });
    const c = await burner.confirm(rec);
    assert.equal(c.status, "CONFIRMED", JSON.stringify(c));
    if (c.status !== "CONFIRMED") return;
    assert.equal(c.bridge?.stage, "burn-confirmed");
    assert.equal(c.bridge?.amountUsdc, (4_000_000_000n + 150_000_000n).toString());
    assert.equal(c.bridge?.baseAccount, ACCOUNT_A, "kept across the stage change");
    assert.equal(c.bridge?.minFinalityThreshold, 1000);
    const m = decodeCctpBurnMessageV2(Uint8Array.from(Buffer.from(c.bridge!.messageHex!.slice(2), "hex")));
    assert.equal(m.body.amount, 4_150_000_000n);
    assert.equal("0x" + Buffer.from(m.body.mintRecipient).toString("hex"), RECIPIENT);
    // the finality and the fee bound the chooser picked are what the router was asked for (the mock echoes the call into the message)
    assert.equal(m.minFinalityThreshold, 1000, "Fast, from Circle's recorded schedule");
    assert.equal(m.body.maxFee, (4_150_000_000n * 2n + 9_999n) / 10_000n + 1n, "2 bp of the expected 4,150 USDC, rounded up, plus one unit — never the 1 bp a floored 1.3 would have been");
  });

  it("the defect, pinned: the Base dispatcher refuses a record that still carries the Solana rung's action name — which is what every bridge burn would have been before the translation", async () => {
    const b = await baseRig();
    const untranslated = { ...toBaseRecord(solanaRecord(), ACCOUNT_A), action: "derisk" };
    const res = await b.dispatcher.dispatchBurn({ record: untranslated, usdcNeeded: 1_000_000_000n, expectedRecipient: RECIPIENT, collateralAssetForProbe: CBBTC_FIXTURE, maxFeeBps: 2, minFinalityThreshold: 1000 });
    assert.equal(res.status, "REFUSED");
    if (res.status === "REFUSED") assert.match(res.reason, /unknown burn action derisk/);
    assert.equal(b.oil.executed.filter((e) => e.mutate).length, 0, "nothing was sent");
    // and the de-risk translation reaches the planner: two thirds, not everything
    const burner = new KeeperBaseBurner({ base: b.dispatcher, fees: null, policy: CCTP_FINALITY_POLICY_DEFAULTS, collateralAssetForProbe: CBBTC_FIXTURE, log: new Logger(memorySink().sink, "debug") });
    const out = await burner.dispatch(input({ baseAccount: ACCOUNT_A, action: "burn-derisk", usdcNeeded: 1_000_000_000n }));
    assert.equal(out.status, "SENT", JSON.stringify(out));
    const call = b.oil.executed.filter((e) => e.mutate)[0]!;
    assert.deepEqual(call.calls.map((c) => c.selector), [GRANT_SELECTORS["StrategyRouter.closeLpAndBurn"]]);
    assert.ok(b.oil.positions.get(ACCOUNT_A.toLowerCase())!.length >= 1, "a de-risk leaves LP behind; an emergency would have closed both ids");
  });
});

describe("KeeperBaseBurner.dispatch", () => {
  it("the Base dispatcher sees the BASE account, never the Solana PDA; the intent carries the recipient, the need, the probe asset; the bridge comes back with the account and the finality it was sent with", async () => {
    const r = rig();
    const out = await r.burner.dispatch(input());
    assert.equal(r.base.intents.length, 1);
    const i = r.base.intents[0]!;
    assert.equal(i.record.account, BASE.toLowerCase());
    assert.notEqual(i.record.account, SOLANA_ACCOUNT);
    assert.equal(i.record.key, `${SOLANA_ACCOUNT}:1:1:derisk`, "the Solana key survives — the store finds the record by it");
    assert.equal(i.expectedRecipient, RECIPIENT);
    assert.equal(i.usdcNeeded, 4_500_000_000n);
    assert.equal(i.collateralAssetForProbe, CBBTC);
    assert.equal(out.status, "SENT");
    if (out.status !== "SENT") return;
    assert.deepEqual(out.bridge, { chain: "base", stage: "burn-sent", burnTxHash: BURN_TX, amountUsdc: "0", recipient: RECIPIENT, baseAccount: BASE, minFinalityThreshold: 1000, maxFeeBps: 2 });
  });

  it("Fast or Standard comes from Circle's live numbers: the recorded schedule → 2 bp / 1000; an allowance the need would exhaust → 0 bp / 2000; no fee client → the ceiling / 1000", async () => {
    const fast = rig();
    await fast.burner.dispatch(input());
    assert.equal(fast.base.intents[0]!.maxFeeBps, 2, "1.3 bp with 50 % headroom, rounded up");
    assert.equal(fast.base.intents[0]!.minFinalityThreshold, 1000);
    assert.ok(fast.lines.some((l) => /finality chosen/.test(l) && /"path":"fast"/.test(l)), fast.lines.join("\n"));

    const short = rig({ fees: fees((url) => (url.endsWith("/fees/6/5") ? json(body("/fees/6/5")) : json({ allowance: 1_000, lastUpdated: "2026-09-25T21:58:40.744Z" }))) });
    await short.burner.dispatch(input({ usdcNeeded: 4_500_000_000n }));
    assert.equal(short.base.intents[0]!.maxFeeBps, 0);
    assert.equal(short.base.intents[0]!.minFinalityThreshold, 2000);
    assert.ok(short.lines.some((l) => /"path":"standard"/.test(l) && /exceeds the usable Fast allowance/.test(l)));

    const none = rig({ fees: null });
    await none.burner.dispatch(input());
    assert.equal(none.base.intents[0]!.maxFeeBps, CCTP_FINALITY_POLICY_DEFAULTS.maxFastFeeBps, "nothing tighter is known");
    assert.equal(none.base.intents[0]!.minFinalityThreshold, 1000);
    assert.ok(none.lines.some((l) => /no Circle fee client configured/.test(l)));
  });

  it("a chooser refusal never reaches the Base dispatcher, and is not permanent — the schedule can change", async () => {
    const r = rig({ fees: fees((url) => (url.endsWith("/fees/6/5") ? json([{ finalityThreshold: 1000, minimumFee: 30 }, { finalityThreshold: 2000, minimumFee: 20 }]) : json(body("/allowance")))) });
    const out = await r.burner.dispatch(input());
    assert.equal(out.status, "REFUSED");
    if (out.status !== "REFUSED") return;
    assert.match(out.reason, /finality: Circle's Standard minimum is 20 bp/);
    assert.equal(out.permanent, undefined);
    assert.equal(r.base.intents.length, 0, "nothing was planned or simulated on Base");
  });

  it("the pre-send write is forwarded: what the Base dispatcher persists before the broadcast reaches the Solana record's hook", async () => {
    const seen: { nonce?: number; closeIds: bigint[] }[] = [];
    const base = fakeBase({
      dispatch: async (i) => {
        await i.persistBeforeSend?.({ nonce: 7, closeIds: [1n, 3n] });
        return { status: "SENT", txHash: BURN_TX, bridge: { chain: "base", stage: "burn-sent", burnTxHash: BURN_TX, amountUsdc: "0", recipient: RECIPIENT } };
      },
    });
    const r = rig({ base });
    await r.burner.dispatch(input({ persistBeforeSend: async (info) => { seen.push(info); } }));
    assert.deepEqual(seen, [{ nonce: 7, closeIds: [1n, 3n] }]);
  });

  it("a record whose pre-send nonce is persisted but whose send never reported is named as 'a burn may already be out' before the re-dispatch", async () => {
    const r = rig();
    await r.burner.dispatch(input({ record: solanaRecord({ sentNonce: 7, attempts: 1 }) }));
    assert.ok(r.lines.some((l) => /a Base burn may already be out/.test(l) && /"sentNonce":7/.test(l)), r.lines.join("\n"));
    const settled = rig();
    await settled.burner.dispatch(input({ record: solanaRecord({ sentNonce: 7, bridge: { chain: "base", stage: "delivered", burnTxHash: BURN_TX, amountUsdc: "1" } }) }));
    assert.ok(!settled.lines.some((l) => /may already be out/.test(l)), "a record with a bridge stage has a receipt: nothing to warn about");
  });

  it("every Base result maps through unchanged apart from the bridge fields it gains: REFUSED (permanent kept), FAILED, SUPERSEDED", async () => {
    for (const res of [
      { status: "REFUSED", reason: "no active grant", permanent: true },
      { status: "FAILED", error: "send failed" },
      { status: "SUPERSEDED", reason: "nothing to close" },
    ] as BurnResult[]) {
      const r = rig({ base: fakeBase({ dispatch: () => res }) });
      assert.deepEqual(await r.burner.dispatch(input()), res);
    }
  });
});

describe("KeeperBaseBurner.confirm", () => {
  it("translates with the Base account the bridge record carries and merges the fresh stage over the kept fields (account, finality)", async () => {
    const r = rig();
    const rec = solanaRecord({ status: "SENT", attempts: 1, bridge: { chain: "base", stage: "burn-sent", burnTxHash: BURN_TX, amountUsdc: "0", recipient: RECIPIENT, baseAccount: BASE, minFinalityThreshold: 1000, maxFeeBps: 2 } });
    const out = await r.burner.confirm(rec);
    assert.equal(r.base.confirms.length, 1);
    assert.equal(r.base.confirms[0]!.account, BASE.toLowerCase());
    assert.equal(r.base.confirms[0]!.txHash, BURN_TX);
    assert.equal(out.status, "CONFIRMED");
    if (out.status !== "CONFIRMED") return;
    assert.equal(out.bridge?.stage, "burn-confirmed");
    assert.equal(out.bridge?.amountUsdc, "1000000000", "the receipt's amount replaces the pre-send zero");
    assert.equal(out.bridge?.baseAccount, BASE, "kept from the record: confirmBurn builds its bridge info without it");
    assert.equal(out.bridge?.minFinalityThreshold, 1000);
    assert.equal(out.bridge?.maxFeeBps, 2);
  });

  it("a bridge record with no Base account cannot be judged: REFUSED permanently, by name, and the Base dispatcher is not asked", async () => {
    const r = rig();
    const out = await r.burner.confirm(solanaRecord({ status: "SENT", bridge: { chain: "base", stage: "burn-sent", burnTxHash: BURN_TX, amountUsdc: "0" } }));
    assert.equal(out.status, "REFUSED");
    if (out.status === "REFUSED") {
      assert.equal(out.permanent, true);
      assert.match(out.reason, /carries no Base account/);
    }
    assert.equal(r.base.confirms.length, 0);
    const none = await r.burner.confirm(solanaRecord({ status: "SENT" }));
    assert.equal(none.status, "FAILED");
  });
});
