import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { KAMINO_ZCASH_MARKET } from "@zyo/shared";
import {
  PK,
  SF_ONE,
  USDC_SCOPE_INDEX,
  ZEC_SCOPE_INDEX,
  ctokensToLiquidity,
  decodeObligation,
  decodeReserve,
  decodeScopeEntry,
  ixKeeperProtect,
  ixRefreshObligation,
  ixRefreshReserve,
  lendingMarketAuthority,
  obligationPda,
  anchorErrorName,
} from "../src/solana/layouts.js";
import { bs58Disc } from "../src/solana/reader.js";
import { evaluateSolana, type SolanaSnapshot } from "../src/solana/valuation.js";

const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/solana/mainnet-2026-09-12.json", import.meta.url) /* compiled into dist/test/, the fixture stays in test/ */, "utf8"));
const bytes = (k: string) => Buffer.from(fixture.accounts[k].dataBase64, "base64");

test("the mainnet obligation decodes to the numbers the facts file recorded for the top borrower", () => {
  const ob = decodeObligation(bytes("obligationTopBorrower"));
  assert.equal(ob.lendingMarket.toBase58(), KAMINO_ZCASH_MARKET.lendingMarket);
  assert.equal(ob.depositReserves.length, 1);
  assert.equal(ob.depositReserves[0].toBase58(), KAMINO_ZCASH_MARKET.reserves.ZEC.address);
  assert.equal(ob.borrowReserves[0].toBase58(), KAMINO_ZCASH_MARKET.reserves.USDC.address);
  assert.equal(ob.hasDebt, true);
  // 612.15 ZEC deposited (cTokens, 8 dp) and ≈ $259,912 of USDC debt as of the facts read
  assert.ok(ob.zecDepositedCtokens > 600_00000000n && ob.zecDepositedCtokens < 620_00000000n, ob.zecDepositedCtokens.toString());
  const debt = ob.usdcBorrowedAmountSf / SF_ONE;
  assert.ok(debt > 259_000_000000n && debt < 262_000_000000n, debt.toString());
  // Kamino's own HF for that obligation: unhealthy / bf-adjusted debt ≈ 2.9 at its last refresh price
  const hf = Number((ob.unhealthyBorrowValueSf * 10_000n) / ob.borrowFactorAdjustedDebtValueSf) / 10_000;
  assert.ok(hf > 2 && hf < 4, String(hf));
});

test("the ZEC reserve decodes to LTV 40 / LT 65 / 8 decimals / Scope 430, and the USDC reserve to 6 decimals / Scope 13", () => {
  const zec = decodeReserve(bytes("zecReserve"));
  assert.equal(zec.loanToValuePct, 40);
  assert.equal(zec.liquidationThresholdPct, 65);
  assert.equal(zec.mintDecimals, 8);
  assert.equal(zec.scopePriceChain0, ZEC_SCOPE_INDEX);
  assert.equal(zec.scopePriceFeed.toBase58(), KAMINO_ZCASH_MARKET.scopeOraclePrices);
  assert.equal(zec.maxAgePriceSeconds, 180n);
  assert.equal(zec.status, 0);
  assert.equal(zec.liquidityMint.toBase58(), KAMINO_ZCASH_MARKET.reserves.ZEC.mint);
  const usdc = decodeReserve(bytes("usdcReserve"));
  assert.equal(usdc.mintDecimals, 6);
  assert.equal(usdc.scopePriceChain0, USDC_SCOPE_INDEX);
  // exchange rate: nothing is lent from the ZEC reserve, so cTokens redeem ≈ 1:1
  const one = ctokensToLiquidity(100_000_000n, zec);
  assert.ok(one >= 99_990_000n && one <= 100_010_000n, one.toString());
});

test("Scope entries 430 and 13 decode to a ZEC price in the reserve's $400–$2,000 band and a USDC price near $1", () => {
  const z = decodeScopeEntry(bytes("scopePrices"), ZEC_SCOPE_INDEX);
  assert.ok(z.priceUsd > 400 && z.priceUsd < 2000, String(z.priceUsd));
  assert.equal(z.exp, 8);
  const u = decodeScopeEntry(bytes("scopePrices"), USDC_SCOPE_INDEX);
  assert.ok(u.priceUsd > 0.98 && u.priceUsd < 1.02, String(u.priceUsd));
});

