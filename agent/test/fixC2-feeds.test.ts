import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { GRANT_SELECTORS } from "../src/abi/oilskin.js";
import { buildFeedPolicies, policyMap, selfCheckFeeds, FeedSelfCheckError } from "../src/engine/feeds.js";
import { evaluateSnapshot } from "../src/engine/valuation.js";
import { runKeeper } from "../src/keeper.js";
import { memorySink } from "../src/log.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import {
  ACCOUNT_A,
  CBBTC,
  FACTORY,
  LIVE_USDC_ROUND_AGE_S,
  OWNER_A,
  USDC,
  cbBtcPosition,
  debtForHf,
  newMockChain,
} from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";

/**
 * HARVESTED FROM /tmp/audit2/C/poc2-usdc-stale.test.js — expectations FLIPPED.
 *
 * The PoC read the repo's own live measurement (docs/VERIFIED-BASE-FACTS.md):
 *
 *     PRICE_MAX_AGE_S default = 10800s; live USDC/USD age = 44475s
 *     verdict: UNKNOWN ["G2 USDC: feed stale by 44475s"]
 *     (end to end, HF 1.02, both grants, 5,000 idle USDC to repay)
 *     per-tick: ["UNKNOWN/-/-","UNKNOWN/-/-","UNKNOWN/-/-","UNKNOWN/-/-"]
 *     transactions broadcast: 0
 *
 * Every borrower carries USDC debt, so ONE global staleness constant that is
 * shorter than the USDC feed's heartbeat turned the whole ladder off for the
 * whole fleet, silently, for ever. The staleness bound is now measured from
 * each feed's own published cadence, and a policy that would blind the keeper
 * is a loud fatal at startup instead of a quiet no-op.
 */

const KEY = ("0x" + "42".repeat(32)) as Hex;
const ROUTER = "0x2000000000000000000000000000000000000001" as const;
const LP_VENUE = "0x2000000000000000000000000000000000000002" as const;
const KEEPER = privateKeyToAccount(KEY).address;

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "fixC2-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PROBE = { fallbackMaxAgeS: 3 * 3600, minMaxAgeS: 300, slack: 2, rounds: 6 };

function env(storePath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    BASE_RPC_URL: "http://mock.invalid",
    ACCOUNT_FACTORY_ADDRESS: FACTORY,
    STORE_PATH: storePath,
    DISCOVERY_FROM_BLOCK: "0",
    KEEPER_PRIVATE_KEY: KEY,
    STRATEGY_ROUTER_ADDRESS: ROUTER,
    HEALTH_POLL_MS: "10",
    RPC_DEADLINE_MS: "2000",
    WATCHDOG_STALL_MS: "5000",
    LOG_LEVEL: "info",
    ...extra,
  };
}

