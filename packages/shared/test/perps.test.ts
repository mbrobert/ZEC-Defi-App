import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  CORE_ACTIONS,
  CORE_SPOT_DEX,
  CORE_TIF,
  HYPERCORE_PRECOMPILES,
  HYPERLIQUID,
  MAX_LADDER_ENTRY_DISTANCE_BPS,
  MAX_SHORT_DISTANCE_BPS,
  PERP_MARGIN_MARKS,
  PROPOSED_PERP_ENTRY_FLOOR_MARGIN_BPS,
  PrecompileDecodeError,
  accountValueForDistanceE6,
  annualisedFundingPct,
  decodeAccountMarginSummary,
  decodeCoreUserExists,
  decodePerpAssetInfo,
  decodePosition,
  decodePx,
  decodeSpotBalance,
  decodeTokenInfo,
  decodeWithdrawable,
  distanceBpsForHfBps,
  encodeLimitOrder,
  encodePrecompileInput,
  encodeSendAsset,
  encodeUsdClassTransfer,
  entryDistanceBpsForMarginBps,
  equivalentHfBps,
  formatUnits,
  fundingStats,
  isChecksumAddress,
  ladderBpsFor,
  maintenanceMarginRateBps,
  marginBpsForEntryDistanceBps,
  notionalE6,
  parseDecimalToUnits,
  perpLadderFor,
  perpPxDecimals,
  perpReserveE6,
  perpRungFor,
  realisedCarryOnMarginPct,
  reduceForDistance,
  shortDistanceBps,
  shortLiquidationPrice,
  sizeForDistance,
  topUpE6ForDistance,
} from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const reads = JSON.parse(readFileSync(join(here, "../../../docs/research/hyperevm-reads-2026-09-25.json"), "utf8"));
const live = reads.precompiles.liveZecShort;
const ZEC = { ...HYPERLIQUID.zec };
const MMR = maintenanceMarginRateBps(ZEC.maxLeverage);

// ---------------------------------------------------------------- the facts, as pinned

test("the venue facts are the ones read from chain and the API, checksummed, and every precompile address is in the documented range", () => {
  assert.equal(HYPERLIQUID.chainId, 999);
  assert.equal(HYPERLIQUID.zec.index, 214);
  assert.equal(HYPERLIQUID.zec.szDecimals, 2);
  assert.equal(HYPERLIQUID.zec.maxLeverage, 10);
  assert.equal(HYPERLIQUID.zec.marginTableId, 52);
  assert.equal(MMR, 500, "tier 0: half the initial margin at 10× = 5 %");
  assert.equal(perpPxDecimals(ZEC.szDecimals), 4);
  assert.equal(HYPERLIQUID.cctp.domain, 19);
  assert.equal(HYPERLIQUID.cctp.fastTransferIn, true, "6→19 prices Fast at 1.3 bp");
  assert.equal(HYPERLIQUID.cctp.fastTransferOut, false, "19→6 is Standard only");
  assert.deepEqual(reads.cctpV2OnHyperEvm.circleFees["6->19"], [{ finalityThreshold: 1000, minimumFee: 1.3 }, { finalityThreshold: 2000, minimumFee: 0 }]);
  assert.deepEqual(reads.cctpV2OnHyperEvm.circleFees["19->6"], [{ finalityThreshold: 1000, minimumFee: 0 }, { finalityThreshold: 2000, minimumFee: 0 }]);
  for (const a of [HYPERLIQUID.coreWriter, HYPERLIQUID.usdc.circleUsdc, HYPERLIQUID.usdc.circleUsdcTestnet, HYPERLIQUID.cctp.tokenMessengerV2, HYPERLIQUID.cctp.messageTransmitterV2, HYPERLIQUID.cctp.tokenMinterV2]) {
    assert.ok(isChecksumAddress(a), `${a} is checksummed`);
  }
  assert.equal(HYPERLIQUID.cctp.tokenMessengerV2, reads.cctpV2OnHyperEvm.tokenMessengerV2.address);
  assert.equal(HYPERLIQUID.cctp.messageTransmitterV2, reads.cctpV2OnHyperEvm.messageTransmitterV2.address);
  assert.equal(reads.cctpV2OnHyperEvm.messageTransmitterV2.localDomain, 19);
  assert.equal(HYPERLIQUID.usdc.circleUsdc, reads.usdc.circleUsdc.address);
  assert.equal(HYPERLIQUID.usdc.adapter.toLowerCase(), reads.usdc.hyperCoreToken0.evmContract);
  assert.equal(HYPERLIQUID.usdc.weiDecimals, reads.usdc.hyperCoreToken0.weiDecimals);
  assert.equal(HYPERLIQUID.usdc.evmDecimals, reads.usdc.hyperCoreToken0.weiDecimals + reads.usdc.hyperCoreToken0.evmExtraWeiDecimals);
  for (const [name, addr] of Object.entries(HYPERCORE_PRECOMPILES)) {
    const n = Number(BigInt(addr));
    assert.ok(n >= 0x800 && n <= 0x810, `${name} at ${addr}`);
  }
});

