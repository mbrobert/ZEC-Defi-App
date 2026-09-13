import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseUnits } from "viem";
import { HF_LADDER, ladderFor } from "@zyo/shared";
import { accountCreatedEvent, strategyRouterAbi } from "../src/abi/oilskin.js";
import type { DispatchIntent, DispatchResult, Dispatcher } from "../src/dispatch/types.js";
import { Logger, memorySink } from "../src/log.js";
import { HealthMonitor, rotate, type MonitorConfig } from "../src/monitors/healthMonitor.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import { AccountDiscovery } from "../src/services/discovery.js";
import { RouterEntryHfReader } from "../src/services/entryHf.js";
import { KeeperStore, StoreTamperedError, type DispatchRecord } from "../src/store/keeperStore.js";
import type { Address } from "../src/types/evm.js";
import { ProgressWatchdog, type TickHandle } from "../src/watchdog.js";
import { ACCOUNT_A, ACCOUNT_B, FACTORY, OWNER_A, OWNER_B, USDC, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import type { MockChain } from "./mockChain.js";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "keeper-monitor-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
let n = 0;
const freshPath = () => join(dir, `m${++n}.json`);

/** Recording dispatcher whose behaviour is scripted per call. */
class FakeDispatcher implements Dispatcher {
  calls: { intent: DispatchIntent; storeOnDisk: unknown }[] = [];
  confirms: DispatchRecord[] = [];
  script: ((intent: DispatchIntent) => Promise<DispatchResult> | DispatchResult)[] = [];
  default: (intent: DispatchIntent) => DispatchResult = (i) =>
    i.record.action === "notify" ? { status: "NOTIFIED" } : { status: "CONFIRMED", txHash: ("0x" + "11".repeat(32)) as `0x${string}` };
  constructor(private readonly storePath: string) {}
  async dispatch(intent: DispatchIntent): Promise<DispatchResult> {
    // What the store looked like ON DISK at the moment of dispatch.
    const storeOnDisk = JSON.parse(await readFile(this.storePath, "utf8"));
    this.calls.push({ intent, storeOnDisk });
    const fn = this.script.shift();
    return fn ? fn(intent) : this.default(intent);
  }
  async confirm(record: DispatchRecord): Promise<DispatchResult> {
    this.confirms.push(record);
    return { status: "CONFIRMED", txHash: record.txHash! };
  }
}

const CONFIG: MonitorConfig = {
  concurrency: 2,
  priceMaxAgeS: 3 * 3600,
  oracleDeviationBps: 300,
  hfToleranceBps: 100,
  discoveryFromBlock: 0n,
  unknownEscalationStreak: 2,
  maxDispatchAttempts: 3,
  maxResumePerTick: 25,
  dispatchDeadlineMs: 5_000,
  maxRecordStalls: 3,
  maxRungRefires: 2,
  clockDriftMaxS: 120,
};

interface Rig {
  chain: MockChain;
  store: KeeperStore;
  dispatcher: FakeDispatcher;
  monitor: HealthMonitor;
  sink: ReturnType<typeof memorySink>;
  escalations: { account: Address; reasons: string[]; streak: number }[];
  fatals: Error[];
  events: { kind: string; account?: string; reasons?: string[] }[];
  tick: () => Promise<Awaited<ReturnType<HealthMonitor["tick"]>>>;
  watchdog: ProgressWatchdog;
  storePath: string;
  readsInFlight: { peak: number };
  /** What the mock router's `entryHfWad(account)` answers, per lower-cased account (absent = 0). */
  entryHfs: Map<string, number>;
  /** When set, the router read throws — the monitor keeps the last recorded value. */
  routerFault: { on: boolean };
}

/** The mock StrategyRouter: only `entryHfWad` (A4). Wad = the number at 18 decimals. */
const ROUTER = getAddress("0x2000000000000000000000000000000000000001") as Address;
function mockRouter(chain: MockChain, entryHfs: Map<string, number>, fault: { on: boolean }): void {
  chain.contracts.set(ROUTER.toLowerCase(), (data) => {
    if (fault.on) throw new Error("mock router: read fault");
    const { functionName, args } = decodeFunctionData({ abi: strategyRouterAbi, data });
    if (functionName !== "entryHfWad") throw new Error(`mock router: ${functionName} not mocked`);
    const [account] = args as [Address];
    const hf = entryHfs.get(account.toLowerCase()) ?? 0;
    return encodeFunctionResult({ abi: strategyRouterAbi, functionName, result: parseUnits(hf.toString(), 18) });
  });
}

async function rig(opts: { chain?: MockChain; storePath?: string; config?: Partial<MonitorConfig>; deadlineMs?: number; noRouter?: boolean } = {}): Promise<Rig> {
  const chain = opts.chain ?? newMockChain();
  const entryHfs = new Map<string, number>();
  const routerFault = { on: false };
  if (!opts.noRouter) mockRouter(chain, entryHfs, routerFault);
  const storePath = opts.storePath ?? freshPath();
  const store = new KeeperStore(storePath);
  await store.open();
  const sink = memorySink();
  const log = new Logger(sink.sink, "debug");
  const client = chain.publicClient();
  const readsInFlight = { peak: 0 };
  let inFlight = 0;
  const readerBase = new AaveReader(client, aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: opts.deadlineMs ?? 300 });
  const reader = Object.create(readerBase) as AaveReader;
  reader.readAccount = async (...args: Parameters<AaveReader["readAccount"]>) => {
    inFlight++;
    readsInFlight.peak = Math.max(readsInFlight.peak, inFlight);
    try {
      return await readerBase.readAccount(...args);
    } finally {
      inFlight--;
    }
  };
  const discovery = new AccountDiscovery(client, {
    factory: FACTORY,
    event: accountCreatedEvent,
    argNames: { owner: "owner", account: "account" },
    chunkBlocks: 1000,
    deadlineMs: 300,
  });
  const dispatcher = new FakeDispatcher(storePath);
  const escalations: Rig["escalations"] = [];
  const fatals: Error[] = [];
  const events: Rig["events"] = [];
  const watchdog = new ProgressWatchdog({ stallMs: 10_000, backoff: { initialMs: 10, maxMs: 100, factor: 2 } });
  const monitor = new HealthMonitor({
    reader,
    discovery,
    store,
    ladder: HF_LADDER,
    entryHf: opts.noRouter ? null : new RouterEntryHfReader(client, ROUTER, { deadlineMs: opts.deadlineMs ?? 300 }),
    dispatcher,
    log,
    config: { ...CONFIG, ...(opts.config ?? {}) },
    // The monitor's clock is the mock chain's clock (feed staleness is judged against it).
    now: () => new Date(Number(chain.nowS) * 1000),
    onEscalate: (e) => escalations.push(e),
    onFatal: (e) => fatals.push(e),
    notifier: {
      failures: 0,
      channels: ["test"],
      hasPersonChannel: true,
      deliver: async (e) => (events.push({ kind: e.kind, account: e.account, reasons: e.reasons }), { personReached: true }),
    },
  });
  const tick = () => monitor.tick(watchdog.beginTick());
  return { chain, store, dispatcher, monitor, sink, escalations, fatals, events, tick, watchdog, storePath, readsInFlight, entryHfs, routerFault };
}

