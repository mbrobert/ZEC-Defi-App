import type { ReserveSpec } from "../services/chain.js";
import type { AaveReader, RoundRead } from "../services/chain.js";
import type { Logger } from "../log.js";

/**
 * Per-feed staleness policy, and the startup self-check that refuses to run a
 * keeper that cannot value anybody.
 *
 * WHY THIS EXISTS (audit C-HIGH-2). The keeper shipped with one global
 * `PRICE_MAX_AGE_S = 10,800`. The live USDC/USD round on Base was **44,475 s
 * old** — normal for a $1-pegged asset whose deviation threshold almost never
 * trips — while BTC/ETH/cbBTC rounds were 109–833 s old. Every borrower's debt
 * is USDC, so every account failed guard G2 on every tick, the ladder never
 * ran for anyone, and the only trace was a log line on a host the user cannot
 * see. There is no single number that works: raising it past a day disables
 * the guard for the assets that actually move.
 *
 * So the bound is per feed, and it comes from the FEED ITSELF: the keeper
 * walks back through the aggregator's own recent rounds (`getRoundData`) and
 * measures the gaps it actually publishes. The bound is
 * `max(observed gap) × slack`, floored by the configured fallback, and it is
 * logged at startup so an operator sees the number that will be enforced.
 *
 * Nothing here is typed from a document: a heartbeat is measured, not
 * declared. When a feed cannot be walked (a proxy that reverts on historical
 * rounds, a phase boundary), the fallback applies and the row says so.
 */

export interface FeedPolicy {
  symbol: string;
  feed: string | null;
  /** Largest gap observed between consecutive published rounds, in seconds. */
  observedHeartbeatS: number | null;
  /** Gaps used, newest first (for the log). */
  observedGapsS: number[];
  /** The staleness bound that will be enforced for this feed. */
  maxAgeS: number;
  source: "probe" | "override" | "fallback" | "no-feed";
  /** Round age at the probe, in seconds. */
  ageS: number | null;
  /** True when the round is already older than the bound that will be enforced. */
  staleNow: boolean;
}

export interface FeedPolicyOptions {
  /** Bound for a feed whose cadence could not be probed and has no override. */
  fallbackMaxAgeS: number;
  /** Floor under a PROBED bound, so a fast feed does not get a hair trigger. */
  minMaxAgeS: number;
  /** Multiplier applied to the largest observed gap. */
  slack: number;
  /** How many historical rounds to walk back (gaps = rounds − 1). */
  rounds: number;
  /** Per-symbol operator overrides (PRICE_MAX_AGE_S_<SYMBOL>). */
  overrides?: Readonly<Record<string, number>>;
}

export interface FeedSelfCheck {
  rows: FeedPolicy[];
  /** Symbols whose latest round is already older than their own bound. */
  stale: string[];
  /**
   * True when the configured policy would make EVERY account UNKNOWN: the
   * borrow asset's feed is stale (every borrower carries that debt row), or
   * every collateral feed is stale. This is a fatal startup condition — a
   * keeper that silently does nothing is the worst failure mode this product
   * has, and it is exactly what shipped.
   */
  fatal: boolean;
  reason: string | null;
}

function gapsFrom(rounds: RoundRead[]): number[] {
  const sorted = [...rounds].filter((r) => r.updatedAt > 0n).sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1));
  const gaps: number[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const d = sorted[i].updatedAt - sorted[i + 1].updatedAt;
    if (d > 0n) gaps.push(Number(d));
  }
  return gaps;
}

/**
 * Probe every wired feed and resolve its staleness bound. One `latestRoundData`
 * plus up to `rounds − 1` `getRoundData` calls per feed, once, at startup.
 */
