import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, openSync, writeSync } from "node:fs";
import { copyFile, link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute } from "node:path";
import type { Address, Hex } from "../types/evm.js";
import { isAddress, lowerAddress } from "../types/evm.js";
import type { LadderState } from "../engine/ladder.js";

/**
 * How account ids and transaction ids look on the chain this store serves. The store is chain-agnostic in
 * everything but this: EVM ids are 0x-hex and case-insensitive (normalised lower), Solana ids are base58 and
 * CASE-SENSITIVE (never normalised). A store file records its codec; opening it with another is refused.
 */
export interface IdCodec {
  name: "evm" | "base58";
  isId(v: string): boolean;
  normalize(v: string): string;
  isTxHash(v: string): boolean;
}
export const EVM_ID_CODEC: IdCodec = {
  name: "evm",
  isId: (v) => isAddress(v),
  normalize: (v) => v.toLowerCase(),
  isTxHash: (v) => /^0x[0-9a-fA-F]{64}$/.test(v),
};
export const BASE58_ID_CODEC: IdCodec = {
  name: "base58",
  isId: (v) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v),
  normalize: (v) => v,
  isTxHash: (v) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(v),
};

/**
 * Crash-safe keeper store: one JSON file, one writer.
 *
 * Guarantees (each has a test in test/keeperStore.test.ts):
 *   • Atomic persistence — write to a temp file, fsync, rename over the store.
 *     A crash mid-write leaves the previous store intact.
 *   • Single writer — `open()` takes a lock by creating a temp file and
 *     hard-`link()`ing it to `<store>.lock`. link(2) is atomic and fails with
 *     EEXIST when the lock exists, including on NFS where O_EXCL is unreliable.
 *     A lock held by a dead pid on this host is reclaimed once; a lock held by
 *     a live pid (or another host) is fatal.
 *   • External-edit detection — after every write the file's size, mtime,
 *     inode and SHA-256 are recorded; before every subsequent write they are
 *     re-checked. A mismatch means someone edited the store behind the
 *     keeper's back and the keeper REFUSES to write (StoreTamperedError):
 *     overwriting an operator's manual edit is worse than stopping, and a
 *     store the keeper did not write cannot be trusted for idempotency keys.
 *   • Duplicate-id rejection — accounts and dispatch records are arrays in
 *     the file (a JSON object silently drops duplicate keys); duplicates are
 *     rejected on load and on insert.
 *   • Monotonic counters — `episode` and `dispatchSeq` only ever increase and
 *     are persisted by the caller BEFORE the action they key (see
 *     dispatch/dispatcher.ts).
 *   • Serialised mutations — every `mutate` runs to completion (including the
 *     fsync'd rename) before the next begins.
 *   • SHORT WRITES ARE FATAL, NOT SILENT (audit C-HIGH-4). `write(2)` returns a
 *     short count on ENOSPC instead of throwing. The old `persist()` discarded
 *     that count, fsync'd a truncated temp file, renamed it over the good
 *     store, and reported success — and the fingerprint agreed, because it
 *     hashed the intended content while stat-ing the truncated file. The
 *     keeper then ran on state that no longer existed on disk and could never
 *     restart ("not valid JSON — refusing to start on a corrupt store", exit 1,
 *     supervisor crash-loop, every account's protection gone). Now every write
 *     loops to completion, the fd is `fstat`ed before the fsync, and any
 *     mismatch unlinks the temp file and throws.
 *   • A LAST-GOOD COPY — each successful write leaves `<store>.bak`, and a
 *     corrupt store degrades to "resume from the last good one" instead of
 *     "never start again".
 *   • TERMINAL RECORDS ARE PRUNED — dispatch records used to accumulate for
 *     ever, which is what filled the disk in the first place.
 *   • The single-writer lock is HEARTBEAT-based, not pid-based (audit C-MED-6,
 *     C-LOW-2): `process.kill(pid, 0)` answers about the CHECKING process's pid
 *     namespace, so a second container on the same volume saw the same
 *     hostname, a "dead" pid, stole the lock, and both wrote; and after a crash
 *     a REUSED pid made the lock unreclaimable for ever. A lock now carries a
 *     random instance id and a heartbeat, is reclaimable only when the
 *     heartbeat has gone stale, and is re-verified before every write.
 */

export const STORE_VERSION = 3 as const;
/** Versions this build can read. A v2 store is migrated in place on load. */
export const READABLE_VERSIONS = [2, 3] as const;

export type ValuationKind = "OK" | "NO_DEBT" | "UNKNOWN";

