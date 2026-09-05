import type { TokenSymbol } from "@zyo/shared";
import type { Dispatcher, DispatchResult } from "../dispatch/types.js";
import { stepLadder, validateLadder, type LadderRung } from "../engine/ladder.js";
import { evaluateSnapshot, type Valuation } from "../engine/valuation.js";
import type { Logger } from "../log.js";
import type { AaveReader, ReserveContextResult } from "../services/chain.js";
import type { AccountDiscovery } from "../services/discovery.js";
import { AbortedError, mapBounded } from "../services/deadline.js";
import { DuplicateIdError, KeeperStore, type AccountRecord, type DispatchRecord } from "../store/keeperStore.js";
import type { Address } from "../types/evm.js";
import type { TickHandle } from "../watchdog.js";

/**
 * The keeper's per-tick work, in order:
 *   1. resume — any dispatch left PENDING/SENT by a previous process is
 *      finished FIRST, with its persisted key (crash-restart reuses the key);
 *   2. discover — new `AccountCreated` logs since the persisted cursor;
 *   3. context — per-asset LT / prices, read once for the tick;
 *   4. evaluate — every registered account, bounded concurrency, rotating
 *      start so a slow tail never starves the same accounts twice, each
 *      account isolated (one failure = one UNKNOWN, never a stalled tick);
 *   5. per account: valuation → ladder step → (episode + dispatch record +
 *      ladder state persisted in ONE atomic write) → dispatch → bookkeeping.
 *
 * Progress is reported to the watchdog after every completed unit, so a slow
 * tick is distinguishable from a stuck one.
 */

export interface MonitorConfig {
  concurrency: number;
  priceMaxAgeS: number;
  oracleDeviationBps: number;
  hfToleranceBps: number;
  discoveryFromBlock: bigint;
  /** Consecutive UNKNOWN valuations before the escalation hook fires. */
  unknownEscalationStreak: number;
  /** Attempts (same key) before a FAILED/REFUSED dispatch is ABANDONED and escalated. */
  maxDispatchAttempts: number;
}

export interface MonitorDeps {
  reader: AaveReader;
  discovery: AccountDiscovery;
  store: KeeperStore;
  ladder: readonly LadderRung[];
  dispatcher: Dispatcher;
  log: Logger;
  config: MonitorConfig;
  now?: () => Date;
  /** Human escalation hook (webhook/pager). Never gates any action. */
  onEscalate?: (e: { account: Address; reasons: string[]; streak: number }) => void;
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

  constructor(private readonly d: MonitorDeps) {
    validateLadder(d.ladder);
    if (!(d.config.concurrency >= 1)) throw new RangeError("concurrency must be ≥ 1");
    this.now = d.now ?? (() => new Date());
  }

