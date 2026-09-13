/**
 * The Kamino decoders against the mainnet captures: every number VERIFIED-SOLANA-FACTS.md recorded comes back
 * from the raw offsets, and a buffer of the wrong size, discriminator, market, mint or Scope chain is refused.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { KAMINO_ZCASH_MARKET, KAMINO_ZCASH_SNAPSHOT_2026_09_12, SOLANA_PROGRAMS, SOLANA_TOKENS, kaminoCurveAprBps } from "@zyo/shared";
import { decodeKaminoMarket, decodeKaminoReserve, decodeScopePrice, KaminoDecodeError, KaminoSource, KLEND_DISCRIMINATOR, KLEND_MARKET_LEN, KLEND_RESERVE_LEN, pubkeyBase58, SCOPE_PRICES_LEN } from "../src/sources/kamino.js";
import { bytes, fixtureOwner, FIXTURE_BLOCK_TIME, FIXTURE_SLOT, kaminoSampleFixture, marketBytes } from "./fixtures/kamino.js";

const ZEC = { address: KAMINO_ZCASH_MARKET.reserves.ZEC.address, symbol: "ZEC" as const };
const USDC = { address: KAMINO_ZCASH_MARKET.reserves.USDC.address, symbol: "USDC" as const };

test("the fixture is what it says: klend-owned reserves and market, Scope-owned prices, the documented sizes", () => {
  assert.equal(fixtureOwner("zecReserve"), SOLANA_PROGRAMS.klend);
  assert.equal(fixtureOwner("usdcReserve"), SOLANA_PROGRAMS.klend);
  assert.equal(fixtureOwner("scopePrices"), SOLANA_PROGRAMS.scope);
  assert.equal(bytes("zecReserve").length, KLEND_RESERVE_LEN);
  assert.equal(bytes("scopePrices").length, SCOPE_PRICES_LEN);
  assert.equal(marketBytes().length, KLEND_MARKET_LEN);
  // anchor discriminators are sha256("account:<Name>")[..8]; the captures carry them
  assert.deepEqual([...bytes("zecReserve").subarray(0, 8)], [...createHash("sha256").update("account:Reserve").digest().subarray(0, 8)]);
  assert.deepEqual([...marketBytes().subarray(0, 8)], [...KLEND_DISCRIMINATOR.lendingMarket]);
  assert.deepEqual([...marketBytes().subarray(0, 8)], [246, 114, 50, 98, 72, 157, 28, 120]);
});

test("the ZEC reserve decodes to the facts file: LTV 40 / LT 65, 13,000 ZEC deposit limit, no borrowing, 3,000 ZEC per day withdrawal cap, Scope 430/429, $400–$2,000 band, 180/240 s ages", () => {
  const r = decodeKaminoReserve(bytes("zecReserve"), ZEC);
  assert.equal(r.lendingMarket, KAMINO_ZCASH_MARKET.lendingMarket);
  assert.equal(r.liquidityMint, SOLANA_TOKENS.ZEC.mint);
  assert.equal(r.mintDecimals, 8);
  assert.equal(r.status, 0);
  assert.equal(r.loanToValuePct, KAMINO_ZCASH_SNAPSHOT_2026_09_12.zec.loanToValuePct);
  assert.equal(r.liquidationThresholdPct, KAMINO_ZCASH_SNAPSHOT_2026_09_12.zec.liquidationThresholdPct);
  assert.equal(r.borrowFactorPct, 150);
  assert.equal(r.depositLimitUnits, 1_300_000_000_000n);
  assert.equal(r.borrowLimitUnits, 0n);
  assert.equal(r.borrowedUnits, 0n);
  assert.equal(r.availableUnits, 120_260_719_100n, "1,202.607 ZEC supplied at slot 446,506,191");
  assert.equal(r.collateralTotalSupply, r.availableUnits, "cToken exchange rate 1:1 while nothing is lent out of it");
  assert.deepEqual(r.depositWithdrawalCap, { configCapacity: 300_000_000_000n, currentTotal: -11_101_606_145n, lastIntervalStartTimestamp: r.depositWithdrawalCap.lastIntervalStartTimestamp, configIntervalLengthSeconds: 86_400n });
  assert.equal(r.debtWithdrawalCap.configCapacity, 0n);
  assert.equal(r.utilizationLimitBlockBorrowingAbovePct, 0);
  assert.equal(r.scopePriceChain0, 430);
  assert.equal(r.scopeTwapChain0, 429);
  assert.equal(r.scopePriceFeed, KAMINO_ZCASH_MARKET.scopeOraclePrices);
  assert.equal(r.heuristicLowerUsd, 400);
  assert.equal(r.heuristicUpperUsd, 2000);
  assert.equal(r.maxTwapDivergenceBps, 1000);
  assert.equal(r.maxAgePriceSeconds, 180);
  assert.equal(r.maxAgeTwapSeconds, 240);
  assert.deepEqual(r.borrowRateCurve, [[0, 1000], [10_000, 1000]], "flat 10 % — moot, ZEC is not borrowable");
  assert.equal(r.lastUpdatePriceStatus, 63);
});

test("the USDC reserve decodes to the facts file: the five-point curve, 2 M limits, 1 M per day caps, Scope 13/456, $0.98–$1.02 band, 6 decimals", () => {
  const r = decodeKaminoReserve(bytes("usdcReserve"), USDC);
  assert.equal(r.liquidityMint, SOLANA_TOKENS.USDC.mint);
  assert.equal(r.mintDecimals, 6);
  assert.equal(r.loanToValuePct, 0);
  assert.equal(r.liquidationThresholdPct, 0);
  assert.equal(r.borrowFactorPct, 100);
  assert.deepEqual(r.borrowRateCurve, KAMINO_ZCASH_SNAPSHOT_2026_09_12.usdc.borrowRateCurve.map((p) => [...p]));
  assert.equal(r.depositLimitUnits, 2_000_000_000_000n);
  assert.equal(r.borrowLimitUnits, 2_000_000_000_000n);
  assert.equal(r.debtWithdrawalCap.configCapacity, 1_000_000_000_000n);
  assert.equal(r.debtWithdrawalCap.configIntervalLengthSeconds, 86_400n);
  assert.equal(r.debtWithdrawalCap.currentTotal, 3_622_993_258n, "3,622.99 USDC net borrowed in the window at the capture");
  assert.equal(r.availableUnits, 355_599_950_997n);
  assert.equal(r.borrowedUnits, 446_186_304_801n, "floor(borrowedAmountSf / 2^60) = 446,186.30 USDC");
  assert.equal(r.borrowedSf, 514_417_785_866_375_382_064_880_048_244n);
  assert.equal(r.scopePriceChain0, 13);
  assert.equal(r.scopeTwapChain0, 456);
  assert.equal(r.heuristicLowerUsd, 0.98);
  assert.equal(r.heuristicUpperUsd, 1.02);
  assert.equal(r.maxTwapDivergenceBps, 300);
  // the curve at the capture's utilisation, the same arithmetic the facts file's projection table used
  const util = Math.round((Number(r.borrowedUnits) / Number(r.availableUnits + r.borrowedUnits)) * 10_000);
  assert.equal(util, 5565, "55.65 % utilisation at the capture");
  assert.ok(Math.abs(kaminoCurveAprBps(r.borrowRateCurve, util) / 100 - 3.4199) < 0.001, "279 + 446 × 565/4000 bps ≈ 3.42 %");
});

test("the market decodes to the facts file: owned by A11E…, not in emergency mode, borrowing enabled", () => {
  const m = decodeKaminoMarket(marketBytes(), KAMINO_ZCASH_MARKET.lendingMarket);
  assert.equal(m.owner, KAMINO_ZCASH_MARKET.lendingMarketOwner);
  assert.equal(m.emergencyMode, 0);
  assert.equal(m.borrowDisabled, 0);
  assert.equal(m.autodeleverageEnabled, 0);
});

test("Scope entries 430 and 13 decode to a ZEC price inside the reserve's band and a dollar, both fresh at the capture", () => {
  const s = bytes("scopePrices");
  const zec = decodeScopePrice(s, 430);
  const usdc = decodeScopePrice(s, 13);
  assert.ok(zec.priceUsd > 400 && zec.priceUsd < 2000, `ZEC $${zec.priceUsd}`);
  assert.ok(Math.abs(usdc.priceUsd - 1) < 0.01, `USDC $${usdc.priceUsd}`);
  const age = FIXTURE_BLOCK_TIME - Number(zec.unixTimestamp);
  assert.ok(age >= 0 && age <= 180, `ZEC price age ${age}s at slot ${FIXTURE_SLOT}`);
  assert.equal(zec.exp, 8);
});

test("base58 of a 32-byte key round-trips the known addresses", () => {
  const b = marketBytes().subarray(24, 56);
  assert.equal(pubkeyBase58(b), KAMINO_ZCASH_MARKET.lendingMarketOwner);
  assert.equal(pubkeyBase58(Buffer.alloc(32)), "1".repeat(32));
  assert.throws(() => pubkeyBase58(Buffer.alloc(31)), KaminoDecodeError);
});

test("refusals: the wrong size, discriminator, market, mint or Scope chain is never misread", () => {
  assert.throws(() => decodeKaminoReserve(bytes("zecReserve").subarray(0, 100), ZEC), /8624/);
  const bad = Buffer.from(bytes("zecReserve"));
  bad[0] ^= 1;
  assert.throws(() => decodeKaminoReserve(bad, ZEC), /discriminator/);
  assert.throws(() => decodeKaminoReserve(bytes("zecReserve"), USDC), /mint .* is not USDC's/);
  const otherMarket = Buffer.from(bytes("zecReserve"));
  otherMarket[32] ^= 1;
  assert.throws(() => decodeKaminoReserve(otherMarket, ZEC), /not the ZCASH market/);
  const wrongChain = Buffer.from(bytes("zecReserve"));
  wrongChain.writeUInt16LE(431, 5144);
  assert.throws(() => decodeKaminoReserve(wrongChain, ZEC), /Scope chain 431/);
  assert.throws(() => decodeKaminoMarket(marketBytes(), KAMINO_ZCASH_MARKET.reserves.ZEC.address), /not the ZCASH market/);
  assert.throws(() => decodeScopePrice(bytes("scopePrices"), 512), /out of range/);
  assert.throws(() => decodeScopePrice(Buffer.alloc(100), 430), /28712/);
});

test("KaminoSource.sample: one getMultipleAccounts + one getBlockTime, owners checked, a foreign owner refused", async () => {
  const calls: string[] = [];
  const accounts = (owners: Record<string, string>) => [
    { data: [marketBytes().toString("base64"), "base64"], owner: owners.market ?? SOLANA_PROGRAMS.klend, executable: false, lamports: 1 },
    { data: [bytes("zecReserve").toString("base64"), "base64"], owner: SOLANA_PROGRAMS.klend, executable: false, lamports: 1 },
    { data: [bytes("usdcReserve").toString("base64"), "base64"], owner: SOLANA_PROGRAMS.klend, executable: false, lamports: 1 },
    { data: [bytes("scopePrices").toString("base64"), "base64"], owner: owners.scope ?? SOLANA_PROGRAMS.scope, executable: false, lamports: 1 },
  ];
  const fetchFor = (owners: Record<string, string>): typeof fetch =>
    (async (_url: unknown, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
      calls.push(req.method);
      const result = req.method === "getMultipleAccounts" ? { context: { slot: FIXTURE_SLOT }, value: accounts(owners) } : req.method === "getBlockTime" ? FIXTURE_BLOCK_TIME : null;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: req.id, result }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
  const src = new KaminoSource("http://rpc.test", () => 1_700_000_000_000, { fetchImpl: fetchFor({}), retries: 0 });
  const s = await src.sample();
  assert.deepEqual(calls, ["getMultipleAccounts", "getBlockTime"]);
  assert.equal(s.slot, FIXTURE_SLOT);
  assert.equal(s.chainTimeS, FIXTURE_BLOCK_TIME);
  assert.equal(s.usdc.borrowRateCurve.length, 5);
  assert.equal(s.scopeZec.index, 430);
  const expected = kaminoSampleFixture(1_700_000_000_000);
  assert.deepEqual(s.usdc, expected.usdc);
  assert.deepEqual(s.market, expected.market);
  const spoofed = new KaminoSource("http://rpc.test", () => 0, { fetchImpl: fetchFor({ scope: SOLANA_PROGRAMS.klend }), retries: 0 });
  await assert.rejects(spoofed.sample(), /scope: owned by/);
});
