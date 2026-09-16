/**
 * The Solana keeper's per-tick work — the twin of `monitors/healthMonitor.ts`, same order, same rules:
 *   1. resume — dispatches a previous process left PENDING / SENT / FAILED / REFUSED / LOGGED_ONLY are
 *      finished FIRST, bounded per tick, each inside its own deadline;
 *   2. discover — every UserAccount the program owns (getProgramAccounts; no cursor to lose);
 *   3. evaluate — every registered account, bounded concurrency, rotating by the store's persisted tick;
 *   4. per account: valuation (a simulated Kamino refresh + Scope + an independent price, fail-closed) →
 *      ladder step with hysteresis → ONE atomic store write (episode, dispatch record, ladder state) →
 *      dispatch → bookkeeping; every rung and escalation goes through the notifier;
 *   5. prune terminal dispatch records.
 * Time comes from the chain (the slot's block time), never the host clock.
 *
 * What is deliberately absent versus Base: venue books and LP ids (one venue, one obligation), the
 * nonce (a Solana signature is persisted before the send instead), and the untracked-collateral class
 * (the program admits one collateral).
 */
import { PublicKey } from "@solana/web3.js";
import { MIN_LADDER_ENTRY_HF, ladderBpsFor } from "@zyo/shared";
import { stepLadder, validateLadder, type LadderRung, type LadderState } from "../engine/ladder.js";
import type { Logger } from "../log.js";
import { eventNow, type KeeperEvent, type Notifier } from "../notify/notifier.js";
import { AbortedError, DeadlineError, withDeadline } from "../services/deadline.js";
import { DuplicateIdError, isFatalStoreError, KeeperStore, type AccountRecord, type DispatchRecord } from "../store/keeperStore.js";
import type { TickHandle } from "../watchdog.js";
import type { SolanaDispatcher, SolanaDispatchResult } from "./dispatcher.js";
import type { PairView } from "./pair.js";
import type { DiscoveredSolanaAccount, SolanaReader } from "./reader.js";
import { evaluateSolana, type SolanaValuation, type SolanaValuationParams } from "./valuation.js";

type Rec = AccountRecord<string>;
type Disp = DispatchRecord<string, string>;

export interface SolanaMonitorConfig {
  concurrency: number;
  unknownEscalationStreak: number;
  maxDispatchAttempts: number;
  maxResumePerTick: number;
  dispatchDeadlineMs: number;
  maxRungRefires: number;
}

export interface SolanaMonitorDeps {
  reader: SolanaReader;
  store: KeeperStore<string, string>;
  ladder: readonly LadderRung[];
  dispatcher: SolanaDispatcher;
  log: Logger;
  config: SolanaMonitorConfig;
  valuationParams: SolanaValuationParams;
  /** Fee payer named by the read-only refresh simulation. */
  simPayer: PublicKey;
  now?: () => Date;
  notifier?: Notifier;
  onEscalate?: (e: { account: string; reasons: string[]; streak: number }) => void;
  onFatal?: (e: Error) => void;
}

export interface SolanaAccountOutcome {
  account: string;
  valuation: SolanaValuation["kind"] | "READ_FAILED";
  hf: number | null;
  fired: string | null;
  dispatch: SolanaDispatchResult | null;
  error?: string;
}

export interface SolanaTickReport {
  slot: bigint | null;
  discovered: number;
  resumed: number;
  evaluated: number;
  outcomes: SolanaAccountOutcome[];
  aborted: boolean;
}

const RESUMABLE = new Set<Disp["status"]>(["PENDING", "SENT", "FAILED", "REFUSED", "LOGGED_ONLY"]);

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
}

async function mapBounded<T, R>(items: readonly T[], concurrency: number, fn: (t: T) => Promise<R>, signal: AbortSignal): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length && !signal.aborted) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  // Items never started are not "evaluated": an aborted tick says so instead of returning a short list.
  if (signal.aborted && i < items.length) throw new AbortedError(`tick (${items.length - i} of ${items.length} accounts not evaluated)`, signal.reason);
  return out;
}

