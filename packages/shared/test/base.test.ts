import { test } from "node:test";
import assert from "node:assert/strict";
import * as shared from "../dist/index.js";
import {
  CHAIN_ID,
  BASE_CHAIN_ID,
  BASE_TOKENS,
  BORROW_ASSET,
  AAVE_V3,
  AAVE_V3_RESERVES,
  CHAINLINK_FEEDS,
  CHAINLINK_ZEC_USD,
  PYTH,
  AERODROME,
  MORPHO_BLUE,
  COMPOUND_V3,
  PERMIT2,
  COW_PROTOCOL,
  CBZEC_ADDRESS,
  COUNTERFEIT_PREFIX,
  classifyCbZecAddress,
  isCounterfeitCbZec,
  isGenuineCbZec,
  allVerifiedAddresses,
  toChecksumAddress,
  isChecksumAddress,
} from "../dist/index.js";

test("chain id is Base mainnet", () => {
  assert.equal(CHAIN_ID, 8453);
  assert.equal(BASE_CHAIN_ID, 8453);
});

test("token table matches VERIFIED-BASE-FACTS (address + decimals)", () => {
  assert.equal(BASE_TOKENS.USDC.address, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(BASE_TOKENS.USDC.decimals, 6);
  assert.equal(BASE_TOKENS.WETH.address, "0x4200000000000000000000000000000000000006");
  assert.equal(BASE_TOKENS.WETH.decimals, 18);
  assert.equal(BASE_TOKENS.cbBTC.address, "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf");
  assert.equal(BASE_TOKENS.cbBTC.decimals, 8);
  assert.equal(BASE_TOKENS.cbZEC.address, "0xB2000000000000000000008501b13360000cb2EC");
  assert.equal(BASE_TOKENS.cbZEC.decimals, 8);
  assert.equal(BASE_TOKENS.cbZEC.kind, "b20");
  assert.equal(BASE_TOKENS.AERO.address, "0x940181a94A35A4569E4529A3CDfB74e38FD98631");
  assert.equal(BASE_TOKENS.AERO.decimals, 18);
  assert.equal(BORROW_ASSET, "USDC");
  for (const t of Object.values(BASE_TOKENS)) {
    assert.equal(t.symbol in BASE_TOKENS, true);
    assert.ok(Number.isInteger(t.decimals) && t.decimals > 0 && t.decimals <= 18);
  }
});

test("Aave v3 addresses and no typed risk parameters", () => {
  assert.equal(AAVE_V3.poolAddressesProvider, "0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D");
  assert.equal(AAVE_V3.pool, "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5");
  assert.equal(AAVE_V3.poolDataProvider.toLowerCase(), "0x0f43731eb8d45a581f4a36dd74f5f358bc90c73a");
  assert.equal(AAVE_V3.oracle, "0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156");
  assert.deepEqual([...AAVE_V3_RESERVES], ["cbBTC", "WETH", "USDC"]);
  // the whole point: LT / LTV are read from chain, never typed
  const json = JSON.stringify(AAVE_V3).toLowerCase();
  for (const forbidden of ["ltv", "liquidationthreshold", "7800", "8300", "7300", "8000"]) {
    assert.equal(json.includes(forbidden), false, `AAVE_V3 must not carry ${forbidden}`);
  }
});

test("Chainlink feeds, Pyth, Aerodrome, Morpho, Compound, Permit2, CoW", () => {
  assert.equal(CHAINLINK_FEEDS.BTC_USD.address, "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F");
  assert.equal(CHAINLINK_FEEDS.ETH_USD.address, "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70");
  assert.equal(CHAINLINK_FEEDS.USDC_USD.address, "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B");
  assert.equal(CHAINLINK_FEEDS.cbBTC_USD.address, "0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D");
  assert.equal(CHAINLINK_ZEC_USD, null);
  assert.equal(PYTH.contract, "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a");
  assert.equal(PYTH.priceIds.ZEC_USD, "0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24");
  assert.match(PYTH.priceIds.ZEC_USD, /^0x[0-9a-f]{64}$/);
  assert.equal(AERODROME.voter, "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5");
  assert.equal(AERODROME.pools.cbZEC_USDC.address, "0x0Fc47C17AF86078d809358db1b4db2DeBC988566");
  assert.equal(AERODROME.pools.cbZEC_USDC.gauge.toLowerCase(), "0x8779e34e5d38358b0cb957c553b40cc1208c81fb");
  assert.equal(AERODROME.pools.cbZEC_USDC.token0, "USDC");
  assert.equal(AERODROME.pools.cbZEC_USDC.token1, "cbZEC");
  assert.equal(AERODROME.pools.cbZEC_USDC.feePips, 2000);
  assert.equal(AERODROME.pools.cbZEC_USDC.tickSpacing, 200);
  assert.equal(MORPHO_BLUE.address, "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
  assert.equal(
    MORPHO_BLUE.marketIds.cbBTC_USDC,
    "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
    "chain-verified 2026-09-07 (VERIFIED-BASE-FACTS, Morpho addendum)",
  );
  assert.equal(MORPHO_BLUE.marketIds.WETH_USDC, "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda");
  assert.equal(MORPHO_BLUE.lltvWad, 860000000000000000n);
  assert.equal(COMPOUND_V3.usdcComet, "0xb125E6687d4313864e53df431d5425969c15Eb2F");
  assert.equal(PERMIT2, "0x000000000022D473030F116dDEE9F6B43aC78BA3");
  assert.equal(COW_PROTOCOL.settlement, "0x9008D19f58AAbD9eD0D60971565AA8510560ab41");
  assert.equal(COW_PROTOCOL.vaultRelayer, null, "relayer is not in VERIFIED-BASE-FACTS");
});

test("every address constant is EIP-55 checksummed and unique", () => {
  const all = allVerifiedAddresses();
  assert.equal(Object.keys(all).length, 24);
  const seen = new Set<string>();
  for (const [key, addr] of Object.entries(all)) {
    assert.equal(isChecksumAddress(addr), true, `${key} = ${addr} is not checksummed`);
    assert.equal(toChecksumAddress(addr), addr, key);
    assert.equal(seen.has(addr.toLowerCase()), false, `${key} duplicates another constant`);
    seen.add(addr.toLowerCase());
  }
});

test("counterfeit detection pins the real cbZEC and flags every other 0xb2000 address", () => {
  assert.equal(COUNTERFEIT_PREFIX, "0xb2000");
  assert.equal(CBZEC_ADDRESS, BASE_TOKENS.cbZEC.address);
  assert.equal(classifyCbZecAddress(CBZEC_ADDRESS), "genuine");
  assert.equal(classifyCbZecAddress(CBZEC_ADDRESS.toLowerCase()), "genuine");
  assert.equal(classifyCbZecAddress("0x" + CBZEC_ADDRESS.slice(2).toUpperCase()), "genuine");
  assert.equal(isGenuineCbZec(CBZEC_ADDRESS), true);
  // one nibble off → counterfeit
  const oneOff = CBZEC_ADDRESS.slice(0, -1) + (CBZEC_ADDRESS.endsWith("C") ? "D" : "C");
  assert.equal(classifyCbZecAddress(oneOff), "counterfeit");
  assert.equal(isCounterfeitCbZec(oneOff), true);
  assert.equal(isGenuineCbZec(oneOff), false);
  for (const fake of [
    "0xb200000000000000000000000000000000000000",
    "0xB2000000000000000000008501b13360000cb2Ed",
    "0xb20000000000000000000000000000000000dead",
    "0xB20001111111111111111111111111111111beef",
  ]) {
    assert.equal(isCounterfeitCbZec(fake), true, fake);
  }
  // legit non-cbZEC addresses are unrelated, not counterfeit
  assert.equal(classifyCbZecAddress(PERMIT2), "unrelated");
  assert.equal(classifyCbZecAddress(BASE_TOKENS.cbBTC.address), "unrelated");
  assert.equal(isCounterfeitCbZec(BASE_TOKENS.USDC.address), false);
  // 0xb2001… does not share the prefix (prefix is 0xb2000)
  assert.equal(classifyCbZecAddress("0xb2001000000000000000000000000000000000000"), "invalid"); // 41 chars
  assert.equal(classifyCbZecAddress("0xb200100000000000000000000000000000000000"), "unrelated");
  // garbage
  assert.equal(classifyCbZecAddress("0xb2000"), "invalid");
  assert.equal(classifyCbZecAddress(null), "invalid");
  assert.equal(isCounterfeitCbZec(undefined), false);
});

test("no NEAR / Rhea / 1-Click / Zcash-address exports survive", () => {
  const names = Object.keys(shared);
  const banned = /^(ONE_CLICK|INTENTS_|RHEA|ZCASH_|classifyZcash|describeZcash|WALLET_SHIELD|ZEC_DECIMALS|PLATFORM_FEE)/;
  for (const n of names) assert.doesNotMatch(n, banned, `leaked export ${n}`);
  // and the whole surface has no NEAR-ish strings in its values
  const dump = JSON.stringify(Object.fromEntries(names.filter((n) => typeof (shared as any)[n] !== "function").map((n) => [n, (shared as any)[n]])), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  // case-sensitive on purpose: "near-zero IL" in a pool description is fine, "NEAR" / "Rhea" are not
  assert.equal(/\bNEAR\b|\bRhea\b|1-Click|chaindefuser|nep141|omft\.near|\bzs1[a-z0-9]|"t[13][a-zA-Z0-9]{33}"/.test(dump), false, "value mentions the NEAR leg");
});
