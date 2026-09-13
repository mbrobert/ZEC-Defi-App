/**
 * The Kamino sample the tests decode from the two mainnet captures: reserves + Scope at slot 446,506,191
 * (2026-09-12), the LendingMarket at slot 446,591,426 (2026-09-13). Read-only bytes; never edited.
 */
import { readFileSync } from "node:fs";
import { KAMINO_ZCASH_MARKET } from "@zyo/shared";
import { decodeKaminoMarket, decodeKaminoReserve, decodeScopePrice, type KaminoSample } from "../../src/sources/kamino.js";

const here = new URL(".", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/solana-mainnet-2026-09-12.json", here), "utf8")) as {
  slot: number;
  blockTime: number;
  accounts: Record<string, { address: string; owner: string; dataBase64: string }>;
};
const marketFixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/solana-lending-market-2026-09-13.json", here), "utf8")) as {
  slot: number;
  blockTime: number;
  account: { address: string; owner: string; dataBase64: string };
};

export const FIXTURE_SLOT = fixture.slot;
export const FIXTURE_BLOCK_TIME = fixture.blockTime;
export const MARKET_FIXTURE_SLOT = marketFixture.slot;
export const bytes = (k: string): Buffer => Buffer.from(fixture.accounts[k]!.dataBase64, "base64");
export const marketBytes = (): Buffer => Buffer.from(marketFixture.account.dataBase64, "base64");
export const fixtureOwner = (k: string): string => fixture.accounts[k]!.owner;

/** A sample as `KaminoSource.sample()` would have returned it at the capture's slot. */
export function kaminoSampleFixture(nowMs: number): KaminoSample {
  const zec = decodeKaminoReserve(bytes("zecReserve"), { address: KAMINO_ZCASH_MARKET.reserves.ZEC.address, symbol: "ZEC" });
  const usdc = decodeKaminoReserve(bytes("usdcReserve"), { address: KAMINO_ZCASH_MARKET.reserves.USDC.address, symbol: "USDC" });
  const scope = bytes("scopePrices");
  return {
    sampledAt: new Date(nowMs).toISOString(),
    slot: fixture.slot,
    chainTimeS: fixture.blockTime,
    market: decodeKaminoMarket(marketBytes(), marketFixture.account.address),
    zec,
    usdc,
    scopeZec: decodeScopePrice(scope, zec.scopePriceChain0),
    scopeUsdc: decodeScopePrice(scope, usdc.scopePriceChain0),
    source: "solana-rpc",
  };
}

/** The same sample with the USDC pool set to the facts file's projection-table row (2026-09-12 00:57 UTC read). */
export function withFactsPool(s: KaminoSample): KaminoSample {
  const SF = 1n << 60n;
  const borrowed = 442_516_970_000n; // 442,516.97 USDC
  return { ...s, usdc: { ...s.usdc, availableUnits: 358_198_990_000n, borrowedUnits: borrowed, borrowedSf: borrowed * SF } };
}
