/**
 * Dispatch on Solana — the twin of `dispatch/keeperDispatcher.ts` and `dispatch/observeOnly.ts`.
 *
 * The keeper's whole on-chain surface is one `keeper_protect` per rung, and this module:
 *   1. re-values the account NOW (a resumed record never acts on the valuation that created it);
 *   2. reads the keeper's grant as the program will judge it (live?, budgets after the period roll) and
 *      surfaces it to the store;
 *   3. sizes the action with `policy.ts` (repay-only from the Account's idle USDC, or a sale where the keeper
 *      pays USDC in and takes ZEC at the Scope price);
 *   4. builds ONE transaction: compute budget · [USDC keeper → Account] · keeper_protect; signs it, SIMULATES
 *      it (a program refusal is read by name and classified — permanent when only the user can clear it),
 *      persists the signature BEFORE broadcasting, sends, and waits for confirmation inside the deadline;
 *   5. after a sale, collects the delegated ZEC into the keeper's own token account in a second transaction —
 *      best-effort, never a reason to call the protection failed: the delegation is the keeper's to pull later.
 * Without a keeper key the observe-only dispatcher delivers `notify` rungs and REFUSES every action by name.
 */
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction, sendAndConfirmRawTransaction, type AddressLookupTableAccount, type Commitment } from "@solana/web3.js";
import { CCTP_DOMAINS } from "@zyo/shared";
import type { DispatchRecord } from "../store/keeperStore.js";
import type { Logger } from "../log.js";
import { eventNow, type Notifier } from "../notify/notifier.js";
import { AbortedError, withDeadline } from "../services/deadline.js";
import type { BridgeInfo, BurnResult } from "../dispatch/types.js";
import type { Address } from "../types/evm.js";
import { PK, accountPda, anchorErrorName, ata, grantPda, grantRemaining, ixKeeperProtect, ixSplTransfer, obligationPda } from "./layouts.js";
import type { CircleAttestationClient } from "./attestation.js";
import { decodeFeeRecipient, feeRecipientTokenAccount, ixReceiveMessage, tokenMessengerPda, usedNoncePda } from "./delivery.js";
import { bridgeDecision, unreadPair, type PairReader, type PairView } from "./pair.js";
import { planProtect, usdcNeededFor, type ProtectPlan, type RungTarget } from "./policy.js";
import type { SolanaReader } from "./reader.js";
import { evaluateSolana, type SolanaValuation, type SolanaValuationParams } from "./valuation.js";

export type SolanaDispatchRecord = DispatchRecord<string, string>;

export type SolanaDispatchResult =
  | { status: "NOTIFIED" }
  | { status: "LOGGED_ONLY"; reason: string }
  /** `bridge` is set when the rung was answered on Base (a burn home, A5.2); `signature` is then the Base hash. */
  | { status: "SENT"; signature: string; bridge?: BridgeInfo }
  | { status: "CONFIRMED"; signature: string; note?: string; bridge?: BridgeInfo }
  | { status: "REFUSED"; reason: string; permanent?: boolean }
  | { status: "SUPERSEDED"; reason: string }
  | { status: "FAILED"; error: string };

export interface SolanaGrantSnapshot {
  live: boolean;
  expiry: number;
  repayLeft: bigint;
  sellLeft: bigint;
  allowedRungs: number;
}

export interface SolanaDispatchIntent {
  record: SolanaDispatchRecord;
  /** Persist the signature BEFORE the broadcast (the twin of the persisted nonce). Rejecting fails closed. */
  persistBeforeSend?: (info: { signature: string; plan: ProtectPlan }) => Promise<void>;
  onGrantRead?: (g: SolanaGrantSnapshot) => void;
  /** The pair as read this dispatch, for the account record (A5.2). */
  onPairRead?: (p: PairView) => void;
  /** Age (s) of the youngest Base burn still in flight for this account, or null (the monitor reads the store). */
  inFlightAgeS?: number | null;
}