// ---------------------------------------------------------------- decoders, pinned to the raw bytes beside the API

test("position(0x800): the live short decodes to the API's own numbers — szi −5176 (−51.76 ZEC), entryNtl 1535.1438 × 51.76 in 10^6, cross 10×", () => {
  const p = decodePosition(live.position_0x800_raw);
  assert.equal(p.szi, -5176n);
  assert.equal(formatUnits(p.szi, ZEC.szDecimals), live.apiPosition.szi);
  assert.equal(p.entryNtl, 79459043173n);
  // entryPx (10^4) × |szi| (10^2) is 10^6 USDC; the API's entryPx is truncated to four decimals, so the product
  // is within |szi| units of the chain's exact entryNtl (79,459,043,173 ÷ 5,176 = 1,535.14380…).
  const entryPx = parseDecimalToUnits(live.apiPosition.entryPx, 4);
  const product = entryPx * 5176n;
  const gap = p.entryNtl > product ? p.entryNtl - product : product - p.entryNtl;
  assert.ok(gap <= 5176n, `entryNtl ${p.entryNtl} vs entryPx × |szi| ${product}`);
  assert.equal((p.entryNtl / 5176n), entryPx, "entryNtl ÷ |szi| truncates to the API's entryPx");
  assert.equal(p.isolatedRawUsd, 0n);
  assert.equal(p.leverage, live.apiPosition.leverage.value);
  assert.equal(p.isIsolated, live.apiPosition.leverage.type !== "cross");
});

test("spotBalance(0x801) is in weiDecimals (10^8), withdrawable(0x803) and accountMarginSummary(0x80f) in 10^6, and each is the API's number", () => {
  const b = decodeSpotBalance(live.spotBalance_0x801_raw);
  assert.equal(formatUnits(b.total, HYPERLIQUID.usdc.weiDecimals), live.apiSpotUsdc.total);
  assert.equal(b.hold, 0n);
  const w = decodeWithdrawable(live.withdrawable_0x803_raw);
  assert.equal(w, 1510976428420n);
  const s = decodeAccountMarginSummary(live.accountMarginSummary_0x80f_raw);
  assert.equal(s.accountValue, 8326374359126n);
  assert.equal(s.marginUsed, 6611248254435n);
  assert.equal(s.ntlPos, 31173438173085n);
  assert.equal(s.rawUsd, 26393270272055n);
  // the API's cross summary, read two seconds earlier on a $31 M book: within 0.01 %
  const apiA = parseDecimalToUnits(live.apiCrossMarginSummary.accountValue.slice(0, live.apiCrossMarginSummary.accountValue.indexOf(".") + 7), 6);
  const diff = s.accountValue > apiA ? s.accountValue - apiA : apiA - s.accountValue;
  assert.ok(diff * 10_000n < apiA, `accountValue within 1 bp of the API: ${s.accountValue} vs ${apiA}`);
  // the HLP read: marginUsed is the perp dex 0 initial margin, matching marginSummary.totalMarginUsed
  const hlp = decodeAccountMarginSummary(reads.precompiles.accountMarginSummary_0x80f_dex0_HLP.raw);
  assert.equal(formatUnits(hlp.marginUsed, 6), "477.867397");
  assert.equal(hlp.ntlPos, 0n);
});

