import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress } from "viem";
import { HF_LADDER } from "@zyo/shared";
import { accountCreatedEvent } from "../src/abi/oilskin.js";
import type { DispatchIntent, DispatchResult, Dispatcher } from "../src/dispatch/types.js";
import { evaluateSnapshot } from "../src/engine/valuation.js";
import { Logger, memorySink } from "../src/log.js";
import { HealthMonitor, rotate, type MonitorConfig } from "../src/monitors/healthMonitor.js";
import type { KeeperEvent } from "../src/notify/notifier.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import { AccountDiscovery } from "../src/services/discovery.js";
import { KeeperStore } from "../src/store/keeperStore.js";
import type { Address } from "../src/types/evm.js";
import { ProgressWatchdog } from "../src/watchdog.js";
import { CBBTC, FACTORY, USDC, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import type { MockChain } from "./mockChain.js";

/**
 * HARVESTED FROM /tmp/audit2/C/poc5-watchdog-rotation.test.js and
 * poc8-availability.test.js — expectations FLIPPED.
 *
 * The PoCs recorded, with 15 accounts ALL at HF 1.02 and one whose dispatch
 * never returns:
 *
 *     accounts the dispatcher was called for, per tick: [[0,1,…,14],[0],[0],[0]]
 *     => ticks 2..n resume the stuck record FIRST and never get past it: the
 *        other 14 accounts sit at HF 1.02 and are never looked at again.
 *
 * and, for the last rung:
 *
 *     emergency record: ABANDONED attempts 5
 *     after HF falls to 0.99, three more ticks: ["-/-","-/-","-/-"]
 *     ladder still latched: ["derisk","emergency","repay","warn"]
 *
 * and, for an account holding an Aave reserve the keeper does not track:
 *
 *     verdict: UNKNOWN ["G3 Σ reserve collateral … ≠ pool totalCollateralBase …"]
 *     (log-only escalation after 3 ticks; the user is never told)
 */

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fixC3-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

let seq = 0;
const freshPath = () => join(dir, `s${seq++}.json`);
const acct = (i: number) => getAddress(`0xacc${i.toString(16).padStart(37, "0")}`) as Address;

const CONFIG: MonitorConfig = {
  concurrency: 4,
  priceMaxAgeS: 3 * 3600,
  oracleDeviationBps: 300,
  hfToleranceBps: 100,
  discoveryFromBlock: 0n,
  unknownEscalationStreak: 3,
  maxDispatchAttempts: 3,
  maxResumePerTick: 25,
  dispatchDeadlineMs: 60,
  maxRecordStalls: 2,
  maxRungRefires: 0,
  clockDriftMaxS: 120,
};

class ScriptedDispatcher implements Dispatcher {
  seen: string[] = [];
  constructor(private readonly fn: (intent: DispatchIntent) => Promise<DispatchResult>) {}
  async dispatch(intent: DispatchIntent): Promise<DispatchResult> {
    this.seen.push(intent.record.account);
    return this.fn(intent);
  }
  async confirm(): Promise<DispatchResult> {
    return { status: "CONFIRMED", txHash: ("0x" + "11".repeat(32)) as `0x${string}` };
  }
}

async function rig(opts: { chain?: MockChain; dispatcher: Dispatcher; config?: Partial<MonitorConfig>; hostClockSkewS?: number }) {
  const chain = opts.chain ?? newMockChain();
  const storePath = freshPath();
  const store = new KeeperStore(storePath);
  await store.open();
  const sink = memorySink();
  const log = new Logger(sink.sink, "debug");
  const client = chain.publicClient();
  const reader = new AaveReader(client, aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 500 });
  const discovery = new AccountDiscovery(client, {
    factory: FACTORY,
    event: accountCreatedEvent,
    argNames: { owner: "owner", account: "account" },
    chunkBlocks: 1000,
    deadlineMs: 500,
  });
  const escalations: { account: Address; reasons: string[] }[] = [];
  const events: KeeperEvent[] = [];
  const watchdog = new ProgressWatchdog({ stallMs: 10_000, backoff: { initialMs: 10, maxMs: 100, factor: 2 } });
  const monitor = new HealthMonitor({
    reader,
    discovery,
    store,
    ladder: HF_LADDER,
    dispatcher: opts.dispatcher,
    log,
    config: { ...CONFIG, ...(opts.config ?? {}) },
    // The HOST clock, deliberately skewable; the keeper must judge feeds by CHAIN time.
    now: () => new Date((Number(chain.nowS) + (opts.hostClockSkewS ?? 0)) * 1000),
    onEscalate: (e) => escalations.push(e),
    notifier: { failures: 0, channels: ["test"], hasPersonChannel: true, deliver: async (e) => (events.push(e), { personReached: true }) },
  });
  return { chain, store, sink, escalations, events, monitor, tick: () => monitor.tick(watchdog.beginTick()) };
}

