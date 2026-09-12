/**
 * Client for the yield service's FORECAST: GET /v1/forecast (services/yield/src/forecast.ts).
 *
 * Since 2026-09-12 (BUILD-PLAN-2026-09-12 D4/D5/D7, step A3) the yield model is information, not a
 * gate: every curated pool × setting is shown with both LP-net forms, the gap between them, the
 * impermanent-loss drag, the break-evens, the user's net at the LTV they chose, and the drawdown to
 * liquidation — and may be opened after an acknowledgment that names those numbers. The ONLY
 * refusals are the safety ones the service reports in `refusals` (registry floor, a borrow the pool
 * cannot fund, stale rates, a paused or inactive reserve, a disabled asset, the venue's own LTV).
 *
 * The service is numbers; this file is the words. Every sentence here passes test/copy.test.ts.
 */
import { CURATED_POOLS, ltvPresets, type CollateralSymbol, type CuratedPool, type NamedRangePreset } from "@zyo/shared";
import type { GateEntry, GateSettingId } from "./gate";

export type ForecastRefusal =
  | "entry_hf_below_floor"
  | "collateral_disabled"
  | "rates_unavailable"
  | "rates_stale"
  | "collateral_not_active"
  | "collateral_paused"
  | "borrow_paused"
  | "venue_ltv_exceeded"
  | "pool_cannot_fund";

export type ForecastDisclosureId =
  | "forecast_not_advice"
  | "model_uncertainty"
  | "no_forecast"
  | "emissions_dilutable"
  | "borrow_rate_moves"
  | "liquidation_at_chosen_hf"
  | "impermanent_loss";

export interface ForecastCell {
  poolId: string;
  pool: CuratedPool;
  setting: GateSettingId;
  preset: NamedRangePreset;
  collateral: CollateralSymbol;
  rangeWidthBps: number;
  halfWidth: number;
  rebalanceDelayHours: number;
  entryHf: number;
  entryHfFloor: number;
  liquidationThresholdBps: number | null;
  ltvAtEntryBps: number | null;
  venueMaxLtvBps: number | null;
  bindingCap: string | null;
  drawdownToLiquidationPct: number;
  collateralPriceUsd: number | null;
  liquidationPriceUsd: number | null;
  depositUsd: number | null;
  borrowUsd: number | null;
  borrowAprNowPct: number | null;
  borrowAprAfterPct: number | null;
  userNetBorrowBasis: "after" | "now" | null;
  poolAvailableUsd: number | null;
  collateralSupplyAprPct: number | null;
  lpPriced: boolean;
  lpUnpricedReason: string | null;
  emissionsGrossPct: number | null;
  emissionsNetPct: number | null;
  emissionsRealizedPct: number | null;
  dragPct: number | null;
  lpNetPct: number | null;
  mcLpNetPct: number | null;
  mcUnavailableReason: string | null;
  modelGapPts: number | null;
  sigma: number | null;
  breakEvenSigma: number | null;
  breakEvenEmissionsMultiple: number | null;
  userNetPct: number | null;
  mcUserNetPct: number | null;
  clearsBorrow: { closedForm: boolean | null; monteCarlo: boolean | null; both: boolean | null };
  refusals: ForecastRefusal[];
  allowed: boolean;
  disclosures: ForecastDisclosureId[];
  /** The payload this cell came from was stale. */
  stale: boolean;
}

export interface ForecastView {
  generatedAt: string;
  entryHf: number;
  entryHfFloor: number;
  depositUsd: number | null;
  borrowAprPct: number | null;
  ratesSampledAt: string;
  emissionsSampledAt: string;
  volatilityAsOf: string;
  engineFeeBps: number | null;
  mcCalibrationGeneratedAt: string;
  settings: { id: GateSettingId; preset: NamedRangePreset; rebalanceDelayHours: number }[];
  cells: ForecastCell[];
  source: "live" | "demo";
  stale: boolean;
  /** Set when the service could not be reached at all (network, non-2xx) — the demo snapshot is shown instead and labelled. */
  unavailableReason?: string;
}

// ---------------------------------------------------------------------------
// The words
// ---------------------------------------------------------------------------

