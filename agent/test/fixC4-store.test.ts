import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSync } from "node:fs";
import {
  KeeperStore,
  StoreError,
  StoreWriteError,
  isFatalStoreError,
} from "../src/store/keeperStore.js";
import { ACCOUNT_A, ACCOUNT_B, OWNER_A, OWNER_B } from "./fixtures.js";

/**
 * HARVESTED FROM /tmp/audit2/C/poc9-store.test.js — expectations FLIPPED.
 *
 * The PoC filled a real 100 KiB tmpfs and recorded:
 *
 *     registerAccount() calls that reported SUCCESS: 3000  errors thrown: 0
 *     in-memory accounts: 3000
 *     bytes actually on disk: 49152 on a 100 KiB filesystem
 *     JSON.parse of the persisted store: Unterminated string in JSON at position 49152
 *     assertUntampered() after the truncation: passes — the corruption is invisible
 *     restart on that store: … is not valid JSON — refusing to start on a corrupt store
 *
 * `write(2)` returns a SHORT COUNT on ENOSPC rather than throwing; `persist()`
 * discarded it, fsync'd the partial temp file, renamed it over the good store,
 * and the fingerprint agreed because it hashed the intended content while
 * stat-ing the truncated file. The keeper then ran on state that no longer
 * existed and could never restart.
 *
 * The short write is injected here rather than by filling a real filesystem, so
 * the regression runs anywhere; the behaviour under test is identical.
 */

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fixC4-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

let seq = 0;
const fresh = () => join(dir, `s${seq++}.json`);
const NOW = new Date("2026-09-06T00:00:00.000Z");

describe("FIX C-4: a short write is loud, and never corrupts the store", () => {
  it("FIX C-4: a truncating write REJECTS, poisons the store, and leaves the last good file intact", async () => {
    const p = fresh();
    let truncate = false;
    let partialDone = false;
    const s = new KeeperStore(p, {
      // ENOSPC on a nearly-full disk: the kernel takes what fits, returns the
      // short count, and then accepts nothing more.
      writeChunk: (fd, buf, offset, length) => {
        if (!truncate) return writeSync(fd, buf, offset, length);
        if (partialDone) return 0;
        partialDone = true;
        return writeSync(fd, buf, offset, Math.max(1, Math.floor(length / 3)));
      },
    });
    await s.open();
    await s.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    const good = await readFile(p, "utf8");

    truncate = true;
    // Was: resolved successfully, 0 errors, a truncated file on disk.
    await assert.rejects(s.registerAccount({ account: ACCOUNT_B, owner: OWNER_B, discoveredAtBlock: 2n }, NOW), StoreWriteError);
    await assert.rejects(
      s.registerAccount({ account: ACCOUNT_B, owner: OWNER_B, discoveredAtBlock: 2n }, NOW),
      /wrote \d+ of \d+ bytes|is \d+ bytes on disk/
    );
    assert.ok(isFatalStoreError(s.fatal), "the store must poison itself, not carry on");
    // The good store is untouched and still parses.
    assert.equal(await readFile(p, "utf8"), good);
    JSON.parse(good);
    // The in-memory state rolled back with it: no phantom account.
    assert.equal(s.listAccounts().length, 1);
    // Every later write repeats the same fatal instead of pretending.
    await assert.rejects(s.registerAccount({ account: ACCOUNT_B, owner: OWNER_B, discoveredAtBlock: 2n }, NOW), StoreWriteError);
    await s.close();

    // …and the keeper RESTARTS on it (the old failure mode was "never again").
    const s2 = new KeeperStore(p);
    await s2.open();
    assert.equal(s2.listAccounts().length, 1);
    await s2.close();
  });

  it("FIX C-4: a corrupt primary store degrades to the last good copy instead of refusing to start", async () => {
    const p = fresh();
    const s = new KeeperStore(p);
    await s.open();
    await s.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    await s.registerAccount({ account: ACCOUNT_B, owner: OWNER_B, discoveredAtBlock: 2n }, NOW);
    await s.close();

    // Whatever the cause (a truncation from an older build, a bad editor save):
    const whole = await readFile(p, "utf8");
    await writeFile(p, whole.slice(0, Math.floor(whole.length / 2)));

    const s2 = new KeeperStore(p);
    await s2.open();
    assert.equal(s2.recoveredFromBackup, true);
    assert.ok(s2.listAccounts().length >= 1, "the backup carried the fleet forward");
    JSON.parse(await readFile(p, "utf8")); // the primary was rewritten from it
    await s2.close();
  });

  it("FIX C-4: with no usable backup the store still refuses to start on garbage — it never invents state", async () => {
    const p = fresh();
    await writeFile(p, "{not json");
    await writeFile(`${p}.bak`, "also not json");
    await assert.rejects(new KeeperStore(p).open(), StoreError);
    await assert.rejects(new KeeperStore(p).open(), /not valid JSON/);
  });

  it("FIX C-4: terminal dispatch records are pruned, so the store cannot grow for ever", async () => {
    const p = fresh();
    const s = new KeeperStore(p, { keepTerminalPerAccount: 5 });
    await s.open();
    await s.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    const ep = await s.beginEpisode(ACCOUNT_A);
    for (let i = 0; i < 30; i++) {
      const d = await s.createDispatch({ account: ACCOUNT_A, episode: ep, action: "repay", rung: "repay", hf: 1.3 }, NOW);
      await s.updateDispatch(d.key, { status: "CONFIRMED" }, NOW);
    }
    const live = await s.createDispatch({ account: ACCOUNT_A, episode: ep, action: "derisk", rung: "derisk", hf: 1.1 }, NOW);
    const dropped = await s.prune();
    assert.equal(dropped, 25);
    const left = s.listDispatches({ account: ACCOUNT_A });
    assert.equal(left.length, 6); // 5 terminal + the live one
    assert.ok(left.some((d) => d.key === live.key), "a PENDING record is never pruned");
    // Counters are untouched, so keys stay unique for ever.
    assert.equal(s.counters.dispatchSeq, 31);
    await s.close();
    const s2 = new KeeperStore(p);
    await s2.open(); // still valid after pruning
    assert.equal(s2.listDispatches().length, 6);
    await s2.close();
  });
});
