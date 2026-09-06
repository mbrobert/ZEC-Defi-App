import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, link, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DuplicateIdError,
  KeeperStore,
  StoreError,
  StoreLockedError,
  StoreLockLostError,
  StoreTamperedError,
  StoreWriteError,
  dispatchKey,
  emptyState,
  validateState,
} from "../src/store/keeperStore.js";
import { ACCOUNT_A, ACCOUNT_B, OWNER_A, OWNER_B } from "./fixtures.js";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "keeper-store-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-05T01:00:00Z");
let n = 0;
const fresh = () => join(dir, `s${++n}.json`);

describe("keeper store — basics", () => {
  it("requires an absolute path", () => {
    assert.throws(() => new KeeperStore("relative/store.json"), StoreError);
  });

  it("creates an empty store on first open, persists across reopen", async () => {
    const p = fresh();
    const s = new KeeperStore(p);
    await s.open();
    assert.deepEqual(s.getState(), emptyState());
    await s.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 5n }, NOW);
    await s.setCursor(10n);
    await s.close();
    const s2 = new KeeperStore(p);
    await s2.open();
    assert.equal(s2.listAccounts().length, 1);
    assert.equal(s2.listAccounts()[0].account, ACCOUNT_A.toLowerCase());
    assert.equal(s2.cursor, 10n);
    await s2.close();
  });

  it("rejects duplicate account ids and duplicate dispatch keys on insert", async () => {
    const s = new KeeperStore(fresh());
    await s.open();
    await s.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    await assert.rejects(
      s.registerAccount({ account: ACCOUNT_A.toUpperCase().replace("0X", "0x") as `0x${string}`, owner: OWNER_B, discoveredAtBlock: 2n }, NOW),
      DuplicateIdError
    );
    assert.equal(s.listAccounts().length, 1);
    const ep = await s.beginEpisode(ACCOUNT_A);
    const d = await s.createDispatch({ account: ACCOUNT_A, episode: ep, action: "repay", rung: "repay", hf: 1.3 }, NOW);
    assert.equal(d.key, dispatchKey(ACCOUNT_A, ep, 1, "repay"));
    // Forge a duplicate by direct mutation → validation rejects and rolls back.
    await assert.rejects(
      s.mutate((st) => {
        st.dispatches.push({ ...st.dispatches[0] });
      }),
      DuplicateIdError
    );
    assert.equal(s.listDispatches().length, 1);
    await s.close();
  });

  it("rejects duplicate ids present in the FILE on load", async () => {
    const p = fresh();
    const doc = emptyState();
    const a = { account: ACCOUNT_A.toLowerCase(), owner: OWNER_A.toLowerCase(), discoveredAtBlock: "1", addedAt: NOW.toISOString(), ladder: { fired: [] }, episode: null, lastHf: null, lastValuation: null, lastEvaluatedAt: null, unknownStreak: 0 };
    (doc.accounts as unknown[]).push(a, { ...a, owner: OWNER_B.toLowerCase() });
    await writeFile(p, JSON.stringify(doc));
    const s = new KeeperStore(p);
    await assert.rejects(s.open(), DuplicateIdError);
    // The lock must not be left behind after a failed open.
    await assert.rejects(stat(`${p}.lock`), /ENOENT/);
  });

  it("refuses corrupt JSON, wrong version, and counters that a record exceeds (rolled-back store)", async () => {
    const p1 = fresh();
    await writeFile(p1, "{not json");
    await assert.rejects(new KeeperStore(p1).open(), /not valid JSON/);
    const p2 = fresh();
    await writeFile(p2, JSON.stringify({ ...emptyState(), version: 1 }));
    await assert.rejects(new KeeperStore(p2).open(), /unsupported version/);
    const p3 = fresh();
    const doc = emptyState();
    doc.dispatches.push({ key: "k", account: ACCOUNT_A, episode: 3, seq: 1, action: "repay", rung: "repay", hf: 1, status: "PENDING", attempts: 0, createdAt: "x", updatedAt: "x" });
    await writeFile(p3, JSON.stringify(doc));
    await assert.rejects(new KeeperStore(p3).open(), /exceeds persisted counters/);
    assert.throws(() => validateState({ ...emptyState(), counters: { episode: -1, dispatchSeq: 0, tick: 0 } }), /counters malformed/);
    assert.throws(() => validateState({ ...emptyState(), counters: { episode: 0, dispatchSeq: 0 } }), /counters.tick malformed/);

    // FIX C-4: a v2 store (no tick counter) is MIGRATED, not refused — refusing
    // to start is how a keeper stops protecting anybody.
    const p4 = fresh();
    const v2 = { ...emptyState(), version: 2, counters: { episode: 0, dispatchSeq: 0 } };
    await writeFile(p4, JSON.stringify(v2));
    const migrated = new KeeperStore(p4);
    await migrated.open();
    assert.deepEqual(migrated.counters, { episode: 0, dispatchSeq: 0, tick: 0 });
    await migrated.close();
  });
});

