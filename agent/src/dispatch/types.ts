import type { Valuation } from "../engine/valuation.js";
import type { DispatchRecord, VenueBook } from "../store/keeperStore.js";

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
  persistBeforeSend?: (info: { nonce?: number; closeIds: bigint[]; venueBooks?: VenueBook[] }) => Promise<void>;
  /** Surface the on-chain grant (expiry included) to the caller for the store. */
  onGrantRead?: (g: GrantSnapshot) => void;
}

export type DispatchResult =
  | { status: "NOTIFIED" }
  /**
   * The event was written, but only to channels that reach nobody (the keeper's
   * own log and store). Not terminal: retried each tick like a FAILED dispatch
   * until a person-facing channel accepts it (audit wave 2, N-MED-1).
   */
  | { status: "LOGGED_ONLY"; reason: string }
  | { status: "SENT"; txHash: `0x${string}` }
  /**
   * `note` is set when the receipt is an honest SHORTFALL (slice 5): the worse book was paid, the
   * account's USDC ran out, a book it owed at dispatch was left for the retry. Confirmed, but said.
   */
  | { status: "CONFIRMED"; txHash: `0x${string}`; note?: string }
  /**
   * `permanent` marks a refusal only the USER can clear — no grant, a grant
   * without `allowCallback`, a budget spent. Retrying it is noise; the monitor
   * escalates it once and stops.
   */
  | { status: "REFUSED"; reason: string; permanent?: boolean }
  | { status: "SUPERSEDED"; reason: string }
  | { status: "FAILED"; error: string };

/**
 * What a confirmed Base burn leaves for the Solana side to finish (BUILD-PLAN D6 / A5.2; Stream C fills the
 * later stages): the transaction Circle's attestation is looked up by, the amount, and the message bytes
 * the transmitter emitted (hex), so a delivery can be built without re-reading the receipt.
 */
export interface BridgeInfo {
  chain: "base";
  stage: "burn-sent" | "burn-confirmed" | "attested" | "delivered";
  burnTxHash: string;
  amountUsdc: string;
  /** CCTP's nonce (bytes32, hex) from the message header; absent until the receipt is read. */
  nonce?: string;
  /** The full V2 message, hex. */
  messageHex?: string;
  /** The recipient the router burned to (bytes32, hex) — the Solana USDC token account. */
  recipient?: string;
  /** Circle's signatures over that message, hex; absent until the service has attested it. */
  attestationHex?: string;
  /** The Solana signature that delivered it, once it landed. */
  deliveryTx?: string;
  /** What actually arrived: the burn less the fee Circle executed. */
  deliveredAmountUsdc?: string;
  /**
   * The Base `OilskinAccount` the burn was made from (checksummed). A Solana record's `account` is the Solana
   * PDA, so without this the receipt could not be judged on a later tick — set by the Base burner adapter at
   * dispatch (`agent/src/solana/baseBurner.ts`, 2026-09-25).
   */
  baseAccount?: string;
  /** The finality the burn asked Circle for (1000 Fast / 2000 Standard) and the fee bound it carried, bps — chosen at send time from Circle's live schedule. */
  minFinalityThreshold?: number;
  maxFeeBps?: number;
}

/**
 * A burn the Solana side asks the Base side to make for a paired account (§14.7): the USDC that must reach
 * the Solana debt plus Circle's fee, and the recipient the router MUST already carry for the account —
 * the dispatcher refuses when `solanaRecipient(account)` is anything else.
 */
export interface BurnIntent {
  record: DispatchRecord;
  /** USDC (base units) that must arrive on Solana; null = size by the rung's fraction alone. */
  usdcNeeded: bigint | null;
  /** The Solana USDC token account the burn must go to (bytes32 hex), as read from the Solana Account. */
  expectedRecipient: `0x${string}`;
  /** A registered collateral asset for the value probe's simulated unwind (any enabled asset works for an LP-only account). */
  collateralAssetForProbe: `0x${string}`;
  /** Bound on Circle's fee, in bps of the burn (the Fast minimum Base → Solana was 1.3 bp on 2026-09-12). */
  maxFeeBps: number;
  /** 1000 = Fast Transfer, 2000 = Standard. */
  minFinalityThreshold: number;
  persistBeforeSend?: (info: { nonce?: number; closeIds: bigint[] }) => Promise<void>;
  onGrantRead?: (g: GrantSnapshot) => void;
}

export type BurnResult = DispatchResult & { bridge?: BridgeInfo };

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