test("mark and oracle prices are 10^(6 − szDecimals): the 2026-09-14 exact pair and today's read", () => {
  assert.equal(decodePx(live.markPx_0x806_raw), 15389417n);
  assert.equal(formatUnits(15389417n, perpPxDecimals(ZEC.szDecimals)), "1538.9417");
  // facts §4, 2026-09-14T22:53:44Z: 11,691,000 ↔ markPx 1169.1 to the last digit
  assert.equal(formatUnits(11691000n, 4), "1169.1000");
  assert.equal(decodePx(reads.precompiles.oraclePx_0x807_ZEC214.raw), 15387700n);
});

test("perpAssetInfo(0x80a) and tokenInfo(0x80c) decode their dynamic tuples to the API's meta", () => {
  const info = decodePerpAssetInfo(reads.precompiles.perpAssetInfo_0x80a_214.raw);
  assert.deepEqual(info, { coin: "ZEC", marginTableId: 52, szDecimals: 2, maxLeverage: 10, onlyIsolated: false });
  const t = decodeTokenInfo(reads.usdc.hyperCoreToken0.tokenInfoRaw);
  assert.equal(t.name, "USDC");
  assert.deepEqual(t.spots, []);
  assert.equal(t.deployerTradingFeeShare, 0n);
  assert.equal(t.deployer, "0x0000000000000000000000000000000000000000");
  assert.equal(t.evmContract, HYPERLIQUID.usdc.adapter);
  assert.equal(t.szDecimals, 8);
  assert.equal(t.weiDecimals, 8);
  assert.equal(t.evmExtraWeiDecimals, -2);
  assert.equal(decodeCoreUserExists("0x0000000000000000000000000000000000000000000000000000000000000001"), true);
  assert.equal(decodeCoreUserExists("0x0000000000000000000000000000000000000000000000000000000000000000"), false);
});

test("a read that does not decode is refused by name, never returned as a number (design §8 risk 6)", () => {
  assert.throws(() => decodePosition("0x00"), PrecompileDecodeError);
  assert.throws(() => decodePosition(live.spotBalance_0x801_raw), /expected 5 words/);
  assert.throws(() => decodeSpotBalance(live.position_0x800_raw), /expected 3 words/);
  assert.throws(() => decodeCoreUserExists("0x0000000000000000000000000000000000000000000000000000000000000002"), /not a bool/);
  assert.throws(() => decodePerpAssetInfo("0x" + "00".repeat(32)), PrecompileDecodeError);
  assert.throws(() => decodeAccountMarginSummary(""), PrecompileDecodeError);
});

test("precompile inputs are raw ABI words without a selector, in the shapes that answered", () => {
  assert.equal(encodePrecompileInput.position(live.user, 214), "0x" + "0".repeat(24) + live.user.slice(2) + "0".repeat(62) + "d6");
  assert.equal(encodePrecompileInput.px(214).length, 2 + 64);
  assert.equal(encodePrecompileInput.accountMarginSummary(0, live.user), "0x" + "0".repeat(64) + "0".repeat(24) + live.user.slice(2));
  assert.equal(encodePrecompileInput.spotBalance(live.user, 0), "0x" + "0".repeat(24) + live.user.slice(2) + "0".repeat(64));
});

// ---------------------------------------------------------------- CoreWriter encoding, pinned to a live RawAction

