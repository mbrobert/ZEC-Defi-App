// The Solana addresses seam: generated/addresses.rs must equal @zyo/shared's solana.ts, key for key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { KAMINO_ZCASH_MARKET, SOLANA_PROGRAMS, SOLANA_TOKENS } from "@zyo/shared";

const here = dirname(fileURLToPath(import.meta.url));
const rs = readFileSync(join(here, "..", "programs", "oilskin", "src", "generated", "addresses.rs"), "utf8");
const key = (name) => {
  const m = rs.match(new RegExp(`pub const ${name}: Pubkey = pubkey!\\("([1-9A-HJ-NP-Za-km-z]+)"\\);`));
  assert.ok(m, `${name} missing from addresses.rs`);
  return m[1];
};

test("programs, market, reserves, vaults and mints are shared's, nothing retyped", () => {
  assert.equal(key("KLEND_PROGRAM"), SOLANA_PROGRAMS.klend);
  assert.equal(key("SCOPE_PROGRAM"), SOLANA_PROGRAMS.scope);
  assert.equal(key("FARMS_PROGRAM"), SOLANA_PROGRAMS.farms);
  assert.equal(key("ZCASH_LENDING_MARKET"), KAMINO_ZCASH_MARKET.lendingMarket);
  assert.equal(key("SCOPE_ORACLE_PRICES"), KAMINO_ZCASH_MARKET.scopeOraclePrices);
  const r = KAMINO_ZCASH_MARKET.reserves;
  assert.equal(key("ZEC_MINT"), SOLANA_TOKENS.ZEC.mint);
  assert.equal(key("ZEC_RESERVE"), r.ZEC.address);
  assert.equal(key("ZEC_LIQUIDITY_SUPPLY"), r.ZEC.liquiditySupplyVault);
  assert.equal(key("ZEC_COLLATERAL_MINT"), r.ZEC.collateralMint);
  assert.equal(key("ZEC_COLLATERAL_SUPPLY"), r.ZEC.collateralSupplyVault);
  assert.equal(key("USDC_MINT"), SOLANA_TOKENS.USDC.mint);
  assert.equal(key("USDC_RESERVE"), r.USDC.address);
  assert.equal(key("USDC_LIQUIDITY_SUPPLY"), r.USDC.liquiditySupplyVault);
  assert.equal(key("USDC_FEE_VAULT"), r.USDC.liquidityFeeVault);
  assert.match(rs, new RegExp(`ZEC_SCOPE_PRICE_INDEX: u16 = ${r.ZEC.scopePriceChain[0]};`));
  assert.match(rs, /ZEC_DECIMALS: u8 = 8;/);
  assert.match(rs, /USDC_DECIMALS: u8 = 6;/);
});

test("the generator's --check agrees", () => {
  const outp = execFileSync(process.execPath, [join(here, "..", "scripts", "gen-addresses.mjs"), "--check"], { encoding: "utf8" });
  assert.match(outp, /addresses seam OK/);
});

test("no LTV, threshold or rate constant exists in the generated addresses (those are read live)", () => {
  const consts = rs.split("\n").filter((l) => l.startsWith("pub const ")).join("\n");
  assert.doesNotMatch(consts, /LTV|THRESHOLD|APR|RATE_BPS/);
});