  async tick(handle: TickHandle): Promise<TickReport> {
    const { signal } = handle;
    const log = this.d.log.child({ tick: ++this.tickCount });
    const report: TickReport = { blockNumber: null, discovered: 0, resumed: 0, evaluated: 0, outcomes: [], aborted: false };

    try {
      report.resumed = await this.resumePending(handle, log);

      const head = await this.d.reader.blockNumber(signal);
      handle.bump();
      report.blockNumber = head;

      report.discovered = await this.discover(head, handle, log);

      const contexts = await this.d.reader.readReserveContexts(signal);
      handle.bump();
      for (const [sym, r] of contexts) if (!r.ok) log.warn("reserve context unreadable", { reserve: sym, reason: r.reason });

      const accounts = this.d.store.listAccounts();
      const rotated = rotate(accounts, head);
      const results = await mapBounded(
        rotated,
        this.d.config.concurrency,
        (rec) => this.evaluateOne(rec, contexts, head, handle, log),
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
    } catch (e) {
      if (signal.aborted || e instanceof AbortedError) {
        report.aborted = true;
        log.warn("tick aborted", { error: errMsg(e) });
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
   *                           otherwise ABANDONED (+ escalation).
   * The dispatcher re-checks the world before re-sending, so a resumed record
   * whose rung has since cleared comes back SUPERSEDED, not double-acted.
   */
  private async resumePending(handle: TickHandle, log: Logger): Promise<number> {
    let n = 0;
    const candidates = [
      ...this.d.store.listDispatches({ status: "PENDING" }),
      ...this.d.store.listDispatches({ status: "SENT" }),
      ...this.d.store.listDispatches({ status: "FAILED" }),
      ...this.d.store.listDispatches({ status: "REFUSED" }),
    ].sort((a, b) => a.seq - b.seq);
    for (const rec of candidates) {
      if (handle.signal.aborted) break;
      const l = log.child({ account: rec.account, key: rec.key, action: rec.action, status: rec.status });
      if (rec.status === "FAILED" || rec.status === "REFUSED") {
        const acct = this.d.store.getAccount(rec.account);
        if (!acct || acct.episode !== rec.episode) {
          // Episode over: nothing left to protect under this key.
          await this.setStatus(rec, "SUPERSEDED", "episode ended before retry", l);
          continue;
        }
        if (rec.attempts >= this.d.config.maxDispatchAttempts) {
          await this.setStatus(rec, "ABANDONED", `gave up after ${rec.attempts} attempts`, l);
          l.error("dispatch ABANDONED — human intervention required", { attempts: rec.attempts, lastError: rec.error });
          this.d.onEscalate?.({ account: rec.account, reasons: [`dispatch ${rec.key} abandoned: ${rec.error ?? "?"}`], streak: rec.attempts });
          continue;
        }
      }
      l.warn("resuming dispatch with its persisted key", { attempt: rec.attempts + 1 });
      let result: DispatchResult;
      try {
        result =
          rec.status === "SENT" && rec.txHash
            ? await this.d.dispatcher.confirm(rec, handle.signal)
            : await this.d.dispatcher.dispatch({ record: rec, valuation: null }, handle.signal);
      } catch (e) {
        result = { status: "FAILED", error: errMsg(e) };
      }
      handle.bump();
      await this.recordResult(rec, result, l, handle.signal);
      n += 1;
    }
    return n;
  }

  private async setStatus(rec: DispatchRecord, status: "SUPERSEDED" | "ABANDONED", error: string, l: Logger): Promise<void> {
    try {
      await this.d.store.updateDispatch(rec.key, { status, error }, this.now());
      l.info(`dispatch ${status}`, { reason: error });
    } catch (e) {
      l.error("bookkeeping write failed", { error: errMsg(e) });
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
    contexts: Map<TokenSymbol, ReserveContextResult>,
    head: bigint,
    handle: TickHandle,
    log: Logger
  ): Promise<AccountOutcome> {
    const l = log.child({ account: rec.account });
    const nowIso = this.now().toISOString();

    let valuation: Valuation;
    try {
      const snap = await this.d.reader.readAccount(rec.account, contexts, head, handle.signal);
      valuation = evaluateSnapshot(snap, {
        nowS: BigInt(Math.floor(this.now().getTime() / 1000)),
        priceMaxAgeS: this.d.config.priceMaxAgeS,
        oracleDeviationBps: this.d.config.oracleDeviationBps,
        hfToleranceBps: this.d.config.hfToleranceBps,
      });
    } catch (e) {
      if (e instanceof AbortedError || handle.signal.aborted) throw e;
      valuation = { kind: "UNKNOWN", reasons: [`read failed: ${errMsg(e)}`] };
    }
    handle.bump();

    // ---- UNKNOWN: no ladder, no dispatch, escalate on a streak ----------
    if (valuation.kind === "UNKNOWN") {
      const streak = rec.unknownStreak + 1;
      l.warn("valuation UNKNOWN — fail closed, no action", { reasons: valuation.reasons, streak });
      await this.bookkeep(rec.account, { lastValuation: "UNKNOWN", unknownStreak: streak, lastEvaluatedAt: nowIso }, l, handle.signal);
      if (streak >= this.d.config.unknownEscalationStreak && this.d.onEscalate) {
        try {
          this.d.onEscalate({ account: rec.account, reasons: valuation.reasons, streak });
        } catch (e) {
          l.error("escalation hook threw", { error: errMsg(e) });
        }
      }
      return { account: rec.account, valuation: "UNKNOWN", hf: null, fired: null, dispatch: null };
    }

    // ---- NO_DEBT: everything re-arms (HF = +∞) -------------------------
    const hf = valuation.kind === "OK" ? valuation.hf : Number.POSITIVE_INFINITY;
    const step = stepLadder(this.d.ladder, rec.ladder, hf);

    if (!step.fire) {
      // Nothing to dispatch: persist ladder state / re-arms / episode end.
      const patch: Partial<AccountRecord> = {
        ladder: step.next,
        lastHf: Number.isFinite(hf) ? hf : null,
        lastValuation: valuation.kind,
        lastEvaluatedAt: nowIso,
        unknownStreak: 0,
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
          if (d.account === rec.account && (d.status === "PENDING" || d.status === "FAILED" || d.status === "REFUSED")) {
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
      this.d.onEscalate?.({ account: rec.account, reasons: [`store write failed before dispatch: ${errMsg(e)}`], streak: 0 });
      return { account: rec.account, valuation: "OK", hf: okValuation.hf, fired: fire.id, dispatch: null, error: errMsg(e) };
    }

    l.warn("rung fired", {
      rung: fire.id,
      action: fire.action,
      hf: okValuation.hf,
      episode: record.episode,
      key: record.key,
      crossed: step.crossed.map((r) => r.id),
      collateral: okValuation.dominantCollateral.symbol,
    });

    let result: DispatchResult;
    try {
      result = await this.d.dispatcher.dispatch({ record, valuation: okValuation }, handle.signal);
    } catch (e) {
      result = { status: "FAILED", error: errMsg(e) };
    }
    handle.bump();
    await this.recordResult(record, result, l, handle.signal);
    return { account: rec.account, valuation: "OK", hf: okValuation.hf, fired: fire.id, dispatch: result };
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
        patch.error = result.reason;
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
    const level = result.status === "FAILED" || result.status === "REFUSED" ? "warn" : "info";
    l[level]("dispatch result", { key: record.key, ...result });
    try {
      await this.d.store.updateDispatch(record.key, patch, this.now());
    } catch (e) {
      l.error("bookkeeping write failed after dispatch (action already taken)", { key: record.key, error: errMsg(e) });
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
      l.error("bookkeeping write failed", { error: errMsg(e) });
    }
  }
}

/** Rotate the evaluation order by the block number so no account is always last. */
export function rotate<T>(items: readonly T[], seed: bigint): T[] {
  if (items.length === 0) return [];
  const start = Number(seed % BigInt(items.length));
  return [...items.slice(start), ...items.slice(0, start)];
}