test("action 13's encoding reproduces the live RawAction bytes byte for byte (tx 0xeaf2…acb9): version 1, id 0x00000d, six ABI words", () => {
  const d = reads.usdc.liveDepositObserved;
  const encoded = encodeSendAsset({ destination: "0xc0e330226EAC3D1a47C91f1D9bae525e5fB28DA0", sourceDex: CORE_SPOT_DEX, destinationDex: 0, token: 0, wei: 7001465300n });
  assert.equal(encoded, d.rawActionDataHex);
  assert.equal(encoded.length, 2 + 2 * (4 + 6 * 32));
  assert.equal(formatUnits(7001465300n, HYPERLIQUID.usdc.weiDecimals), "70.01465300", "70.014653 USDC in 10^8 wei");
  assert.equal(CORE_ACTIONS.sendAsset, 13);
});

test("action 1 [doc] and action 7 [doc] follow the same rule: version, three-byte id, then the documented tuples; refused when malformed", () => {
  const order = encodeLimitOrder({ asset: 214, isBuy: false, limitPxE8: parseDecimalToUnits("1538.9417", 8), szE8: parseDecimalToUnits("1.5", 8), reduceOnly: false, tif: CORE_TIF.ioc });
  assert.ok(order.startsWith("0x01000001"));
  assert.equal(order.length, 2 + 2 * (4 + 7 * 32));
  const words = order.slice(2 + 8).match(/.{64}/g)!;
  assert.equal(BigInt("0x" + words[0]), 214n);
  assert.equal(BigInt("0x" + words[1]), 0n, "isBuy false: a short is a sell");
  assert.equal(BigInt("0x" + words[2]), 153894170000n, "limitPx is 10^8 × the human price, not the precompile's 10^4");
  assert.equal(BigInt("0x" + words[3]), 150000000n);
  assert.equal(BigInt("0x" + words[4]), 0n);
  assert.equal(BigInt("0x" + words[5]), 3n, "IOC");
  assert.equal(BigInt("0x" + words[6]), 0n, "no cloid");
  const xfer = encodeUsdClassTransfer(1_000_000n, true);
  assert.equal(xfer, "0x01000007" + "0".repeat(59) + "f4240" + "0".repeat(63) + "1");
  assert.throws(() => encodeLimitOrder({ asset: 214, isBuy: true, limitPxE8: 0n, szE8: 1n, reduceOnly: true, tif: 3 }), /limitPx/);
  assert.throws(() => encodeLimitOrder({ asset: 214, isBuy: true, limitPxE8: 1n, szE8: 1n, reduceOnly: true, tif: 4 as never }), /tif/);
  assert.throws(() => encodeUsdClassTransfer(0n, true), /ntl/);
  assert.throws(() => encodeSendAsset({ destination: "0x12", sourceDex: 0, destinationDex: 0, token: 0, wei: 1n }), /address/);
});

test("decimal strings are parsed exactly and formatted back — no float in the money path", () => {
  assert.equal(parseDecimalToUnits("1535.1438", 4), 15351438n);
  assert.equal(parseDecimalToUnits("-51.76", 2), -5176n);
  assert.equal(parseDecimalToUnits("1.54956382", 8), 154956382n);
  assert.equal(parseDecimalToUnits("70.014653", 6), 70014653n);
  assert.equal(formatUnits(-5176n, 2), "-51.76");
  assert.equal(formatUnits(5n, 0), "5");
  assert.throws(() => parseDecimalToUnits("1.123456789", 8), /more than 8 decimals/);
  assert.throws(() => parseDecimalToUnits("1e5", 8), /not a decimal/);
});

// ---------------------------------------------------------------- the health of a short (design §4)

test("the distance from the live short's own reads: the venue's rule, in integers, and the equivalent HF", () => {
  // The live account has 95 positions, so its distance is not a single-position number; use the reads to check
  // the arithmetic shape only, then the design's worked rows below.
  const p = decodePosition(live.position_0x800_raw);
  const ntl = notionalE6(p.szi, 15389417n, ZEC.szDecimals);
  assert.equal(ntl, 5176n * 15389417n, "|szi| × mark is the 10^6 notional when szDecimals + pxDecimals = 6");
  assert.equal(formatUnits(ntl, 6), "79655.622392");
});