export async function buildFeedPolicies(
  reader: AaveReader,
  specs: readonly ReserveSpec[],
  nowS: bigint,
  opts: FeedPolicyOptions,
  signal?: AbortSignal
): Promise<FeedPolicy[]> {
  const out: FeedPolicy[] = [];
  for (const spec of specs) {
    const override = opts.overrides?.[spec.symbol];
    if (!spec.feed) {
      out.push({
        symbol: spec.symbol,
        feed: null,
        observedHeartbeatS: null,
        observedGapsS: [],
        maxAgeS: override ?? opts.fallbackMaxAgeS,
        source: "no-feed",
        ageS: null,
        staleNow: false,
      });
      continue;
    }
    let rounds: RoundRead[] = [];
    try {
      rounds = await reader.readRoundHistory(spec, spec.feed, opts.rounds, signal);
    } catch {
      rounds = [];
    }
    const latest = rounds[0];
    const gaps = gapsFrom(rounds);
    const observed = gaps.length ? Math.max(...gaps) : null;
    const probed = observed === null ? null : Math.ceil(observed * opts.slack);
    // A probed bound stands on its own — it is TIGHTER than the old global
    // constant for the assets that move (a 20-minute-heartbeat cbBTC feed gets
    // ~40 minutes, not 3 hours) and LOOSER for the pegged one that publishes
    // daily. `minMaxAgeS` only stops a very fast feed getting a hair trigger.
    const maxAgeS = override ?? (probed === null ? opts.fallbackMaxAgeS : Math.max(probed, opts.minMaxAgeS));
    const ageS = latest ? Number(nowS - latest.updatedAt) : null;
    out.push({
      symbol: spec.symbol,
      feed: spec.feed,
      observedHeartbeatS: observed,
      observedGapsS: gaps,
      maxAgeS,
      source: override !== undefined ? "override" : probed === null ? "fallback" : "probe",
      ageS,
      staleNow: ageS !== null && ageS > maxAgeS,
    });
  }
  return out;
}

/** Symbol → enforced bound, the map the valuation reads. */
export function policyMap(rows: readonly FeedPolicy[]): Map<string, number> {
  return new Map(rows.map((r) => [r.symbol, r.maxAgeS]));
}

/**
 * Decide whether this policy leaves anybody protectable.
 *
 * `borrowSymbol` is the debt asset every account carries: if its feed is
 * already stale, no account can ever be valued. Likewise if every collateral
 * feed is stale. Either is fatal — loudly, at startup, before the keeper has
 * spent an hour pretending to work.
 */
export function selfCheckFeeds(
  rows: readonly FeedPolicy[],
  borrowSymbol: string,
  collateralSymbols: readonly string[]
): FeedSelfCheck {
  const stale = rows.filter((r) => r.staleNow).map((r) => r.symbol);
  const borrow = rows.find((r) => r.symbol === borrowSymbol);
  const collateral = rows.filter((r) => collateralSymbols.includes(r.symbol));
  let reason: string | null = null;
  if (borrow?.staleNow) {
    reason =
      `${borrowSymbol}/USD round is ${borrow.ageS}s old against its own bound of ${borrow.maxAgeS}s ` +
      `(${borrow.source}) — every borrower carries ${borrowSymbol} debt, so EVERY account would read UNKNOWN and the ladder would never run`;
  } else if (collateral.length > 0 && collateral.every((r) => r.staleNow)) {
    reason =
      `every collateral feed is stale against its own bound (${collateral.map((r) => `${r.symbol} ${r.ageS}s>${r.maxAgeS}s`).join(", ")}) ` +
      "— no account has a valuable collateral row, so the ladder would never run";
  }
  return { rows: [...rows], stale, fatal: reason !== null, reason };
}

export function logFeedPolicies(log: Logger, rows: readonly FeedPolicy[]): void {
  for (const r of rows) {
    log.info("feed staleness policy", {
      reserve: r.symbol,
      maxAgeS: r.maxAgeS,
      source: r.source,
      observedHeartbeatS: r.observedHeartbeatS,
      observedGapsS: r.observedGapsS.slice(0, 6),
      ageS: r.ageS,
      staleNow: r.staleNow,
    });
  }
}

export class FeedSelfCheckError extends Error {
  constructor(reason: string) {
    super(
      `feed self-check FAILED: ${reason}. ` +
        "Refusing to start: a keeper that silently protects nobody is worse than one that is down. " +
        "Fix the feed wiring, or set PRICE_MAX_AGE_S_<SYMBOL> deliberately, or FEED_SELFCHECK=warn to run anyway."
    );
    this.name = "FeedSelfCheckError";
  }
}
