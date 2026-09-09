import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { HF_LADDER } from "@zyo/shared";
import { GRANT_SELECTORS, accountCreatedEvent } from "../src/abi/oilskin.js";
import { KeeperDispatcher } from "../src/dispatch/keeperDispatcher.js";
import type { DispatchIntent, DispatchResult, Dispatcher } from "../src/dispatch/types.js";
import { Logger, memorySink } from "../src/log.js";
import { HealthMonitor, type MonitorConfig } from "../src/monitors/healthMonitor.js";
import { readTickContexts, valueAccount } from "../src/services/accountValuer.js";
import { AaveReader, aaveAddressesFromShared, reserveSpecsFromShared } from "../src/services/chain.js";
import { AccountDiscovery } from "../src/services/discovery.js";
import { VenueReader } from "../src/services/venues.js";
import { KeeperStore, type DispatchRecord } from "../src/store/keeperStore.js";
import type { Address } from "../src/types/evm.js";
import { ProgressWatchdog } from "../src/watchdog.js";
import { ACCOUNT_A, ACCOUNT_B, CBBTC, FACTORY, OWNER_A, USDC, WETH, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import type { MockChain } from "./mockChain.js";
import { AAVE_VENUE_ADDR, DEAD_VENUE_ADDR, MORPHO_VENUE_ADDR, MockOilskin } from "./mockOilskin.js";

/**
 * Audit wave 2, M-HIGH-2 — the venue-aware reader and valuation, end to end over the mock chain.
 *
 * Before this the keeper valued every account through the Aave pool only: a position on the
 * Morpho venue after `acceptVenue` was NO_DEBT, no rung fired, and the dashboard said "active".
 * Every test here pins one of the brief's requirements:
 *   • the Aave path is unchanged (NO_DEBT / OK exactly as before, now with a venue cross-check);
 *   • a Morpho venue position is read through ICollateralVenue, is NOT NO_DEBT, and rungs fire;
 *   • the venue's health factor is accepted only when the keeper's own Chainlink feeds agree —
 *     a disagreement beyond ORACLE_DEVIATION_BPS is UNKNOWN, never OK;
 *   • Aave debt behind a Morpho pointer (previousVenues, the M-HIGH-1 class) is still seen;
 *   • anything unreadable fails closed.
 */

const KEY = ("0x" + "42".repeat(32)) as Hex;
const KEEPER = privateKeyToAccount(KEY).address;
const ROUTER = getAddress("0x2000000000000000000000000000000000000001") as Address;
const LP_VENUE = getAddress("0x2000000000000000000000000000000000000002") as Address;
const ONE_BTC = 100_000_000n;
const PARAMS = { priceMaxAgeS: 3 * 3600, oracleDeviationBps: 300, hfToleranceBps: 100 };
/** USDC debt (raw, 6 dp) that puts 1 cbBTC at exactly `hf` on the Morpho mock (price 79,600, LLTV 86 %). */
const morphoDebtForHf = (hf: number) => BigInt(Math.round(((79_600 * 0.86) / hf) * 1e6));

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "venue-reader-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});
let n = 0;
const freshPath = () => join(dir, `v${++n}.json`);

function world(setup?: (oil: MockOilskin, chain: MockChain) => void) {
  const chain = newMockChain();
  const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
  oil.install([ACCOUNT_A, ACCOUNT_B]);
  setup?.(oil, chain);
  const client = chain.publicClient();
  const reader = new AaveReader(client, aaveAddressesFromShared(), reserveSpecsFromShared(), { deadlineMs: 500 });
  const venues = new VenueReader(client, ROUTER, { deadlineMs: 500 });
  const value = async (account: Address = ACCOUNT_A) => {
    const ctx = await readTickContexts({ reader, venues });
    return valueAccount({ reader, venues }, account, ctx, chain.blockNumber, { nowS: chain.nowS, ...PARAMS });
  };
  return { chain, oil, client, reader, venues, value };
}

/** Puts cbBTC on the Morpho venue (Aave remembered as previous) with 1 cbBTC against `debt` USDC there. */
function morphoWorld(hf: number, setup?: (oil: MockOilskin, chain: MockChain) => void) {
  return world((oil, chain) => {
    oil.setVenue(CBBTC, MORPHO_VENUE_ADDR);
    oil.setMorphoPosition(ACCOUNT_A, CBBTC, { collateral: ONE_BTC, debt: morphoDebtForHf(hf) });
    setup?.(oil, chain);
  });
}

describe("venue-aware valuation — the Aave path is unchanged", () => {
  it("an empty account is NO_DEBT, and the Aave venue's own answers agree with the pool (the cross-check)", async () => {
    const w = world();
    const av = await w.value(ACCOUNT_B);
    assert.equal(av.valuation.kind, "NO_DEBT");
    assert.equal(av.aave.kind, "NO_DEBT");
    assert.ok(av.venues);
    assert.equal(av.venues!.length, 1);
    assert.equal(av.venues![0].kind, "aave");
    assert.equal(av.venues![0].venue.toLowerCase(), AAVE_VENUE_ADDR.toLowerCase());
    assert.equal(av.venues![0].valuation.kind, "NO_DEBT");
  });

  it("1 cbBTC against USDC on Aave is OK at the same health factor as before", async () => {
    const w = world((_, chain) => cbBtcPosition(chain, ACCOUNT_A, debtForHf(2.0)));
    const av = await w.value();
    assert.equal(av.valuation.kind, "OK");
    if (av.valuation.kind !== "OK") return;
    assert.ok(Math.abs(av.valuation.hf - 2.0) < 1e-6, String(av.valuation.hf));
    assert.equal(av.valuation.dominantCollateral.symbol, "cbBTC");
    assert.equal(av.venues![0].valuation.kind, "OK");
  });

  it("V3: an 'Aave' venue whose healthFactor does not reproduce the pool's is UNKNOWN — it is not reading the pool this keeper reads", async () => {
    const w = world((oil, chain) => {
      cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.3));
      oil.overrideVenueAnswer(AAVE_VENUE_ADDR, "healthFactor", 5n * 10n ** 18n);
    });
    const av = await w.value();
    assert.equal(av.valuation.kind, "UNKNOWN");
    assert.equal(av.aave.kind, "OK", "the pool itself is fine — the venue is the liar");
    if (av.valuation.kind === "UNKNOWN") assert.match(av.valuation.reasons.join("\n"), /V3 aave venue .* healthFactor .* ≠ pool HF/);
  });

  it("no VenueReader (no router configured) → the Aave verdict alone, venues null, exactly the old behaviour", async () => {
    const w = world((_, chain) => cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.3)));
    const ctx = await readTickContexts({ reader: w.reader, venues: null });
    assert.equal(ctx.venues, null);
    const av = await valueAccount({ reader: w.reader, venues: null }, ACCOUNT_A, ctx, w.chain.blockNumber, { nowS: w.chain.nowS, ...PARAMS });
    assert.equal(av.venues, null);
    assert.equal(av.valuation.kind, "OK");
  });
});

