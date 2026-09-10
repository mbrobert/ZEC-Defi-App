import type { Dispatcher, DispatchResult } from "../dispatch/types.js";
import { stepLadder, validateLadder, type LadderRung, type LadderState } from "../engine/ladder.js";
import { UNTRACKED_COLLATERAL, type Valuation } from "../engine/valuation.js";
import type { Logger } from "../log.js";
import { eventNow, type KeeperEvent, type Notifier } from "../notify/notifier.js";
import type { AccountValuation } from "../engine/venueValuation.js";
import { readTickContexts, valueAccount, type TickContexts } from "../services/accountValuer.js";
import type { AaveReader } from "../services/chain.js";
import type { AccountDiscovery } from "../services/discovery.js";
import { AbortedError, DeadlineError, mapBounded, withDeadline } from "../services/deadline.js";
import type { VenueReader } from "../services/venues.js";
import { DuplicateIdError, isFatalStoreError, KeeperStore, type AccountRecord, type DispatchRecord } from "../store/keeperStore.js";
import type { Address } from "../types/evm.js";
import type { TickHandle } from "../watchdog.js";

/**
 * The keeper's per-tick work, in order:
 *   1. resume — dispatches left PENDING/SENT/FAILED/REFUSED by a previous
 *      process are finished FIRST, with their persisted key, but BOUNDED: each
 *      record gets its own deadline, only `maxResumePerTick` are touched, and
 *      the list rotates. One record that never returns used to be picked up
 *      first on every subsequent tick and wedge the WHOLE FLEET for ever
 *      (audit C-HIGH-3); a record that stalls `maxRecordStalls` times is
 *      quarantined and escalated instead of retried at the head of every tick;
 *   2. discover — new `AccountCreated` logs since the persisted cursor.
 *      Isolated: a failed head read or a discovery error no longer skips the
 *      evaluation of every account (audit C-LOW-4);
 *   3. context — per-asset LT / prices, and the registry's venues per asset
 *      (current and previous), read once for the tick;
 *   4. evaluate — every registered account, bounded concurrency, rotating by a
 *      PERSISTED tick counter (rotating by block number was a fixed
 *      permutation at the default poll — audit C-LOW-3), each account isolated;
 *   5. per account: valuation → ladder step → (episode + dispatch record +
 *      ladder state persisted in ONE atomic write) → dispatch → bookkeeping;
 *   6. prune terminal dispatch records so the store cannot grow for ever.
 *
 * Every rung and every escalation is delivered through the notifier: a
 * protection nobody can see is not a protection (audit C-MED-7).
 *
 * Time comes from the CHAIN HEAD, not the host clock (audit C-LOW-1).
 */

export interface MonitorConfig {
  concurrency: number;
  priceMaxAgeS: number;
  /** Per-feed staleness bounds, from each feed's own measured cadence. */
  priceMaxAgeBySymbol?: ReadonlyMap<string, number>;
  oracleDeviationBps: number;
  hfToleranceBps: number;
  discoveryFromBlock: bigint;
  /** Consecutive UNKNOWN valuations before the escalation hook fires. */
  unknownEscalationStreak: number;
  /** Attempts (same key) before a FAILED/REFUSED dispatch is ABANDONED and escalated. */
  maxDispatchAttempts: number;
  /** Records resumed per tick. The rest wait for the next one. */
  maxResumePerTick: number;
  /**
   * Wall clock for ONE dispatch — fresh or resumed. Beyond it the tick moves
   * on to the rest of the fleet and the record is counted as stalled.
   */
  dispatchDeadlineMs: number;
  /** Stalls (deadline hits) before a record is quarantined. */
  maxRecordStalls: number;
  /** Times a rung may be re-armed because its action did not clear it. */
  maxRungRefires: number;
  /** Host-vs-chain clock difference (seconds) worth an escalation. */
  clockDriftMaxS: number;
}

