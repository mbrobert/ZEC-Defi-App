/**
 * The perps keeper's configuration (BUILD-PLAN Stream D step D4): every variable validated by name, the shared
 * defaults when unset, a key that is checked for shape and never serialised, and the two knobs that are the
 * keeper's own (the CoreWriter delay, the de-risk fraction) bounded.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ConfigError } from "../src/config.js";
import { describePerpsConfig, loadPerpsConfig, PERPS_CONFIG_DEFAULTS } from "../src/perps/config.js";

const BASE_ENV = {
  HYPEREVM_RPC_URL: "https://rpc.hyperliquid.xyz/evm",
  PERPS_VENUE_ADDRESS: "0x5E00000000000000000000000000000000000001",
  PERPS_FACTORY_ADDRESS: "0x5e000000000000000000000000000000000000fa",
  PERPS_STORE_PATH: "/var/tmp/oilskin-perps-store.json",
  PERPS_DISCOVERY_FROM_BLOCK: "46887589",
};
const bad = (over: Record<string, string>, re: RegExp) => assert.throws(() => loadPerpsConfig({ ...BASE_ENV, ...over }), (e: unknown) => e instanceof ConfigError && re.test(e.message));

describe("the perps keeper config", () => {
  it("defaults: chain 999, the venue's API as the independent mark, the delay and fraction knobs, observe-only without a key; addresses lower-cased", () => {
    const c = loadPerpsConfig({ ...BASE_ENV });
    assert.equal(c.chainId, 999);
    assert.equal(c.priceSource, "api");
    assert.equal(c.actionDelayBlocks, PERPS_CONFIG_DEFAULTS.actionDelayBlocks);
    assert.equal(c.deriskFractionBps, 3_333);
    assert.equal(c.planMarginBps, 50);
    assert.equal(c.keeperPrivateKey, undefined);
    assert.equal(c.venueAddress, "0x5e00000000000000000000000000000000000001");
    assert.equal(c.discoveryFromBlock, 46_887_589n);
    const d = describePerpsConfig(c);
    assert.equal(d.mode, "observe-only");
    assert.equal(d.chain, "hyperevm");
    assert.equal(d.rpc, "https://rpc.hyperliquid.xyz");
  });

  it("each required variable is refused by name when missing", () => {
    for (const name of Object.keys(BASE_ENV)) {
      const env = { ...BASE_ENV } as Record<string, string>;
      delete env[name];
      assert.throws(() => loadPerpsConfig(env), (e: unknown) => e instanceof ConfigError && e.message.includes(name), name);
    }
  });

  it("the chain id is 999 or 998 and nothing else; the testnet is described as such", () => {
    assert.equal(loadPerpsConfig({ ...BASE_ENV, HYPEREVM_CHAIN_ID: "998" }).chainId, 998);
    assert.equal(describePerpsConfig(loadPerpsConfig({ ...BASE_ENV, HYPEREVM_CHAIN_ID: "998" })).chain, "hyperevm-testnet");
    bad({ HYPEREVM_CHAIN_ID: "8453" }, /HYPEREVM_CHAIN_ID.*999.*998/);
  });

  it("the key is checked for shape and never appears in the description", () => {
    bad({ KEEPER_PERPS_PRIVATE_KEY: "0x1234" }, /KEEPER_PERPS_PRIVATE_KEY.*32-byte/);
    bad({ KEEPER_PERPS_PRIVATE_KEY: "0x" + "0".repeat(64) }, /KEEPER_PERPS_PRIVATE_KEY.*zero/);
    const key = "0x" + "42".repeat(32);
    const c = loadPerpsConfig({ ...BASE_ENV, KEEPER_PERPS_PRIVATE_KEY: key });
    assert.equal(c.keeperPrivateKey, key);
    const d = JSON.stringify(describePerpsConfig(c));
    assert.equal(d.includes("42".repeat(8)), false);
    assert.equal(describePerpsConfig(c).mode, "keeper");
  });

  it("the keeper's own knobs are bounded and read by name; a price source that is not one of the two is refused", () => {
    bad({ PERPS_ACTION_DELAY_BLOCKS: "0" }, /PERPS_ACTION_DELAY_BLOCKS.*≥ 1/);
    bad({ PERPS_DERISK_FRACTION_BPS: "10001" }, /PERPS_DERISK_FRACTION_BPS.*≤ 10000/);
    bad({ PERPS_ORACLE_DEVIATION_BPS: "abc" }, /PERPS_ORACLE_DEVIATION_BPS.*number/);
    bad({ PERPS_PRICE_SOURCE: "jupiter" }, /PERPS_PRICE_SOURCE/);
    bad({ WATCHDOG_STALL_MS: "1000", RPC_DEADLINE_MS: "2000" }, /WATCHDOG_STALL_MS.*exceed/);
    bad({ HYPEREVM_RPC_URL: "   " }, /HYPEREVM_RPC_URL.*whitespace/);
    bad({ PERPS_STORE_PATH: "relative/store.json" }, /PERPS_STORE_PATH.*absolute/);
    const c = loadPerpsConfig({ ...BASE_ENV, PERPS_ACTION_DELAY_BLOCKS: "25", PERPS_DERISK_FRACTION_BPS: "2500", PERPS_PRICE_SOURCE: "precompile-only" });
    assert.equal(c.actionDelayBlocks, 25);
    assert.equal(c.deriskFractionBps, 2_500);
    assert.equal(c.priceSource, "precompile-only");
  });
});
