/**
 * A borrow on Kamino's ZCASH market, judged the way BUILD-PLAN-2026-09-12 D4/D5 ask: refusals are SAFETY only
 * (the venue paused or borrowing disabled, a reserve not active, a stale or out-of-band oracle, a borrow the
 * pool cannot fund or its limits forbid, a deposit above the reserve's cap, the entry floor the program enforces,
 * a stale read); everything else — the rate after this borrow, the pool's depth, the account's share, the
 * liquidation price at the chosen HF — is SHOWN with its slot and date. Pure: the server hands it the last
 * Kamino sample and the query. SOLANA-ARCHITECTURE.md §7 / §8.
 *
 * The identity (BUILD-PLAN §2b): debt = collateral × LT ÷ HF, so HF at entry = collateral × LT ÷ debt. Kamino's
 * own LTV cap (40 % on ZEC, LT 65 %) binds every position at HF ≥ 1.625 whatever the registry floor; the view
 * names which limit binds.
 */
import { kaminoCurveAprBps } from "@zyo/shared";
import type { KaminoSample, WithdrawalCaps } from "./sources/kamino.js";

export type SolanaBorrowRefusal =
  | "kamino_unavailable"
  | "kamino_stale"
  | "venue_paused"
  | "borrow_disabled"
  | "reserve_not_active"
  | "oracle_stale"
  | "oracle_out_of_band"
  | "entry_hf_below_floor"
  | "venue_ltv_exceeded"
  | "pool_cannot_fund"
  | "borrow_limit_reached"
  | "borrow_cap_24h_reached"
  | "utilization_limit_reached"
  | "deposit_limit_reached";

/** Which limit decides the borrow the view suggests. */
export type SolanaBindingCap = "venue_max_ltv" | "chosen_hf" | "entry_hf_floor" | "pool_liquidity" | "borrow_limit" | "borrow_cap_24h";

/** Ids of the disclosures the site must show with this view; the words live in web/lib (copy rules apply there). */
export type SolanaDisclosureId =
  | "forecast_not_advice"
  | "bridged_zec"
  | "kamino_parameters_mutable"
  | "usdc_freezable"
  | "program_exit_only"
  | "borrow_rate_moves"
  | "liquidation_at_chosen_hf";

export interface SolanaBorrowQuery {
  /** ZEC the user would deposit (whole tokens); null = pool view only. */
  collateralZec: number | null;
  /** USDC the user would borrow (whole tokens); null = let the view suggest one from the HF. */
  amountUsdc: number | null;
  /** The entry HF the user chose (the slider); null = the venue's cap bounded by the floor. */
  entryHf: number | null;
}

export interface SolanaBorrowInputs extends SolanaBorrowQuery {
  sample: (KaminoSample & { stale: boolean }) | null;
  entryHfFloor: number;
}

export interface SolanaBorrowView {
  chain: "solana";
  venue: "kamino-zcash-market";
  sampledAt: string | null;
  slot: number | null;
  stale: boolean;
  entryHf: number | null;
  entryHfFloor: number;

  // --- the venue's own constants, read live ---
  ltvCapBps: number | null;
  liquidationThresholdBps: number | null;
  /** LT ÷ LTV cap: the HF every Kamino position starts at or above (1.625 today). */
  hfAtVenueCap: number | null;

  // --- prices (Scope, the oracle the reserves read) ---
  zecPriceUsd: number | null;
  usdcPriceUsd: number | null;
  oracleAgeS: number | null;
  oracleMaxAgeS: number | null;

  // --- the USDC pool ---
  poolAvailableUsdc: number | null;
  poolBorrowedUsdc: number | null;
  poolSupplyUsdc: number | null;
  borrowLimitUsdc: number | null;
  remainingBorrowLimitUsdc: number | null;
  /** Room left in the venue's per-interval borrow cap (null when the venue has none). */
  remaining24hBorrowUsdc: number | null;
  /** min(available, remaining borrow limit, remaining 24 h cap): the most this pool can lend to anyone right now. */
  maxFundableUsdc: number | null;
  utilizationNowPct: number | null;
  borrowAprNowPct: number | null;