describe("FIX C-2: staleness is per feed, measured from the feed itself", () => {
  it("FIX C-2: each feed's bound comes from its OWN published cadence — tighter for the movers, longer for the peg", async () => {
    const chain = newMockChain();
    const reader = new AaveReader(chain.publicClient(), aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 1000 });
    const rows = await buildFeedPolicies(reader, reserveSpecsFromShared(), chain.nowS, PROBE);
    const by = new Map(rows.map((r) => [r.symbol, r]));

    // USDC publishes daily: 86,400 s measured, 172,800 s enforced.
    assert.equal(by.get("USDC")!.observedHeartbeatS, 86_400);
    assert.equal(by.get("USDC")!.source, "probe");
    assert.equal(by.get("USDC")!.maxAgeS, 172_800);
    assert.ok(by.get("USDC")!.maxAgeS > Number(LIVE_USDC_ROUND_AGE_S), "the live 44,475 s round must be FRESH for a daily feed");

    // cbBTC publishes every 20 minutes: 2,400 s enforced — TIGHTER than the
    // 10,800 s global constant it replaces, on the asset that actually moves.
    assert.equal(by.get("cbBTC")!.observedHeartbeatS, 1_200);
    assert.equal(by.get("cbBTC")!.maxAgeS, 2_400);
    assert.ok(by.get("cbBTC")!.maxAgeS < PROBE.fallbackMaxAgeS);
    assert.deepEqual(rows.filter((r) => r.staleNow).map((r) => r.symbol), []);
  });

  it("FIX C-2: the live 44,475 s USDC round is OK, while a 3-hour cbBTC round is UNKNOWN", async () => {
    const chain = newMockChain();
    chain.reserves.get(USDC.toLowerCase())!.chainlink!.updatedAt = chain.nowS - LIVE_USDC_ROUND_AGE_S;
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.6));
    const reader = new AaveReader(chain.publicClient(), aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 1000 });
    const rows = await buildFeedPolicies(reader, reserveSpecsFromShared(), chain.nowS, PROBE);
    const priceMaxAgeBySymbol = policyMap(rows);
    const ctx = await reader.readReserveContexts();
    const snap = await reader.readAccount(ACCOUNT_A, ctx, chain.blockNumber);
    const params = { nowS: chain.nowS, priceMaxAgeS: 3 * 3600, oracleDeviationBps: 300, hfToleranceBps: 100 };

    // Was: UNKNOWN ["G2 USDC: feed stale by 44475s"] — for every borrower, every tick.
    const withPolicy = evaluateSnapshot(snap, { ...params, priceMaxAgeBySymbol });
    assert.equal(withPolicy.kind, "OK", withPolicy.kind === "UNKNOWN" ? withPolicy.reasons.join("; ") : "");

    // The old single constant is still what breaks it — kept as the proof.
    const withGlobalConstant = evaluateSnapshot(snap, params);
    assert.equal(withGlobalConstant.kind, "UNKNOWN");
    assert.ok(withGlobalConstant.kind === "UNKNOWN" && withGlobalConstant.reasons.some((r) => r.includes("USDC")));

    // And the guard still bites where it must: cbBTC three hours late.
    chain.reserves.get(CBBTC.toLowerCase())!.chainlink!.updatedAt = chain.nowS - 3n * 3600n;
    const snap2 = await reader.readAccount(ACCOUNT_A, await reader.readReserveContexts(), chain.blockNumber);
    const stale = evaluateSnapshot(snap2, { ...params, priceMaxAgeBySymbol });
    assert.equal(stale.kind, "UNKNOWN");
    assert.ok(stale.kind === "UNKNOWN" && stale.reasons.some((r) => r.includes("cbBTC") && r.includes("max 2400s")));
  });

  it("FIX C-2: the ladder RUNS end to end against the live USDC round age (was 4 UNKNOWN ticks, 0 broadcasts)", async () => {
    const chain = newMockChain();
    chain.reserves.get(USDC.toLowerCase())!.chainlink!.updatedAt = chain.nowS - LIVE_USDC_ROUND_AGE_S;
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.02)); // emergency rung
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);
    oil.setUsdc(ACCOUNT_A, 5_000_000_000n); // 5,000 idle USDC to repay

    const sink = memorySink();
    const outcomes: string[] = [];
    await runKeeper(env(join(dir, "e2e.json")), {
      sink: sink.sink,
      maxTicks: 2,
      makeClient: () => chain.publicClient(),
      makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
      onTick: (r) => {
        for (const o of r.outcomes) outcomes.push(`${o.valuation}/${o.fired ?? "-"}/${o.dispatch?.status ?? "-"}`);
      },
    });
    assert.ok(!outcomes.some((o) => o.startsWith("UNKNOWN")), `no account may be UNKNOWN on live feed ages: ${JSON.stringify(outcomes)}`);
    assert.ok(outcomes.some((o) => o.includes("emergency-unwind") || o.includes("SENT") || o.includes("CONFIRMED")), JSON.stringify(outcomes));
    assert.equal(oil.txFrom.length > 0, true, "a transaction must be broadcast");
    assert.ok(sink.lines.some((l) => l.includes("feed staleness policy")), "the enforced bounds must be visible at startup");
  });

  it("FIX C-2: a policy that would blind every account is a LOUD FATAL at startup, never a quiet no-op", async () => {
    const chain = newMockChain();
    // A USDC feed that claims a 60 s cadence but has not published in 44,475 s:
    // a genuinely broken feed, not a heartbeat. Every borrower would be UNKNOWN.
    const usdc = chain.reserves.get(USDC.toLowerCase())!;
    usdc.heartbeatS = 60n;
    usdc.chainlink!.updatedAt = chain.nowS - LIVE_USDC_ROUND_AGE_S;
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.02));
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);

    const reader = new AaveReader(chain.publicClient(), aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 1000 });
    const rows = await buildFeedPolicies(reader, reserveSpecsFromShared(), chain.nowS, PROBE);
    const check = selfCheckFeeds(rows, "USDC", ["cbBTC", "WETH"]);
    assert.equal(check.fatal, true);
    assert.match(check.reason ?? "", /EVERY account would read UNKNOWN/);

    const sink = memorySink();
    await assert.rejects(
      runKeeper(env(join(dir, "fatal.json")), {
        sink: sink.sink,
        maxTicks: 1,
        makeClient: () => chain.publicClient(),
        makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
      }),
      FeedSelfCheckError
    );
    assert.ok(sink.lines.some((l) => l.includes("FEED SELF-CHECK FAILED")));

    // …and an operator can still override it deliberately, loudly.
    const sink2 = memorySink();
    const { ticks } = await runKeeper(env(join(dir, "warn.json"), { FEED_SELFCHECK: "warn" }), {
      sink: sink2.sink,
      maxTicks: 1,
      makeClient: () => chain.publicClient(),
      makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
    });
    assert.equal(ticks, 1);
    assert.ok(sink2.lines.some((l) => l.includes("FEED SELF-CHECK FAILED")));
  });

  it("FIX C-2: a feed with no round history falls back and says so; an operator override wins", async () => {
    const chain = newMockChain();
    chain.reserves.get(USDC.toLowerCase())!.noRoundHistory = true;
    const reader = new AaveReader(chain.publicClient(), aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 1000 });
    const rows = await buildFeedPolicies(reader, reserveSpecsFromShared(), chain.nowS, { ...PROBE, overrides: { WETH: 999 } });
    const by = new Map(rows.map((r) => [r.symbol, r]));
    assert.equal(by.get("USDC")!.source, "fallback");
    assert.equal(by.get("USDC")!.maxAgeS, PROBE.fallbackMaxAgeS);
    assert.equal(by.get("WETH")!.source, "override");
    assert.equal(by.get("WETH")!.maxAgeS, 999);
  });
});