describe("FIX C-3: one hung dispatch cannot starve the fleet", () => {
  it("FIX C-3: 15 accounts at HF 1.02, one wedged — every other account is still evaluated on every tick", async () => {
    const chain = newMockChain();
    const wedged = acct(0);
    for (let i = 0; i < 15; i++) {
      chain.emitAccountCreated(acct(100 + i), acct(i), 1n);
      cbBtcPosition(chain, acct(i), debtForHf(1.02));
    }
    const dispatcher = new ScriptedDispatcher(async (intent) =>
      intent.record.account === wedged.toLowerCase()
        ? new Promise<DispatchResult>(() => undefined) // never returns, ignores every signal
        : { status: "CONFIRMED", txHash: ("0x" + "22".repeat(32)) as `0x${string}` }
    );
    const r = await rig({ chain, dispatcher });

    const evaluatedPerTick: number[] = [];
    for (let t = 0; t < 4; t++) {
      const rep = await r.tick();
      evaluatedPerTick.push(rep.evaluated);
    }
    // Was: [15, 1, 1, 1] worth of dispatcher calls — ticks 2+ never got past
    // the wedged record. Now every tick evaluates the whole fleet.
    assert.deepEqual(evaluatedPerTick, [15, 15, 15, 15], `evaluated per tick: ${JSON.stringify(evaluatedPerTick)}`);

    // The wedged record is quarantined and escalated, not retried at the head of every tick.
    const wedgedRecords = r.store.listDispatches({ account: wedged });
    const quarantined = wedgedRecords.find((d) => (d.error ?? "").includes("quarantined"));
    assert.ok(quarantined, `expected a quarantined record, got ${JSON.stringify(wedgedRecords.map((d) => [d.status, d.stalls, d.error]))}`);
    assert.equal(quarantined!.status, "ABANDONED");
    assert.ok((quarantined!.stalls ?? 0) >= 2);
    assert.ok(r.sink.lines.some((l) => l.includes("exceeded its deadline")));
    assert.ok(r.events.some((e) => e.reasons?.some((x) => x.includes("quarantined"))), "a quarantine must reach the notifier");

    // The other 14 accounts were protected in the meantime.
    for (let i = 1; i < 15; i++) {
      const ds = r.store.listDispatches({ account: acct(i) });
      assert.ok(ds.length > 0 && ds.some((d) => d.status === "CONFIRMED"), `account ${i} was never acted on`);
    }
    await r.store.close();
  });

  it("FIX C-8: the last-resort rung is never abandoned for retry exhaustion, and escalates on the FIRST failure", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(acct(200), acct(1), 1n);
    cbBtcPosition(chain, acct(1), debtForHf(1.02)); // emergency
    const dispatcher = new ScriptedDispatcher(async () => ({ status: "FAILED", error: "every broadcast reverts" }));
    const r = await rig({ chain, dispatcher });

    for (let t = 0; t < 6; t++) await r.tick();
    const recs = r.store.listDispatches({ account: acct(1) });
    const emergency = recs.find((d) => d.rung === "emergency")!;
    // Was: ABANDONED after 5 attempts, then permanently idle at HF 0.99.
    assert.notEqual(emergency.status, "ABANDONED", "the protection of last resort must not give up");
    assert.ok(emergency.attempts > CONFIG.maxDispatchAttempts, `attempts ${emergency.attempts} must exceed the cap and keep going`);
    assert.ok(
      r.escalations.some((e) => e.reasons.some((x) => x.includes("emergency dispatch") && x.includes("failed"))),
      "the first emergency failure must escalate"
    );
    assert.ok(r.sink.lines.some((l) => l.includes("LAST-RESORT rung still failing")));

    // The world getting worse does not silence it either.
    cbBtcPosition(r.chain, acct(1), debtForHf(0.99));
    const before = dispatcher.seen.length;
    await r.tick();
    assert.ok(dispatcher.seen.length > before, "the keeper must still be trying at HF 0.99");
    await r.store.close();
  });

  it("FIX C-5: untracked Aave collateral escalates IMMEDIATELY as its own actionable kind", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(acct(201), acct(2), 1n);
    cbBtcPosition(chain, acct(2), debtForHf(1.6));
    // The user supplied a reserve the keeper has no row for: the pool sees more
    // collateral than the keeper can value.
    const totals = chain.accountData(acct(2));
    chain.overrides.set(acct(2).toLowerCase(), { totalCollateralBase: totals[0] + 5_000_00000000n });
    const dispatcher = new ScriptedDispatcher(async () => ({ status: "CONFIRMED", txHash: ("0x" + "33".repeat(32)) as `0x${string}` }));
    const r = await rig({ chain, dispatcher });

    const rep = await r.tick(); // ONE tick, not three
    assert.equal(rep.outcomes[0].valuation, "UNKNOWN");
    const ev = r.events.find((e) => e.kind === "untracked-collateral");
    assert.ok(ev, `expected an untracked-collateral event, got ${JSON.stringify(r.events.map((e) => e.kind))}`);
    assert.ok(ev!.reasons!.some((x) => x.includes("collateral Oilskin cannot value")));
    // …and the reason is stored so a dashboard can show that ONE user why.
    assert.ok(r.store.getAccount(acct(2))?.lastReasons?.some((x) => x.includes("UNTRACKED_COLLATERAL")));
    await r.store.close();
  });

  it("FIX C-11: a host clock 10 minutes slow no longer makes every account UNKNOWN", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(acct(202), acct(3), 1n);
    cbBtcPosition(chain, acct(3), debtForHf(1.6));
    const dispatcher = new ScriptedDispatcher(async () => ({ status: "CONFIRMED", txHash: ("0x" + "44".repeat(32)) as `0x${string}` }));
    const r = await rig({ chain, dispatcher, hostClockSkewS: -600 });
    const rep = await r.tick();
    // Was: UNKNOWN ["G2 cbBTC: feed updatedAt in the future", "G2 USDC: …"].
    assert.equal(rep.outcomes[0].valuation, "OK");
    assert.ok(r.sink.lines.some((l) => l.includes("host clock differs from chain time")), "the drift itself must be visible");
    await r.store.close();
  });

  it("FIX C-13: a failed eth_blockNumber costs the head read, not the whole tick", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(acct(203), acct(4), 1n);
    cbBtcPosition(chain, acct(4), debtForHf(1.6));
    const dispatcher = new ScriptedDispatcher(async () => ({ status: "CONFIRMED", txHash: ("0x" + "55".repeat(32)) as `0x${string}` }));
    const r = await rig({ chain, dispatcher });
    await r.tick(); // discovery happens while the head is readable
    chain.faults.set("eth_getBlockByNumber", { kind: "revert", message: "node is down" });
    const rep = await r.tick();
    // Was: the whole tick skipped — no account evaluated at all.
    assert.equal(rep.evaluated, 1, "evaluation must continue against the last known head");
    assert.ok(r.sink.lines.some((l) => l.includes("head read failed")));
    await r.store.close();
  });

  it("FIX C-12: rotation advances with a PERSISTED counter, not the block number", async () => {
    // Base advances ~15 blocks per 30 s tick: `head % n` never moved for any n
    // dividing 15, so a truncated tick always truncated the same accounts.
    const items = [0, 1, 2, 3, 4];
    const byBlock = new Set<string>();
    for (let t = 0; t < 8; t++) byBlock.add(rotate(items, BigInt(1000 + 15 * t)).join(","));
    assert.equal(byBlock.size, 1, "the old rotation was a fixed permutation");

    const byCounter = new Set<string>();
    for (let t = 1; t <= 8; t++) byCounter.add(rotate(items, BigInt(t)).join(","));
    assert.equal(byCounter.size, items.length, "a per-tick counter visits every starting offset");

    // …and the counter really is persisted across restarts.
    const p = freshPath();
    const s1 = new KeeperStore(p);
    await s1.open();
    assert.equal(await s1.nextTick(), 1);
    assert.equal(await s1.nextTick(), 2);
    await s1.close();
    const s2 = new KeeperStore(p);
    await s2.open();
    assert.equal(await s2.nextTick(), 3);
    await s2.close();
  });
});