export interface AccountRecord<Id extends string = Address> {
  /** The account id, normalised by the store's codec (lower-cased on EVM, verbatim base58 on Solana). */
  account: Id;
  owner: Id;
  discoveredAtBlock: string;
  addedAt: string;
  ladder: LadderState;
  /** Episode number the account is currently in, or null when clear. */
  episode: number | null;
  lastHf: number | null;
  lastValuation: ValuationKind | null;
  lastEvaluatedAt: string | null;
  /** Consecutive UNKNOWN valuations (for escalation). */
  unknownStreak: number;
  /** Reasons behind the last UNKNOWN, so a dashboard can say WHY protection is off. */
  lastReasons?: string[];
  /** Last on-chain grant state seen for this account (expiry surfaced, not discarded). */
  grant?: {
    target: Id;
    selector: string;
    active: boolean;
    allowCallback: boolean;
    expiry: number;
    checkedAt: string;
  };
  /** Times a rung was re-armed because the action it fired did not clear it. */
  rungRefires?: Record<string, number>;
  /**
   * Durable per-account notification history (see notify/ownerNotifier.ts). Capped PER KIND,
   * oldest of that kind dropped first — one emergency episode's dispatch and escalation entries
   * used to push the `warn` entry out of a single shared ring (audit wave 2, N-LOW-1).
   */
  notifyHistory?: OwnerNotifyEntry[];
}

/**
 * One entry in an account's owner-notification history. Deliberately generic
 * (`kind`/`severity` as `string`, not `KeeperEventKind`/`Severity`) so the
 * store has no dependency on notify/notifier.ts — ownerNotifier.ts maps a
 * KeeperEvent into this shape. No PII: only what is already public on chain
 * (the account address, held as the record's key) plus the rung/hf/severity.
 */
export interface OwnerNotifyEntry {
  kind: string;
  severity: string;
  rung?: string;
  hf: number | null;
  at: string;
}

/**
 * PENDING    — key persisted, nothing sent yet (resume: dispatch with the same key)
 * SENT       — broadcast, awaiting receipt (resume: confirm)
 * CONFIRMED  — receipt success
 * NOTIFIED   — off-chain action (warn rung) delivered to a PERSON-FACING channel
 * LOGGED_ONLY— off-chain action written only to the keeper's own log/store;
 *              NOT terminal — retried like FAILED (audit wave 2, N-MED-1)
 * FAILED     — send/receipt failure; retried with the SAME key while the
 *              episode is open and attempts < max
 * REFUSED    — no grant on-chain / keeper cannot act; re-checked like FAILED
 * SUPERSEDED — a later, more severe dispatch for the account replaced it, or
 *              the world moved on (HF recovered) before it could act
 * ABANDONED  — retries exhausted; escalated to a human
 */
export type DispatchStatus =
  | "PENDING"
  | "SENT"
  | "CONFIRMED"
  | "NOTIFIED"
  | "LOGGED_ONLY"
  | "FAILED"
  | "REFUSED"
  | "SUPERSEDED"
  | "ABANDONED";

export const DISPATCH_STATUSES: readonly DispatchStatus[] = [
  "PENDING",
  "SENT",
  "CONFIRMED",
  "NOTIFIED",
  "LOGGED_ONLY",
  "FAILED",
  "REFUSED",
  "SUPERSEDED",
  "ABANDONED",
];

export interface DispatchRecord<Id extends string = Address, Tx extends string = Hex> {
  /** `${account}:${episode}:${seq}:${action}` */
  key: string;
  account: Id;
  episode: number;
  seq: number;
  action: string;
  rung: string;
  hf: number;
  status: DispatchStatus;
  txHash?: Tx;
  attempts: number;
  error?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Keeper nonce persisted BEFORE the broadcast. A crash between the send and
   * the store write used to replay the action and close a further slice of the
   * user's LP (audit C-MED-1); on resume this says a transaction may already
   * be out, and the plan is re-sized against the CURRENT debt rather than
   * blindly taking another fraction.
   */
  sentNonce?: number;
  /** Ids the plan intended to close, persisted with the key. */
  closeIds?: string[];
  /**
   * Every venue the registry names for the account, with what the account owed there and its
   * health factor there, read right before the broadcast (slice 5, 2026-09-10). `confirm()` judges
   * a venue the receipt left untouched against THIS: owed here at dispatch, USDC exhausted and every
   * book that was paid no healthier than it → an honest shortfall (CONFIRMED with a note); owed
   * here and skipped with USDC left, or owing now but not here → FAILED. Absent on a record from
   * before this build or a dispatch without a venue reader, when the older, stricter rule applies.
   */
  venueBooks?: VenueBook<Id>[];
  /** Times this record wedged a tick. Quarantined at the cap. */
  stalls?: number;
}

/** One venue's book for the account at dispatch time; bigints as decimal strings (JSON). */
export interface VenueBook<Id extends string = Address> {
  venue: Id;
  debtUsdc: string;
  hfWad: string;
}

export interface StoreState<Id extends string = Address, Tx extends string = Hex> {
  version: typeof STORE_VERSION;
  /** Which id codec wrote this file; absent on files from before 2026-09-12 (EVM). */
  idCodec?: IdCodec["name"];
  cursor: { lastScannedBlock: string } | null;
  /** `tick` drives evaluation rotation: a persisted counter, never the block
   *  number — at a 30 s poll Base advances ~15 blocks a tick, so `head % n`
   *  was a FIXED permutation for every account count dividing 15 and the same
   *  accounts were truncated every time (audit C-LOW-3). */
  counters: { episode: number; dispatchSeq: number; tick: number };
  accounts: AccountRecord<Id>[];
  dispatches: DispatchRecord<Id, Tx>[];
  /**
   * Owner-notification entries for accounts not registered yet (a startup race between
   * discovery and the first tick), keyed by lowercase account address; attached to the record on
   * registration. Additive, no version bump (audit wave 2, N-MED-1).
   */
  deferredNotify?: Record<string, OwnerNotifyEntry[]>;
}

