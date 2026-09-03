/**
 * Engine event indexer: chunked backfill + head-follow over any RpcClient
 * (plain RPC or the Blockscout PRO gateway — identical semantics).
 *
 * Storage is an append-only JSONL of decoded EngineEvents plus a state file
 * with the high-water block, so every pass is resumable: kill it anywhere
 * and rerun — it continues from `nextBlock`. Timestamps and entry flows are
 * separate enrichment passes over the same store (also resumable), keeping
 * each pass simple and independently retryable.
 *
 * Crash-safety contract (the numbers this store feeds are marketed as
 * empirical — losing events silently is the worst failure mode):
 *   • state, rewrites, and bands.json are written ATOMICALLY: temp file →
 *     fsync(file) → rename → fsync(directory). A SIGKILL/disk-full can no
 *     longer leave a truncated store beside an advanced high-water mark.
 *   • state records the events-file line count; scan() REFUSES to run when
 *     the file is shorter than state claims (data was lost — the operator
 *     must delete state to re-scan, not silently skip the missing range).
 *   • readAll() tolerates ONE malformed FINAL line (a torn append): it is
 *     truncated away with a warning. A malformed INTERIOR line throws
 *     loudly — that is real corruption, not a crash artifact.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { TRANSFER_TOPIC, topicToAddress, wordToBigint, strip0x } from "../abi.js";
import type { RpcClient } from "../sources/rpc.js";
import type { Address, EngineEvent, PositionCreatedEvent } from "../types.js";
import { INDEXED_TOPICS, decodeEngineLog } from "./events.js";

/** Blocks below the chain head the indexer will not scan past (reorg guard). */
export const CONFIRMATION_DEPTH = 64;

export interface IndexerState {
  vault: Address;
  /** Next block to scan (inclusive). */
  nextBlock: number;
  /** Contract creation block (backfill start), once discovered. */
  creationBlock?: number;
  /**
   * Complete (newline-terminated) lines in the events file when this state
   * was written. scan() refuses to advance when the file has fewer — that
   * means indexed events were lost while the high-water mark survived.
   */
  eventsLineCount?: number;
  updatedAt: string;
}

/** Write `data` to `path` atomically and durably: tmp → fsync → rename → fsync(dir). */
export function atomicWriteFileSync(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    // Make the rename itself durable. Some platforms refuse directory fsync —
    // best effort there (the file content fsync above already happened).
    const dfd = openSync(dirname(path), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    /* directory fsync unsupported on this platform */
  }
}

export class EventStore {
  readonly eventsPath: string;
  readonly statePath: string;
  /** Cached count of complete lines in the events file (lazy). */
  private lineCountCache: number | null = null;

  constructor(dataDir: string, readonly vault: Address) {
    mkdirSync(dataDir, { recursive: true });
    this.eventsPath = join(dataDir, `events-${vault}.jsonl`);
    this.statePath = join(dataDir, `state-${vault}.json`);
  }

  readState(): IndexerState | null {
    if (!existsSync(this.statePath)) return null;
    const raw = readFileSync(this.statePath, "utf8");
    try {
      return JSON.parse(raw) as IndexerState;
    } catch (e) {
      throw new Error(
        `${this.statePath}: state file is not valid JSON (${(e as Error).message}). ` +
          `It predates atomic state writes or was edited by hand — delete it to re-scan.`
      );
    }
  }

  writeState(s: IndexerState): void {
    atomicWriteFileSync(
      this.statePath,
      JSON.stringify({
        ...s,
        eventsLineCount: this.countEventLines(),
        updatedAt: new Date().toISOString(),
      })
    );
  }

  /** Complete (newline-terminated) lines in the events file. */
  countEventLines(): number {
    if (this.lineCountCache !== null) return this.lineCountCache;
    if (!existsSync(this.eventsPath)) {
      this.lineCountCache = 0;
      return 0;
    }
    const content = readFileSync(this.eventsPath, "utf8");
    let n = 0;
    for (let i = 0; i < content.length; i++) if (content[i] === "\n") n++;
    this.lineCountCache = n;
    return n;
  }

  /**
   * Throw when the events file holds fewer complete lines than the state
   * file recorded — indexed events were lost (e.g. the file was truncated or
   * replaced) while the high-water mark survived, so scanning forward would
   * permanently skip the lost range.
   */
  verifyAgainstState(state: IndexerState | null): void {
    if (!state || state.eventsLineCount === undefined) return; // pre-upgrade state
    const actual = this.countEventLines();
    if (actual < state.eventsLineCount) {
      throw new Error(
        `${this.eventsPath}: holds ${actual} events but ${this.statePath} claims ` +
          `${state.eventsLineCount} were indexed — events were LOST while the scan ` +
          `high-water mark survived. Refusing to scan forward over the gap. ` +
          `Delete ${this.statePath} (and the events file) to re-scan from the creation block.`
      );
    }
  }

