import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIRMATION_DEPTH, EngineIndexer, EventStore } from "../src/engine/indexer.js";
import { decodeEngineLog } from "../src/engine/events.js";
import { RpcClient } from "../src/sources/rpc.js";
import { DEPOSIT_RECEIPT, LOGS } from "./fixtures/engine.js";
import type { Address, EngineEvent, Hex, PositionCreatedEvent, RawLog } from "../src/types.js";

const VAULT = "0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55" as Address;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "yield-test-"));
}

/** RpcClient stub serving the captured fixtures without any network. */
class StubRpc extends RpcClient {
  getLogsCalls: [number, number][] = [];
  constructor(private readonly head: number, private readonly logs: RawLog[]) {
    super("http://unused.invalid");
  }
  override async blockNumber(): Promise<number> { return this.head; }
  override async contractCreationBlock(): Promise<number> { return 50_530_000; }
  override async getLogs(_a: Address, from: number, to: number): Promise<RawLog[]> {
    this.getLogsCalls.push([from, to]);
    return this.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to);
  }
  override async blockTimestamps(blocks: number[]): Promise<Map<number, number>> {
    return new Map(blocks.map((b) => [b, 1_700_000_000 + b]));
  }
  override async getReceipt(): Promise<{ logs: RawLog[] }> {
    return {
      logs: DEPOSIT_RECEIPT.erc20.map((l, i) => ({
        address: l.address as Address, topics: l.topics as Hex[], data: l.data as Hex,
        blockNumber: 50531295, transactionHash: DEPOSIT_RECEIPT.tx as Hex, logIndex: i,
      })),
    };
  }
}

