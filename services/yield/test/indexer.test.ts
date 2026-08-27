import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EngineIndexer, EventStore } from "../src/engine/indexer.js";
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
      const prev = all[i - 1];
      const cur = all[i];
      assert.ok(
        prev.blockNumber < cur.blockNumber ||
          (prev.blockNumber === cur.blockNumber && prev.logIndex <= cur.logIndex)
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scan: chunks the range, persists a resumable high-water mark", async () => {
  const dir = tempDir();
  try {
    const store = new EventStore(dir, VAULT);
    const rpc = new StubRpc(50_534_000, LOGS);
    const indexer = new EngineIndexer(rpc, store, VAULT, 1_000);
    const r = await indexer.scan();
    assert.equal(r.events, LOGS.length);
    assert.equal(store.readState()!.nextBlock, 50_534_001);
    assert.ok(rpc.getLogsCalls.length >= 4); // (534000−530000)/1000 chunks
    // resume: nothing new to scan
    const r2 = await indexer.scan();
    assert.equal(r2.events, 0);
    assert.equal(store.readAll().length, LOGS.length);
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
      from: ("0x" + l.topics[1].slice(26)) as Address,
      to: ("0x" + l.topics[2].slice(26)) as Address,
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
