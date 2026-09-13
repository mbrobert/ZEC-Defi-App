import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFeedPolicies } from "../src/engine/feeds.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import { newMockChain } from "./fixtures.js";
import type { MockChain, MockReserve } from "./mockChain.js";

/**
 * FIX FEED-MED-1 — the staleness probe samples a WINDOW OF TIME, not a count
 * of rounds.
 *
 * C-HIGH-2 replaced one global `PRICE_MAX_AGE_S` with a bound measured from
 * each feed's own published cadence: `max(gap over the last 6 rounds) × 2`.
 * The measurement was right in principle and wrong in its window. A Chainlink
 * feed publishes on TWO triggers — a deviation threshold and a heartbeat — and
 * six rounds sampled while the market is moving contain only deviation-driven
 * gaps, which are a fraction of the heartbeat. The bound then lands UNDER the
 * feed's own heartbeat, and as soon as the market calms every heartbeat
 * publication reads stale: the account goes UNKNOWN and the ladder stops.
 * That is C-HIGH-2's failure again, reached by the derivation instead of by a
 * constant.
 *
 * MEASURED, not supposed (docs/VERIFIED-BASE-FACTS.md Addendum 17, read from
 * Base 2026-09-13):
 *
 *   ETH / USD    600 rounds   heartbeat 1,232 s   median gap   360 s
 *      6-round probe derives a bound BELOW 1,232 s at 34.7 % of all possible
 *      start-up points; at the 90th percentile the feed then reads stale for
 *      59.0 % of wall-clock time.
 *   cbBTC / USD  600 rounds   heartbeat 1,236 s   median gap 1,230 s  → 1.8 %
 *   ZEC / USD  1,007 rounds   NO heartbeat seen in 10.85 days (deviation-only,
 *      0.5 %); the 6-round probe under-bounds its largest real gap at 98.0 %
 *      of start-up points, and the feed reads stale 15.1 % of the time at the
 *      median start-up.
 *
 * With a 24-hour window and a 120-round cap the 90th-percentile stale time is
 * 0.00 % on both wired feeds and 4.73 % on ZEC.
 */

/** The shipped probe before this fix. */
const OLD = { fallbackMaxAgeS: 3 * 3600, minMaxAgeS: 300, slack: 2, rounds: 6, minWindowS: 0 };
/** The probe as it ships now (agent/src/config.ts CONFIG_DEFAULTS). */
const NEW = { fallbackMaxAgeS: 3 * 3600, minMaxAgeS: 300, slack: 2, rounds: 120, minWindowS: 24 * 3600 };

/** ETH / USD on Base, measured 2026-09-13. */
const ETH_HEARTBEAT_S = 1_232n;
const ETH_ACTIVE_GAP_S = 300n;
const ACTIVE_ROUNDS = 40;

function wethFeed(chain: MockChain): MockReserve {
  const r = [...chain.reserves.values()].find((x) => x.symbol === "WETH");
  assert.ok(r?.chainlink, "the WETH fixture must carry a Chainlink feed");
  return r;
}

/**
 * An active market: the last `ACTIVE_ROUNDS` gaps are deviation-driven and
 * short, everything older is the heartbeat. `latestAgeS` is how old the newest
 * round is — one heartbeat, the oldest a healthy feed ever legitimately gets.
 */
function activeMarket(latestAgeS: bigint): { chain: MockChain; reader: AaveReader } {
  const chain = newMockChain();
  const weth = wethFeed(chain);
  weth.heartbeatS = ETH_HEARTBEAT_S;
  weth.gapScheduleS = Array.from({ length: ACTIVE_ROUNDS }, () => ETH_ACTIVE_GAP_S);
  // Deep enough history to walk: the real feed is at round 137,000-odd.
  weth.chainlink!.roundId = 5_000n;
  weth.chainlink!.answeredInRound = 5_000n;
  weth.chainlink!.updatedAt = chain.nowS - latestAgeS;
  const reader = new AaveReader(chain.publicClient(), aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 1000 });
  return { chain, reader };
}

