import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { KeeperStore } from "../src/store/keeperStore.js";
import { ownerHistoryChannel } from "../src/notify/ownerNotifier.js";
import { GRANT_SELECTORS } from "../src/abi/oilskin.js";
import { runKeeper } from "../src/keeper.js";
import { memorySink } from "../src/log.js";
import { ACCOUNT_A, ACCOUNT_B, FACTORY, OWNER_A, cbBtcPosition, debtForHf, newMockChain } from "./fixtures.js";
import { MockOilskin } from "./mockOilskin.js";

let dir: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "owner-notifier-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-09-07T00:00:00Z");
let n = 0;
const fresh = () => join(dir, `s${++n}.json`);

describe("owner-history channel — durable per-account record, not a delivery path", () => {
  it("records an account-scoped event with no extra fields (no PII)", async () => {
    const store = new KeeperStore(fresh());
    await store.open();
    await store.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    const channel = ownerHistoryChannel(store);

    await channel.send({ kind: "rung-fired", severity: "warn", account: ACCOUNT_A, owner: OWNER_A, rung: "warn", hf: 1.42, at: NOW.toISOString() });

    const history = store.getOwnerNotifyHistory(ACCOUNT_A);
    assert.equal(history.length, 1);
    assert.deepEqual(Object.keys(history[0]).sort(), ["at", "hf", "kind", "rung", "severity"]);
    assert.equal(history[0].kind, "rung-fired");
    assert.equal(history[0].severity, "warn");
    assert.equal(history[0].rung, "warn");
    assert.equal(history[0].hf, 1.42);
    await store.close();
  });

  it("ignores fleet-level events with no account, without throwing", async () => {
    const store = new KeeperStore(fresh());
    await store.open();
    await store.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    const channel = ownerHistoryChannel(store);

    await channel.send({ kind: "feed-policy", severity: "info", at: NOW.toISOString() });

    assert.deepEqual(store.getOwnerNotifyHistory(ACCOUNT_A), []);
    await store.close();
  });

  it("caps history per account, dropping the oldest first", async () => {
    const store = new KeeperStore(fresh(), { ownerNotifyHistoryCap: 3 });
    await store.open();
    await store.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    const channel = ownerHistoryChannel(store);

    for (let i = 0; i < 5; i++) {
      await channel.send({ kind: "rung-fired", severity: "warn", account: ACCOUNT_A, rung: "warn", hf: 1.5 - i * 0.01, at: `2026-09-07T00:0${i}:00.000Z` });
    }

    const history = store.getOwnerNotifyHistory(ACCOUNT_A);
    assert.equal(history.length, 3);
    // Oldest two (i=0,1) dropped; the three most recent (i=2,3,4) survive in order.
    assert.deepEqual(
      history.map((h) => h.at),
      ["2026-09-07T00:02:00.000Z", "2026-09-07T00:03:00.000Z", "2026-09-07T00:04:00.000Z"]
    );
    await store.close();
  });

  it("an account not yet registered is swallowed, not a delivery failure", async () => {
    const store = new KeeperStore(fresh());
    await store.open();
    const channel = ownerHistoryChannel(store);

    // ACCOUNT_B was never registered — this must resolve, not reject.
    await channel.send({ kind: "rung-fired", severity: "critical", account: ACCOUNT_B, rung: "emergency", hf: 1.02, at: NOW.toISOString() });

    assert.deepEqual(store.getOwnerNotifyHistory(ACCOUNT_B), []);
    await store.close();
  });

  it("keeps per-account isolation — one account's history never leaks into another's", async () => {
    const store = new KeeperStore(fresh());
    await store.open();
    await store.registerAccount({ account: ACCOUNT_A, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    await store.registerAccount({ account: ACCOUNT_B, owner: OWNER_A, discoveredAtBlock: 1n }, NOW);
    const channel = ownerHistoryChannel(store);

    await channel.send({ kind: "rung-fired", severity: "warn", account: ACCOUNT_A, rung: "warn", hf: 1.4, at: NOW.toISOString() });

    assert.equal(store.getOwnerNotifyHistory(ACCOUNT_A).length, 1);
    assert.equal(store.getOwnerNotifyHistory(ACCOUNT_B).length, 0);
    await store.close();
  });
});

const KEY = ("0x" + "77".repeat(32)) as Hex;
const ROUTER = "0x3000000000000000000000000000000000000001" as const;
const LP_VENUE = "0x3000000000000000000000000000000000000002" as const;
const KEEPER = privateKeyToAccount(KEY).address;

function env(storePath: string): NodeJS.ProcessEnv {
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
  };
}

describe("owner-history channel — wired into the real keeper run, not just the unit", () => {
  it("a warn rung during a real tick leaves a durable record for that account", async () => {
    const chain = newMockChain();
    chain.emitAccountCreated(OWNER_A, ACCOUNT_A, 1n);
    cbBtcPosition(chain, ACCOUNT_A, debtForHf(1.45)); // warn rung (< 1.50)
    const oil = new MockOilskin(chain, { router: ROUTER, lpVenue: LP_VENUE });
    oil.install([ACCOUNT_A]);
    oil.grant(KEEPER, ROUTER, GRANT_SELECTORS["StrategyRouter.unwind"]);

    const storePath = join(dir, "wired.json");
    await runKeeper(env(storePath), {
      sink: memorySink().sink,
      maxTicks: 1,
      makeClient: () => chain.publicClient(),
      makeWallet: (_c, account) => createWalletClient({ account, chain: base, transport: chain.transport() }),
    });

    const store = new KeeperStore(storePath);
    await store.open();
    const history = store.getOwnerNotifyHistory(ACCOUNT_A);
    assert.ok(history.length > 0, "the warn rung must leave a durable owner-history record");
    assert.ok(history.some((h) => h.rung === "warn"));
    await store.close();
  });
});