describe("M-HIGH-2 — a Morpho venue position is read through ICollateralVenue", () => {
  it("1 cbBTC against USDC on the Morpho venue is OK at LLTV / LTV = 1.72, NOT NO_DEBT; the Aave pool alone says NO_DEBT", async () => {
    const w = morphoWorld(1.72);
    const av = await w.value();
    assert.equal(av.aave.kind, "NO_DEBT", "this is the blind spot: the pool sees nothing");
    assert.equal(av.valuation.kind, "OK");
    if (av.valuation.kind !== "OK") return;
    assert.ok(Math.abs(av.valuation.hf - 1.72) < 1e-4, String(av.valuation.hf));
    assert.equal(av.valuation.dominantCollateral.symbol, "cbBTC");
    assert.equal(av.valuation.dominantCollateral.liquidationThresholdBps, 8600n, "the venue's LLTV, read live");
    assert.equal(av.valuation.debt.length, 1);
    assert.equal(av.valuation.debt[0].asset.toLowerCase(), USDC.toLowerCase());
    assert.equal(av.valuation.debt[0].amount, morphoDebtForHf(1.72), "the venue's own debt(account, USDC), in USDC units");
    const morpho = av.venues!.find((v) => v.kind === "other")!;
    assert.equal(morpho.venue.toLowerCase(), MORPHO_VENUE_ADDR.toLowerCase());
    assert.deepEqual(morpho.assets, ["cbBTC"]);
    assert.equal(morpho.valuation.kind, "OK");
    const aave = av.venues!.find((v) => v.kind === "aave")!;
    assert.deepEqual(aave.assets, ["cbBTC", "WETH", "cbZEC"], "the Aave venue stays on cbBTC's list as a previous venue");
    assert.equal(aave.valuation.kind, "NO_DEBT");
  });

  it("the worst venue wins: Aave HF 2.0 and Morpho HF 1.3 → 1.3 with Morpho's shares; the other way round → Aave's 1.3", async () => {
    const w1 = morphoWorld(1.3, (_, chain) => cbBtcPosition(chain, ACCOUNT_A, debtForHf(2.0)));
    const a1 = await w1.value();
    assert.equal(a1.valuation.kind, "OK");
    if (a1.valuation.kind === "OK") {
      assert.ok(Math.abs(a1.valuation.hf - 1.3) < 1e-4, String(a1.valuation.hf));
      assert.equal(a1.valuation.dominantCollateral.liquidationThresholdBps, 8600n, "sized against the Morpho market");
    }
    const w2 = morphoWorld(2.0, (_, chain) => cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.3)));
    const a2 = await w2.value();
    assert.equal(a2.valuation.kind, "OK");
    if (a2.valuation.kind === "OK") {
      assert.ok(Math.abs(a2.valuation.hf - 1.3) < 1e-6, String(a2.valuation.hf));
      assert.equal(a2.valuation.dominantCollateral.liquidationThresholdBps, 7800n, "sized against Aave");
    }
  });

  it("two Morpho markets: the venue's worst-market HF sits inside the feed-implied band [min_i a_i/D, Σa_i/D] and is accepted", async () => {
    const w = world((oil) => {
      oil.setVenue(CBBTC, MORPHO_VENUE_ADDR);
      oil.setVenue(WETH, MORPHO_VENUE_ADDR);
      oil.setMorphoPosition(ACCOUNT_A, CBBTC, { collateral: ONE_BTC, debt: morphoDebtForHf(1.3) }); // HF 1.30
      oil.setMorphoPosition(ACCOUNT_A, WETH, { collateral: 10n * 10n ** 18n, debt: 5_000_000_000n }); // 24,534 × 0.86 / 5,000 = 4.22
    });
    const av = await w.value();
    assert.equal(av.valuation.kind, "OK");
    if (av.valuation.kind === "OK") {
      assert.ok(Math.abs(av.valuation.hf - 1.3) < 1e-4, `worst market ${av.valuation.hf}`);
      assert.equal(av.valuation.collateral.length, 2);
    }
  });
});