test("design §4's table: margin per dollar shorted ↔ up-move to liquidation ↔ equivalent HF, at mmr 5 %", () => {
  const rows: [number, number, number][] = [
    // marginBps, expected distance bps (floor), expected HF bps (floor)
    [10_000, 9_047, 104_931], // L = 1: 90.5 %, HF 10.49
    [6_667, 5_873, 24_230], // L = 1.5: 58.7 %, HF 2.42
    [5_000, 4_285, 17_497], // L = 2: 42.9 %, HF 1.75
    [3_333, 2_698, 13_694], // L = 3: 27.0 %, HF 1.37
    [2_000, 1_428, 11_665], // L = 5: 14.3 %, HF 1.17
    [1_000, 476, 10_499], // L = 10: 4.8 %, HF 1.05
  ];
  for (const [m, d, hf] of rows) {
    assert.equal(entryDistanceBpsForMarginBps(m, MMR), d, `margin ${m} bps → distance`);
    assert.equal(equivalentHfBps(d), hf, `distance ${d} → HF`);
    assert.ok(marginBpsForEntryDistanceBps(d, MMR) <= m && marginBpsForEntryDistanceBps(d, MMR) >= m - 2, `distance ${d} → margin ≈ ${m} (the slider's other direction, within rounding)`);
    assert.ok(distanceBpsForHfBps(hf) <= d && distanceBpsForHfBps(hf) >= d - 1, `HF ${hf} → distance ≈ ${d}`);
  }
  assert.equal(entryDistanceBpsForMarginBps(MMR, MMR), 0, "margin at the maintenance rate is zero distance");
  assert.equal(entryDistanceBpsForMarginBps(100_000, MMR), MAX_SHORT_DISTANCE_BPS, "clamped at 0.99");
  assert.equal(equivalentHfBps(MAX_SHORT_DISTANCE_BPS), 1_000_000, "HF 100 at the clamp");
  assert.equal(PROPOSED_PERP_ENTRY_FLOOR_MARGIN_BPS, 5_000);
  assert.deepEqual(PERP_MARGIN_MARKS.map((m) => [m.id, m.marginBps]), [["sheltered", 6_667], ["expert", 5_000]]);
});

test("the live rule against the venue's own liquidation price: the single-position short sampled 2026-09-25 (0x330e…, −13.95 ZEC)", () => {
  const row = reads.liquidationFormulaCheck.rows.find((r: { user: string }) => r.user.startsWith("0x330e4c08"));
  assert.ok(row, "the sampled single-position short is in the research file");
  const markRaw = parseDecimalToUnits(String(row.mark), 4);
  const szi = parseDecimalToUnits(row.szi, 2);
  const accountValueE6 = parseDecimalToUnits(row.accountValue.toFixed(6), 6);
  const d = shortDistanceBps({ accountValueE6, szi, markRaw, szDecimals: 2, mmrBps: MMR });
  const venueD = (row.venueLiquidationPx - row.mark) / row.mark;
  assert.ok(Math.abs(d / 10_000 - venueD) < 0.0002, `distance ${d} bps vs the venue's ${(venueD * 10_000).toFixed(1)} bps`);
  assert.ok(Math.abs(row.relDiffPct) < 0.001, "the formula reproduced the venue's liquidationPx to 0.001 %");
  const liq = shortLiquidationPrice(row.mark, d);
  assert.ok(Math.abs(liq - row.venueLiquidationPx) / row.venueLiquidationPx < 0.0003);
});

test("shortDistanceBps refuses a long or an empty position and reads a wiped account as zero distance", () => {
  assert.throws(() => shortDistanceBps({ accountValueE6: 1n, szi: 5n, markRaw: 1n, szDecimals: 2, mmrBps: MMR }), /not a short/);
  assert.throws(() => shortDistanceBps({ accountValueE6: 1n, szi: 0n, markRaw: 1n, szDecimals: 2, mmrBps: MMR }), /not a short/);
  assert.equal(shortDistanceBps({ accountValueE6: -5n, szi: -100n, markRaw: 15389417n, szDecimals: 2, mmrBps: MMR }), 0);
  assert.equal(shortDistanceBps({ accountValueE6: 10n ** 12n, szi: -1n, markRaw: 1n, szDecimals: 2, mmrBps: MMR }), MAX_SHORT_DISTANCE_BPS);
});

