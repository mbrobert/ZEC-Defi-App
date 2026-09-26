/**
 * The perps keeper's per-tick work — the third chain's twin of `monitors/healthMonitor.ts` and
 * `solana/monitor.ts`, same order, same rules (design §5, "monitor"):
 *   1. resume — dispatches a previous process left PENDING / SENT / FAILED / REFUSED / LOGGED_ONLY are
 *      finished FIRST, bounded per tick, each inside its own deadline;
 *   2. discover — new `AccountCreated` logs from the factory since the persisted cursor (the Base pattern);
 *   3. evaluate — every registered account, bounded concurrency, rotating by the store's persisted tick;
 *   4. per account: valuation (the precompiles at one block, the venue's entry, the independent mark —
 *      fail-closed) → the ladder THIS account runs on, derived from its recorded entry (D9) →
 *      ladder step with hysteresis → ONE atomic store write (episode, dispatch record, ladder state) →
 *      dispatch → bookkeeping; every rung and escalation goes through the notifier;
 *   5. prune terminal dispatch records.
 * Time comes from the chain (the head's timestamp), never the host clock.
 *
 * What is new on this chain: the number the ladder runs on is the short's EQUIVALENT health factor
 * (`1 / (1 − d)`, design §4), and a CONFIRMED action may not have landed on HyperCore (an IOC that did not
 * fill) — the dispatcher says so on the record, and the confirmed-but-ineffective re-arm below is what turns
 * that into a re-plan on the next tick, bounded per rung.
 */
import { HF_LADDER, MAX_SHORT_DISTANCE_BPS, MIN_LADDER_ENTRY_HF, perpLadderFor, perpPxDecimals, type HfRungId } from "@zyo/shared";
import { stepLadder, validateLadder, type LadderRung, type LadderState } from "../engine/ladder.js";
import type { Logger } from "../log.js";
import { eventNow, type KeeperEvent, type Notifier } from "../notify/notifier.js";
import { AbortedError, DeadlineError, withDeadline } from "../services/deadline.js";
import type { AccountDiscovery } from "../services/discovery.js";
import { DuplicateIdError, isFatalStoreError, KeeperStore, type AccountRecord, type DispatchRecord } from "../store/keeperStore.js";
import type { Address, Hex } from "../types/evm.js";
import type { TickHandle } from "../watchdog.js";
import type { PerpsDispatchIntent, PerpsDispatchResult, PerpsDispatcher } from "./dispatcher.js";
import type { PerpsEntry, PerpsReader } from "./reader.js";
import { evaluatePerps, type PerpsValuation, type PerpsValuationParams } from "./valuation.js";

type Rec = AccountRecord<Address>;
type Disp = DispatchRecord<Address, Hex>;

export interface PerpsMonitorConfig {
  concurrency: number;
  unknownEscalationStreak: number;
  maxDispatchAttempts: number;
  maxResumePerTick: number;
  dispatchDeadlineMs: number;
  maxRungRefires: number;
  discoveryFromBlock: bigint;
}

export interface PerpsMonitorDeps {
  reader: PerpsReader;
  discovery: AccountDiscovery;
  store: KeeperStore<Address, Hex>;
  /** The floor's ladder — what an account with no usable entry record runs on (warn only reaches it: `protect` needs the record). */
  floorLadder: readonly LadderRung[];
  dispatcher: PerpsDispatcher;
  log: Logger;
  config: PerpsMonitorConfig;
  valuationParams: PerpsValuationParams;
  now?: () => Date;
  notifier?: Notifier;
  onEscalate?: (e: { account: string; reasons: string[]; streak: number }) => void;
  onFatal?: (e: Error) => void;
}

export interface PerpsAccountOutcome {
  account: Address;
  valuation: PerpsValuation["kind"] | "READ_FAILED";
  hf: number | null;
  distanceBps: number | null;
  fired: string | null;
  dispatch: PerpsDispatchResult | null;
  error?: string;
}

export interface PerpsTickReport {
  head: bigint | null;
  discovered: number;
  resumed: number;
  evaluated: number;
  outcomes: PerpsAccountOutcome[];
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
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  if (signal.aborted && i < items.length) throw new AbortedError(`tick (${items.length - i} of ${items.length} accounts not evaluated)`, signal.reason);
  return out;
}

/** The shared rung's action name for a rung id (the same words the Base and Solana keepers record). */
const ACTION_BY_ID: Readonly<Record<HfRungId, string>> = Object.fromEntries(HF_LADDER.map((r) => [r.id, r.action])) as Record<HfRungId, string>;

/**
 * The short's ladder for a recorded entry distance, in the shape the ladder engine consumes: each rung's
 * equivalent HF from `perpLadderFor` (the venue's `PerpHealthLib.ladderFor`, value for value).
 */