export function emptyState<Id extends string = Address, Tx extends string = Hex>(codec: IdCodec = EVM_ID_CODEC): StoreState<Id, Tx> {
  return {
    version: STORE_VERSION,
    idCodec: codec.name,
    cursor: null,
    counters: { episode: 0, dispatchSeq: 0, tick: 0 },
    accounts: [],
    dispatches: [],
  };
}

export class StoreError extends Error {
  constructor(msg: string) {
    super(`store: ${msg}`);
    this.name = "StoreError";
  }
}
export class StoreLockedError extends StoreError {
  constructor(msg: string) {
    super(`locked — ${msg}`);
    this.name = "StoreLockedError";
  }
}
export class StoreTamperedError extends StoreError {
  constructor(msg: string) {
    super(`external edit detected — ${msg}`);
    this.name = "StoreTamperedError";
  }
}
/**
 * The lock we hold is gone or belongs to somebody else. Another writer is on
 * this store; this process must not write another byte. Fatal by construction:
 * the supervisor restarts into a clean re-read rather than the old behaviour
 * (an endless stream of caught exceptions in a process that looks healthy and
 * can no longer fire a single rung).
 */
export class StoreLockLostError extends StoreError {
  constructor(msg: string) {
    super(`lock lost — ${msg}`);
    this.name = "StoreLockLostError";
  }
}
/** A write that did not reach the disk intact (short write / ENOSPC). */
export class StoreWriteError extends StoreError {
  constructor(msg: string) {
    super(`write failed — ${msg}`);
    this.name = "StoreWriteError";
  }
}
/** Errors after which the keeper must stop rather than keep pretending. */
export function isFatalStoreError(e: unknown): boolean {
  return e instanceof StoreTamperedError || e instanceof StoreLockLostError || e instanceof StoreWriteError;
}
export class DuplicateIdError extends StoreError {
  constructor(kind: string, id: string) {
    super(`duplicate ${kind} id ${id}`);
    this.name = "DuplicateIdError";
  }
}

interface Fingerprint {
  size: number;
  mtimeMs: number;
  ino: number;
  sha256: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** Validate a parsed store document. Throws StoreError on any shape problem. */
export function validateState<Id extends string = Address, Tx extends string = Hex>(doc: unknown, codec: IdCodec = EVM_ID_CODEC): StoreState<Id, Tx> {
  if (!isRecord(doc)) throw new StoreError("document is not an object");
  if (doc.version !== STORE_VERSION) throw new StoreError(`unsupported version ${String(doc.version)}`);
  if (doc.idCodec !== undefined && doc.idCodec !== codec.name) {
    throw new StoreError(`store was written for the ${String(doc.idCodec)} id codec, this keeper uses ${codec.name}`);
  }
  if (!isRecord(doc.counters) || !isNonNegInt((doc.counters as Record<string, unknown>).tick)) {
    throw new StoreError("counters.tick malformed");
  }
  if (doc.cursor !== null && !(isRecord(doc.cursor) && typeof doc.cursor.lastScannedBlock === "string" && /^\d+$/.test(doc.cursor.lastScannedBlock))) {
    throw new StoreError("cursor malformed");
  }
  if (!isRecord(doc.counters) || !isNonNegInt(doc.counters.episode) || !isNonNegInt(doc.counters.dispatchSeq)) {
    throw new StoreError("counters malformed");
  }
  if (!Array.isArray(doc.accounts) || !Array.isArray(doc.dispatches)) throw new StoreError("accounts/dispatches must be arrays");

  const accountIds = new Set<string>();
  for (const a of doc.accounts as unknown[]) {
    if (!isRecord(a) || typeof a.account !== "string" || !codec.isId(a.account)) throw new StoreError("account record malformed");
    const id = codec.normalize(a.account);
    if (accountIds.has(id)) throw new DuplicateIdError("account", id);
    accountIds.add(id);
    if (typeof a.owner !== "string" || !codec.isId(a.owner)) throw new StoreError(`account ${id}: owner malformed`);
    if (!isRecord(a.ladder) || !Array.isArray(a.ladder.fired)) throw new StoreError(`account ${id}: ladder malformed`);
    if (a.episode !== null && !isNonNegInt(a.episode)) throw new StoreError(`account ${id}: episode malformed`);
    if (a.episode !== null && a.episode > (doc.counters as { episode: number }).episode) {
      throw new StoreError(`account ${id}: episode ${a.episode} exceeds counter`);
    }
    if (!isNonNegInt(a.unknownStreak)) throw new StoreError(`account ${id}: unknownStreak malformed`);
  }
  const keys = new Set<string>();
  for (const d of doc.dispatches as unknown[]) {
    if (!isRecord(d) || typeof d.key !== "string") throw new StoreError("dispatch record malformed");
    if (keys.has(d.key)) throw new DuplicateIdError("dispatch", d.key);
    keys.add(d.key);
    if (!isNonNegInt(d.episode) || !isNonNegInt(d.seq)) throw new StoreError(`dispatch ${d.key}: counters malformed`);
    const c = doc.counters as { episode: number; dispatchSeq: number };
    if (d.episode > c.episode || d.seq > c.dispatchSeq) {
      throw new StoreError(`dispatch ${d.key}: exceeds persisted counters (store rolled back?)`);
    }
    if (typeof d.status !== "string" || !DISPATCH_STATUSES.includes(d.status as DispatchStatus)) {
      throw new StoreError(`dispatch ${d.key}: status malformed`);
    }
    if (!isNonNegInt(d.attempts)) throw new StoreError(`dispatch ${d.key}: attempts malformed`);
    if (d.txHash !== undefined && !(typeof d.txHash === "string" && codec.isTxHash(d.txHash))) {
      throw new StoreError(`dispatch ${d.key}: txHash malformed`);
    }
    if (d.venueBooks !== undefined) {
      if (!Array.isArray(d.venueBooks)) throw new StoreError(`dispatch ${d.key}: venueBooks malformed`);
      for (const b of d.venueBooks as unknown[]) {
        const digits = (x: unknown) => typeof x === "string" && /^\d+$/.test(x);
        if (!isRecord(b) || typeof b.venue !== "string" || !codec.isId(b.venue) || !digits(b.debtUsdc) || !digits(b.hfWad)) {
          throw new StoreError(`dispatch ${d.key}: venueBooks entry malformed`);
        }
      }
    }
  }
  return doc as unknown as StoreState<Id, Tx>;
}

/** Parse + validate, with the corrupt-JSON message the operator sees. */
export function parseStore<Id extends string = Address, Tx extends string = Hex>(raw: string, path: string, codec: IdCodec = EVM_ID_CODEC): StoreState<Id, Tx> {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new StoreError(`${path} is not valid JSON — refusing to start on a corrupt store`);
  }
  return validateState<Id, Tx>(migrateDoc(doc), codec);
}