export interface MonitorDeps {
  reader: AaveReader;
  /**
   * Venue-aware reader over the registry (audit wave 2, M-HIGH-2). With it every account is
   * valued through the Aave pool AND every venue the registry names for its collateral, and the
   * ladder runs on the worst of them (`services/accountValuer.ts`). Without it — no router
   * configured — only the Aave pool is read, as before.
   */
  venues?: VenueReader | null;
  discovery: AccountDiscovery;
  store: KeeperStore;
  ladder: readonly LadderRung[];
  dispatcher: Dispatcher;
  log: Logger;
  config: MonitorConfig;
  now?: () => Date;
  notifier?: Notifier;
  /** Human escalation hook (webhook/pager). Never gates any action. */
  onEscalate?: (e: { account: Address; reasons: string[]; streak: number }) => void;
  /** Called when the store can no longer be trusted: the process must stop. */
  onFatal?: (e: Error) => void;
}

export interface AccountOutcome {
  account: Address;
  valuation: Valuation["kind"] | "READ_FAILED";
  hf: number | null;
  fired: string | null;
  dispatch: DispatchResult | null;
  error?: string;
}

export interface TickReport {
  blockNumber: bigint | null;
  discovered: number;
  resumed: number;
  evaluated: number;
  outcomes: AccountOutcome[];
  aborted: boolean;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
}

export class HealthMonitor {
  private readonly now: () => Date;
  private tickCount = 0;
  private lastHead: bigint | null = null;
  private headFailures = 0;
  /** Dispatch keys this tick already acted on — never re-armed in the same pass. */
  private handledThisTick = new Set<string>();
  /** Accounts already told about a live venue/feed price disagreement; cleared on a tick that reads none. */
  private readonly disagreementTold = new Set<string>();

  constructor(private readonly d: MonitorDeps) {
    validateLadder(d.ladder);
    if (!(d.config.concurrency >= 1)) throw new RangeError("concurrency must be ≥ 1");
    this.now = d.now ?? (() => new Date());
  }

  /** Most severe rung in the ladder — the one that must never be given up on. */
  private get lastResortRung(): LadderRung {
    return [...this.d.ladder].sort((a, b) => a.severity - b.severity)[this.d.ladder.length - 1];
  }

  private async emit(e: Omit<KeeperEvent, "at">): Promise<void> {
    if (!this.d.notifier) return;
    try {
      await this.d.notifier.deliver(eventNow(e, this.now));
    } catch {
      // MultiNotifier already logged it at error. Delivery must never break a tick.
    }
  }

  /**
   * RISKS.md §8 residual (b), policy set 2026-09-10. A venue whose oracle disagrees with the keeper's
   * feed is valued at the PESSIMISTIC health (so the ladder below still runs) and the owner is told
   * once per episode, at warn level; every tick it persists is logged. Nothing here gates an action.
   */
  private async noteDisagreements(account: Address, av: AccountValuation, l: Logger): Promise<void> {
    const key = account.toLowerCase();
    if (av.oracleDisagreements.length === 0) {
      this.disagreementTold.delete(key);
      return;
    }
    const reasons = av.oracleDisagreements.flatMap((d) => d.disagreement.reasons);
    l.warn("venue/feed price disagreement — protecting at the pessimistic health; a withdrawal would be refused", { reasons });
    if (this.disagreementTold.has(key)) return;
    this.disagreementTold.add(key);
    await this.emit({ kind: "oracle-disagreement", severity: "warn", account, reasons, detail: { venues: av.oracleDisagreements.map((d) => d.venue) } });
  }