const keyOf = (r: Rig, i: number) => r.dispatcher.calls[i].intent.record.key;

describe("health monitor — discovery and registry", () => {
  it("registers accounts from AccountCreated logs, persists the cursor, and never re-registers", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 10n);
    r.chain.emitAccountCreated(OWNER_B, ACCOUNT_B, 20n);
    const rep = await r.tick();
    assert.equal(rep.discovered, 2);
    assert.equal(r.store.cursor, 1000n);
    assert.equal(r.store.listAccounts().length, 2);
    // Next tick: cursor + 1 > head → nothing scanned; a re-emitted log below the cursor is ignored.
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 10n);
    const rep2 = await r.tick();
    assert.equal(rep2.discovered, 0);
    assert.equal(r.store.listAccounts().length, 2);
    // New block, new account.
    r.chain.blockNumber = 1500n;
    r.chain.emitAccountCreated(OWNER_B, "0xacc0000000000000000000000000000000000003", 1200n);
    const rep3 = await r.tick();
    assert.equal(rep3.discovered, 1);
    assert.equal(r.store.cursor, 1500n);
    await r.store.close();
  });

  it("the persisted registry is the source of truth across a restart (accounts survive without logs)", async () => {
    const p = freshPath();
    const r1 = await rig({ storePath: p });
    r1.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 10n);
    await r1.tick();
    await r1.store.close();
    const chain2 = newMockChain(); // no logs at all
    const r2 = await rig({ storePath: p, chain: chain2 });
    const rep = await r2.tick();
    assert.equal(rep.evaluated, 1);
    assert.equal(rep.outcomes[0].account, ACCOUNT_A.toLowerCase());
    await r2.store.close();
  });

  it("rotates the evaluation order by block number so no account is always last", () => {
    const items = ["a", "b", "c", "d"];
    assert.deepEqual(rotate(items, 0n), ["a", "b", "c", "d"]);
    assert.deepEqual(rotate(items, 1n), ["b", "c", "d", "a"]);
    assert.deepEqual(rotate(items, 6n), ["c", "d", "a", "b"]);
    assert.deepEqual(rotate([], 5n), []);
  });
});

