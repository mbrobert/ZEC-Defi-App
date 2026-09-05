/**
 * Every external await in the keeper goes through `withDeadline`: a bounded
 * wait that also honours the tick's AbortSignal. An RPC that never answers
 * becomes a thrown DeadlineError (⇒ valuation UNKNOWN, never HEALTHY), and an
 * aborted tick stops waiting immediately.
 */
export class DeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: no answer within ${ms}ms`);
    this.name = "DeadlineError";
  }
}

export class AbortedError extends Error {
  constructor(label: string, cause?: unknown) {
    super(`${label}: aborted${cause instanceof Error ? ` (${cause.message})` : ""}`);
    this.name = "AbortedError";
  }
}

export function withDeadline<T>(label: string, ms: number, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (!(ms > 0)) return Promise.reject(new RangeError(`withDeadline(${label}): ms must be > 0`));
  if (signal?.aborted) return Promise.reject(new AbortedError(label, signal.reason));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new DeadlineError(label, ms))), ms);
    const onAbort = () => finish(() => reject(new AbortedError(label, signal?.reason)));
    signal?.addEventListener("abort", onAbort, { once: true });
    function finish(fn: () => void) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      fn();
    }
    let p: Promise<T>;
    try {
      p = work();
    } catch (e) {
      finish(() => reject(e));
      return;
    }
    p.then(
      (v) => finish(() => resolve(v)),
      (e) => finish(() => reject(e))
    );
  });
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Run `items` through `fn` with at most `limit` in flight; results in order, errors captured per item. */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal
): Promise<PromiseSettledResult<R>[]> {
  if (!(limit >= 1)) throw new RangeError("mapBounded: limit must be ≥ 1");
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      if (signal?.aborted) {
        // Stop scheduling; items never started are reported as aborted.
        while (next < items.length) {
          results[next] = { status: "rejected", reason: new AbortedError(`item ${next}`, signal.reason) };
          next++;
        }
        return;
      }
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