export class SolanaMonitor {
  private readonly now: () => Date;
  private views = new Map<string, DiscoveredSolanaAccount>();

  constructor(private readonly d: SolanaMonitorDeps) {
    validateLadder(d.ladder);
    if (!(d.config.concurrency >= 1)) throw new RangeError("concurrency must be ≥ 1");
    this.now = d.now ?? (() => new Date());
  }

  private get lastResortRung(): LadderRung {
    return [...this.d.ladder].sort((a, b) => a.severity - b.severity)[this.d.ladder.length - 1];
  }

  /**
   * The ladder THIS account runs on (the twin of `HealthMonitor.resolveLadder`): derived from the entry HF
   * the program recorded at the account's last borrow (`UserAccount.entry_hf_bps`, BUILD-PLAN D7 /
   * SOLANA-ARCHITECTURE §14.2) with the same INTEGER rule the program applies (`ladderBpsFor`), so the rung
   * the keeper names is the rung `keeper_protect` expects; the floor's ladder (`deps.ladder`) when there is
   * no usable record, and the record says so (`entryHf: null`).
   */
  private resolveLadder(view: DiscoveredSolanaAccount | undefined): { ladder: readonly LadderRung[]; entryHf: number | null } {
    const e = view ? Number(view.view.entryHfBps) : 0;
    if (!Number.isFinite(e) || e < MIN_LADDER_ENTRY_HF * 10_000) return { ladder: this.d.ladder, entryHf: null };
    try {
      const bps = ladderBpsFor(e);
      const ladder = bps.map((r, i) => ({ id: r.id, hf: r.hfBps / 10_000, disarmHf: r.disarmHfBps / 10_000, severity: r.severity, action: this.d.ladder[i]!.action }));
      validateLadder(ladder);
      return { ladder, entryHf: e / 10_000 };
    } catch {
      return { ladder: this.d.ladder, entryHf: null };
    }
  }

  private async emit(e: Omit<KeeperEvent, "at">): Promise<void> {
    if (!this.d.notifier) return;
    try {
      await this.d.notifier.deliver(eventNow({ ...e, detail: { chain: "solana", ...(e.detail ?? {}) } }, this.now));
    } catch {
      /* MultiNotifier logged it; delivery never breaks a tick */
    }
  }

  private async escalate(account: string, reasons: string[], streak: number, kind: KeeperEvent["kind"] = "escalation"): Promise<void> {
    try {
      this.d.onEscalate?.({ account, reasons, streak });
    } catch (e) {
      this.d.log.error("escalation hook threw", { error: errMsg(e) });
    }
    await this.emit({ kind, severity: "critical", account, reasons, detail: { streak } });
  }

  private fatal(e: unknown): boolean {
    if (!isFatalStoreError(e)) return false;
    this.d.log.error("STORE UNUSABLE — stopping (a keeper that cannot record what it did must not act)", { error: errMsg(e) });
    this.d.onFatal?.(e as Error);
    return true;
  }

