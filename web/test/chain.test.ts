import { test } from "node:test";
import assert from "node:assert/strict";
import { AAVE_V3, BASE_TOKENS, CHAINS, COLLATERAL_ASSETS, MissingChainAddressError, PERMIT2, UnsupportedChainError } from "@zyo/shared";
import { AAVE_V3 as APP_AAVE, BASE_TOKENS as APP_TOKENS, CHAIN_ID, COLLATERAL_ASSETS as APP_COLLATERAL, COW_SUPPORTED, VIEM_CHAIN, buildChainConfig } from "../lib/chain";

test("slice 6: the default build is Base mainnet and its tables are the shared mainnet objects, unchanged", () => {
  assert.equal(CHAIN_ID, 8453);
  assert.equal(APP_TOKENS, BASE_TOKENS);
  assert.equal(APP_COLLATERAL, COLLATERAL_ASSETS);
  assert.equal(APP_AAVE, CHAINS[8453].aave);
  assert.equal(APP_AAVE.pool, AAVE_V3.pool);
  assert.equal(VIEM_CHAIN.id, 8453);
  assert.equal(COW_SUPPORTED, true);
});

test("slice 6: NEXT_PUBLIC_CHAIN_ID=84532 with the doubles resolves the Sepolia table — Aave, WBTC under the cbBTC role, no CoW, viem baseSepolia — and never a mainnet address", () => {
  const c = buildChainConfig({ chainId: 84532, cbzecAddress: "0x1111111111111111111111111111111111111111", aeroAddress: "0x2222222222222222222222222222222222222222" });
  assert.equal(c.chainId, 84532);
  assert.equal(c.aave.pool, "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27");
  assert.notEqual(c.aave.pool, AAVE_V3.pool);
  assert.equal(c.aave.poolDataProvider, "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b");
  assert.equal(c.tokens.USDC.address, "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f");
  assert.equal(c.tokens.cbBTC.address, "0x54114591963CF60EF3aA63bEfD6eC263D98145a4");
  assert.equal(c.collateral.cbBTC.address, c.tokens.cbBTC.address);
  assert.equal(c.collateral.cbBTC.venueDataSource, c.aave.poolDataProvider);
  assert.equal(c.collateral.cbBTC.feed.kind === "chainlink" ? c.collateral.cbBTC.feed.description : null, "BTC / USD");
  assert.equal(c.tokens.cbZEC.address, "0x1111111111111111111111111111111111111111");
  assert.equal(c.permit2, PERMIT2, "Permit2 is the same address on both chains");
  assert.equal(c.viemChain.id, 84532);
  assert.equal(c.cowSupported, false);
  assert.equal(c.display.explorerUrl, "https://sepolia.basescan.org");
});

test("slice 6: a Sepolia build without the deploy-time doubles fails by name — NEXT_PUBLIC_CBZEC_ADDRESS, then NEXT_PUBLIC_AERO_ADDRESS", () => {
  assert.throws(
    () => buildChainConfig({ chainId: 84532, cbzecAddress: "", aeroAddress: "" }),
    (e: unknown) => e instanceof MissingChainAddressError && e.variable === "NEXT_PUBLIC_CBZEC_ADDRESS" && /no cbZEC address for chain 84532/.test(e.message)
  );
  assert.throws(
    () => buildChainConfig({ chainId: 84532, cbzecAddress: "0x1111111111111111111111111111111111111111", aeroAddress: "" }),
    (e: unknown) => e instanceof MissingChainAddressError && e.variable === "NEXT_PUBLIC_AERO_ADDRESS"
  );
});

test("slice 6: a chain without a table fails by name; an override for a pinned mainnet token is refused", () => {
  assert.throws(() => buildChainConfig({ chainId: 1, cbzecAddress: "", aeroAddress: "" }), (e: unknown) => e instanceof UnsupportedChainError);
  assert.throws(() => buildChainConfig({ chainId: NaN, cbzecAddress: "", aeroAddress: "" }), (e: unknown) => e instanceof UnsupportedChainError);
  assert.throws(() => buildChainConfig({ chainId: 8453, cbzecAddress: "0x1111111111111111111111111111111111111111", aeroAddress: "" }), /NEXT_PUBLIC_CBZEC_ADDRESS is set, but cbZEC on chain 8453 is pinned/);
});
