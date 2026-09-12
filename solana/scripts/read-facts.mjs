// Read-only Solana facts read — the reader behind docs/VERIFIED-SOLANA-FACTS.md.
// Nothing here signs, builds, or sends a transaction. Public RPC, finalized commitment.
//
//   SOLANA_RPC_URL=<rpc> BASE_AAVE_USDC_BORROW_APR_PCT=<pct> node solana/scripts/read-facts.mjs
//
// Writes solana/.facts/facts.json (gitignored). Re-run it before any number in the facts file is relied on;
// paste the deltas into a dated addendum of docs/VERIFIED-SOLANA-FACTS.md, never edit the table in place.
// The Base rate is read separately (cast call PoolDataProvider.getReserveData(USDC) on Base) and passed in so
// the projection table can say where the Kamino curve crosses it.
import { createSolanaRpc, address, getProgramDerivedAddress, getAddressEncoder } from "@solana/kit";
import { PublicKey } from "@solana/web3.js";
import * as klend from "@kamino-finance/klend-sdk";
// scope-sdk accounts are decoded raw below (see the Scope section)
import Decimal from "decimal.js";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const rpc = createSolanaRpc(RPC_URL);

const MARKET = address("GBJ3bzUiMfwC9ugaF3MM68EXMDyTUb5UryRRAcVjEowd");
const ZEC_MINT = address("A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS");
const USDC_MINT = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const KLEND = address("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
const METAPLEX = address("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function raw(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) {
    if (j.error.code === 429 && (params?.__retry ?? 0) < 4) { await sleep(3000 * (1 + (params.__retry ?? 0))); const p = params; p.__retry = (p.__retry ?? 0) + 1; return raw(method, p); }
    throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  }
  return j.result;
}
const bnStr = (x) => (x == null ? null : x.toString());
const sf = (x) => new Decimal(x.toString()).div(new Decimal(2).pow(60)); // Kamino scaled fraction = 2^60

// ---------------------------------------------------------------- slot / time
const slot = Number(await rpc.getSlot({ commitment: "finalized" }).send());
const blockTime = await raw("getBlockTime", [slot]);
out.read = { rpc: RPC_URL, slot, blockTime, iso: new Date(blockTime * 1000).toISOString() };
console.log("READ", out.read);