describe("disagreement between the venue and the keeper's feeds fails closed", () => {
  it("V4: the venue's oracle says HF 1.72 while the keeper's cbBTC/USD feed implies 1.08 → UNKNOWN, never OK", async () => {
    const w = morphoWorld(1.72, (_, chain) => {
      // Morpho's cbBTC market prices with BTC/USD; the keeper's independent view is cbBTC/USD. Here
      // they split by far more than ORACLE_DEVIATION_BPS — a depeg the venue cannot see (RISKS.md §8).
      chain.reserves.get(CBBTC.toLowerCase())!.chainlink!.answer = 50_000_00000000n;
    });
    const av = await w.value();
    assert.equal(av.valuation.kind, "UNKNOWN");
    assert.notEqual(av.valuation.kind, "OK");
    if (av.valuation.kind === "UNKNOWN") assert.match(av.valuation.reasons.join("\n"), /V4 venue .* above the feed-implied ceiling/);
  });

  it("V4: the venue's oracle is the pessimist (HF 1.08) while the feed implies 1.72 → UNKNOWN too; the keeper never guesses which is right", async () => {
    const w = morphoWorld(1.72, (oil) => oil.setMorphoPrice(CBBTC, 50_000_00000000n));
    const av = await w.value();
    assert.equal(av.valuation.kind, "UNKNOWN");
    if (av.valuation.kind === "UNKNOWN") assert.match(av.valuation.reasons.join("\n"), /V4 venue .* below the feed-implied floor/);
  });

  it("a small basis between the venue's oracle and the feed (cbBTC/USD vs BTC/USD) is inside the bound and accepted", async () => {
    // 79,630.89 (cbBTC/USD) vs 79,593.77 (BTC/USD), VERIFIED-BASE-FACTS 2026-09-05: ≈ 4.7 bps apart.
    const w = morphoWorld(1.72, (oil, chain) => {
      oil.setMorphoPrice(CBBTC, 79_593_77000000n);
      chain.reserves.get(CBBTC.toLowerCase())!.chainlink!.answer = 79_630_89000000n;
    });
    const av = await w.value();
    assert.equal(av.valuation.kind, "OK");
  });

  it("V2: a stale cbBTC feed makes the Morpho position UNKNOWN even though the venue itself answers", async () => {
    const w = morphoWorld(1.72, (_, chain) => {
      chain.reserves.get(CBBTC.toLowerCase())!.chainlink!.updatedAt = chain.nowS - 100_000n;
    });
    const av = await w.value();
    assert.equal(av.valuation.kind, "UNKNOWN");
    if (av.valuation.kind === "UNKNOWN") assert.match(av.valuation.reasons.join("\n"), /V2 venue .* cbBTC: feed stale/);
  });

  it("V4: Morpho's 'my oracle is unreadable' answer (HF 0 with collateral, M-MED-2) is UNKNOWN, not a rung at 0", async () => {
    const w = morphoWorld(1.72, (oil) => oil.overrideVenueAnswer(MORPHO_VENUE_ADDR, "healthFactor", 0n));
    const av = await w.value();
    assert.equal(av.valuation.kind, "UNKNOWN");
    if (av.valuation.kind === "UNKNOWN") assert.match(av.valuation.reasons.join("\n"), /V4 venue .* HF is 0 with collateral/);
  });

  it("V4: debt with MAX_UINT health factor, or debt with no collateral the registry names, is UNKNOWN", async () => {
    const w1 = morphoWorld(1.72, (oil) => oil.overrideVenueAnswer(MORPHO_VENUE_ADDR, "healthFactor", 2n ** 256n - 1n));
    const a1 = await w1.value();
    assert.equal(a1.valuation.kind, "UNKNOWN");
    const w2 = morphoWorld(1.72, (oil) => oil.overrideVenueAnswer(MORPHO_VENUE_ADDR, "collateral", 0n));
    const a2 = await w2.value();
    assert.equal(a2.valuation.kind, "UNKNOWN");
    if (a2.valuation.kind === "UNKNOWN") assert.match(a2.valuation.reasons.join("\n"), /zero collateral in any asset the registry names/);
  });
});

