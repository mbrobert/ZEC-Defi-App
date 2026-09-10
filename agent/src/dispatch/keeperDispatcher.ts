import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionResult,
  parseEventLogs,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import {
  clPoolAbi,
  erc20BalanceAbi,
  lpVenueAbi,
  oilskinAccountAbi,
  strategyRouterAbi,
  swapAdapterAbi,
  GRANT_SELECTORS,
} from "../abi/oilskin.js";
import type { LadderRung } from "../engine/ladder.js";
import { WAD, type Valuation } from "../engine/valuation.js";
import type { Logger } from "../log.js";
import { eventNow, type Notifier } from "../notify/notifier.js";
import { readTickContexts, valueAccount } from "../services/accountValuer.js";
import type { AaveReader } from "../services/chain.js";
import { withDeadline } from "../services/deadline.js";
import type { VenueReader } from "../services/venues.js";
import type { DispatchRecord, VenueBook } from "../store/keeperStore.js";
import type { Address } from "../types/evm.js";
import { planAction, type KeeperCall, type PlannedPosition, type PoolInfo } from "./policy.js";
import { quoteForPool, NO_SWAP, type SwapQuote } from "./quote.js";
import type { DispatchIntent, DispatchResult, Dispatcher, OkValuation } from "./types.js";

/**
 * The only component that signs anything. Every dispatch:
 *   1. re-checks the WORLD (fresh valuation, at CHAIN time) — never acts on a
 *      stale reason. NO_DEBT or HF ≥ the rung's disarm ⇒ SUPERSEDED;
 *      UNKNOWN ⇒ REFUSED;
 *   2. reads the ONE grant the plan can need — `StrategyRouter.unwind` — with
 *      its whole tuple: active, expiry and `allowCallback`. A grant without
 *      `allowCallback` is a MIS-ISSUED GRANT, not a market condition: the
 *      router acts back on the account and the call would revert
 *      `NotActivePeripheral()` inside the router's frame;
 *   3. prices the position: LP ids, their pools, each pool's live price, its
 *      token pair and tick spacing, the account's idle USDC — and then the
 *      USDC each id would actually return, by SIMULATING a single-id unwind.
 *      That is what lets the rung be sized by value instead of by id count;
 *   4. plans ONE `unwind` per pool — the only root call, inside the only grant;
 *   5. simulates `execAsKeeper` from the keeper address (revert classified:
 *      grant/budget ⇒ REFUSED, anything else ⇒ FAILED) and broadcasts nothing;
 *   6. persists the keeper NONCE before broadcasting, so a crash between the
 *      send and the store write is visible on resume;
 *   7. broadcasts and returns SENT immediately so the monitor can persist the
 *      hash; `confirm` finishes the job on a later tick — and a successful
 *      receipt is CONFIRMED only when the router's own events say the repay
 *      reached every venue the account still owes: `LeveragedLpUnwound.repaid`
 *      must be non-zero (M-HIGH-1) and, with a venue reader configured, every
 *      venue where `debt(account, USDC)` is still non-zero must carry a
 *      `VenueRepaid` in the receipt (RISKS §8 residual (a), closed 2026-09-09).
 *
 * The keeper's private key lives inside the viem account object only; this
 * class never reads or logs it.
 */

export interface KeeperDispatcherDeps {
  client: PublicClient;
  wallet: WalletClient<Transport, Chain, Account>;
  keeper: Address;
  router: Address;
  lpVenue: Address;
  usdc: Address;
  reader: AaveReader;
  /** Same venue-aware reader the monitor uses; the world check must see every venue the monitor saw. */
  venues?: VenueReader | null;
  ladder: readonly LadderRung[];
  log: Logger;
  config: {
    deadlineMs: number;
    bandToleranceBps: number;
    /** Ceiling when a retry widens the band (a wider band on an emergency exit beats not exiting). */
    bandMaxToleranceBps: number;
    txDeadlineS: number;
    priceMaxAgeS: number;
    priceMaxAgeBySymbol?: ReadonlyMap<string, number>;
    oracleDeviationBps: number;
    hfToleranceBps: number;
    /** Slippage tolerance handed to the adapter; it caps this at MAX_SLIPPAGE_BPS (500). */
    swapMaxSlippageBps: number;
    /** Most single-id value probes per dispatch. Unprobed ids sort last. */
    maxValueProbes: number;
    /** Warn/escalate when the grant expires within this many seconds. */
    grantExpiryWarnS: number;
  };
  now?: () => Date;
  notifier?: Notifier;
}

const GRANT_ERRORS = new Set(["NotGranted", "TokenNotBudgeted", "TokenBudgetExceeded", "ValueBudgetExceeded"]);
/** Reverts that mean "the grant is wrong", not "the market moved". */
const CONFIG_ERRORS = new Set(["NotActivePeripheral", "CallbackNotPermitted", "UnbudgetableSelector"]);

/**
 * ABI used for execAsKeeper simulation/sending: the account's functions plus
 * every error the call tree can bubble (the account re-throws venue / router /
 * adapter revert data untouched), so a revert decodes to its real name.
 */
