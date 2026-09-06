/**
 * Client for the yield service's gate: GET /v1/gate (services/yield/src/gate.ts).
 *
 * The rule: a pool × setting is offered only when the SAME LP slice beats the
 * live Base USDC borrow rate under BOTH of the product's models —
 *
 *   • `lpNetPct`, the published closed form (emissions net of the engine's cut
 *     and Oilskin's performance fee, realised on the IL-drag-shrunk base, plus
 *     the drag). This stays the headline number the UI shows;
 *   • `mcLpNetPct`, the same slice priced by the Monte-Carlo-calibrated form,
 *     which also charges time spent OUT of range. The closed form ignores that
 *     and is therefore optimistic — by 0.2 to 32 points at the gate boundary.
 *
 * When the closed form clears and the calibrated one does not, the cell sits
 * inside the band where the product's two models disagree and it is refused
 * (`within_model_uncertainty`). Seven of the eight cells that used to be
 * offerable at their own published break-even multiple are refused by this.
 *
 * The service computes the verdict and refuses with an explicit reason; the UI
 * re-derives the SAME test from the served numbers and never shows a pool the
 * numbers do not support, whatever the flag says. A missing `mcLpNetPct` fails
 * closed: an uncalibrated cell is not an offerable cell.
 *
 * Widths are TOTAL tick spans; `halfWidth` is the exact price half-width
 * (1.0001^(bps/2) − 1) the model prices at, served by the gate.
 */
import { CURATED_POOLS, type CollateralSymbol, type CuratedPool, type NamedRangePreset } from "@zyo/shared";

export type GateSettingId = "sheltered" | "steady" | "working";

export interface GateUserNet {
  ltvBps: number;
  offerable: boolean;
  /** collateral supply + LTV × (lpNet − borrow), percent. */
  userNetPct: number;
}

export interface GateEntry {
  poolId: string;
  pool: CuratedPool;
  setting: GateSettingId;
  preset: NamedRangePreset;
  collateral: CollateralSymbol;
  rangeWidthBps: number;
  /** Exact price half-width as a fraction (0.0779 = ±7.79%). */
  halfWidth: number;
  rebalanceDelayHours: number;
  /** Re-derived: served qualifies AND lpNetPct > borrowAprPct. */
  qualifies: boolean;
  reason: string | null;
  emissionsGrossPct: number | null;
  emissionsNetPct: number | null;
  emissionsRealizedPct: number | null;
  dragPct: number | null;
  lpNetPct: number | null;
  /** The same LP slice under the Monte-Carlo-calibrated form; the offer needs THIS to clear too. */
  mcLpNetPct: number | null;
  borrowAprPct: number | null;
  collateralSupplyAprPct: number | null;
  sigma: number | null;
  breakEvenSigma: number | null;
  breakEvenEmissionsMultiple: number | null;
  userNet: GateUserNet[];
  /** The payload this verdict came from was stale — nothing stale is ever offered. */
  stale: boolean;
}

export interface GateView {
  generatedAt: string;
  borrowAprPct: number;
  ratesSampledAt: string;
  emissionsSampledAt: string;
  volatilityAsOf: string;
  /** Engine fee the model applied (external protocol parameter carried by the yield service), bps. */
  engineFeeBps: number | null;
  /** When the Monte-Carlo calibration behind every `mcLpNetPct` was produced. */
  mcCalibrationGeneratedAt: string;
  settings: { id: GateSettingId; preset: NamedRangePreset; rebalanceDelayHours: number }[];
  verdicts: GateEntry[];
  source: "live" | "demo";
  stale: boolean;
  /** Set when the service refused (503 gate_unavailable) — nothing is offered. */
  unavailableReason?: string;
}

/** Advanced mode: the technical reason, one clause, per pool row. */
const REASON_TEXT: Record<string, string> = {
  collateral_disabled: "collateral is disabled in the registry",
  collateral_not_active: "Aave reports this collateral inactive/frozen",
  collateral_paused: "Aave's guardian has PAUSED this collateral reserve",
  borrow_paused: "Aave's guardian has PAUSED the USDC reserve",
  rates_unavailable: "borrow rate not sampled",
  rates_stale: "borrow rate sample is stale",
  emissions_unavailable: "gauge emissions not sampled",
  emissions_stale: "gauge emissions sample is stale",
  no_emissions: "gauge pays no AERO (rewardRate 0 or epoch lapsed)",
  no_staked_liquidity: "no staked liquidity at this width",
  insufficient_samples: "the staked-liquidity anchor is not corroborated by enough independent readings yet",
  staked_liquidity_outlier: "staked-liquidity reading is an outlier",
  emissions_implausible: "the implied emissions APR is above the plausibility ceiling — treated as a bad reading, not a return",
  emissions_below_borrow: "net emissions alone are below the borrow rate",
  no_volatility_input: "no calibrated volatility for this pool",
  mc_calibration_unavailable: "no Monte-Carlo calibration covers this pool at this width, so the second model cannot price it",
  mc_calibration_stale: "the Monte-Carlo calibration was taken at a different volatility or width than today's inputs",
  net_below_borrow: "net of IL drag it is below the borrow rate",
  within_model_uncertainty: "the two models disagree: the closed form clears the borrow rate, the one that also charges time out of range does not",
  net_out_of_bounds: "the computed net is outside the bounds the model is trusted in — treated as a bad reading",
};