describe("M-HIGH-1 class — the debt sits behind the registry's previous pointer", () => {
  it("Aave debt at HF 1.3 with cbBTC now pointed at Morpho (nothing there) → still OK at 1.3, never NO_DEBT", async () => {
    const w = world((oil, chain) => {
      cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.3));
      oil.setVenue(CBBTC, MORPHO_VENUE_ADDR); // Aave remembered in previousVenues
    });
    const ctx = await readTickContexts({ reader: w.reader, venues: w.venues });
    const aaveSpec = ctx.venues!.venues.find((v) => v.kind === "aave")!;
    assert.equal(aaveSpec.assets.find((a) => a.symbol === "cbBTC")?.role, "previous");
    const av = await w.value();
    assert.equal(av.valuation.kind, "OK");
    if (av.valuation.kind === "OK") assert.ok(Math.abs(av.valuation.hf - 1.3) < 1e-6, String(av.valuation.hf));
  });

  it("a registry DEPLOYED pointing at Morpho (no previous venue) still values the Aave pool — the keeper never assumes a single venue", async () => {
    const w = world((oil, chain) => {
      cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.3));
      oil.setVenue(CBBTC, MORPHO_VENUE_ADDR, false);
      oil.setVenue(WETH, MORPHO_VENUE_ADDR, false);
      oil.setEnabled(CBBTC, true);
    });
    const ctx = await readTickContexts({ reader: w.reader, venues: w.venues });
    const aaveVenues = ctx.venues!.venues.filter((v) => v.kind === "aave");
    assert.deepEqual(aaveVenues.flatMap((v) => v.assets.map((a) => a.symbol)), ["cbZEC"], "only the disabled cbZEC still names the Aave venue");
    const av = await w.value();
    assert.equal(av.valuation.kind, "OK", "the pool verdict is always part of the combination");
    if (av.valuation.kind === "OK") assert.ok(Math.abs(av.valuation.hf - 1.3) < 1e-6);
  });

  it("V1: a previous venue that cannot be read makes the account UNKNOWN — it may hold the debt", async () => {
    const w = world((oil, chain) => {
      cbBtcPosition(chain, ACCOUNT_A, debtForHf(2.0));
      oil.setVenue(CBBTC, MORPHO_VENUE_ADDR);
      oil.setPreviousVenues(CBBTC, [AAVE_VENUE_ADDR, DEAD_VENUE_ADDR]);
    });
    const av = await w.value();
    assert.equal(av.valuation.kind, "UNKNOWN");
    assert.equal(av.aave.kind, "OK");
    if (av.valuation.kind === "UNKNOWN") assert.match(av.valuation.reasons.join("\n"), /V1 venue .* unreadable/);
  });

  it("a venue with a threshold problem this tick is inert for an account that holds nothing on it", async () => {
    const w = world((oil, chain) => {
      cbBtcPosition(chain, ACCOUNT_A, debtForHf(2.0));
      oil.setVenue(WETH, MORPHO_VENUE_ADDR);
      oil.failVenueCall(MORPHO_VENUE_ADDR, "liquidationThresholdBps");
    });
    const av = await w.value();
    assert.equal(av.valuation.kind, "OK");
    // …and NOT inert for an account exposed there.
    w.oil.setMorphoPosition(ACCOUNT_B, WETH, { collateral: 10n ** 18n, debt: 1_000_000_000n });
    const b = await w.value(ACCOUNT_B);
    assert.equal(b.valuation.kind, "UNKNOWN");
    if (b.valuation.kind === "UNKNOWN") assert.match(b.valuation.reasons.join("\n"), /V1 venue .* liquidationThresholdBps\(WETH\)/);
  });

  it("V1: a registry pointer that cannot be read this tick makes every account UNKNOWN", async () => {
    const w = world((oil, chain) => {
      cbBtcPosition(chain, ACCOUNT_A, debtForHf(2.0));
      oil.failRegistryCall("previousVenues", CBBTC);
    });
    const av = await w.value();
    assert.equal(av.valuation.kind, "UNKNOWN");
    if (av.valuation.kind === "UNKNOWN") assert.match(av.valuation.reasons.join("\n"), /V1 registry cbBTC/);
  });
});

