/**
 * The perps dispatcher through REAL viem clients over the HyperEVM fake (design §5, "dispatcher"): the world
 * re-check, both grants judged as the venue judges them, the plan, a simulation whose revert is classified by the
 * venue's own error name, the nonce and the intent persisted BEFORE the broadcast, and `confirm` that waits the
 * CoreWriter delay and then judges the record against what landed — an IOC that did not fill is CONFIRMED and
 * said, never a failure.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWalletClient, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hyperEvm } from "viem/chains";
import { PERP_RUNG_INDEX, topUpE6ForDistance, distanceBpsForHfBps, type HfRungId } from "@zyo/shared";
import { Logger, memorySink } from "../src/log.js";
import type { Delivery, KeeperEvent, Notifier } from "../src/notify/notifier.js";
import { KeeperPerpsDispatcher, PerpsObserveOnlyDispatcher, perpGrantBounds, type PerpsDispatchRecord, type PerpsGrantSnapshot } from "../src/perps/dispatcher.js";
import { PerpsReader } from "../src/perps/reader.js";
import type { Address } from "../src/types/evm.js";
import { A_10, A_20, FakeHyperEvm, MARK_10, MARK_20, MMR, PERP_ACCOUNT_A, PERP_OWNER_A, RESERVE0, SZ, SZ_DEC, VENUE, rung0 } from "./perpsFixtures.js";

const KEY = ("0x" + "42".repeat(32)) as Hex;
const keeperAccount = privateKeyToAccount(KEY);
const KEEPER = keeperAccount.address.toLowerCase() as Address;
const OTHER = "0x9999999999999999999999999999999999999999" as Address;
const ACTION: Record<HfRungId, string> = { warn: "notify", repay: "repay", derisk: "derisk", emergency: "emergency-unwind" };

class RecordingNotifier implements Notifier {
  events: KeeperEvent[] = [];
  failures = 0;
  personReached = false;
  readonly channels: readonly string[] = ["recording"];
  get hasPersonChannel(): boolean {
    return this.personReached;
  }
  async deliver(e: KeeperEvent): Promise<Delivery> {
    this.events.push(e);
    return { personReached: this.personReached };
  }
}

function rig(opts: { actionDelayBlocks?: number } = {}) {
  const evm = new FakeHyperEvm();
  const client = evm.chain.publicClient();
  const wallet = createWalletClient({ account: keeperAccount, chain: hyperEvm, transport: evm.chain.transport() });
  const sink = memorySink();
  const log = new Logger(sink.sink, "debug", { svc: "test" });
  const reader = new PerpsReader(client, VENUE, { deadlineMs: 5_000, independent: null });
  const notifier = new RecordingNotifier();
  const d = new KeeperPerpsDispatcher({
    client,
    wallet,
    keeper: KEEPER,
    venue: VENUE,
    reader,
    valuationParams: { independentMaxAgeS: 120, oracleDeviationBps: 200, requireIndependent: false },
    deriskFractionBps: 3_333,
    planMarginBps: 50,
    actionDelayBlocks: opts.actionDelayBlocks ?? 5,
    deadlineMs: 5_000,
    log,
    notifier,
  });
  return { evm, client, d, reader, notifier, sink, log };
}

const record = (account: Address, rung: HfRungId, over: Partial<PerpsDispatchRecord> = {}): PerpsDispatchRecord => ({
  key: `${account}:1:1:${ACTION[rung]}`,
  account,
  episode: 1,
  seq: 1,
  action: ACTION[rung],
  rung,
  hf: 1.5,
  status: "PENDING",
  attempts: 0,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
  disarmHf: rung0(rung).disarmHfBps / 10_000,
  ...over,
});

const targetD = (id: HfRungId) => distanceBpsForHfBps(Math.ceil(rung0(id).disarmHfBps * 1.005));

describe("KeeperPerpsDispatcher — the top-up rung, sent and judged", () => {
  it("sends execAsKeeper([{venue, protect(1, reserve, 0)}]) with the nonce and the intent persisted first, and surfaces both grants", async () => {
    const { evm, d } = rig();
    evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
    evm.scene(PERP_ACCOUNT_A, 10);
    const need = topUpE6ForDistance({ accountValueE6: A_10, szi: -SZ, markRaw: MARK_10, szDecimals: SZ_DEC, mmrBps: MMR }, targetD("repay"));
    assert.ok(need > RESERVE0, "the +10 % scene needs more than the 1× reserve (RISKS §23)");
    let persisted: { nonce?: number; perp: NonNullable<PerpsDispatchRecord["perp"]> } | null = null;
    let sentAtPersist = -1;
    let grant: PerpsGrantSnapshot | null = null;
    const r = await d.dispatch({
      record: record(PERP_ACCOUNT_A, "repay"),
      persistBeforeSend: async (info) => {
        persisted = info;
        sentAtPersist = evm.sent.length;
      },
      onGrantRead: (g) => {
        grant = g;
      },
    });
    assert.equal(r.status, "SENT");
    assert.equal(evm.sent.length, 1);
    const s = evm.sent[0]!;
    assert.equal(s.from.toLowerCase(), KEEPER);
    assert.equal(s.to.toLowerCase(), PERP_ACCOUNT_A.toLowerCase());
    assert.equal(s.rung, 1);
    assert.equal(s.topUpE6, RESERVE0, "the reserve binds: all of it moves");
    assert.equal(s.reduceSz, 0n);
    assert.equal(s.nonce, 0);
    assert.equal(sentAtPersist, 0, "the intent was persisted BEFORE the broadcast");
    assert.deepEqual(persisted, { nonce: 0, perp: { rung: 1, topUpE6: RESERVE0.toString(), reduceSz: "0", sziBefore: (-SZ).toString(), spotE6Before: RESERVE0.toString() }, plan: (persisted as unknown as { plan: unknown }).plan });
    assert.ok(grant !== null && (grant as PerpsGrantSnapshot).live);
    assert.equal((grant as unknown as PerpsGrantSnapshot).allowedRungs, 0b1110);
    assert.equal((grant as unknown as PerpsGrantSnapshot).topUpLeft, 10_000_000_000n);
    assert.equal(evm.pending.length, 1, "the CoreWriter action is queued, not landed");
    assert.equal(evm.accounts.get(PERP_ACCOUNT_A.toLowerCase())!.grant!.topUpSpent, RESERVE0, "the budget was charged on the receipt, before anything landed");
  });

  it("confirm waits the CoreWriter delay, then CONFIRMS on the spot balance having moved — or says it did not", async () => {
    const { evm, d } = rig({ actionDelayBlocks: 5 });
    evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
    evm.scene(PERP_ACCOUNT_A, 10);
    const rec = record(PERP_ACCOUNT_A, "repay");
    let perp: NonNullable<PerpsDispatchRecord["perp"]> | null = null;
    const sent = await d.dispatch({ record: rec, persistBeforeSend: async (i) => void (perp = i.perp) });
    assert.equal(sent.status, "SENT");
    const withTx: PerpsDispatchRecord = { ...rec, status: "SENT", txHash: (sent as { txHash: Hex }).txHash, perp: perp! };
    evm.advance(2n);
    const early = await d.confirm(withTx);
    assert.equal(early.status, "SENT");
    assert.match((early as { note?: string }).note ?? "", /waiting 3 more block\(s\) for the CoreWriter action/);
    evm.advance(3n);
    // (a) it did not land
    const missed = await d.confirm(withTx);
    assert.equal(missed.status, "CONFIRMED");
    assert.match((missed as { note?: string }).note ?? "", /did not land on HyperCore within 5 block\(s\): the top-up of 348979462 did not move .* the rung re-arms and re-plans; the grant's budget was charged/);
    // (b) it landed
    evm.land();
    const landed = await d.confirm(withTx);
    assert.equal(landed.status, "CONFIRMED");
    assert.match((landed as { note?: string }).note ?? "", /top-up of 348979462 moved \(spot 348979462 → 0\)/);
    assert.equal(evm.accounts.get(PERP_ACCOUNT_A.toLowerCase())!.spotE6, 0n);
    // a record from before this build: confirmed on the receipt alone, and said
    const old = await d.confirm({ ...withTx, perp: undefined });
    assert.equal(old.status, "CONFIRMED");
    assert.match((old as { note?: string }).note ?? "", /no intent on the record/);
  });

  it("the de-risk rung: an IOC that did not fill, filled in part, or filled — each said by name; a receipt that reverted is FAILED", async () => {
    const { evm, d } = rig({ actionDelayBlocks: 1 });
    evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER, { spotE6: 0n });
    evm.scene(PERP_ACCOUNT_A, 20);
    const rec = record(PERP_ACCOUNT_A, "derisk");
    let perp: NonNullable<PerpsDispatchRecord["perp"]> | null = null;
    const sent = await d.dispatch({ record: rec, persistBeforeSend: async (i) => void (perp = i.perp) });
    assert.equal(sent.status, "SENT");
    const asked = evm.sent[0]!.reduceSz;
    assert.ok(asked >= 104n && asked <= 166n, `reduce ${asked}`);
    assert.equal(evm.sent[0]!.topUpE6, 0n);
    const withTx: PerpsDispatchRecord = { ...rec, status: "SENT", txHash: (sent as { txHash: Hex }).txHash, perp: perp! };
    evm.advance(1n);
    const none = await d.confirm(withTx);
    assert.equal(none.status, "CONFIRMED");
    assert.match((none as { note?: string }).note ?? "", new RegExp(`the reduce-only IOC of ${asked} did not fill \\(size still 500\\)`));
    evm.land({ fill: 10n });
    const part = await d.confirm(withTx);
    assert.equal(part.status, "CONFIRMED");
    assert.match((part as { note?: string }).note ?? "", new RegExp(`filled 10 of ${asked} \\(size 500 → 490\\)`));
    // the rest fills on a later tick
    evm.accounts.get(PERP_ACCOUNT_A.toLowerCase())!.szi = -(SZ - asked);
    const all = await d.confirm(withTx);
    assert.equal(all.status, "CONFIRMED");
    assert.match((all as { note?: string }).note ?? "", new RegExp(`reduce of ${asked} filled`));
    // a reverted receipt
    const bad = ("0x" + "ee".repeat(32)) as Hex;
    evm.chain.receipts.set(bad, { status: "0x0", blockNumber: evm.chain.blockNumber });
    const reverted = await d.confirm({ ...withTx, txHash: bad });
    assert.equal(reverted.status, "FAILED");
    assert.match((reverted as { error: string }).error, /reverted on chain after a clean simulation/);
    // still pending
    const pending = await d.confirm({ ...withTx, txHash: ("0x" + "dd".repeat(32)) as Hex });
    assert.equal(pending.status, "SENT");
  });
});

describe("KeeperPerpsDispatcher — refusals, by the venue's own names", () => {
  it("a simulated revert is classified: RungNotAllowed permanent, RungNotCrossed superseding, ReserveShort transient, MarkOracleDeviation failed, the account's NotGranted permanent", async () => {
    const { evm, d } = rig();
    const a = evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
    evm.scene(PERP_ACCOUNT_A, 10);
    const cases: [string, readonly unknown[], string, boolean | undefined][] = [
      ["RungNotAllowed", [1], "REFUSED", true],
      ["RungNotCrossed", [1, 16_000, 15_000], "SUPERSEDED", undefined],
      ["ReserveShort", [0n, 100n], "REFUSED", false],
      ["MarkOracleDeviation", [1n, 2n, 1111n], "FAILED", undefined],
      ["NotGranted", [KEEPER, VENUE, "0x12345678"], "REFUSED", true],
      ["NoEntry", [], "REFUSED", true],
      ["TopUpBudgetExceeded", [5n, 1n], "REFUSED", false],
    ];
    for (const [name, args, status, permanent] of cases) {
      a.revertNext = { name, args };
      const r = await d.dispatch({ record: record(PERP_ACCOUNT_A, "repay") });
      assert.equal(r.status, status, name);
      const text = "reason" in r ? r.reason : "error" in r ? r.error : "";
      assert.match(text, new RegExp(`simulation (refused|failed): ${name}\\(`), name);
      if (permanent !== undefined) assert.equal((r as { permanent?: boolean }).permanent, permanent, name);
    }
    assert.equal(evm.sent.length, 0, "nothing was broadcast");
  });

  it("the grants are judged before any simulation: another keeper's grant, a Permission without allowCallback, an expired one, a stale epoch — each permanent and named; a rolled period restores the budgets", async () => {
    const { evm, d } = rig();
    const a = evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
    evm.scene(PERP_ACCOUNT_A, 10);
    const refused = async (re: RegExp) => {
      const r = await d.dispatch({ record: record(PERP_ACCOUNT_A, "repay") });
      assert.equal(r.status, "REFUSED");
      if (r.status === "REFUSED") {
        assert.equal(r.permanent, true);
        assert.match(r.reason, re);
      }
    };
    const grant = a.grant!;
    grant.keeper = OTHER;
    await refused(/names another keeper \(0x9999/);
    grant.keeper = KEEPER;
    a.permission!.allowCallback = false;
    await refused(/lacks allowCallback .* NotActivePeripheral/);
    a.permission!.allowCallback = true;
    a.permission!.expiry = Number(evm.nowS) - 1;
    await refused(/the Permission expired/);
    a.permission!.expiry = Number(evm.nowS) + 1_000;
    grant.expiry = Number(evm.nowS) - 1;
    await refused(/the PerpGrant expired/);
    grant.expiry = Number(evm.nowS) + 1_000;
    a.epoch = 1n;
    await refused(/epoch 0, the account is at 1 \(revokeAll\)/);
    a.epoch = 0n;
    // a spent budget in a period that has rolled is a fresh budget
    grant.topUpSpent = grant.topUpUsdcPerPeriod;
    grant.periodStart = Number(evm.nowS) - grant.period - 1;
    let seen: PerpsGrantSnapshot | null = null;
    const r = await d.dispatch({ record: record(PERP_ACCOUNT_A, "repay"), onGrantRead: (g) => void (seen = g) });
    assert.equal(r.status, "SENT");
    assert.equal((seen as unknown as PerpsGrantSnapshot).topUpLeft, grant.topUpUsdcPerPeriod);
    assert.equal(evm.sent.length, 1);
  });

  it("perpGrantBounds: a budget spent inside the period is what is left; a zero reduce budget is 'reduce not allowed'", () => {
    const now = 1_789_000_100n;
    const bounds = perpGrantBounds(
      {
        permission: { active: true, maxValuePerPeriod: 0n, valueSpent: 0n, period: 86_400, expiry: Number(now) + 100, periodStart: Number(now) - 10, allowCallback: true },
        accountEpoch: 3n,
        grant: { keeper: KEEPER, expiry: Number(now) + 200, period: 86_400, periodStart: Number(now) - 10, allowedRungs: 0b1110, topUpUsdcPerPeriod: 1_000n, reduceSzPerPeriod: 0n, maxSlippageBps: 50, topUpSpent: 300n, reduceSpent: 0n, epoch: 3n },
      },
      KEEPER,
      now
    );
    assert.equal(bounds.live, true);
    assert.equal(bounds.topUpLeft, 700n);
    assert.equal(bounds.reduceAllowed, false);
    assert.equal(bounds.expiry, Number(now) + 100, "the earlier of the two expiries");
  });

  it("the world check: a healthy short is SUPERSEDED, no short is SUPERSEDED, a precompile that does not answer is FAILED (UNKNOWN), no entry record is permanent", async () => {
    const { evm, d } = rig();
    const a = evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
    const healthy = await d.dispatch({ record: record(PERP_ACCOUNT_A, "repay") });
    assert.equal(healthy.status, "SUPERSEDED");
    assert.match((healthy as { reason: string }).reason, /already at or above the disarm level/);
    evm.scene(PERP_ACCOUNT_A, 10);
    a.entry = null;
    const noEntry = await d.dispatch({ record: record(PERP_ACCOUNT_A, "repay") });
    assert.equal(noEntry.status, "REFUSED");
    assert.match((noEntry as { reason: string }).reason, /NoEntry/);
    assert.equal((noEntry as { permanent?: boolean }).permanent, true);
    a.entry = { distanceBps: 4350, hfBps: 17699, sz: SZ, reserveE6: RESERVE0, at: 1 };
    evm.failing.add("markPx");
    const unknown = await d.dispatch({ record: record(PERP_ACCOUNT_A, "repay") });
    assert.equal(unknown.status, "FAILED");
    assert.match((unknown as { error: string }).error, /valuation UNKNOWN before send: P0 markPx\(0x806\)/);
    evm.failing.delete("markPx");
    a.szi = 0n;
    const gone = await d.dispatch({ record: record(PERP_ACCOUNT_A, "repay") });
    assert.equal(gone.status, "SUPERSEDED");
    assert.match((gone as { reason: string }).reason, /no short left/);
    assert.equal(evm.sent.length, 0);
  });

  it("the record's own disarm level is what a resumed record is judged against; a warn record cannot be dispatched on chain", async () => {
    const { evm, d } = rig();
    evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
    evm.scene(PERP_ACCOUNT_A, 10);
    // a disarm level far below the live HF: nothing to do
    const low = await d.dispatch({ record: record(PERP_ACCOUNT_A, "repay", { disarmHf: 1.01 }) });
    assert.equal(low.status, "SUPERSEDED");
    const warn = await d.dispatch({ record: record(PERP_ACCOUNT_A, "warn", { action: "repay" }) });
    assert.equal(warn.status, "REFUSED");
    assert.match((warn as { reason: string }).reason, /rung warn is not one the venue acts on/);
  });
});

describe("the notify rung and observe-only", () => {
  it("notify carries the perps copy (the distance from the HF) and is NOTIFIED only when a person-facing channel took it", async () => {
    const { d, notifier } = rig();
    const rec = record(PERP_ACCOUNT_A, "warn", { hf: 1.6 });
    const logged = await d.dispatch({ record: rec });
    assert.equal(logged.status, "LOGGED_ONLY");
    notifier.personReached = true;
    const told = await d.dispatch({ record: rec });
    assert.equal(told.status, "NOTIFIED");
    const e = notifier.events.at(-1)!;
    assert.equal(e.kind, "notify");
    assert.equal(e.detail?.chain, "hyperevm");
    assert.equal(e.detail?.distancePct, "37.50");
    assert.equal(e.detail?.copy, "your short is 37.50 % from liquidation");
  });

  it("observe-only refuses every action permanently, by name, and confirms nothing", async () => {
    const sink = memorySink();
    const notifier = new RecordingNotifier();
    const d = new PerpsObserveOnlyDispatcher(new Logger(sink.sink, "debug", { svc: "test" }), notifier);
    const r = await d.dispatch({ record: record(PERP_ACCOUNT_A, "repay") });
    assert.equal(r.status, "REFUSED");
    assert.match((r as { reason: string }).reason, /observe-only mode: no KEEPER_PERPS_PRIVATE_KEY/);
    assert.equal((r as { permanent?: boolean }).permanent, true);
    assert.equal((await d.confirm()).status, "REFUSED");
    const n = await d.dispatch({ record: record(PERP_ACCOUNT_A, "warn", { hf: 1.5 }) });
    assert.equal(n.status, "LOGGED_ONLY");
    assert.equal(notifier.events[0]!.detail?.mode, "observe-only");
  });
});

// keep the rung index import honest: the venue numbers them 1..3 and warn is 0
void PERP_RUNG_INDEX;
void MARK_20;
void A_20;
