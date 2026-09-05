/**
 * Client for the yield service's gate: GET /v1/gate (services/yield/src/gate.ts).
 *
 * The rule (BUILD-SPEC "Yield gate"): a pool × setting is offered only when
 * its served `lpNetPct` — emissions net of the engine's 15% and Oilskin's
 * performance fee, realised on the IL-drag-shrunk base, plus the drag —
 * beats the LIVE Base USDC borrow rate. The service computes it and refuses
 * with an explicit reason otherwise; the UI re-checks `lpNetPct > borrowAprPct`
 * from the same served numbers and never shows a pool the numbers do not
 * support, whatever the flag says.
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
  borrowAprPct: number | null;
  collateralSupplyAprPct: number | null;
  sigma: number | null;
  breakEvenSigma: number | null;
  breakEvenEmissionsMultiple: number | null;
  userNet: GateUserNet[];
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
  settings: { id: GateSettingId; preset: NamedRangePreset; rebalanceDelayHours: number }[];
  verdicts: GateEntry[];
  source: "live" | "demo";
  stale: boolean;
  /** Set when the service refused (503 gate_unavailable) — nothing is offered. */
  unavailableReason?: string;
}

const REASON_TEXT: Record<string, string> = {
  collateral_disabled: "collateral is disabled in the registry",
  collateral_not_active: "Aave reports this collateral inactive/frozen",
  rates_unavailable: "borrow rate not sampled",
  rates_stale: "borrow rate sample is stale",
  emissions_unavailable: "gauge emissions not sampled",
  emissions_stale: "gauge emissions sample is stale",
  no_emissions: "gauge pays no AERO (rewardRate 0 or epoch lapsed)",
  no_staked_liquidity: "no staked liquidity at this width",
  staked_liquidity_outlier: "staked-liquidity reading is an outlier",
  emissions_below_borrow: "net emissions alone are below the borrow rate",
  no_volatility_input: "no calibrated volatility for this pool",
  net_below_borrow: "net of IL drag it is below the borrow rate",
};

export function reasonText(reason: string | null): string {
  if (!reason) return "";
  return REASON_TEXT[reason] ?? reason.replace(/_/g, " ");
}

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
    const rowBorrow = num(v.borrowAprPct) ?? (Number.isFinite(borrowAprPct) ? borrowAprPct : null);
    const qualifies = v.qualifies === true && lpNetPct !== null && rowBorrow !== null && lpNetPct > rowBorrow && !stale;
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
      reason: qualifies ? null : (typeof v.reason === "string" ? v.reason : v.qualifies === true ? "net_below_borrow" : "unreadable"),
      emissionsGrossPct: num(v.emissionsGrossPct),
      emissionsNetPct: num(v.emissionsNetPct),
      emissionsRealizedPct: num(v.emissionsRealizedPct),
      dragPct: num(v.dragPct),
      lpNetPct,
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
    settings,
    verdicts,
    source,
    stale,
  };
}

export function unavailableGate(reason: string, source: GateView["source"]): GateView {
  return { generatedAt: "", borrowAprPct: NaN, ratesSampledAt: "", emissionsSampledAt: "", volatilityAsOf: "", engineFeeBps: null, settings: [], verdicts: [], source, stale: true, unavailableReason: reason };
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
