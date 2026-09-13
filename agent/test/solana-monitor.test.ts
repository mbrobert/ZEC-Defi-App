/**
 * The Solana monitor against a fake Kamino world (no RPC): discovery, the shared ladder on Kamino-shaped
 * snapshots, fail-closed UNKNOWN streaks, and the store's idempotency record around every dispatch. The twin of
 * healthMonitor.test.ts. The dispatcher here is a scripted fake — the real one signs and sends on localnet in
 * solana/tests/keeper.spec.ts.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { LOAN_DUST_UNITS, rungById } from "@zyo/shared";
import { Logger, memorySink } from "../src/log.js";
import type { Delivery, KeeperEvent, Notifier } from "../src/notify/notifier.js";
import { SolanaObserveOnlyDispatcher, type SolanaDispatchIntent, type SolanaDispatchRecord, type SolanaDispatchResult, type SolanaDispatcher } from "../src/solana/dispatcher.js";
import { SOLANA_LADDER } from "../src/solana/keeper.js";
import { PK, SF_ONE, type ObligationView, type ReserveView, type ScopeEntry, type UserAccountView } from "../src/solana/layouts.js";
import { SolanaMonitor, type SolanaMonitorConfig } from "../src/solana/monitor.js";
import type { DiscoveredSolanaAccount, SolanaReader } from "../src/solana/reader.js";
import type { SolanaSnapshot, SolanaValuationParams } from "../src/solana/valuation.js";
import { BASE58_ID_CODEC, KeeperStore } from "../src/store/keeperStore.js";
import { ProgressWatchdog } from "../src/watchdog.js";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "keeper-solana-monitor-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
let n = 0;
const freshPath = () => join(dir, `m${++n}.json`);

const ONE_ZEC = 100_000_000n;
const ONE_USDC = 1_000_000n;
const LT = 0.65;
const R = { warn: rungById("warn"), repay: rungById("repay"), derisk: rungById("derisk"), emergency: rungById("emergency") };
/** Midway between two adjacent rungs' thresholds: inside the milder rung's band, above the more severe one. */
const between = (mild: typeof R.warn, severe: typeof R.warn) => (mild.hf + severe.hf) / 2;
/** The price that puts the fixture (10 ZEC, 3,990 USDC of debt) at `hf`. */
const priceAt = (hf: number) => (hf * 3_990) / (10 * LT);
/** Inside the repay band of the floor's ladder: under repay (1.16), above de-risk (1.09) → HF 1.125, ≈ $690.58 (−31 %). */
const P_REPAY = priceAt(between(R.repay, R.derisk));
/** After a repay: above repay's disarm level (1.18) but under warn's (1.25) → HF 1.215. */
const HF_REPAY_CLEARED = (R.repay.disarmHf + R.warn.disarmHf) / 2;
/** USD → Kamino scaled fraction (2^60). */
const usdSf = (usd: number): bigint => (BigInt(Math.round(usd * 1e9)) * SF_ONE) / 1_000_000_000n;
/** The debt (USDC base units) that puts a position at `hf` — the same arithmetic the valuation recomputes. */
const debtForHf = (collateralZec: bigint, zecUsd: number, hf: number): bigint => BigInt(Math.floor(((Number(collateralZec) / 1e8) * zecUsd * LT * 1e6) / hf));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A distinct, well-formed base58 signature per call. */
const SIG = (i: number) => B58[i % 58].repeat(88);

interface Position {
  view: UserAccountView;
  collateralZec: bigint;
  debtUsdc: bigint;
  idleUsdc: bigint;
  idleZec: bigint;
}

/** A market of one reserve pair whose refreshed numbers follow the Scope price, like klend's after refresh. */
class FakeWorld {
  slot = 447_000_000n;
  nowS = 1_789_000_000n;
  zecUsd = 1000;
  /** Age of the Scope stamp at read time (S3 refuses > 180 s). */
  scopeAgeS = 0;
  readFailures = new Set<string>();
  positions = new Map<string, Position>();