/**
 * The Base side of a paired account's rung (SOLANA-ARCHITECTURE §14.6–14.7): closes the Base leg and burns
 * USDC home. Injected — a process holding a Base key wires `KeeperDispatcher.dispatchBurn`; Stream C's
 * two-key process is where that happens in production. Absent = the single-chain path for every rung.
 */
export interface BaseBurner {
  dispatch(input: { record: SolanaDispatchRecord; baseAccount: Address; expectedRecipient: `0x${string}`; usdcNeeded: bigint; action: "burn-derisk" | "burn-emergency" }, signal?: AbortSignal): Promise<BurnResult>;
  confirm(record: SolanaDispatchRecord, signal?: AbortSignal): Promise<BurnResult>;
}

export interface SolanaDispatcher {
  dispatch(intent: SolanaDispatchIntent, signal?: AbortSignal): Promise<SolanaDispatchResult>;
  confirm(record: SolanaDispatchRecord, signal?: AbortSignal): Promise<SolanaDispatchResult>;
}

/** Program refusals only the USER can clear (a re-grant, a new period): retrying them is noise. */
const PERMANENT_REFUSALS = new Set(["GrantNotLive", "RungNotAllowed", "RungIsNotifyOnly", "UnknownRung"]);
/** The world moved between valuation and send: re-evaluate rather than retry the same plan. */
const SUPERSEDING = new Set(["RungNotCrossed", "RungUnderstated"]);

export interface KeeperSolanaDispatcherDeps {
  connection: Connection;
  reader: SolanaReader;
  programId: PublicKey;
  keeper: Keypair;
  /** Program-side rung index → disarm level, from the shared ladder. */
  rungs: readonly RungTarget[];
  /** Rung id (string, e.g. "repay") → program rung index. */
  rungIndex: (rungId: string) => number | undefined;
  valuationParams: SolanaValuationParams;
  saleDiscountBps: number;
  keeperMaxSaleUsdc: bigint;
  planMarginBps: number;
  confirmTimeoutMs: number;
  idlErrors: readonly { code: number; name: string }[];
  log: Logger;
  notifier?: Notifier;
  now?: () => Date;
  /** Reads the Base half of the pair (`solanaRecipient` on the router); null = never read, every account "unknown"/"unlinked". */
  pair?: PairReader | null;
  /** The Base burner for linked pairs at rungs 3–4; null = the single-chain path. */
  baseBurner?: BaseBurner | null;
  /** Circle's attestation service; null = a burn can be sent and confirmed but never delivered (it waits). */
  attestation?: CircleAttestationClient | null;
  /**
   * The address lookup table a delivery rides. `receive_message` carries 21 accounts plus Circle's message and
   * signatures — **1,264 bytes as a legacy transaction against the 1,232 limit**, measured on localnet
   * 2026-09-13 — so it must be a v0 transaction. The table is created once at deploy (`SOLANA-DEPLOY.md`);
   * without one the delivery is refused by name rather than sent and rejected for its size.
   */
  cctpLookupTable?: PublicKey | null;
  /** How long a Base burn may be in flight before the single-chain path takes over (s). */
  bridgeStallS?: number;
  commitment?: Commitment;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
}