export const keeperExecAbi = [...oilskinAccountAbi, ...lpVenueAbi, ...strategyRouterAbi, ...swapAdapterAbi] as const;

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

export interface UnwindSummary {
  events: number;
  closed: bigint;
  failed: bigint;
  usdcFromLp: bigint;
  repaid: bigint;
  withdrawn: bigint;
  /** `VenueRepaid` per venue (lower-cased address → USDC repaid there), summed across the receipt. */
  byVenue: Map<string, bigint>;
}

/**
 * What every `LeveragedLpUnwound` in a receipt says the router did for `account`, summed — and,
 * from the router's `VenueRepaid` events, WHICH venue each repaid unit reached. The total alone
 * was enough to catch a repay that moved nothing (M-HIGH-1); it could not catch a repay that moved
 * the wrong book (RISKS §8 residual (a)).
 */
export function summarizeUnwinds(
  logs: readonly { address: `0x${string}`; data: `0x${string}`; topics: readonly `0x${string}`[] }[],
  account: Address
): UnwindSummary {
  const out: UnwindSummary = { events: 0, closed: 0n, failed: 0n, usdcFromLp: 0n, repaid: 0n, withdrawn: 0n, byVenue: new Map() };
  type Unwound = { account?: string; closedCount?: bigint; failedCount?: bigint; usdcFromLp?: bigint; repaid?: bigint; withdrawn?: bigint };
  let parsed: { args: Unwound }[];
  try {
    parsed = parseEventLogs({ abi: strategyRouterAbi, logs: logs as never, eventName: "LeveragedLpUnwound" }) as unknown as { args: Unwound }[];
  } catch {
    return out;
  }
  for (const log of parsed) {
    const a = log.args;
    if (!a.account || a.account.toLowerCase() !== account.toLowerCase()) continue;
    out.events += 1;
    out.closed += a.closedCount ?? 0n;
    out.failed += a.failedCount ?? 0n;
    out.usdcFromLp += a.usdcFromLp ?? 0n;
    out.repaid += a.repaid ?? 0n;
    out.withdrawn += a.withdrawn ?? 0n;
  }
  type Repaid = { account?: string; venue?: string; repaid?: bigint };
  let perVenue: { args: Repaid }[] = [];
  try {
    perVenue = parseEventLogs({ abi: strategyRouterAbi, logs: logs as never, eventName: "VenueRepaid" }) as unknown as { args: Repaid }[];
  } catch {
    perVenue = [];
  }
  for (const log of perVenue) {
    const a = log.args;
    if (!a.account || a.account.toLowerCase() !== account.toLowerCase() || !a.venue) continue;
    const k = a.venue.toLowerCase();
    out.byVenue.set(k, (out.byVenue.get(k) ?? 0n) + (a.repaid ?? 0n));
  }
  return out;
}

/**
 * The rule confirm() applies to a venue the receipt left untouched (slice 5, 2026-09-10). Pure, so
 * it is testable on its own. With a dispatch-time snapshot of every book:
 *   • a venue owing now that owed nothing then (or was not in the snapshot) → not this receipt's
 *     to confirm; a venue paid that was not in the snapshot → the keeper acted on a book it never
 *     sized; the USDC balance unreadable → cannot tell a shortfall from a skip. All FAILED.
 *   • USDC left in the account → a book owed at dispatch was skipped → FAILED (wrong book).
 *   • USDC exhausted and every book paid no healthier at dispatch than every book left →
 *     an honest shortfall: CONFIRMED, with a note the retry's world check follows up on.
 * Without a snapshot the older rule stands: an untouched venue is never confirmed.
 */