describe("health monitor — ladder, hysteresis, re-arm, episodes", () => {
  it("NO_DEBT and healthy accounts fire nothing; a warn crossing notifies once with a persisted key", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    r.chain.emitAccountCreated(OWNER_B, ACCOUNT_B, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(2.0));
    let rep = await r.tick();
    assert.deepEqual(rep.outcomes.map((o) => [o.valuation, o.fired]).sort(), [["NO_DEBT", null], ["OK", null]]);
    assert.equal(r.dispatcher.calls.length, 0);

    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.22));
    rep = await r.tick();
    const a = rep.outcomes.find((o) => o.account === ACCOUNT_A.toLowerCase())!;
    assert.equal(a.fired, "warn");
    assert.deepEqual(a.dispatch, { status: "NOTIFIED" });
    assert.equal(r.dispatcher.calls.length, 1);
    const rec = r.dispatcher.calls[0].intent.record;
    assert.equal(rec.key, `${ACCOUNT_A.toLowerCase()}:1:1:notify`);
    // The record was ON DISK (PENDING) before the dispatcher was invoked.
    const disk = r.dispatcher.calls[0].storeOnDisk as { dispatches: DispatchRecord[]; counters: { episode: number } };
    assert.equal(disk.dispatches[0].key, rec.key);
    assert.equal(disk.dispatches[0].status, "PENDING");
    assert.equal(disk.counters.episode, 1);
    assert.equal(r.store.getDispatch(rec.key)?.status, "NOTIFIED");
    assert.equal(r.store.getAccount(ACCOUNT_A)?.episode, 1);

    // Sitting at 1.22 / bouncing to 1.24 (under the warn disarm 1.25): nothing more fires (hysteresis).
    for (const hf of [1.22, 1.24, 1.22, 1.24, 1.235]) {
      cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(hf));
      await r.tick();
    }
    assert.equal(r.dispatcher.calls.length, 1);
    await r.store.close();
  });

  it("re-arm after a top-up: recovery above disarm ends the episode; the next drop is a NEW episode with a NEW key", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15)); // warn + repay in one step → repay fires
    await r.tick();
    assert.equal(keyOf(r, 0), `${ACCOUNT_A.toLowerCase()}:1:1:repay`);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.7)); // top-up
    let rep = await r.tick();
    assert.equal(r.store.getAccount(ACCOUNT_A)?.episode, null);
    assert.deepEqual(r.store.getAccount(ACCOUNT_A)?.ladder.fired, []);
    assert.equal(rep.outcomes[0].fired, null);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.08)); // fresh drop: derisk
    rep = await r.tick();
    assert.equal(rep.outcomes[0].fired, "derisk");
    assert.equal(keyOf(r, 1), `${ACCOUNT_A.toLowerCase()}:2:2:derisk`);
    assert.equal(r.store.counters.episode, 2);
    await r.store.close();
  });

  it("a new rung firing within the same episode gets a NEW key (seq advances, episode stays)", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.2));
    await r.tick(); // warn
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15));
    await r.tick(); // repay
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.0));
    await r.tick(); // emergency (derisk crossed too, subsumed)
    assert.deepEqual(
      r.dispatcher.calls.map((c) => c.intent.record.key),
      [`${ACCOUNT_A.toLowerCase()}:1:1:notify`, `${ACCOUNT_A.toLowerCase()}:1:2:repay`, `${ACCOUNT_A.toLowerCase()}:1:3:emergency-unwind`]
    );
    assert.deepEqual([...r.store.getAccount(ACCOUNT_A)!.ladder.fired].sort(), ["derisk", "emergency", "repay", "warn"]);
    // Partial recovery re-arms derisk + emergency only; falling again re-fires derisk with yet another key.
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.13));
    await r.tick();
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.08));
    await r.tick();
    // FIX C-10: `repay` CONFIRMED but HF never cleared its trigger, so it is
    // re-armed once and fires again (bounded by maxRungRefires) instead of
    // latching for the whole band between repay and derisk while the position rots.
    assert.equal(keyOf(r, 3), `${ACCOUNT_A.toLowerCase()}:1:4:repay`);
    assert.equal(r.store.getAccount(ACCOUNT_A)?.rungRefires?.repay, 2);
    assert.equal(keyOf(r, 4), `${ACCOUNT_A.toLowerCase()}:1:5:derisk`);
    await r.store.close();
  });

  it("no debt after an episode (full repay) re-arms everything and ends the episode", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.0));
    await r.tick();
    r.chain.setPosition(ACCOUNT_A, { collateral: [{ asset: r.chain.reserves.values().next().value!.asset, amount: 1n }], debt: [] });
    const rep = await r.tick();
    assert.equal(rep.outcomes[0].valuation, "NO_DEBT");
    assert.equal(r.store.getAccount(ACCOUNT_A)?.episode, null);
    assert.deepEqual(r.store.getAccount(ACCOUNT_A)?.ladder.fired, []);
    await r.store.close();
  });
});