  add(collateralZec: bigint, debtUsdc: bigint, idleUsdc = 0n): string {
    const account = Keypair.generate().publicKey;
    const view: UserAccountView = { owner: Keypair.generate().publicKey, bump: 255, version: 1, grantEpoch: 0n, obligation: Keypair.generate().publicKey, createdSlot: this.slot };
    this.positions.set(account.toBase58(), { view, collateralZec, debtUsdc, idleUsdc, idleZec: 0n });
    return account.toBase58();
  }
  advance(): void {
    this.slot += 5n;
    this.nowS += 2n;
  }
  hf(id: string): number {
    const p = this.positions.get(id)!;
    return ((Number(p.collateralZec) / 1e8) * this.zecUsd * LT) / (Number(p.debtUsdc) / 1e6);
  }
  private reserve(zec: boolean): ReserveView {
    const supply = 1_000_000n * (zec ? ONE_ZEC : ONE_USDC);
    return {
      slot: this.slot,
      stale: false,
      priceStatus: 63,
      status: 0,
      loanToValuePct: 40,
      liquidationThresholdPct: 65,
      borrowFactorPct: 100n,
      liquidityMint: zec ? PK.zecMint : PK.usdcMint,
      liquidityAvailable: supply,
      liquidityBorrowedSf: 0n,
      marketPriceSf: usdSf(zec ? this.zecUsd : 1),
      mintDecimals: zec ? 8 : 6,
      collateralTotalSupply: supply, // 1:1 cToken exchange rate
      maxAgePriceSeconds: 180n,
      scopePriceFeed: PK.scopePrices,
      scopePriceChain0: zec ? 430 : 13,
    };
  }
  snapshot(id: string): SolanaSnapshot {
    const p = this.positions.get(id);
    if (!p) throw new Error(`no such account ${id}`);
    if (this.readFailures.has(id)) throw new Error("rpc: simulateTransaction timed out");
    const collateralUsd = (Number(p.collateralZec) / 1e8) * this.zecUsd;
    const debtUsd = Number(p.debtUsdc) / 1e6;
    const obligation: ObligationView = {
      slot: this.slot,
      stale: false,
      priceStatus: 63,
      owner: new PublicKey(id),
      lendingMarket: PK.market,
      depositReserves: [PK.zecReserve],
      borrowReserves: p.debtUsdc > 0n ? [PK.usdcReserve] : [],
      zecDepositedCtokens: p.collateralZec,
      usdcBorrowedAmountSf: p.debtUsdc * SF_ONE,
      depositedValueSf: usdSf(collateralUsd),
      borrowFactorAdjustedDebtValueSf: usdSf(debtUsd),
      borrowedAssetsMarketValueSf: usdSf(debtUsd),
      allowedBorrowValueSf: usdSf(collateralUsd * 0.4),
      unhealthyBorrowValueSf: usdSf(collateralUsd * LT),
      hasDebt: p.debtUsdc > 0n,
    };
    const scope = (index: number, priceUsd: number): ScopeEntry => ({ index, value: BigInt(Math.round(priceUsd * 1e8)), exp: 8, lastUpdatedSlot: this.slot, unixTimestamp: this.nowS - BigInt(this.scopeAgeS), priceUsd });
    return { slot: this.slot, nowS: this.nowS, obligation, zecReserve: this.reserve(true), usdcReserve: this.reserve(false), scopeZec: scope(430, this.zecUsd), scopeUsdc: scope(13, 1), independent: null, accountUsdc: p.idleUsdc, accountZec: p.idleZec };
  }
  reader(): SolanaReader {
    const fake = {
      slot: async () => this.slot,
      blockTime: async () => this.nowS,
      discover: async (): Promise<DiscoveredSolanaAccount[]> => [...this.positions.entries()].map(([id, p]) => ({ account: new PublicKey(id), view: p.view })),
      snapshot: async (account: PublicKey) => this.snapshot(account.toBase58()),
    };
    return fake as unknown as SolanaReader;
  }
}