  private async escalate(account: Address, reasons: string[], streak: number, kind: KeeperEvent["kind"] = "escalation"): Promise<void> {
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

  async tick(handle: TickHandle): Promise<TickReport> {
    const { signal } = handle;
    const log = this.d.log.child({ tick: ++this.tickCount });
    this.handledThisTick.clear();
    const report: TickReport = { blockNumber: null, discovered: 0, resumed: 0, evaluated: 0, outcomes: [], aborted: false };

    try {
      report.resumed = await this.resumePending(handle, log);

      // ---- head: isolated. A failed eth_blockNumber must not cost the tick.
      let head = this.lastHead ?? 0n;
      let chainNowS = BigInt(Math.floor(this.now().getTime() / 1000));
      try {
        const h = await this.d.reader.head(signal);
        head = h.number;
        chainNowS = h.timestamp;
        this.lastHead = head;
        this.headFailures = 0;
        const driftS = Math.abs(Math.floor(this.now().getTime() / 1000) - Number(chainNowS));
        if (driftS > this.d.config.clockDriftMaxS) {
          log.warn("host clock differs from chain time", { driftS, chainNowS: chainNowS.toString() });
        }
      } catch (e) {
        if (signal.aborted || e instanceof AbortedError) throw e;
        this.headFailures += 1;
        log.error("head read failed — evaluating against the last known head", {
          error: errMsg(e),
          lastHead: this.lastHead?.toString() ?? null,
          consecutive: this.headFailures,
        });
        if (this.headFailures >= 3) {
          await this.emit({
            kind: "escalation",
            severity: "critical",
            reasons: [`chain head unreadable ${this.headFailures} ticks running: ${errMsg(e)}`],
          });
        }
      }
      handle.bump();
      report.blockNumber = head === 0n ? null : head;

      // ---- discovery: isolated too.
      if (head > 0n) {
        try {
          report.discovered = await this.discover(head, handle, log);
        } catch (e) {
          if (signal.aborted || e instanceof AbortedError) throw e;
          if (this.fatal(e)) throw e;
          log.error("discovery failed — evaluating the accounts already known", { error: errMsg(e) });
        }
      }

      const contexts = await readTickContexts({ reader: this.d.reader, venues: this.d.venues ?? null }, signal);
      handle.bump();
      for (const [sym, r] of contexts.reserves) if (!r.ok) log.warn("reserve context unreadable", { reserve: sym, reason: r.reason });
      if (contexts.venueError !== null) log.error("venue context unreadable — every account is UNKNOWN this tick", { error: contexts.venueError });
      if (contexts.venues) {
        for (const u of contexts.venues.unreadableAssets) log.warn("registry unreadable for an asset", { asset: u.symbol, reason: u.reason });
        for (const v of contexts.venues.venues) if (v.problems.length) log.warn("venue context problems", { venue: v.venue, kind: v.kind, problems: v.problems });
      }

      const accounts = this.d.store.listAccounts();
      let seq = this.tickCount;
      try {
        seq = await this.d.store.nextTick();
      } catch (e) {
        if (this.fatal(e)) throw e;
      }
      const rotated = rotate(accounts, BigInt(seq));
      const results = await mapBounded(
        rotated,
        this.d.config.concurrency,
        (rec) => this.evaluateOne(rec, contexts, head, chainNowS, handle, log),
        signal
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "fulfilled") {
          report.outcomes.push(r.value);
          report.evaluated += 1;
        } else {
          report.outcomes.push({
            account: rotated[i].account,
            valuation: "READ_FAILED",
            hf: null,
            fired: null,
            dispatch: null,
            error: errMsg(r.reason),
          });
          if (r.reason instanceof AbortedError) report.aborted = true;
        }
      }

      if (!signal.aborted) {
        try {
          const pruned = await this.d.store.prune();
          if (pruned) log.info("pruned terminal dispatch records", { pruned });
        } catch (e) {
          if (this.fatal(e)) throw e;
          log.warn("prune failed", { error: errMsg(e) });
        }
      }
    } catch (e) {
      if (signal.aborted || e instanceof AbortedError) {
        report.aborted = true;
        log.warn("tick aborted", { error: errMsg(e) });
      } else if (isFatalStoreError(e)) {
        report.aborted = true;
      } else {
        log.error("tick failed", { error: errMsg(e) });
      }
    } finally {
      handle.end();
    }
    log.info("tick complete", {
      block: report.blockNumber?.toString() ?? null,
      discovered: report.discovered,
      resumed: report.resumed,
      evaluated: report.evaluated,
      aborted: report.aborted,
    });
    return report;
  }

  // ---- 1. resume ------------------------------------------------------------

