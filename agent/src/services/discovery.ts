import type { AbiEvent, PublicClient } from "viem";
import type { Address } from "../types/evm.js";
import { isAddress } from "../types/evm.js";
import { withDeadline } from "./deadline.js";

/**
 * Discovers OilskinAccounts from the factory's `AccountCreated` logs.
 *
 * Scans in bounded block windows from a persisted cursor; each window has a
 * deadline and honours the tick signal. The caller persists the cursor after
 * each window it has fully registered, so a crash mid-scan re-reads at most
 * one window (and registration is duplicate-safe).
 */
export interface DiscoveredAccount {
  owner: Address;
  account: Address;
  blockNumber: bigint;
}

export interface DiscoveryOptions {
  factory: Address;
  event: AbiEvent;
  /** Names of the decoded args carrying owner and account. */
  argNames: { owner: string; account: string };
  chunkBlocks: number;
  deadlineMs: number;
  onProgress?: () => void;
}

export class AccountDiscovery {
  constructor(
    private readonly client: PublicClient,
    private readonly opts: DiscoveryOptions
  ) {
    if (!(opts.chunkBlocks >= 1)) throw new RangeError("chunkBlocks must be ≥ 1");
  }

  /**
   * Scan [from, to] inclusive. `onWindow` is awaited per window with the
   * accounts found and the last block of that window (persist the cursor there).
   */
  async scan(
    from: bigint,
    to: bigint,
    onWindow: (found: DiscoveredAccount[], lastBlock: bigint) => Promise<void>,
    signal?: AbortSignal
  ): Promise<{ windows: number; found: number }> {
    let windows = 0;
    let found = 0;
    const step = BigInt(this.opts.chunkBlocks);
    for (let start = from; start <= to; start += step) {
      if (signal?.aborted) break;
      const end = start + step - 1n < to ? start + step - 1n : to;
      const logs = await withDeadline(`eth_getLogs(${start}-${end})`, this.opts.deadlineMs, signal, () =>
        this.client.getLogs({
          address: this.opts.factory,
          event: this.opts.event,
          fromBlock: start,
          toBlock: end,
          strict: true,
        })
      );
      this.opts.onProgress?.();
      const out: DiscoveredAccount[] = [];
      for (const log of logs) {
        const args = (log as { args?: Record<string, unknown> }).args ?? {};
        const owner = args[this.opts.argNames.owner];
        const account = args[this.opts.argNames.account];
        if (typeof owner !== "string" || typeof account !== "string" || !isAddress(owner) || !isAddress(account)) {
          // A log that does not decode to two addresses is not one of ours; skip, never guess.
          continue;
        }
        if (log.blockNumber === null || log.blockNumber === undefined) continue;
        out.push({ owner, account, blockNumber: log.blockNumber });
      }
      found += out.length;
      windows += 1;
      await onWindow(out, end);
    }
    return { windows, found };
  }
}
