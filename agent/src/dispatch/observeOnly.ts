import type { Logger } from "../log.js";
import { eventNow, type Notifier } from "../notify/notifier.js";
import type { DispatchIntent, DispatchResult, Dispatcher } from "./types.js";

/**
 * Dispatcher used when no KEEPER_PRIVATE_KEY is configured: the ladder still
 * runs and every firing is recorded with its idempotency key, but nothing is
 * sent. `notify` rungs are DELIVERED through the notifier — and are only
 * reported NOTIFIED when a channel accepted them; every on-chain action is
 * REFUSED so the record and the escalation are visible.
 */
export class ObserveOnlyDispatcher implements Dispatcher {
  constructor(
    private readonly log: Logger,
    private readonly notifier?: Notifier,
    private readonly now: () => Date = () => new Date()
  ) {}

  async dispatch({ record }: DispatchIntent): Promise<DispatchResult> {
    if (record.action === "notify") {
      try {
        await this.notifier?.deliver(
          eventNow(
            {
              kind: "notify",
              severity: "warn",
              account: record.account,
              rung: record.rung,
              action: record.action,
              hf: record.hf,
              key: record.key,
              detail: { mode: "observe-only" },
            },
            this.now
          )
        );
      } catch (e) {
        return { status: "FAILED", error: `notification not delivered: ${e instanceof Error ? e.message : String(e)}` };
      }
      this.log.warn("NOTIFY: health warning", { account: record.account, rung: record.rung, hf: record.hf, key: record.key });
      return { status: "NOTIFIED" };
    }
    return { status: "REFUSED", permanent: true, reason: "observe-only mode: no keeper key configured" };
  }

  async confirm(): Promise<DispatchResult> {
    return { status: "REFUSED", permanent: true, reason: "observe-only mode: nothing was ever sent" };
  }
}