  // --- the ZEC side ---
  depositLimitZec: number | null;
  remainingDepositZec: number | null;
  /** Room left in the venue's per-interval WITHDRAWAL cap (what an exit could take out right now). */
  remaining24hWithdrawZec: number | null;
  collateralZec: number | null;
  collateralUsd: number | null;
  borrowAtVenueCapUsdc: number | null;
  borrowAtFloorUsdc: number | null;
  borrowAtChosenHfUsdc: number | null;
  /** The borrow the view proposes for this collateral: the chosen HF (or the floor), inside the venue's cap and the pool's depth. */
  borrowSuggestedUsdc: number | null;
  bindingCap: SolanaBindingCap | null;

  // --- the borrow the user typed (or the suggested one) ---
  amountUsdc: number | null;
  hfAtEntry: number | null;
  ltvAtEntryBps: number | null;
  liquidationPriceUsd: number | null;
  drawdownToLiquidationPct: number | null;
  utilizationAfterPct: number | null;
  /** The curve re-priced with this borrow added: what the depositor will pay. */
  borrowAprAfterPct: number | null;
  /** This account's share of the pool's debt after the borrow. */
  poolSharePctAfter: number | null;

  refusals: SolanaBorrowRefusal[];
  allowed: boolean;
  disclosures: SolanaDisclosureId[];
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
const units = (x: number, decimals: number): bigint => BigInt(Math.round(x * 10 ** decimals));
const whole = (u: bigint, decimals: number): number => Number(u) / 10 ** decimals;

/** Room left under a klend `WithdrawalCaps` at chain time `nowS`; null when the cap is off (capacity ≤ 0). */
export function capRoom(cap: WithdrawalCaps, nowS: number): bigint | null {
  if (cap.configCapacity <= 0n) return null;
  const elapsed = BigInt(nowS) - cap.lastIntervalStartTimestamp;
  const current = cap.configIntervalLengthSeconds > 0n && elapsed >= cap.configIntervalLengthSeconds ? 0n : cap.currentTotal;
  const room = cap.configCapacity - current;
  return room < 0n ? 0n : room;
}

/** Utilisation in bps after adding `extra` to the borrowed side (supply unchanged). */
function utilizationBps(available: bigint, borrowed: bigint, extra: bigint): number {
  const supply = available + borrowed;
  if (supply <= 0n) return 10_000;
  const u = Math.round((Number(borrowed + extra) / Number(supply)) * 10_000);
  return Math.max(0, Math.min(10_000, u));
}

export function evaluateSolanaBorrow(input: SolanaBorrowInputs): SolanaBorrowView {
  const { sample, entryHfFloor } = input;
  const refusals: SolanaBorrowRefusal[] = [];
  const disclosures = new Set<SolanaDisclosureId>(["forecast_not_advice", "bridged_zec", "kamino_parameters_mutable", "usdc_freezable", "program_exit_only", "borrow_rate_moves"]);
  const view: SolanaBorrowView = {
    chain: "solana",
    venue: "kamino-zcash-market",
    sampledAt: sample?.sampledAt ?? null,
    slot: sample?.slot ?? null,
    stale: sample?.stale ?? true,
    entryHf: input.entryHf,
    entryHfFloor,
    ltvCapBps: null,
    liquidationThresholdBps: null,
    hfAtVenueCap: null,
    zecPriceUsd: null,
    usdcPriceUsd: null,
    oracleAgeS: null,
    oracleMaxAgeS: null,
    poolAvailableUsdc: null,
    poolBorrowedUsdc: null,
    poolSupplyUsdc: null,
    borrowLimitUsdc: null,
    remainingBorrowLimitUsdc: null,
    remaining24hBorrowUsdc: null,
    maxFundableUsdc: null,
    utilizationNowPct: null,
    borrowAprNowPct: null,
    depositLimitZec: null,
    remainingDepositZec: null,
    remaining24hWithdrawZec: null,
    collateralZec: input.collateralZec,
    collateralUsd: null,
    borrowAtVenueCapUsdc: null,
    borrowAtFloorUsdc: null,
    borrowAtChosenHfUsdc: null,
    borrowSuggestedUsdc: null,
    bindingCap: null,
    amountUsdc: input.amountUsdc,
    hfAtEntry: null,
    ltvAtEntryBps: null,
    liquidationPriceUsd: null,
    drawdownToLiquidationPct: null,
    utilizationAfterPct: null,
    borrowAprAfterPct: null,
    poolSharePctAfter: null,
    refusals,
    allowed: false,
    disclosures: [],
  };
  const finish = (): SolanaBorrowView => {
    if (input.entryHf !== null || input.amountUsdc !== null) disclosures.add("liquidation_at_chosen_hf");
    view.disclosures = [...disclosures];
    view.allowed = refusals.length === 0;
    return view;
  };
  if (input.entryHf !== null && !(Number.isFinite(input.entryHf) && input.entryHf >= 1)) throw new RangeError(`entryHf must be ≥ 1, got ${input.entryHf}`);
  if (input.collateralZec !== null && !(Number.isFinite(input.collateralZec) && input.collateralZec > 0)) throw new RangeError("collateralZec must be > 0");
  if (input.amountUsdc !== null && !(Number.isFinite(input.amountUsdc) && input.amountUsdc > 0)) throw new RangeError("amountUsdc must be > 0");
  if (input.entryHf !== null && input.entryHf < entryHfFloor) refusals.push("entry_hf_below_floor");

  // ---- 1. Safety: the read itself, the venue's flags, the oracle --------------------------------------------
  if (!sample) {
    refusals.push("kamino_unavailable");
    return finish();
  }
  if (sample.stale) {
    // A read past staleAfterMs is refused and shows NO number derived from it (Base's rates_stale rule).
    refusals.push("kamino_stale");
    return finish();
  }
  const { market, zec, usdc, scopeZec, scopeUsdc } = sample;
  if (market.emergencyMode !== 0) refusals.push("venue_paused");
  if (market.borrowDisabled !== 0) refusals.push("borrow_disabled");
  if (zec.status !== 0 || usdc.status !== 0) refusals.push("reserve_not_active");
  const oracleAgeS = sample.chainTimeS - Number(scopeZec.unixTimestamp);
  view.oracleAgeS = oracleAgeS;
  view.oracleMaxAgeS = zec.maxAgePriceSeconds;
  if (oracleAgeS > zec.maxAgePriceSeconds || oracleAgeS < -300) refusals.push("oracle_stale");
  const zecUsd = scopeZec.priceUsd;
  const usdcUsd = scopeUsdc.priceUsd;
  view.zecPriceUsd = zecUsd;
  view.usdcPriceUsd = usdcUsd;
  if (!(zecUsd >= zec.heuristicLowerUsd && zecUsd <= zec.heuristicUpperUsd) || !(usdcUsd >= usdc.heuristicLowerUsd && usdcUsd <= usdc.heuristicUpperUsd)) refusals.push("oracle_out_of_band");

  // ---- 2. The venue's constants and the pool as it is ----------------------------------------------------------
  const ltvBps = zec.loanToValuePct * 100;
  const ltBps = zec.liquidationThresholdPct * 100;
  view.ltvCapBps = ltvBps;
  view.liquidationThresholdBps = ltBps;
  view.hfAtVenueCap = ltvBps > 0 ? round4(ltBps / ltvBps) : null;
  const uDec = usdc.mintDecimals;
  const zDec = zec.mintDecimals;
  const available = usdc.availableUnits;
  const borrowed = usdc.borrowedUnits;
  view.poolAvailableUsdc = round2(whole(available, uDec));
  view.poolBorrowedUsdc = round2(whole(borrowed, uDec));
  view.poolSupplyUsdc = round2(whole(available + borrowed, uDec));
  view.borrowLimitUsdc = round2(whole(usdc.borrowLimitUnits, uDec));
  const limitRoom = usdc.borrowLimitUnits > borrowed ? usdc.borrowLimitUnits - borrowed : 0n;
  view.remainingBorrowLimitUsdc = round2(whole(limitRoom, uDec));
  const capRoomUsdc = capRoom(usdc.debtWithdrawalCap, sample.chainTimeS);
  view.remaining24hBorrowUsdc = capRoomUsdc === null ? null : round2(whole(capRoomUsdc, uDec));
  let fundable = available;
  let fundableBy: SolanaBindingCap = "pool_liquidity";
  if (limitRoom < fundable) {
    fundable = limitRoom;
    fundableBy = "borrow_limit";
  }
  if (capRoomUsdc !== null && capRoomUsdc < fundable) {
    fundable = capRoomUsdc;
    fundableBy = "borrow_cap_24h";
  }
  view.maxFundableUsdc = round2(whole(fundable, uDec));
  const utilNow = utilizationBps(available, borrowed, 0n);
  view.utilizationNowPct = round4(utilNow / 100);
  view.borrowAprNowPct = round4(kaminoCurveAprBps(usdc.borrowRateCurve, utilNow) / 100);
  const zecSupply = zec.availableUnits + zec.borrowedUnits;
  view.depositLimitZec = round4(whole(zec.depositLimitUnits, zDec));
  view.remainingDepositZec = round4(whole(zec.depositLimitUnits > zecSupply ? zec.depositLimitUnits - zecSupply : 0n, zDec));
  const withdrawRoom = capRoom(zec.depositWithdrawalCap, sample.chainTimeS);
  view.remaining24hWithdrawZec = withdrawRoom === null ? null : round4(whole(withdrawRoom, zDec));

  // ---- 3. The collateral, and the borrow it supports ---------------------------------------------------------
  let collateralUsd: number | null = null;
  if (input.collateralZec !== null) {
    const cUnits = units(input.collateralZec, zDec);
    if (zecSupply + cUnits > zec.depositLimitUnits) refusals.push("deposit_limit_reached");
    collateralUsd = input.collateralZec * zecUsd;
    view.collateralUsd = round2(collateralUsd);
    const capUsd = (collateralUsd * ltvBps) / 10_000;
    const floorUsd = (collateralUsd * ltBps) / 10_000 / entryHfFloor;
    const chosenUsd = input.entryHf !== null ? (collateralUsd * ltBps) / 10_000 / input.entryHf : null;
    view.borrowAtVenueCapUsdc = round2(capUsd / usdcUsd);
    view.borrowAtFloorUsdc = round2(floorUsd / usdcUsd);
    view.borrowAtChosenHfUsdc = chosenUsd === null ? null : round2(chosenUsd / usdcUsd);
    // the proposal: the chosen HF (else the floor), then the venue's cap, then what the pool can lend
    let suggestedUsd = chosenUsd ?? floorUsd;
    let binding: SolanaBindingCap = chosenUsd === null ? "entry_hf_floor" : "chosen_hf";
    if (capUsd < suggestedUsd) {
      suggestedUsd = capUsd;
      binding = "venue_max_ltv";
    }
    const fundableUsd = whole(fundable, uDec) * usdcUsd;
    if (fundableUsd < suggestedUsd) {
      suggestedUsd = fundableUsd;
      binding = fundableBy;
    }
    view.borrowSuggestedUsdc = round2(suggestedUsd / usdcUsd);
    view.bindingCap = binding;
  }

  // ---- 4. The borrow itself: the typed amount, else the suggested one ----------------------------------------
  const amount = input.amountUsdc ?? view.borrowSuggestedUsdc;
  if (amount !== null && amount > 0) {
    const aUnits = units(amount, uDec);
    if (aUnits > available) refusals.push("pool_cannot_fund");
    if (borrowed + aUnits > usdc.borrowLimitUnits) refusals.push("borrow_limit_reached");
    if (capRoomUsdc !== null && aUnits > capRoomUsdc) refusals.push("borrow_cap_24h_reached");
    const utilAfter = utilizationBps(available, borrowed, aUnits);
    if (usdc.utilizationLimitBlockBorrowingAbovePct > 0 && utilAfter > usdc.utilizationLimitBlockBorrowingAbovePct * 100) refusals.push("utilization_limit_reached");
    view.utilizationAfterPct = round4(utilAfter / 100);
    view.borrowAprAfterPct = round4(kaminoCurveAprBps(usdc.borrowRateCurve, utilAfter) / 100);
    const debtAfter = borrowed + aUnits;
    view.poolSharePctAfter = debtAfter > 0n ? round4(Number((aUnits * 1_000_000n) / debtAfter) / 10_000) : null;
    if (collateralUsd !== null && input.collateralZec !== null) {
      const debtUsd = amount * usdcUsd;
      const hf = (collateralUsd * ltBps) / 10_000 / debtUsd;
      view.amountUsdc = round2(amount);
      view.hfAtEntry = round4(hf);
      view.ltvAtEntryBps = Math.round((debtUsd / collateralUsd) * 10_000);
      view.liquidationPriceUsd = round4(debtUsd / ((input.collateralZec * ltBps) / 10_000));
      view.drawdownToLiquidationPct = round2(100 * (1 - 1 / hf));
      if (input.amountUsdc !== null) {
        if (hf < entryHfFloor * (1 - 1e-9) && !refusals.includes("entry_hf_below_floor")) refusals.push("entry_hf_below_floor");
        if (debtUsd > (collateralUsd * ltvBps) / 10_000 + 1e-6) refusals.push("venue_ltv_exceeded");
      }
    }
  }
  return finish();
}
