import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Strategy } from "@zyo/shared";
import { StrategyStore } from "../src/store/strategyStore.js";

function tempStore(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "agent-store-"));
  return { dir, path: join(dir, "strategies.json") };
}

function strat(id = "s1"): Strategy {
  return {
    id,
    owner: { zcashAddress: "t1Le9mTDaqQUX1ANKaeDchpJsxEY4h5LQCX" },
    mode: "SIMPLE_LENDING",
    status: "ACTIVE_SIMPLE",
    rewardPreference: "COMPOUND",
    lending: { mcaId: "mca.1", suppliedZecAtomic: "100000000" },
    createdAt: "0",
    updatedAt: "0",
  };
}

describe("StrategyStore durability (A-05)", () => {
  it("ENOENT means empty; a corrupt file THROWS instead of silently blanking the ledger", async () => {
    const { dir, path } = tempStore();
    try {
      assert.deepEqual(await new StrategyStore(path).list(), []); // missing file OK

      writeFileSync(path, "{ not json");
      const corrupt = new StrategyStore(path);
      await assert.rejects(() => corrupt.list(), /unreadable.*Refusing/s);
      // and the next write must NOT have happened implicitly:
      assert.equal(readFileSync(path, "utf8"), "{ not json");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects structurally wrong JSON (not an array of records with string ids)", async () => {
    const { dir, path } = tempStore();
    try {
      for (const bad of ["null", "{}", '"x"', '[{"noId":1}]', "[42]"]) {
        writeFileSync(path, bad);
        await assert.rejects(() => new StrategyStore(path).list(), /StoreCorrupt|unreadable/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a rolling .bak of the previous good file before replacing it", async () => {
    const { dir, path } = tempStore();
    try {
      const store = new StrategyStore(path);
      await store.upsert(strat("s1"));
      assert.ok(!existsSync(`${path}.bak`)); // first write: nothing to back up
      await store.upsert(strat("s2"));
      const bak = JSON.parse(readFileSync(`${path}.bak`, "utf8")) as Strategy[];
      assert.deepEqual(bak.map((s) => s.id), ["s1"]); // previous good version
      const cur = JSON.parse(readFileSync(path, "utf8")) as Strategy[];
      assert.deepEqual(cur.map((s) => s.id).sort(), ["s1", "s2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("StrategyStore concurrency (A-07)", () => {
  it("patch FUNCTIONS see the current record — interleaved writers cannot revert nested fields", async () => {
    const { dir, path } = tempStore();
    try {
      const store = new StrategyStore(path);
      await store.upsert(strat());
      // health tick takes a snapshot…
      const snapshot = (await store.list())[0]!;
      // …then the upgrade executor commits a borrow…
      await store.update("s1", (cur) => ({
        ...cur,
        lending: { ...cur.lending, borrowedAsset: "USDC", borrowedAmountAtomic: "500000000" },
      }));
      // …and the health tick writes its healthFactor. With the OLD object
      // patch built from `snapshot`, this erased borrowedAmountAtomic and the
      // position vanished from the health monitor (hasDebt=false).
      void snapshot;
      await store.update("s1", (cur) => ({
        ...cur,
        lending: { ...cur.lending, healthFactor: 1.9 },
      }));
      const after = (await store.get("s1"))!;
      assert.equal(after.lending.borrowedAmountAtomic, "500000000"); // survived
      assert.equal(after.lending.healthFactor, 1.9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("20 concurrent updates all succeed (serialized persists, unique temp files)", async () => {
    const { dir, path } = tempStore();
    try {
      const store = new StrategyStore(path);
      await store.upsert(strat());
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          store.update("s1", (cur) => ({ ...cur, createdAt: String(i) }))
        )
      );
      assert.equal(results.filter((r) => r.status === "rejected").length, 0);
      // no stray temp files left behind
      assert.deepEqual(
        readdirSync(dir).filter((f) => f.includes(".tmp")),
        []
      );
      // the file on disk is valid JSON with the record present
      const cur = JSON.parse(readFileSync(path, "utf8")) as Strategy[];
      assert.equal(cur.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("object patches still work for scalar fields (back-compat)", async () => {
    const { dir, path } = tempStore();
    try {
      const store = new StrategyStore(path);
      await store.upsert(strat());
      const next = await store.update("s1", { status: "CLOSED" });
      assert.equal(next.status, "CLOSED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