/**
 * Simple mode: ONE plain sentence a first-time user can act on. Never a code,
 * never a clause fragment. Every reason the service can send has an entry;
 * anything new falls back to an honest "we could not stand behind it".
 */
const REASON_PLAIN: Record<string, string> = {
  collateral_disabled: "Oilskin does not accept this asset as collateral right now.",
  collateral_not_active: "Aave is not accepting this asset as collateral right now.",
  collateral_paused: "Aave has paused this collateral, so nothing can be supplied or borrowed against it until they unpause it.",
  borrow_paused: "Aave has paused USDC borrowing, so there is nothing to borrow right now.",
  rates_unavailable: "We could not read what borrowing costs today, and we will not offer a position without it.",
  rates_stale: "Our reading of the borrowing cost is too old to trust, so nothing is offered until it refreshes.",
  emissions_unavailable: "We could not read what this pool is paying out, so we cannot say it is worth it.",
  emissions_stale: "Our reading of what this pool pays is too old to trust.",
  no_emissions: "This pool is not paying any rewards at the moment, so there is nothing to earn.",
  no_staked_liquidity: "Nobody is providing liquidity at this width, so there is no reliable number to price it with.",
  insufficient_samples: "We have not seen enough independent readings of this pool to trust the one we have.",
  staked_liquidity_outlier: "The reading we got for this pool does not match its history, so we are treating it as wrong rather than as an opportunity.",
  emissions_implausible: "The rewards this pool appears to pay are too high to be real, so we are treating the reading as broken rather than as a return.",
  emissions_below_borrow: "The rewards would not even cover the interest on the loan, before any other cost.",
  no_volatility_input: "We do not have a trusted volatility figure for this pair, so we cannot price the risk of the price moving.",
  mc_calibration_unavailable: "Our second, stricter model has nothing calibrated for this pool at this width, so we cannot double-check the first one — and we will not offer what we can only price once.",
  mc_calibration_stale: "Our second model was calibrated in calmer conditions than today's, so its answer would not be honest here.",
  net_below_borrow: "Once the loss from the price moving is priced in, it earns less than the loan costs.",
  within_model_uncertainty: "Our two models disagree about this one: the simpler one says it clears, the stricter one — which also charges for the time your money sits outside the price range — says it does not. When they disagree we do not offer it.",
  net_out_of_bounds: "The numbers came out far outside the range this model is trusted in, so we are treating them as broken rather than as a return.",
};

export function reasonText(reason: string | null): string {
  if (!reason) return "";
  return REASON_TEXT[reason] ?? reason.replace(/_/g, " ");
}

/** ONE plain sentence for Simple mode. */
export function reasonPlain(reason: string | null): string {
  if (!reason) return "";
  return REASON_PLAIN[reason] ?? "We could not stand behind the numbers for this pool today, so it is not offered.";
}

/** Every reason the UI has copy for — the drift test asserts it covers the service's union. */
export const KNOWN_REASONS: readonly string[] = Object.keys(REASON_TEXT);

const SETTING_IDS: GateSettingId[] = ["sheltered", "steady", "working"];
const PRESETS: NamedRangePreset[] = ["CONSERVATIVE", "MODERATE", "AGGRESSIVE"];

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}
function str(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}

/**
 * Normalise a /v1/gate payload. Unreadable verdicts are dropped (fail closed
 * = not offered); a verdict only `qualifies` when the service said so AND
 * the served lpNet beats the served borrow rate.
 */