/** v2 → v3: the persisted tick counter that drives rotation did not exist. */
function migrateDoc(doc: unknown): unknown {
  if (!isRecord(doc)) return doc;
  if (doc.version === 2 && isRecord(doc.counters)) {
    return { ...doc, version: STORE_VERSION, counters: { ...doc.counters, tick: 0 } };
  }
  return doc;
}

function migrate<Id extends string, Tx extends string>(s: StoreState<Id, Tx>): StoreState<Id, Tx> {
  return s;
}

export interface KeeperStoreOptions {
  /** Injected for tests; defaults to process.pid. */
  pid?: number;
  /**
   * A lock whose heartbeat is older than this is reclaimable. Pid liveness is
   * NOT consulted: it answers about the checking process's pid namespace, and
   * it is wrong in both directions (stolen locks across containers; a reused
   * pid blocking a restart for ever).
   */
  lockStaleMs?: number;
  /** Injected for tests. */
  now?: () => Date;
  /** Terminal dispatch records kept per account (older ones are pruned). */
  keepTerminalPerAccount?: number;
  /** Owner-notification history entries kept per account (oldest dropped first). */
  ownerNotifyHistoryCap?: number;
  /**
   * Test hook for the raw write. Defaults to `writeSync`. A short return is
   * exactly what `write(2)` does on ENOSPC, and discarding it is what silently
   * truncated the store (audit C-HIGH-4) — so it must be testable.
   */
  writeChunk?: (fd: number, buf: Buffer, offset: number, length: number) => number;
  /** How ids look on this chain. Defaults to EVM (0x, lower-cased); the Solana keeper passes BASE58_ID_CODEC. */
  idCodec?: IdCodec;
}

export const STORE_DEFAULTS = {
  lockStaleMs: 5 * 60_000,
  keepTerminalPerAccount: 50,
  ownerNotifyHistoryCap: 20,
} as const;

const TERMINAL_STATUSES: readonly DispatchStatus[] = ["CONFIRMED", "NOTIFIED", "SUPERSEDED", "ABANDONED"];

export class KeeperStore<Id extends string = Address, Tx extends string = Hex> {
  private state: StoreState<Id, Tx> | null = null;
  private fingerprint: Fingerprint | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private locked = false;
  private readonly lockPath: string;
  private readonly bakPath: string;
  private readonly pid: number;
  private readonly lockStaleMs: number;
  private readonly keepTerminalPerAccount: number;
  private readonly ownerNotifyHistoryCap: number;
  private readonly writeChunk: (fd: number, buf: Buffer, offset: number, length: number) => number;
  private readonly now: () => Date;
  readonly codec: IdCodec;
  /** Random per-process id written into the lock and re-verified before every write. */
  readonly instanceId: string = randomUUID();
  /** Set once an unrecoverable store error happens; every later write repeats it. */
  private fatalError: Error | null = null;
  /** True when this store was loaded from `<path>.bak` after the primary was corrupt. */
  recoveredFromBackup = false;