export function judgeUntouched(
  books: readonly VenueBook[] | undefined,
  byVenue: ReadonlyMap<string, bigint>,
  untouched: readonly { venue: Address; debtUsdc: bigint }[],
  heldAfter: bigint | null
): { honest: true; note: string } | { honest: false; why: string } {
  const left = untouched.map((u) => `${u.venue} (${u.debtUsdc} USDC still owed)`).join(", ");
  if (!books) {
    return {
      honest: false,
      why:
        heldAfter === 0n
          ? "the account's USDC ran out on the worse book, but this dispatch carries no per-venue snapshot to prove that book was the worse one — not confirmed; the retry re-values the account and continues"
          : "the repay reached another book than the one this account still owes — not a protection of that debt",
    };
  }
  const snap = new Map(books.map((b) => [b.venue.toLowerCase(), { debt: BigInt(b.debtUsdc), hf: BigInt(b.hfWad) }]));
  for (const u of untouched) {
    const at = snap.get(u.venue.toLowerCase());
    if (!at || at.debt === 0n) {
      return { honest: false, why: `USDC debt on ${u.venue} that owed nothing when this dispatch was sized (${at ? "0" : "not in the snapshot"}) — not this receipt's to confirm` };
    }
  }
  for (const [v, amt] of byVenue) {
    if (amt > 0n && !snap.has(v.toLowerCase())) return { honest: false, why: `the repay reached ${v}, a venue that was not in the dispatch-time snapshot — a book the keeper never sized took USDC` };
  }
  if (heldAfter === null) return { honest: false, why: "the account's USDC balance could not be read after the receipt, so a shortfall cannot be told from a skipped book" };
  if (heldAfter > 0n) {
    return { honest: false, why: `the repay reached another book than the one this account still owes while ${heldAfter} USDC remained in the account — a book owed at dispatch was skipped, not a protection of that debt` };
  }
  let worstLeft: { venue: Address; hf: bigint } | null = null;
  for (const u of untouched) {
    const hf = snap.get(u.venue.toLowerCase())!.hf;
    if (!worstLeft || hf < worstLeft.hf) worstLeft = { venue: u.venue, hf };
  }
  for (const [v, amt] of byVenue) {
    if (amt === 0n) continue;
    const hf = snap.get(v.toLowerCase())!.hf;
    if (worstLeft && hf > worstLeft.hf) {
      return {
        honest: false,
        why: `the repay went to ${v} (HF ${hf} at dispatch) before ${worstLeft.venue} (HF ${worstLeft.hf} at dispatch), the book in more trouble — the wrong book, not a shortfall`,
      };
    }
  }
  const paid = [...byVenue].filter(([, amt]) => amt > 0n).map(([v, amt]) => `${v} ${amt}`).join(", ");
  return { honest: true, note: `USDC ran out on the worse book (${paid}); ${left} was owed at dispatch and is left for the retry — an honest shortfall, not a wrong book` };
}

export interface GrantState {
  active: boolean;
  allowCallback: boolean;
  expiry: number;
  maxValuePerPeriod: bigint;
  valueSpent: bigint;
}

/**
 * USDC that must reach the debt to lift the health factor to `targetHf`.
 * Derived from the live valuation only: HF = Σ(collateral × LT) / debt, so the
 * debt that yields `targetHf` is `Σ(collateral × LT) / targetHf`, and the
 * shortfall is converted into the debt asset's own units at the same oracle
 * price the pool uses. Returns null when the debt asset has no row (nothing to
 * size against) — the caller then falls back to the rung's value fraction.
 */
export function usdcNeededFor(v: OkValuation, targetHf: number, usdc: Address): bigint | null {
  const row = v.debt.find((d) => d.asset.toLowerCase() === usdc.toLowerCase());
  if (!row || row.price8 <= 0n) return null;
  if (!(targetHf > 0) || !Number.isFinite(targetHf)) return null;
  const weighted = (v.hfWad * v.debtBase) / WAD; // Σ(collateral × LT), base units
  const targetWad = BigInt(Math.round(targetHf * 1e18));
  if (targetWad <= 0n) return null;
  const debtTarget = (weighted * WAD) / targetWad;
  const shortfallBase = v.debtBase > debtTarget ? v.debtBase - debtTarget : 0n;
  const unit = 10n ** BigInt(row.decimals);
  const needed = (shortfallBase * unit) / row.price8;
  // Never more than the debt actually owed in that asset.
  return needed > row.amount ? row.amount : needed;
}

export class KeeperDispatcher implements Dispatcher {
  private readonly now: () => Date;
  private readonly decimalsCache = new Map<string, number>();
  private readonly tickSpacingCache = new Map<string, number>();

  constructor(private readonly d: KeeperDispatcherDeps) {
    this.now = d.now ?? (() => new Date());
  }

  private call<T>(label: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    return withDeadline(label, this.d.config.deadlineMs, signal, work);
  }

  /** Chain time; falls back to the host clock only when the head cannot be read. */
  private async chainNowS(signal?: AbortSignal): Promise<bigint> {
    try {
      const head = await this.d.reader.head(signal);
      return head.timestamp;
    } catch {
      return BigInt(Math.floor(this.now().getTime() / 1000));
    }
  }

