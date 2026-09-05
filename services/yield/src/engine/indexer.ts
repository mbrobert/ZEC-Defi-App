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
import { INDEXED_TOPICS, MalformedLogError, decodeEngineLog } from "./events.js";

export interface IndexerState {
  vault: Address;
  /** Next block to scan (inclusive). */
  nextBlock: number;
  /** Contract creation block (backfill start), once discovered. */
  creationBlock?: number;
  /**
   * Logs whose topic0 we index but whose shape was wrong (STRICT decoding).
   * Counted and skipped — never booked as zeros. Non-zero here after an
   * engine upgrade means `npm run backfill -- verify-events` is due.
   */
  malformedLogs?: number;
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
  malformed: number;
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
  ): Promise<{ from: number; to: number; events: number; malformed: number }> {
    const head = toBlock ?? (await this.rpc.blockNumber());
    let state = this.store.readState();
    if (!state) {
      const creation = await this.rpc.contractCreationBlock(this.vault, head);
      state = { vault: this.vault, nextBlock: creation, creationBlock: creation, malformedLogs: 0, updatedAt: "" };
      this.store.writeState(state);
    }
    const from = state.nextBlock;
    let total = 0;
    let malformed = 0;
    for (let lo = from; lo <= head; lo += this.logChunk) {
      const hi = Math.min(lo + this.logChunk - 1, head);
      const logs = await this.rpc.getLogs(this.vault, lo, hi, [INDEXED_TOPICS]);
      const events: EngineEvent[] = [];
      for (const l of logs) {
        try {
          const e = decodeEngineLog(l);
          if (e) events.push(e);
        } catch (err) {
          if (!(err instanceof MalformedLogError)) throw err;
          malformed++;
          console.warn(err.message);
        }
      }
      this.store.append(events);
      total += events.length;
      state.nextBlock = hi + 1;
      state.malformedLogs = (state.malformedLogs ?? 0) + malformed;
      malformed = 0;
      this.store.writeState(state);
      onProgress?.({ scanned: hi - from + 1, total: head - from + 1, events: total, malformed: state.malformedLogs });
    }
    return { from, to: head, events: total, malformed: state.malformedLogs ?? 0 };
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
   * the deposit tx receipt and split the ERC-20 transfers into INFLOWS
   * (owner→vault) and REFUNDS (vault→owner), per token, kept SEPARATE.
   *
   * Attribution rules (methodology v2 — audit Lens F + wave 2):
   *   • Inflows are only owner→vault legs; refunds only vault→owner legs
   *     of the SAME tx. Internal legs (vault↔adapter↔pool, incl. dust the
   *     adapter returns to the vault) are excluded.
   *   • A refund in a token the owner did NOT deposit (the other pool token
   *     of a single-sided deposit) is recorded, not dropped — it reduces
   *     principal at valuation.
   *   • Which refund legs COUNT is decided at fold time against the
   *     position's pool tokens (engine/lifecycles.ts); an unrelated
   *     vault→owner leg never becomes a refund.
   *   • `entryTxPositions` records how many PositionCreated the deposit tx
   *     contains. More than one → the flows cannot be attributed to one
   *     position and the lifecycle is refused (excluded, counted), never
   *     split by guesswork.
   * Uses Blockscout's decoded `txTokenTransfers` when a key is configured;
   * raw receipt logs otherwise — identical semantics.
   */
  async fillEntryFlows(
    txTransfers?: (txHash: `0x${string}`) => Promise<{ token: Address; from: Address; to: Address; value: string }[]>,
    onProgress?: (done: number, total: number) => void
  ): Promise<number> {
    const events = this.store.readAll();
    const createdPerTx = new Map<string, number>();
    for (const e of events) {
      if (e.kind === "PositionCreated") {
        createdPerTx.set(e.transactionHash, (createdPerTx.get(e.transactionHash) ?? 0) + 1);
      }
    }
    const pending = events.filter(
      (e): e is PositionCreatedEvent => e.kind === "PositionCreated" && e.entryFlows === undefined
    );
    let done = 0;
    for (const ev of pending) {
      const inflows = new Map<Address, bigint>();
      const refunds = new Map<Address, bigint>();
      const add = (m: Map<Address, bigint>, token: Address, delta: bigint) =>
        m.set(token, (m.get(token) ?? 0n) + delta);

      const owner = ev.owner.toLowerCase();
      if (txTransfers) {
        for (const t of await txTransfers(ev.transactionHash)) {
          const token = t.token.toLowerCase() as Address;
          if (t.from === owner && t.to === this.vault) add(inflows, token, BigInt(t.value));
          if (t.from === this.vault && t.to === owner) add(refunds, token, BigInt(t.value));
        }
      } else {
        const receipt = await this.rpc.getReceipt(ev.transactionHash);
        for (const l of receipt?.logs ?? []) {
          if (l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue; // ERC-20 only
          const data = strip0x(l.data);
          if (data.length !== 64) continue; // strict: a Transfer carries exactly one word
          const from = topicToAddress(l.topics[1]);
          const to = topicToAddress(l.topics[2]);
          const value = wordToBigint(data);
          const token = l.address.toLowerCase() as Address;
          if (from === owner && to === this.vault) add(inflows, token, value);
          if (from === this.vault && to === owner) add(refunds, token, value);
        }
      }

      ev.entryFlows = Object.fromEntries([...inflows].filter(([, v]) => v > 0n).map(([k, v]) => [k, v.toString()]));
      ev.entryRefunds = Object.fromEntries([...refunds].filter(([, v]) => v > 0n).map(([k, v]) => [k, v.toString()]));
      ev.entryTxPositions = createdPerTx.get(ev.transactionHash) ?? 1;
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
