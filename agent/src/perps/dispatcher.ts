/**
 * Dispatch on HyperEVM — the third chain's twin of `dispatch/keeperDispatcher.ts` and `solana/dispatcher.ts`
 * (design §5, "dispatcher"). The keeper's whole on-chain surface is one `protect(rung, topUpE6, reduceSz)`
 * per rung, reached through the account's `execAsKeeper`, and this module:
 *   1. re-values the account NOW at the head (a resumed record never acts on the valuation that created it);
 *   2. reads BOTH grants as the venue will judge them — the account's `Permission` on (venue, protect) with
 *      `allowCallback`, and the venue's `PerpGrant` (keeper, expiry, epoch, rungs, budgets after the period
 *      roll) — and surfaces them to the store;
 *   3. sizes the action with `policy.ts`;
 *   4. SIMULATES `execAsKeeper([{venue, protect(...)}])` from the keeper address — a revert is read by name and
 *      classified: permanent when only the owner can clear it, superseding when the world moved, refused when
 *      a budget or the reserve binds, failed otherwise;
 *   5. persists the nonce AND the intent (what was asked, the size and reserve it was asked against) BEFORE
 *      broadcasting, sends, and returns SENT;
 *   6. `confirm` on a later tick: the receipt, then — because a CoreWriter action lands on HyperCore seconds
 *      after the receipt and cannot revert it — at least `actionDelayBlocks` more blocks, then a re-read of the
 *      position and the spot reserve judged against the intent. An IOC that did not fill is CONFIRMED with the
 *      shortfall said: it is a rung that re-arms and re-plans, not a failure (design §5), and the budget it
 *      charged is said too.
 * Without a keeper key the observe-only dispatcher delivers `notify` rungs and REFUSES every action by name.
 */
import { BaseError, ContractFunctionRevertedError, encodeFunctionData, type Account, type Chain, type PublicClient, type Transport, type WalletClient } from "viem";
import { PERP_RUNG_INDEX, perpLadderFor, type HfRungId } from "@zyo/shared";
import { hyperliquidPerpVenueAbi, oilskinAccountAbi } from "../abi/oilskin.js";
import type { Logger } from "../log.js";
import { eventNow, type Notifier } from "../notify/notifier.js";
import { AbortedError, withDeadline } from "../services/deadline.js";
import type { DispatchRecord } from "../store/keeperStore.js";
import type { Address, Hex } from "../types/evm.js";
import { planPerpProtect, type PerpGrantBounds, type PerpProtectPlan, type PerpRungTarget } from "./policy.js";
import type { PerpsGrantReads, PerpsReader } from "./reader.js";
import { evaluatePerps, spotToE6, type PerpsValuation, type PerpsValuationParams } from "./valuation.js";

export type PerpsDispatchRecord = DispatchRecord<Address, Hex>;
export type PerpIntent = NonNullable<PerpsDispatchRecord["perp"]>;

export type PerpsDispatchResult =
  | { status: "NOTIFIED" }
  | { status: "LOGGED_ONLY"; reason: string }
  | { status: "SENT"; txHash: Hex; note?: string }
  | { status: "CONFIRMED"; txHash: Hex; note?: string }
  | { status: "REFUSED"; reason: string; permanent?: boolean }
  | { status: "SUPERSEDED"; reason: string }
  | { status: "FAILED"; error: string; permanent?: boolean };

export interface PerpsGrantSnapshot {
  live: boolean;
  /** Why not, when not. */
  why?: string;
  expiry: number;
  allowedRungs: number;
  topUpLeft: bigint;
  reduceLeft: bigint;
  reduceAllowed: boolean;
  maxSlippageBps: number;
}

export interface PerpsDispatchIntent {
  record: PerpsDispatchRecord;
  /** Persist the nonce and the intent BEFORE the broadcast (audit C-MED-1's rule). Rejecting fails closed. */
  persistBeforeSend?: (info: { nonce?: number; perp: PerpIntent; plan: PerpProtectPlan }) => Promise<void>;
  onGrantRead?: (g: PerpsGrantSnapshot) => void;
}

export interface PerpsDispatcher {
  dispatch(intent: PerpsDispatchIntent, signal?: AbortSignal): Promise<PerpsDispatchResult>;
  confirm(record: PerpsDispatchRecord, signal?: AbortSignal): Promise<PerpsDispatchResult>;
}