export function perpLadderRungs(entryDistanceBps: number): LadderRung[] {
  return perpLadderFor(entryDistanceBps).map((r) => ({ id: r.id, hf: r.hfBps / 10_000, disarmHf: r.disarmHfBps / 10_000, severity: r.severity, action: ACTION_BY_ID[r.id] }));
}

export class PerpsMonitor {
  private readonly now: () => Date;

  constructor(private readonly d: PerpsMonitorDeps) {
    validateLadder(d.floorLadder);
    if (!(d.config.concurrency >= 1)) throw new RangeError("concurrency must be ≥ 1");
    this.now = d.now ?? (() => new Date());
  }

  private get lastResortRung(): LadderRung {
    return [...this.d.floorLadder].sort((a, b) => a.severity - b.severity)[this.d.floorLadder.length - 1]!;
  }

  /**
   * The ladder THIS account runs on: derived from the entry the venue recorded at the owner's last action
   * (`entryOf(account).distanceBps`, D9) with the same integer rule the venue applies (`PerpHealthLib.ladderFor`
   * = shared `ladderBpsFor` on the equivalent HF), so the rung the keeper names is the rung `protect` expects;
   * the floor's ladder when there is no usable record, and the record says so (`entryHf: null`).
   */
  private resolveLadder(entry: PerpsEntry | null): { ladder: readonly LadderRung[]; entryHf: number | null } {
    if (!entry || entry.distanceBps <= 0 || entry.distanceBps > MAX_SHORT_DISTANCE_BPS || entry.hfBps < MIN_LADDER_ENTRY_HF * 10_000) return { ladder: this.d.floorLadder, entryHf: null };
    try {
      const ladder = perpLadderRungs(entry.distanceBps);
      validateLadder(ladder);
      return { ladder, entryHf: entry.hfBps / 10_000 };
    } catch {
      return { ladder: this.d.floorLadder, entryHf: null };
    }
  }