// ---------------------------------------------------------------- programs (executable?)
out.programs = {};
for (const [name, id] of Object.entries({
  klend: "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD",
  scope: "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ",
  farms: "FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr",
  metaplexTokenMetadata: "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
})) {
  const ai = await raw("getAccountInfo", [id, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
  out.programs[name] = { id, executable: ai?.value?.executable ?? null, owner: ai?.value?.owner ?? null };
  await sleep(300);
}
console.log("PROGRAMS", out.programs);

// ---------------------------------------------------------------- lending market
const lm = await klend.LendingMarket.fetch(rpc, MARKET, KLEND);
if (!lm) throw new Error("market not found");
const lmj = lm.toJSON();
const nameBytes = Buffer.from(lm.name);
out.market = {
  address: MARKET,
  name: nameBytes.toString("utf8").replace(/\0+$/g, ""),
  version: bnStr(lmj.version),
  lendingMarketOwner: lmj.lendingMarketOwner,
  lendingMarketOwnerCached: lmj.lendingMarketOwnerCached,
  riskCouncil: lmj.riskCouncil,
  quoteCurrency: Buffer.from(lm.quoteCurrency).toString("utf8").replace(/\0+$/g, ""),
  emergencyMode: lmj.emergencyMode,
  autodeleverageEnabled: lmj.autodeleverageEnabled,
  borrowDisabled: lmj.borrowDisabled,
  immutableFlag: lmj.immutableFlag,
  referralFeeBps: lmj.referralFeeBps,
  liquidationMaxDebtCloseFactorPct: lmj.liquidationMaxDebtCloseFactorPct,
  insolvencyRiskUnhealthyLtvPct: lmj.insolvencyRiskUnhealthyLtvPct,
  minFullLiquidationValueThreshold: bnStr(lmj.minFullLiquidationValueThreshold),
  maxLiquidatableDebtMarketValueAtOnce: bnStr(lmj.maxLiquidatableDebtMarketValueAtOnce),
  globalAllowedBorrowValue: bnStr(lmj.globalAllowedBorrowValue),
  priceRefreshTriggerToMaxAgePct: lmj.priceRefreshTriggerToMaxAgePct,
  minNetValueInObligationSf: bnStr(lmj.minNetValueInObligationSf),
  minValueSkipLiquidationLtvChecks: bnStr(lmj.minValueSkipLiquidationLtvChecks),
  minValueSkipLiquidationBfChecks: bnStr(lmj.minValueSkipLiquidationBfChecks),
  individualAutodeleverageMarginCallPeriodSecs: bnStr(lmj.individualAutodeleverageMarginCallPeriodSecs),
  minInitialDepositAmount: bnStr(lmj.minInitialDepositAmount),
  obligationOrderExecutionEnabled: lmj.obligationOrderExecutionEnabled,
  obligationOrderCreationEnabled: lmj.obligationOrderCreationEnabled,
  elevationGroupsActive: (lmj.elevationGroups ?? []).filter((g) => g.id !== 0).map((g) => ({
    id: g.id, maxLiquidationBonusBps: g.maxLiquidationBonusBps, ltvPct: g.ltvPct, liquidationThresholdPct: g.liquidationThresholdPct,
    allowNewLoans: g.allowNewLoans, maxReservesAsCollateral: g.maxReservesAsCollateral, debtReserve: g.debtReserve,
  })),
};
console.log("MARKET", out.market);

// ---------------------------------------------------------------- reserves (chain enumeration)
const gpa = await raw("getProgramAccounts", [
  KLEND,
  {
    encoding: "base64",
    commitment: "finalized",
    dataSlice: { offset: 0, length: 0 },
    filters: [{ dataSize: 8624 }, { memcmp: { offset: 32, bytes: MARKET } }],
  },
]);
out.reserveAddresses = gpa.map((a) => a.pubkey);
console.log("RESERVES", out.reserveAddresses);

await sleep(500);
const reserves = await klend.Reserve.fetchMultiple(rpc, out.reserveAddresses.map(address), KLEND);
const curvePts = (curve) => curve.points.map((p) => ({ utilBps: p.utilizationRateBps, rateBps: p.borrowRateBps }));
function curveRateBps(points, utilBps) {
  // Kamino's curve: piecewise-linear between (utilization bps, rate bps) points; clamp at the ends.
  const pts = points.filter((p, i, a) => i === 0 || !(p.utilBps === a[i - 1].utilBps && p.rateBps === a[i - 1].rateBps));
  if (utilBps <= pts[0].utilBps) return pts[0].rateBps;
  for (let i = 1; i < pts.length; i++) {
    if (utilBps <= pts[i].utilBps) {
      const a = pts[i - 1], b = pts[i];
      if (b.utilBps === a.utilBps) return b.rateBps;
      return a.rateBps + ((b.rateBps - a.rateBps) * (utilBps - a.utilBps)) / (b.utilBps - a.utilBps);
    }
  }
  return pts[pts.length - 1].rateBps;
}

out.reserves = {};
const decBy = {};
for (let i = 0; i < reserves.length; i++) {
  const r = reserves[i];
  const addr = out.reserveAddresses[i];
  const j = r.toJSON();
  const c = j.config;
  const liq = j.liquidity;
  const dec = Number(liq.mintDecimals);
  const scale = new Decimal(10).pow(dec);
  const available = new Decimal(liq.totalAvailableAmount).div(scale);
  const borrowed = sf(liq.borrowedAmountSf).div(scale);
  const accProtoFees = sf(liq.accumulatedProtocolFeesSf).div(scale);
  const accReferrerFees = sf(liq.accumulatedReferrerFeesSf).div(scale);
  const pendingReferrerFees = sf(liq.pendingReferrerFeesSf).div(scale);
  const totalSupply = available.plus(borrowed).minus(accProtoFees).minus(accReferrerFees).minus(pendingReferrerFees);
  const util = totalSupply.gt(0) ? borrowed.div(totalSupply) : new Decimal(0);
  const pts = curvePts(r.config.borrowRateCurve);
  const utilBps = Math.round(util.toNumber() * 10_000);
  const rateBpsNow = curveRateBps(pts, utilBps);
  const symbol = liq.mintPubkey === ZEC_MINT ? "ZEC" : liq.mintPubkey === USDC_MINT ? "USDC" : "?";
  decBy[symbol] = dec;
  const tokenName = Buffer.from(r.config.tokenInfo.name).toString("utf8").replace(/\0+$/g, "");
  const ti = c.tokenInfo;
  const borrowLimit = new Decimal(c.borrowLimit).div(scale);
  const depositLimit = new Decimal(c.depositLimit).div(scale);
  out.reserves[symbol] = {
    address: addr,
    lastUpdateSlot: bnStr(j.lastUpdate.slot),
    lastUpdateStale: j.lastUpdate.stale,
    lastUpdatePriceStatus: j.lastUpdate.priceStatus,
    mint: liq.mintPubkey,
    mintDecimals: dec,
    tokenProgram: liq.tokenProgram,
    supplyVault: liq.supplyVault,
    feeVault: liq.feeVault,
    collateralMint: j.collateral.mintPubkey,
    collateralSupplyVault: j.collateral.supplyVault,
    farmCollateral: j.farmCollateral,
    farmDebt: j.farmDebt,
    status: c.status,
    tokenName,
    // risk parameters
    loanToValuePct: c.loanToValuePct,
    liquidationThresholdPct: c.liquidationThresholdPct,
    minLiquidationBonusBps: c.minLiquidationBonusBps,
    maxLiquidationBonusBps: c.maxLiquidationBonusBps,
    badDebtLiquidationBonusBps: c.badDebtLiquidationBonusBps,
    borrowFactorPct: c.borrowFactorPct,
    protocolTakeRatePct: c.protocolTakeRatePct,
    protocolLiquidationFeePct: c.protocolLiquidationFeePct,
    protocolOrderExecutionFeePct: c.protocolOrderExecutionFeePct,
    hostFixedInterestRateBps: c.hostFixedInterestRateBps,
    fees: c.fees,
    depositLimit: depositLimit.toString(),
    borrowLimit: borrowLimit.toString(),
    borrowLimitOutsideElevationGroup: new Decimal(c.borrowLimitOutsideElevationGroup).div(scale).toString(),
    utilizationLimitBlockBorrowingAbovePct: c.utilizationLimitBlockBorrowingAbovePct,
    depositWithdrawalCap: c.depositWithdrawalCap,
    debtWithdrawalCap: c.debtWithdrawalCap,
    elevationGroups: c.elevationGroups.filter((g) => g !== 0),
    disableUsageAsCollOutsideEmode: c.disableUsageAsCollOutsideEmode,
    blockCtokenUsage: c.blockCtokenUsage,
    autodeleverageEnabled: c.autodeleverageEnabled,
    deleveragingMarginCallPeriodSecs: c.deleveragingMarginCallPeriodSecs,
    deleveragingThresholdDecreaseBpsPerDay: c.deleveragingThresholdDecreaseBpsPerDay,
    emergencyMode: c.emergencyMode,
    interestRateBasis: c.interestRateBasis,
    proposerAuthorityLocked: c.proposerAuthorityLocked,
    permissionedOps: c.permissionedOps,
    borrowRateCurve: pts,
    // oracle
    oracle: {
      maxAgePriceSeconds: ti.maxAgePriceSeconds,
      maxAgeTwapSeconds: ti.maxAgeTwapSeconds,
      maxTwapDivergenceBps: ti.maxTwapDivergenceBps,
      heuristic: ti.heuristic,
      scope: ti.scopeConfiguration,
      pyth: ti.pythConfiguration,
      switchboard: ti.switchboardConfiguration,
      blockPriceUsage: ti.blockPriceUsage,
    },
    // liquidity state
    availableAmount: available.toString(),
    borrowedAmount: borrowed.toString(),
    totalSupply: totalSupply.toString(),
    utilizationPct: util.mul(100).toFixed(4),
    borrowRateNowPctFromCurve: (rateBpsNow / 100).toFixed(4),
    marketPriceSf: sf(liq.marketPriceSf).toString(),
    marketPriceLastUpdatedTs: bnStr(liq.marketPriceLastUpdatedTs),
    cumulativeBorrowRateBsf: liq.cumulativeBorrowRateBsf,
    depositLimitCrossedTimestamp: bnStr(liq.depositLimitCrossedTimestamp),
    borrowLimitCrossedTimestamp: bnStr(liq.borrowLimitCrossedTimestamp),
    accumulatedProtocolFees: accProtoFees.toString(),
    collateralMintTotalSupply: bnStr(j.collateral.mintTotalSupply),
  };
  console.log(`RESERVE ${symbol}`, JSON.stringify(out.reserves[symbol], null, 1));
}

// ---------------------------------------------------------------- USDC borrow projection
{
  const u = out.reserves.USDC;
  const supply = new Decimal(u.totalSupply);
  const borrowed = new Decimal(u.borrowedAmount);
  const available = new Decimal(u.availableAmount);
  const borrowLimit = new Decimal(u.borrowLimit);
  const roomByLimit = borrowLimit.minus(borrowed);
  const remaining = Decimal.min(available, roomByLimit.gt(0) ? roomByLimit : new Decimal(0));
  const pts = u.borrowRateCurve;
  const rows = [];
  for (const add of [0, 50_000, 100_000, 150_000, 200_000, 250_000, 300_000, 350_000, 400_000]) {
    const b = borrowed.plus(add);
    if (b.gt(supply)) break;
    const util = b.div(supply);
    const rate = curveRateBps(pts, Math.round(util.toNumber() * 10_000)) / 100;
    rows.push({ addUsdc: add, borrowedUsdc: b.toFixed(0), utilPct: util.mul(100).toFixed(2), borrowAprPct: rate.toFixed(3) });
  }
  // the smallest added borrow (to $1k) at which the curve rate exceeds Base's Aave USDC rate (read separately)
  const baseAaveUsdcAprPct = Number(process.env.BASE_AAVE_USDC_BORROW_APR_PCT ?? "NaN");
  let crossesBaseAt = null;
  if (Number.isFinite(baseAaveUsdcAprPct)) {
    for (let add = 0; borrowed.plus(add).lte(supply); add += 1_000) {
      const util = borrowed.plus(add).div(supply);
      const rate = curveRateBps(pts, Math.round(util.toNumber() * 10_000)) / 100;
      if (rate > baseAaveUsdcAprPct) { crossesBaseAt = add; break; }
    }
  }
  out.usdcProjection = {
    remainingBorrowableUsdc: remaining.toFixed(2),
    boundBy: available.lte(roomByLimit) ? "available liquidity" : "borrow limit",
    rows,
    baseAaveUsdcAprPct: Number.isFinite(baseAaveUsdcAprPct) ? baseAaveUsdcAprPct : null,
    newBorrowingThatCrossesBaseRateUsdc: crossesBaseAt,
  };
  console.log("USDC PROJECTION", JSON.stringify(out.usdcProjection, null, 1));
}

// ---------------------------------------------------------------- Scope oracle: ZEC price chain (raw decode)
// The scope-sdk 10.2.6 account layouts do not decode the live feed correctly (prices[] came back short), so the
// two accounts are decoded from bytes here. Layouts (scope program, verified against ORACLE_PRICES_LEN 28,712 =
// 8 + 32 + 512 × 56 and ORACLE_MAPPINGS_LEN 29,704 = 8 + 512 × 58):
//   OraclePrices  : disc[8] | oracle_mappings Pubkey | prices [DatedPrice; 512]
//   DatedPrice    : price{value u64, exp u64} | last_updated_slot u64 | unix_timestamp u64 | generic_data [u8; 24]
//   OracleMappings: disc[8] | price_info_accounts [Pubkey;512] | price_types [u8;512] | twap_source [u16;512] |
//                   twap_enabled [u8;512] | ref_price [u16;512] | generic [[u8;20];512]
//   MostRecentOfData (generic): source_entries [u16;4] | max_divergence_bps u16 | sources_max_age_s u64
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const OracleTypeMod = req("@kamino-finance/scope-sdk/dist/@codegen/scope/types/OracleType.js");
try {
  const sc = out.reserves.ZEC.oracle.scope;
  await sleep(500);
  const pAcct = await raw("getAccountInfo", [sc.priceFeed, { encoding: "base64", commitment: "finalized" }]);
  const pb = Buffer.from(pAcct.value.data[0], "base64");
  const N = (pb.length - 40) / 56;
  const mappingsPk = new PublicKey(pb.subarray(8, 40)).toBase58();
  await sleep(500);
  const mAcct = await raw("getAccountInfo", [mappingsPk, { encoding: "base64", commitment: "finalized" }]);
  const mb = Buffer.from(mAcct.value.data[0], "base64");
  const NM = (mb.length - 8) / 58;
  const names = {};
  for (const [k, v] of Object.entries(OracleTypeMod)) if (typeof v === "function" && v.discriminator !== undefined) names[v.discriminator] = v.kind ?? k;
  const priceEntry = (i) => {
    const o = 40 + i * 56;
    const value = pb.readBigUInt64LE(o), exp = pb.readBigUInt64LE(o + 8), slotU = pb.readBigUInt64LE(o + 16), ts = pb.readBigUInt64LE(o + 24);
    return { priceUsd: new Decimal(value.toString()).div(new Decimal(10).pow(Number(exp))).toString(), value: value.toString(), exp: Number(exp), lastUpdatedSlot: slotU.toString(), unixTimestamp: Number(ts), ageSecondsAtRead: blockTime - Number(ts), priceGenericHex: pb.subarray(o + 32, o + 56).toString("hex") };
  };
  const mapEntry = (i) => {
    let o = 8;
    const acct = new PublicKey(mb.subarray(o + i * 32, o + i * 32 + 32)).toBase58(); o += NM * 32;
    const ptype = mb[o + i]; o += NM;
    const twapSrc = mb.readUInt16LE(o + i * 2); o += NM * 2;
    const twapEn = mb[o + i]; o += NM;
    const ref = mb.readUInt16LE(o + i * 2); o += NM * 2;
    const gen = mb.subarray(o + i * 20, o + i * 20 + 20);
    const e = { priceType: names[ptype] ?? `type#${ptype} (not in scope-sdk 10.2.6 table)`, priceTypeCode: ptype, priceInfoAccount: acct, twapSource: twapSrc === 65535 ? null : twapSrc, twapEnabled: twapEn, refPrice: ref === 65535 ? null : ref, genericHex: gen.toString("hex") };
    if (ptype === 28 || ptype === 39) e.mostRecentOf = { sourceEntries: [0, 2, 4, 6].map((k) => gen.readUInt16LE(k)).filter((x) => x < N), maxDivergenceBps: gen.readUInt16LE(8), sourcesMaxAgeS: Number(gen.readBigUInt64LE(10)) };
    return e;
  };
  const entry = (i, depth = 0) => {
    const e = { index: i, ...mapEntry(i), ...priceEntry(i) };
    if (e.mostRecentOf && depth < 2) e.sources = e.mostRecentOf.sourceEntries.map((s) => entry(s, depth + 1));
    if (e.twapSource != null && depth < 2) e.twapOver = entry(e.twapSource, depth + 1);
    return e;
  };
  const idxs = sc.priceChain.filter((x) => x !== 65535);
  const twapIdxs = sc.twapChain.filter((x) => x !== 65535);
  out.scope = {
    program: "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ",
    oraclePrices: sc.priceFeed,
    oraclePricesOwner: pAcct.value.owner,
    oraclePricesLen: pb.length,
    entries: N,
    oracleMappings: mappingsPk,
    oracleMappingsOwner: mAcct.value.owner,
    oracleMappingsLen: mb.length,
    readSlot: pAcct.context.slot,
    oracleTypeTable: names,
    zecPriceChain: sc.priceChain,
    zecTwapChain: sc.twapChain,
    zecEntries: idxs.map((i) => entry(i)),
    zecTwapEntries: twapIdxs.map((i) => entry(i)),
    usdcEntries: out.reserves.USDC.oracle.scope.priceChain.filter((x) => x !== 65535).map((i) => entry(i)),
    usdcTwapEntries: out.reserves.USDC.oracle.scope.twapChain.filter((x) => x !== 65535).map((i) => entry(i)),
  };
  // Who owns the Chainlink-typed source's price account?
  const chainlinkSrc = out.scope.zecEntries.flatMap((e) => e.sources ?? []).find((s) => s.priceTypeCode === 26);
  if (chainlinkSrc) {
    await sleep(400);
    const ca = await raw("getAccountInfo", [chainlinkSrc.priceInfoAccount, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 } }]);
    out.scope.chainlinkSourceAccount = { address: chainlinkSrc.priceInfoAccount, owner: ca?.value?.owner ?? null, space: ca?.value?.space ?? null };
  }
  console.log("SCOPE", JSON.stringify(out.scope, null, 1));
} catch (e) {
  out.scopeError = String(e?.stack ?? e);
  console.log("SCOPE ERROR", out.scopeError);
}

