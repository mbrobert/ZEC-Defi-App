/**
 * The perps monitor against the HyperEVM fake (design §5, "monitor"): discovery from the factory's logs with
 * the cursor, the account's own ladder from the venue's entry record, the shared ladder on the equivalent HF,
 * the store's idempotency record around every dispatch, fail-closed UNKNOWN streaks, and the re-arm of a rung
 * whose CONFIRMED action did not land on HyperCore — the ordinary case for an IOC the book did not fill.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { accountCreatedEvent } from "../src/abi/oilskin.js";
import { Logger, memorySink } from "../src/log.js";
import type { Delivery, KeeperEvent, Notifier } from "../src/notify/notifier.js";
import type { PerpsDispatchIntent, PerpsDispatchRecord, PerpsDispatchResult, PerpsDispatcher } from "../src/perps/dispatcher.js";
import { PerpsMonitor, perpLadderRungs, type PerpsMonitorConfig } from "../src/perps/monitor.js";
import { PerpsReader } from "../src/perps/reader.js";
import type { PerpsValuationParams } from "../src/perps/valuation.js";
import { AccountDiscovery } from "../src/services/discovery.js";
import { KeeperStore } from "../src/store/keeperStore.js";
import type { Address } from "../src/types/evm.js";
import { FakeHyperEvm, HF0, PARAMS, PERPS_FACTORY, PERP_ACCOUNT_A, PERP_ACCOUNT_B, PERP_OWNER_A, PERP_OWNER_B, RESERVE0, VENUE, rung0 } from "./perpsFixtures.js";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "keeper-perps-monitor-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
let n = 0;
const freshPath = () => join(dir, `m${++n}.json`);
const KEEPER = "0x1111111111111111111111111111111111111111" as Address;
const hashOf = (s: string): Hex => keccak256(toHex(s));

/** Recording dispatcher whose behaviour is scripted per call; it also snapshots the store ON DISK at dispatch time. */
class FakeDispatcher implements PerpsDispatcher {
  calls: { intent: PerpsDispatchIntent; storeOnDisk: { dispatches: { key: string; status: string; perp?: unknown; sentNonce?: number }[] } }[] = [];
  confirms: PerpsDispatchRecord[] = [];
  script: ((intent: PerpsDispatchIntent) => Promise<PerpsDispatchResult> | PerpsDispatchResult)[] = [];
  default: (intent: PerpsDispatchIntent) => PerpsDispatchResult = (i) => (i.record.action === "notify" ? { status: "NOTIFIED" } : { status: "CONFIRMED", txHash: hashOf(i.record.key) });
  constructor(private readonly storePath: string) {}
  async dispatch(intent: PerpsDispatchIntent): Promise<PerpsDispatchResult> {
    const storeOnDisk = JSON.parse(await readFile(this.storePath, "utf8"));
    this.calls.push({ intent, storeOnDisk });
    const fn = this.script.shift();
    return fn ? fn(intent) : this.default(intent);
  }
  async confirm(record: PerpsDispatchRecord): Promise<PerpsDispatchResult> {
    this.confirms.push(record);
    return { status: "CONFIRMED", txHash: record.txHash! };
  }
}

class RecordingNotifier implements Notifier {
  events: KeeperEvent[] = [];
  failures = 0;
  personReached = true;
  readonly channels: readonly string[] = ["recording"];
  get hasPersonChannel(): boolean {
    return this.personReached;
  }
  async deliver(e: KeeperEvent): Promise<Delivery> {
    this.events.push(e);
    return { personReached: this.personReached };
  }
}

const PARAMS_V: PerpsValuationParams = { independentMaxAgeS: 120, oracleDeviationBps: 200, requireIndependent: false };

async function rig() {
  const evm = new FakeHyperEvm();
  const client = evm.chain.publicClient();
  const path = freshPath();
  const store = new KeeperStore<Address, Hex>(path);
  await store.open();
  const sink = memorySink();
  const log = new Logger(sink.sink, "debug", { svc: "test" });
  const notifier = new RecordingNotifier();
  const fake = new FakeDispatcher(path);
  const escalations: { account: string; reasons: string[]; streak: number }[] = [];
  const reader = new PerpsReader(client, VENUE, { deadlineMs: 5_000, independent: null });
  const discovery = new AccountDiscovery(client, { factory: PERPS_FACTORY, event: accountCreatedEvent, argNames: { owner: "owner", account: "account" }, chunkBlocks: 1_000, deadlineMs: 5_000 });
  const config: PerpsMonitorConfig = { concurrency: 2, unknownEscalationStreak: 2, maxDispatchAttempts: 3, maxResumePerTick: 25, dispatchDeadlineMs: 5_000, maxRungRefires: 2, discoveryFromBlock: evm.chain.blockNumber };
  const monitor = new PerpsMonitor({ reader, discovery, store, floorLadder: perpLadderRungs(PARAMS.minEntryDistanceBps), dispatcher: fake, log, config, valuationParams: PARAMS_V, notifier, onEscalate: (e) => escalations.push(e) });
  const { ProgressWatchdog } = await import("../src/watchdog.js");
  const watchdog = new ProgressWatchdog({ stallMs: 10_000, backoff: { initialMs: 10, maxMs: 100, factor: 2 } });
  const tick = async () => {
    evm.advance();
    return monitor.tick(watchdog.beginTick());
  };
  return { evm, path, store, fake, sink, notifier, escalations, monitor, tick, close: () => store.close() };
}