export class KeeperSolanaDispatcher implements SolanaDispatcher {
  private readonly now: () => Date;
  constructor(private readonly d: KeeperSolanaDispatcherDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async dispatch(intent: SolanaDispatchIntent, signal?: AbortSignal): Promise<SolanaDispatchResult> {
    const { record } = intent;
    const log = this.d.log.child({ key: record.key, account: record.account });
    if (record.action === "notify") return this.notify(record, log);

    const account = new PublicKey(record.account);
    const rungIx = this.d.rungIndex(record.rung);
    if (rungIx === undefined) return { status: "REFUSED", permanent: true, reason: `unknown rung ${record.rung}` };
    // The disarm level is the ACCOUNT's (the monitor derived its ladder from the recorded entry HF and wrote
    // the level on the record); the floor ladder's only for a record from before that.
    const rung: RungTarget = { id: rungIx, disarmHf: record.disarmHf ?? this.d.rungs[rungIx].disarmHf };

    // 1. Re-value now.
    const view = await this.readUserAccount(account, signal);
    if (!view) return { status: "REFUSED", permanent: true, reason: "account no longer exists on chain" };
    const snap = await this.d.reader.snapshot(account, view, this.d.keeper.publicKey, signal);
    const valuation: SolanaValuation = evaluateSolana(snap, this.d.valuationParams);
    if (valuation.kind === "NO_DEBT") return { status: "SUPERSEDED", reason: "no debt left to protect" };
    if (valuation.kind === "UNKNOWN") return { status: "FAILED", error: `valuation UNKNOWN before send: ${valuation.reasons.join("; ")}` };
    if (!(valuation.hf < rung.disarmHf)) return { status: "SUPERSEDED", reason: `HF ${valuation.hf.toFixed(4)} already at or above the disarm level ${rung.disarmHf}` };

    // 2. The grant as the program will judge it.
    const grant = await this.d.reader.readGrant(account, this.d.keeper.publicKey, signal);
    if (!grant) return { status: "REFUSED", permanent: true, reason: "no grant for this keeper on this account" };
    const rem = grantRemaining(grant, view.grantEpoch, snap.nowS);
    intent.onGrantRead?.({ live: rem.live, expiry: Number(grant.expiryTs), repayLeft: rem.repayLeft, sellLeft: rem.sellLeft, allowedRungs: grant.allowedRungs });
    if (!rem.live) return { status: "REFUSED", permanent: true, reason: "grant is not live (expired, revoked, or an older epoch)" };

    // 3. The pair, and which way this rung goes (A5.2, §14.7): rung 2 always on Solana; rungs 3–4 over the
    //    bridge for a linked pair with a burner and no burn already in flight; otherwise the single-chain path.
    const pair = this.d.pair ? await this.d.pair.read(account, view, signal) : unreadPair(account, view);
    intent.onPairRead?.(pair);
    const target = rung.disarmHf * (1 + this.d.planMarginBps / 10_000);
    const needed = usdcNeededFor(valuation, target);
    const decision = bridgeDecision({
      action: record.action,
      status: pair.status,
      burnerAvailable: !!this.d.baseBurner,
      inFlightAgeS: intent.inFlightAgeS ?? null,
      stallS: this.d.bridgeStallS ?? 1800,
      // What makes the five-step sequence end: once a delivery has landed, the Account's own USDC covers the
      // need and this rung is answered by the Solana repay instead of a second burn (§14.6, step 5).
      idleCoversNeed: valuation.idleUsdc >= needed,
    });
    log.info("route", { route: decision.route, reason: decision.reason, pair: pair.status, baseAccount: pair.baseAccount });
    if (decision.route === "wait") return { status: "REFUSED", reason: decision.reason };
    if (decision.route === "bridge" && pair.baseAccount) {
      if (needed === 0n) return { status: "SUPERSEDED", reason: "nothing is needed to reach the disarm level" };
      const r = await this.d.baseBurner!.dispatch({ record, baseAccount: pair.baseAccount, expectedRecipient: pair.expectedRecipient, usdcNeeded: needed, action: record.action === "emergency-unwind" ? "burn-emergency" : "burn-derisk" }, signal);
      return this.mapBurn(r);
    }

    // 4. Size the Solana action.
    const keeperUsdcBalance = await this.d.reader.tokenBalance(this.d.keeper.publicKey, PK.usdcMint, signal);
    const keeperUsdc = keeperUsdcBalance < this.d.keeperMaxSaleUsdc ? keeperUsdcBalance : this.d.keeperMaxSaleUsdc;
    const plan = planProtect({
      valuation,
      rung,
      grant: { live: rem.live, allowedRungs: grant.allowedRungs, repayLeft: rem.repayLeft, sellLeft: rem.sellLeft, maxSellSlippageBps: grant.maxSellSlippageBps },
      keeperUsdc,
      saleDiscountBps: this.d.saleDiscountBps,
      marginBps: this.d.planMarginBps,
    });
    if (plan.kind === "refused") return { status: "REFUSED", permanent: plan.permanent, reason: plan.reason };
    log.info("plan", { kind: plan.kind, repayUsdc: plan.repayUsdc.toString(), keeperUsdcIn: plan.keeperUsdcIn.toString(), sellZec: plan.sellZec.toString(), expectedHf: plan.expectedHf.toFixed(4), note: plan.note });

    // 4. Build, sign, simulate, persist, send, confirm.
    const keys = {
      program: this.d.programId,
      keeper: this.d.keeper.publicKey,
      account,
      grant: grantPda(this.d.programId, account, this.d.keeper.publicKey),
      obligation: obligationPda(account),
      accountZec: ata(account, PK.zecMint),
      accountUsdc: ata(account, PK.usdcMint),
    };
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
    if (plan.keeperUsdcIn > 0n) tx.add(ixSplTransfer(ata(this.d.keeper.publicKey, PK.usdcMint), keys.accountUsdc, this.d.keeper.publicKey, plan.keeperUsdcIn));
    tx.add(ixKeeperProtect(keys, plan.rungId, plan.repayUsdc, plan.sellZec));
    const { blockhash, lastValidBlockHeight } = await withDeadline("getLatestBlockhash", this.d.confirmTimeoutMs, signal, () => this.d.connection.getLatestBlockhash(this.d.commitment ?? "confirmed"));
    tx.recentBlockhash = blockhash;
    tx.feePayer = this.d.keeper.publicKey;
    tx.sign(this.d.keeper);
    const signature = tx.signatures[0]?.signature ? bs58(tx.signatures[0].signature) : null;
    if (!signature) return { status: "FAILED", error: "could not sign" };

    const sim = await withDeadline("simulateTransaction", this.d.confirmTimeoutMs, signal, () => this.d.connection.simulateTransaction(tx));
    if (sim.value.err) {
      const name = anchorErrorName(sim.value.logs, this.d.idlErrors);
      const detail = `${name ?? JSON.stringify(sim.value.err)}: ${(sim.value.logs ?? []).filter((l) => /Error|failed/.test(l)).slice(-2).join(" | ")}`;
      if (name && PERMANENT_REFUSALS.has(name)) return { status: "REFUSED", permanent: true, reason: detail };
      if (name && SUPERSEDING.has(name)) return { status: "SUPERSEDED", reason: detail };
      if (name === "RepayBudgetExceeded" || name === "SellBudgetExceeded") return { status: "REFUSED", permanent: false, reason: detail };
      return { status: "FAILED", error: `simulation refused: ${detail}` };
    }

    if (intent.persistBeforeSend) await intent.persistBeforeSend({ signature, plan });
    const raw = tx.serialize();
    try {
      await withDeadline("sendAndConfirm", this.d.confirmTimeoutMs, signal, () =>
        sendAndConfirmRawTransaction(this.d.connection, raw, { signature, blockhash, lastValidBlockHeight }, { commitment: this.d.commitment ?? "confirmed", skipPreflight: true })
      );
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      // It may still land: leave SENT for confirm() to settle.
      log.warn("sent, confirmation not seen inside the deadline", { signature, error: errMsg(e) });
      return { status: "SENT", signature };
    }
    log.info("confirmed", { signature });
    let note: string | undefined;
    if (plan.sellZec > 0n) note = await this.collect(account, log, signal);
    return { status: "CONFIRMED", signature, note };
  }

  /** A Base result in the Solana record's terms: the Base hash rides in `signature`, the bridge info beside it. */
  private mapBurn(r: BurnResult): SolanaDispatchResult {
    switch (r.status) {
      case "SENT":
        return { status: "SENT", signature: r.txHash, bridge: r.bridge };
      case "CONFIRMED":
        return { status: "CONFIRMED", signature: r.txHash, note: r.note, bridge: r.bridge };
      case "REFUSED":
        return { status: "REFUSED", reason: `Base burn: ${r.reason}`, permanent: r.permanent };
      case "FAILED":
        return { status: "FAILED", error: `Base burn: ${r.error}` };
      case "SUPERSEDED":
        return { status: "SUPERSEDED", reason: `Base burn: ${r.reason}` };
      case "NOTIFIED":
        return { status: "NOTIFIED" };
      case "LOGGED_ONLY":
        return { status: "LOGGED_ONLY", reason: r.reason };
    }
  }

  /**
   * Drive a cross-chain rung one stage per call (`SOLANA-ARCHITECTURE.md` §14.6): the monitor re-enters a SENT
   * record every tick, so each stage is resumable and a crash between any two of them loses nothing.
   *
   *   burn-sent      → the Base receipt, which yields the nonce and the message bytes
   *   burn-confirmed → Circle's attestation (pending and not-found are waits, never failures)
   *   attested       → the delivery on Solana; a nonce Circle already recorded means someone else delivered it
   *   delivered      → done as a bridge; the rung then fires again and the Solana repay answers it
   */
  private async advanceBridge(record: SolanaDispatchRecord, signal?: AbortSignal): Promise<SolanaDispatchResult> {
    const b = record.bridge!;
    const log = this.d.log.child({ key: record.key, account: record.account, stage: b.stage });

    if (b.stage === "burn-sent") {
      if (!this.d.baseBurner) return { status: "FAILED", error: "a Base burn record with no Base burner to confirm it" };
      const r = await this.d.baseBurner.confirm(record, signal);
      if (r.status !== "CONFIRMED" || !r.bridge) return this.mapBurn(r);
      // The burn landed; the message still has to be attested and delivered, so the record stays open.
      log.info("burn confirmed on Base — waiting on Circle", { nonce: r.bridge.nonce, amount: r.bridge.amountUsdc });
      return { status: "SENT", signature: b.burnTxHash, bridge: { ...r.bridge, stage: "burn-confirmed" } };
    }

    if (b.stage === "burn-confirmed") {
      if (!this.d.attestation) return { status: "SENT", signature: b.burnTxHash, bridge: b };
      if (!b.nonce || !b.recipient) return { status: "FAILED", error: "a confirmed burn with no nonce or recipient on the record — cannot ask Circle for it" };
      const expect = { nonce: b.nonce as `0x${string}`, mintRecipient: b.recipient as `0x${string}`, amount: BigInt(b.amountUsdc), destinationDomain: CCTP_DOMAINS.solana };
      const att = await this.d.attestation.byNonce(CCTP_DOMAINS.base, b.nonce, expect, signal);
      if (att.kind === "mismatch") return { status: "FAILED", error: `Circle's message is not the burn we made: ${att.why}` };
      if (att.kind !== "complete") {
        const why = att.kind === "pending" ? `Circle has not attested it yet (${att.status}${att.delayReason ? `: ${att.delayReason}` : ""})` : att.kind === "not-found" ? "Circle has not indexed the burn yet" : att.why;
        log.info("waiting on the attestation", { why });
        return { status: "SENT", signature: b.burnTxHash, bridge: b };
      }
      log.info("attested — delivering", { deliveredAmount: att.deliveredAmount.toString(), feeExecuted: att.feeExecuted.toString() });
      const attested = { ...b, stage: "attested" as const, messageHex: att.messageHex, attestationHex: att.attestationHex, deliveredAmountUsdc: att.deliveredAmount.toString() };
      return this.deliver(record, attested, signal);
    }

    if (b.stage === "attested") return this.deliver(record, b, signal);

    return { status: "CONFIRMED", signature: b.deliveryTx ?? b.burnTxHash, note: `delivered ${b.deliveredAmountUsdc ?? b.amountUsdc} USDC on Solana; the repay is the next rung firing`, bridge: b };
  }

  /**
   * Step 4: hand Circle's attested bytes to the transmitter. The USDC lands where the BURN said, so this
   * transaction has no destination of its own; the keeper pays the used-nonce rent and the fee and is
   * otherwise a relayer. A nonce that is already recorded means the message was delivered by someone else —
   * which is a success, not a race lost.
   */
  private async deliver(record: SolanaDispatchRecord, b: NonNullable<SolanaDispatchRecord["bridge"]>, signal?: AbortSignal): Promise<SolanaDispatchResult> {
    const log = this.d.log.child({ key: record.key, account: record.account });
    if (!b.messageHex || !b.attestationHex) return { status: "FAILED", error: "an attested stage with no message or attestation on the record" };
    const message = Uint8Array.from(Buffer.from(b.messageHex.replace(/^0x/, ""), "hex"));
    const attestation = Uint8Array.from(Buffer.from(b.attestationHex.replace(/^0x/, ""), "hex"));
    const account = new PublicKey(record.account);
    const recipient = ata(account, PK.usdcMint);
    if (b.recipient && b.recipient.toLowerCase() !== `0x${Buffer.from(recipient.toBytes()).toString("hex")}`) {
      return { status: "REFUSED", permanent: true, reason: `the burn paid ${b.recipient}, which is not this Account's USDC token account` };
    }

    // Already delivered? The used-nonce account exists only because a delivery created it.
    let nonceKey: PublicKey;
    try {
      nonceKey = usedNoncePda(Uint8Array.from(Buffer.from((b.nonce ?? "").replace(/^0x/, ""), "hex")));
    } catch (e) {
      return { status: "FAILED", error: `the record's nonce is not 32 bytes: ${errMsg(e)}` };
    }
    const already = await withDeadline("getAccountInfo(used_nonce)", this.d.confirmTimeoutMs, signal, () => this.d.connection.getAccountInfo(nonceKey, "confirmed"));
    if (already) {
      log.info("the message was already delivered (its nonce is recorded) — nothing to send", { nonce: b.nonce });
      return { status: "CONFIRMED", signature: b.burnTxHash, note: `already delivered: Circle's nonce ${b.nonce} is recorded on chain`, bridge: { ...b, stage: "delivered" } };
    }

    const feeAta = await this.feeRecipientAta(signal);
    let ix;
    try {
      ix = ixReceiveMessage({ payer: this.d.keeper.publicKey, caller: this.d.keeper.publicKey, recipientTokenAccount: recipient, feeRecipientTokenAccount: feeAta }, message, attestation);
    } catch (e) {
      return { status: "FAILED", error: `the attested message cannot be delivered to this account: ${errMsg(e)}` };
    }
    const table = await this.lookupTable(signal);
    if (!table) {
      return {
        status: "REFUSED",
        permanent: true,
        reason:
          "the delivery needs an address lookup table: receive_message carries 21 accounts plus Circle's message and signatures, which is over the legacy transaction limit. Create the table at deploy (docs/SOLANA-DEPLOY.md) and set CCTP_LOOKUP_TABLE.",
      };
    }
    const { blockhash, lastValidBlockHeight } = await withDeadline("getLatestBlockhash", this.d.confirmTimeoutMs, signal, () => this.d.connection.getLatestBlockhash(this.d.commitment ?? "confirmed"));
    const v0 = new TransactionMessage({
      payerKey: this.d.keeper.publicKey,
      recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix],
    }).compileToV0Message([table]);
    const tx = new VersionedTransaction(v0);
    tx.sign([this.d.keeper]);
    const signature = tx.signatures[0] ? bs58(Buffer.from(tx.signatures[0])) : null;
    if (!signature) return { status: "FAILED", error: "could not sign the delivery" };

    const sim = await withDeadline("simulateTransaction(delivery)", this.d.confirmTimeoutMs, signal, () => this.d.connection.simulateTransaction(tx));
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).filter((l) => /Error|failed|insufficient/i.test(l)).slice(-3).join(" | ");
      // A nonce recorded between the read above and now is the same benign race.
      if (/already in use|NonceAlreadyUsed/i.test(logs)) {
        return { status: "CONFIRMED", signature: b.burnTxHash, note: "delivered by another sender while this one was building", bridge: { ...b, stage: "delivered" } };
      }
      return { status: "FAILED", error: `the delivery would fail: ${JSON.stringify(sim.value.err)} ${logs}` };
    }

    try {
      await withDeadline("sendAndConfirm(delivery)", this.d.confirmTimeoutMs, signal, () =>
        sendAndConfirmRawTransaction(this.d.connection, Buffer.from(tx.serialize()), { signature, blockhash, lastValidBlockHeight }, { commitment: this.d.commitment ?? "confirmed", skipPreflight: true })
      );
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      log.warn("delivery sent, confirmation not seen inside the deadline", { signature, error: errMsg(e) });
      return { status: "SENT", signature: b.burnTxHash, bridge: { ...b, deliveryTx: signature } };
    }
    log.info("delivered on Solana", { signature, amount: b.deliveredAmountUsdc ?? b.amountUsdc });
    return {
      status: "CONFIRMED",
      signature,
      note: `delivered ${b.deliveredAmountUsdc ?? b.amountUsdc} USDC to the Account (${signature}); the repay is the next rung firing`,
      bridge: { ...b, stage: "delivered", deliveryTx: signature },
    };
  }

  /** The lookup table the delivery rides, fetched once and cached; null when none is configured or it is gone. */
  private table: AddressLookupTableAccount | null = null;
  private async lookupTable(signal?: AbortSignal): Promise<AddressLookupTableAccount | null> {
    if (this.table) return this.table;
    if (!this.d.cctpLookupTable) return null;
    const res = await withDeadline("getAddressLookupTable", this.d.confirmTimeoutMs, signal, () => this.d.connection.getAddressLookupTable(this.d.cctpLookupTable!, { commitment: this.d.commitment ?? "confirmed" }));
    if (!res.value) {
      this.d.log.error("CCTP_LOOKUP_TABLE names no table on this cluster — deliveries cannot be sent", { table: this.d.cctpLookupTable.toBase58() });
      return null;
    }
    this.table = res.value;
    return this.table;
  }

  /** Circle's fee recipient token account, read from `token_messenger` on chain once and cached. */
  private feeAta: PublicKey | null = null;
  private async feeRecipientAta(signal?: AbortSignal): Promise<PublicKey> {
    if (this.feeAta) return this.feeAta;
    const info = await withDeadline("getAccountInfo(token_messenger)", this.d.confirmTimeoutMs, signal, () => this.d.connection.getAccountInfo(tokenMessengerPda(), "confirmed"));
    if (!info) throw new Error("CCTP token_messenger account not found on this cluster");
    this.feeAta = feeRecipientTokenAccount(decodeFeeRecipient(info.data), PK.usdcMint);
    return this.feeAta;
  }

  async confirm(record: SolanaDispatchRecord, signal?: AbortSignal): Promise<SolanaDispatchResult> {
    if (!record.txHash && !record.bridge) return { status: "FAILED", error: "no signature on the record" };
    if (record.bridge) return this.advanceBridge(record, signal);
    const signature = record.txHash!;
    const st = await withDeadline("getSignatureStatuses", this.d.confirmTimeoutMs, signal, () => this.d.connection.getSignatureStatuses([signature], { searchTransactionHistory: true }));
    const v = st.value[0];
    if (!v) return { status: "FAILED", error: "signature not found (blockhash likely expired); re-evaluate and re-send" };
    if (v.err) return { status: "FAILED", error: `transaction failed on chain: ${JSON.stringify(v.err)}` };
    if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") return { status: "CONFIRMED", signature };
    return { status: "SENT", signature };
  }

  /** Pull the ZEC a sale delegated to the keeper into the keeper's own token account. Best-effort. */
  async collect(account: PublicKey, log: Logger, signal?: AbortSignal): Promise<string | undefined> {
    try {
      const info = await this.d.connection.getAccountInfo(ata(account, PK.zecMint), "confirmed");
      if (!info || info.data.length < 165) return "collect: account ZEC token account unreadable";
      const hasDelegate = info.data.readUInt32LE(72) === 1;
      const delegate = hasDelegate ? new PublicKey(info.data.subarray(76, 108)) : null;
      const delegated = info.data.readBigUInt64LE(121);
      if (!delegate || !delegate.equals(this.d.keeper.publicKey) || delegated === 0n) return "collect: nothing delegated to this keeper";
      const tx = new Transaction().add(ixSplTransfer(ata(account, PK.zecMint), ata(this.d.keeper.publicKey, PK.zecMint), this.d.keeper.publicKey, delegated));
      const { blockhash, lastValidBlockHeight } = await this.d.connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = this.d.keeper.publicKey;
      tx.sign(this.d.keeper);
      const sig = bs58(tx.signatures[0]!.signature!);
      await withDeadline("collect", this.d.confirmTimeoutMs, signal, () => sendAndConfirmRawTransaction(this.d.connection, tx.serialize(), { signature: sig, blockhash, lastValidBlockHeight }, { commitment: "confirmed" }));
      log.info("collected delegated ZEC", { amount: delegated.toString(), signature: sig });
      return `collected ${delegated} ZEC base units (${sig})`;
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      log.warn("collect failed — the delegation persists and is pulled on a later tick", { error: errMsg(e) });
      return `collect failed: ${errMsg(e)}`;
    }
  }

  private async readUserAccount(account: PublicKey, signal?: AbortSignal) {
    const found = await this.d.reader.discover(signal);
    return found.find((f) => f.account.equals(account))?.view ?? null;
  }

  private async notify(record: SolanaDispatchRecord, log: Logger): Promise<SolanaDispatchResult> {
    let delivery: { personReached: boolean } = { personReached: false };
    try {
      delivery = (await this.d.notifier?.deliver(eventNow({ kind: "notify", severity: "warn", account: record.account, rung: record.rung, action: record.action, hf: record.hf, key: record.key, detail: { chain: "solana" } }, this.now))) ?? { personReached: false };
    } catch (e) {
      return { status: "FAILED", error: `notification not delivered: ${errMsg(e)}` };
    }
    if (!delivery.personReached) {
      log.warn("NOTIFY: health warning written to the keeper's own log/store only — nobody was told", { rung: record.rung, hf: record.hf });
      return { status: "LOGGED_ONLY", reason: "no person-facing channel accepted it (set NOTIFY_WEBHOOK_URL)" };
    }
    return { status: "NOTIFIED" };
  }
}