  async dispatch(intent: DispatchIntent, signal?: AbortSignal): Promise<DispatchResult> {
    const { record } = intent;
    const log = this.d.log.child({ account: record.account, key: record.key, action: record.action });

    if (record.action === "notify") {
      // A notification nobody receives is not a notification: only report
      // NOTIFIED when a PERSON-FACING channel accepted it (audit C-MED-7, and
      // wave 2 N-MED-1: the keeper's own log and store accept everything).
      let delivery;
      try {
        delivery = await this.deliver({
          kind: "notify",
          severity: "warn",
          account: record.account,
          rung: record.rung,
          action: record.action,
          hf: record.hf,
          key: record.key,
        });
      } catch (e) {
        return { status: "FAILED", error: `notification not delivered: ${errMsg(e)}` };
      }
      if (!delivery.personReached) {
        log.warn("NOTIFY: health warning written to the keeper's own log/store only — nobody was told", { rung: record.rung, hf: record.hf });
        return { status: "LOGGED_ONLY", reason: "no person-facing channel accepted it (set NOTIFY_WEBHOOK_URL); the keeper's own log and store are not a notification" };
      }
      log.warn("NOTIFY: health warning delivered", { rung: record.rung, hf: record.hf });
      return { status: "NOTIFIED" };
    }

    // 1. World check.
    const world = await this.worldCheck(record, intent.valuation, signal);
    if (world.kind !== "ACT") return world.result;
    const valuation = world.valuation;
    const account = record.account;

    // 2. The one grant this keeper can ever need, read whole.
    const selector = GRANT_SELECTORS["StrategyRouter.unwind"];
    let grant: GrantState;
    try {
      grant = await this.readGrant(account, this.d.router, selector, signal);
    } catch (e) {
      return { status: "REFUSED", reason: `cannot read grant for ${this.d.router} ${selector}: ${errMsg(e)}` };
    }
    intent.onGrantRead?.({ target: this.d.router, selector, active: grant.active, allowCallback: grant.allowCallback, expiry: grant.expiry });
    if (!grant.active) {
      return {
        status: "REFUSED",
        permanent: true,
        reason: `no active grant for keeper on ${this.d.router} selector ${selector} (expiry ${grant.expiry}) — the owner must (re-)grant protection`,
      };
    }
    if (!grant.allowCallback) {
      return {
        status: "REFUSED",
        permanent: true,
        reason:
          `grant for ${this.d.router} ${selector} has allowCallback=false — the router must act back on the account, ` +
          "so every dispatch would revert NotActivePeripheral(). This is a mis-issued grant, not a market condition.",
      };
    }
    const nowS = await this.chainNowS(signal);
    if (grant.expiry > 0 && BigInt(grant.expiry) - nowS <= BigInt(this.d.config.grantExpiryWarnS)) {
      const secondsLeft = Number(BigInt(grant.expiry) - nowS);
      log.warn("protection grant expiring", { expiry: grant.expiry, secondsLeft });
      await this.deliver({
        kind: "grant-expiring",
        severity: "warn",
        account,
        detail: { expiry: grant.expiry, secondsLeft, target: this.d.router, selector },
      }).catch(() => undefined);
    }

    // 3. Price the position.
    let positions: PlannedPosition[];
    let pools: Map<Hex, PoolInfo>;
    let idleUsdc: bigint;
    try {
      const state = await this.readLpState(account, signal);
      positions = state.positions;
      pools = state.pools;
      idleUsdc = state.idleUsdc;
    } catch (e) {
      // Cannot enumerate / price ⇒ cannot plan safely. Fail closed.
      return { status: "REFUSED", reason: `cannot read LP state (fail closed): ${errMsg(e)}` };
    }

    const rung = this.d.ladder.find((r) => r.id === record.rung);
    const bandToleranceBps = this.bandToleranceFor(record.attempts);

    // Value every id the plan might close, by simulating what the router would
    // hand back for it. Bounded; unprobed ids sort last.
    if (positions.length > 0) {
      await this.probeValues(account, valuation.dominantCollateral.asset, positions, pools, nowS, bandToleranceBps, signal, log);
    }

    const usdcNeeded = rung ? usdcNeededFor(valuation, rung.disarmHf, this.d.usdc) : null;

    // 4. Plan — one unwind per pool, one selector, one grant.
    const plan = planAction({
      account,
      action: record.action,
      collateralAsset: valuation.dominantCollateral.asset,
      router: this.d.router,
      positions,
      pools,
      idleUsdc,
      usdcNeeded,
      bandToleranceBps,
      nowS,
      txDeadlineS: this.d.config.txDeadlineS,
    });
    if (plan.kind === "NOTHING") return { status: "REFUSED", reason: plan.reason };
    if (plan.kind === "REFUSE") return { status: "REFUSED", reason: plan.reason };

    const outside = plan.grantsNeeded.filter((g) => g.target !== this.d.router || g.selector !== selector);
    if (outside.length) {
      // Defensive: this is the C-HIGH-1 class (a plan reaching outside the
      // user's single signed Permission). It must never happen again.
      return {
        status: "REFUSED",
        permanent: true,
        reason: `plan needs a grant outside the signed one: ${outside.map((g) => `${g.target}:${g.selector}`).join(", ")}`,
      };
    }

    // 5. Simulate from the keeper address.
    const calls = plan.calls.map((c: KeeperCall) => ({ target: c.target, value: c.value, data: c.data, callback: c.callback }));
    try {
      await this.call("simulate execAsKeeper", signal, () =>
        this.d.client.simulateContract({
          address: account,
          abi: keeperExecAbi,
          functionName: "execAsKeeper",
          args: [calls],
          account: this.d.keeper,
        })
      );
    } catch (e) {
      const rv = revertName(e);
      if (rv && GRANT_ERRORS.has(rv.name)) return { status: "REFUSED", reason: `simulation reverted ${rv.name}(${rv.args.join(",")})` };
      if (rv && CONFIG_ERRORS.has(rv.name)) {
        return { status: "REFUSED", permanent: true, reason: `simulation reverted ${rv.name}(${rv.args.join(",")}) — mis-issued grant` };
      }
      return { status: "FAILED", error: `simulation failed: ${rv ? `${rv.name}(${rv.args.join(",")})` : errMsg(e)}` };
    }

    // 6. Persist what we are about to broadcast BEFORE broadcasting it — the nonce, the ids, and
    //    every book the account has right now (slice 5), which is what confirm() judges an
    //    untouched venue against. A snapshot that cannot be read is a dispatch that cannot be
    //    judged: fail closed before the send, not after.
    let nonce: number | undefined;
    try {
      nonce = await this.call("getTransactionCount", signal, () =>
        this.d.client.getTransactionCount({ address: this.d.keeper, blockTag: "pending" })
      );
    } catch {
      nonce = undefined;
    }
    let venueBooks: VenueBook[] | undefined;
    try {
      venueBooks = (await this.readBooks(account, signal)) ?? undefined;
    } catch (e) {
      return { status: "REFUSED", reason: `cannot snapshot the account's books before sending (fail closed): ${errMsg(e)}` };
    }
    if (intent.persistBeforeSend) {
      try {
        await intent.persistBeforeSend({ nonce, closeIds: plan.closeIds, venueBooks });
      } catch (e) {
        // Without the pre-send record a crash could replay the action: fail closed.
        return { status: "REFUSED", reason: `could not persist pre-send state (fail closed): ${errMsg(e)}` };
      }
    }

    // 7. Broadcast.
    log.warn("sending execAsKeeper", {
      closeIds: plan.closeIds.map(String),
      calls: calls.length,
      hf: valuation.hf,
      sizing: plan.sizing,
      expectedProceedsUsdc: plan.expectedProceedsUsdc?.toString() ?? null,
      usdcNeeded: usdcNeeded?.toString() ?? null,
      bandToleranceBps,
      nonce,
    });
    let txHash: Hex;
    try {
      txHash = await this.call("sendTransaction", signal, () =>
        this.d.wallet.writeContract({
          address: account,
          abi: keeperExecAbi,
          functionName: "execAsKeeper",
          args: [calls],
          account: this.d.wallet.account,
          chain: this.d.wallet.chain,
        })
      );
    } catch (e) {
      const rv = revertName(e);
      if (rv && GRANT_ERRORS.has(rv.name)) return { status: "REFUSED", reason: `send reverted ${rv.name}` };
      return { status: "FAILED", error: `send failed: ${errMsg(e)}` };
    }
    log.info("sent", { txHash });
    return { status: "SENT", txHash };
  }