/** One plain sentence per safety refusal — the only reasons a position may not be opened. */
const REFUSAL_PLAIN: Record<ForecastRefusal, string> = {
  entry_hf_below_floor: "This health factor is under the floor Oilskin's registry sets, so the contracts would refuse the borrow.",
  collateral_disabled: "Oilskin does not accept this asset as collateral right now.",
  rates_unavailable: "We could not read what borrowing costs today, and nothing opens without that number.",
  rates_stale: "Our reading of the borrowing cost is too old to trust; nothing opens until it refreshes.",
  collateral_not_active: "Aave is not accepting this asset as collateral right now.",
  collateral_paused: "Aave has paused this collateral, so nothing can be supplied or borrowed against it until they unpause it.",
  borrow_paused: "Aave has paused USDC borrowing, so there is nothing to borrow right now.",
  venue_ltv_exceeded: "This borrow is above the largest loan-to-value the lending venue itself allows for this asset.",
  pool_cannot_fund: "The lending pool does not hold enough USDC to lend this much right now.",
};

/** Why the LP slice has no number — shown beside the cell, never a reason to refuse it. */
const UNPRICED_PLAIN: Record<string, string> = {
  rates_unavailable: "We could not read the borrow rate, so the comparison against it is missing.",
  rates_stale: "Our reading of the borrow rate is too old to compare against.",
  emissions_unavailable: "We could not read what this pool is paying out, so its return cannot be priced.",
  emissions_stale: "Our reading of what this pool pays is too old to price with.",
  no_emissions: "This pool is not paying any rewards at the moment.",
  staked_liquidity_outlier: "The reading we got for this pool does not match its history, so we are treating it as wrong rather than as a number.",
  insufficient_samples: "We have not seen enough independent readings of this pool to trust the one we have.",
  no_staked_liquidity: "Nobody is providing liquidity at this width, so there is no reliable number to price it with.",
  emissions_implausible: "The rewards this pool appears to pay are too high to be real, so we are treating the reading as broken rather than as a return.",
  no_volatility_input: "We have no trusted volatility figure for this pair, so the loss from the price moving cannot be priced.",
  net_out_of_bounds: "The numbers came out far outside the range this model is trusted in, so we are treating them as broken.",
};

/** The disclosures the forecast asks the site to show, in plain words. */
export const DISCLOSURE_TEXT: Record<ForecastDisclosureId, string> = {
  forecast_not_advice: "This is a forecast from a model, not advice and not a promise. Do your own research before you put money in; the numbers can be wrong, and they will change.",
  model_uncertainty: "Two models price the same position and they disagree: the simpler one ignores the time your money spends outside the price range and is the more optimistic of the two. Both are shown; the gap between them is the model's own uncertainty.",
  no_forecast: "The model could not price this pool today, so there is no forecast to read — only the borrow cost and the liquidation math.",
  emissions_dilutable: "The rewards are AERO emissions that Aerodrome's weekly vote can cut to zero, and that anyone else staking in the same pool dilutes.",
  borrow_rate_moves: "The borrow rate is variable. It moves with the pool's utilisation, including with your own borrow, and a position that looks one way today can look another way tomorrow.",
  liquidation_at_chosen_hf: "If your collateral falls by the drawdown shown, the lending venue liquidates the position and sells collateral at its penalty. Oilskin's keeper acts earlier only while its permission is live.",
  impermanent_loss: "A concentrated-liquidity position changes token mix as the price moves and can be worth less than holding. The model charges for that as the drag shown.",
};

export function refusalPlain(r: ForecastRefusal | string): string {
  return REFUSAL_PLAIN[r as ForecastRefusal] ?? "The contracts would refuse this position for a reason this page has no words for yet.";
}
export function unpricedPlain(reason: string | null): string {
  if (!reason) return "";
  return UNPRICED_PLAIN[reason] ?? "The model could not price this pool today.";
}
/** Every refusal the UI has copy for — the drift test asserts it covers the service's union. */
export const KNOWN_REFUSALS: readonly string[] = Object.keys(REFUSAL_PLAIN);
export const KNOWN_UNPRICED: readonly string[] = Object.keys(UNPRICED_PLAIN);

/**
 * The sentence the user ticks before a new position. It names the numbers they chose, in words a
 * first-time user can read; never a code, never a promise. Hold and spot get the loan half only.
 */