  append(events: EngineEvent[]): void {
    if (!events.length) return;
    appendFileSync(this.eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    if (this.lineCountCache !== null) this.lineCountCache += events.length;
  }

  /** Stream all stored events (dedup by tx:logIndex — appends are at-least-once). */
  readAll(): EngineEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const content = readFileSync(this.eventsPath, "utf8");
    const lines = content.split("\n");
    const seen = new Set<string>();
    const out: EngineEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let e: EngineEvent;
      try {
        e = JSON.parse(line) as EngineEvent;
      } catch {
        if (i === lines.length - 1) {
          // Torn FINAL line: the process died mid-append. The complete lines
          // before it are intact and state never counted the torn one —
          // truncate it away and continue.
          console.error(
            `${this.eventsPath}: truncating torn final line (${line.length} bytes) — ` +
              `crash artifact of an interrupted append`
          );
          atomicWriteFileSync(this.eventsPath, content.slice(0, content.lastIndexOf("\n") + 1));
          this.lineCountCache = null;
          continue;
        }
        throw new Error(
          `${this.eventsPath}: malformed JSON on interior line ${i + 1} — the store is ` +
            `corrupt (not a crash artifact; torn appends only affect the final line). ` +
            `Refusing to serve partial data; restore the file or delete it plus ` +
            `${this.statePath} to re-scan.`
        );
      }
      const key = `${e.transactionHash}:${e.logIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
    out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    return out;
  }

  /** Rewrite the store in place (enrichment passes) — atomic, never truncate-then-write. */
  rewrite(events: EngineEvent[]): void {
    atomicWriteFileSync(
      this.eventsPath,
      events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "")
    );
    this.lineCountCache = events.length;
  }
}

export interface ScanProgress {
  scanned: number;
  total: number;
  events: number;
}

export interface IndexerOptions {
  logChunk?: number;
  /**
   * First block to scan when no state exists. Skips the eth_getCode
   * creation-block bisection (which needs an archive node).
   */
  startBlock?: number;
}

export class EngineIndexer {
  private readonly logChunk: number;
  private readonly startBlock?: number;

  constructor(
    private readonly rpc: RpcClient,
    private readonly store: EventStore,
    private readonly vault: Address,
    opts: IndexerOptions | number = {}
  ) {
    // Back-compat: the 4th arg used to be the numeric chunk size.
    const o = typeof opts === "number" ? { logChunk: opts } : opts;
    this.logChunk = o.logChunk ?? 5_000;
    this.startBlock = o.startBlock;
  }

  /**
   * Scan [state.nextBlock, head − CONFIRMATION_DEPTH] in chunks, decoding +
   * appending as it goes. Stopping short of the chain head keeps reorged
   * blocks out of an append-only store that can never repair them. An
   * explicit `toBlock` is honored verbatim (tests, bounded backfills).
   * Safe to interrupt: state advances only after each chunk is persisted.
   */
  async scan(
    toBlock?: number,
    onProgress?: (p: ScanProgress) => void
  ): Promise<{ from: number; to: number; events: number }> {
    const head = toBlock ?? (await this.rpc.blockNumber()) - CONFIRMATION_DEPTH;
    let state = this.store.readState();
    this.store.verifyAgainstState(state);
    if (!state) {
      const creation =
        this.startBlock ?? (await this.rpc.contractCreationBlock(this.vault, head));
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
   *
   * Checkpoints after EVERY receipt: each fetch is billed (Blockscout
   * credits), so an abort must never lose paid-for work.
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
          const from = topicToAddress(l.topics[1]!);
          const to = topicToAddress(l.topics[2]!);
          const value = wordToBigint(strip0x(l.data).slice(0, 64));
          if (from === owner && to === this.vault) addFlow(l.address, value);
          if (from === this.vault && to === owner) addFlow(l.address, -value);
        }
      }

      ev.entryFlows = Object.fromEntries(
        [...flows].filter(([, v]) => v > 0n).map(([k, v]) => [k, v.toString()])
      );
      done++;
      this.store.rewrite(events); // checkpoint every receipt — fetches are billed
      onProgress?.(done, pending.length);
    }
    return done;
  }
}