  /**
   * Finish what a previous process (or a previous tick) left unfinished.
   *   PENDING / SENT        → always resumed, same key.
   *   FAILED / REFUSED      → retried with the same key while the account is
   *                           still in that episode and attempts < max;
   *                           otherwise ABANDONED (+ escalation) — EXCEPT at
   *                           the most severe rung, which is never abandoned
   *                           for retry exhaustion while the account is still
   *                           below it (audit C-MED-4: the protection of last
   *                           resort used to give up permanently at HF ≈ 1).
   * Every resume is bounded by its own deadline and the whole pass is bounded
   * by `maxResumePerTick`, rotating so the head of the list cannot monopolise
   * every tick.
   */
  private async resumePending(handle: TickHandle, log: Logger): Promise<number> {
    let n = 0;
    const candidates = [
      ...this.d.store.listDispatches({ status: "PENDING" }),
      ...this.d.store.listDispatches({ status: "SENT" }),
      ...this.d.store.listDispatches({ status: "FAILED" }),
      ...this.d.store.listDispatches({ status: "REFUSED" }),
      // A warning only the keeper's own log/store took is not delivered: retry it like a failure
      // until a person-facing channel accepts it or the attempts run out (audit wave 2, N-MED-1).
      ...this.d.store.listDispatches({ status: "LOGGED_ONLY" }),
    ].sort((a, b) => a.seq - b.seq);
    const budget = Math.max(1, this.d.config.maxResumePerTick);
    const slice = rotate(candidates, BigInt(this.tickCount)).slice(0, budget);
    if (candidates.length > slice.length) {
      log.info("resume budget reached — the rest wait for the next tick", { pending: candidates.length, resuming: slice.length });
    }

    for (const rec of slice) {
      if (handle.signal.aborted) break;
      const l = log.child({ account: rec.account, key: rec.key, action: rec.action, status: rec.status });
      const isLastResort = rec.rung === this.lastResortRung.id;
      if (rec.status === "FAILED" || rec.status === "REFUSED" || rec.status === "LOGGED_ONLY") {
        const acct = this.d.store.getAccount(rec.account);
        if (!acct || acct.episode !== rec.episode) {
          // Episode over: nothing left to protect under this key.
          await this.setStatus(rec, "SUPERSEDED", "episode ended before retry", l);
          continue;
        }
        if (rec.error?.includes("permanent:")) {
          // A refusal only the user can clear: retrying is noise.
          await this.setStatus(rec, "ABANDONED", rec.error, l);
          await this.escalate(rec.account, [`dispatch ${rec.key} needs the owner: ${rec.error}`], rec.attempts, "grant-misconfigured");
          continue;
        }
        if (rec.attempts >= this.d.config.maxDispatchAttempts) {
          if (!isLastResort) {
            await this.setStatus(rec, "ABANDONED", `gave up after ${rec.attempts} attempts`, l);
            l.error("dispatch ABANDONED — human intervention required", { attempts: rec.attempts, lastError: rec.error });
            await this.escalate(rec.account, [`dispatch ${rec.key} abandoned: ${rec.error ?? "?"}`], rec.attempts);
            continue;
          }
          // Most severe rung: keep trying (with a wider band each attempt) and
          // escalate every time, for as long as the account is below it.
          l.error("LAST-RESORT rung still failing — retrying, not abandoning", { attempts: rec.attempts, lastError: rec.error });
          await this.escalate(
            rec.account,
            [`emergency dispatch ${rec.key} has failed ${rec.attempts} times: ${rec.error ?? "?"} — still retrying`],
            rec.attempts
          );
        }
        if (isLastResort && rec.attempts === 1) {
          // Escalate on the FIRST failure of the last resort, not the fifth.
          await this.escalate(rec.account, [`emergency dispatch ${rec.key} failed: ${rec.error ?? "?"}`], rec.attempts);
        }
      }
      l.warn("resuming dispatch with its persisted key", { attempt: rec.attempts + 1 });
      let result: DispatchResult;
      try {
        result = await withDeadline(`resume ${rec.key}`, this.d.config.dispatchDeadlineMs, handle.signal, () =>
          rec.status === "SENT" && rec.txHash
            ? this.d.dispatcher.confirm(rec, handle.signal)
            : this.d.dispatcher.dispatch({ record: rec, valuation: null, persistBeforeSend: this.preSend(rec) }, handle.signal)
        );
      } catch (e) {
        if (e instanceof DeadlineError) {
          await this.quarantineOrCount(rec, l);
          n += 1;
          handle.bump();
          continue;
        }
        result = { status: "FAILED", error: errMsg(e) };
      }
      handle.bump();
      await this.recordResult(rec, result, l, handle.signal);
      n += 1;
    }
    return n;
  }

