import type { Logger } from "../log.js";
import { withDeadline } from "../services/deadline.js";
import type { Address } from "../types/evm.js";

/**
 * The keeper's outbound channel.
 *
 * WHY THIS EXISTS (audit C-MED-7, and D7). Before this, `index.ts` called
 * `runKeeper(process.env)` with no hooks at all, so `notify?.()` was a
 * permanent no-op and `onEscalate` was undefined. The ENTIRE user-visible
 * behaviour of the protection they were shown before signing — "Warning
 * (HF < 1.50) → keeper notify" — was one JSON line on a server they cannot
 * see. That covered every escalation too: an UNKNOWN streak, an ABANDONED
 * dispatch, a refused grant, a store failure.
 *
 * Rules:
 *   • every rung and every escalation produces an event — not just `warn`;
 *   • delivery is bounded by a deadline and never throws into a tick: a
 *     wedged webhook must not wedge the fleet (audit C-HIGH-3);
 *   • delivery failures are counted and logged at error, so "nobody was told"
 *     is itself visible;
 *   • the `notify` RUNG is only reported NOTIFIED when delivery SUCCEEDED —
 *     otherwise it is a FAILED dispatch and gets retried like any other.
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
  | "feed-policy";

export type Severity = "info" | "warn" | "critical";

export interface KeeperEvent {
  kind: KeeperEventKind;
  severity: Severity;
  /** Account the event is about; absent for fleet-level events. */
  account?: Address;
  owner?: Address;
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

export interface Notifier {
  /** Deliver one event. Resolves on success, REJECTS when nobody was told. */
  deliver(e: KeeperEvent): Promise<void>;
  /** Delivery failures since start (for the heartbeat line). */
  readonly failures: number;
  readonly channels: readonly string[];
}

/** Fan-out: an event is delivered if EVERY channel accepted it. */
export class MultiNotifier implements Notifier {
  private failed = 0;
  constructor(
    private readonly log: Logger,
    private readonly targets: readonly { name: string; send: (e: KeeperEvent, signal?: AbortSignal) => Promise<void> }[],
    private readonly deadlineMs: number
  ) {}

  get failures(): number {
    return this.failed;
  }
  get channels(): readonly string[] {
    return this.targets.map((t) => t.name);
  }

  async deliver(e: KeeperEvent): Promise<void> {
    const errors: string[] = [];
    for (const t of this.targets) {
      try {
        await withDeadline(`notify:${t.name}`, this.deadlineMs, undefined, () => t.send(e));
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
  }
}

/** Always-on channel: the keeper's own structured log, at a level matching severity. */
export function logChannel(log: Logger): { name: string; send: (e: KeeperEvent) => Promise<void> } {
  return {
    name: "log",
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
export function webhookChannel(opts: WebhookOptions): { name: string; send: (e: KeeperEvent) => Promise<void> } {
  const f = opts.fetchImpl ?? fetch;
  return {
    name: "webhook",
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

/** A notifier that drops everything — used only where a test wants silence. */
export class NullNotifier implements Notifier {
  readonly failures = 0;
  readonly channels: readonly string[] = [];
  async deliver(): Promise<void> {
    /* no channel configured */
  }
}

export function eventNow(e: Omit<KeeperEvent, "at">, now: () => Date = () => new Date()): KeeperEvent {
  return { ...e, at: now().toISOString() };
}