  constructor(
    readonly path: string,
    opts: KeeperStoreOptions = {}
  ) {
    if (!isAbsolute(path)) throw new StoreError(`path must be absolute: ${path}`);
    this.lockPath = `${path}.lock`;
    this.bakPath = `${path}.bak`;
    this.pid = opts.pid ?? process.pid;
    this.lockStaleMs = opts.lockStaleMs ?? STORE_DEFAULTS.lockStaleMs;
    this.keepTerminalPerAccount = opts.keepTerminalPerAccount ?? STORE_DEFAULTS.keepTerminalPerAccount;
    this.ownerNotifyHistoryCap = opts.ownerNotifyHistoryCap ?? STORE_DEFAULTS.ownerNotifyHistoryCap;
    this.writeChunk = opts.writeChunk ?? ((fd, buf, offset, length) => writeSync(fd, buf, offset, length));
    this.now = opts.now ?? (() => new Date());
    this.codec = opts.idCodec ?? EVM_ID_CODEC;
  }

  /** Normalise an id the way this store's chain does (lower-case on EVM, verbatim on Solana). */
  private id(v: string): Id {
    return this.codec.normalize(v) as Id;
  }

  /** The error that poisoned this store, if any. The keeper exits on it. */
  get fatal(): Error | null {
    return this.fatalError;
  }

  private poison<T extends Error>(e: T): T {
    if (isFatalStoreError(e)) this.fatalError = e;
    return e;
  }

  // ---- lifecycle ----------------------------------------------------------

