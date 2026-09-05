/**
 * PROGRESS watchdog — not an elapsed-time watchdog.
 *
 * AUDIT-FINDINGS Part 4 row 2: the round-2 watchdog measured elapsed time,
 * killed a healthy-but-slow tick mid-unwind, and the supervisor restarted into
 * the same wall forever (9 of 40 accounts ever assessed). The rule here:
 *
 *   A tick is stalled only if NO unit of work has completed for `stallMs`.
 *   A tick that keeps completing units — however slowly — is never touched.
 *
 * On a stall the watchdog aborts the current tick (via its AbortSignal — the
 * loop cooperatively stops scheduling more work and every in-flight RPC has
 * its own deadline) and schedules the NEXT tick after an exponential backoff.
 * It never exits the process: the daemon stays up, keeps its lock, and tries
 * again later with a longer gap. Any tick that makes progress resets the
 * backoff to zero. There is no restart loop because there is no restart.
 */

export interface WatchdogOptions {
  stallMs: number;
  backoff: { initialMs: number; maxMs: number; factor: number };
  now?: () => number;
  onStall?: (info: { stalls: number; backoffMs: number; progress: number; idleMs: number }) => void;
}

export interface TickHandle {
  signal: AbortSignal;
  /** Report that one unit of work completed. */
  bump: (n?: number) => void;
  /** Mark the tick finished (success or failure). */
  end: () => void;
}

export class ProgressWatchdog {
  private readonly now: () => number;
  private progress = 0;
  private lastProgress = 0;
  private lastProgressAt: number;
  private controller: AbortController | null = null;
  private stalls = 0;
  private backoffMs = 0;
  private tickProgressed = false;

  constructor(private readonly opts: WatchdogOptions) {
    if (!(opts.stallMs > 0)) throw new RangeError("stallMs must be > 0");
    if (!(opts.backoff.initialMs > 0) || !(opts.backoff.maxMs >= opts.backoff.initialMs) || !(opts.backoff.factor > 1)) {
      throw new RangeError("backoff must have initialMs > 0, maxMs ≥ initialMs, factor > 1");
    }
    this.now = opts.now ?? (() => Date.now());
    this.lastProgressAt = this.now();
  }

  /** Total units of work completed since construction. */
  get totalProgress(): number {
    return this.progress;
  }
  get currentBackoffMs(): number {
    return this.backoffMs;
  }
  get stallCount(): number {
    return this.stalls;
  }
  get tickInFlight(): boolean {
    return this.controller !== null;
  }

  beginTick(): TickHandle {
    if (this.controller) throw new Error("watchdog: tick already in flight");
    const controller = new AbortController();
    this.controller = controller;
    this.tickProgressed = false;
    this.lastProgress = this.progress;
    this.lastProgressAt = this.now();
    return {
      signal: controller.signal,
      bump: (n = 1) => {
        if (this.controller !== controller) return; // late bump from an aborted tick
        this.progress += n;
        this.tickProgressed = true;
        this.lastProgressAt = this.now();
      },
      end: () => {
        if (this.controller !== controller) return;
        this.controller = null;
        if (this.tickProgressed) {
          // Progress this tick ⇒ the system is alive: drop the backoff.
          this.stalls = 0;
          this.backoffMs = 0;
        }
      },
    };
  }

  /**
   * Called periodically (from a timer). Returns "stalled" exactly once per
   * stall event: aborts the in-flight tick and raises the backoff.
   */
  check(): "idle" | "ok" | "stalled" {
    if (!this.controller) return "idle";
    const idleMs = this.now() - this.lastProgressAt;
    if (this.progress !== this.lastProgress) {
      this.lastProgress = this.progress;
      return "ok";
    }
    if (idleMs < this.opts.stallMs) return "ok";
    // Stalled: no progress for stallMs while a tick is in flight.
    const c = this.controller;
    this.controller = null;
    this.stalls += 1;
    const { initialMs, maxMs, factor } = this.opts.backoff;
    this.backoffMs = Math.min(maxMs, Math.round(initialMs * Math.pow(factor, this.stalls - 1)));
    c.abort(new Error(`watchdog: no progress for ${idleMs}ms`));
    this.opts.onStall?.({ stalls: this.stalls, backoffMs: this.backoffMs, progress: this.progress, idleMs });
    return "stalled";
  }
}
