import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AAVE_V3 } from "@zyo/shared";
import { runKeeper } from "../src/keeper.js";
import { memorySink } from "../src/log.js";
import { assertAaveVenues, UnsupportedVenueError } from "../src/services/venues.js";
import type { Address } from "../src/types/evm.js";
import { ACCOUNT_A, CBBTC, FACTORY, OWNER_A, WETH, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import { AAVE_VENUE_ADDR, MockOilskin, OTHER_VENUE_ADDR } from "./mockOilskin.js";

/**
 * Audit wave 2, M-HIGH-2. The keeper values every account through the Aave
 * pool (services/chain.ts) and never reads ICollateralVenue. After the
 * registry owner runs `proposeVenue` → `acceptVenue` for cbBTC, a position
 * opened on the new venue is NO_DEBT to this process: no rung fires, no
 * escalation, while the dashboard says "active". The guard below makes that
 * a startup FATAL instead of a silent blind spot.
 */

const KEY = ("0x" + "42".repeat(32)) as Hex;
const ROUTER = getAddress("0x2000000000000000000000000000000000000001") as Address;
const LP_VENUE = getAddress("0x2000000000000000000000000000000000000002") as Address;
const KEEPER = privateKeyToAccount(KEY).address;

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

describe("venue guard — the registry must point every enabled asset at the Aave venue the keeper reads", () => {
  it("passes when every enabled asset resolves to an AaveV3Venue over the shared provider", async () => {
    const chain = newMockChain();
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    const r = await assertAaveVenues(chain.publicClient(), ROUTER, 2_000);
    assert.equal(r.registry, oil.registry);
    assert.deepEqual(
      r.checked.map((c) => `${c.symbol}:${c.venue.toLowerCase()}`),
      [`cbBTC:${AAVE_VENUE_ADDR.toLowerCase()}`, `WETH:${AAVE_VENUE_ADDR.toLowerCase()}`]
    );
    assert.deepEqual(r.skippedDisabled, ["cbZEC"], "a disabled asset is not checked — nothing can be opened there");
  });

  it("names every enabled asset whose venue does not answer PROVIDER() — a MorphoBlueVenue after acceptVenue", async () => {
    const chain = newMockChain();
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.setVenue(CBBTC, OTHER_VENUE_ADDR);
    await assert.rejects(
      () => assertAaveVenues(chain.publicClient(), ROUTER, 2_000),
      (e: unknown) => {
        assert.ok(e instanceof UnsupportedVenueError);
        assert.equal(e.problems.length, 1);
        assert.equal(e.problems[0].symbol, "cbBTC");
        assert.equal(e.problems[0].venue?.toLowerCase(), OTHER_VENUE_ADDR.toLowerCase());
        assert.match(e.problems[0].reason, /PROVIDER/);
        assert.match(e.message, /M-HIGH-2/);
        return true;
      }
    );
  });

  it("refuses an AaveV3Venue over a DIFFERENT provider (a venue the keeper's pool reads would not describe)", async () => {
    const chain = newMockChain();
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    const other = getAddress("0x0000000000000000000000000000000000000e15") as Address;
    oil.installVenue(other);
    oil.setVenue(WETH, other);
    oil.setVenueProvider(other, getAddress("0x00000000000000000000000000000000000000ff") as Address);
    await assert.rejects(
      () => assertAaveVenues(chain.publicClient(), ROUTER, 2_000),
      (e: unknown) => {
        assert.ok(e instanceof UnsupportedVenueError);
        assert.equal(e.problems[0].symbol, "WETH");
        assert.match(e.problems[0].reason, new RegExp(AAVE_V3.poolAddressesProvider, "i"));
        return true;
      }
    );
  });

  it("ignores a DISABLED asset pointed at an unsupported venue (cbZEC at Morpho, say)", async () => {
    const chain = newMockChain();
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.setVenue(CBBTC, OTHER_VENUE_ADDR);
    oil.setEnabled(CBBTC, false);
    const r = await assertAaveVenues(chain.publicClient(), ROUTER, 2_000);
    assert.deepEqual(r.checked.map((c) => c.symbol), ["WETH"]);
    assert.deepEqual(r.skippedDisabled, ["cbBTC", "cbZEC"]);
  });

  it("runKeeper is FATAL at startup on an unsupported venue: no tick runs, no account is ever valued NO_DEBT", async () => {
    const chain = newMockChain();
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.3));
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 5n);
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.grant(KEEPER, ROUTER, "0x08435e75" as Hex);
    oil.setVenue(CBBTC, OTHER_VENUE_ADDR);
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
    assert.ok(msgs.some((m) => /VENUE GUARD FAILED/.test(m)), "the failure is loud");
    assert.ok(!msgs.some((m) => /valuation|NO_DEBT|rung fired|heartbeat/.test(m)), "nothing was valued or heartbeat");
  });

  it("runKeeper starts and ticks when the registry agrees with the keeper's Aave wiring", async () => {
    const chain = newMockChain();
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(2.0));
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 5n);
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    const sink = memorySink();
    const { ticks } = await runKeeper(env(join(dir, "ok.json")), {
      sink: sink.sink,
      makeClient: () => chain.publicClient(),
      maxTicks: 1,
      notifyChannel: { name: "test", send: async () => undefined },
    });
    assert.equal(ticks, 1);
    assert.ok(sink.records.some((r) => /venue guard passed/.test(String(r.msg))));
  });
});