test("the short's ladder IS the shared ladder on the equivalent HF: L = 2 opens at HF 1.7498 → warn 1.68 / top-up 1.48 / reduce 1.27 / close 1.0675 as design §4 tabulates", () => {
  const d0 = entryDistanceBpsForMarginBps(5_000, MMR);
  const ladder = perpLadderFor(d0);
  assert.deepEqual(ladder.map((r) => r.id), ["warn", "repay", "derisk", "emergency"]);
  assert.deepEqual(ladder.map((r) => r.hfBps), ladderBpsFor(equivalentHfBps(d0)).map((r) => r.hfBps));
  assert.deepEqual(ladder.map((r) => r.hfBps), [16_800, 14_800, 12_700, 10_700]);
  assert.deepEqual(ladder.map((r) => r.distanceBps), [4_047, 3_243, 2_125, 654]);
  for (const r of ladder) assert.ok(r.disarmDistanceBps > r.distanceBps, `${r.id} disarms above its trigger`);
  // L = 1.5 opens at 2.42: the acting rungs take the 2.00 cap's (D10), warn keeps deriving
  const l15 = perpLadderFor(entryDistanceBpsForMarginBps(6_667, MMR));
  assert.equal(l15[0]!.hfBps, 22_900);
  assert.deepEqual(l15.slice(1).map((r) => r.hfBps), [16_400, 13_600, 10_900]);
  assert.deepEqual(l15.slice(1).map((r) => r.distanceBps), [3_902, 2_647, 825]);
  assert.equal(MAX_LADDER_ENTRY_DISTANCE_BPS, 5_000, "the D10 cap at HF 2.00 is a 50 % up-move");
  // the emergency rung's 1.05 floor is a 4.76 % move on either kind of position
  assert.equal(distanceBpsForHfBps(10_500), 476);
  assert.throws(() => perpLadderFor(800), /four rungs do not fit/);
});

test("perpRungFor names the most severe rung the live distance is under, and null when healthy", () => {
  const ladder = perpLadderFor(4_285);
  assert.equal(perpRungFor(4_285, ladder), null);
  // a rung's distance is the FLOOR of its HF's up-move, and the comparison is made in HF space (as on chain):
  // 4048 bps → HF 1.6801 is healthy, 4047 bps → HF 1.6798 is under the 1.68 warn rung.
  assert.equal(perpRungFor(4_048, ladder), null, "just above the warn rung");
  assert.equal(perpRungFor(4_047, ladder)?.id, "warn", "the rung's own floored distance is already under it");
  assert.equal(perpRungFor(3_200, ladder)?.id, "repay");
  assert.equal(perpRungFor(2_000, ladder)?.id, "derisk");
  assert.equal(perpRungFor(600, ladder)?.id, "emergency");
  assert.equal(perpRungFor(0, ladder)?.id, "emergency");
  assert.throws(() => perpRungFor(-1, ladder), RangeError);
});

