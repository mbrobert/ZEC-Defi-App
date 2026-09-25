/**
 * The Base burner the Solana keeper's dispatcher asks for at rungs 3–4 of a linked pair
 * (`SOLANA-ARCHITECTURE.md` §14.6–14.7; BUILD-PLAN D6 / A5.2; Stream C) — the adapter over
 * `KeeperDispatcher.dispatchBurn` / `confirmBurn` that did not exist until 2026-09-25. Three things happen
 * here and nowhere else:
 *
 *   1. **The record is translated.** A Solana dispatch record's `account` is the Solana PDA; the Base
 *      dispatcher reads `solanaRecipient(record.account)` on the router and matches `BurnedToSolana` events
 *      on it, so it must be handed a record whose `account` is the Base `OilskinAccount`. That address
 *      arrives with the dispatch (the pair the dispatcher read) and is written onto the bridge record, so a
 *      later tick's `confirm` can translate the same way without re-reading the pair.
 *   2. **Fast or Standard is chosen from Circle's live numbers** (`chooseCctpFinality` in shared, the
 *      fee client beside this file), and the bound and the threshold ride into the burn intent — the
 *      runbook's "the keeper sends whatever threshold the caller passes" ends here.
 *   3. **The pre-send write is forwarded**, so the Base keeper's nonce and the closed ids are on the Solana
 *      record before the broadcast, as they are on a Base-only record.
 *
 * What this file does NOT decide: where the Base key lives. Whoever constructs a `KeeperDispatcher` with a
 * Base wallet constructs this adapter over it and hands it to `runSolanaKeeper` as `baseBurner`; that a
 * process holds two keys is the founder's call (`CROSSCHAIN-RUNBOOK-2026-09-13.md` §4).
 */
import { CCTP_DOMAINS, chooseCctpFinality, type CctpFinalityPolicy } from "@zyo/shared";
import type { BurnIntent, BurnResult } from "../dispatch/types.js";
import type { Logger } from "../log.js";
import type { DispatchRecord } from "../store/keeperStore.js";
import type { Address, Hex } from "../types/evm.js";
import type { CircleFeeClient } from "./circleFees.js";
import type { BaseBurner, SolanaDispatchRecord } from "./dispatcher.js";

/** The two calls of the Base dispatcher this adapter needs — `KeeperDispatcher` satisfies it; a test fakes it. */
export interface BurnDispatcherLike {
  dispatchBurn(intent: BurnIntent, signal?: AbortSignal): Promise<BurnResult>;
  confirmBurn(record: DispatchRecord, signal?: AbortSignal): Promise<BurnResult>;
}

export interface KeeperBaseBurnerDeps {
  base: BurnDispatcherLike;
  /** null = Circle is never asked; the chooser then sends Fast at the policy's ceiling and says so. */
  fees: CircleFeeClient | null;
  policy: CctpFinalityPolicy;
  /** A registered collateral asset for the Base dispatcher's value probe (any enabled asset serves an LP-only account). */
  collateralAssetForProbe: Address;
  log: Logger;
}

/**
 * A Solana record as the Base dispatcher must see it: the Base account in `account`, the Base hash (if any) in
 * `txHash`. Everything else — key, episode, action, attempts, bridge — is the same record.
 */
export function toBaseRecord(record: SolanaDispatchRecord, baseAccount: Address): DispatchRecord {
  const { txHash: _solanaTx, ...rest } = record;
  void _solanaTx;
  // The generic record is the same shape on both chains; only the id and hash codecs differ, hence the cast.
  const out = { ...rest, account: baseAccount.toLowerCase() as Address } as DispatchRecord;
  if (record.bridge?.burnTxHash) out.txHash = record.bridge.burnTxHash as Hex;
  return out;
}

export class KeeperBaseBurner implements BaseBurner {
  constructor(private readonly d: KeeperBaseBurnerDeps) {}

  async dispatch(input: Parameters<BaseBurner["dispatch"]>[0], signal?: AbortSignal): Promise<BurnResult> {
    const { record, baseAccount } = input;
    const log = this.d.log.child({ key: record.key, account: record.account, baseAccount });
    if (record.sentNonce !== undefined && !record.bridge) {
      // The pre-send write landed and the send's result did not: a burn may already be out under that nonce.
      // The Base dispatcher re-reads the LP state before planning, so a landed burn shows as less to close;
      // this line is what a person looks for when the store says so (C-MED-1's rule, on the Solana record).
      log.warn("a Base burn may already be out for this record (the pre-send nonce is persisted, no receipt) — the plan is re-sized against the LP state on Base now", { sentNonce: record.sentNonce });
    }

    const inputs = this.d.fees ? await this.d.fees.finalityInputs(CCTP_DOMAINS.base, CCTP_DOMAINS.solana, signal) : { fees: null, allowance: null, notes: ["fees: no Circle fee client configured"] };
    const choice = chooseCctpFinality({ amountUsdc: input.usdcNeeded, fees: inputs.fees, allowance: inputs.allowance, policy: this.d.policy });
    if (choice.kind === "refuse") {
      // Not permanent: the schedule or the ceiling can change, and the next tick asks again.
      return { status: "REFUSED", reason: `finality: ${choice.reason}` };
    }
    log.info("finality chosen", { path: choice.path, minFinalityThreshold: choice.minFinalityThreshold, maxFeeBps: choice.maxFeeBps, reason: choice.reason, notes: inputs.notes });

    const intent: BurnIntent = {
      record: toBaseRecord(record, baseAccount),
      usdcNeeded: input.usdcNeeded,
      expectedRecipient: input.expectedRecipient,
      collateralAssetForProbe: this.d.collateralAssetForProbe,
      maxFeeBps: choice.maxFeeBps,
      minFinalityThreshold: choice.minFinalityThreshold,
      persistBeforeSend: input.persistBeforeSend,
    };
    const r = await this.d.base.dispatchBurn(intent, signal);
    // Whatever came back with a bridge record carries the account and the finality it was sent with.
    if ("bridge" in r && r.bridge) return { ...r, bridge: { ...r.bridge, baseAccount, minFinalityThreshold: choice.minFinalityThreshold, maxFeeBps: choice.maxFeeBps } };
    return r;
  }

  async confirm(record: SolanaDispatchRecord, signal?: AbortSignal): Promise<BurnResult> {
    const b = record.bridge;
    if (!b) return { status: "FAILED", error: "confirm asked for a record with no bridge stage" };
    const baseAccount = b.baseAccount;
    if (!baseAccount || !/^0x[0-9a-fA-F]{40}$/.test(baseAccount)) {
      // A record from before the adapter existed, or one written by something else: the receipt cannot be
      // judged (its events are matched on the Base account) and no retry changes that.
      return { status: "REFUSED", permanent: true, reason: "the bridge record carries no Base account — the receipt cannot be judged, and no retry changes that; deliver by hand from the burn hash (CROSSCHAIN-RUNBOOK §3)" };
    }
    const r = await this.d.base.confirmBurn(toBaseRecord(record, baseAccount as Address), signal);
    if ("bridge" in r && r.bridge) return { ...r, bridge: { ...b, ...r.bridge } };
    return r;
  }
}