  async open(): Promise<void> {
    if (this.locked) return;
    await mkdir(dirname(this.path), { recursive: true });
    await this.acquireLock();
    try {
      await this.loadFromDisk();
    } catch (e) {
      await this.releaseLock();
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.queue; // drain
    await this.releaseLock();
    this.state = null;
    this.fingerprint = null;
  }

  private lockBody(): string {
    return JSON.stringify({
      instanceId: this.instanceId,
      pid: this.pid,
      host: hostname(),
      at: this.now().toISOString(),
      heartbeatAt: this.now().toISOString(),
    });
  }

  private async acquireLock(): Promise<void> {
    const tmp = `${this.lockPath}.${this.pid}.${process.hrtime.bigint().toString(36)}`;
    await writeFile(tmp, this.lockBody());
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await link(tmp, this.lockPath);
          this.locked = true;
          return;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          const holder = await this.readLockHolder();
          const heartbeatAgeMs =
            holder && holder.heartbeatAt ? this.now().getTime() - Date.parse(holder.heartbeatAt) : Number.POSITIVE_INFINITY;
          if (attempt === 0 && (!holder || heartbeatAgeMs > this.lockStaleMs)) {
            // The holder stopped heartbeating: it is gone, whatever its pid says
            // (a pid can be reused, and a pid from another namespace is not ours
            // to judge). Reclaim once.
            await unlink(this.lockPath).catch(() => undefined);
            continue;
          }
          throw new StoreLockedError(
            holder
              ? `held by pid ${holder.pid} on ${holder.host} since ${holder.at} (heartbeat ${Math.round(heartbeatAgeMs / 1000)}s ago; reclaimable after ${Math.round(this.lockStaleMs / 1000)}s)`
              : `${this.lockPath} exists`
          );
        }
      }
      throw new StoreLockedError("could not acquire after reclaim");
    } finally {
      await unlink(tmp).catch(() => undefined);
    }
  }

  /** Refresh the heartbeat and prove the lock is still ours. Fatal if it is not. */
  private async assertLockOurs(): Promise<void> {
    if (!this.locked) throw this.poison(new StoreLockLostError("this process does not hold the lock"));
    const holder = await this.readLockHolder();
    if (!holder) throw this.poison(new StoreLockLostError(`${this.lockPath} vanished — another writer may have reclaimed it`));
    if (holder.instanceId !== undefined && holder.instanceId !== this.instanceId) {
      throw this.poison(new StoreLockLostError(`held by another instance (${holder.instanceId}) — two writers on one store`));
    }
    await writeFile(this.lockPath, this.lockBody()).catch(() => undefined);
  }

  private async readLockHolder(): Promise<{ pid: number; host: string; at: string; heartbeatAt?: string; instanceId?: string } | null> {
    try {
      const raw = await readFile(this.lockPath, "utf8");
      const j = JSON.parse(raw) as Record<string, unknown>;
      if (typeof j.pid === "number" && typeof j.host === "string") {
        return {
          pid: j.pid,
          host: j.host,
          at: typeof j.at === "string" ? j.at : "?",
          heartbeatAt: typeof j.heartbeatAt === "string" ? j.heartbeatAt : typeof j.at === "string" ? j.at : undefined,
          instanceId: typeof j.instanceId === "string" ? j.instanceId : undefined,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.locked) return;
    this.locked = false;
    await unlink(this.lockPath).catch(() => undefined);
  }

  private async loadFromDisk(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.state = emptyState<Id, Tx>(this.codec);
        await this.persist();
        return;
      }
      throw e;
    }
    try {
      this.state = migrate(parseStore<Id, Tx>(raw, this.path, this.codec));
      this.fingerprint = await this.fingerprintOf(raw);
      return;
    } catch (primary) {
      // The primary store is unreadable. Before refusing to start — which is
      // an unstartable keeper and a crash-looping supervisor, i.e. every
      // account unprotected — try the last good copy we kept beside it.
      let bak: string;
      try {
        bak = await readFile(this.bakPath, "utf8");
      } catch {
        throw primary;
      }
      let recovered: StoreState<Id, Tx>;
      try {
        recovered = migrate(parseStore<Id, Tx>(bak, this.bakPath, this.codec));
      } catch {
        throw primary;
      }
      this.state = recovered;
      this.recoveredFromBackup = true;
      await this.persist(); // rewrite the primary from the recovered state
    }
  }

  private async fingerprintOf(content: string): Promise<Fingerprint> {
    const st = await stat(this.path);
    return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, sha256: sha256(content) };
  }

  /** Throws StoreTamperedError when the file no longer matches our last write. */
  async assertUntampered(): Promise<void> {
    if (!this.fingerprint) return;
    let st;
    try {
      st = await stat(this.path);
    } catch {
      throw this.poison(new StoreTamperedError("store file vanished"));
    }
    const fp = this.fingerprint;
    if (st.size !== fp.size || st.ino !== fp.ino || st.mtimeMs !== fp.mtimeMs) {
      const raw = await readFile(this.path, "utf8").catch(() => "");
      if (sha256(raw) !== fp.sha256) throw this.poison(new StoreTamperedError(`${this.path} changed on disk since last write`));
      // Same content, different metadata (e.g. copied back): accept and re-pin.
      this.fingerprint = { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, sha256: fp.sha256 };
    }
  }

  /**
   * Atomic, VERIFIED write: temp file → every byte written → fstat the fd →
   * fsync → keep the previous store as `<path>.bak` → rename.
   *
   * The `writeSync` loop and the `fstat` are the fix for audit C-HIGH-4: on a
   * full disk `write(2)` returns a short count instead of throwing, so the old
   * one-shot `writeSync(fd, content)` fsync'd and renamed a TRUNCATED file over
   * a good store, reported success to every caller, and left a keeper that
   * could never restart.
   */
  private async persist(): Promise<void> {
    if (!this.state) throw new StoreError("not open");
    const content = JSON.stringify(this.state, null, 2);
    const bytes = Buffer.from(content, "utf8");
    const tmp = `${this.path}.tmp.${this.pid}.${process.hrtime.bigint().toString(36)}`;
    let fd: number | null = null;
    try {
      fd = openSync(tmp, "w", 0o600);
      let written = 0;
      while (written < bytes.length) {
        const n = this.writeChunk(fd, bytes, written, bytes.length - written);
        if (n <= 0) {
          throw this.poison(
            new StoreWriteError(`wrote ${written} of ${bytes.length} bytes to ${tmp} and made no progress (disk full?)`)
          );
        }
        written += n;
      }
      const st = fstatSync(fd);
      if (st.size !== bytes.length) {
        throw this.poison(new StoreWriteError(`${tmp} is ${st.size} bytes on disk, expected ${bytes.length} (disk full?)`));
      }
      fsyncSync(fd);
    } catch (e) {
      if (fd !== null) closeSync(fd);
      fd = null;
      await unlink(tmp).catch(() => undefined);
      throw e instanceof StoreError ? e : this.poison(new StoreWriteError(`${tmp}: ${(e as Error).message}`));
    } finally {
      if (fd !== null) closeSync(fd);
    }
    // Last-good copy, best effort: a corrupt primary then degrades to
    // "resume from the previous store" instead of "never start again".
    await copyFile(this.path, this.bakPath).catch(() => undefined);
    await rename(tmp, this.path);
    // Fingerprint the FILE, not the intended content: hashing what we meant to
    // write is how a truncation stayed invisible.
    const onDisk = await readFile(this.path, "utf8");
    if (onDisk.length !== content.length) {
      throw this.poison(new StoreWriteError(`${this.path} is ${onDisk.length} chars after rename, expected ${content.length}`));
    }
    this.fingerprint = await this.fingerprintOf(onDisk);
  }

  // ---- reads --------------------------------------------------------------

  private snapshot(): StoreState<Id, Tx> {
    if (!this.state) throw new StoreError("not open");
    return this.state;
  }

  getState(): Readonly<StoreState<Id, Tx>> {
    return structuredClone(this.snapshot());
  }

  listAccounts(): AccountRecord<Id>[] {
    return structuredClone(this.snapshot().accounts);
  }

  getAccount(account: Id): AccountRecord<Id> | undefined {
    const id = this.id(account);
    const a = this.snapshot().accounts.find((x) => x.account === id);
    return a ? structuredClone(a) : undefined;
  }

  /** An account's owner-notification history, oldest first, capped. */
  getOwnerNotifyHistory(account: Id): OwnerNotifyEntry[] {
    const id = this.id(account);
    const a = this.snapshot().accounts.find((x) => x.account === id);
    if (a) return structuredClone(a.notifyHistory ?? []);
    // Not registered yet: whatever was recorded for it is waiting in the deferred bucket.
    return structuredClone(this.snapshot().deferredNotify?.[id] ?? []);
  }

  getDispatch(key: string): DispatchRecord<Id, Tx> | undefined {
    const d = this.snapshot().dispatches.find((x) => x.key === key);
    return d ? structuredClone(d) : undefined;
  }

  listDispatches(filter?: { account?: Id; status?: DispatchStatus }): DispatchRecord<Id, Tx>[] {
    const acc = filter?.account ? this.id(filter.account) : undefined;
    return structuredClone(
      this.snapshot().dispatches.filter(
        (d) => (acc === undefined || d.account === acc) && (filter?.status === undefined || d.status === filter.status)
      )
    );
  }

  get counters(): Readonly<StoreState<Id, Tx>["counters"]> {
    return { ...this.snapshot().counters };
  }

  get cursor(): bigint | null {
    const c = this.snapshot().cursor;
    return c ? BigInt(c.lastScannedBlock) : null;
  }

  // ---- writes (serialised, atomic, tamper-checked) ------------------------

  /**
   * Apply `fn` to the state and persist. Mutations are serialised; the state
   * handed to `fn` is the live object — return normally to commit, throw to
   * roll back (the in-memory copy is restored from the last persisted JSON).
   */
  mutate<T>(fn: (s: StoreState<Id, Tx>) => T): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.fatalError) throw this.fatalError;
      if (!this.locked) throw new StoreError("not open");
      await this.assertLockOurs();
      await this.assertUntampered();
      const before = JSON.stringify(this.state);
      let result: T;
      try {
        result = fn(this.snapshot());
        validateState(JSON.parse(JSON.stringify(this.state)), this.codec);
      } catch (e) {
        this.state = JSON.parse(before) as StoreState<Id, Tx>;
        throw e;
      }
      try {
        await this.persist();
      } catch (e) {
        this.state = JSON.parse(before) as StoreState<Id, Tx>;
        throw e;
      }
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  registerAccount(rec: { account: Id; owner: Id; discoveredAtBlock: bigint }, now: Date): Promise<AccountRecord<Id>> {
    return this.mutate((s) => {
      const id = this.id(rec.account);
      if (s.accounts.some((a) => a.account === id)) throw new DuplicateIdError("account", id);
      const a: AccountRecord<Id> = {
        account: id,
        owner: this.id(rec.owner),
        discoveredAtBlock: rec.discoveredAtBlock.toString(),
        addedAt: now.toISOString(),
        ladder: { fired: [] },
        episode: null,
        lastHf: null,
        lastValuation: null,
        lastEvaluatedAt: null,
        unknownStreak: 0,
      };
      // Entries recorded before discovery reached this account (audit wave 2, N-MED-1).
      const deferred = s.deferredNotify?.[id];
      if (deferred && deferred.length) {
        a.notifyHistory = deferred;
        delete s.deferredNotify![id];
      }
      s.accounts.push(a);
      return structuredClone(a);
    });
  }

  updateAccount(account: Id, patch: Partial<Omit<AccountRecord<Id>, "account" | "owner">>): Promise<AccountRecord<Id>> {
    return this.mutate((s) => {
      const id = this.id(account);
      const a = s.accounts.find((x) => x.account === id);
      if (!a) throw new StoreError(`account ${id} not registered`);
      Object.assign(a, patch);
      return structuredClone(a);
    });
  }

  /**
   * Append one entry to `account`'s owner-notification history, capped at
   * `ownerNotifyHistoryCap` PER KIND (oldest of that kind dropped first). An account that is not
   * registered yet gets the entry in a deferred bucket that `registerAccount` attaches later —
   * never dropped, never a delivery failure (audit wave 2, N-MED-1 / N-LOW-1).
   */
  recordOwnerNotification(account: Id, entry: OwnerNotifyEntry): Promise<OwnerNotifyEntry[]> {
    return this.mutate((s) => {
      const id = this.id(account);
      const a = s.accounts.find((x) => x.account === id);
      const list = a ? (a.notifyHistory ?? (a.notifyHistory = [])) : ((s.deferredNotify ??= {})[id] ??= []);
      list.push(entry);
      this.capPerKind(list, entry.kind);
      return structuredClone(list);
    });
  }

  private capPerKind(list: OwnerNotifyEntry[], kind: string): void {
    let count = list.filter((e) => e.kind === kind).length;
    for (let i = 0; i < list.length && count > this.ownerNotifyHistoryCap; ) {
      if (list[i].kind === kind) {
        list.splice(i, 1);
        count -= 1;
      } else {
        i += 1;
      }
    }
  }

  setCursor(lastScannedBlock: bigint): Promise<void> {
    return this.mutate((s) => {
      const prev = s.cursor ? BigInt(s.cursor.lastScannedBlock) : -1n;
      if (lastScannedBlock < prev) throw new StoreError(`cursor cannot move backwards (${prev} → ${lastScannedBlock})`);
      s.cursor = { lastScannedBlock: lastScannedBlock.toString() };
    });
  }

  /** Allocate the next episode number for `account` and persist it. */
  beginEpisode(account: Id): Promise<number> {
    return this.mutate((s) => {
      const id = this.id(account);
      const a = s.accounts.find((x) => x.account === id);
      if (!a) throw new StoreError(`account ${id} not registered`);
      if (a.episode !== null) throw new StoreError(`account ${id} already in episode ${a.episode}`);
      s.counters.episode += 1;
      a.episode = s.counters.episode;
      return a.episode;
    });
  }

  endEpisode(account: Id): Promise<void> {
    return this.mutate((s) => {
      const id = this.id(account);
      const a = s.accounts.find((x) => x.account === id);
      if (!a) throw new StoreError(`account ${id} not registered`);
      a.episode = null;
    });
  }

  /**
   * Allocate a dispatch sequence number, mint the key and persist a PENDING
   * record — all before the caller sends anything. Returns the record.
   */
  createDispatch(input: { account: Id; episode: number; action: string; rung: string; hf: number }, now: Date): Promise<DispatchRecord<Id, Tx>> {
    return this.mutate((s) => {
      const id = this.id(input.account);
      s.counters.dispatchSeq += 1;
      const seq = s.counters.dispatchSeq;
      const key = `${id}:${input.episode}:${seq}:${input.action}`;
      if (s.dispatches.some((d) => d.key === key)) throw new DuplicateIdError("dispatch", key);
      const d: DispatchRecord<Id, Tx> = {
        key,
        account: id,
        episode: input.episode,
        seq,
        action: input.action,
        rung: input.rung,
        hf: input.hf,
        status: "PENDING",
        attempts: 0,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      s.dispatches.push(d);
      return structuredClone(d);
    });
  }

  /** Advance and return the persisted tick counter (drives evaluation rotation). */
  nextTick(): Promise<number> {
    return this.mutate((s) => {
      s.counters.tick += 1;
      return s.counters.tick;
    });
  }

  /**
   * Drop terminal dispatch records beyond `keepTerminalPerAccount` per account,
   * newest first. Records used to accumulate for ever — the store only grew,
   * which is what eventually filled the disk (audit C-HIGH-4 / INFO note).
   * Live records (PENDING/SENT/FAILED/REFUSED) are never pruned.
   */
  prune(): Promise<number> {
    // Cheap pre-check: pruning nothing must not cost a write (every persist is
    // an fsync, and the disk-full path is exactly what this guards against).
    if (!this.needsPrune()) return Promise.resolve(0);
    return this.mutate((s) => {
      const keep = this.keepTerminalPerAccount;
      const terminalByAccount = new Map<string, DispatchRecord<Id, Tx>[]>();
      for (const d of s.dispatches) {
        if (!TERMINAL_STATUSES.includes(d.status)) continue;
        const arr = terminalByAccount.get(d.account) ?? [];
        arr.push(d);
        terminalByAccount.set(d.account, arr);
      }
      const drop = new Set<string>();
      for (const [, list] of terminalByAccount) {
        if (list.length <= keep) continue;
        list.sort((a, b) => b.seq - a.seq);
        for (const d of list.slice(keep)) drop.add(d.key);
      }
      if (drop.size === 0) return 0;
      s.dispatches = s.dispatches.filter((d) => !drop.has(d.key));
      return drop.size;
    });
  }

  private needsPrune(): boolean {
    const counts = new Map<string, number>();
    for (const d of this.snapshot().dispatches) {
      if (!TERMINAL_STATUSES.includes(d.status)) continue;
      const n = (counts.get(d.account) ?? 0) + 1;
      if (n > this.keepTerminalPerAccount) return true;
      counts.set(d.account, n);
    }
    return false;
  }

  updateDispatch(
    key: string,
    patch: Partial<Pick<DispatchRecord<Id, Tx>, "status" | "txHash" | "attempts" | "error" | "sentNonce" | "closeIds" | "venueBooks" | "stalls">>,
    now: Date
  ): Promise<DispatchRecord<Id, Tx>> {
    return this.mutate((s) => {
      const d = s.dispatches.find((x) => x.key === key);
      if (!d) throw new StoreError(`dispatch ${key} not found`);
      Object.assign(d, patch, { updatedAt: now.toISOString() });
      return structuredClone(d);
    });
  }
}

export function dispatchKey(account: Address, episode: number, seq: number, action: string): string {
  return `${lowerAddress(account)}:${episode}:${seq}:${action}`;
}