  async confirm(record: DispatchRecord, signal?: AbortSignal): Promise<DispatchResult> {
    if (!record.txHash) return { status: "FAILED", error: "confirm called without txHash" };
    let receipt;
    try {
      receipt = await this.call("getTransactionReceipt", signal, () =>
        this.d.client.getTransactionReceipt({ hash: record.txHash! }).catch((e: unknown) => {
          // viem throws TransactionReceiptNotFoundError while pending.
          if (e instanceof BaseError && /not be found|not found/i.test(e.shortMessage)) return null;
          throw e;
        })
      );
    } catch (e) {
      return { status: "FAILED", error: `receipt read failed: ${errMsg(e)}` };
    }
    if (!receipt) {
      // Still pending: keep SENT (the monitor keeps it SENT when we return SENT again).
      return { status: "SENT", txHash: record.txHash };
    }
    if (receipt.status === "success") {
      // A successful transaction is not a successful PROTECTION. The router's
      // `unwind` is a no-op when the venue it resolved holds nothing of the
      // account's — after a registry venue switch every position on the old
      // venue read exactly like that: repaid 0, closed 0, receipt status 1,
      // and this method called it CONFIRMED while the Aave debt rode to
      // liquidation (audit wave 2, M-HIGH-1). Read what the unwind DID from
      // its own event and refuse to confirm a repay that repaid nothing.
      const moved = summarizeUnwinds(receipt.logs, record.account);
      if (moved.events === 0) {
        return {
          status: "FAILED",
          error: `transaction ${record.txHash} succeeded but its receipt carries no LeveragedLpUnwound for this account — cannot confirm that anything moved`,
        };
      }
      if (moved.repaid === 0n) {
        return {
          status: "FAILED",
          error:
            `transaction ${record.txHash} succeeded but repaid nothing (closed ${moved.closed}, failed ${moved.failed}, usdcFromLp ${moved.usdcFromLp}) — ` +
            "a repay rung that moves no debt is not protection; no venue the registry names for this asset owed anything the account could pay",
        };
      }
      // The total says something was repaid; the router's `VenueRepaid` events say WHERE. Every
      // venue the account still owes USDC on must be among them, or the repay landed on another
      // book than the one that fired the rung — dust collateral or a small healthy debt on the
      // registry's new pointer used to take it while the Aave debt rode (RISKS §8 residual (a),
      // closed 2026-09-09). Read the venues NOW, through the same reader the world check uses:
      // a venue that cannot be read may be the one still owing, so that is not confirmed either.
      const where = await this.untouchedVenues(record.account, moved.byVenue, signal);
      if (where.unreadable !== null) {
        return {
          status: "FAILED",
          error:
            `transaction ${record.txHash} succeeded and repaid ${moved.repaid}, but the registry's venues could not be re-read to prove ` +
            `no debt was left untouched (${where.unreadable}) — not confirming what cannot be verified`,
        };
      }
      if (where.untouched.length) {
        // Slice 5: judged against the books persisted at dispatch. An honest shortfall (the worse
        // book paid, USDC exhausted, a book owed then left for the retry) is CONFIRMED and said;
        // a skipped book, or debt on a venue that owed nothing at dispatch, is FAILED.
        const reached = [...moved.byVenue].map(([v, amt]) => `${v} ${amt}`).join(", ") || "no venue named";
        const left = where.untouched.map((u) => `${u.venue} (${u.debtUsdc} USDC still owed)`).join(", ");
        const verdict = judgeUntouched(record.venueBooks, moved.byVenue, where.untouched, where.heldAfter);
        if (!verdict.honest) {
          return {
            status: "FAILED",
            error: `transaction ${record.txHash} succeeded and repaid ${moved.repaid} (${reached}) but left USDC debt untouched on ${left}: ${verdict.why}`,
          };
        }
        return { status: "CONFIRMED", txHash: record.txHash, note: verdict.note };
      }
      return { status: "CONFIRMED", txHash: record.txHash };
    }

    // A revert on chain after a clean simulation is usually the grant or a
    // budget consumed in between (audit C-MED-8). That is PERMANENT and needs
    // the user — retrying it five times and calling it transient hides the
    // only thing a human could fix.
    try {
      const grant = await this.readGrant(record.account, this.d.router, GRANT_SELECTORS["StrategyRouter.unwind"], signal);
      if (!grant.active || !grant.allowCallback) {
        return {
          status: "REFUSED",
          permanent: true,
          reason: `transaction reverted on-chain (${record.txHash}) and the grant is ${grant.active ? "not callback-enabled" : "no longer active"} — the owner must re-grant`,
        };
      }
    } catch {
      /* fall through to FAILED */
    }
    return { status: "FAILED", error: `transaction reverted on-chain (${record.txHash})` };
  }