  async tick(handle: TickHandle): Promise<SolanaTickReport> {
    const log = this.d.log;
    const report: SolanaTickReport = { slot: null, discovered: 0, resumed: 0, evaluated: 0, outcomes: [], aborted: false };
    try {
      report.resumed = await this.resumePending(handle, log);
      handle.bump();

      let slot: bigint;
      let nowS: bigint;
      try {
        slot = await this.d.reader.slot(handle.signal);
        nowS = await this.d.reader.blockTime(slot, handle.signal);
      } catch (e) {
        if (e instanceof AbortedError || handle.signal.aborted) throw e;
        log.error("head read failed — no evaluation this tick", { error: errMsg(e) });
        return report;
      }
      report.slot = slot;
      const drift = Math.abs(Number(nowS) - Math.floor(this.now().getTime() / 1000));
      if (drift > 300) log.warn("host clock drifts from the chain", { driftS: drift });
      handle.bump();

      try {
        report.discovered = await this.discover(slot, handle, log);
      } catch (e) {
        if (e instanceof AbortedError || handle.signal.aborted) throw e;
        log.error("discovery failed — evaluating the accounts already registered", { error: errMsg(e) });
      }

      const tick = await this.d.store.nextTick();
      const all = this.d.store.listAccounts();
      const rotated = all.length ? [...all.slice(tick % all.length), ...all.slice(0, tick % all.length)] : [];
      const outcomes = await mapBounded(
        rotated,
        this.d.config.concurrency,
        async (rec) => {
          try {
            return await this.evaluateOne(rec, slot, nowS, handle, log);
          } catch (e) {
            if (e instanceof AbortedError || handle.signal.aborted) throw e;
            if (this.fatal(e)) throw e;
            log.error("account evaluation failed", { account: rec.account, error: errMsg(e) });
            return { account: rec.account, valuation: "READ_FAILED" as const, hf: null, fired: null, dispatch: null, error: errMsg(e) };
          }
        },
        handle.signal
      );
      report.outcomes = outcomes;
      report.evaluated = outcomes.length;
      try {
        const pruned = await this.d.store.prune();
        if (pruned) log.info("pruned terminal dispatch records", { pruned });
      } catch (e) {
        if (this.fatal(e)) throw e;
        log.warn("prune failed", { error: errMsg(e) });
      }
      return report;
    } catch (e) {
      if (e instanceof AbortedError || handle.signal.aborted) {
        report.aborted = true;
        return report;
      }
      throw e;
    } finally {
      handle.end();
    }
  }

  // ---- 1. resume ------------------------------------------------------------

  private async resumePending(handle: TickHandle, log: Logger): Promise<number> {
    const candidates = this.d.store.listDispatches().filter((d) => RESUMABLE.has(d.status));
    const slice = candidates.slice(0, this.d.config.maxResumePerTick);
    if (slice.length < candidates.length) log.info("resume budget reached — the rest wait for the next tick", { pending: candidates.length, resuming: slice.length });
    let n = 0;
    for (const rec of slice) {
      if (handle.signal.aborted) break;
      const l = log.child({ key: rec.key, account: rec.account });
      // An episode that ended (account healthy again) makes the record moot.
      const acct = this.d.store.getAccount(rec.account);
      if (acct && acct.episode !== rec.episode) {
        await this.setStatus(rec, "SUPERSEDED", "episode ended before this record was resumed", l);
        continue;
      }
      if (rec.status !== "SENT") {
        if (rec.error?.includes("permanent:")) {
          // A refusal only the owner can clear (grant not live, rung excluded): retrying is noise — Base's rule.
          await this.setStatus(rec, "ABANDONED", rec.error, l);
          await this.escalate(rec.account, [`dispatch ${rec.key} needs the owner: ${rec.error}`], rec.attempts, "grant-misconfigured");
          continue;
        }
        if (rec.attempts >= this.d.config.maxDispatchAttempts && rec.rung !== this.lastResortRung.id) {
          await this.setStatus(rec, "ABANDONED", `gave up after ${rec.attempts} attempts: ${rec.error ?? "?"}`, l);
          l.error("dispatch ABANDONED — human intervention required", { attempts: rec.attempts, lastError: rec.error });
          await this.escalate(rec.account, [`dispatch ${rec.key} abandoned: ${rec.error ?? "?"}`], rec.attempts);
          continue;
        }
      }
      let result: SolanaDispatchResult;
      try {
        result = await withDeadline(`resume ${rec.key}`, this.d.config.dispatchDeadlineMs, handle.signal, () =>
          rec.status === "SENT" ? this.d.dispatcher.confirm(rec, handle.signal) : this.d.dispatcher.dispatch({ record: rec, persistBeforeSend: this.preSend(rec) }, handle.signal)
        );
      } catch (e) {
        if (e instanceof AbortedError || handle.signal.aborted) throw e;
        if (e instanceof DeadlineError) {
          l.error("resumed dispatch exceeded its deadline — moving on", { error: errMsg(e) });
          continue;
        }
        result = { status: "FAILED", error: errMsg(e) };
      }
      await this.recordResult(rec, result, l, handle.signal);
      n++;
      handle.bump();
    }
    return n;
  }

