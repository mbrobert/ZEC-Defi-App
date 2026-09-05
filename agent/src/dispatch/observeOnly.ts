import type { Logger } from "../log.js";
import { withDeadline } from "../services/deadline.js";
import type { DispatchRecord } from "../store/keeperStore.js";
import type { DispatchIntent, DispatchResult, Dispatcher } from "./types.js";

/**
 * Dispatcher used when no KEEPER_PRIVATE_KEY is configured: the ladder still
 * runs and every firing is recorded with its idempotency key, but nothing is
 * sent. `notify` rungs are delivered (to the log / notify hook); every
 * on-chain action is REFUSED so the record and the escalation are visible.
 */
export class ObserveOnlyDispatcher implements Dispatcher {
  constructor(
    private readonly log: Logger,
    private readonly notify?: (r: DispatchRecord) => Promise<void> | void,
    private readonly hookDeadlineMs = 10_000
  ) {}

  async dispatch({ record }: DispatchIntent, signal?: AbortSignal): Promise<DispatchResult> {
    if (record.action === "notify") {
      await withDeadline("notify hook", this.hookDeadlineMs, signal, async () => this.notify?.(record));
      this.log.warn("NOTIFY: health warning", { account: record.account, rung: record.rung, hf: record.hf, key: record.key });
      return { status: "NOTIFIED" };
    }
    return { status: "REFUSED", reason: "observe-only mode: no keeper key configured" };
  }

  async confirm(): Promise<DispatchResult> {
    return { status: "REFUSED", reason: "observe-only mode: nothing was ever sent" };
  }
}