/** Observe-only: the ladder runs and every firing is recorded; `notify` is delivered; every action is REFUSED by name. */
export class SolanaObserveOnlyDispatcher implements SolanaDispatcher {
  constructor(
    private readonly log: Logger,
    private readonly notifier?: Notifier,
    private readonly now: () => Date = () => new Date()
  ) {}
  async dispatch({ record }: SolanaDispatchIntent): Promise<SolanaDispatchResult> {
    if (record.action === "notify") {
      let delivery: { personReached: boolean } = { personReached: false };
      try {
        delivery = (await this.notifier?.deliver(eventNow({ kind: "notify", severity: "warn", account: record.account, rung: record.rung, action: record.action, hf: record.hf, key: record.key, detail: { mode: "observe-only", chain: "solana" } }, this.now))) ?? { personReached: false };
      } catch (e) {
        return { status: "FAILED", error: `notification not delivered: ${errMsg(e)}` };
      }
      if (!delivery.personReached) {
        this.log.warn("NOTIFY: health warning written to the keeper's own log/store only — nobody was told", { account: record.account, rung: record.rung, hf: record.hf, key: record.key });
        return { status: "LOGGED_ONLY", reason: "no person-facing channel accepted it (set NOTIFY_WEBHOOK_URL); the keeper's own log and store are not a notification" };
      }
      this.log.warn("NOTIFY: health warning", { account: record.account, rung: record.rung, hf: record.hf, key: record.key });
      return { status: "NOTIFIED" };
    }
    return { status: "REFUSED", permanent: true, reason: "observe-only mode: no KEEPER_SOLANA_KEYPAIR configured" };
  }
  async confirm(): Promise<SolanaDispatchResult> {
    return { status: "REFUSED", permanent: true, reason: "observe-only mode: nothing was ever sent" };
  }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function bs58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    s = "1" + s;
  }
  return s;
}
export { accountPda };