test("EventStore: append is at-least-once, readAll dedups and orders", () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const events = LOGS.map((l) => decodeEngineLog(l)!) as EngineEvent[];
    store.append(events.slice(0, 6));
    store.append(events.slice(4)); // overlap 4,5 on purpose
    const all = store.readAll();
    assert.equal(all.length, LOGS.length);
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1]!;
      const cur = all[i]!;
      assert.ok(
        prev.blockNumber < cur.blockNumber ||
          (prev.blockNumber === cur.blockNumber && prev.logIndex <= cur.logIndex)
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: chunks the range, stops CONFIRMATION_DEPTH short of head, persists a resumable high-water mark", async () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const rpc = new StubRpc(50_534_000, LOGS);
    const indexer = new EngineIndexer(rpc, store, VAULT, 1_000);
    const r = await indexer.scan();
    assert.equal(r.events, LOGS.length);
    // Head 50_534_000 → scanned only to head − 64 (reorg guard); the last 64
    // blocks are left for the next pass once they are final.
    assert.equal(r.to, 50_534_000 - CONFIRMATION_DEPTH);
    assert.equal(store.readState()!.nextBlock, 50_534_000 - CONFIRMATION_DEPTH + 1);
    assert.ok(rpc.getLogsCalls.length >= 3); // (533936−530000)/1000 chunks
    // resume: nothing new to scan
    const r2 = await indexer.scan();
    assert.equal(r2.events, 0);
    assert.equal(store.readAll().length, LOGS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan honors an explicit --to-block verbatim (no confirmation offset)", async () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const rpc = new StubRpc(50_534_000, LOGS);
    const indexer = new EngineIndexer(rpc, store, VAULT, 10_000);
    const r = await indexer.scan(50_534_000);
    assert.equal(r.to, 50_534_000);
    assert.equal(store.readState()!.nextBlock, 50_534_001);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fillTimestamps enriches every event once", async () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const rpc = new StubRpc(50_534_000, LOGS);
    const indexer = new EngineIndexer(rpc, store, VAULT, 10_000);
    await indexer.scan();
    const n = await indexer.fillTimestamps();
    assert.ok(n > 0);
    assert.ok(store.readAll().every((e) => typeof e.timestamp === "number"));
    assert.equal(await indexer.fillTimestamps(), 0); // idempotent
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fillEntryFlows (raw-receipt path): nets deposit inflows minus same-tx refunds", async () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const rpc = new StubRpc(50_534_000, LOGS);
    const indexer = new EngineIndexer(rpc, store, VAULT, 10_000);
    await indexer.scan();
    const n = await indexer.fillEntryFlows();
    assert.equal(n, 2); // two PositionCreated fixtures
    const created = store
      .readAll()
      .filter((e): e is PositionCreatedEvent => e.kind === "PositionCreated")
      .find((e) => e.transactionHash === DEPOSIT_RECEIPT.tx)!;
    // Independently computed from the captured receipt:
    //   WETH: 0x572e83490cdbc00 in − 0x11e refund = 392631429999999714
    //   USDC: 0x3b193628 in − 0x859b19 refund = 982752015
    assert.equal(created.entryFlows!["0x4200000000000000000000000000000000000006"], "392631429999999714");
    assert.equal(created.entryFlows!["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"], "982752015");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fillEntryFlows (decoded-transfers path): same result through the Blockscout shape", async () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const rpc = new StubRpc(50_534_000, LOGS);
    const indexer = new EngineIndexer(rpc, store, VAULT, 10_000);
    await indexer.scan();
    const transfers = DEPOSIT_RECEIPT.erc20.map((l) => ({
      token: l.address as Address,
      from: ("0x" + l.topics[1]!.slice(26)) as Address,
      to: ("0x" + l.topics[2]!.slice(26)) as Address,
      value: BigInt(l.data).toString(),
    }));
    await indexer.fillEntryFlows(async (tx) =>
      tx === DEPOSIT_RECEIPT.tx ? transfers : []
    );
    const created = store
      .readAll()
      .filter((e): e is PositionCreatedEvent => e.kind === "PositionCreated")
      .find((e) => e.transactionHash === DEPOSIT_RECEIPT.tx)!;
    assert.equal(created.entryFlows!["0x4200000000000000000000000000000000000006"], "392631429999999714");
    assert.equal(created.entryFlows!["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"], "982752015");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Crash-safety (Y-02): torn writes, lost events, atomic persistence.
// ---------------------------------------------------------------------------

test("readAll tolerates a torn FINAL line (crash mid-append): truncates it and keeps the rest", () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const events = LOGS.map((l) => decodeEngineLog(l)!) as EngineEvent[];
    store.append(events);
    // Simulate SIGKILL mid-appendFileSync: a partial trailing line, no newline.
    appendFileSync(store.eventsPath, '{"kind":"FeesHarvested","tokenId":"9","block');
    const all = store.readAll();
    assert.equal(all.length, events.length); // complete lines intact
    // The torn tail was physically removed so later passes read clean.
    assert.ok(readFileSync(store.eventsPath, "utf8").endsWith("\n"));
    assert.equal(store.readAll().length, events.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readAll throws LOUDLY on a malformed INTERIOR line (real corruption, not a crash artifact)", () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const events = LOGS.map((l) => decodeEngineLog(l)!) as EngineEvent[];
    store.append(events.slice(0, 2));
    appendFileSync(store.eventsPath, "{corrupt interior}\n");
    store.append(events.slice(2, 4));
    assert.throws(() => store.readAll(), /interior line 3/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan REFUSES when the events file is shorter than state claims (lost data must not be skipped)", async () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const rpc = new StubRpc(50_534_000, LOGS);
    const indexer = new EngineIndexer(rpc, store, VAULT, 10_000);
    await indexer.scan();
    const before = store.readState()!;
    assert.equal(before.eventsLineCount, LOGS.length); // state records the count
    // Simulate the old crash-mid-rewrite outcome: events gone, state advanced.
    writeFileSync(store.eventsPath, "");
    const store2 = new EventStore(dir, VAULT); // fresh process
    const indexer2 = new EngineIndexer(rpc, store2, VAULT, 10_000);
    await assert.rejects(() => indexer2.scan(), /delete .*state.*re-scan/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewrite is atomic: no truncate-then-write window, content replaced in one rename", () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const events = LOGS.map((l) => decodeEngineLog(l)!) as EngineEvent[];
    store.append(events);
    const enriched = store.readAll().map((e) => ({ ...e, timestamp: 1 }));
    store.rewrite(enriched);
    const all = store.readAll();
    assert.equal(all.length, events.length);
    assert.ok(all.every((e) => e.timestamp === 1));
    // Post-rewrite state writes carry the rewritten line count.
    store.writeState({ vault: VAULT, nextBlock: 1, updatedAt: "" });
    assert.equal(store.readState()!.eventsLineCount, events.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("torn state file fails with a clear message (legacy pre-atomic artifact)", () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    writeFileSync(store.statePath, '{"vault":"0x7d27","nextBlo');
    assert.throws(() => store.readState(), /not valid JSON.*delete it to re-scan/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("YIELD_START_BLOCK skips the creation-block bisection", async () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    class NoArchiveRpc extends StubRpc {
      override async contractCreationBlock(): Promise<number> {
        throw new Error("eth_getCode at historical block: archive node required");
      }
    }
    const rpc = new NoArchiveRpc(50_534_000, LOGS);
    const indexer = new EngineIndexer(rpc, store, VAULT, {
      logChunk: 10_000,
      startBlock: 50_530_000,
    });
    const r = await indexer.scan();
    assert.equal(r.from, 50_530_000);
    assert.equal(r.events, LOGS.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