  // ---- internals ----------------------------------------------------------

  private async deliver(e: Parameters<typeof eventNow>[0]): Promise<{ personReached: boolean }> {
    if (!this.d.notifier) return { personReached: false };
    return this.d.notifier.deliver(eventNow(e, this.now));
  }

  private bandToleranceFor(attempts: number): number {
    const base = this.d.config.bandToleranceBps;
    const max = Math.max(base, this.d.config.bandMaxToleranceBps);
    // Each retry widens the window: the price move that triggered an emergency
    // exit is exactly what breaks a 1 % band, and an exit at a worse price
    // beats no exit at all (audit C-MED-4).
    return Math.min(max, base * (Math.max(0, attempts) + 1));
  }

  /**
   * Venues where the account STILL owes USDC that the receipt's `VenueRepaid` events do not name.
   * Without a venue reader (no router configured: the Aave-only, observe-and-value shape) there is
   * no registry to ask and the total is all there is — `[]`. Any read failure is `unreadable`:
   * confirm() fails closed on it rather than confirming a receipt it cannot check.
   */
  private async untouchedVenues(
    account: Address,
    byVenue: ReadonlyMap<string, bigint>,
    signal?: AbortSignal
  ): Promise<{ unreadable: string | null; untouched: { venue: Address; debtUsdc: bigint }[]; heldAfter: bigint | null }> {
    if (!this.d.venues) return { unreadable: null, untouched: [], heldAfter: null };
    let ctx;
    let snap;
    try {
      ctx = await this.d.venues.readContext(signal);
      snap = await this.d.venues.readAccount(account, ctx, signal);
    } catch (e) {
      return { unreadable: errMsg(e), untouched: [], heldAfter: null };
    }
    const problems = [
      ...ctx.unreadableAssets.map((u) => `registry ${u.symbol}: ${u.reason}`),
      ...snap.unreadable.map((u) => `venue ${u.venue}: ${u.reason}`),
    ];
    if (problems.length) return { unreadable: problems.join("; "), untouched: [], heldAfter: null };
    const untouched = snap.venues
      .filter((v) => v.debtUsdc > 0n && (byVenue.get(v.venue.toLowerCase()) ?? 0n) === 0n)
      .map((v) => ({ venue: v.venue, debtUsdc: v.debtUsdc }));
    let heldAfter: bigint | null = null;
    if (untouched.length) {
      // Only for the message: did the router run dry on the worse book, or skip this one?
      try {
        heldAfter = await this.call("usdc.balanceOf", signal, () =>
          this.d.client.readContract({ address: this.d.usdc, abi: erc20BalanceAbi, functionName: "balanceOf", args: [account] })
        );
      } catch {
        heldAfter = null;
      }
    }
    return { unreadable: null, untouched, heldAfter };
  }