  // ---- 2. discover -----------------------------------------------------------

  private async discover(slot: bigint, handle: TickHandle, log: Logger): Promise<number> {
    const found = await this.d.reader.discover(handle.signal);
    this.views = new Map(found.map((f) => [f.account.toBase58(), f]));
    let registered = 0;
    for (const f of found) {
      const id = f.account.toBase58();
      if (this.d.store.getAccount(id)) continue;
      try {
        await this.d.store.registerAccount({ account: id, owner: f.view.owner.toBase58(), discoveredAtBlock: slot }, this.now());
        registered++;
        log.info("account discovered", { account: id, owner: f.view.owner.toBase58() });
      } catch (e) {
        if (e instanceof DuplicateIdError) continue;
        throw e;
      }
    }
    return registered;
  }

  // ---- 4/5. evaluate one account -------------------------------------------

  private async evaluateOne(rec: Rec, slot: bigint, nowS: bigint, handle: TickHandle, log: Logger): Promise<SolanaAccountOutcome> {
    const l = log.child({ account: rec.account });
    const nowIso = this.now().toISOString();
    let valuation: SolanaValuation;
    const view = this.views.get(rec.account);
    if (!view) {
      valuation = { kind: "UNKNOWN", reasons: ["account not found on chain this tick"] };
    } else {
      try {
        const snap = await this.d.reader.snapshot(view.account, view.view, this.d.simPayer, handle.signal);
        valuation = evaluateSolana(snap, this.d.valuationParams);
      } catch (e) {
        if (e instanceof AbortedError || handle.signal.aborted) throw e;
        valuation = { kind: "UNKNOWN", reasons: [`read failed: ${errMsg(e)}`] };
      }
    }
    void slot;
    void nowS;
    handle.bump();

    if (valuation.kind === "UNKNOWN") {
      const streak = rec.unknownStreak + 1;
      l.warn("valuation UNKNOWN — fail closed, no action", { reasons: valuation.reasons, streak });
      await this.bookkeep(rec.account, { lastValuation: "UNKNOWN", unknownStreak: streak, lastEvaluatedAt: nowIso, lastReasons: valuation.reasons }, l);
      if (streak >= this.d.config.unknownEscalationStreak) await this.escalate(rec.account, valuation.reasons, streak);
      return { account: rec.account, valuation: "UNKNOWN", hf: null, fired: null, dispatch: null };
    }

    const hf = valuation.kind === "OK" ? valuation.hf : Number.POSITIVE_INFINITY;
    const { ladder, entryHf } = this.resolveLadder(view);
    const { ladder: startState, refires, rearmedIds } = this.reArmIneffective(rec, hf, l, ladder);
    const step = stepLadder(ladder, startState, hf);

    if (!step.fire) {
      const patch: Partial<Rec> = { ladder: step.next, lastHf: Number.isFinite(hf) ? hf : null, lastValuation: valuation.kind, lastEvaluatedAt: nowIso, unknownStreak: 0, rungRefires: refires, entryHf };
      if (step.episodeEnded) patch.episode = null;
      if (step.rearmed.length) l.info("rungs re-armed", { rungs: step.rearmed.map((r) => r.id), hf });
      if (step.episodeEnded) l.info("episode ended — account healthy again", { episode: rec.episode });
      await this.bookkeep(rec.account, patch, l);
      return { account: rec.account, valuation: valuation.kind, hf: Number.isFinite(hf) ? hf : null, fired: null, dispatch: null };
    }

    if (valuation.kind !== "OK") throw new Error("invariant: rung fired without an OK valuation");
    const fire = step.fire;
    if (handle.signal.aborted) throw new AbortedError(`evaluate ${rec.account}`, handle.signal.reason);
    let record: Disp;
    try {
      record = await this.d.store.mutate((s) => {
        const a = s.accounts.find((x) => x.account === rec.account);
        if (!a) throw new Error(`account ${rec.account} vanished from store`);
        if (step.episodeStarted || a.episode === null) {
          s.counters.episode += 1;
          a.episode = s.counters.episode;
        }
        s.counters.dispatchSeq += 1;
        const seq = s.counters.dispatchSeq;
        const key = `${rec.account}:${a.episode}:${seq}:${fire.action}`;
        if (s.dispatches.some((d) => d.key === key)) throw new DuplicateIdError("dispatch", key);
        for (const d of s.dispatches) {
          if (d.account === rec.account && RESUMABLE.has(d.status) && d.status !== "SENT") {
            d.status = "SUPERSEDED";
            d.error = `superseded by ${key}`;
            d.updatedAt = nowIso;
          }
        }
        const d: Disp = { key, account: rec.account, episode: a.episode, seq, action: fire.action, rung: fire.id, hf: valuation.hf, status: "PENDING", attempts: 0, createdAt: nowIso, updatedAt: nowIso, disarmHf: fire.disarmHf };
        s.dispatches.push(d);
        a.ladder = step.next;
        a.entryHf = entryHf;
        a.lastHf = valuation.hf;
        a.lastValuation = "OK";
        a.lastEvaluatedAt = nowIso;
        a.unknownStreak = 0;
        a.rungRefires = refires;
        return structuredClone(d);
      });
    } catch (e) {
      l.error("STORE WRITE FAILED BEFORE DISPATCH — refusing to act without an idempotency record", { rung: fire.id, hf: valuation.hf, error: errMsg(e) });
      await this.escalate(rec.account, [`store write failed before dispatch: ${errMsg(e)}`], 0, "store-failure");
      this.fatal(e);
      return { account: rec.account, valuation: "OK", hf: valuation.hf, fired: fire.id, dispatch: null, error: errMsg(e) };
    }

    l.warn("rung fired", { rung: fire.id, action: fire.action, hf: valuation.hf, episode: record.episode, key: record.key, crossed: step.crossed.map((r) => r.id), rearmedFirst: rearmedIds, debtUsdc: valuation.debtUsdc.toString(), collateralZec: valuation.collateralZec.toString(), zecUsd: valuation.zecUsd });
    await this.emit({ kind: "rung-fired", severity: fire.id === this.lastResortRung.id ? "critical" : "warn", account: rec.account, owner: rec.owner, rung: fire.id, action: fire.action, hf: valuation.hf, key: record.key, detail: { episode: record.episode } });

    let result: SolanaDispatchResult;
    try {
      result = await withDeadline(`dispatch ${record.key}`, this.d.config.dispatchDeadlineMs, handle.signal, () =>
        this.d.dispatcher.dispatch(
          {
            record,
            persistBeforeSend: this.preSend(record),
            onGrantRead: (g) => {
              void this.bookkeep(rec.account, { grant: { target: rec.account, selector: `rungs:${g.allowedRungs.toString(2)}`, active: g.live, allowCallback: true, expiry: g.expiry, checkedAt: this.now().toISOString() } }, l);
            },
            onPairRead: (p) => {
              void this.bookkeep(rec.account, { crossChain: this.pairRecord(p) }, l);
            },
            inFlightAgeS: this.bridgeInFlightAgeS(rec.account),
          },
          handle.signal
        )
      );
    } catch (e) {
      if (e instanceof AbortedError || handle.signal.aborted) throw e;
      if (e instanceof DeadlineError) {
        l.error("dispatch exceeded its deadline — left for the resume path", { error: errMsg(e) });
        handle.bump();
        return { account: rec.account, valuation: "OK", hf: valuation.hf, fired: fire.id, dispatch: null, error: errMsg(e) };
      }
      result = { status: "FAILED", error: errMsg(e) };
    }
    handle.bump();
    await this.recordResult(record, result, l, handle.signal);
    return { account: rec.account, valuation: "OK", hf: valuation.hf, fired: fire.id, dispatch: result };
  }