test("the sizing identities invert the distance: a top-up reaches a target with no size change, a reduce reaches it with no new money", () => {
  const mark = 15389417n;
  const reads = { accountValueE6: 40_000_000_000n, szi: -5176n, markRaw: mark, szDecimals: 2, mmrBps: MMR }; // $40,000 against $79,656 notional
  const d = shortDistanceBps(reads);
  assert.equal(d, 4_305);
  const target = 4_800;
  const topUp = topUpE6ForDistance(reads, target);
  assert.ok(topUp > 0n);
  const after = { ...reads, accountValueE6: reads.accountValueE6 + topUp };
  assert.ok(shortDistanceBps(after) >= target, "the top-up reaches the target");
  assert.ok(shortDistanceBps({ ...reads, accountValueE6: reads.accountValueE6 + topUp - 1_000_000n }) < target, "a dollar less does not");
  assert.equal(topUpE6ForDistance(after, target), 0n, "nothing more once there");
  assert.equal(accountValueForDistanceE6(notionalE6(reads.szi, mark, 2), d, MMR) <= reads.accountValueE6, true);
  const reduce = reduceForDistance(reads, target);
  assert.ok(reduce > 0n && reduce < 5176n);
  const kept = sizeForDistance(reads, target);
  assert.equal(kept, 5176n - reduce);
  assert.ok(shortDistanceBps({ ...reads, szi: -kept }) >= target, "the reduce reaches the target");
  assert.ok(shortDistanceBps({ ...reads, szi: -(kept + 1n) }) < target, "one more unit kept does not");
  assert.equal(reduceForDistance(after, target), 0n);
  assert.equal(sizeForDistance({ ...reads, accountValueE6: 0n }, target), 0n);
});

test("the reserve is the repay rung's own top-up at the highest price it can fire at, times the multiple, rounded up (design §6)", () => {
  const ntl = 25_000_000_000n; // the D8 cap, $25,000
  const d0 = entryDistanceBpsForMarginBps(5_000, MMR); // 4285
  const r = perpReserveE6(ntl, d0, MMR);
  const repay = perpLadderFor(d0)[1]!;
  const delta = repay.disarmDistanceBps - repay.distanceBps;
  const expected = (25_000 * (1 + d0 / 10_000) * 1.05 * delta) / 10_000;
  assert.ok(Math.abs(Number(r) / 1e6 - expected) < 0.01, `${r} ≈ ${expected}`);
  const doubled = perpReserveE6(ntl, d0, MMR, 20_000);
  assert.ok(doubled >= 2n * r - 1n && doubled <= 2n * r, "a 2× multiple doubles it, to rounding");
  assert.ok(r > 0n);
});

// ---------------------------------------------------------------- funding, as measured

test("fundingStats over the 288 hours of 2026-09-13 → 25 reproduces the facts file's numbers: mean +13.55 %, median +10.95 %, 12 negative hours, 0.446 % realised", () => {
  const sample = JSON.parse(readFileSync(join(here, "../../../docs/research/hyperliquid-zec-2026-09-25.json"), "utf8"));
  const s = fundingStats(sample.fundingHistoryZec.rows);
  assert.equal(s.samples, 288);
  assert.equal(s.firstIso.slice(0, 16), "2026-09-13T23:00");
  assert.equal(s.lastIso.slice(0, 16), "2026-09-25T22:00");
  assert.equal(s.meanAnnualisedPct.toFixed(2), "13.55");
  assert.equal(s.medianAnnualisedPct.toFixed(2), "10.95");
  assert.equal(s.minAnnualisedPct.toFixed(2), "-24.02");
  assert.equal(s.maxAnnualisedPct.toFixed(2), "147.24");
  assert.equal(s.negativeHours, 12);
  assert.equal(s.negativeSharePct.toFixed(1), "4.2");
  assert.equal(s.realisedPctOverWindow.toFixed(3), "0.446");
  assert.equal(s.realisedAnnualisedPct.toFixed(2), "13.55");
  assert.equal(annualisedFundingPct(0.0000125).toFixed(2), "10.95", "the venue's 0.0000125/h is +10.95 %/yr");
  // funding is paid on the notional: at $0.50 of margin per dollar shorted the carry per margin dollar is 2×
  assert.equal(realisedCarryOnMarginPct(sample.fundingHistoryZec.rows, 5_000).toFixed(3), (s.realisedPctOverWindow * 2).toFixed(3));
  assert.throws(() => fundingStats([]), /no samples/);
  assert.throws(() => fundingStats([{ time: 2, fundingRate: "0" }, { time: 1, fundingRate: "0" }]), /increasing/);
});