// ---------------------------------------------------------------------------
// Rungs fire on a Morpho position — through the monitor and through the dispatcher.
// ---------------------------------------------------------------------------

class FakeDispatcher implements Dispatcher {
  calls: DispatchIntent[] = [];
  async dispatch(intent: DispatchIntent): Promise<DispatchResult> {
    this.calls.push(intent);
    return intent.record.action === "notify" ? { status: "NOTIFIED" } : { status: "CONFIRMED", txHash: ("0x" + "11".repeat(32)) as Hex };
  }
  async confirm(record: DispatchRecord): Promise<DispatchResult> {
    return { status: "CONFIRMED", txHash: record.txHash! };
  }
}

const MONITOR_CONFIG: MonitorConfig = {
  concurrency: 2,
  priceMaxAgeS: 3 * 3600,
  oracleDeviationBps: 300,
  hfToleranceBps: 100,
  discoveryFromBlock: 0n,
  unknownEscalationStreak: 2,
  maxDispatchAttempts: 3,
  maxResumePerTick: 25,
  dispatchDeadlineMs: 5_000,
  maxRecordStalls: 3,
  maxRungRefires: 2,
  clockDriftMaxS: 120,
};

async function monitorRig(w: ReturnType<typeof world>) {
  const store = new KeeperStore(freshPath());
  await store.open();
  const sink = memorySink();
  const dispatcher = new FakeDispatcher();
  const escalations: { account: Address; reasons: string[] }[] = [];
  const monitor = new HealthMonitor({
    reader: w.reader,
    venues: w.venues,
    discovery: new AccountDiscovery(w.client, { factory: FACTORY, event: accountCreatedEvent, argNames: { owner: "owner", account: "account" }, chunkBlocks: 1000, deadlineMs: 300 }),
    store,
    ladder: HF_LADDER,
    dispatcher,
    log: new Logger(sink.sink, "debug"),
    config: MONITOR_CONFIG,
    now: () => new Date(Number(w.chain.nowS) * 1000),
    onEscalate: (e) => escalations.push(e),
    notifier: { failures: 0, channels: ["test"], hasPersonChannel: true, deliver: async () => ({ personReached: true }) },
  });
  const watchdog = new ProgressWatchdog({ stallMs: 10_000, backoff: { initialMs: 10, maxMs: 100, factor: 2 } });
  return { store, sink, dispatcher, monitor, escalations, tick: () => monitor.tick(watchdog.beginTick()) };
}