describe("health monitor — the ladder is the account's, derived from its recorded entry HF (A4, BUILD-PLAN D7)", () => {
  it("opened at HF 1.30 the rungs are 1.27 / 1.19 / 1.11 / 1.05: 1.28 fires nothing, 1.26 warns with the account's disarm on the record, 1.18 repays; a record-less account runs the floor's ladder", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    r.chain.emitAccountCreated(OWNER_B, ACCOUNT_B, 1n);
    r.entryHfs.set(ACCOUNT_A.toLowerCase(), 1.3);
    const ladder = ladderFor(1.3);
    assert.deepEqual(ladder.map((x) => x.hf), [1.27, 1.19, 1.11, 1.05]);
    assert.deepEqual(ladder.map((x) => x.disarmHf), [1.3, 1.22, 1.14, 1.08]);

    // 1.28 sits above this account's warn rung (1.27) — and above the floor's (1.23): nothing fires on either ladder.
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.28));
    cbBtcPosition(r.chain, ACCOUNT_B, debtForHf(1.22));
    let rep = await r.tick();
    const a = () => rep.outcomes.find((o) => o.account === ACCOUNT_A.toLowerCase())!;
    const b = () => rep.outcomes.find((o) => o.account === ACCOUNT_B.toLowerCase())!;
    assert.equal(a().fired, null, "1.28 sits above the 1.27 warn rung of the 1.30 ladder");
    assert.equal(b().fired, "warn", "the record-less account runs the floor's ladder: 1.22 < 1.23");
    assert.equal(r.store.getAccount(ACCOUNT_A)?.entryHf, 1.3);
    assert.equal(r.store.getAccount(ACCOUNT_B)?.entryHf, null, "null = no record, the floor's ladder, said");
    const warnB = r.dispatcher.calls[0].intent.record;
    assert.equal(warnB.account, ACCOUNT_B.toLowerCase());
    assert.equal(warnB.disarmHf, HF_LADDER[0].disarmHf, "the floor's warn disarm (1.25) travels on the record");

    // 1.26 is under THIS account's warn rung (1.27) but above the floor's (1.23): the account's ladder decides.
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.26));
    rep = await r.tick();
    assert.equal(a().fired, "warn");
    const warnA = r.dispatcher.calls[1].intent.record;
    assert.equal(warnA.account, ACCOUNT_A.toLowerCase());
    assert.equal(warnA.rung, "warn");
    assert.equal(warnA.disarmHf, 1.3, "the 1.30 ladder's warn disarm, not the floor's 1.25");
    assert.ok(Math.abs(warnA.hf - 1.26) < 1e-6, `hf at fire ${warnA.hf}`);

    // 1.18 is under the account's repay rung (1.19); the floor's ladder (repay 1.16) would only have warned.
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.18));
    rep = await r.tick();
    assert.equal(a().fired, "repay");
    assert.equal(r.dispatcher.calls[2].intent.record.disarmHf, 1.22);

    // Bouncing between the repay trigger (1.19) and its disarm (1.22) fires nothing more — the ACCOUNT's
    // hysteresis. (Dipping under 1.19 again would re-fire the confirmed-but-ineffective repay once, C-MED-2.)
    for (const hf of [1.21, 1.195, 1.215]) {
      cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(hf));
      await r.tick();
    }
    assert.equal(r.dispatcher.calls.length, 3);
    // 1.23 re-arms repay (≥ 1.22) but not warn (< 1.30); the episode continues.
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.23));
    await r.tick();
    assert.deepEqual(r.store.getAccount(ACCOUNT_A)?.ladder.fired, ["warn"]);
    // Still the episode A's warn opened (episode numbers are store-wide: B's warn took 1, so A's is 2).
    assert.equal(r.store.getAccount(ACCOUNT_A)?.episode, warnA.episode);
    assert.equal(warnA.episode, 2);

    // The record and the account's entry HF survive a reopen (the store validates both on load).
    await r.store.close();
    const again = new KeeperStore(r.storePath);
    await again.open();
    assert.equal(again.getAccount(ACCOUNT_A)?.entryHf, 1.3);
    assert.equal(again.getDispatch(warnA.key)?.disarmHf, 1.3);
    await again.close();
  });

  it("a failed router read keeps the last recorded entry HF; the router reading 0 afterwards returns the account to the floor's ladder", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    r.entryHfs.set(ACCOUNT_A.toLowerCase(), 1.3);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.28));
    await r.tick();
    assert.equal(r.store.getAccount(ACCOUNT_A)?.entryHf, 1.3);

    r.routerFault.on = true;
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.26));
    let rep = await r.tick();
    assert.equal(rep.outcomes[0].fired, "warn", "the kept 1.30 ladder: 1.26 < 1.27");
    assert.equal(r.dispatcher.calls[0].intent.record.disarmHf, 1.3);
    assert.equal(r.store.getAccount(ACCOUNT_A)?.entryHf, 1.3, "kept, not dropped");
    assert.ok(r.sink.lines.some((x) => x.includes("entry HF read failed")), "said at warn");

    // The router now answers 0 (say, a redeploy without the record): the floor's ladder runs and the store says so.
    // At 1.26 the floor's ladder fires nothing (its warn is 1.23), so drop to 1.15: under the floor's repay rung (1.16).
    r.routerFault.on = false;
    r.entryHfs.delete(ACCOUNT_A.toLowerCase());
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15));
    rep = await r.tick();
    assert.equal(rep.outcomes[0].fired, "repay", "at 1.15 the floor's repay rung (1.16) is crossed; warn was already fired");
    assert.equal(r.dispatcher.calls[1].intent.record.disarmHf, HF_LADDER[1].disarmHf, "the floor's repay disarm (1.18), not the 1.30 ladder's 1.22");
    assert.equal(r.store.getAccount(ACCOUNT_A)?.entryHf, null);
    assert.ok(r.sink.lines.some((x) => x.includes("entry HF record gone")));
    await r.store.close();
  });

  it("a recorded entry HF under 1.10 (a floor set in the rungs-collapse band) runs the floor's ladder and says so at error; no router at all means the floor's ladder for everyone", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    r.entryHfs.set(ACCOUNT_A.toLowerCase(), 1.08);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.2));
    const rep = await r.tick();
    assert.equal(rep.outcomes[0].fired, "warn", "the floor's ladder: 1.2 < 1.23");
    assert.equal(r.store.getAccount(ACCOUNT_A)?.entryHf, 1.08, "what the router said is recorded as read");
    assert.ok(r.sink.lines.some((x) => x.includes("raise the registry floor")));
    await r.store.close();

    const bare = await rig({ noRouter: true });
    bare.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(bare.chain, ACCOUNT_A, debtForHf(1.2));
    const rep2 = await bare.tick();
    assert.equal(rep2.outcomes[0].fired, "warn");
    assert.equal(bare.store.getAccount(ACCOUNT_A)?.entryHf, null);
    assert.equal(bare.chain.calls.filter((c) => c.label.startsWith("custom(")).length, 0, "no router read was attempted");
    await bare.store.close();
  });
});

