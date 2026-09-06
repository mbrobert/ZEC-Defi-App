import type { Valuation } from "../engine/valuation.js";
import type { DispatchRecord } from "../store/keeperStore.js";

export type OkValuation = Extract<Valuation, { kind: "OK" }>;

export interface GrantSnapshot {
  target: `0x${string}`;
  selector: `0x${string}`;
  active: boolean;
  allowCallback: boolean;
  expiry: number;
}

export interface DispatchIntent {
  record: DispatchRecord;
  /** Valuation that triggered the rung; null when resuming after a restart. */
  valuation: OkValuation | null;
  /**
   * Persist the keeper nonce and the ids about to be closed BEFORE the
   * broadcast. A crash in the window between the send and the store write used
   * to replay the action and close a further slice of the user's LP
   * (audit C-MED-1). Rejecting here fails the dispatch closed.
   */
  persistBeforeSend?: (info: { nonce?: number; closeIds: bigint[] }) => Promise<void>;
  /** Surface the on-chain grant (expiry included) to the caller for the store. */
  onGrantRead?: (g: GrantSnapshot) => void;
}

export type DispatchResult =
  | { status: "NOTIFIED" }
  | { status: "SENT"; txHash: `0x${string}` }
  | { status: "CONFIRMED"; txHash: `0x${string}` }
  /**
   * `permanent` marks a refusal only the USER can clear — no grant, a grant
   * without `allowCallback`, a budget spent. Retrying it is noise; the monitor
   * escalates it once and stops.
   */
  | { status: "REFUSED"; reason: string; permanent?: boolean }
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