  private async emit(e: Omit<KeeperEvent, "at">): Promise<void> {
    if (!this.d.notifier) return;
    try {
      await this.d.notifier.deliver(eventNow({ ...e, detail: { chain: "hyperevm", ...(e.detail ?? {}) } }, this.now));
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

  async tick(handle: TickHandle): Promise<PerpsTickReport> {
    const log = this.d.log;
    const report: PerpsTickReport = { head: null, discovered: 0, resumed: 0, evaluated: 0, outcomes: [], aborted: false };
    try {
      report.resumed = await this.resumePending(handle, log);
      handle.bump();

      let head: { number: bigint; timestamp: bigint };
      try {
        head = await this.d.reader.head(handle.signal);
      } catch (e) {
        if (e instanceof AbortedError || handle.signal.aborted) throw e;
        log.error("head read failed — no evaluation this tick", { error: errMsg(e) });
        return report;
      }
      report.head = head.number;
      const drift = Math.abs(Number(head.timestamp) - Math.floor(this.now().getTime() / 1000));
      if (drift > 300) log.warn("host clock drifts from the chain", { driftS: drift });
      handle.bump();

      try {
        report.discovered = await this.discover(head.number, handle, log);
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
            return await this.evaluateOne(rec, head, handle, log);
          } catch (e) {
            if (e instanceof AbortedError || handle.signal.aborted) throw e;
            if (this.fatal(e)) throw e;
            log.error("account evaluation failed", { account: rec.account, error: errMsg(e) });
            return { account: rec.account, valuation: "READ_FAILED" as const, hf: null, distanceBps: null, fired: null, dispatch: null, error: errMsg(e) };
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
      const acct = this.d.store.getAccount(rec.account);
      if (acct && acct.episode !== rec.episode) {
        await this.setStatus(rec, "SUPERSEDED", "episode ended before this record was resumed", l);
        continue;
      }
      if (rec.status !== "SENT") {
        if (rec.error?.includes("permanent:")) {
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
      let result: PerpsDispatchResult;
      try {
        result = await withDeadline(`resume ${rec.key}`, this.d.config.dispatchDeadlineMs, handle.signal, () =>
          rec.status === "SENT" ? this.d.dispatcher.confirm(rec, handle.signal) : this.d.dispatcher.dispatch(this.dispatchIntent(rec, l), handle.signal)
        );
      } catch (e) {
        if (e instanceof AbortedError || handle.signal.aborted) throw e;
        if (e instanceof DeadlineError) {
          l.error("resumed dispatch exceeded its deadline — moving on", { error: errMsg(e) });
          continue;
        }
        result = { status: "FAILED", error: errMsg(e) };
      }
      await this.recordResult(rec, result, l);
      n++;
      handle.bump();
    }
    return n;
  }

  // ---- 2. discover -----------------------------------------------------------

  private async discover(head: bigint, handle: TickHandle, log: Logger): Promise<number> {
    const cursor = this.d.store.cursor;
    const from = cursor === null ? this.d.config.discoveryFromBlock : cursor + 1n;
    if (from > head) return 0;
    let registered = 0;
    await this.d.discovery.scan(
      from,
      head,
      async (found, lastBlock) => {
        for (const f of found) {
          try {
            await this.d.store.registerAccount({ account: f.account, owner: f.owner, discoveredAtBlock: f.blockNumber }, this.now());
            registered += 1;
            log.info("account discovered", { account: f.account, owner: f.owner, block: f.blockNumber.toString() });
          } catch (e) {
            if (!(e instanceof DuplicateIdError)) throw e;
          }
        }
        await this.d.store.setCursor(lastBlock);
        handle.bump();
      },
      handle.signal
    );
    return registered;
  }

  // ---- 4/5. evaluate one account -------------------------------------------

  private async evaluateOne(rec: Rec, head: { number: bigint; timestamp: bigint }, handle: TickHandle, log: Logger): Promise<PerpsAccountOutcome> {
    const l = log.child({ account: rec.account });
    const nowIso = this.now().toISOString();
    let valuation: PerpsValuation;
    let entry: PerpsEntry | null = null;
    try {
      const snap = await this.d.reader.snapshot(rec.account, head, handle.signal);
      entry = snap.entry;
      valuation = evaluatePerps(snap, this.d.valuationParams);
    } catch (e) {
      if (e instanceof AbortedError || handle.signal.aborted) throw e;
      valuation = { kind: "UNKNOWN", reasons: [`read failed: ${errMsg(e)}`] };
    }
    handle.bump();

    if (valuation.kind === "UNKNOWN") {
      const streak = rec.unknownStreak + 1;
      l.warn("valuation UNKNOWN — fail closed, no action", { reasons: valuation.reasons, streak });
      await this.bookkeep(rec.account, { lastValuation: "UNKNOWN", unknownStreak: streak, lastEvaluatedAt: nowIso, lastReasons: valuation.reasons }, l);
      if (streak >= this.d.config.unknownEscalationStreak) await this.escalate(rec.account, valuation.reasons, streak);
      return { account: rec.account, valuation: "UNKNOWN", hf: null, distanceBps: null, fired: null, dispatch: null };
    }

    // A short with no position is "no debt": everything re-arms. The store's kind for that is NO_DEBT.
    const storeKind = valuation.kind === "OK" ? "OK" : "NO_DEBT";
    const hf = valuation.kind === "OK" ? valuation.hf : Number.POSITIVE_INFINITY;
    const distanceBps = valuation.kind === "OK" ? valuation.distanceBps : null;
    const { ladder, entryHf } = this.resolveLadder(valuation.kind === "OK" ? valuation.entry : entry);
    const { ladder: startState, refires, rearmedIds } = await this.reArmIneffective(rec, hf, l, ladder);
    const step = stepLadder(ladder, startState, hf);

    if (!step.fire) {
      const patch: Partial<Rec> = { ladder: step.next, lastHf: Number.isFinite(hf) ? hf : null, lastValuation: storeKind, lastEvaluatedAt: nowIso, unknownStreak: 0, rungRefires: refires, entryHf };
      if (step.episodeEnded) patch.episode = null;
      if (step.rearmed.length) l.info("rungs re-armed", { rungs: step.rearmed.map((r) => r.id), hf });
      if (step.episodeEnded) l.info("episode ended — the short is clear of every rung", { episode: rec.episode });
      await this.bookkeep(rec.account, patch, l);
      return { account: rec.account, valuation: valuation.kind, hf: Number.isFinite(hf) ? hf : null, distanceBps, fired: null, dispatch: null };
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
      return { account: rec.account, valuation: "OK", hf: valuation.hf, distanceBps, fired: fire.id, dispatch: null, error: errMsg(e) };
    }

    const markUsd = Number(valuation.markRaw) / 10 ** perpPxDecimals(valuation.szDecimals);
    const distancePct = (valuation.distanceBps / 100).toFixed(2);
    l.warn("rung fired", { rung: fire.id, action: fire.action, hf: valuation.hf, distanceBps: valuation.distanceBps, episode: record.episode, key: record.key, crossed: step.crossed.map((r) => r.id), rearmedFirst: rearmedIds, size: valuation.size.toString(), accountValueE6: valuation.accountValueE6.toString(), spotE6: valuation.spotE6.toString(), markUsd });
    await this.emit({
      kind: "rung-fired",
      severity: fire.id === this.lastResortRung.id ? "critical" : "warn",
      account: rec.account,
      owner: rec.owner,
      rung: fire.id,
      action: fire.action,
      hf: valuation.hf,
      key: record.key,
      detail: { episode: record.episode, distancePct, markUsd, copy: `your short is ${distancePct} % from liquidation; ZEC is at $${markUsd.toFixed(2)}` },
    });

    let result: PerpsDispatchResult;
    try {
      result = await withDeadline(`dispatch ${record.key}`, this.d.config.dispatchDeadlineMs, handle.signal, () =>
        this.d.dispatcher.dispatch(this.dispatchIntent(record, l), handle.signal)
      );
    } catch (e) {
      if (e instanceof AbortedError || handle.signal.aborted) throw e;
      if (e instanceof DeadlineError) {
        l.error("dispatch exceeded its deadline — left for the resume path", { error: errMsg(e) });
        handle.bump();
        return { account: rec.account, valuation: "OK", hf: valuation.hf, distanceBps, fired: fire.id, dispatch: null, error: errMsg(e) };
      }
      result = { status: "FAILED", error: errMsg(e) };
    }
    handle.bump();
    await this.recordResult(record, result, l);
    return { account: rec.account, valuation: "OK", hf: valuation.hf, distanceBps, fired: fire.id, dispatch: result };
  }

  /**
   * A rung whose action CONFIRMED but did not clear it re-arms, bounded per rung (Base audit C-MED-2). On
   * this chain that is the ordinary case for an IOC the book did not fill (design §5): the dispatcher
   * confirms it and says so, and this is what re-plans it. When the cap is reached on a rung that is not the
   * last resort, the owner is told once; the last-resort rung never gives up.
   */
  private async reArmIneffective(rec: Rec, hf: number, l: Logger, ladder: readonly LadderRung[]): Promise<{ ladder: LadderState; refires: Record<string, number>; rearmedIds: string[] }> {
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
          l.warn("last-resort rung re-armed beyond the refire cap — the position is still below it", { rung: rung.id, hf });
        } else {
          if (n === this.d.config.maxRungRefires) {
            refires[rung.id] = n + 1; // told once
            await this.escalate(rec.account, [`rung ${rung.id} re-fired ${n} times without clearing (${last.error ?? "no note"}) — it stays fired; only the owner can change the position or the grant`], n);
          }
          continue;
        }
      }
      refires[rung.id] = n + 1;
      fired.splice(fired.indexOf(rung.id), 1);
      rearmedIds.push(rung.id);
      l.warn("rung re-armed: its confirmed action did not clear it", { rung: rung.id, hf, refires: refires[rung.id], lastNote: last.error });
    }
    return { ladder: { fired }, refires, rearmedIds };
  }

  /** Everything a dispatch is handed, built ONE way for the fire path and the resume path alike (AUDIT-2026-09-25 CC-2's rule). */
  private dispatchIntent(record: Disp, l: Logger): PerpsDispatchIntent {
    return {
      record,
      persistBeforeSend: async ({ nonce, perp }) => {
        await this.d.store.mutate((s) => {
          const d = s.dispatches.find((x) => x.key === record.key);
          if (!d) throw new Error(`dispatch ${record.key} vanished`);
          d.sentNonce = nonce;
          d.perp = perp;
          d.updatedAt = this.now().toISOString();
        });
      },
      onGrantRead: (g) => {
        void this.bookkeep(record.account, { grant: { target: this.d.reader.venue, selector: `protect rungs:${g.allowedRungs.toString(2)}${g.live ? "" : ` (${g.why})`}`, active: g.live, allowCallback: true, expiry: g.expiry, checkedAt: this.now().toISOString() } }, l);
      },
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

  private async recordResult(rec: Disp, result: PerpsDispatchResult, l: Logger): Promise<void> {
    const nowIso = this.now().toISOString();
    const attempts = rec.attempts + 1;
    const hash = "txHash" in result ? result.txHash : undefined;
    const patch: Partial<Disp> = { attempts, updatedAt: nowIso, txHash: hash ?? rec.txHash };
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
    l[level](`dispatch ${result.status}`, { key: rec.key, rung: rec.rung, action: rec.action, attempts, txHash: hash, detail: patch.error });
    await this.emit({ kind: "dispatch", severity: escalation ? "critical" : result.status === "CONFIRMED" ? "info" : "warn", account: rec.account, rung: rec.rung, action: rec.action, hf: rec.hf, status: patch.status, key: rec.key, txHash: hash, reasons: patch.error ? [patch.error] : undefined });
    if (escalation) await this.escalate(rec.account, [escalation], attempts, result.status === "REFUSED" ? "grant-misconfigured" : "escalation");
  }

  private async bookkeep(account: Address, patch: Partial<Omit<Rec, "account" | "owner">>, l: Logger): Promise<void> {
    try {
      await this.d.store.updateAccount(account, patch);
    } catch (e) {
      if (this.fatal(e)) throw e;
      l.error("bookkeeping write failed", { error: errMsg(e) });
    }
  }
}
