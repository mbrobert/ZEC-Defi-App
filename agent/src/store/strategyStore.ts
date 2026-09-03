import { copyFile, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import type { Strategy } from "@zyo/shared";

/**
 * Small JSON-file strategy store with atomic, durable writes.
 * Deliberately boring: v1 runs a single agent process; swap for Postgres
 * when the agent becomes multi-instance.
 *
 * Durability contract (this file is the only user→MCA→position ledger):
 *   • load(): ONLY ENOENT means "empty store". Every other failure —
 *     permissions, a directory at the path, torn/invalid JSON, wrong shape —
 *     rethrows with context so a corrupt ledger can never be silently
 *     replaced by an empty one on the next write.
 *   • persist(): unique temp file (pid + counter) → fsync → rename, with a
 *     rolling `.bak` copy of the previous good file taken first. Concurrent
 *     persists are serialized through a promise chain so writers can never
 *     race each other's temp files.
 *   • update() takes a PATCH FUNCTION applied to the CURRENT record, so two
 *     interleaved read-modify-write loops (health tick vs upgrade executor)
 *     cannot clobber each other's nested `lending`/`lp` fields.
 */

export type StrategyPatch = (current: Strategy) => Strategy;

export class StoreCorruptError extends Error {
  constructor(path: string, cause: string) {
    super(
      `strategy store ${path} is unreadable (${cause}). Refusing to continue with an empty ` +
        `store — that would erase the ledger on the next write. Inspect the file (a .bak of ` +
        `the previous good version may sit beside it) and repair or remove it explicitly.`
    );
    this.name = "StoreCorruptError";
  }
}

function isValidStrategyList(v: unknown): v is Strategy[] {
  return (
    Array.isArray(v) &&
    v.every(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        typeof (s as { id?: unknown }).id === "string" &&
        (s as { id: string }).id.length > 0
    )
  );
}

export class StrategyStore {
  private cache: Map<string, Strategy> | null = null;
  /** Serializes persist() calls — a new write always waits for the previous. */
  private writeChain: Promise<void> = Promise.resolve();
  private tmpCounter = 0;

  constructor(private readonly path: string) {}

  private async load(): Promise<Map<string, Strategy>> {
    if (this.cache) return this.cache;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = new Map();
        return this.cache;
      }
      // EACCES, EISDIR, EMFILE, … — surface, never blank the ledger.
      throw new StoreCorruptError(this.path, (err as Error).message);
    }
    let list: unknown;
    try {
      list = JSON.parse(raw);
    } catch (err) {
      throw new StoreCorruptError(this.path, `invalid JSON: ${(err as Error).message}`);
    }
    if (!isValidStrategyList(list)) {
      throw new StoreCorruptError(this.path, "not an array of strategy records with string ids");
    }
    this.cache = new Map(list.map((s) => [s.id, s]));
    return this.cache;
  }

  /** Enqueue an atomic write of the current cache; serialized with all others. */
  private persist(): Promise<void> {
    const run = async (): Promise<void> => {
      if (!this.cache) return;
      await mkdir(dirname(this.path), { recursive: true });
      // Rolling backup of the previous good file (best effort — absent on first write).
      try {
        await copyFile(this.path, `${this.path}.bak`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      const tmp = `${this.path}.${process.pid}.${++this.tmpCounter}.tmp`;
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(JSON.stringify([...this.cache.values()], null, 2));
        await fh.sync(); // durable before the rename makes it visible
      } finally {
        await fh.close();
      }
      await rename(tmp, this.path);
    };
    const next = this.writeChain.then(run);
    // Keep the chain alive even when a write fails; the caller still sees the rejection.
    this.writeChain = next.catch(() => {});
    return next;
  }

  async list(): Promise<Strategy[]> {
    return [...(await this.load()).values()];
  }

  async get(id: string): Promise<Strategy | undefined> {
    return (await this.load()).get(id);
  }

  async upsert(strategy: Strategy): Promise<void> {
    const map = await this.load();
    map.set(strategy.id, { ...strategy, updatedAt: new Date().toISOString() });
    await this.persist();
  }

  /**
   * Apply a patch to the CURRENT stored record. Prefer the function form —
   * it reads the record at apply time, so no await-window snapshot can
   * silently revert another writer's nested fields. The object form remains
   * for simple scalar patches (it is a shallow merge onto the current record).
   */
  async update(id: string, patch: StrategyPatch | Partial<Strategy>): Promise<Strategy> {
    const map = await this.load();
    const existing = map.get(id);
    if (!existing) throw new Error(`strategy ${id} not found`);
    const patched = typeof patch === "function" ? patch(existing) : { ...existing, ...patch };
    const next = { ...patched, id, updatedAt: new Date().toISOString() };
    map.set(id, next);
    await this.persist();
    return next;
  }
}