describe("rungs fire on a Morpho position", () => {
  it("monitor: HF 1.30 on Morpho fires `repay`, a crash to 1.02 fires `emergency-unwind`; recovery re-arms", async () => {
    const w = morphoWorld(1.3);
    w.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    const r = await monitorRig(w);
    let rep = await r.tick();
    assert.equal(rep.outcomes.length, 1);
    assert.equal(rep.outcomes[0].valuation, "OK");
    assert.equal(rep.outcomes[0].fired, "repay");
    assert.equal(r.dispatcher.calls[0].record.action, "repay");
    assert.ok(r.dispatcher.calls[0].valuation, "the intent carries the Morpho valuation the plan is sized from");
    assert.equal(r.dispatcher.calls[0].valuation?.dominantCollateral.liquidationThresholdBps, 8600n);

    w.oil.setMorphoPrice(CBBTC, 47_000_00000000n); // 47,000 × 0.86 / 52,658 = 0.768 at the venue…
    w.chain.reserves.get(CBBTC.toLowerCase())!.chainlink!.answer = 47_000_00000000n; // …and the keeper's feed agrees
    rep = await r.tick();
    assert.equal(rep.outcomes[0].fired, "emergency", "the most severe rung's id");
    assert.equal(r.dispatcher.calls.at(-1)?.record.action, "emergency-unwind");

    w.oil.setMorphoPrice(CBBTC, 79_600_00000000n);
    w.chain.reserves.get(CBBTC.toLowerCase())!.chainlink!.answer = 79_600_00000000n;
    w.oil.setMorphoPosition(ACCOUNT_A, CBBTC, { collateral: ONE_BTC, debt: morphoDebtForHf(2.0) });
    rep = await r.tick();
    assert.equal(rep.outcomes[0].fired, null);
    assert.equal(r.store.getAccount(ACCOUNT_A)?.episode, null, "episode ended — every rung re-armed");
    await r.store.close();
  });

  it("monitor: a venue/feed disagreement is UNKNOWN on the tick — no rung, an escalation after the streak, never 'healthy'", async () => {
    const w = morphoWorld(1.1, (_, chain) => {
      chain.reserves.get(CBBTC.toLowerCase())!.chainlink!.answer = 120_000_00000000n; // the feed says the position is fine; the venue says 1.1
    });
    w.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    const r = await monitorRig(w);
    const rep1 = await r.tick();
    assert.equal(rep1.outcomes[0].valuation, "UNKNOWN");
    assert.equal(rep1.outcomes[0].fired, null);
    assert.equal(r.dispatcher.calls.length, 0);
    await r.tick();
    assert.equal(r.escalations.length, 1, "UNKNOWN twice running escalates (streak 2)");
    assert.match(r.escalations[0].reasons.join("\n"), /V4 venue/);
    await r.store.close();
  });

  it("monitor: Aave debt behind a Morpho pointer (previousVenues) fires `repay` exactly as it did before the switch", async () => {
    const w = world((oil, chain) => {
      cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.3));
      oil.setVenue(CBBTC, MORPHO_VENUE_ADDR);
    });
    w.chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    const r = await monitorRig(w);
    const rep = await r.tick();
    assert.equal(rep.outcomes[0].valuation, "OK");
    assert.equal(rep.outcomes[0].fired, "repay");
    assert.equal(r.dispatcher.calls[0].valuation?.dominantCollateral.liquidationThresholdBps, 7800n, "sized against the Aave position");
    await r.store.close();
  });

  function keeperDispatcher(w: ReturnType<typeof world>) {
    const wallet = createWalletClient({ account: privateKeyToAccount(KEY), chain: base, transport: w.chain.transport() });
    const sink = memorySink();
    return new KeeperDispatcher({
      client: w.client,
      wallet,
      keeper: KEEPER,
      router: ROUTER,
      lpVenue: LP_VENUE,
      usdc: USDC,
      reader: w.reader,
      venues: w.venues,
      ladder: HF_LADDER,
      log: new Logger(sink.sink, "debug"),
      config: { deadlineMs: 500, bandToleranceBps: 100, bandMaxToleranceBps: 500, txDeadlineS: 120, ...PARAMS, swapMaxSlippageBps: 100, maxValueProbes: 24, grantExpiryWarnS: 7 * 86_400 },
      now: () => new Date(Number(w.chain.nowS) * 1000),
      notifier: { failures: 0, channels: ["test"], hasPersonChannel: true, deliver: async () => ({ personReached: true }) },
    });
  }
  const record = (action: string, rung: string, hf: number): DispatchRecord => {
    const now = "2026-09-08T01:00:00.000Z";
    return { key: `${ACCOUNT_A.toLowerCase()}:1:1:${action}`, account: ACCOUNT_A.toLowerCase() as Address, episode: 1, seq: 1, action, rung, hf, status: "PENDING", attempts: 0, createdAt: now, updatedAt: now };
  };

  it("dispatcher world check: a resumed repay for a Morpho account is NOT 'SUPERSEDED: no debt' — it reaches the grant read", async () => {
    const w = morphoWorld(1.3);
    const d = keeperDispatcher(w);
    const res = await d.dispatch({ record: record("repay", "repay", 1.3), valuation: null });
    assert.equal(res.status, "REFUSED");
    assert.match((res as { reason: string }).reason, /no active grant/, "the world check saw the Morpho debt and moved on to the grant");
  });

  it("dispatcher end to end: with the signed grant and idle USDC, `repay` on a Morpho position is SENT, the mock repays the Morpho market, and confirm() sees repaid > 0", async () => {
    const w = morphoWorld(1.3, (oil) => {
      oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);
      oil.setUsdc(ACCOUNT_A, 20_000_000_000n); // 20,000 USDC idle in the account
    });
    const before = w.oil.morphoPosition(ACCOUNT_A, CBBTC).debt;
    const d = keeperDispatcher(w);
    const res = await d.dispatch({ record: record("repay", "repay", 1.3), valuation: null });
    assert.equal(res.status, "SENT", JSON.stringify(res));
    const after = w.oil.morphoPosition(ACCOUNT_A, CBBTC).debt;
    assert.ok(after < before, `Morpho debt ${before} → ${after}`);
    const c = await d.confirm({ ...record("repay", "repay", 1.3), status: "SENT", txHash: (res as { txHash: Hex }).txHash });
    assert.equal(c.status, "CONFIRMED");
    // The repay was sized to the rung's disarm from the Morpho valuation: HF is now ≥ 1.40.
    const av = await w.value();
    assert.equal(av.valuation.kind, "OK");
    if (av.valuation.kind === "OK") assert.ok(av.valuation.hf >= 1.4 - 1e-6, `HF after repay ${av.valuation.hf}`);
  });
});