describe("health monitor — idempotency across crash-restart", () => {
  it("crash after the PENDING record is persisted but before the action completes ⇒ restart resumes with the SAME key", async () => {
    const p = freshPath();
    const r1 = await rig({ storePath: p });
    r1.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r1.chain, ACCOUNT_A, debtForHf(1.15));
    // Simulate the process dying inside dispatch: never returns a result.
    r1.dispatcher.script.push(() => {
      throw Object.assign(new Error("process killed"), { crash: true });
    });
    await r1.tick();
    const key1 = keyOf(r1, 0);
    // The store shows the action as FAILED with attempts=1 (our best-effort bookkeeping ran);
    // a true crash would leave it PENDING. Force PENDING to model the harder case.
    await r1.store.updateDispatch(key1, { status: "PENDING", attempts: 0 }, new Date());
    await r1.store.close();

    // Restart on the same store, same chain state.
    const r2 = await rig({ storePath: p, chain: r1.chain });
    const rep = await r2.tick();
    assert.equal(rep.resumed, 1);
    assert.equal(r2.dispatcher.calls.length, 1, "exactly one resume dispatch");
    assert.equal(keyOf(r2, 0), key1, "the persisted key is reused, not re-minted");
    assert.equal(r2.dispatcher.calls[0].intent.valuation, null, "resume carries no fresh valuation");
    assert.equal(r2.store.getDispatch(key1)?.status, "CONFIRMED");
    // And evaluation in the same tick did NOT mint a second dispatch for the same rung.
    assert.equal(r2.store.listDispatches().length, 1);
    assert.equal(r2.store.counters.dispatchSeq, 1);
    await r2.store.close();
  });

  it("crash after SENT (txHash persisted) ⇒ restart confirms the same tx, sends nothing", async () => {
    const p = freshPath();
    const r1 = await rig({ storePath: p });
    r1.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r1.chain, ACCOUNT_A, debtForHf(1.15));
    const tx = ("0x" + "77".repeat(32)) as `0x${string}`;
    r1.dispatcher.script.push(() => ({ status: "SENT", txHash: tx }));
    await r1.tick();
    await r1.store.close();
    const r2 = await rig({ storePath: p, chain: r1.chain });
    await r2.tick();
    assert.equal(r2.dispatcher.calls.length, 0);
    assert.equal(r2.dispatcher.confirms.length, 1);
    assert.equal(r2.dispatcher.confirms[0].txHash, tx);
    assert.equal(r2.store.getDispatch(r2.dispatcher.confirms[0].key)?.status, "CONFIRMED");
    await r2.store.close();
  });

  it("the other direction: two rung firings are never collapsed onto one key, even after a restart between them", async () => {
    const p = freshPath();
    const r1 = await rig({ storePath: p });
    r1.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r1.chain, ACCOUNT_A, debtForHf(1.15));
    await r1.tick();
    await r1.store.close();
    const r2 = await rig({ storePath: p, chain: r1.chain });
    cbBtcPosition(r2.chain, ACCOUNT_A, debtForHf(1.08));
    await r2.tick();
    const keys = r2.store.listDispatches().map((d) => d.key);
    assert.equal(new Set(keys).size, 2);
    assert.deepEqual(keys, [`${ACCOUNT_A.toLowerCase()}:1:1:repay`, `${ACCOUNT_A.toLowerCase()}:1:2:derisk`]);
    await r2.store.close();
  });

  it("FAILED dispatch is retried with the same key while the episode is open, then ABANDONED and escalated", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15));
    r.dispatcher.default = () => ({ status: "FAILED", error: "rpc down" });
    await r.tick(); // attempt 1 (fresh)
    await r.tick(); // attempt 2 (resume)
    await r.tick(); // attempt 3 (resume)
    const key = keyOf(r, 0);
    assert.deepEqual(r.dispatcher.calls.map((c) => c.intent.record.key), [key, key, key]);
    assert.equal(r.store.getDispatch(key)?.attempts, 3);
    await r.tick(); // attempts == max → ABANDONED, no dispatch
    assert.equal(r.dispatcher.calls.length, 3);
    assert.equal(r.store.getDispatch(key)?.status, "ABANDONED");
    assert.ok(r.escalations.some((e) => e.reasons[0].includes("abandoned")));
    await r.store.close();
  });

  it("a FAILED record whose episode has ended is SUPERSEDED, not replayed", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15));
    r.dispatcher.script.push(() => ({ status: "FAILED", error: "once" }));
    await r.tick();
    const key = keyOf(r, 0);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.9)); // recovered
    await r.tick(); // resume sees FAILED with open episode → retries (CONFIRMED by default)…
    // Note: retry happens before evaluation in the same tick, so it IS retried once here.
    assert.equal(r.dispatcher.calls.length, 2);
    // Now a fresh FAILED after the episode closed:
    await r.store.updateDispatch(key, { status: "FAILED", attempts: 1 }, new Date());
    await r.tick();
    assert.equal(r.dispatcher.calls.length, 2);
    assert.equal(r.store.getDispatch(key)?.status, "SUPERSEDED");
    await r.store.close();
  });

  it("a more severe rung supersedes an unfinished milder dispatch for the same account", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15));
    r.dispatcher.script.push(() => ({ status: "REFUSED", reason: "no grant yet" }));
    await r.tick();
    const k1 = keyOf(r, 0);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.0));
    r.dispatcher.script.push(() => ({ status: "REFUSED", reason: "still no grant" })); // the resume of k1
    await r.tick();
    assert.equal(r.store.getDispatch(k1)?.status, "SUPERSEDED");
    const k2 = r.store.listDispatches().find((d) => d.action === "emergency-unwind")!;
    assert.equal(k2.status, "CONFIRMED");
    await r.store.close();
  });
});