  /**
   * A record whose dispatch did not return inside its own deadline. Count it;
   * at the cap, quarantine it and re-arm its rung so the account is protected
   * under a FRESH key instead of being held hostage by a wedged one.
   */
  private async quarantineOrCount(rec: DispatchRecord, l: Logger): Promise<void> {
    const stalls = (rec.stalls ?? 0) + 1;
    if (stalls < this.d.config.maxRecordStalls) {
      l.error("resumed dispatch exceeded its deadline — moving on to the rest of the fleet", { stalls });
      try {
        await this.d.store.updateDispatch(rec.key, { stalls }, this.now());
      } catch (e) {
        if (!this.fatal(e)) l.error("bookkeeping write failed", { error: errMsg(e) });
      }
      await this.emit({
        kind: "escalation",
        severity: "warn",
        account: rec.account,
        key: rec.key,
        reasons: [`dispatch ${rec.key} stalled (${stalls}/${this.d.config.maxRecordStalls})`],
      });
      return;
    }
    l.error("QUARANTINING a dispatch that has stalled repeatedly — its rung is re-armed for a fresh attempt", { stalls });
    try {
      await this.d.store.updateDispatch(rec.key, { status: "ABANDONED", stalls, error: `quarantined after ${stalls} stalls` }, this.now());
      await this.d.store.mutate((s) => {
        const a = s.accounts.find((x) => x.account === rec.account);
        if (!a) return;
        a.ladder = { fired: a.ladder.fired.filter((id) => id !== rec.rung) };
      });
    } catch (e) {
      if (!this.fatal(e)) l.error("bookkeeping write failed", { error: errMsg(e) });
    }
    await this.escalate(rec.account, [`dispatch ${rec.key} quarantined after ${stalls} stalls — rung ${rec.rung} re-armed`], stalls);
  }

  private preSend(rec: DispatchRecord): (info: { nonce?: number; closeIds: bigint[] }) => Promise<void> {
    return async (info) => {
      await this.d.store.updateDispatch(
        rec.key,
        { sentNonce: info.nonce, closeIds: info.closeIds.map(String) },
        this.now()
      );
    };
  }

  private async setStatus(rec: DispatchRecord, status: "SUPERSEDED" | "ABANDONED", error: string, l: Logger): Promise<void> {
    try {
      await this.d.store.updateDispatch(rec.key, { status, error }, this.now());
      l.info(`dispatch ${status}`, { reason: error });
    } catch (e) {
      if (!this.fatal(e)) l.error("bookkeeping write failed", { error: errMsg(e) });
    }
  }

