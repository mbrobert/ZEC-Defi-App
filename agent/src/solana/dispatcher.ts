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
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmRawTransaction, type Commitment } from "@solana/web3.js";
import type { DispatchRecord } from "../store/keeperStore.js";
import type { Logger } from "../log.js";
import { eventNow, type Notifier } from "../notify/notifier.js";
import { AbortedError, withDeadline } from "../services/deadline.js";
import { PK, accountPda, anchorErrorName, ata, grantPda, grantRemaining, ixKeeperProtect, ixSplTransfer, obligationPda } from "./layouts.js";
import { planProtect, type ProtectPlan, type RungTarget } from "./policy.js";
import type { SolanaReader } from "./reader.js";
import { evaluateSolana, type SolanaValuation, type SolanaValuationParams } from "./valuation.js";

export type SolanaDispatchRecord = DispatchRecord<string, string>;

export type SolanaDispatchResult =
  | { status: "NOTIFIED" }
  | { status: "LOGGED_ONLY"; reason: string }
  | { status: "SENT"; signature: string }
  | { status: "CONFIRMED"; signature: string; note?: string }
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

    // 3. Size it.
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

  async confirm(record: SolanaDispatchRecord, signal?: AbortSignal): Promise<SolanaDispatchResult> {
    if (!record.txHash) return { status: "FAILED", error: "no signature on the record" };
    const st = await withDeadline("getSignatureStatuses", this.d.confirmTimeoutMs, signal, () => this.d.connection.getSignatureStatuses([record.txHash!], { searchTransactionHistory: true }));
    const v = st.value[0];
    if (!v) return { status: "FAILED", error: "signature not found (blockhash likely expired); re-evaluate and re-send" };
    if (v.err) return { status: "FAILED", error: `transaction failed on chain: ${JSON.stringify(v.err)}` };
    if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") return { status: "CONFIRMED", signature: record.txHash };
    return { status: "SENT", signature: record.txHash };
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
