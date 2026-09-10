import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AAVE_V3, BASE_TOKENS, CHAINS } from "@zyo/shared";
import { CONFIG_DEFAULTS, ConfigError, describeConfig, loadConfig } from "../src/config.js";

const KEY = "0x" + "ab".repeat(32);
const BASE_ENV = {
  BASE_RPC_URL: "https://user:secret@rpc.example/v2/APIKEY123",
  ACCOUNT_FACTORY_ADDRESS: "0xFAC70000000000000000000000000000000000AC",
  STORE_PATH: "/var/lib/oilskin/keeper.json",
  DISCOVERY_FROM_BLOCK: "35000000",
};
const ROUTER = "0x2000000000000000000000000000000000000001";

describe("config — validation", () => {
  it("loads a minimal valid env with defaults", () => {
    const c = loadConfig({ ...BASE_ENV });
    assert.equal(c.healthPollMs, CONFIG_DEFAULTS.healthPollMs);
    assert.equal(c.rpcDeadlineMs, CONFIG_DEFAULTS.rpcDeadlineMs);
    assert.equal(c.keeperPrivateKey, undefined);
    assert.equal(c.chainId, 8453);
  });

  it("S-MED-1: a CHAIN_ID without an address table is refused by name — 8453 and 84532 are the only tables", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, CHAIN_ID: "1" }), /CHAIN_ID: unsupported chain 1.*address tables for 8453, 84532 only/);
    assert.throws(() => loadConfig({ ...BASE_ENV, CHAIN_ID: "10" }), /CHAIN_ID: unsupported chain 10/);
    assert.equal(loadConfig({ ...BASE_ENV, CHAIN_ID: "8453" }).chainId, 8453);
  });

  it("slice 6: CHAIN_ID=8453 is unchanged — the mainnet table, the mainnet tokens, and an override for a pinned token is refused by name", () => {
    const c = loadConfig({ ...BASE_ENV });
    assert.equal(c.chain.id, 8453);
    assert.equal(c.chain, CHAINS[8453]);
    assert.equal(c.chain.aave.pool, AAVE_V3.pool);
    assert.equal(c.tokens.USDC.address, BASE_TOKENS.USDC.address);
    assert.equal(c.tokens.cbZEC.address, BASE_TOKENS.cbZEC.address);
    assert.throws(
      () => loadConfig({ ...BASE_ENV, CBZEC_ADDRESS: "0x1111111111111111111111111111111111111111" }),
      (e: unknown) => e instanceof ConfigError && /CBZEC_ADDRESS: CBZEC_ADDRESS is set, but cbZEC on chain 8453 is pinned/.test((e as Error).message)
    );
    assert.equal(describeConfig(c).chain, "Base");
  });

  it("slice 6: CHAIN_ID=84532 resolves the Base Sepolia table — Aave, feeds, WBTC under the cbBTC role — and never a mainnet address", () => {
    const c = loadConfig({ ...BASE_ENV, CHAIN_ID: "84532", CBZEC_ADDRESS: "0x1111111111111111111111111111111111111111", AERO_ADDRESS: "0x2222222222222222222222222222222222222222" });
    assert.equal(c.chainId, 84532);
    assert.equal(c.chain, CHAINS[84532]);
    assert.equal(c.chain.aave.pool, "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27");
    assert.notEqual(c.chain.aave.pool, AAVE_V3.pool);
    assert.equal(c.tokens.USDC.address, "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f");
    assert.equal(c.tokens.cbBTC.address, "0x54114591963CF60EF3aA63bEfD6eC263D98145a4");
    assert.equal(c.tokens.cbZEC.address, "0x1111111111111111111111111111111111111111");
    assert.equal(c.tokens.AERO.address, "0x2222222222222222222222222222222222222222");
    assert.equal(c.chain.feeds.cbBTC_USD, null);
    assert.equal(describeConfig(c).chain, "Base Sepolia");
  });

  it("slice 6: on 84532 a token the table does not pin must come from env, by name — cbZEC and AERO are deploy-time doubles", () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, CHAIN_ID: "84532" }),
      (e: unknown) => e instanceof ConfigError && /CBZEC_ADDRESS: no cbZEC address for chain 84532/.test((e as Error).message) && /DEPLOY-SEPOLIA/.test((e as Error).message)
    );
    assert.throws(
      () => loadConfig({ ...BASE_ENV, CHAIN_ID: "84532", CBZEC_ADDRESS: "0x1111111111111111111111111111111111111111" }),
      (e: unknown) => e instanceof ConfigError && /AERO_ADDRESS: no AERO address for chain 84532/.test((e as Error).message)
    );
    assert.throws(() => loadConfig({ ...BASE_ENV, CHAIN_ID: "84532", CBZEC_ADDRESS: "nope", AERO_ADDRESS: "0x2222222222222222222222222222222222222222" }), ConfigError);
  });

  it("N-MED-1: NOTIFY_ALLOW_LOG_ONLY is off by default and only \"1\" turns it on", () => {
    assert.equal(loadConfig({ ...BASE_ENV }).notifyAllowLogOnly, false);
    assert.equal(loadConfig({ ...BASE_ENV, NOTIFY_ALLOW_LOG_ONLY: "1" }).notifyAllowLogOnly, true);
    assert.equal(loadConfig({ ...BASE_ENV, NOTIFY_ALLOW_LOG_ONLY: "0" }).notifyAllowLogOnly, false);
    assert.throws(() => loadConfig({ ...BASE_ENV, NOTIFY_ALLOW_LOG_ONLY: "yes" }), /NOTIFY_ALLOW_LOG_ONLY/);
  });

  it("requires BASE_RPC_URL, ACCOUNT_FACTORY_ADDRESS, STORE_PATH, DISCOVERY_FROM_BLOCK", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, BASE_RPC_URL: "" }), /BASE_RPC_URL: is required/);
    assert.throws(() => loadConfig({ ...BASE_ENV, DISCOVERY_FROM_BLOCK: undefined }), /DISCOVERY_FROM_BLOCK: is required/);
    assert.throws(() => loadConfig({ ...BASE_ENV, ACCOUNT_FACTORY_ADDRESS: undefined }), /ACCOUNT_FACTORY_ADDRESS: is required/);
    assert.throws(() => loadConfig({ ...BASE_ENV, STORE_PATH: undefined }), /STORE_PATH: is required/);
  });

  it("STORE_PATH must be absolute and whitespace-free", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, STORE_PATH: "data/keeper.json" }), /STORE_PATH: must be absolute/);
    assert.throws(() => loadConfig({ ...BASE_ENV, STORE_PATH: "./keeper.json" }), /must be absolute/);
    assert.throws(() => loadConfig({ ...BASE_ENV, STORE_PATH: "/var/lib/oil skin/k.json" }), /whitespace/);
  });

  it("whitespace-only numeric values are refused, never parsed as 0", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, HEALTH_POLL_MS: "   " }), /HEALTH_POLL_MS: is whitespace-only/);
    assert.throws(() => loadConfig({ ...BASE_ENV, HEALTH_POLL_MS: "\t" }), /whitespace-only/);
    assert.throws(() => loadConfig({ ...BASE_ENV, HEALTH_POLL_MS: " 5000" }), /not a strict decimal/);
    assert.throws(() => loadConfig({ ...BASE_ENV, HEALTH_POLL_MS: "5000 " }), /not a strict decimal/);
    // Sanity: JavaScript really does parse whitespace as 0 — the reason the rule exists.
    assert.equal(Number("   "), 0);
  });

  it("rejects non-strict numerics: hex, exponent, Infinity, NaN, empty decimal", () => {
    for (const bad of ["0x10", "1e3", "Infinity", "NaN", "5.", ".5", "+5", "1_000"]) {
      assert.throws(() => loadConfig({ ...BASE_ENV, RPC_DEADLINE_MS: bad }), /RPC_DEADLINE_MS/, bad);
    }
  });

  it("every floor / interval / tolerance must be > 0", () => {
    for (const name of [
      "HEALTH_POLL_MS",
      "RPC_DEADLINE_MS",
      "WATCHDOG_STALL_MS",
      "BACKOFF_MAX_MS",
      "PRICE_MAX_AGE_S",
      "ORACLE_DEVIATION_BPS",
      "HF_TOLERANCE_BPS",
      "CONCURRENCY",
      "DISCOVERY_CHUNK_BLOCKS",
    ]) {
      assert.throws(() => loadConfig({ ...BASE_ENV, [name]: "0" }), new RegExp(`${name}: must be ≥ 1`), name);
      assert.throws(() => loadConfig({ ...BASE_ENV, [name]: "-1" }), new RegExp(name), name);
    }
  });

  it("integers only where integers are required", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, CONCURRENCY: "2.5" }), /CONCURRENCY: must be an integer/);
    assert.throws(() => loadConfig({ ...BASE_ENV, HEALTH_POLL_MS: "100.5" }), /must be an integer/);
  });

  it("watchdog stall must exceed the RPC deadline (else it is the elapsed-time bug)", () => {
    assert.throws(
      () => loadConfig({ ...BASE_ENV, RPC_DEADLINE_MS: "10000", WATCHDOG_STALL_MS: "10000" }),
      /WATCHDOG_STALL_MS: must exceed RPC_DEADLINE_MS/
    );
    assert.throws(() => loadConfig({ ...BASE_ENV, RPC_DEADLINE_MS: "10000", WATCHDOG_STALL_MS: "5000" }), /must exceed/);
    const ok = loadConfig({ ...BASE_ENV, RPC_DEADLINE_MS: "10000", WATCHDOG_STALL_MS: "10001" });
    assert.equal(ok.watchdogStallMs, 10001);
  });

  it("validates the private key shape without echoing it", () => {
    let err: Error | undefined;
    try {
      loadConfig({ ...BASE_ENV, KEEPER_PRIVATE_KEY: "0xdeadbeefSECRET" });
    } catch (e) {
      err = e as Error;
    }
    assert.ok(err instanceof ConfigError);
    assert.doesNotMatch(err!.message, /SECRET/);
    assert.throws(() => loadConfig({ ...BASE_ENV, KEEPER_PRIVATE_KEY: "0x" + "00".repeat(32) }), /must not be zero/);
    const c = loadConfig({ ...BASE_ENV, KEEPER_PRIVATE_KEY: KEY, STRATEGY_ROUTER_ADDRESS: ROUTER });
    assert.equal(c.keeperPrivateKey, KEY);
    assert.equal(c.routerAddress, ROUTER);
  });

  it("keeper mode requires the router address; observe-only does not", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, KEEPER_PRIVATE_KEY: KEY }), /STRATEGY_ROUTER_ADDRESS: is required when KEEPER_PRIVATE_KEY/);
    assert.equal(loadConfig(BASE_ENV).routerAddress, undefined);
  });

  it("band tolerance and tx deadline are floors > 0 with sane ceilings", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, BAND_TOLERANCE_BPS: "0" }), /BAND_TOLERANCE_BPS: must be ≥ 1/);
    assert.throws(() => loadConfig({ ...BASE_ENV, BAND_TOLERANCE_BPS: "5001" }), /BAND_TOLERANCE_BPS: must be ≤ 5000/);
    assert.throws(() => loadConfig({ ...BASE_ENV, TX_DEADLINE_S: "0" }), /TX_DEADLINE_S: must be ≥ 1/);
    assert.equal(loadConfig({ ...BASE_ENV, BAND_TOLERANCE_BPS: "50", TX_DEADLINE_S: "60" }).bandToleranceBps, 50);
  });

  it("validates addresses and rejects the zero address", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, ACCOUNT_FACTORY_ADDRESS: "0x1234" }), /20-byte address/);
    assert.throws(() => loadConfig({ ...BASE_ENV, ACCOUNT_FACTORY_ADDRESS: "0x" + "0".repeat(40) }), /zero address/);
  });

  it("RPC URL must be http(s)", () => {
    assert.throws(() => loadConfig({ ...BASE_ENV, BASE_RPC_URL: "wss://rpc.example" }), /must be http/);
    assert.throws(() => loadConfig({ ...BASE_ENV, BASE_RPC_URL: "not a url" }), /not a valid URL/);
  });

  it("DISCOVERY_FROM_BLOCK is a non-negative integer bigint", () => {
    assert.equal(loadConfig({ ...BASE_ENV, DISCOVERY_FROM_BLOCK: "12345678901234567890" }).discoveryFromBlock, 12345678901234567890n);
    assert.throws(() => loadConfig({ ...BASE_ENV, DISCOVERY_FROM_BLOCK: "-1" }), /DISCOVERY_FROM_BLOCK/);
    assert.throws(() => loadConfig({ ...BASE_ENV, DISCOVERY_FROM_BLOCK: "1.5" }), /DISCOVERY_FROM_BLOCK/);
  });

  it("no health-factor threshold is configurable from the environment", () => {
    // The ladder is derived in packages/shared; typing one here is forbidden.
    const c = loadConfig({ ...BASE_ENV, HF_WARNING: "1.9", HF_CRITICAL: "1.1" }) as unknown as Record<string, unknown>;
    assert.equal(c.hfWarning, undefined);
    assert.equal(c.hfCritical, undefined);
    assert.ok(!Object.keys(c).some((k) => /^hf(Warning|Critical|Emergency)/.test(k)));
  });
});

describe("config — describeConfig never leaks", () => {
  it("omits the key and reduces the RPC URL to its origin", () => {
    const c = loadConfig({ ...BASE_ENV, KEEPER_PRIVATE_KEY: KEY, STRATEGY_ROUTER_ADDRESS: ROUTER });
    const d = JSON.stringify(describeConfig(c));
    assert.doesNotMatch(d, /ab{2}/i);
    assert.doesNotMatch(d, /APIKEY123|secret|user:/);
    assert.match(d, /rpc\.example/);
    assert.match(d, /"mode":"keeper"/);
    assert.equal(JSON.stringify(describeConfig(loadConfig(BASE_ENV))).includes("observe-only"), true);
  });
});
