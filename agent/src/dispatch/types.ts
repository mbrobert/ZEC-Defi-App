import type { Valuation } from "../engine/valuation.js";
import type { DispatchRecord } from "../store/keeperStore.js";

export type OkValuation = Extract<Valuation, { kind: "OK" }>;

export interface DispatchIntent {
  record: DispatchRecord;
  /** Valuation that triggered the rung; null when resuming after a restart. */
  valuation: OkValuation | null;
}

export type DispatchResult =
  | { status: "NOTIFIED" }
  | { status: "SENT"; txHash: `0x${string}` }
  | { status: "CONFIRMED"; txHash: `0x${string}` }
  | { status: "REFUSED"; reason: string }
  | { status: "SUPERSEDED"; reason: string }
  | { status: "FAILED"; error: string };

export interface Dispatcher {
  /**
   * Execute the action named by `record.action` for `record.account`, using
   * `record.key` as the idempotency key. Must be safe to call again with the
   * same record after a crash (the implementation re-checks the world before
   * re-sending).
   */
  dispatch(intent: DispatchIntent, signal?: AbortSignal): Promise<DispatchResult>;
  /** Check on a previously SENT transaction. */
  confirm(record: DispatchRecord, signal?: AbortSignal): Promise<DispatchResult>;
}