  /** A rung whose action CONFIRMED but did not clear it re-arms, bounded per rung (Base audit C-MED-2). */
  private reArmIneffective(rec: Rec, hf: number, l: Logger, ladder: readonly LadderRung[]): { ladder: LadderState; refires: Record<string, number>; rearmedIds: string[] } {
    const refires: Record<string, number> = { ...(rec.rungRefires ?? {}) };
    const rearmedIds: string[] = [];
    const inFlight = this.d.store.listDispatches({ account: rec.account }).some((d) => d.status === "PENDING" || d.status === "SENT");
    if (inFlight) return { ladder: rec.ladder, refires, rearmedIds };
    const fired = [...rec.ladder.fired];
    for (const rung of ladder) {
      if (!fired.includes(rung.id) || !(hf < rung.hf)) continue;
      const last = this.d.store
        .listDispatches({ account: rec.account })
        .filter((d) => d.rung === rung.id && d.episode === rec.episode)
        .sort((a, b) => b.seq - a.seq)[0];
      if (!last || last.status !== "CONFIRMED") continue;
      const n = refires[rung.id] ?? 0;
      if (n >= this.d.config.maxRungRefires) {
        if (rung.id === this.lastResortRung.id) {
          // never give up on the most severe rung while the account is below it
          l.warn("last-resort rung re-armed beyond the refire cap — the position is still below it", { rung: rung.id, hf });
        } else continue;
      }
      refires[rung.id] = n + 1;
      fired.splice(fired.indexOf(rung.id), 1);
      rearmedIds.push(rung.id);
      l.warn("rung re-armed: its confirmed action did not clear it", { rung: rung.id, hf, refires: refires[rung.id] });
    }
    return { ladder: { fired }, refires, rearmedIds };
  }