/** ABI for the `execAsKeeper` simulation and send: the account's functions plus every error the venue can bubble. */
export const perpKeeperExecAbi = [...oilskinAccountAbi, ...hyperliquidPerpVenueAbi] as const;

/** Refusals only the OWNER can clear (a re-grant, a re-record, a new period): retrying them is noise. */
const PERMANENT_REFUSALS = new Set(["NotGranted", "NotActivePeripheral", "CallbackNotPermitted", "UnbudgetableSelector", "NotGrantedKeeper", "GrantExpired", "GrantEpochStale", "RungNotAllowed", "NoEntry", "NotKeeperPath", "ReduceNotAllowedAtRung"]);
/** The world moved between valuation and send: re-evaluate rather than retry the same plan. */
const SUPERSEDING = new Set(["RungNotCrossed", "NoPosition"]);
/** A bound that binds this tick and may not next: the plan is re-sized on the next tick. */
const TRANSIENT_REFUSALS = new Set(["TopUpBudgetExceeded", "ReduceBudgetExceeded", "ReserveShort", "ReduceExceedsPosition", "NothingToDo", "OtherPositionsOpen", "OrderBelowMinimum"]);

function revertName(e: unknown): { name: string; args: readonly unknown[] } | null {
  if (!(e instanceof BaseError)) return null;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (!r) return null;
  return { name: r.data?.errorName ?? r.reason ?? (r.signature ? `revert ${r.signature}` : "revert"), args: r.data?.args ?? [] };
}

function errMsg(e: unknown): string {
  if (e instanceof BaseError) return `${e.name}: ${e.shortMessage}`;
  return e instanceof Error ? `${e.name}: ${e.message.split("\n")[0]}` : String(e);
}

const fmtArgs = (args: readonly unknown[]): string => args.map((a) => (typeof a === "bigint" ? a.toString() : String(a))).join(", ");

/**
 * The two grants, judged as `execAsKeeper` → `protect` will judge them at chain time `nowS`: the account's
 * Permission (active, unexpired, with the callback right the venue needs to act back on the account) and the
 * venue's PerpGrant (this keeper, unexpired, the account's current epoch), with the budgets after the roll
 * `_rollPeriod` would apply. Exported for the tests.
 */
export function perpGrantBounds(reads: PerpsGrantReads, keeper: Address, nowS: bigint): PerpsGrantSnapshot {
  const { permission: p, grant: g } = reads;
  const now = Number(nowS);
  let why: string | undefined;
  if (!p.active) why = "no Permission on (venue, protect) for this keeper";
  else if (p.expiry <= now) why = `the Permission expired at ${p.expiry}`;
  else if (!p.allowCallback) why = "the Permission lacks allowCallback — the venue acts back on the account and protect would revert NotActivePeripheral (a mis-issued grant)";
  else if (g.keeper !== keeper.toLowerCase()) why = g.keeper === "0x0000000000000000000000000000000000000000" ? "no PerpGrant on the venue for this account" : `the PerpGrant names another keeper (${g.keeper})`;
  else if (g.expiry <= now) why = `the PerpGrant expired at ${g.expiry}`;
  else if (g.epoch !== reads.accountEpoch) why = `the PerpGrant is of epoch ${g.epoch}, the account is at ${reads.accountEpoch} (revokeAll)`;
  const rolled = now >= g.periodStart + g.period;
  const topUpSpent = rolled ? 0n : g.topUpSpent < g.topUpUsdcPerPeriod ? g.topUpSpent : g.topUpUsdcPerPeriod;
  const reduceSpent = rolled ? 0n : g.reduceSpent < g.reduceSzPerPeriod ? g.reduceSpent : g.reduceSzPerPeriod;
  return {
    live: why === undefined,
    why,
    expiry: Math.min(p.expiry, g.expiry),
    allowedRungs: g.allowedRungs,
    topUpLeft: g.topUpUsdcPerPeriod - topUpSpent,
    reduceLeft: g.reduceSzPerPeriod - reduceSpent,
    reduceAllowed: g.reduceSzPerPeriod > 0n,
    maxSlippageBps: g.maxSlippageBps,
  };
}