// ---------------------------------------------------------------- ZEC mint, authority, metadata
{
  await sleep(500);
  const mint = await raw("getAccountInfo", [ZEC_MINT, { encoding: "jsonParsed", commitment: "finalized" }]);
  const info = mint.value.data.parsed.info;
  const auth = info.mintAuthority;
  const authOnCurve = auth ? PublicKey.isOnCurve(new PublicKey(auth).toBytes()) : null;
  await sleep(300);
  const authAcct = auth ? await raw("getAccountInfo", [auth, { encoding: "base64", commitment: "finalized" }]) : null;
  const [metaPda] = await getProgramDerivedAddress({
    programAddress: METAPLEX,
    seeds: ["metadata", getAddressEncoder().encode(METAPLEX), getAddressEncoder().encode(ZEC_MINT)],
  });
  await sleep(300);
  const meta = await raw("getAccountInfo", [metaPda, { encoding: "base64", commitment: "finalized" }]);
  let metadata = null;
  if (meta?.value) {
    const b = Buffer.from(meta.value.data[0], "base64");
    let o = 1 + 32 + 32;
    const readStr = () => { const len = b.readUInt32LE(o); o += 4; const s = b.subarray(o, o + len).toString("utf8").replace(/\0+$/g, ""); o += len; return s; };
    const updateAuthority = new PublicKey(b.subarray(1, 33)).toBase58();
    const name = readStr(); const symbol = readStr(); const uri = readStr();
    const sellerFeeBps = b.readUInt16LE(o); o += 2;
    const hasCreators = b[o]; o += 1;
    let creators = [];
    if (hasCreators) { const n = b.readUInt32LE(o); o += 4; for (let k = 0; k < n; k++) { creators.push({ address: new PublicKey(b.subarray(o, o + 32)).toBase58(), verified: !!b[o + 32], share: b[o + 33] }); o += 34; } }
    const primarySaleHappened = !!b[o]; o += 1;
    const isMutable = !!b[o]; o += 1;
    metadata = { pda: metaPda, updateAuthority, name, symbol, uri, sellerFeeBps, creators, primarySaleHappened, isMutable };
  }
  out.zecMint = {
    mint: ZEC_MINT,
    owner: mint.value.owner,
    decimals: info.decimals,
    supply: info.supply,
    supplyUi: new Decimal(info.supply).div(1e8).toString(),
    mintAuthority: auth,
    mintAuthorityOnCurve: authOnCurve,
    mintAuthorityIsPda: auth ? !authOnCurve : null,
    mintAuthorityAccount: authAcct?.value ? { owner: authAcct.value.owner, lamports: authAcct.value.lamports, dataLen: Buffer.from(authAcct.value.data[0], "base64").length, executable: authAcct.value.executable } : null,
    freezeAuthority: info.freezeAuthority,
    metadata,
  };
  console.log("ZEC MINT", JSON.stringify(out.zecMint, null, 1));

  // Minting program and upgrade authorities: see mints.mjs / mints.json (read from the mint authority's own signatures).
}