  // ---- 2. discover ----------------------------------------------------------

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
            await this.d.store.registerAccount(
              { account: f.account, owner: f.owner, discoveredAtBlock: f.blockNumber },
              this.now()
            );
            registered += 1;
            log.info("account discovered", { account: f.account, owner: f.owner, block: f.blockNumber.toString() });
          } catch (e) {
            if (!(e instanceof DuplicateIdError)) throw e;
            // Re-scanned window after a crash: already registered, fine.
          }
        }
        await this.d.store.setCursor(lastBlock);
        handle.bump();
      },
      handle.signal
    );
    return registered;
  }

  // ---- 4/5. evaluate one account ---------------------------------------------

  private async evaluateOne(
    rec: AccountRecord,
    contexts: TickContexts,
    head: bigint,
    chainNowS: bigint,
    handle: TickHandle,
    log: Logger
  ): Promise<AccountOutcome> {
    const l = log.child({ account: rec.account });
    const nowIso = this.now().toISOString();

    let valuation: Valuation;
    try {
      const av = await valueAccount(
        { reader: this.d.reader, venues: this.d.venues ?? null },
        rec.account,
        contexts,
        head,
        {
          nowS: chainNowS,
          priceMaxAgeS: this.d.config.priceMaxAgeS,
          priceMaxAgeBySymbol: this.d.config.priceMaxAgeBySymbol,
          oracleDeviationBps: this.d.config.oracleDeviationBps,
          hfToleranceBps: this.d.config.hfToleranceBps,
        },
        handle.signal
      );
      valuation = av.valuation;
      if (av.venues) {
        l.debug("venue verdicts", {
          aave: av.aave.kind,
          venues: av.venues.map((v) => ({ venue: v.venue, kind: v.kind, assets: v.assets, hf: v.healthFactorWad?.toString() ?? null, verdict: v.valuation.kind })),
          combined: valuation.kind,
        });
      }
      await this.noteDisagreements(rec.account, av, l);
    } catch (e) {
      if (e instanceof AbortedError || handle.signal.aborted) throw e;
      valuation = { kind: "UNKNOWN", reasons: [`read failed: ${errMsg(e)}`] };
    }
    handle.bump();

    // ---- UNKNOWN: no ladder, no dispatch, escalate on a streak ----------
    if (valuation.kind === "UNKNOWN") {
      const streak = rec.unknownStreak + 1;
      l.warn("valuation UNKNOWN — fail closed, no action", { reasons: valuation.reasons, streak });
      await this.bookkeep(
        rec.account,
        { lastValuation: "UNKNOWN", unknownStreak: streak, lastEvaluatedAt: nowIso, lastReasons: valuation.reasons },
        l,
        handle.signal
      );
      const untracked = valuation.reasons.some((r) => r.startsWith(UNTRACKED_COLLATERAL));
      if (untracked) {
        // Actionable by THIS user, and by nobody else: they supplied a reserve
        // Oilskin cannot value, so their protection is off (audit C-MED-5).
        await this.escalate(rec.account, valuation.reasons, streak, "untracked-collateral");
      } else if (streak >= this.d.config.unknownEscalationStreak) {
        await this.escalate(rec.account, valuation.reasons, streak);
      }
      return { account: rec.account, valuation: "UNKNOWN", hf: null, fired: null, dispatch: null };
    }

    // ---- NO_DEBT: everything re-arms (HF = +∞) -------------------------
    const hf = valuation.kind === "OK" ? valuation.hf : Number.POSITIVE_INFINITY;
    const { ladder: startState, refires, rearmedIds } = this.reArmIneffective(rec, hf, l);
    const step = stepLadder(this.d.ladder, startState, hf);

    if (!step.fire) {
      // Nothing to dispatch: persist ladder state / re-arms / episode end.
      const patch: Partial<AccountRecord> = {
        ladder: step.next,
        lastHf: Number.isFinite(hf) ? hf : null,
        lastValuation: valuation.kind,
        lastEvaluatedAt: nowIso,
        unknownStreak: 0,
        rungRefires: refires,
      };
      if (step.episodeEnded) patch.episode = null;
      if (step.rearmed.length) l.info("rungs re-armed", { rungs: step.rearmed.map((r) => r.id), hf });
      if (step.episodeEnded) l.info("episode ended — account healthy again", { episode: rec.episode });
      await this.bookkeep(rec.account, patch, l, handle.signal);
      return { account: rec.account, valuation: valuation.kind, hf: Number.isFinite(hf) ? hf : null, fired: null, dispatch: null };
    }

    // ---- a rung fired: ONE atomic write, then dispatch --------------------
    if (valuation.kind !== "OK") throw new Error("invariant: rung fired without an OK valuation");
    const okValuation = valuation;
    const fire = step.fire;
    if (handle.signal.aborted) throw new AbortedError(`evaluate ${rec.account}`, handle.signal.reason);
    let record: DispatchRecord;
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
        // A more severe rung subsumes any unfinished milder action for this
        // account: mark it so resume does not replay it after this one.
        for (const d of s.dispatches) {
          if (d.account === rec.account && (d.status === "PENDING" || d.status === "FAILED" || d.status === "REFUSED" || d.status === "LOGGED_ONLY")) {
            d.status = "SUPERSEDED";
            d.error = `superseded by ${key}`;
            d.updatedAt = nowIso;
          }
        }
        const d: DispatchRecord = {
          key,
          account: rec.account,
          episode: a.episode,
          seq,
          action: fire.action,
          rung: fire.id,
          hf: okValuation.hf,
          status: "PENDING",
          attempts: 0,
          createdAt: nowIso,
          updatedAt: nowIso,
        };
        s.dispatches.push(d);
        a.ladder = step.next;
        a.lastHf = okValuation.hf;
        a.lastValuation = "OK";
        a.lastEvaluatedAt = nowIso;
        a.unknownStreak = 0;
        a.rungRefires = refires;
        return structuredClone(d);
      });
    } catch (e) {
      // The idempotency record could not be persisted. Acting without it
      // would risk a double unwind after a crash; NOT acting leaves the
      // position exposed. Fail closed and shout: this is an operator page.
      l.error("STORE WRITE FAILED BEFORE DISPATCH — refusing to act without an idempotency record", {
        rung: fire.id,
        hf: okValuation.hf,
        error: errMsg(e),
      });
      await this.escalate(rec.account, [`store write failed before dispatch: ${errMsg(e)}`], 0, "store-failure");
      this.fatal(e);
      return { account: rec.account, valuation: "OK", hf: okValuation.hf, fired: fire.id, dispatch: null, error: errMsg(e) };
    }

    l.warn("rung fired", {
      rung: fire.id,
      action: fire.action,
      hf: okValuation.hf,
      episode: record.episode,
      key: record.key,
      crossed: step.crossed.map((r) => r.id),
      rearmedFirst: rearmedIds,
      collateral: okValuation.dominantCollateral.symbol,
    });
    await this.emit({
      kind: "rung-fired",
      severity: fire.id === this.lastResortRung.id ? "critical" : "warn",
      account: rec.account,
      owner: rec.owner,
      rung: fire.id,
      action: fire.action,
      hf: okValuation.hf,
      key: record.key,
      detail: { episode: record.episode, collateral: okValuation.dominantCollateral.symbol },
    });

    let result: DispatchResult;
    try {
      result = await withDeadline(`dispatch ${record.key}`, this.d.config.dispatchDeadlineMs, handle.signal, () =>
        this.d.dispatcher.dispatch(
        {
          record,
          valuation: okValuation,
          persistBeforeSend: this.preSend(record),
          // The grant (expiry included) is SURFACED, not discarded: a dashboard
          // can now say "protection expires in N days" instead of the user
          // finding out on day 31 that nothing fires any more (audit C-MED-3).
          onGrantRead: (g) => {
            void this.bookkeep(
              rec.account,
              {
                grant: {
                  target: g.target,
                  selector: g.selector,
                  active: g.active,
                  allowCallback: g.allowCallback,
                  expiry: g.expiry,
                  checkedAt: this.now().toISOString(),
                },
              },
              l,
              handle.signal
            );
          },
        },
        handle.signal
        )
      );
    } catch (e) {
      if (e instanceof DeadlineError) {
        // One account's wedged dispatch must not consume the tick: leave the
        // record for the (bounded, quarantining) resume path and move on.
        await this.quarantineOrCount(record, l);
        handle.bump();
        return { account: rec.account, valuation: "OK", hf: okValuation.hf, fired: fire.id, dispatch: null, error: errMsg(e) };
      }
      result = { status: "FAILED", error: errMsg(e) };
    }
    handle.bump();
    await this.recordResult(record, result, l, handle.signal);
    return { account: rec.account, valuation: "OK", hf: okValuation.hf, fired: fire.id, dispatch: result };
  }

  /**
   * Re-arm a rung whose action CONFIRMED but did not clear it.
   *
   * A rung that fires, sends a transaction that succeeds, and leaves the health
   * factor exactly where it was (the classic case: the close was sized on dust)
   * used to latch until HF climbed all the way to its disarm — a whole 0.15-wide
   * band during which the keeper watched the position rot (audit C-MED-2).
   * Bounded by `maxRungRefires` per rung so it can never become a loop, and
   * never applied while a dispatch for the account is still in flight.
   */
  private reArmIneffective(
    rec: AccountRecord,
    hf: number,
    l: Logger
  ): { ladder: LadderState; refires: Record<string, number>; rearmedIds: string[] } {
    const refires: Record<string, number> = { ...(rec.rungRefires ?? {}) };
    if (!Number.isFinite(hf) || rec.ladder.fired.length === 0) return { ladder: rec.ladder, refires, rearmedIds: [] };
    const live = this.d.store
      .listDispatches({ account: rec.account })
      .filter((d) => d.status === "PENDING" || d.status === "SENT");
    if (live.length) return { ladder: rec.ladder, refires, rearmedIds: [] };

    const byRung = new Map<string, DispatchRecord>();
    for (const d of this.d.store.listDispatches({ account: rec.account })) {
      if (rec.episode !== null && d.episode !== rec.episode) continue;
      const prev = byRung.get(d.rung);
      if (!prev || d.seq > prev.seq) byRung.set(d.rung, d);
    }
    const rearmedIds: string[] = [];
    const fired = new Set(rec.ladder.fired);
    for (const id of [...fired]) {
      const rung = this.d.ladder.find((r) => r.id === id);
      if (!rung || hf >= rung.hf) continue; // already cleared, or the normal disarm applies
      const last = byRung.get(id);
      if (!last || last.status !== "CONFIRMED") continue;
      // Never re-arm on a confirmation this very tick produced: the chain state
      // the valuation was read from may predate that transaction.
      if (this.handledThisTick.has(last.key)) continue;
      const used = refires[id] ?? 0;
      if (used >= this.d.config.maxRungRefires) continue;
      fired.delete(id);
      refires[id] = used + 1;
      rearmedIds.push(id);
    }
    if (rearmedIds.length) {
      l.warn("re-arming rungs whose action did not clear them", { rungs: rearmedIds, hf, refires });
    }
    return { ladder: { fired: [...fired].sort() }, refires, rearmedIds };
  }

  /** Post-action bookkeeping. Never throws: a failed write is logged, not fatal. */
  private async recordResult(record: DispatchRecord, result: DispatchResult, l: Logger, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      // A tick the watchdog abandoned must not write stale state over a newer tick's.
      l.warn("bookkeeping skipped: tick was abandoned by the watchdog", { key: record.key, result: result.status });
      return;
    }
    const patch: Parameters<KeeperStore["updateDispatch"]>[1] = { attempts: record.attempts + 1 };
    switch (result.status) {
      case "NOTIFIED":
        patch.status = "NOTIFIED";
        break;
      case "LOGGED_ONLY":
        patch.status = "LOGGED_ONLY";
        patch.error = result.reason;
        break;
      case "SENT":
        patch.status = "SENT";
        patch.txHash = result.txHash;
        break;
      case "CONFIRMED":
        patch.status = "CONFIRMED";
        patch.txHash = result.txHash;
        break;
      case "REFUSED":
        patch.status = "REFUSED";
        patch.error = result.permanent ? `permanent: ${result.reason}` : result.reason;
        break;
      case "SUPERSEDED":
        patch.status = "SUPERSEDED";
        patch.error = result.reason;
        break;
      case "FAILED":
        patch.status = "FAILED";
        patch.error = result.error;
        break;
    }
    this.handledThisTick.add(record.key);
    const level = result.status === "FAILED" || result.status === "REFUSED" || result.status === "LOGGED_ONLY" ? "warn" : "info";
    l[level]("dispatch result", { key: record.key, ...result });
    if (record.action !== "notify") {
      await this.emit({
        kind: "dispatch",
        severity: result.status === "FAILED" || result.status === "REFUSED" ? "warn" : "info",
        account: record.account,
        rung: record.rung,
        action: record.action,
        hf: record.hf,
        key: record.key,
        status: result.status,
        txHash: "txHash" in result ? result.txHash : undefined,
        reasons: "reason" in result ? [result.reason] : "error" in result ? [result.error] : undefined,
      });
    }
    if (result.status === "REFUSED" && result.permanent) {
      await this.escalate(record.account, [`dispatch ${record.key} refused permanently: ${result.reason}`], record.attempts + 1, "grant-misconfigured");
    }
    try {
      await this.d.store.updateDispatch(record.key, patch, this.now());
    } catch (e) {
      if (!this.fatal(e)) l.error("bookkeeping write failed after dispatch (action already taken)", { key: record.key, error: errMsg(e) });
    }
  }

  private async bookkeep(account: Address, patch: Partial<AccountRecord>, l: Logger, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      l.warn("bookkeeping skipped: tick was abandoned by the watchdog");
      return;
    }
    try {
      await this.d.store.updateAccount(account, patch);
    } catch (e) {
      if (!this.fatal(e)) l.error("bookkeeping write failed", { error: errMsg(e) });
    }
  }
}

/**
 * Rotate the evaluation order by a PERSISTED counter so no account is always
 * last. It used to rotate by the block number: Base makes a block every ~2 s,
 * so at the default 30 s poll the head advances by ~15 per tick and `head % n`
 * never moved for any account count dividing 15 — the rotation that exists to
 * stop the same accounts being truncated truncated the same accounts
 * (audit C-LOW-3).
 */
export function rotate<T>(items: readonly T[], seed: bigint): T[] {
  if (items.length === 0) return [];
  const start = Number(((seed % BigInt(items.length)) + BigInt(items.length)) % BigInt(items.length));
  return [...items.slice(start), ...items.slice(0, start)];
}