export interface KeeperPerpsDispatcherDeps {
  client: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
  keeper: Address;
  venue: Address;
  reader: PerpsReader;
  valuationParams: PerpsValuationParams;
  deriskFractionBps: number;
  planMarginBps: number;
  /** Blocks after the receipt before a CoreWriter action is judged by a read (design §5). */
  actionDelayBlocks: number;
  deadlineMs: number;
  log: Logger;
  notifier?: Notifier;
  now?: () => Date;
}

export class KeeperPerpsDispatcher implements PerpsDispatcher {
  private readonly now: () => Date;
  constructor(private readonly d: KeeperPerpsDispatcherDeps) {
    this.now = d.now ?? (() => new Date());
  }

  private call<T>(label: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    return withDeadline(label, this.d.deadlineMs, signal, work);
  }

  async dispatch(intent: PerpsDispatchIntent, signal?: AbortSignal): Promise<PerpsDispatchResult> {
    const { record } = intent;
    const log = this.d.log.child({ key: record.key, account: record.account });
    if (record.action === "notify") return this.notify(record, log);

    const account = record.account;
    const rungIx = PERP_RUNG_INDEX[record.rung as HfRungId];
    if (rungIx === undefined || rungIx === 0) return { status: "REFUSED", permanent: true, reason: `rung ${record.rung} is not one the venue acts on` };

    // 1. Re-value now, at the head.
    const head = await this.d.reader.head(signal);
    const snap = await this.d.reader.snapshot(account, head, signal);
    const valuation: PerpsValuation = evaluatePerps(snap, this.d.valuationParams);
    if (valuation.kind === "NO_POSITION") return { status: "SUPERSEDED", reason: "no short left to protect" };
    if (valuation.kind === "UNKNOWN") return { status: "FAILED", error: `valuation UNKNOWN before send: ${valuation.reasons.join("; ")}` };
    // The disarm level is the ACCOUNT's (the monitor derived its ladder from the recorded entry and wrote the
    // level on the record); the floor's ladder only for a record from before that.
    const disarmHfBps = record.disarmHf !== undefined ? Math.round(record.disarmHf * 10_000) : perpLadderFor(snap.params.minEntryDistanceBps)[rungIx]!.disarmHfBps;
    const rung: PerpRungTarget = { index: rungIx, disarmHfBps };
    if (valuation.hfBps >= disarmHfBps) return { status: "SUPERSEDED", reason: `HF ${(valuation.hfBps / 10_000).toFixed(4)} already at or above the disarm level ${(disarmHfBps / 10_000).toFixed(4)}` };
    if (!valuation.entry) return { status: "REFUSED", permanent: true, reason: "the venue holds no entry record for this account — protect reverts NoEntry; any owner action (addMargin, reduce, withdrawToEvm) re-records it" };

    // 2. Both grants, as the venue will judge them.
    let grants: PerpsGrantReads;
    try {
      grants = await this.d.reader.grants(account, this.d.keeper, head.number, signal);
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      return { status: "FAILED", error: `grant read failed: ${errMsg(e)}` };
    }
    const bounds = perpGrantBounds(grants, this.d.keeper, head.timestamp);
    intent.onGrantRead?.(bounds);
    if (!bounds.live) return { status: "REFUSED", permanent: true, reason: bounds.why! };

    // 3. Size the action.
    const grant: PerpGrantBounds = { live: true, allowedRungs: bounds.allowedRungs, topUpLeft: bounds.topUpLeft, reduceLeft: bounds.reduceLeft, reduceAllowed: bounds.reduceAllowed, maxSlippageBps: bounds.maxSlippageBps };
    const plan = planPerpProtect({ valuation, rung, grant, deriskFractionBps: this.d.deriskFractionBps, marginBps: this.d.planMarginBps });
    if (plan.kind === "refused") return { status: "REFUSED", permanent: plan.permanent, reason: plan.reason };
    log.info("plan", { rung: plan.rung, topUpE6: plan.topUpE6.toString(), reduceSz: plan.reduceSz.toString(), size: valuation.size.toString(), distanceBps: valuation.distanceBps, expectedDistanceBps: plan.expectedDistanceBps, expectedHf: (plan.expectedHfBps / 10_000).toFixed(4), note: plan.note });

    // 4. Simulate from the keeper address; classify a revert by name.
    const calls = [{ target: this.d.venue, value: 0n, data: encodeFunctionData({ abi: hyperliquidPerpVenueAbi, functionName: "protect", args: [plan.rung, plan.topUpE6, plan.reduceSz] }), callback: false }] as const;
    try {
      await this.call("simulate execAsKeeper(protect)", signal, () =>
        this.d.client.simulateContract({ address: account, abi: perpKeeperExecAbi, functionName: "execAsKeeper", args: [[...calls]], account: this.d.keeper })
      );
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      const r = revertName(e);
      const detail = r ? `${r.name}(${fmtArgs(r.args)})` : errMsg(e);
      if (r && PERMANENT_REFUSALS.has(r.name)) return { status: "REFUSED", permanent: true, reason: `simulation refused: ${detail}` };
      if (r && SUPERSEDING.has(r.name)) return { status: "SUPERSEDED", reason: `simulation refused: ${detail}` };
      if (r && TRANSIENT_REFUSALS.has(r.name)) return { status: "REFUSED", permanent: false, reason: `simulation refused: ${detail}` };
      return { status: "FAILED", error: `simulation failed: ${detail}` };
    }

    // 5. Persist the nonce and the intent before the broadcast.
    let nonce: number | undefined;
    try {
      nonce = await this.call("getTransactionCount", signal, () => this.d.client.getTransactionCount({ address: this.d.keeper, blockTag: "pending" }));
    } catch {
      nonce = undefined;
    }
    const perp: PerpIntent = { rung: plan.rung, topUpE6: plan.topUpE6.toString(), reduceSz: plan.reduceSz.toString(), sziBefore: valuation.szi.toString(), spotE6Before: valuation.spotE6.toString() };
    if (intent.persistBeforeSend) {
      try {
        await intent.persistBeforeSend({ nonce, perp, plan });
      } catch (e) {
        return { status: "FAILED", error: `refusing to send: the pre-send store write failed (${errMsg(e)})` };
      }
    }
    log.warn("sending execAsKeeper(protect)", { rung: plan.rung, topUpE6: plan.topUpE6.toString(), reduceSz: plan.reduceSz.toString(), nonce });
    let txHash: Hex;
    try {
      txHash = await this.call("writeContract execAsKeeper", signal, () =>
        this.d.wallet.writeContract({ address: account, abi: perpKeeperExecAbi, functionName: "execAsKeeper", args: [[...calls]], nonce, account: this.d.wallet.account, chain: this.d.wallet.chain })
      );
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      return { status: "FAILED", error: `send failed: ${errMsg(e)}` };
    }
    return { status: "SENT", txHash };
  }

