/**
 * The entry health factor the router recorded for an account (BUILD-PLAN-2026-09-12 D7 / step A4).
 *
 * `StrategyRouter.entryHfWad(account)` is written by every open (leveraged or borrow-only) as the
 * venue measured it, and is 0 for an account that never opened through the router — or opened
 * through a router from before the record existed. The monitor derives the account's ladder from
 * it (`ladderFor` in packages/shared); 0 means "the floor's ladder", and the store says so.
 *
 * Read-only; bounded by the same deadline as every other chain read.
 */
import type { PublicClient } from "viem";
import { hfFromWad } from "@zyo/shared";
import { strategyRouterAbi } from "../abi/oilskin.js";
import type { Address } from "../types/evm.js";
import { withDeadline } from "./deadline.js";

export interface EntryHfReader {
  /** The recorded entry HF as a number (four decimals), or 0 when nothing is recorded. */
  read(account: Address, signal?: AbortSignal): Promise<number>;
}

export class RouterEntryHfReader implements EntryHfReader {
  constructor(
    private readonly client: PublicClient,
    private readonly router: Address,
    private readonly opts: { deadlineMs: number }
  ) {}

  async read(account: Address, signal?: AbortSignal): Promise<number> {
    const wad = await withDeadline(`entryHfWad(${account})`, this.opts.deadlineMs, signal, () =>
      this.client.readContract({ address: this.router, abi: strategyRouterAbi, functionName: "entryHfWad", args: [account] })
    );
    return hfFromWad(wad);
  }
}
