import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AAVE_V3,
  BASE_TOKENS,
  CHAINLINK_FEEDS,
  CHAINS,
  COLLATERAL_ASSETS,
  MissingChainAddressError,
  PERMIT2,
  PinnedChainAddressError,
  SUPPORTED_CHAIN_IDS,
  UnsupportedChainError,
  chainTable,
  collateralAssetsFor,
  isChecksumAddress,
  isSupportedChainId,
  resolveTokens,
} from "../dist/index.js";

const variable = (s: string) => `${s.toUpperCase()}_ADDRESS`;

test("CHAINS[8453] is the mainnet table — the very objects base.ts exports, nothing retyped", () => {
  const m = CHAINS[8453];
  assert.equal(m.id, 8453);
  assert.equal(m.tokens, BASE_TOKENS);
  assert.equal(m.aave.pool, AAVE_V3.pool);
  assert.equal(m.aave.poolAddressesProvider, AAVE_V3.poolAddressesProvider);
  assert.equal(m.aave.poolDataProvider, AAVE_V3.poolDataProvider);
  assert.equal(m.aave.oracle, AAVE_V3.oracle);
  assert.equal(m.feeds.cbBTC_USD, CHAINLINK_FEEDS.cbBTC_USD);
  assert.equal(m.collateralFeeds.cbBTC, CHAINLINK_FEEDS.cbBTC_USD);
  assert.equal(m.collateralFeeds.WETH, CHAINLINK_FEEDS.ETH_USD);
  assert.equal(m.permit2, PERMIT2);
  assert.deepEqual(SUPPORTED_CHAIN_IDS, [8453, 84532]);
});

test("CHAINS[84532] is the Base Sepolia addendum of VERIFIED-BASE-FACTS (read 2026-09-07) — Aave, the three reserves, the three feeds, Pyth", () => {
  const s = CHAINS[84532];
  assert.equal(s.id, 84532);
  assert.equal(s.aave.poolAddressesProvider, "0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00");
  assert.equal(s.aave.pool, "0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27");
  assert.equal(s.aave.poolDataProvider, "0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b");
  assert.equal(s.aave.oracle, "0x943b0dE18d4abf4eF02A85912F8fc07684C141dF");
  assert.equal(s.tokens.USDC?.address, "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f", "Aave's test USDC, not Circle's");
  assert.equal(s.tokens.WETH?.address, "0x4200000000000000000000000000000000000006");
  assert.equal(s.tokens.cbBTC?.address, "0x54114591963CF60EF3aA63bEfD6eC263D98145a4", "WBTC stands in under the cbBTC role");
  assert.equal(s.tokens.cbBTC?.decimals, 8);
  assert.equal(s.tokens.cbZEC, null, "a deploy-time double");
  assert.equal(s.tokens.AERO, null, "a deploy-time double");
  assert.equal(s.feeds.BTC_USD.address, "0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298");
  assert.equal(s.feeds.ETH_USD.address, "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1");
  assert.equal(s.feeds.USDC_USD.address, "0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165");
  assert.equal(s.feeds.cbBTC_USD, null, "no cbBTC/USD feed on Sepolia");
  assert.equal(s.collateralFeeds.cbBTC, s.feeds.BTC_USD, "the stand-in is priced by BTC/USD");
  assert.equal(s.pyth, "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729");
  assert.equal(s.permit2, PERMIT2, "same address on both chains");
  assert.equal(s.morphoBlue, CHAINS[8453].morphoBlue, "same address, a different owner and no market — the table says nothing else");
  assert.ok(s.notes.some((n) => /proves NOTHING about the live MaxFi\/Snuggle engine/.test(n)));
});

test("every Sepolia address is EIP-55 checksummed; none is a mainnet address except the shared infrastructure", () => {
  const s = CHAINS[84532];
  const m = CHAINS[8453];
  const addrs: [string, string][] = [
    ["aave.poolAddressesProvider", s.aave.poolAddressesProvider],
    ["aave.pool", s.aave.pool],
    ["aave.poolDataProvider", s.aave.poolDataProvider],
    ["aave.oracle", s.aave.oracle],
    ["USDC", s.tokens.USDC!.address],
    ["cbBTC", s.tokens.cbBTC!.address],
    ["BTC_USD", s.feeds.BTC_USD.address],
    ["ETH_USD", s.feeds.ETH_USD.address],
    ["USDC_USD", s.feeds.USDC_USD.address],
    ["pyth", s.pyth],
  ];
  for (const [name, a] of addrs) assert.ok(isChecksumAddress(a), `${name} ${a} must be checksummed`);
  const mainnet = new Set([m.aave.pool, m.aave.poolAddressesProvider, m.aave.poolDataProvider, m.aave.oracle, m.tokens.USDC!.address, m.tokens.cbBTC!.address, m.feeds.BTC_USD.address, m.feeds.ETH_USD.address, m.feeds.USDC_USD.address, m.pyth].map((x) => x.toLowerCase()));
  for (const [name, a] of addrs) assert.ok(!mainnet.has(a.toLowerCase()), `${name} must not be a mainnet address`);
  assert.equal(s.tokens.WETH!.address, m.tokens.WETH!.address, "the OP-stack predeploy is the same everywhere");
  assert.equal(s.multicall3, m.multicall3);
});