  /**
   * The receipt, then the CoreWriter delay, then the judgement: the position moved by `reduceSz` and the spot
   * reserve by `topUpE6`, or it did not, and the record says which (design §5). A record without an intent
   * (written before this build) is confirmed on the receipt alone, and says so.
   */
  async confirm(record: PerpsDispatchRecord, signal?: AbortSignal): Promise<PerpsDispatchResult> {
    if (!record.txHash) return { status: "FAILED", error: "confirm called without txHash" };
    let receipt;
    try {
      receipt = await this.call("getTransactionReceipt", signal, () =>
        this.d.client.getTransactionReceipt({ hash: record.txHash! }).catch((e: unknown) => {
          if (e instanceof BaseError && /not be found|not found/i.test(e.shortMessage)) return null;
          throw e;
        })
      );
    } catch (e) {
      if (e instanceof AbortedError) throw e;
      return { status: "FAILED", error: `receipt read failed: ${errMsg(e)}` };
    }
    if (!receipt) return { status: "SENT", txHash: record.txHash };
    if (receipt.status !== "success") return { status: "FAILED", error: `transaction ${record.txHash} reverted on chain after a clean simulation — the grant or the world moved between the two; re-evaluated on the next attempt` };

    const head = await this.d.reader.head(signal);
    const due = receipt.blockNumber + BigInt(this.d.actionDelayBlocks);
    if (head.number < due) {
      return { status: "SENT", txHash: record.txHash, note: `receipt at block ${receipt.blockNumber}; waiting ${due - head.number} more block(s) for the CoreWriter action to land before judging it` };
    }
    if (!record.perp) return { status: "CONFIRMED", txHash: record.txHash, note: "no intent on the record (written before D4): confirmed on the receipt alone, not on what landed" };

    const snap = await this.d.reader.snapshot(record.account, head, signal);
    if (!snap.position || !snap.spot) return { status: "FAILED", error: `cannot judge what landed: ${snap.readFailures.map((f) => `${f.what} (${f.reason})`).join("; ") || "the position or spot balance did not read"}` };
    const sizeBefore = -BigInt(record.perp.sziBefore);
    const sizeNow = snap.position.szi < 0n ? -snap.position.szi : 0n;
    const closed = sizeBefore - sizeNow;
    const reduceWanted = BigInt(record.perp.reduceSz);
    const topUpWanted = BigInt(record.perp.topUpE6);
    const spotNow = spotToE6(snap.spot.total, snap.params.usdcWeiDecimals, snap.params.usdcEvmDecimals);
    const spotFell = BigInt(record.perp.spotE6Before) - spotNow;

    const missed: string[] = [];
    const landed: string[] = [];
    if (reduceWanted > 0n) {
      if (closed >= reduceWanted) landed.push(`reduce of ${reduceWanted} filled (size ${sizeBefore} → ${sizeNow})`);
      else if (closed > 0n) missed.push(`the reduce-only IOC filled ${closed} of ${reduceWanted} (size ${sizeBefore} → ${sizeNow})`);
      else missed.push(`the reduce-only IOC of ${reduceWanted} did not fill (size still ${sizeNow})`);
    }
    if (topUpWanted > 0n) {
      if (spotFell >= topUpWanted) landed.push(`top-up of ${topUpWanted} moved (spot ${record.perp.spotE6Before} → ${spotNow})`);
      else missed.push(`the top-up of ${topUpWanted} did not move (spot ${record.perp.spotE6Before} → ${spotNow})`);
    }
    if (missed.length === 0) return { status: "CONFIRMED", txHash: record.txHash, note: landed.length ? landed.join("; ") : undefined };
    // CONFIRMED and said, not FAILED: the EVM transaction succeeded and the grant's budget was charged; the
    // rung re-arms on the next tick and re-plans against what is there (design §5). The owner is told.
    return {
      status: "CONFIRMED",
      txHash: record.txHash,
      note: `did not land on HyperCore within ${this.d.actionDelayBlocks} block(s): ${missed.join("; ")}${landed.length ? `; landed: ${landed.join("; ")}` : ""} — the rung re-arms and re-plans; the grant's budget was charged for what was asked`,
    };
  }