/** Recording dispatcher whose behaviour is scripted per call; it also snapshots the store ON DISK at dispatch time. */
class FakeDispatcher implements SolanaDispatcher {
  calls: { intent: SolanaDispatchIntent; storeOnDisk: { dispatches: { key: string; status: string }[] } }[] = [];
  confirms: SolanaDispatchRecord[] = [];
  script: ((intent: SolanaDispatchIntent) => Promise<SolanaDispatchResult> | SolanaDispatchResult)[] = [];
  default: (intent: SolanaDispatchIntent) => SolanaDispatchResult = (i) => (i.record.action === "notify" ? { status: "NOTIFIED" } : { status: "CONFIRMED", signature: SIG(this.calls.length - 1) });
  constructor(private readonly storePath: string) {}
  async dispatch(intent: SolanaDispatchIntent): Promise<SolanaDispatchResult> {
    const storeOnDisk = JSON.parse(await readFile(this.storePath, "utf8"));
    this.calls.push({ intent, storeOnDisk });
    const fn = this.script.shift();
    return fn ? fn(intent) : this.default(intent);
  }
  async confirm(record: SolanaDispatchRecord): Promise<SolanaDispatchResult> {
    this.confirms.push(record);
    return { status: "CONFIRMED", signature: record.txHash! };
  }
}

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

const CONFIG: SolanaMonitorConfig = { concurrency: 2, unknownEscalationStreak: 2, maxDispatchAttempts: 3, maxResumePerTick: 25, dispatchDeadlineMs: 5_000, maxRungRefires: 2 };
const PARAMS: SolanaValuationParams = { priceMaxAgeS: 180, independentMaxAgeS: 120, oracleDeviationBps: 200, hfToleranceBps: 100, requireIndependent: false };

async function rig(makeDispatcher?: (path: string, log: Logger, notifier: RecordingNotifier) => SolanaDispatcher) {
  const world = new FakeWorld();
  const path = freshPath();
  const store = new KeeperStore<string, string>(path, { idCodec: BASE58_ID_CODEC });
  await store.open();
  const sink = memorySink();
  const log = new Logger(sink.sink, "debug", { svc: "test" });
  const notifier = new RecordingNotifier();
  const fake = new FakeDispatcher(path);
  const dispatcher: SolanaDispatcher = makeDispatcher ? makeDispatcher(path, log, notifier) : fake;
  const escalations: { account: string; reasons: string[]; streak: number }[] = [];
  const watchdog = new ProgressWatchdog({ stallMs: 10_000, backoff: { initialMs: 10, maxMs: 100, factor: 2 } });
  const monitor = new SolanaMonitor({ reader: world.reader(), store, ladder: SOLANA_LADDER, dispatcher, log, config: CONFIG, valuationParams: PARAMS, simPayer: Keypair.generate().publicKey, notifier, onEscalate: (e) => escalations.push(e) });
  const tick = async () => {
    world.advance();
    return monitor.tick(watchdog.beginTick());
  };
  return { world, path, store, fake, dispatcher, sink, notifier, escalations, monitor, watchdog, tick, close: () => store.close() };
}

describe("Solana monitor: discovery and a healthy position", () => {
  it("registers every Account the program owns (owner from the account bytes) and records the HF Kamino reports; nothing fires", async () => {
    const r = await rig();
    const id = r.world.add(10n * ONE_ZEC, 3_990n * ONE_USDC); // Kamino's 40 % cap at $1,000 → HF 1.629
    const first = await r.tick();
    assert.equal(first.discovered, 1);
    assert.equal(first.evaluated, 1);
    assert.equal(first.outcomes[0].valuation, "OK");
    assert.ok(Math.abs(first.outcomes[0].hf! - 1.6291) < 0.001, `hf ${first.outcomes[0].hf}`);
    assert.equal(first.outcomes[0].fired, null);
    const acct = r.store.getAccount(id)!;
    assert.equal(acct.owner, r.world.positions.get(id)!.view.owner.toBase58());
    assert.equal(acct.lastValuation, "OK");
    assert.deepEqual(acct.ladder.fired, []);
    assert.equal(acct.episode, null);
    assert.equal(r.fake.calls.length, 0);
    const second = await r.tick();
    assert.equal(second.discovered, 0, "already registered");
    assert.equal(r.store.listAccounts().length, 1);
    assert.equal(JSON.parse(await readFile(r.path, "utf8")).idCodec, "base58");
    await r.close();
  });

  it("no debt, and debt at or under LOAN_DUST_UNITS, is NO_DEBT — not a rung, not an HF", async () => {
    const r = await rig();
    r.world.add(10n * ONE_ZEC, 0n);
    r.world.add(10n * ONE_ZEC, BigInt(LOAN_DUST_UNITS));
    const rep = await r.tick();
    assert.deepEqual(rep.outcomes.map((o) => o.valuation).sort(), ["NO_DEBT", "NO_DEBT"]);
    assert.ok(rep.outcomes.every((o) => o.hf === null && o.fired === null));
    assert.equal(r.fake.calls.length, 0);
    await r.close();
  });
});