export function acknowledgmentText(input: {
  strategy: "lp" | "hold" | "spot";
  collateral: string;
  cell: ForecastCell | null;
  borrowAprPct: number;
  drawdownToLiquidationPct: number;
}): string {
  const { strategy, collateral, cell, borrowAprPct, drawdownToLiquidationPct } = input;
  const dd = `a ${drawdownToLiquidationPct.toFixed(1)}% fall in ${collateral} would liquidate this position`;
  const rate = `the loan costs ${borrowAprPct.toFixed(2)}% a year today and that rate moves`;
  if (strategy !== "lp" || !cell) {
    return `I have read the numbers: ${rate}, ${dd}, and nothing here is advice or a promise. I choose to open it.`;
  }
  const pair = `${cell.pool.token0}/${cell.pool.token1}`;
  if (!cell.lpPriced || cell.lpNetPct === null) {
    return `I have read the numbers: the model could not price ${pair} today, so I am opening it without a forecast; ${rate}; ${dd}; nothing here is advice or a promise. I choose to open it.`;
  }
  const mc = cell.mcLpNetPct === null ? "the stricter model has no number for it" : `the stricter model says ${fmtSigned(cell.mcLpNetPct)}%`;
  return `I have read the forecast: on ${pair} the model projects ${fmtSigned(cell.lpNetPct)}% a year on the deployed USDC (${mc}); ${rate}; ${dd}; nothing here is advice or a promise. I choose to open it.`;
}
function fmtSigned(x: number): string {
  return `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Normalisation and fetch
// ---------------------------------------------------------------------------

const SETTING_IDS: GateSettingId[] = ["sheltered", "steady", "working"];
const PRESETS: NamedRangePreset[] = ["CONSERVATIVE", "MODERATE", "AGGRESSIVE"];
function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function str(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}
function strOrNull(x: unknown): string | null {
  return typeof x === "string" ? x : null;
}
function boolOrNull(x: unknown): boolean | null {
  return typeof x === "boolean" ? x : null;
}

/** Normalise a /v1/forecast payload. Unreadable cells are dropped; a cell is never invented. */
export function normalizeForecast(raw: unknown, source: ForecastView["source"]): ForecastView {
  const r = (raw ?? {}) as Record<string, unknown>;
  const stale = r.stale === true;
  const settingsRaw = (Array.isArray(r.settings) ? r.settings : []) as Record<string, unknown>[];
  const settings = settingsRaw
    .map((s) => ({ id: str(s.id) as GateSettingId, preset: str(s.preset) as NamedRangePreset, rebalanceDelayHours: num(s.rebalanceDelayHours) ?? 0 }))
    .filter((s) => SETTING_IDS.includes(s.id) && PRESETS.includes(s.preset));
  const delayFor = (id: GateSettingId) => settings.find((s) => s.id === id)?.rebalanceDelayHours ?? 0;
  const entryHf = num(r.entryHf) ?? NaN;
  const entryHfFloor = num(r.entryHfFloor) ?? NaN;

  const cells: ForecastCell[] = [];
  for (const c of (Array.isArray(r.cells) ? r.cells : []) as Record<string, unknown>[]) {
    const pool = CURATED_POOLS.find((p) => p.id === c.poolId);
    const setting = c.setting as GateSettingId;
    const preset = c.preset as NamedRangePreset;
    const collateral = c.collateral as CollateralSymbol;
    const rangeWidthBps = num(c.rangeWidthBps);
    const halfWidth = num(c.halfWidth);
    const drawdown = num(c.drawdownToLiquidationPct);
    if (!pool || !SETTING_IDS.includes(setting) || !PRESETS.includes(preset) || !collateral || rangeWidthBps === null || halfWidth === null || drawdown === null) continue;
    const cb = (c.clearsBorrow ?? {}) as Record<string, unknown>;
    const refusals = (Array.isArray(c.refusals) ? c.refusals : []).filter((x): x is ForecastRefusal => typeof x === "string") as ForecastRefusal[];
    const disclosures = (Array.isArray(c.disclosures) ? c.disclosures : []).filter((x): x is ForecastDisclosureId => typeof x === "string" && x in DISCLOSURE_TEXT);
    // `allowed` is re-derived from the refusal list, never trusted as a flag; a stale payload never allows anything.
    const allowed = refusals.length === 0 && !stale;
    cells.push({
      poolId: pool.id,
      pool,
      setting,
      preset,
      collateral,
      rangeWidthBps,
      halfWidth,
      rebalanceDelayHours: delayFor(setting),
      entryHf: num(c.entryHf) ?? entryHf,
      entryHfFloor: num(c.entryHfFloor) ?? entryHfFloor,
      liquidationThresholdBps: num(c.liquidationThresholdBps),
      ltvAtEntryBps: num(c.ltvAtEntryBps),
      venueMaxLtvBps: num(c.venueMaxLtvBps),
      bindingCap: strOrNull(c.bindingCap),
      drawdownToLiquidationPct: drawdown,
      collateralPriceUsd: num(c.collateralPriceUsd),
      liquidationPriceUsd: num(c.liquidationPriceUsd),
      depositUsd: num(c.depositUsd),
      borrowUsd: num(c.borrowUsd),
      borrowAprNowPct: num(c.borrowAprNowPct),
      borrowAprAfterPct: num(c.borrowAprAfterPct),
      userNetBorrowBasis: c.userNetBorrowBasis === "after" || c.userNetBorrowBasis === "now" ? c.userNetBorrowBasis : null,
      poolAvailableUsd: num(c.poolAvailableUsd),
      collateralSupplyAprPct: num(c.collateralSupplyAprPct),
      lpPriced: c.lpPriced === true && num(c.lpNetPct) !== null,
      lpUnpricedReason: strOrNull(c.lpUnpricedReason),
      emissionsGrossPct: num(c.emissionsGrossPct),
      emissionsNetPct: num(c.emissionsNetPct),
      emissionsRealizedPct: num(c.emissionsRealizedPct),
      dragPct: num(c.dragPct),
      lpNetPct: num(c.lpNetPct),
      mcLpNetPct: num(c.mcLpNetPct),
      mcUnavailableReason: strOrNull(c.mcUnavailableReason),
      modelGapPts: num(c.modelGapPts),
      sigma: num(c.sigma),
      breakEvenSigma: num(c.breakEvenSigma),
      breakEvenEmissionsMultiple: num(c.breakEvenEmissionsMultiple),
      userNetPct: num(c.userNetPct),
      mcUserNetPct: num(c.mcUserNetPct),
      clearsBorrow: { closedForm: boolOrNull(cb.closedForm), monteCarlo: boolOrNull(cb.monteCarlo), both: boolOrNull(cb.both) },
      refusals,
      allowed,
      disclosures,
      stale,
    });
  }
  return {
    generatedAt: str(r.generatedAt),
    entryHf,
    entryHfFloor,
    depositUsd: num(r.depositUsd),
    borrowAprPct: num(r.borrowAprPct),
    ratesSampledAt: str(r.ratesSampledAt),
    emissionsSampledAt: str(r.emissionsSampledAt),
    volatilityAsOf: str(r.volatilityAsOf),
    engineFeeBps: num(r.engineFeeBps),
    mcCalibrationGeneratedAt: str(r.mcCalibrationGeneratedAt),
    settings,
    cells,
    source,
    stale,
  };
}

export interface ForecastQuery {
  collateral?: CollateralSymbol;
  entryHf?: number;
  depositUsd?: number;
  pool?: string;
  setting?: GateSettingId;
}

export function forecastPath(q: ForecastQuery): string {
  const p = new URLSearchParams();
  if (q.collateral) p.set("collateral", q.collateral);
  if (q.entryHf !== undefined && Number.isFinite(q.entryHf)) p.set("entryHf", String(q.entryHf));
  if (q.depositUsd !== undefined && Number.isFinite(q.depositUsd) && q.depositUsd > 0) p.set("deposit", String(q.depositUsd));
  if (q.pool) p.set("pool", q.pool);
  if (q.setting) p.set("setting", q.setting);
  const s = p.toString();
  return `/v1/forecast${s ? `?${s}` : ""}`;
}

export async function fetchForecast(baseUrl: string, q: ForecastQuery, signal?: AbortSignal): Promise<ForecastView> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${forecastPath(q)}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`forecast ${res.status}`);
  return normalizeForecast(await res.json(), "live");
}

// ---------------------------------------------------------------------------
// Views over the cells
// ---------------------------------------------------------------------------

/** supply + LTV × (lpNet − borrow): the same identity the service uses, at the LTV the user picked. */
export function userNetAtLtv(cell: ForecastCell, ltvBps: number, lpNet: number | null = cell.lpNetPct): number | null {
  const borrow = cell.borrowAprAfterPct ?? cell.borrowAprNowPct;
  if (lpNet === null || borrow === null || cell.collateralSupplyAprPct === null) return null;
  return cell.collateralSupplyAprPct + (ltvBps / 10_000) * (lpNet - borrow);
}

/** Cells for one collateral, best user net at the given LTV first; unpriced cells last. */
export function cellsFor(view: ForecastView, collateral: CollateralSymbol, ltvBps: number): ForecastCell[] {
  const score = (c: ForecastCell) => userNetAtLtv(c, ltvBps) ?? -Infinity;
  return view.cells.filter((c) => c.collateral === collateral).sort((a, b) => score(b) - score(a) || b.rangeWidthBps - a.rangeWidthBps);
}

export function findCell(view: ForecastView, e: { poolId: string; setting: string; collateral: string }): ForecastCell | undefined {
  return view.cells.find((c) => c.poolId === e.poolId && c.setting === e.setting && c.collateral === e.collateral);
}

export function unavailableForecast(reason: string, source: ForecastView["source"]): ForecastView {
  return { generatedAt: "", entryHf: NaN, entryHfFloor: NaN, depositUsd: null, borrowAprPct: null, ratesSampledAt: "", emissionsSampledAt: "", volatilityAsOf: "", engineFeeBps: null, mcCalibrationGeneratedAt: "", settings: [], cells: [], source, stale: true, unavailableReason: reason };
}

// ---------------------------------------------------------------------------
// Bridging to the wizard's GateEntry shape (the plan, execute and review code read that shape)
// ---------------------------------------------------------------------------


/**
 * A forecast cell as the wizard's strategy entry. `qualifies` is the informational "clears the
 * borrow on both forms"; `reason` names why not, or why the LP slice is unpriced — never a block.
 * The user-net ladder is re-priced at the registry's LTV presets from the cell's own numbers.
 */
export function entryFromCell(cell: ForecastCell): GateEntry {
  const lt = cell.liquidationThresholdBps ?? 0;
  const userNet = lt > 0 ? ltvPresets(lt).map((p) => ({ ltvBps: p.ltvBps, offerable: p.offerable, userNetPct: userNetAtLtv(cell, p.ltvBps) ?? NaN })).filter((u) => Number.isFinite(u.userNetPct)) : [];
  const qualifies = cell.clearsBorrow.both === true && !cell.stale;
  const reason = qualifies
    ? null
    : !cell.lpPriced
      ? (cell.lpUnpricedReason ?? "unreadable")
      : cell.clearsBorrow.closedForm === false
        ? "net_below_borrow"
        : cell.mcLpNetPct === null
          ? "mc_calibration_unavailable"
          : "within_model_uncertainty";
  return {
    poolId: cell.poolId,
    pool: cell.pool,
    setting: cell.setting,
    preset: cell.preset,
    collateral: cell.collateral,
    rangeWidthBps: cell.rangeWidthBps,
    halfWidth: cell.halfWidth,
    rebalanceDelayHours: cell.rebalanceDelayHours,
    qualifies,
    reason,
    emissionsGrossPct: cell.emissionsGrossPct,
    emissionsNetPct: cell.emissionsNetPct,
    emissionsRealizedPct: cell.emissionsRealizedPct,
    dragPct: cell.dragPct,
    lpNetPct: cell.lpNetPct,
    mcLpNetPct: cell.mcLpNetPct,
    borrowAprPct: cell.borrowAprNowPct,
    collateralSupplyAprPct: cell.collateralSupplyAprPct,
    sigma: cell.sigma,
    breakEvenSigma: cell.breakEvenSigma,
    breakEvenEmissionsMultiple: cell.breakEvenEmissionsMultiple,
    userNet,
    stale: cell.stale,
  };
}

/** One cell per pool — the setting with the best user net at this LTV; unpriced pools keep their sheltered setting. */
export function bestPerPool(cells: ForecastCell[], ltvBps: number): ForecastCell[] {
  const byPool = new Map<string, ForecastCell>();
  for (const c of cells) {
    const cur = byPool.get(c.poolId);
    if (!cur) {
      byPool.set(c.poolId, c);
      continue;
    }
    const a = userNetAtLtv(c, ltvBps);
    const b = userNetAtLtv(cur, ltvBps);
    if ((a ?? -Infinity) > (b ?? -Infinity) || (a === null && b === null && c.setting === "sheltered")) byPool.set(c.poolId, c);
  }
  const score = (c: ForecastCell) => userNetAtLtv(c, ltvBps) ?? -Infinity;
  return [...byPool.values()].sort((a, b) => score(b) - score(a) || b.rangeWidthBps - a.rangeWidthBps);
}