describe("FIX C-2/C-5: the valuation names WHY protection is off", () => {
  it("distinguishes untracked collateral from an accounting fault", async () => {
    const chain = newMockChain();
    cbBtcPosition(chain, acct(5), debtForHf(1.5));
    const reader = new AaveReader(chain.publicClient(), aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 500 });
    const ctx = await reader.readReserveContexts();
    const totals = chain.accountData(acct(5));
    const params = { nowS: chain.nowS, priceMaxAgeS: 3 * 3600, oracleDeviationBps: 300, hfToleranceBps: 100 };

    chain.overrides.set(acct(5).toLowerCase(), { totalCollateralBase: totals[0] + 5_000_00000000n });
    const more = evaluateSnapshot(await reader.readAccount(acct(5), ctx, chain.blockNumber), params);
    assert.ok(more.kind === "UNKNOWN" && more.reasons.some((r) => r.startsWith("G3 UNTRACKED_COLLATERAL")));

    chain.overrides.set(acct(5).toLowerCase(), { totalCollateralBase: totals[0] / 2n });
    const fewer = evaluateSnapshot(await reader.readAccount(acct(5), ctx, chain.blockNumber), params);
    assert.ok(fewer.kind === "UNKNOWN" && fewer.reasons.some((r) => r.startsWith("G3 Σ reserve collateral")));
    assert.ok(fewer.kind === "UNKNOWN" && !fewer.reasons.some((r) => r.includes("UNTRACKED")));
    // The debt rows a repay is sized from are present on every OK valuation.
    chain.overrides.delete(acct(5).toLowerCase());
    const ok = evaluateSnapshot(await reader.readAccount(acct(5), ctx, chain.blockNumber), params);
    assert.equal(ok.kind, "OK");
    assert.ok(ok.kind === "OK" && ok.debt.some((d) => d.asset.toLowerCase() === USDC.toLowerCase() && d.amount > 0n));
    assert.ok(ok.kind === "OK" && ok.dominantCollateral.asset.toLowerCase() === CBBTC.toLowerCase());
  });
});