describe("PerpsMonitor", () => {
  it("discovers accounts from the factory's logs, persists the cursor at the head, and registers each once", async () => {
    const r = await rig();
    try {
      r.evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
      r.evm.addAccount(PERP_ACCOUNT_B, PERP_OWNER_B, KEEPER);
      const t1 = await r.tick();
      assert.equal(t1.discovered, 2);
      assert.equal(t1.evaluated, 2);
      assert.equal(r.store.cursor, r.evm.chain.blockNumber);
      assert.equal(r.store.getAccount(PERP_ACCOUNT_A.toLowerCase() as Address)?.owner, PERP_OWNER_A.toLowerCase());
      const t2 = await r.tick();
      assert.equal(t2.discovered, 0);
      assert.equal(t2.evaluated, 2);
    } finally {
      await r.close();
    }
  });

  it("a healthy short: OK at HF 1.7699, distance 4350, nothing fires; the record carries the venue's entry as the ladder's origin", async () => {
    const r = await rig();
    try {
      r.evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
      const t = await r.tick();
      const o = t.outcomes[0]!;
      assert.equal(o.valuation, "OK");
      assert.equal(o.hf, HF0 / 10_000);
      assert.equal(o.distanceBps, 4350);
      assert.equal(o.fired, null);
      const rec = r.store.getAccount(PERP_ACCOUNT_A.toLowerCase() as Address)!;
      assert.equal(rec.lastHf, 1.7699);
      assert.equal(rec.entryHf, 1.7699);
      assert.deepEqual(rec.ladder.fired, []);
      assert.equal(r.fake.calls.length, 0);
    } finally {
      await r.close();
    }
  });

  it("+10 %: the top-up rung fires on the ACCOUNT's ladder — the record is PENDING on disk before the dispatcher is called, carries the rung's disarm level, and the owner is told in the perps copy", async () => {
    const r = await rig();
    try {
      r.evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
      r.evm.scene(PERP_ACCOUNT_A, 10);
      const t = await r.tick();
      const o = t.outcomes[0]!;
      assert.equal(o.fired, "repay");
      assert.equal(o.dispatch?.status, "CONFIRMED");
      assert.equal(r.fake.calls.length, 1);
      const { intent, storeOnDisk } = r.fake.calls[0]!;
      assert.equal(intent.record.rung, "repay");
      assert.equal(intent.record.action, "repay");
      assert.equal(intent.record.disarmHf, rung0("repay").disarmHfBps / 10_000);
      assert.ok(intent.record.hf < rung0("repay").hfBps / 10_000 && intent.record.hf >= rung0("derisk").hfBps / 10_000, `hf ${intent.record.hf}`);
      assert.equal(storeOnDisk.dispatches[0]!.status, "PENDING");
      assert.equal(storeOnDisk.dispatches[0]!.key, intent.record.key);
      const rec = r.store.getAccount(PERP_ACCOUNT_A.toLowerCase() as Address)!;
      assert.deepEqual([...rec.ladder.fired].sort(), ["repay", "warn"], "the gap down crossed warn too; the most severe fired");
      assert.equal(rec.episode, 1);
      const fired = r.notifier.events.find((e) => e.kind === "rung-fired")!;
      assert.equal(fired.detail?.chain, "hyperevm");
      assert.match(String(fired.detail?.copy), /^your short is \d+\.\d\d % from liquidation; ZEC is at \$1692\.84$/);
      // the intent the dispatcher persists lands on the record with the nonce
      await intent.persistBeforeSend!({ nonce: 7, perp: { rung: 1, topUpE6: RESERVE0.toString(), reduceSz: "0", sziBefore: "-500", spotE6Before: RESERVE0.toString() }, plan: { kind: "refused", reason: "n/a", permanent: false } });
      const d = r.store.getDispatch(intent.record.key)!;
      assert.equal(d.sentNonce, 7);
      assert.equal(d.perp?.topUpE6, RESERVE0.toString());
      // the grant surfaced by the dispatcher is bookkept on the account
      intent.onGrantRead!({ live: false, why: "the PerpGrant expired at 1", expiry: 1, allowedRungs: 0b1110, topUpLeft: 0n, reduceLeft: 0n, reduceAllowed: true, maxSlippageBps: 50 });
      await new Promise((res) => setTimeout(res, 20));
      assert.match(r.store.getAccount(PERP_ACCOUNT_A.toLowerCase() as Address)!.grant?.selector ?? "", /protect rungs:1110 \(the PerpGrant expired/);
    } finally {
      await r.close();
    }
  });

  it("UNKNOWN streaks: a precompile that does not answer is named on every tick and escalates at the configured count; nothing fires", async () => {
    const r = await rig();
    try {
      r.evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
      r.evm.scene(PERP_ACCOUNT_A, 40);
      r.evm.failing.add("accountMarginSummary");
      await r.tick();
      assert.equal(r.escalations.length, 0);
      const t = await r.tick();
      assert.equal(t.outcomes[0]!.valuation, "UNKNOWN");
      assert.equal(r.escalations.length, 1);
      assert.match(r.escalations[0]!.reasons.join(";"), /P0 accountMarginSummary\(0x80f\) did not answer/);
      assert.equal(r.escalations[0]!.streak, 2);
      assert.equal(r.fake.calls.length, 0, "fail closed: no rung acted on a wiped read");
      const rec = r.store.getAccount(PERP_ACCOUNT_A.toLowerCase() as Address)!;
      assert.equal(rec.unknownStreak, 2);
      r.evm.failing.delete("accountMarginSummary");
      const t3 = await r.tick();
      assert.equal(t3.outcomes[0]!.fired, "emergency", "the read back, the close rung fires");
    } finally {
      await r.close();
    }
  });

  it("a CONFIRMED action that did not land re-arms the rung and re-plans on the next tick, bounded per rung, with the owner told once at the cap; the close rung never gives up", async () => {
    const r = await rig();
    try {
      r.evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER, { spotE6: 0n });
      r.evm.scene(PERP_ACCOUNT_A, 20);
      const unfilled = (i: PerpsDispatchIntent): PerpsDispatchResult => ({ status: "CONFIRMED", txHash: hashOf(i.record.key), note: "did not land on HyperCore within 5 block(s): the reduce-only IOC of 110 did not fill" });
      r.fake.script.push(unfilled, unfilled, unfilled, unfilled);
      const t1 = await r.tick();
      assert.equal(t1.outcomes[0]!.fired, "derisk");
      const t2 = await r.tick();
      assert.equal(t2.outcomes[0]!.fired, "derisk", "re-armed and re-fired");
      assert.equal(r.store.getAccount(PERP_ACCOUNT_A.toLowerCase() as Address)!.rungRefires?.derisk, 1);
      const t3 = await r.tick();
      assert.equal(t3.outcomes[0]!.fired, "derisk");
      assert.equal(r.store.getAccount(PERP_ACCOUNT_A.toLowerCase() as Address)!.rungRefires?.derisk, 2);
      const t4 = await r.tick();
      assert.equal(t4.outcomes[0]!.fired, null, "at the cap the rung stays fired");
      assert.equal(r.fake.calls.filter((c) => c.intent.record.rung === "derisk").length, 3);
      const capped = r.escalations.find((e) => /re-fired 2 times without clearing/.test(e.reasons.join(";")));
      assert.ok(capped, "the owner is told once at the cap");
      await r.tick();
      assert.equal(r.escalations.filter((e) => /re-fired/.test(e.reasons.join(";"))).length, 1, "told once, not every tick");
      // the close rung: beyond the cap it keeps re-arming
      r.evm.scene(PERP_ACCOUNT_A, 40);
      r.fake.script.push(unfilled, unfilled, unfilled, unfilled);
      for (let k = 0; k < 4; k++) await r.tick();
      assert.ok(r.fake.calls.filter((c) => c.intent.record.rung === "emergency").length >= 4, "the last-resort rung never gives up");
    } finally {
      await r.close();
    }
  });

  it("no position left ends the episode and re-arms everything; a SENT record from a previous process is confirmed on the resume path", async () => {
    const r = await rig();
    try {
      const a = r.evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER);
      r.evm.scene(PERP_ACCOUNT_A, 10);
      await r.tick();
      assert.equal(r.store.getAccount(PERP_ACCOUNT_A.toLowerCase() as Address)!.episode, 1);
      // a record another process left SENT
      const key = r.fake.calls[0]!.intent.record.key;
      await r.store.mutate((s) => {
        const d = s.dispatches.find((x) => x.key === key)!;
        d.status = "SENT";
        d.txHash = hashOf("left-sent");
      });
      a.szi = 0n;
      const t = await r.tick();
      assert.equal(r.fake.confirms.length, 1);
      assert.equal(r.fake.confirms[0]!.key, key);
      assert.equal(r.store.getDispatch(key)!.status, "CONFIRMED");
      assert.equal(t.outcomes[0]!.valuation, "NO_POSITION");
      const rec = r.store.getAccount(PERP_ACCOUNT_A.toLowerCase() as Address)!;
      assert.equal(rec.episode, null);
      assert.deepEqual(rec.ladder.fired, []);
      assert.equal(rec.lastValuation, "NO_DEBT");
    } finally {
      await r.close();
    }
  });

  it("an account whose venue record is empty runs the floor's ladder and says so", async () => {
    const r = await rig();
    try {
      r.evm.addAccount(PERP_ACCOUNT_A, PERP_OWNER_A, KEEPER, { entry: null });
      await r.tick();
      const rec = r.store.getAccount(PERP_ACCOUNT_A.toLowerCase() as Address)!;
      assert.equal(rec.entryHf, null);
      assert.equal(rec.lastHf, HF0 / 10_000);
    } finally {
      await r.close();
    }
  });
});