describe("keeper store — crash safety and locking", () => {
  it("writes are atomic: no temp files linger and a failed mutation leaves the file unchanged", async () => {
    const p = fresh();
    const s = new KeeperStore(p);
    await s.open();
    await s.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    const before = await readFile(p, "utf8");
    await assert.rejects(
      s.mutate((st) => {
        st.accounts[0].owner = "not an address" as `0x${string}`;
        throw new Error("simulated crash inside mutation");
      }),
      /simulated crash/
    );
    assert.equal(await readFile(p, "utf8"), before);
    assert.equal(s.listAccounts()[0].owner, OWNER_A.toLowerCase());
    const files = await readdir(dir);
    assert.ok(!files.some((f) => f.includes(".tmp.")), `temp files linger: ${files}`);
    await s.close();
  });

  it("temp-file + link() lock: a second opener is refused while the first holds it", async () => {
    const p = fresh();
    const a = new KeeperStore(p, { pid: 1001 });
    await a.open();
    const b = new KeeperStore(p, { pid: 1002 });
    await assert.rejects(b.open(), StoreLockedError);
    await assert.rejects(b.open(), /held by pid 1001/);
    await a.close();
    await b.open(); // released
    await b.close();
  });

  it("FIX C-6/C-9: the lock is reclaimed on a STALE HEARTBEAT, never on a pid guess", async () => {
    const p = fresh();
    // A crashed keeper: the lock file stays behind with an old heartbeat.
    const crashed = new KeeperStore(p, { pid: 424242, now: () => new Date(Date.now() - 3_600_000) });
    await crashed.open();
    (crashed as unknown as { locked: boolean }).locked = false;
    // A REUSED pid must not block the restart (audit C-LOW-2) …
    const s = new KeeperStore(p, { pid: 424242, lockStaleMs: 60_000 });
    await s.open();
    assert.equal(JSON.parse(await readFile(`${p}.lock`, "utf8")).pid, 424242);
    const firstInstance = s.instanceId;
    await s.close();

    // … and a LIVE holder is refused even from another pid namespace where the
    // holder's pid looks dead (audit C-MED-6: two containers, one volume).
    const holder = new KeeperStore(p, { pid: 9 });
    await holder.open();
    const other = new KeeperStore(p, { pid: 9 }); // same pid, different "namespace"
    await assert.rejects(other.open(), StoreLockedError);
    await assert.rejects(other.open(), /reclaimable after/);
    await holder.close();
    assert.notEqual(firstInstance, holder.instanceId, "each opener gets its own instance id");
  });

  it("FIX C-6: a lock stolen by another instance makes every later write FATAL, not an endless caught exception", async () => {
    const p = fresh();
    const a = new KeeperStore(p, { pid: 1 });
    await a.open();
    await a.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, new Date());
    // Somebody else takes the lock (stale-heartbeat reclaim, or a manual rm).
    await writeFile(`${p}.lock`, JSON.stringify({ instanceId: "someone-else", pid: 2, host: "vm", at: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
    await assert.rejects(a.updateAccount(ACCOUNT_A, { unknownStreak: 1 }), StoreLockLostError);
    assert.ok(a.fatal instanceof StoreLockLostError, "the store must poison itself so the keeper stops");
    await assert.rejects(a.updateAccount(ACCOUNT_A, { unknownStreak: 2 }), StoreLockLostError);
    await a.close();
  });

  it("the lock is a hard link (link() semantics), so a racing link() fails with EEXIST", async () => {
    const p = fresh();
    const s = new KeeperStore(p, { pid: 1 });
    await s.open();
    const tmp = `${p}.racer`;
    await writeFile(tmp, "{}");
    await assert.rejects(link(tmp, `${p}.lock`), /EEXIST/);
    await unlink(tmp);
    await s.close();
  });

  it("external edit detection: a store edited behind the keeper's back refuses further writes", async () => {
    const p = fresh();
    const s = new KeeperStore(p);
    await s.open();
    await s.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    // Operator edits the file by hand.
    const doc = JSON.parse(await readFile(p, "utf8"));
    doc.counters.episode = 99;
    await writeFile(p, JSON.stringify(doc));
    await assert.rejects(s.registerAccount({ account: ACCOUNT_B, owner: OWNER_B, discoveredAtBlock: 2n }, NOW), StoreTamperedError);
    // And it keeps refusing (no silent overwrite), until reopened.
    await assert.rejects(s.setCursor(1n), StoreTamperedError);
    await s.close();
    const s2 = new KeeperStore(p);
    await s2.open();
    assert.equal(s2.counters.episode, 99);
    await s2.close();
  });

  it("external edit detection: same content copied back (metadata changed) is accepted", async () => {
    const p = fresh();
    const s = new KeeperStore(p);
    await s.open();
    await s.setCursor(5n);
    const content = await readFile(p, "utf8");
    await new Promise((r) => setTimeout(r, 5));
    await writeFile(p, content); // touches mtime/inode, same bytes
    await s.setCursor(6n);
    assert.equal(s.cursor, 6n);
    await s.close();
  });

  it("mutations are serialised: concurrent writers never interleave or lose updates", async () => {
    const p = fresh();
    const s = new KeeperStore(p);
    await s.open();
    await Promise.all(Array.from({ length: 25 }, (_, i) => s.registerAccount({ account: `0x${(i + 1).toString(16).padStart(40, "0")}` as `0x${string}`, owner: OWNER_A, discoveredAtBlock: BigInt(i) }, NOW)));
    assert.equal(s.listAccounts().length, 25);
    const onDisk = JSON.parse(await readFile(p, "utf8"));
    assert.equal(onDisk.accounts.length, 25);
    await s.close();
  });
});

describe("keeper store — counters and episodes", () => {
  it("episode and dispatchSeq are monotonic and persisted before the caller can act", async () => {
    const p = fresh();
    const s = new KeeperStore(p);
    await s.open();
    await s.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    const e1 = await s.beginEpisode(ACCOUNT_A);
    assert.equal(e1, 1);
    assert.equal(JSON.parse(await readFile(p, "utf8")).counters.episode, 1); // on disk already
    await assert.rejects(s.beginEpisode(ACCOUNT_A), /already in episode/);
    const d1 = await s.createDispatch({ account: ACCOUNT_A, episode: e1, action: "repay", rung: "repay", hf: 1.3 }, NOW);
    assert.equal(JSON.parse(await readFile(p, "utf8")).dispatches[0].key, d1.key);
    const d2 = await s.createDispatch({ account: ACCOUNT_A, episode: e1, action: "derisk", rung: "derisk", hf: 1.1 }, NOW);
    assert.ok(d2.seq > d1.seq);
    await s.endEpisode(ACCOUNT_A);
    const e2 = await s.beginEpisode(ACCOUNT_A);
    assert.equal(e2, 2);
    await s.close();
    // Counters survive a restart and never go backwards.
    const s2 = new KeeperStore(p);
    await s2.open();
    assert.deepEqual(s2.counters, { episode: 2, dispatchSeq: 2, tick: 0 });
    await s2.registerAccount({ account: ACCOUNT_B, owner: OWNER_B, discoveredAtBlock: 1n }, NOW);
    assert.equal(await s2.beginEpisode(ACCOUNT_B), 3);
    await s2.close();
  });

  it("cursor never moves backwards", async () => {
    const s = new KeeperStore(fresh());
    await s.open();
    await s.setCursor(100n);
    await assert.rejects(s.setCursor(99n), /cannot move backwards/);
    await s.setCursor(100n);
    await s.close();
  });

  it("updateDispatch tracks status/txHash/attempts and validates the txHash shape", async () => {
    const s = new KeeperStore(fresh());
    await s.open();
    await s.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    const ep = await s.beginEpisode(ACCOUNT_A);
    const d = await s.createDispatch({ account: ACCOUNT_A, episode: ep, action: "repay", rung: "repay", hf: 1.3 }, NOW);
    const tx = ("0x" + "ab".repeat(32)) as `0x${string}`;
    const u = await s.updateDispatch(d.key, { status: "SENT", txHash: tx, attempts: 1 }, NOW);
    assert.equal(u.status, "SENT");
    assert.equal(s.getDispatch(d.key)?.txHash, tx);
    await assert.rejects(s.updateDispatch(d.key, { txHash: "0x1234" as `0x${string}` }, NOW), /txHash malformed/);
    await assert.rejects(s.updateDispatch("nope", { status: "FAILED" }, NOW), /not found/);
    assert.equal(s.listDispatches({ status: "SENT" }).length, 1);
    assert.equal(s.listDispatches({ account: ACCOUNT_B }).length, 0);
    await s.close();
  });
});