  /**
   * Every venue the registry names for the account, with the USDC it owes there and its health
   * factor there — the dispatch-time snapshot `confirm()` judges an untouched venue against.
   * `null` without a venue reader (the Aave-only shape has no registry to ask); throws when the
   * registry or a venue cannot be read, and the dispatch fails closed on that.
   */
  private async readBooks(account: Address, signal?: AbortSignal): Promise<VenueBook[] | null> {
    if (!this.d.venues) return null;
    const ctx = await this.d.venues.readContext(signal);
    const snap = await this.d.venues.readAccount(account, ctx, signal);
    const problems = [
      ...ctx.unreadableAssets.map((u) => `registry ${u.symbol}: ${u.reason}`),
      ...snap.unreadable.map((u) => `venue ${u.venue}: ${u.reason}`),
    ];
    if (problems.length) throw new Error(problems.join("; "));
    return snap.venues.map((v) => ({ venue: v.venue, debtUsdc: v.debtUsdc.toString(), hfWad: v.healthFactorWad.toString() }));
  }

  async readGrant(account: Address, target: Address, selector: Hex, signal?: AbortSignal): Promise<GrantState> {
    const g = await this.call(`grantOf(${target},${selector})`, signal, () =>
      this.d.client.readContract({
        address: account,
        abi: oilskinAccountAbi,
        functionName: "grantOf",
        args: [this.d.keeper, target, selector],
      })
    );
    const [active, maxValuePerPeriod, valueSpent, , expiry, , allowCallback] = g;
    return { active, maxValuePerPeriod, valueSpent, expiry: Number(expiry), allowCallback };
  }

  private async readLpState(
    account: Address,
    signal?: AbortSignal
  ): Promise<{ positions: PlannedPosition[]; pools: Map<Hex, PoolInfo>; idleUsdc: bigint }> {
    const ids = await this.call("positionsOf", signal, () =>
      this.d.client.readContract({ address: this.d.lpVenue, abi: lpVenueAbi, functionName: "positionsOf", args: [account] })
    );
    const positions: PlannedPosition[] = [];
    for (const id of ids) {
      const [poolId] = await this.call(`poolOf(${id})`, signal, () =>
        this.d.client.readContract({ address: this.d.lpVenue, abi: lpVenueAbi, functionName: "poolOf", args: [id] })
      );
      positions.push({ id, poolId, valueUsdc: null });
    }
    const pools = new Map<Hex, PoolInfo>();
    for (const poolId of new Set(positions.map((p) => p.poolId))) {
      const sqrtPriceX96 = await this.call(`poolSqrtPriceX96(${poolId})`, signal, () =>
        this.d.client.readContract({ address: this.d.lpVenue, abi: lpVenueAbi, functionName: "poolSqrtPriceX96", args: [poolId] })
      );
      const [token0, token1, pool] = await this.call(`poolTokens(${poolId})`, signal, () =>
        this.d.client.readContract({ address: this.d.lpVenue, abi: lpVenueAbi, functionName: "poolTokens", args: [poolId] })
      );
      const usdc = this.d.usdc.toLowerCase();
      const needsSwap = token0.toLowerCase() !== usdc || token1.toLowerCase() !== usdc;
      let swap: SwapQuote = NO_SWAP;
      if (needsSwap && sqrtPriceX96 > 0n) {
        try {
          const nonUsdc = (token0.toLowerCase() === usdc ? token1 : token0) as Address;
          const nonUsdcDecimals = await this.tokenDecimals(nonUsdc, signal);
          const tickSpacing = await this.poolTickSpacing(pool as Address, signal);
          swap = quoteForPool({
            sqrtPriceX96,
            token0: token0 as Address,
            token1: token1 as Address,
            usdc: this.d.usdc,
            nonUsdcDecimals,
            maxSlippageBps: this.d.config.swapMaxSlippageBps,
            tickSpacing,
          }).quote;
        } catch (e) {
          // Leave the quote empty: the planner refuses this pool by name rather
          // than the keeper guessing a floor. Never a swap without a price.
          this.d.log.warn("could not build a swap quote for a pool — it will be refused, not guessed", {
            poolId,
            error: errMsg(e),
          });
        }
      }
      pools.set(poolId, { sqrtPriceX96, swap, needsSwap });
    }
    const idleUsdc = await this.call("usdc.balanceOf", signal, () =>
      this.d.client.readContract({ address: this.d.usdc, abi: erc20BalanceAbi, functionName: "balanceOf", args: [account] })
    );
    return { positions, pools, idleUsdc };
  }

  private async tokenDecimals(token: Address, signal?: AbortSignal): Promise<number> {
    const k = token.toLowerCase();
    const hit = this.decimalsCache.get(k);
    if (hit !== undefined) return hit;
    const d = await this.call(`decimals(${token})`, signal, () =>
      this.d.client.readContract({ address: token, abi: erc20BalanceAbi, functionName: "decimals" })
    );
    const n = Number(d);
    this.decimalsCache.set(k, n);
    return n;
  }

