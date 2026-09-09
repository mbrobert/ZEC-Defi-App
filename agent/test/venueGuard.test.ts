import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { runKeeper } from "../src/keeper.js";
import { memorySink } from "../src/log.js";
import { UnsupportedVenueError, VenueReader } from "../src/services/venues.js";
import type { Address } from "../src/types/evm.js";
import { ACCOUNT_A, CBBTC, FACTORY, OWNER_A, WETH, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import { AAVE_VENUE_ADDR, DEAD_VENUE_ADDR, MORPHO_VENUE_ADDR, MockOilskin } from "./mockOilskin.js";

/**
 * Audit wave 2, M-HIGH-2 — the startup probe of the venue-aware reader.
 *
 * The fix round's guard refused to START whenever the registry pointed an enabled asset anywhere
 * but the AaveV3Venue over the pool the keeper read, because nothing else could be read. Now every
 * venue the registry names is read through ICollateralVenue on every tick, so the probe is FATAL
 * only for a venue the reader cannot talk to at all (every account would be UNKNOWN, for ever) and
 * a WARNING for a venue that answers but is not Aave. `venueReader.test.ts` proves what those
 * venues are then valued as.
 */

const KEY = ("0x" + "42".repeat(32)) as Hex;
const ROUTER = getAddress("0x2000000000000000000000000000000000000001") as Address;
const LP_VENUE = getAddress("0x2000000000000000000000000000000000000002") as Address;
const KEEPER = privateKeyToAccount(KEY).address;
/** USDC debt (whole units) that puts 1 cbBTC at exactly `hf` on the Morpho mock (LLTV 86 %). */
const morphoDebtForHf = (hf: number) => BigInt(Math.round(((79_600 * 0.86) / hf) * 1e6));

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "venue-guard-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

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

const reader = (chain: ReturnType<typeof newMockChain>) => new VenueReader(chain.publicClient(), ROUTER, { deadlineMs: 2_000 });

describe("venue probe — every venue the registry names must be readable through ICollateralVenue", () => {
  it("passes when every registered asset resolves to the AaveV3Venue over the shared provider; a disabled asset is watched, not skipped", async () => {
    const chain = newMockChain();
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    const p = await reader(chain).probe();
    assert.equal(p.registry, oil.registry);
    assert.equal(p.venues.length, 1);
    assert.equal(p.venues[0].venue.toLowerCase(), AAVE_VENUE_ADDR.toLowerCase());
    assert.equal(p.venues[0].kind, "aave");
    assert.deepEqual(
      p.venues[0].assets.map((a) => `${a.symbol}:${a.role}:${a.enabled}:${a.liquidationThresholdBps}`),
      ["cbBTC:current:true:7800", "WETH:current:true:8300", "cbZEC:current:false:null"],
      "thresholds are read live for enabled assets; the disabled asset is still on the venue's list"
    );
    assert.deepEqual(p.otherVenues, []);
    assert.deepEqual(p.unregistered, []);
  });

  it("a MorphoBlueVenue after acceptVenue answers the interface: the probe PASSES and lists it as a non-Aave venue (a warning, not a fatal)", async () => {
    const chain = newMockChain();
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.setVenue(CBBTC, MORPHO_VENUE_ADDR); // remembers the Aave venue in previousVenues, as the chain does
    const p = await reader(chain).probe();
    assert.equal(p.venues.length, 2);
    assert.equal(p.otherVenues.length, 1);
    const morpho = p.otherVenues[0];
    assert.equal(morpho.venue.toLowerCase(), MORPHO_VENUE_ADDR.toLowerCase());
    assert.equal(morpho.kind, "other");
    assert.equal(morpho.provider, null, "no PROVIDER() view — not an AaveV3Venue");
    assert.deepEqual(morpho.assets.map((a) => `${a.symbol}:${a.role}:${a.liquidationThresholdBps}`), ["cbBTC:current:8600"], "the LLTV is read from the venue, never typed");
    const aave = p.venues.find((v) => v.kind === "aave")!;
    assert.deepEqual(
      aave.assets.map((a) => `${a.symbol}:${a.role}`),
      ["cbBTC:previous", "WETH:current", "cbZEC:current"],
      "the Aave venue stays on cbBTC's list as a PREVIOUS venue — positions opened there are still live (M-HIGH-1)"
    );
  });

  it("an AaveV3Venue over a DIFFERENT provider is readable too — classified 'other' and valued from the feeds, not trusted as the pool", async () => {
    const chain = newMockChain();
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    const other = getAddress("0x0000000000000000000000000000000000000e15") as Address;
    oil.installVenue(other);
    oil.setVenueProvider(other, getAddress("0x00000000000000000000000000000000000000ff") as Address);
    oil.setVenue(WETH, other);
    const p = await reader(chain).probe();
    const v = p.otherVenues.find((x) => x.venue.toLowerCase() === other.toLowerCase())!;
    assert.ok(v, "listed as a non-Aave venue");
    assert.equal(v.provider?.toLowerCase(), "0x00000000000000000000000000000000000000ff");
    assert.equal(v.kind, "other");
  });

  it("a venue that does not answer ICollateralVenue is FATAL by name — every account would be UNKNOWN on every tick", async () => {
    const chain = newMockChain();
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.setVenue(WETH, DEAD_VENUE_ADDR);
    await assert.rejects(
      () => reader(chain).probe(),
      (e: unknown) => {
        assert.ok(e instanceof UnsupportedVenueError);
        assert.equal(e.problems.length, 1);
        assert.equal(e.problems[0].symbol, "WETH");
        assert.equal(e.problems[0].venue?.toLowerCase(), DEAD_VENUE_ADDR.toLowerCase());
        assert.match(e.problems[0].reason, /enabled\(\)/);
        assert.match(e.problems[0].reason, /liquidationThresholdBps\(WETH\)/);
        assert.match(e.message, /M-HIGH-2/);
        return true;
      }
    );
  });

  it("a venue that answers but does not know an ENABLED asset (threshold 0) is fatal; the same asset DISABLED is merely watched", async () => {
    const chain = newMockChain();
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.setVenue(CBBTC, MORPHO_VENUE_ADDR);
    oil.setMorphoLltv(CBBTC, 0n);
    await assert.rejects(
      () => reader(chain).probe(),
      (e: unknown) => {
        assert.ok(e instanceof UnsupportedVenueError);
        assert.equal(e.problems[0].symbol, "cbBTC");
        assert.match(e.problems[0].reason, /liquidationThresholdBps\(cbBTC\) is 0/);
        return true;
      }
    );
    oil.setEnabled(CBBTC, false);
    const p = await reader(chain).probe();
    const morpho = p.otherVenues[0];
    assert.deepEqual(morpho.assets.map((a) => `${a.symbol}:${a.enabled}:${a.liquidationThresholdBps}`), ["cbBTC:false:null"], "disabled: no threshold read, but the venue's healthFactor/debt are still read per account");
  });

  it("a registry whose pointers cannot be read is fatal", async () => {
    const chain = newMockChain();
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.failRegistryCall("venueOf", CBBTC);
    await assert.rejects(
      () => reader(chain).probe(),
      (e: unknown) => {
        assert.ok(e instanceof UnsupportedVenueError);
        assert.equal(e.problems[0].symbol, "cbBTC");
        assert.equal(e.problems[0].venue, null);
        assert.match(e.problems[0].reason, /registry unreadable/);
        return true;
      }
    );
  });

  it("runKeeper is FATAL at startup on an unreadable venue: no tick runs, no account is ever valued", async () => {
    const chain = newMockChain();
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.3));
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 5n);
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.grant(KEEPER, ROUTER, "0x08435e75" as Hex);
    oil.setVenue(CBBTC, DEAD_VENUE_ADDR);
    const sink = memorySink();
    let ticks = 0;
    await assert.rejects(
      () =>
        runKeeper(env(join(dir, "fatal.json")), {
          sink: sink.sink,
          makeClient: () => chain.publicClient(),
          maxTicks: 2,
          onTick: () => void ticks++,
          notifyChannel: { name: "test", send: async () => undefined },
        }),
      (e: unknown) => e instanceof UnsupportedVenueError
    );
    assert.equal(ticks, 0, "the loop never started");
    const msgs = sink.records.map((r) => String(r.msg));
    assert.ok(msgs.some((m) => /VENUE PROBE FAILED/.test(m)), "the failure is loud");
    assert.ok(!msgs.some((m) => /valuation|NO_DEBT|rung fired|heartbeat/.test(m)), "nothing was valued or heartbeat");
  });

  it("runKeeper starts, WARNS and ticks when cbBTC is on a Morpho venue — and values the Morpho position, never NO_DEBT", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 5n);
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.setVenue(CBBTC, MORPHO_VENUE_ADDR);
    oil.setMorphoPosition(ACCOUNT_A, CBBTC, { collateral: 100_000_000n, debt: morphoDebtForHf(2.0) });
    const sink = memorySink();
    const reports: { valuation: string; hf: number | null }[] = [];
    const { ticks } = await runKeeper(env(join(dir, "morpho.json")), {
      sink: sink.sink,
      makeClient: () => chain.publicClient(),
      maxTicks: 1,
      onTick: (r) => reports.push(...r.outcomes.map((o) => ({ valuation: o.valuation, hf: o.hf }))),
      notifyChannel: { name: "test", send: async () => undefined },
    });
    assert.equal(ticks, 1);
    const msgs = sink.records.map((r) => String(r.msg));
    assert.ok(msgs.some((m) => /NON-AAVE VENUE/.test(m)), "the non-Aave venue is a loud warning at startup");
    assert.ok(msgs.some((m) => /venue probe passed/.test(m)));
    assert.equal(reports.length, 1);
    assert.equal(reports[0].valuation, "OK");
    assert.ok(Math.abs((reports[0].hf ?? 0) - 2.0) < 1e-6, `Morpho HF ${reports[0].hf}`);
  });
});