describe("FIX FEED-MED-1: the staleness probe measures a window of time, not a count of rounds", () => {
  it("the 6-round probe derives a bound UNDER the feed's own heartbeat, and a healthy heartbeat round reads stale", async () => {
    const { chain, reader } = activeMarket(ETH_HEARTBEAT_S);
    const rows = await buildFeedPolicies(reader, reserveSpecsFromShared(), chain.nowS, OLD);
    const weth = rows.find((r) => r.symbol === "WETH")!;

    assert.equal(weth.windowRounds, OLD.rounds, "the old probe reads a flat count of rounds");
    assert.equal(weth.observedHeartbeatS, Number(ETH_ACTIVE_GAP_S), "six rounds see only the active-market gaps");
    assert.equal(weth.windowCoveredS, OLD.rounds - 1 === 0 ? 0 : (OLD.rounds - 1) * Number(ETH_ACTIVE_GAP_S), "…spanning 25 minutes of a 24-hour cadence question");
    assert.equal(weth.maxAgeS, 600, "…so the bound is 300 s × 2");
    assert.ok(weth.maxAgeS < Number(ETH_HEARTBEAT_S), "the bound is UNDER the feed's real heartbeat — the defect");
    assert.equal(weth.staleNow, true, "a round published exactly one heartbeat ago reads STALE: the account goes UNKNOWN");
  });

  it("the 24-hour window sees the heartbeat, bounds above it, and the same round is fresh", async () => {
    const { chain, reader } = activeMarket(ETH_HEARTBEAT_S);
    const rows = await buildFeedPolicies(reader, reserveSpecsFromShared(), chain.nowS, NEW);
    const weth = rows.find((r) => r.symbol === "WETH")!;

    assert.equal(weth.source, "probe", "the window was covered, so the measurement stands on its own");
    assert.equal(weth.observedHeartbeatS, Number(ETH_HEARTBEAT_S), "the window reaches past the active market into the heartbeat");
    assert.equal(weth.maxAgeS, Number(ETH_HEARTBEAT_S) * 2);
    assert.ok(weth.maxAgeS > Number(ETH_HEARTBEAT_S), "the bound is now ABOVE the heartbeat");
    assert.equal(weth.staleNow, false, "the same healthy round is FRESH");
    assert.ok(
      weth.windowCoveredS !== null && weth.windowCoveredS >= NEW.minWindowS,
      `the sample must span the asked-for window, got ${weth.windowCoveredS}`
    );
    assert.ok(weth.windowRounds <= NEW.rounds, "and must not exceed the call cap");
  });

  it("the guard still bites: a round older than the measured heartbeat is stale under the new bound too", async () => {
    const { chain, reader } = activeMarket(4n * ETH_HEARTBEAT_S);
    const rows = await buildFeedPolicies(reader, reserveSpecsFromShared(), chain.nowS, NEW);
    const weth = rows.find((r) => r.symbol === "WETH")!;
    assert.equal(weth.staleNow, true, "four heartbeats late is stale — widening the window must not disable the guard");
  });

  it("a walk that cannot cover the window says so and falls back — it must not become a tight bound", async () => {
    const chain = newMockChain();
    const weth = wethFeed(chain);
    weth.heartbeatS = ETH_HEARTBEAT_S;
    weth.gapScheduleS = Array.from({ length: ACTIVE_ROUNDS }, () => ETH_ACTIVE_GAP_S);
    weth.chainlink!.roundId = 8n; // a young feed: seven historical rounds exist
    weth.chainlink!.answeredInRound = 8n;
    weth.chainlink!.updatedAt = chain.nowS - 60n;
    const reader = new AaveReader(chain.publicClient(), aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 1000 });

    const rows = await buildFeedPolicies(reader, reserveSpecsFromShared(), chain.nowS, NEW);
    const row = rows.find((r) => r.symbol === "WETH")!;
    assert.equal(row.source, "probe-short", "the row must say the window was never covered");
    assert.ok(row.windowCoveredS !== null && row.windowCoveredS < NEW.minWindowS);
    assert.equal(row.maxAgeS, NEW.fallbackMaxAgeS, "an unmeasured heartbeat gets the fallback, not 300 s × 2");
    assert.ok(row.maxAgeS > Number(ETH_HEARTBEAT_S));
  });

  it("the cap bounds the call budget: a feed that never goes quiet costs at most `rounds` reads", async () => {
    const chain = newMockChain();
    const weth = wethFeed(chain);
    weth.heartbeatS = ETH_ACTIVE_GAP_S; // every gap short: the window can never be covered inside the cap
    weth.chainlink!.roundId = 50_000n;
    weth.chainlink!.answeredInRound = 50_000n;
    const reader = new AaveReader(chain.publicClient(), aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 1000 });

    const before = chain.calls.filter((c) => c.label.startsWith("getRoundData(WETH")).length;
    const rows = await buildFeedPolicies(reader, reserveSpecsFromShared(), chain.nowS, NEW);
    const reads = chain.calls.filter((c) => c.label.startsWith("getRoundData(WETH")).length - before;
    assert.ok(reads <= NEW.rounds, `walk must stop at the cap, made ${reads} reads`);
    assert.equal(rows.find((r) => r.symbol === "WETH")!.source, "probe-short");
  });
});