  private async poolTickSpacing(pool: Address, signal?: AbortSignal): Promise<number> {
    const k = pool.toLowerCase();
    const hit = this.tickSpacingCache.get(k);
    if (hit !== undefined) return hit;
    const t = await this.call(`tickSpacing(${pool})`, signal, () =>
      this.d.client.readContract({ address: pool, abi: clPoolAbi, functionName: "tickSpacing" })
    );
    const n = Number(t);
    this.tickSpacingCache.set(k, n);
    return n;
  }

  /**
   * Fill in `valueUsdc` for as many ids as the probe budget allows, by
   * simulating the very call the plan would make for that id alone. The
   * simulation is an `eth_call`: nothing is broadcast, nothing is mutated, and
   * the number is the router's own answer rather than an estimate of ours.
   */
  private async probeValues(
    account: Address,
    collateralAsset: Address,
    positions: PlannedPosition[],
    pools: Map<Hex, PoolInfo>,
    nowS: bigint,
    bandToleranceBps: number,
    signal: AbortSignal | undefined,
    log: Logger
  ): Promise<void> {
    const budget = Math.max(0, this.d.config.maxValueProbes);
    let probed = 0;
    let failed = 0;
    for (const p of positions) {
      if (probed >= budget) break;
      const info = pools.get(p.poolId);
      if (!info || info.sqrtPriceX96 <= 0n) continue;
      const single = planAction({
        account,
        action: "emergency-unwind", // "this id, whole" — the probe closes exactly one id
        collateralAsset,
        router: this.d.router,
        positions: [{ ...p, valueUsdc: null }],
        pools,
        idleUsdc: 0n,
        usdcNeeded: null,
        bandToleranceBps,
        nowS,
        txDeadlineS: this.d.config.txDeadlineS,
        repay: false, // measure the close, nothing else
      });
      if (single.kind !== "CALLS") continue;
      probed += 1;
      try {
        const sim = await this.call(`probe unwind(${p.id})`, signal, () =>
          this.d.client.simulateContract({
            address: account,
            abi: keeperExecAbi,
            functionName: "execAsKeeper",
            args: [single.calls.map((c) => ({ target: c.target, value: c.value, data: c.data, callback: c.callback }))],
            account: this.d.keeper,
          })
        );
        const results = sim.result as readonly Hex[];
        const [usdcFromLp] = decodeFunctionResult({ abi: strategyRouterAbi, functionName: "unwind", data: results[0] }) as readonly bigint[];
        p.valueUsdc = usdcFromLp;
      } catch (e) {
        failed += 1;
        p.valueUsdc = null;
        log.debug("value probe failed — id sorts last", { id: p.id.toString(), error: errMsg(e) });
      }
    }
    if (positions.length > budget || failed > 0) {
      log.info("value probes bounded", { ids: positions.length, probed, failed, budget });
    }
  }

  /** Fresh valuation; decides whether the recorded action is still warranted. */
  private async worldCheck(
    record: DispatchRecord,
    given: OkValuation | null,
    signal?: AbortSignal
  ): Promise<{ kind: "ACT"; valuation: OkValuation } | { kind: "STOP"; result: DispatchResult }> {
    let valuation: Valuation;
    if (given) {
      valuation = given;
    } else {
      try {
        const valuer = { reader: this.d.reader, venues: this.d.venues ?? null };
        const head = await this.d.reader.head(signal);
        const ctx = await readTickContexts(valuer, signal);
        const av = await valueAccount(
          valuer,
          record.account,
          ctx,
          head.number,
          {
            nowS: head.timestamp,
            priceMaxAgeS: this.d.config.priceMaxAgeS,
            priceMaxAgeBySymbol: this.d.config.priceMaxAgeBySymbol,
            oracleDeviationBps: this.d.config.oracleDeviationBps,
            hfToleranceBps: this.d.config.hfToleranceBps,
          },
          signal
        );
        valuation = av.valuation;
      } catch (e) {
        return { kind: "STOP", result: { status: "REFUSED", reason: `world check failed (fail closed): ${errMsg(e)}` } };
      }
    }
    if (valuation.kind === "UNKNOWN") {
      return { kind: "STOP", result: { status: "REFUSED", reason: `account unvaluable (fail closed): ${valuation.reasons.join("; ")}` } };
    }
    if (valuation.kind === "NO_DEBT") {
      return { kind: "STOP", result: { status: "SUPERSEDED", reason: "no debt — nothing to protect" } };
    }
    const rung = this.d.ladder.find((r) => r.id === record.rung);
    if (!rung) return { kind: "STOP", result: { status: "REFUSED", reason: `unknown rung ${record.rung}` } };
    if (valuation.hf >= rung.disarmHf) {
      return { kind: "STOP", result: { status: "SUPERSEDED", reason: `HF ${valuation.hf.toFixed(4)} ≥ ${rung.id} disarm ${rung.disarmHf}` } };
    }
    return { kind: "ACT", valuation };
  }
}

export type { KeeperCall };