  /** The account record's view of the pair (A5.2). */
  private pairRecord(p: PairView): NonNullable<Rec["crossChain"]> {
    return { baseAccount: p.baseAccount, recipientOnBase: p.recipientOnBase, status: p.status, checkedAt: this.now().toISOString() };
  }

  /**
   * Age in seconds of the youngest Base burn still in flight for the account — a dispatch with `bridge` whose
   * stage is not "delivered" and whose status is SENT or CONFIRMED — or null. The dispatcher waits on it
   * inside the stall window and falls back to the single-chain path past it (`bridgeDecision`).
   *
   * Measured from `createdAt`, the moment the rung fired. It was `updatedAt` until the 2026-09-13 audit
   * (S-1): every tick re-enters a SENT record and rewrites `updatedAt`, so the age never grew, the stall
   * window never expired, and a bridge stuck behind an outage at Circle would have kept the account waiting
   * for ever instead of falling back to the keeper-funded sale — the one thing the window exists to do.
   */
  private bridgeInFlightAgeS(account: string): number | null {
    const nowMs = this.now().getTime();
    let youngest: number | null = null;
    for (const d of this.d.store.listDispatches({ account })) {
      if (!d.bridge || d.bridge.stage === "delivered" || (d.status !== "SENT" && d.status !== "CONFIRMED")) continue;
      const age = Math.max(0, Math.floor((nowMs - Date.parse(d.createdAt)) / 1000));
      if (youngest === null || age < youngest) youngest = age;
    }
    return youngest;
  }

  private preSend(rec: Disp): (info: { signature: string }) => Promise<void> {
    return async ({ signature }) => {
      await this.d.store.mutate((s) => {
        const d = s.dispatches.find((x) => x.key === rec.key);
        if (!d) throw new Error(`dispatch ${rec.key} vanished`);
        d.txHash = signature;
        d.status = "SENT";
        d.updatedAt = this.now().toISOString();
      });
    };
  }