// ---------------------------------------------------------------- USDC mint facts
{
  await sleep(400);
  const m = await raw("getAccountInfo", [USDC_MINT, { encoding: "jsonParsed", commitment: "finalized" }]);
  const i = m.value.data.parsed.info;
  out.usdcMint = { mint: USDC_MINT, decimals: i.decimals, supplyUi: new Decimal(i.supply).div(1e6).toString(), mintAuthority: i.mintAuthority, freezeAuthority: i.freezeAuthority };
  console.log("USDC MINT", out.usdcMint);
}

// ---------------------------------------------------------------- obligations under the market
{
  await sleep(500);
  const span = klend.Obligation.layout.span + 8;
  const obs = await raw("getProgramAccounts", [
    KLEND,
    { encoding: "base64", commitment: "finalized", filters: [{ dataSize: span }, { memcmp: { offset: 32, bytes: MARKET } }] },
  ]);
  const rows = [];
  for (const o of obs) {
    const ob = klend.Obligation.decode(Buffer.from(o.account.data[0], "base64"));
    const oj = ob.toJSON();
    const deposits = oj.deposits.filter((d) => d.depositReserve !== "11111111111111111111111111111111");
    const borrows = oj.borrows.filter((b) => b.borrowReserve !== "11111111111111111111111111111111");
    rows.push({
      address: o.pubkey,
      owner: oj.owner,
      tag: oj.tag,
      depositedValueUsd: sf(oj.depositedValueSf).toFixed(2),
      borrowedAssetsMarketValueUsd: sf(oj.borrowedAssetsMarketValueSf).toFixed(2),
      allowedBorrowValueUsd: sf(oj.allowedBorrowValueSf).toFixed(2),
      unhealthyBorrowValueUsd: sf(oj.unhealthyBorrowValueSf).toFixed(2),
      deposits: deposits.map((d) => ({ reserve: d.depositReserve, depositedAmount: d.depositedAmount.toString(), marketValueUsd: sf(d.marketValueSf).toFixed(2) })),
      borrows: borrows.map((b) => ({ reserve: b.borrowReserve, borrowedAmountSf: sf(b.borrowedAmountSf).toFixed(2), marketValueUsd: sf(b.marketValueSf).toFixed(2) })),
      lastUpdateSlot: oj.lastUpdate.slot.toString(),
    });
  }
  // Principal-based view (exact amounts at each obligation's last refresh, not USD snapshots):
  // USDC debt from borrows[].borrowedAmountSf on the USDC reserve; ZEC collateral from deposits[].depositedAmount
  // (cToken units; the ZEC collateral mint supply equals the liquidity supply 1:1 since ZEC is never lent).
  const usdcRes = out.reserves.USDC.address, zecRes = out.reserves.ZEC.address;
  for (const r of rows) {
    r.usdcDebt = r.borrows.filter((b) => b.reserve === usdcRes).reduce((s, b) => s + Number(b.borrowedAmountSf) / 1e6, 0);
    r.zecDeposited = r.deposits.filter((d) => d.reserve === zecRes).reduce((s, d) => s + Number(d.depositedAmount) / 1e8, 0);
  }
  rows.sort((a, b) => b.usdcDebt - a.usdcDebt);
  const withDebt = rows.filter((r) => r.usdcDebt > 0);
  const totDebt = withDebt.reduce((s, r) => s + r.usdcDebt, 0);
  const totZec = rows.reduce((s, r) => s + r.zecDeposited, 0);
  const totDepUsd = rows.reduce((s, r) => s + Number(r.depositedValueUsd), 0);
  const share = (n) => ((withDebt.slice(0, n).reduce((s, r) => s + r.usdcDebt, 0) / totDebt) * 100).toFixed(1);
  out.obligations = {
    obligationSpanBytes: span,
    count: rows.length,
    countWithDebt: withDebt.length,
    totalZecDepositedAcrossObligations: totZec.toFixed(8),
    totalUsdcDebtAcrossObligations: totDebt.toFixed(2),
    totalDepositedValueUsdAtLastRefresh: totDepUsd.toFixed(0),
    top5ByUsdcDebt: withDebt.slice(0, 5).map((r) => ({ address: r.address, usdcDebt: r.usdcDebt.toFixed(2), zecDeposited: r.zecDeposited.toFixed(4), sharePct: ((r.usdcDebt / totDebt) * 100).toFixed(1), lastUpdateSlot: r.lastUpdateSlot })),
    top1DebtSharePct: share(1),
    top5DebtSharePct: share(5),
    top10DebtSharePct: share(10),
  };
  console.log("OBLIGATIONS", JSON.stringify(out.obligations, null, 1));
}

import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(new URL("../.facts/", import.meta.url), { recursive: true });
writeFileSync(new URL("../.facts/facts.json", import.meta.url), JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log("WROTE solana/.facts/facts.json");