test("chainTable resolves numbers and decimal strings and throws UnsupportedChainError by name for anything else", () => {
  assert.equal(chainTable(8453).id, 8453);
  assert.equal(chainTable("84532").id, 84532);
  for (const bad of [1, 0, -1, "foo", undefined, null, "8453x", 10]) {
    assert.throws(() => chainTable(bad as never), (e: unknown) => e instanceof UnsupportedChainError && /address tables for 8453, 84532 only/.test((e as Error).message));
  }
  assert.equal(isSupportedChainId(84532), true);
  assert.equal(isSupportedChainId("84532"), false);
});

test("resolveTokens: mainnet needs nothing and refuses an override for a pinned token; Sepolia requires cbZEC and AERO by variable name and checksums what it is given", () => {
  const m = resolveTokens(CHAINS[8453], {}, variable);
  assert.equal(m.USDC, BASE_TOKENS.USDC);
  assert.equal(m.cbZEC, BASE_TOKENS.cbZEC);
  assert.throws(() => resolveTokens(CHAINS[8453], { USDC: "0x1111111111111111111111111111111111111111" }, variable), (e: unknown) => e instanceof PinnedChainAddressError && /USDC_ADDRESS is set, but USDC on chain 8453 is pinned/.test((e as Error).message));
  assert.throws(() => resolveTokens(CHAINS[84532], {}, variable), (e: unknown) => e instanceof MissingChainAddressError && /no cbZEC address for chain 84532/.test((e as Error).message) && (e as MissingChainAddressError).variable === "CBZEC_ADDRESS");
  assert.throws(() => resolveTokens(CHAINS[84532], { cbZEC: "0x1111111111111111111111111111111111111111" }, variable), (e: unknown) => e instanceof MissingChainAddressError && (e as MissingChainAddressError).variable === "AERO_ADDRESS");
  const s = resolveTokens(CHAINS[84532], { cbZEC: "0x1111111111111111111111111111111111111111", AERO: "0x2222222222222222222222222222222222222222" }, variable);
  assert.equal(s.cbBTC.address, "0x54114591963CF60EF3aA63bEfD6eC263D98145a4");
  assert.equal(s.cbZEC.address, "0x1111111111111111111111111111111111111111");
  assert.equal(s.cbZEC.kind, "b20", "the double keeps the role's semantics (MockB20)");
  assert.match(s.cbZEC.name, /double on Base Sepolia/);
  assert.throws(() => resolveTokens(CHAINS[84532], { cbZEC: "not-an-address", AERO: "0x2222222222222222222222222222222222222222" }, variable));
});

test("collateralAssetsFor: 8453 is COLLATERAL_ASSETS itself; on 84532 cbBTC is WBTC priced by BTC/USD at the Sepolia data provider, cbZEC's Pyth is the Sepolia proxy, policy rows unchanged", () => {
  assert.equal(collateralAssetsFor(CHAINS[8453], BASE_TOKENS), COLLATERAL_ASSETS);
  const tokens = resolveTokens(CHAINS[84532], { cbZEC: "0x1111111111111111111111111111111111111111", AERO: "0x2222222222222222222222222222222222222222" }, variable);
  const c = collateralAssetsFor(CHAINS[84532], tokens);
  assert.equal(c.cbBTC.address, "0x54114591963CF60EF3aA63bEfD6eC263D98145a4");
  assert.equal(c.cbBTC.venueDataSource, CHAINS[84532].aave.poolDataProvider);
  assert.deepEqual(c.cbBTC.feed, { kind: "chainlink", description: "BTC / USD", address: "0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298", decimals: 8 });
  assert.equal(c.WETH.feed.kind === "chainlink" ? c.WETH.feed.address : null, "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1");
  assert.equal(c.cbZEC.address, "0x1111111111111111111111111111111111111111");
  assert.equal(c.cbZEC.feed.kind === "pyth" ? c.cbZEC.feed.contract : null, CHAINS[84532].pyth);
  assert.equal(c.cbZEC.enabled, false);
  assert.equal(c.cbBTC.riskNotes, COLLATERAL_ASSETS.cbBTC.riskNotes);
});