  private async setStatus(rec: Disp, status: "SUPERSEDED" | "ABANDONED", error: string, l: Logger): Promise<void> {
    await this.d.store.mutate((s) => {
      const d = s.dispatches.find((x) => x.key === rec.key);
      if (!d) return;
      d.status = status;
      d.error = error;
      d.updatedAt = this.now().toISOString();
    });
    l.info(`dispatch ${status.toLowerCase()}`, { error });
  }

  private async recordResult(rec: Disp, result: SolanaDispatchResult, l: Logger, signal: AbortSignal): Promise<void> {
    void signal;
    const nowIso = this.now().toISOString();
    const attempts = rec.attempts + 1;
    const sig = "signature" in result ? result.signature : undefined;
    // A Base burn's hash is not a Solana signature: it lives in `bridge.burnTxHash` (the store checks `txHash`
    // against the Solana codec), and the dispatcher confirms a bridge record from there.
    const bridged = "bridge" in result && result.bridge ? result.bridge : undefined;
    const patch: Partial<Disp> = { attempts, updatedAt: nowIso, txHash: bridged ? rec.txHash : (sig ?? rec.txHash) };
    if (bridged) patch.bridge = bridged;
    let escalation: string | null = null;
    switch (result.status) {
      case "NOTIFIED":
      case "CONFIRMED":
      case "SENT":
      case "SUPERSEDED":
        patch.status = result.status;
        patch.error = "reason" in result ? result.reason : "note" in result ? result.note : undefined;
        break;
      case "LOGGED_ONLY":
      case "FAILED":
      case "REFUSED": {
        const msg = "error" in result ? result.error : result.reason;
        if (result.status === "REFUSED" && result.permanent) {
          patch.status = "REFUSED";
          patch.error = `permanent: ${msg}`;
          escalation = `keeper refused permanently: ${msg}`;
        } else if (result.status === "FAILED" && result.permanent) {
          // A failure re-trying cannot fix — today only Circle returning a message that is not our burn
          // (AUDIT-2026-09-13.md O-5). Abandoned on the spot rather than re-run until the attempt cap:
          // the error is the same every tick, and burying the one line a person must read under N copies
          // of itself is how it gets missed. The `permanent:` prefix is the same marker the resume path
          // already reads, so a record left in the store by a crash is abandoned rather than retried too.
          patch.status = "ABANDONED";
          patch.error = `permanent: ${msg}`;
          escalation = `dispatch abandoned — retrying cannot fix this: ${msg}`;
        } else if (attempts >= this.d.config.maxDispatchAttempts) {
          patch.status = "ABANDONED";
          patch.error = `after ${attempts} attempts: ${msg}`;
          escalation = `dispatch abandoned after ${attempts} attempts: ${msg}`;
        } else {
          patch.status = result.status;
          patch.error = msg;
        }
        break;
      }
    }
    await this.d.store.mutate((s) => {
      const d = s.dispatches.find((x) => x.key === rec.key);
      if (!d) throw new Error(`dispatch ${rec.key} vanished`);
      Object.assign(d, patch);
    });
    const level = result.status === "CONFIRMED" || result.status === "NOTIFIED" ? "info" : "warn";
    l[level](`dispatch ${result.status}`, { key: rec.key, rung: rec.rung, action: rec.action, attempts, signature: sig, detail: patch.error });
    await this.emit({ kind: "dispatch", severity: escalation ? "critical" : result.status === "CONFIRMED" ? "info" : "warn", account: rec.account, rung: rec.rung, action: rec.action, hf: rec.hf, status: patch.status, key: rec.key, txHash: sig, reasons: patch.error ? [patch.error] : undefined });
    if (escalation) await this.escalate(rec.account, [escalation], attempts, result.status === "REFUSED" ? "grant-misconfigured" : "escalation");
  }

  private async bookkeep(account: string, patch: Partial<Omit<Rec, "account" | "owner">>, l: Logger): Promise<void> {
    try {
      await this.d.store.updateAccount(account, patch);
    } catch (e) {
      if (this.fatal(e)) throw e;
      l.error("bookkeeping write failed", { error: errMsg(e) });
    }
  }
}