export function normalizeGate(raw: unknown, source: GateView["source"]): GateView {
  const r = (raw ?? {}) as Record<string, unknown>;
  const borrowAprPct = num(r.borrowAprPct) ?? NaN;
  const stale = r.stale === true;
  const settingsRaw = (Array.isArray(r.settings) ? r.settings : []) as Record<string, unknown>[];
  const settings = settingsRaw
    .map((s) => ({ id: str(s.id) as GateSettingId, preset: str(s.preset) as NamedRangePreset, rebalanceDelayHours: num(s.rebalanceDelayHours) ?? 0 }))
    .filter((s) => SETTING_IDS.includes(s.id) && PRESETS.includes(s.preset));
  const delayFor = (id: GateSettingId) => settings.find((s) => s.id === id)?.rebalanceDelayHours ?? 0;

  const verdicts: GateEntry[] = [];
  for (const v of (Array.isArray(r.verdicts) ? r.verdicts : []) as Record<string, unknown>[]) {
    const pool = CURATED_POOLS.find((p) => p.id === v.poolId);
    const setting = v.setting as GateSettingId;
    const preset = v.preset as NamedRangePreset;
    const collateral = v.collateral as CollateralSymbol;
    const rangeWidthBps = num(v.rangeWidthBps);
    const halfWidth = num(v.halfWidth);
    if (!pool || !SETTING_IDS.includes(setting) || !PRESETS.includes(preset) || !collateral || rangeWidthBps === null || halfWidth === null) continue;
    const lpNetPct = num(v.lpNetPct);
    const mcLpNetPct = num(v.mcLpNetPct);
    const rowBorrow = num(v.borrowAprPct) ?? (Number.isFinite(borrowAprPct) ? borrowAprPct : null);
    // BOTH models must clear the borrow. An uncalibrated cell (mcLpNetPct null)
    // fails closed — it is priced once, and once is not enough.
    const closedClears = lpNetPct !== null && rowBorrow !== null && lpNetPct > rowBorrow;
    const mcClears = mcLpNetPct !== null && rowBorrow !== null && mcLpNetPct > rowBorrow;
    const qualifies = v.qualifies === true && closedClears && mcClears && !stale;
    const userNet = (Array.isArray(v.userNet) ? v.userNet : [])
      .map((u) => u as Record<string, unknown>)
      .map((u) => ({ ltvBps: num(u.ltvBps) ?? 0, offerable: u.offerable === true, userNetPct: num(u.userNetPct) ?? NaN }))
      .filter((u) => u.ltvBps > 0 && Number.isFinite(u.userNetPct));
    verdicts.push({
      poolId: pool.id,
      pool,
      setting,
      preset,
      collateral,
      rangeWidthBps,
      halfWidth,
      rebalanceDelayHours: delayFor(setting),
      qualifies,
      reason: qualifies
        ? null
        : typeof v.reason === "string"
          ? v.reason
          : v.qualifies !== true
            ? "unreadable"
            : // The service said yes but our own re-derivation says no: name which
              // half failed, so the "why not" list never shows a bare "unreadable".
              !closedClears
              ? "net_below_borrow"
              : mcLpNetPct === null
                ? "mc_calibration_unavailable"
                : "within_model_uncertainty",
      emissionsGrossPct: num(v.emissionsGrossPct),
      emissionsNetPct: num(v.emissionsNetPct),
      emissionsRealizedPct: num(v.emissionsRealizedPct),
      dragPct: num(v.dragPct),
      lpNetPct,
      mcLpNetPct,
      borrowAprPct: rowBorrow,
      collateralSupplyAprPct: num(v.collateralSupplyAprPct),
      sigma: num(v.sigma),
      breakEvenSigma: num(v.breakEvenSigma),
      breakEvenEmissionsMultiple: num(v.breakEvenEmissionsMultiple),
      userNet,
      stale,
    });
  }
  return {
    generatedAt: str(r.generatedAt),
    borrowAprPct,
    ratesSampledAt: str(r.ratesSampledAt),
    emissionsSampledAt: str(r.emissionsSampledAt),
    volatilityAsOf: str(r.volatilityAsOf),
    engineFeeBps: num(r.engineFeeBps),
    mcCalibrationGeneratedAt: str(r.mcCalibrationGeneratedAt),
    settings,
    verdicts,
    source,
    stale,
  };
}

export function unavailableGate(reason: string, source: GateView["source"]): GateView {
  return { generatedAt: "", borrowAprPct: NaN, ratesSampledAt: "", emissionsSampledAt: "", volatilityAsOf: "", engineFeeBps: null, mcCalibrationGeneratedAt: "", settings: [], verdicts: [], source, stale: true, unavailableReason: reason };
}

export async function fetchGate(baseUrl: string, signal?: AbortSignal): Promise<GateView> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/gate`, { signal, cache: "no-store" });
  if (res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    return unavailableGate(body.reason ?? "gate_unavailable", "live");
  }
  if (!res.ok) throw new Error(`gate ${res.status}`);
  return normalizeGate(await res.json(), "live");
}

/** Verdicts for one collateral, best lpNet first. */
export function verdictsFor(view: GateView, collateral: CollateralSymbol): GateEntry[] {
  return view.verdicts.filter((v) => v.collateral === collateral).sort((a, b) => (b.lpNetPct ?? -Infinity) - (a.lpNetPct ?? -Infinity));
}

/** Only the rows the picker may show for a collateral. */
export function offeredEntries(view: GateView, collateral: CollateralSymbol): GateEntry[] {
  return verdictsFor(view, collateral).filter((v) => v.qualifies);
}

/** Rows that did NOT clear for a collateral, for the "why not" list. */
export function rejectedEntries(view: GateView, collateral: CollateralSymbol): GateEntry[] {
  return verdictsFor(view, collateral).filter((v) => !v.qualifies);
}

/** Find the live verdict matching a previously chosen entry. */
export function findVerdict(view: GateView, e: Pick<GateEntry, "poolId" | "setting" | "collateral">): GateEntry | undefined {
  return view.verdicts.find((v) => v.poolId === e.poolId && v.setting === e.setting && v.collateral === e.collateral);
}
