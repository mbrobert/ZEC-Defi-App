import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KAMINO_ZCASH_MARKET,
  KAMINO_ZCASH_SNAPSHOT_2026_09_12,
  KLEND_SEEDS,
  SOLANA_PROGRAMS,
  SOLANA_TOKENS,
  ZEC_MINT_AUTHORITY_SEEDS,
  kaminoCurveAprBps,
  maxOfferedLtvBps,
  maxOfferedLtvStopBps,
  entryHfForLtv,
  rungDropPct,
  liquidationDropPct,
} from "../dist/index.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function isBase58Pubkey(s: string): boolean {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return false;
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) return false;
    n = n * 58n + BigInt(v);
  }
  // Leading '1's encode leading zero bytes; the rest is the big-endian magnitude (0 → no bytes).
  const leadingOnes = s.match(/^1*/)![0].length;
  const magnitudeBytes = n === 0n ? 0 : Math.ceil(n.toString(16).length / 2);
  return leadingOnes + magnitudeBytes === 32;
}

test("every Solana address in shared decodes to exactly 32 bytes of base58", () => {
  const all: string[] = [
    ...Object.values(SOLANA_PROGRAMS),
    ...Object.values(SOLANA_TOKENS).flatMap((t) => [t.mint, t.mintAuthority, t.freezeAuthority ?? t.mint]),
    KAMINO_ZCASH_MARKET.lendingMarket,
    KAMINO_ZCASH_MARKET.lendingMarketOwner,
    KAMINO_ZCASH_MARKET.scopeOraclePrices,
    KAMINO_ZCASH_MARKET.scopeOracleMappings,
    ...Object.values(KAMINO_ZCASH_MARKET.reserves).flatMap((r) => [
      r.address,
      r.mint,
      r.liquiditySupplyVault,
      r.liquidityFeeVault,
      r.collateralMint,
      r.collateralSupplyVault,
    ]),
  ];
  for (const a of all) assert.ok(isBase58Pubkey(a), `${a} is not a 32-byte base58 key`);
  assert.ok(!isBase58Pubkey("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), "an EVM address must not pass");
});

test("the reserves point at the mints and the Scope indices the facts file recorded (2026-09-12)", () => {
  const { ZEC, USDC } = KAMINO_ZCASH_MARKET.reserves;
  assert.equal(ZEC.mint, SOLANA_TOKENS.ZEC.mint);
  assert.equal(USDC.mint, SOLANA_TOKENS.USDC.mint);
  assert.deepEqual(ZEC.scopePriceChain, [430]);
  assert.deepEqual(ZEC.scopeTwapChain, [429]);
  assert.deepEqual(USDC.scopePriceChain, [13]);
  assert.deepEqual(USDC.scopeTwapChain, [456]);
  assert.equal(KAMINO_ZCASH_SNAPSHOT_2026_09_12.scope.zecEntry, ZEC.scopePriceChain[0]);
  assert.deepEqual(KAMINO_ZCASH_SNAPSHOT_2026_09_12.scope.zecSources, [407, 428]);
});

test("the bridged ZEC mint has no freeze authority; USDC does; the mint authority seeds are recorded", () => {
  assert.equal(SOLANA_TOKENS.ZEC.freezeAuthority, null);
  assert.equal(SOLANA_TOKENS.ZEC.kind, "bridged");
  assert.equal(SOLANA_TOKENS.ZEC.decimals, 8);
  assert.equal(typeof SOLANA_TOKENS.USDC.freezeAuthority, "string");
  assert.equal(SOLANA_TOKENS.USDC.decimals, 6);
  assert.deepEqual([...ZEC_MINT_AUTHORITY_SEEDS], ["authority"]);
  assert.equal(KLEND_SEEDS.lendingMarketAuthority, "lma");
  assert.equal(KLEND_SEEDS.userMetadata, "user_meta");
});

test("shared carries no LTV, LT or rate for Solana outside the dated snapshot object", () => {
  const keys = Object.keys(KAMINO_ZCASH_MARKET.reserves.ZEC);
  for (const k of keys) assert.ok(!/ltv|threshold|rate|apr|apy/i.test(k), `reserve ref must not carry ${k}`);
});

test("the entry rule on Kamino's numbers: the 1.25 floor says 52 %, Kamino's own cap is 40 %, the offer is 40 % at HF 1.625", () => {
  const lt = KAMINO_ZCASH_SNAPSHOT_2026_09_12.zec.liquidationThresholdPct * 100;
  const venueLtv = KAMINO_ZCASH_SNAPSHOT_2026_09_12.zec.loanToValuePct * 100;
  assert.equal(maxOfferedLtvBps(lt), 5200);
  assert.equal(maxOfferedLtvStopBps(lt), 5200);
  const offered = Math.min(maxOfferedLtvStopBps(lt), venueLtv);
  assert.equal(offered, 4000);
  assert.equal(entryHfForLtv(lt, offered), 1.625);
  const drop = (id: "warn" | "repay" | "derisk" | "emergency") => Math.round(rungDropPct(id, lt, offered) * 10) / 10;
  // the floor's ladder (1.23 / 1.16 / 1.09 / 1.05) on a 1.625 entry — the Solana keeper reads the global table until the program carries the entry HF
  assert.equal(drop("warn"), 24.3);
  assert.equal(drop("repay"), 28.6);
  assert.equal(drop("derisk"), 32.9);
  assert.equal(drop("emergency"), 35.4);
  assert.equal(Math.round(liquidationDropPct(lt, offered) * 10) / 10, 38.5);
});

test("kaminoCurveAprBps reproduces the projection table in VERIFIED-SOLANA-FACTS.md", () => {
  const curve = KAMINO_ZCASH_SNAPSHOT_2026_09_12.usdc.borrowRateCurve;
  assert.equal(kaminoCurveAprBps(curve, 0), 119);
  assert.equal(kaminoCurveAprBps(curve, 5000), 279);
  assert.equal(kaminoCurveAprBps(curve, 9000), 725);
  assert.equal(kaminoCurveAprBps(curve, 10000), 3860);
  // 55.27 % utilisation → 3.378 %; 65.76 % → 4.547 % (crosses Base's 4.5469 %); 92.73 % → 11.674 %
  assert.equal(Math.round(kaminoCurveAprBps(curve, 5527) * 10) / 10, 337.8);
  assert.equal(Math.round(kaminoCurveAprBps(curve, 6576) * 10) / 10, 454.7);
  assert.equal(Math.round(kaminoCurveAprBps(curve, 9273) * 10) / 10, 1167.4);
  // padded terminal points (Kamino stores 11) are tolerated
  const padded = [...curve, [10000, 3860], [10000, 3860]] as const;
  assert.equal(kaminoCurveAprBps(padded, 9999), kaminoCurveAprBps(curve, 9999));
  assert.throws(() => kaminoCurveAprBps(curve, 10001), RangeError);
  assert.throws(() => kaminoCurveAprBps(curve, -1), RangeError);
  assert.throws(() => kaminoCurveAprBps(curve, 1.5), RangeError);
  assert.throws(() => kaminoCurveAprBps([], 0), RangeError);
});