test("a wrong-sized or wrong-discriminator buffer is refused, never misread", () => {
  assert.throws(() => decodeObligation(bytes("zecReserve")), /not an Obligation/);
  assert.throws(() => decodeReserve(bytes("obligationTopBorrower")), /not a Reserve/);
  assert.throws(() => decodeScopeEntry(bytes("zecReserve"), 430), /not an OraclePrices/);
});

test("PDAs: the obligation of an Account is the klend PDA the program derives; the market authority is klend's", () => {
  const account = new PublicKey("74VYE88JRBuQ9PmbyqWLgZqeL6Qfqjww7drc7te6uPBY");
  const ob = obligationPda(account);
  assert.equal(ob.toBase58().length >= 32, true);
  assert.equal(PublicKey.isOnCurve(ob.toBytes()), false);
  assert.equal(PublicKey.isOnCurve(lendingMarketAuthority().toBytes()), false);
});

test("instruction encoders: klend refreshes and keeper_protect carry the program ids and the None placeholders the SDK uses", () => {
  const r = ixRefreshReserve(PK.zecReserve);
  assert.equal(r.programId.toBase58(), PK.klend.toBase58());
  assert.equal(r.keys.length, 6);
  assert.equal(r.keys[2].pubkey.toBase58(), PK.klend.toBase58(), "pyth = None → klend program id");
  assert.equal(r.keys[5].pubkey.toBase58(), PK.scopePrices.toBase58());
  const o = ixRefreshObligation(PK.zecReserve, [PK.zecReserve, PK.usdcReserve]);
  assert.equal(o.keys.length, 4);
  const k = PublicKey.default;
  const p = ixKeeperProtect({ program: k, keeper: k, account: k, grant: k, obligation: k, accountZec: k, accountUsdc: k }, 2, 1_500_000_000n, 100_000_000n);
  assert.equal(p.data.length, 25);
  assert.equal(p.data[8], 2);
  assert.equal(p.data.readBigUInt64LE(9), 1_500_000_000n);
  assert.equal(p.data.readBigUInt64LE(17), 100_000_000n);
  assert.equal(p.keys[0].isSigner, true, "keeper signs");
  assert.equal(p.keys[1].isWritable, true, "account is writable (klend lists the obligation owner writable)");
});

test("base58 of the UserAccount discriminator is what getProgramAccounts memcmp needs, and anchor errors are read by name", () => {
  assert.match(bs58Disc(Uint8Array.from([211, 33, 136, 16, 186, 110, 242, 127])), /^[1-9A-HJ-NP-Za-km-z]{10,12}$/);
  assert.equal(bs58Disc(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1])), "11111112");
  const errors = [{ code: 6020, name: "ProtectionIneffective" }];
  assert.equal(anchorErrorName(["Program log: AnchorError thrown in x. Error Code: RungNotCrossed. Error Number: 6016."], errors), "RungNotCrossed");
  assert.equal(anchorErrorName(["Program X failed: custom program error: 0x1784"], errors), "ProtectionIneffective");
  assert.equal(anchorErrorName(["nothing"], errors), null);
});

test("valuation from the mainnet bytes: refreshed-at-slot rules turn a cached view into UNKNOWN by name, never a number", () => {
  const ob = decodeObligation(bytes("obligationTopBorrower"));
  const zec = decodeReserve(bytes("zecReserve"));
  const usdc = decodeReserve(bytes("usdcReserve"));
  const snap: SolanaSnapshot = {
    slot: BigInt(fixture.slot),
    nowS: BigInt(fixture.blockTime),
    obligation: ob,
    zecReserve: zec,
    usdcReserve: usdc,
    scopeZec: decodeScopeEntry(bytes("scopePrices"), ZEC_SCOPE_INDEX),
    scopeUsdc: decodeScopeEntry(bytes("scopePrices"), USDC_SCOPE_INDEX),
    independent: null,
    accountUsdc: 0n,
    accountZec: 0n,
  };
  const v = evaluateSolana(snap, { priceMaxAgeS: 180, independentMaxAgeS: 120, oracleDeviationBps: 200, hfToleranceBps: 100, requireIndependent: true });
  assert.equal(v.kind, "UNKNOWN");
  if (v.kind === "UNKNOWN") {
    assert.ok(v.reasons.some((r) => r.startsWith("S1")), "the cached obligation is not refreshed at the fixture slot");
    assert.ok(v.reasons.some((r) => r.startsWith("S4")), "no independent price");
  }
});