describe("health monitor — isolation, concurrency, fail-closed, escalation", () => {
  it("one hanging account is UNKNOWN; the others are still evaluated in the same tick", async () => {
    const r = await rig({ deadlineMs: 80 });
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    r.chain.emitAccountCreated(OWNER_B, ACCOUNT_B, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15));
    cbBtcPosition(r.chain, ACCOUNT_B, debtForHf(1.15));
    r.chain.faults.set(`getUserAccountData(${ACCOUNT_A.toLowerCase()})`, { kind: "hang" });
    const rep = await r.tick();
    const a = rep.outcomes.find((o) => o.account === ACCOUNT_A.toLowerCase())!;
    const b = rep.outcomes.find((o) => o.account === ACCOUNT_B.toLowerCase())!;
    assert.equal(a.valuation, "UNKNOWN");
    assert.equal(a.fired, null);
    assert.equal(b.valuation, "OK");
    assert.equal(b.fired, "repay");
    assert.equal(r.store.getAccount(ACCOUNT_A)?.unknownStreak, 1);
    await r.store.close();
  });

  it("UNKNOWN never runs the ladder, and a streak escalates to a human", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.0)); // would be emergency if readable
    r.chain.reserves.get(USDC.toLowerCase())!.aavePrice = 0n; // the audited poison
    await r.tick();
    assert.equal(r.escalations.length, 0);
    await r.tick();
    assert.equal(r.escalations.length, 1);
    assert.equal(r.escalations[0].streak, 2);
    assert.equal(r.dispatcher.calls.length, 0);
    assert.equal(r.store.listDispatches().length, 0);
    // Streak resets once readable again, and the ladder then acts.
    r.chain.reserves.get(USDC.toLowerCase())!.aavePrice = 100_000_000n;
    const rep = await r.tick();
    assert.equal(rep.outcomes[0].fired, "emergency");
    assert.equal(r.store.getAccount(ACCOUNT_A)?.unknownStreak, 0);
    await r.store.close();
  });

  it("bounded concurrency: never more than `concurrency` accounts read at once", async () => {
    const r = await rig({ config: { concurrency: 2 } });
    for (let i = 1; i <= 7; i++) {
      const acc = `0xacc000000000000000000000000000000000000${i}` as Address;
      r.chain.emitAccountCreated(OWNER_A, acc, 1n);
      cbBtcPosition(r.chain, acc, debtForHf(2));
      r.chain.faults.set(`getUserAccountData(${acc})`, { kind: "delay", ms: 10 });
    }
    const rep = await r.tick();
    assert.equal(rep.evaluated, 7);
    assert.equal(r.readsInFlight.peak, 2);
    await r.store.close();
  });

  it("if the idempotency record cannot be written, the keeper refuses to act and escalates (no un-keyed dispatch)", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(2.0));
    await r.tick(); // registered, healthy
    // Tamper with the store behind the keeper's back → every write is refused.
    const doc = JSON.parse(await readFile(r.storePath, "utf8"));
    doc.counters.episode = 41;
    await writeFile(r.storePath, JSON.stringify(doc));
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15)); // repay rung
    await r.tick();
    assert.equal(r.dispatcher.calls.length, 0, "nothing is dispatched without a store that can key it");
    // FIX C-6: an untrusted store is now FATAL — the keeper stops so a
    // supervisor restarts it into a clean re-read, instead of staying up,
    // heartbeating, and being unable to fire a single rung ever again.
    assert.ok(r.store.fatal instanceof StoreTamperedError);
    assert.ok(r.fatals.some((e) => e.name === "StoreTamperedError"));
    assert.ok(r.sink.lines.some((l) => l.includes("STORE UNUSABLE")));
    await r.store.close();
  });

  it("a non-fatal write failure before dispatch still refuses to act and escalates (no un-keyed dispatch)", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(2.0));
    await r.tick(); // registered, healthy
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15)); // repay rung
    const realMutate = r.store.mutate.bind(r.store);
    // Fail the SECOND write of the next tick: the first is the tick counter,
    // the second is the pre-dispatch idempotency record.
    let calls = 0;
    (r.store as unknown as { mutate: typeof realMutate }).mutate = ((fn) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error("disk hiccup"));
      return realMutate(fn);
    }) as typeof realMutate;
    const rep = await r.tick();
    assert.equal(r.dispatcher.calls.length, 0);
    assert.ok(r.escalations.some((e) => e.reasons[0].includes("store write failed before dispatch")));
    assert.ok(r.sink.lines.some((l) => l.includes("STORE WRITE FAILED BEFORE DISPATCH")));
    assert.ok(r.events.some((e) => e.kind === "store-failure"), "a store failure must reach the notifier");
    assert.ok(rep.outcomes.some((o) => o.error?.includes("disk hiccup")));
    await r.store.close();
  });

  it("a watchdog abort mid-tick ends the tick cleanly (reported, not thrown) and later ticks proceed", async () => {
    const r = await rig({ deadlineMs: 5_000 });
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    r.chain.emitAccountCreated(OWNER_B, ACCOUNT_B, 1n);
    r.chain.faults.set(`getUserAccountData(${ACCOUNT_A.toLowerCase()})`, { kind: "hang" });
    r.chain.faults.set(`getUserAccountData(${ACCOUNT_B.toLowerCase()})`, { kind: "hang" });
    const handle = r.watchdog.beginTick();
    const p = r.monitor.tick(handle);
    setTimeout(() => handle.signal.dispatchEvent(new Event("abort")), 30);
    // Use the real abort path via the watchdog's controller:
    const ctrl = (r.watchdog as unknown as { controller: AbortController }).controller;
    setTimeout(() => ctrl.abort(new Error("watchdog: no progress")), 30);
    const rep = await p;
    assert.equal(rep.aborted, true);
    assert.ok(rep.outcomes.every((o) => o.valuation === "READ_FAILED" || o.valuation === "UNKNOWN"));
    r.chain.faults.clear();
    const rep2 = await r.tick();
    assert.equal(rep2.aborted, false);
    assert.equal(rep2.evaluated, 2);
    await r.store.close();
  });

  it("logs never contain a 32-byte secret-shaped value outside allow-listed hash fields", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15));
    await r.tick();
    const key = "0x" + "ab".repeat(32);
    r.sink.records.length = 0;
    (r.monitor as unknown as { d: { log: Logger } }).d.log.info("leak attempt", { note: `key ${key}`, privateKey: key, txHash: key });
    const line = r.sink.lines[r.sink.lines.length - 1];
    assert.equal(line.split(key).length - 1, 1, "only the txHash field may carry it");
    assert.match(line, /"note":"key 0x\[redacted\]"/);
    assert.match(line, /"privateKey":"\[redacted\]"/);
    await r.store.close();
  });
});