  private async notify(record: PerpsDispatchRecord, log: Logger): Promise<PerpsDispatchResult> {
    let delivery: { personReached: boolean } = { personReached: false };
    const distancePct = record.hf > 0 ? ((1 - 1 / record.hf) * 100).toFixed(2) : null;
    try {
      delivery = (await this.d.notifier?.deliver(eventNow({ kind: "notify", severity: "warn", account: record.account, rung: record.rung, action: record.action, hf: record.hf, key: record.key, detail: { chain: "hyperevm", distancePct, copy: distancePct ? `your short is ${distancePct} % from liquidation` : undefined } }, this.now))) ?? { personReached: false };
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
export class PerpsObserveOnlyDispatcher implements PerpsDispatcher {
  constructor(
    private readonly log: Logger,
    private readonly notifier?: Notifier,
    private readonly now: () => Date = () => new Date()
  ) {}
  async dispatch({ record }: PerpsDispatchIntent): Promise<PerpsDispatchResult> {
    if (record.action === "notify") {
      let delivery: { personReached: boolean } = { personReached: false };
      const distancePct = record.hf > 0 ? ((1 - 1 / record.hf) * 100).toFixed(2) : null;
      try {
        delivery = (await this.notifier?.deliver(eventNow({ kind: "notify", severity: "warn", account: record.account, rung: record.rung, action: record.action, hf: record.hf, key: record.key, detail: { mode: "observe-only", chain: "hyperevm", distancePct } }, this.now))) ?? { personReached: false };
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
    return { status: "REFUSED", permanent: true, reason: "observe-only mode: no KEEPER_PERPS_PRIVATE_KEY configured" };
  }
  async confirm(): Promise<PerpsDispatchResult> {
    return { status: "REFUSED", permanent: true, reason: "observe-only mode: nothing was ever sent" };
  }
}
