import {
  BaseError,
  ContractFunctionRevertedError,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { erc20BalanceAbi, lpVenueAbi, oilskinAccountAbi, strategyRouterAbi } from "../abi/oilskin.js";
import type { LadderRung } from "../engine/ladder.js";
import { evaluateSnapshot, type Valuation } from "../engine/valuation.js";
import type { Logger } from "../log.js";
import type { AaveReader } from "../services/chain.js";
import { withDeadline } from "../services/deadline.js";
import type { DispatchRecord } from "../store/keeperStore.js";
import type { Address } from "../types/evm.js";
import { planAction, type KeeperCall } from "./policy.js";
import type { DispatchIntent, DispatchResult, Dispatcher, OkValuation } from "./types.js";

/**
 * The only component that signs anything. Every dispatch:
 *   1. re-checks the WORLD (fresh valuation) — never acts on a stale reason.
 *      NO_DEBT or HF ≥ the rung's disarm ⇒ SUPERSEDED; UNKNOWN ⇒ REFUSED;
 *   2. reads the grants ON-CHAIN for every root call the plan needs and refuses
 *      without sending when any is inactive (the keeper acts only inside a grant
 *      it can read);
 *   3. plans the calls from chain reads (LP ids, pool prices, idle USDC);
 *   4. simulates `execAsKeeper` from the keeper address — a revert here is
 *      classified (grant/budget ⇒ REFUSED, anything else ⇒ FAILED) and nothing
 *      is broadcast;
 *   5. broadcasts and returns SENT immediately so the monitor can persist the
 *      hash; `confirm` finishes the job on a later tick.
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
  ladder: readonly LadderRung[];
  log: Logger;
  config: {
    deadlineMs: number;
    bandToleranceBps: number;
    txDeadlineS: number;
    priceMaxAgeS: number;
    oracleDeviationBps: number;
    hfToleranceBps: number;
  };
  now?: () => Date;
  notify?: (record: DispatchRecord) => Promise<void> | void;
}

const GRANT_ERRORS = new Set(["NotGranted", "TokenNotBudgeted", "TokenBudgetExceeded", "ValueBudgetExceeded"]);

/**
 * ABI used for execAsKeeper simulation/sending: the account's functions plus
 * every error the call tree can bubble (the account re-throws venue/router
 * revert data untouched), so a revert decodes to its real name.
 */
export const keeperExecAbi = [...oilskinAccountAbi, ...lpVenueAbi, ...strategyRouterAbi] as const;

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

export class KeeperDispatcher implements Dispatcher {
  private readonly now: () => Date;
  constructor(private readonly d: KeeperDispatcherDeps) {
    this.now = d.now ?? (() => new Date());
  }

  private call<T>(label: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    return withDeadline(label, this.d.config.deadlineMs, signal, work);
  }

  async dispatch(intent: DispatchIntent, signal?: AbortSignal): Promise<DispatchResult> {
    const { record } = intent;
    const log = this.d.log.child({ account: record.account, key: record.key, action: record.action });

    if (record.action === "notify") {
      // The hook is external code: bound it like any RPC so it cannot wedge a tick.
      await this.call("notify hook", signal, async () => this.d.notify?.(record));
      log.warn("NOTIFY: health warning delivered", { rung: record.rung, hf: record.hf });
      return { status: "NOTIFIED" };
    }

    // 1. World check.
    const world = await this.worldCheck(record, intent.valuation, signal);
    if (world.kind !== "ACT") return world.result;
    const valuation = world.valuation;

    // 3. Plan from chain reads (done before grants so the plan tells us which grants matter).
    const account = record.account;
    let positions: { id: bigint; poolId: Hex }[];
    let poolSqrtPrice = new Map<Hex, bigint>();
    let idleUsdc: bigint;
    try {
      const ids = await this.call("positionsOf", signal, () =>
        this.d.client.readContract({ address: this.d.lpVenue, abi: lpVenueAbi, functionName: "positionsOf", args: [account] })
      );
      positions = [];
      for (const id of ids) {
        const [poolId] = await this.call(`poolOf(${id})`, signal, () =>
          this.d.client.readContract({ address: this.d.lpVenue, abi: lpVenueAbi, functionName: "poolOf", args: [id] })
        );
        positions.push({ id, poolId });
      }
      for (const poolId of new Set(positions.map((p) => p.poolId))) {
        const price = await this.call(`poolSqrtPriceX96(${poolId})`, signal, () =>
          this.d.client.readContract({ address: this.d.lpVenue, abi: lpVenueAbi, functionName: "poolSqrtPriceX96", args: [poolId] })
        );
        poolSqrtPrice.set(poolId, price);
      }
      idleUsdc = await this.call("usdc.balanceOf", signal, () =>
        this.d.client.readContract({ address: this.d.usdc, abi: erc20BalanceAbi, functionName: "balanceOf", args: [account] })
      );
    } catch (e) {
      // Cannot enumerate / price ⇒ cannot plan safely. Fail closed.
      return { status: "REFUSED", reason: `cannot read LP state (fail closed): ${errMsg(e)}` };
    }

    const plan = planAction({
      account,
      action: record.action,
      collateralAsset: valuation.dominantCollateral.asset,
      router: this.d.router,
      lpVenue: this.d.lpVenue,
      positions,
      poolSqrtPrice,
      idleUsdc,
      bandToleranceBps: this.d.config.bandToleranceBps,
      nowS: BigInt(Math.floor(this.now().getTime() / 1000)),
      txDeadlineS: this.d.config.txDeadlineS,
    });
    if (plan.kind === "NOTHING") return { status: "REFUSED", reason: plan.reason };
    if (plan.kind === "REFUSE") return { status: "REFUSED", reason: plan.reason };

    // 2. Grants, read on-chain, for every root call.
    for (const g of plan.grantsNeeded) {
      let active: boolean;
      try {
        [active] = await this.call(`grantOf(${g.target},${g.selector})`, signal, () =>
          this.d.client.readContract({
            address: account,
            abi: oilskinAccountAbi,
            functionName: "grantOf",
            args: [this.d.keeper, g.target, g.selector],
          })
        );
      } catch (e) {
        return { status: "REFUSED", reason: `cannot read grant for ${g.target} ${g.selector}: ${errMsg(e)}` };
      }
      if (!active) {
        return { status: "REFUSED", reason: `no active grant for keeper on ${g.target} selector ${g.selector}` };
      }
    }

    // 4. Simulate from the keeper address.
    const calls = plan.calls.map((c) => ({ target: c.target, value: c.value, data: c.data }));
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
      return { status: "FAILED", error: `simulation failed: ${rv ? `${rv.name}(${rv.args.join(",")})` : errMsg(e)}` };
    }

    // 5. Broadcast.
    log.warn("sending execAsKeeper", { closeIds: plan.closeIds.map(String), calls: calls.length, hf: valuation.hf });
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
    if (receipt.status === "success") return { status: "CONFIRMED", txHash: record.txHash };
    return { status: "FAILED", error: `transaction reverted on-chain (${record.txHash})` };
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
        const head = await this.d.reader.blockNumber(signal);
        const ctx = await this.d.reader.readReserveContexts(signal);
        const snap = await this.d.reader.readAccount(record.account, ctx, head, signal);
        valuation = evaluateSnapshot(snap, {
          nowS: BigInt(Math.floor(this.now().getTime() / 1000)),
          priceMaxAgeS: this.d.config.priceMaxAgeS,
          oracleDeviationBps: this.d.config.oracleDeviationBps,
          hfToleranceBps: this.d.config.hfToleranceBps,
        });
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