// Keep the type import used (TickHandle appears in signatures above).
export type _T = TickHandle;

// ---------------------------------------------------------------------------------------------
// Slice F (2026-09-11): the CONFIRMED-with-shortfall path carried end to end through the monitor.
// ---------------------------------------------------------------------------------------------
describe("health monitor — a CONFIRMED repay with a shortfall note", () => {
  it("tells the owner ONCE (one `shortfall` event), re-arms the rung, and records the re-armed retry's SUPERSEDED as bookkeeping — no second notice, no third dispatch", async () => {
    const r = await rig();
    r.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(r.chain, ACCOUNT_A, debtForHf(1.15)); // warn + repay crossed in one step → repay fires
    const tx = ("0x" + "22".repeat(32)) as `0x${string}`;
    const note = "USDC ran out on the worse book (0xaave 20000); 0xmorpho (1000 USDC still owed) was owed at dispatch and is left for the retry — an honest shortfall, not a wrong book";
    r.dispatcher.script.push(async () => ({ status: "CONFIRMED", txHash: tx, note }));
    await r.tick();
    const k1 = keyOf(r, 0);
    assert.equal(k1, `${ACCOUNT_A.toLowerCase()}:1:1:repay`);
    assert.equal(r.store.getDispatch(k1)?.status, "CONFIRMED");
    const shortfalls = r.events.filter((e) => e.kind === "shortfall");
    assert.equal(shortfalls.length, 1, "the owner is told once");
    assert.equal(shortfalls[0].account, ACCOUNT_A.toLowerCase());
    assert.match(shortfalls[0].reasons?.[0] ?? "", /honest shortfall/);
    for (const e of r.events.filter((e) => e.kind === "dispatch")) {
      assert.ok(!(e.reasons ?? []).some((x) => /shortfall/i.test(x)), "the record-level dispatch event does not repeat the note");
    }

    // The mock chain did not move (HF still 1.15, under the repay rung): the rung whose action
    // CONFIRMED without clearing it is re-armed once and fires again with a NEW key; the retry's
    // world check (scripted here as the dispatcher would answer once the paid book cleared the
    // disarm) SUPERSEDES it.
    r.dispatcher.script.push(async () => ({ status: "SUPERSEDED", reason: "HF 1.6000 ≥ repay disarm 1.18" }));
    await r.tick();
    assert.equal(r.dispatcher.calls.length, 2);
    const k2 = keyOf(r, 1);
    assert.equal(k2, `${ACCOUNT_A.toLowerCase()}:1:2:repay`);
    assert.equal(r.store.getDispatch(k2)?.status, "SUPERSEDED");
    assert.equal(r.store.getAccount(ACCOUNT_A)?.rungRefires?.repay, 1);
    assert.equal(r.events.filter((e) => e.kind === "shortfall").length, 1, "still told once");
    assert.ok(r.events.some((e) => e.kind === "dispatch" && e.reasons?.some((x) => /≥ repay disarm/.test(x))), "the SUPERSEDED reason is recorded");

    // A SUPERSEDED record is not re-armed again: the next tick sends nothing new.
    await r.tick();
    assert.equal(r.dispatcher.calls.length, 2);
    await r.store.close();
  });
});