describe("Solana monitor: the ladder", () => {
  it("price into the repay band (HF 1.125, −31 %) crosses warn and repay: the most severe rung fires once, its record is on disk as PENDING before the dispatcher runs, then CONFIRMED with the signature; re-arms at the disarm level; the episode ends when the account is healthy again", async () => {
    const r = await rig();
    const id = r.world.add(10n * ONE_ZEC, 3_990n * ONE_USDC, 3_990n * ONE_USDC);
    await r.tick();
    r.world.zecUsd = P_REPAY;
    const hfNow = between(R.repay, R.derisk);
    assert.ok(Math.abs(r.world.hf(id) - hfNow) < 0.001);
    assert.ok(r.world.hf(id) < R.repay.hf && r.world.hf(id) > R.derisk.hf);
    const rep = await r.tick();
    assert.equal(rep.outcomes[0].fired, "repay");
    assert.equal(r.fake.calls.length, 1);
    const call = r.fake.calls[0];
    assert.equal(call.intent.record.rung, "repay");
    assert.equal(call.intent.record.action, "repay");
    assert.ok(Math.abs(call.intent.record.hf - hfNow) < 0.001);
    // idempotency: the record existed on disk, PENDING, before the dispatcher was invoked
    const onDisk = call.storeOnDisk.dispatches.find((d) => d.key === call.intent.record.key);
    assert.ok(onDisk, "dispatch record persisted before dispatch");
    assert.equal(onDisk!.status, "PENDING");
    const rec = r.store.listDispatches()[0];
    assert.equal(rec.status, "CONFIRMED");
    assert.equal(rec.txHash, SIG(0));
    assert.equal(rec.attempts, 1);
    assert.equal(rec.episode, 1);
    const acct = r.store.getAccount(id)!;
    assert.deepEqual([...acct.ladder.fired].sort(), ["repay", "warn"], "the rungs crossed on the way down are marked fired so warn does not fire late");
    assert.equal(acct.episode, 1);
    const kinds = r.notifier.events.map((e) => e.kind);
    assert.ok(kinds.includes("rung-fired") && kinds.includes("dispatch"));
    assert.ok(r.notifier.events.every((e) => e.detail?.chain === "solana"));

    // The repay took effect: HF 1.215 clears repay's disarm level (1.18) but not warn's (1.25).
    r.world.positions.get(id)!.debtUsdc = debtForHf(10n * ONE_ZEC, P_REPAY, HF_REPAY_CLEARED);
    const after = await r.tick();
    assert.equal(after.outcomes[0].fired, null);
    assert.equal(r.fake.calls.length, 1, "nothing new dispatched");
    assert.deepEqual(r.store.getAccount(id)!.ladder.fired, ["warn"]);
    assert.equal(r.store.getAccount(id)!.episode, 1, "episode continues while a rung is fired");

    // Fully healthy again → warn re-arms, the episode ends.
    r.world.zecUsd = 1000;
    assert.ok(r.world.hf(id) >= R.warn.disarmHf);
    await r.tick();
    assert.deepEqual(r.store.getAccount(id)!.ladder.fired, []);
    assert.equal(r.store.getAccount(id)!.episode, null);
    // and a second fall starts a NEW episode with a new key
    r.world.zecUsd = P_REPAY;
    r.world.positions.get(id)!.debtUsdc = 3_990n * ONE_USDC;
    await r.tick();
    assert.equal(r.fake.calls.length, 2);
    assert.equal(r.fake.calls[1].intent.record.episode, 2);
    assert.notEqual(r.fake.calls[1].intent.record.key, r.fake.calls[0].intent.record.key);
    await r.close();
  });

  it("an aborted tick returns aborted:true and writes no dispatch record", async () => {
    const r = await rig();
    r.world.add(10n * ONE_ZEC, 3_990n * ONE_USDC);
    await r.tick();
    r.world.zecUsd = P_REPAY;
    const h = r.watchdog.beginTick();
    const ac = new AbortController();
    ac.abort(new Error("shutdown: SIGTERM"));
    const rep = await r.monitor.tick({ signal: ac.signal, bump: h.bump, end: h.end });
    assert.equal(rep.aborted, true);
    assert.equal(r.fake.calls.length, 0);
    assert.equal(r.store.listDispatches().length, 0);
    await r.close();
  });
});

