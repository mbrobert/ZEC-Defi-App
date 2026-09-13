import type { Logger } from "../log.js";
import { withDeadline } from "../services/deadline.js";

/**
 * The keeper's outbound channel.
 *
 * WHY THIS EXISTS (audit C-MED-7, and D7). Before this, `index.ts` called
 * `runKeeper(process.env)` with no hooks at all, so `notify?.()` was a
 * permanent no-op and `onEscalate` was undefined. The ENTIRE user-visible
 * behaviour of the protection they were shown before signing — "Warning
 * (HF under the warn rung) → keeper notify" — was one JSON line on a server they cannot
 * see. That covered every escalation too: an UNKNOWN streak, an ABANDONED
 * dispatch, a refused grant, a store failure.
 *
 * Rules:
 *   • every rung and every escalation produces an event — not just `warn`;
 *   • delivery is bounded by a deadline and never throws into a tick: a
 *     wedged webhook must not wedge the fleet (audit C-HIGH-3);
 *   • delivery failures are counted and logged at error, so "nobody was told"
 *     is itself visible;
 *   • the `notify` RUNG is only reported NOTIFIED when a PERSON-FACING channel
 *     accepted it. The keeper's own log and its own store are channels too,
 *     and they always accept — so with no webhook configured every warning
 *     used to be NOTIFIED and terminal after being written to a file on a
 *     host the user cannot see (audit wave 2, N-MED-1). A delivery that only
 *     the log/store took is LOGGED_ONLY: not terminal, retried each tick.
 */

export type KeeperEventKind =
  | "rung-fired"
  | "notify"
  | "dispatch"
  | "escalation"
  | "grant-expiring"
  | "grant-misconfigured"
  | "untracked-collateral"
  | "store-failure"
  | "feed-policy"
  /** A venue's oracle and the keeper's feed disagree: acting on the pessimistic health, withdrawals refused (RISKS §8 residual (b)). */
  | "oracle-disagreement"
  /**
   * A protective repay was CONFIRMED with a shortfall: the account's USDC ran out on the worse
   * book and a book owed at dispatch was left for the retry (slice 5 `judgeUntouched`). Told to
   * the owner ONCE per dispatch, at warn; the re-armed rung's retry is bookkeeping (RISKS §8).
   */
  | "shortfall";

export type Severity = "info" | "warn" | "critical";

export interface KeeperEvent {
  kind: KeeperEventKind;
  severity: Severity;
  /** Account the event is about (0x on Base, base58 on Solana); absent for fleet-level events. */
  account?: string;
  owner?: string;
  rung?: string;
  action?: string;
  hf?: number | null;
  status?: string;
  key?: string;
  txHash?: string;
  reasons?: string[];
  detail?: Record<string, unknown>;
  at: string;
}

/** One outbound channel. `reachesAPerson` is the honest label: the keeper's own log and store do not. */
export interface Channel {
  name: string;
  /**
   * True only for a channel that leaves this host towards a human (a webhook to a pager, a
   * mailer). False for the keeper's own log and store — they always accept, and accepting is
   * not telling anyone.
   */
  reachesAPerson: boolean;
  send: (e: KeeperEvent, signal?: AbortSignal) => Promise<void>;
}

/** What one delivery achieved: every channel accepted (else `deliver` rejects), and whether any of them reaches a person. */
export interface Delivery {
  personReached: boolean;
}

export interface Notifier {
  /** Deliver one event. Resolves on success, REJECTS when a channel refused it. */
  deliver(e: KeeperEvent): Promise<Delivery>;
  /** Delivery failures since start (for the heartbeat line). */
  readonly failures: number;
  readonly channels: readonly string[];
  /** Whether any configured channel reaches a person at all. */
  readonly hasPersonChannel: boolean;
}

/** Fan-out: an event is delivered if EVERY channel accepted it; it reached a person if any person-facing one did. */
export class MultiNotifier implements Notifier {
  private failed = 0;
  constructor(
    private readonly log: Logger,
    private readonly targets: readonly Channel[],
    private readonly deadlineMs: number
  ) {}

  get failures(): number {
    return this.failed;
  }
  get channels(): readonly string[] {
    return this.targets.map((t) => t.name);
  }
  get hasPersonChannel(): boolean {
    return this.targets.some((t) => t.reachesAPerson);
  }

  async deliver(e: KeeperEvent): Promise<Delivery> {
    const errors: string[] = [];
    let personReached = false;
    for (const t of this.targets) {
      try {
        await withDeadline(`notify:${t.name}`, this.deadlineMs, undefined, () => t.send(e));
        if (t.reachesAPerson) personReached = true;
      } catch (err) {
        errors.push(`${t.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (errors.length) {
      this.failed += 1;
      this.log.error("NOTIFICATION NOT DELIVERED — the user was not told", {
        kind: e.kind,
        account: e.account,
        rung: e.rung,
        errors,
      });
      throw new Error(`notification not delivered (${errors.join("; ")})`);
    }
    return { personReached };
  }
}

/** Always-on channel: the keeper's own structured log, at a level matching severity. Reaches nobody. */
export function logChannel(log: Logger): Channel {
  return {
    name: "log",
    reachesAPerson: false,
    send: async (e) => {
      const level = e.severity === "critical" ? "error" : e.severity === "warn" ? "warn" : "info";
      log[level](`NOTIFY ${e.kind}`, {
        account: e.account,
        owner: e.owner,
        rung: e.rung,
        action: e.action,
        hf: e.hf ?? null,
        status: e.status,
        key: e.key,
        txHash: e.txHash,
        reasons: e.reasons,
        ...e.detail,
      });
    },
  };
}

export interface WebhookOptions {
  url: string;
  /** Sent as `Authorization: Bearer …`; never logged (the logger redacts it anyway). */
  token?: string;
  fetchImpl?: typeof fetch;
}

/**
 * HTTP channel. One POST per event, JSON body, non-2xx is a delivery failure.
 * This is the seam an operator points at their pager / mailer / dashboard
 * ingest; the keeper does not care which.
 */
export function webhookChannel(opts: WebhookOptions): Channel {
  const f = opts.fetchImpl ?? fetch;
  return {
    name: "webhook",
    reachesAPerson: true,
    send: async (e) => {
      const res = await f(opts.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body: JSON.stringify(e),
      });
      if (!res.ok) throw new Error(`webhook returned ${res.status}`);
    },
  };
}

/** A notifier that drops everything — used only where a test wants silence. Reaches nobody. */
export class NullNotifier implements Notifier {
  readonly failures = 0;
  readonly channels: readonly string[] = [];
  readonly hasPersonChannel = false;
  async deliver(): Promise<Delivery> {
    return { personReached: false };
  }
}

export function eventNow(e: Omit<KeeperEvent, "at">, now: () => Date = () => new Date()): KeeperEvent {
  return { ...e, at: now().toISOString() };
}
