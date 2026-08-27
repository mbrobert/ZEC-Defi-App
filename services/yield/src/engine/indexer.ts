/**
 * Engine event indexer: chunked backfill + head-follow over any RpcClient
 * (plain RPC or the Blockscout PRO gateway — identical semantics).
 *
 * Storage is an append-only JSONL of decoded EngineEvents plus a state file
 * with the high-water block, so every pass is resumable: kill it anywhere
 * and rerun — it continues from `nextBlock`. Timestamps and entry flows are
 * separate enrichment passes over the same store (also resumable), keeping
 * each pass simple and independently retryable.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSFER_TOPIC, topicToAddress, wordToBigint, strip0x } from "../abi.js";
import type { RpcClient } from "../sources/rpc.js";
import type { Address, EngineEvent, PositionCreatedEvent, RawLog } from "../types.js";
import { INDEXED_TOPICS, decodeEngineLog } from "./events.js";

export interface IndexerState {
  vault: Address;
  /** Next block to scan (inclusive). */
  nextBlock: number;
  /** Contract creation block (backfill start), once discovered. */
  creationBlock?: number;
  updatedAt: string;
}

export class EventStore {
  readonly eventsPath: string;
  readonly statePath: string;

  constructor(dataDir: string, readonly vault: Address) {
    mkdirSync(dataDir, { recursive: true });
    this.eventsPath = join(dataDir, `events-${vault}.jsonl`);
    this.statePath = join(dataDir, `state-${vault}.json`);
  }

  readState(): IndexerState | null {
    if (!existsSync(this.statePath)) return null;
    return JSON.parse(readFileSync(this.statePath, "utf8")) as IndexerState;
  }

  writeState(s: IndexerState): void {
    writeFileSync(this.statePath, JSON.stringify({ ...s, updatedAt: new Date().toISOString() }));
  }

  append(events: EngineEvent[]): void {
    if (!events.length) return;
    appendFileSync(this.eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  /** Stream all stored events (dedup by tx:logIndex — appends are at-least-once). */
  readAll(): EngineEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const seen = new Set<string>();
    const out: EngineEvent[] = [];
    for (const line of readFileSync(this.eventsPath, "utf8").split("\n")) {
      if (!line) continue;
      const e = JSON.parse(line) as EngineEvent;
      const key = `${e.transactionHash}:${e.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return out;
  }

  /** Rewrite the store in place (enrichment passes). */
  rewrite(events: EngineEvent[]): void {
    writeFileSync(this.eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  }
}

export interface ScanProgress {
  scanned: number;
  total: number;
  events: number;
}

export class EngineIndexer {
  constructor(
    private readonly rpc: RpcClient,
    private readonly store: EventStore,
    private readonly vault: Address,
    private readonly logChunk = 5_000
  ) {}

  /**
   * Scan [state.nextBlock, head] in chunks, decoding + appending as it goes.
   * Safe to interrupt: state advances only after each chunk is persisted.
   */
  async scan(
    toBlock?: number,
    onProgress?: (p: ScanProgress) => void
  ): Promise<{ from: number; to: number; events: number }> {
    const head = toBlock ?? (await this.rpc.blockNumber());
    let state = this.store.readState();
    if (!state) {
      const creation = await this.rpc.contractCreationBlock(this.vault, head);
      state = { vault: this.vault, nextBlock: creation, creationBlock: creation, updatedAt: "" };
      this.store.writeState(state);
    }
    const from = state.nextBlock;
    let total = 0;
    for (let lo = from; lo <= head; lo += this.logChunk) {
      const hi = Math.min(lo + this.logChunk - 1, head);
      const logs = await this.rpc.getLogs(this.vault, lo, hi, [INDEXED_TOPICS]);
      const events = logs
        .map((l) => decodeEngineLog(l))
        .filter((e): e is EngineEvent => e !== null);
      this.store.append(events);
      total += events.length;
      state.nextBlock = hi + 1;
      this.store.writeState(state);
      onProgress?.({ scanned: hi - from + 1, total: head - from + 1, events: total });
    }
    return { from, to: head, events: total };
  }

  /** Fill missing `timestamp` fields (batched eth_getBlockByNumber). */
  async fillTimestamps(batch = 200): Promise<number> {
    const events = this.store.readAll();
    const missing = [...new Set(events.filter((e) => e.timestamp === undefined).map((e) => e.blockNumber))];
    if (!missing.length) return 0;
    for (let i = 0; i < missing.length; i += batch) {
      const ts = await this.rpc.blockTimestamps(missing.slice(i, i + batch));
      for (const e of events) {
        if (e.timestamp === undefined) {
          const t = ts.get(e.blockNumber);
          if (t !== undefined) e.timestamp = t;
        }
      }
      this.store.rewrite(events); // persist after each batch → resumable
    }
    return missing.length;
  }

  /**
   * Entry-principal pass: for each PositionCreated without entryFlows, pull
   * the deposit tx receipt and net the ERC-20 transfers.
   *
   * Principal definition (methodology v1): Σ ERC-20 amounts on the
   * OWNER→VAULT edge of the deposit tx, minus same-tx VAULT→OWNER refunds,
   * per token. Internal legs (vault↔adapter↔pool, including dust returned
   * adapter→vault) are excluded — verified against a live deposit receipt
   * where the adapter returns dust to the vault before the vault refunds
   * the owner. A deposit with NO owner→vault edge yields empty entryFlows
   * and the position is later excluded as zero-principal (counted, not
   * guessed). Uses Blockscout's decoded `txTokenTransfers` when a key is
   * configured; raw receipt logs otherwise — identical semantics.
   */
  async fillEntryFlows(
    txTransfers?: (txHash: `0x${string}`) => Promise<{ token: Address; from: Address; to: Address; value: string }[]>,
    onProgress?: (done: number, total: number) => void
  ): Promise<number> {
    const events = this.store.readAll();
    const pending = events.filter(
      (e): e is PositionCreatedEvent => e.kind === "PositionCreated" && e.entryFlows === undefined
    );
    let done = 0;
    for (const ev of pending) {
      const flows = new Map<Address, bigint>();
      const addFlow = (token: Address, delta: bigint) =>
        flows.set(token, (flows.get(token) ?? 0n) + delta);

      const owner = ev.owner.toLowerCase();
      if (txTransfers) {
        for (const t of await txTransfers(ev.transactionHash)) {
          if (t.from === owner && t.to === this.vault) addFlow(t.token, BigInt(t.value));
          if (t.from === this.vault && t.to === owner) addFlow(t.token, -BigInt(t.value));
        }
      } else {
        const receipt = await this.rpc.getReceipt(ev.transactionHash);
        for (const l of receipt?.logs ?? []) {
          if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue; // ERC-20 only
          const from = topicToAddress(l.topics[1]);
          const to = topicToAddress(l.topics[2]);
          const value = wordToBigint(strip0x(l.data).slice(0, 64));
          if (from === owner && to === this.vault) addFlow(l.address, value);
          if (from === this.vault && to === owner) addFlow(l.address, -value);
        }
      }

      ev.entryFlows = Object.fromEntries(
        [...flows].filter(([, v]) => v > 0n).map(([k, v]) => [k, v.toString()])
      );
      done++;
      if (done % 50 === 0 || done === pending.length) {
        this.store.rewrite(events); // checkpoint
        onProgress?.(done, pending.length);
      }
    }
    if (pending.length && done % 50 !== 0) this.store.rewrite(events);
    return done;
  }
}