describe("Solana monitor: fail closed", () => {
  it("UNKNOWN (a stale Scope price, then a failed read) never fires a rung: a streak, escalation at the configured streak, reset on the next OK read", async () => {
    const r = await rig();
    const id = r.world.add(10n * ONE_ZEC, 3_990n * ONE_USDC, 3_990n * ONE_USDC);
    await r.tick();
    r.world.zecUsd = P_REPAY; // would cross repay if the read were trusted
    r.world.scopeAgeS = 600; // S3: older than the 180 s the reserve allows
    const t1 = await r.tick();
    assert.equal(t1.outcomes[0].valuation, "UNKNOWN");
    assert.equal(r.fake.calls.length, 0);
    assert.equal(r.store.getAccount(id)!.unknownStreak, 1);
    assert.equal(r.escalations.length, 0);
    await r.tick();
    assert.equal(r.store.getAccount(id)!.unknownStreak, 2);
    assert.equal(r.escalations.length, 1);
    assert.ok(r.escalations[0].reasons.some((x) => x.startsWith("S3")), r.escalations[0].reasons.join("; "));
    r.world.scopeAgeS = 0;
    r.world.readFailures.add(id);
    await r.tick();
    assert.equal(r.store.getAccount(id)!.unknownStreak, 3);
    assert.ok(r.store.getAccount(id)!.lastReasons?.some((x) => x.startsWith("read failed")));
    assert.equal(r.fake.calls.length, 0, "still nothing dispatched");
    r.world.readFailures.delete(id);
    const ok = await r.tick();
    assert.equal(ok.outcomes[0].fired, "repay");
    assert.equal(r.store.getAccount(id)!.unknownStreak, 0);
    assert.equal(r.fake.calls.length, 1);
    await r.close();
  });

  it("a permanent refusal is recorded REFUSED and escalated as grant-misconfigured, then ABANDONED on the next tick instead of retried; a transient FAILED is retried under the SAME key and ABANDONED after maxDispatchAttempts", async () => {
    const r = await rig();
    const a = r.world.add(10n * ONE_ZEC, 3_990n * ONE_USDC, 3_990n * ONE_USDC);
    await r.tick();
    r.world.zecUsd = P_REPAY;
    r.fake.script.push(() => ({ status: "REFUSED", reason: "GrantNotLive", permanent: true }));
    await r.tick();
    let rec = r.store.listDispatches({ account: a })[0];
    assert.equal(rec.status, "REFUSED");
    assert.equal(rec.error, "permanent: GrantNotLive");
    assert.equal(r.escalations.length, 1);
    assert.ok(r.notifier.events.some((e) => e.kind === "grant-misconfigured"));
    await r.tick();
    rec = r.store.listDispatches({ account: a })[0];
    assert.equal(rec.status, "ABANDONED");
    assert.equal(r.fake.calls.length, 1, "a permanent refusal is not retried");
    assert.equal(r.escalations.length, 2);

    // transient failures: same key three times, then abandoned
    const r2 = await rig();
    const b = r2.world.add(10n * ONE_ZEC, 3_990n * ONE_USDC, 3_990n * ONE_USDC);
    await r2.tick();
    r2.world.zecUsd = P_REPAY;
    r2.fake.script.push(() => ({ status: "FAILED", error: "blockhash not found" }), () => ({ status: "FAILED", error: "blockhash not found" }), () => ({ status: "FAILED", error: "blockhash not found" }));
    await r2.tick();
    assert.equal(r2.store.listDispatches({ account: b })[0].status, "FAILED");
    assert.equal(r2.store.listDispatches({ account: b })[0].attempts, 1);
    const t2 = await r2.tick();
    assert.equal(t2.resumed, 1, "the FAILED record is resumed, not re-fired");
    assert.equal(r2.store.listDispatches({ account: b }).length, 1, "no second record while the first is open");
    assert.equal(r2.store.listDispatches({ account: b })[0].attempts, 2);
    await r2.tick();
    const final = r2.store.listDispatches({ account: b })[0];
    assert.equal(final.status, "ABANDONED");
    assert.equal(final.attempts, 3);
    assert.equal(r2.fake.calls.length, 3);
    assert.ok(new Set(r2.fake.calls.map((c) => c.intent.record.key)).size === 1, "one key for the whole episode");
    assert.ok(r2.escalations.some((e) => e.reasons.some((x) => x.includes("abandoned"))));
    await r.close();
    await r2.close();
  });

  it("SENT: the signature is persisted before the broadcast; the resume path confirms it on the next tick without dispatching again", async () => {
    const r = await rig();
    const id = r.world.add(10n * ONE_ZEC, 3_990n * ONE_USDC, 3_990n * ONE_USDC);
    await r.tick();
    r.world.zecUsd = P_REPAY;
    let persistedBeforeReturn = false;
    r.fake.script.push(async (i) => {
      await i.persistBeforeSend!({ signature: SIG(9), plan: {} as never });
      persistedBeforeReturn = JSON.parse(await readFile(r.path, "utf8")).dispatches[0].txHash === SIG(9);
      return { status: "SENT", signature: SIG(9) };
    });
    await r.tick();
    assert.ok(persistedBeforeReturn, "the signature was on disk before the dispatcher returned");
    let rec = r.store.listDispatches({ account: id })[0];
    assert.equal(rec.status, "SENT");
    assert.equal(rec.txHash, SIG(9));
    // the sent repay took effect on chain before the next tick (else the confirmed-but-ineffective rule re-arms it, by design)
    r.world.positions.get(id)!.debtUsdc = debtForHf(10n * ONE_ZEC, P_REPAY, HF_REPAY_CLEARED);
    const t = await r.tick();
    assert.equal(t.resumed, 1);
    assert.equal(r.fake.confirms.length, 1);
    assert.equal(r.fake.calls.length, 1, "confirm, not a second dispatch");
    rec = r.store.listDispatches({ account: id })[0];
    assert.equal(rec.status, "CONFIRMED");
    assert.equal(rec.txHash, SIG(9));
    await r.close();
  });
});

describe("Solana monitor: observe-only", () => {
  it("warn is LOGGED_ONLY until a channel reaches a person, then NOTIFIED; a repay rung is REFUSED by name and never sent", async () => {
    const r = await rig((_p, log, notifier) => new SolanaObserveOnlyDispatcher(log, notifier));
    const id = r.world.add(10n * ONE_ZEC, 3_990n * ONE_USDC);
    await r.tick();
    r.world.positions.get(id)!.debtUsdc = debtForHf(10n * ONE_ZEC, 1000, between(R.warn, R.repay)); // crosses warn (1.23) only: HF 1.195
    await r.tick();
    let rec = r.store.listDispatches({ account: id })[0];
    assert.equal(rec.action, "notify");
    assert.equal(rec.status, "LOGGED_ONLY");
    r.notifier.personReached = true;
    await r.tick();
    rec = r.store.listDispatches({ account: id })[0];
    assert.equal(rec.status, "NOTIFIED", "the resume path re-delivers and upgrades the record");
    r.world.positions.get(id)!.debtUsdc = debtForHf(10n * ONE_ZEC, 1000, between(R.repay, R.derisk)); // crosses repay (1.16), not derisk (1.09): HF 1.125
    await r.tick();
    const repay = r.store.listDispatches({ account: id }).find((d) => d.rung === "repay")!;
    assert.equal(repay.status, "REFUSED");
    assert.match(repay.error!, /^permanent: observe-only/);
    assert.equal(repay.txHash, undefined);
    assert.ok(r.escalations.length >= 1);
    await r.close();
  });
});
