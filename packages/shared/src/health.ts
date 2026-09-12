/**
 * Health-factor ladder — ONE source for the keeper, web, and prototypes.
 *
 * Every number a surface shows about health is derived from these constants
 * and from the venue's live liquidation threshold. No surface may type an HF,
 * an LTV cap, or a "±" of its own.
 */

/**
 * The registry's entry health-factor floor as DEPLOYED (`CollateralRegistry.entryHfFloorWad`),
 * and the shared default wherever a surface has no registry read. The venue refuses a borrow
 * that would open under it. Since 2026-09-12 (BUILD-PLAN D7, step A4) this is the SLIDER'S
 * MINIMUM, not the product's one setting: the user chooses any entry HF at or above it and the
 * ladder is derived from that choice (`ladderFor`). The number itself is the founder's — 1.25 is
 * the proposal in BUILD-PLAN §2b — and it stays 1.55 here until he pins it; every consumer
 * takes the floor as a parameter so the pin is one change.
 */
export const ENTRY_HF_FLOOR = 1.55;

/**
 * Hysteresis at the floor's ladder: a rung disarms (re-arms for next time) once HF climbs back
 * above rung + this. For any other entry HF use `hysteresisFor(entryHf)`; this constant is the
 * value at ENTRY_HF_FLOOR = 1.55 and is what the Solana ladder seam pins today.
 */
export const HF_HYSTERESIS = 0.05;

// ---------------------------------------------------------------------------
// The derived ladder (BUILD-PLAN-2026-09-12 §2b, decision D7)
// ---------------------------------------------------------------------------

/**
 * How far below the chosen entry HF `e` each rung sits, as a share of the buffer (e − 1):
 * rung = 1 + (e − 1) × k. At e = 1.55 this reproduces the ladder the product has always run
 * (1.50 / 1.35 / 1.20 / 1.05).
 */
export const LADDER_RUNG_FACTORS: Readonly<Record<HfRungId, number>> = Object.freeze({ warn: 0.91, repay: 0.64, derisk: 0.36, emergency: 0.09 });
/** The emergency rung is never below this, whatever the entry HF. */
export const EMERGENCY_HF_MIN = 1.05;
/** Hysteresis scales with the buffer — 0.05 at the 1.55 floor — and never falls under this. */
export const HF_HYSTERESIS_MIN = 0.02;
/** The buffer (e − 1) at which the hysteresis is HF_HYSTERESIS: 1.55 − 1. */
export const HF_HYSTERESIS_SPAN = 0.55;
/**
 * Below this entry HF the four rungs cannot fit under the entry with a rung's width between them
 * (the "rungs collapse" band BUILD-PLAN §2b flags); `ladderFor` refuses rather than emits a
 * ladder that is born fired. A registry floor must sit at or above it.
 */
export const MIN_LADDER_ENTRY_HF = 1.1;
/** The two quick-click marks on the slider (BUILD-PLAN D7). Marks, not modes: any HF ≥ the floor is allowed. */
export const HF_MARKS: readonly { id: "sheltered" | "expert"; hf: number; label: string }[] = Object.freeze([
  { id: "sheltered", hf: 1.55, label: "Sheltered" },
  { id: "expert", hf: 1.3, label: "Expert" },
]);

/** hysteresis(e) = max(0.02, 0.05 × (e − 1) ÷ 0.55), to two decimals. */
export function hysteresisFor(entryHf: number): number {
  assertEntryHf(entryHf);
  return round2(Math.max(HF_HYSTERESIS_MIN, (HF_HYSTERESIS * (entryHf - 1)) / HF_HYSTERESIS_SPAN));
}

export type HfRungId = "warn" | "repay" | "derisk" | "emergency";

export interface HfRung {
  id: HfRungId;
  /** Trigger when HF < hf. */
  hf: number;
  /** Consider the rung cleared when HF >= disarmHf (= hf + HF_HYSTERESIS). */
  disarmHf: number;
  /** 1 = mildest … 4 = most severe. */
  severity: 1 | 2 | 3 | 4;
  /** What the keeper does at this rung. */
  action: "notify" | "repay" | "derisk" | "emergency-unwind";
  label: string;
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

function rung(id: HfRungId, hf: number, severity: HfRung["severity"], action: HfRung["action"], label: string): HfRung {
  return { id, hf, disarmHf: round2(hf + HF_HYSTERESIS), severity, action, label };
}

const RUNG_SHAPE: readonly { id: HfRungId; severity: HfRung["severity"]; action: HfRung["action"]; label: string }[] = Object.freeze([
  { id: "warn", severity: 1, action: "notify", label: "Warning" },
  { id: "repay", severity: 2, action: "repay", label: "Repay" },
  { id: "derisk", severity: 3, action: "derisk", label: "De-risk" },
  { id: "emergency", severity: 4, action: "emergency-unwind", label: "Emergency" },
]);

function assertEntryHf(entryHf: number): void {
  if (typeof entryHf !== "number" || !Number.isFinite(entryHf) || entryHf < MIN_LADDER_ENTRY_HF) {
    throw new RangeError(`entryHf must be a finite number ≥ ${MIN_LADDER_ENTRY_HF}, got ${String(entryHf)}`);
  }
}

/**
 * The ladder for a position opened at `entryHf` (BUILD-PLAN-2026-09-12 §2b):
 *   rung = 1 + (e − 1) × k, k = 0.91 / 0.64 / 0.36 / 0.09; emergency ≥ 1.05;
 *   disarm = rung + hysteresisFor(e).
 * Rungs are kept strictly decreasing — the clamp on emergency can lift it to a rung above it at
 * a low entry HF, in which case each rung above is lifted to sit 0.01 higher than the next, so
 * the keeper's shape check (disarm above trigger, thresholds strictly decreasing) always holds.
 * Ordered mildest → most severe; frozen. `ladderFor(ENTRY_HF_FLOOR)` is `HF_LADDER`.
 */
export function ladderFor(entryHf: number): readonly HfRung[] {
  assertEntryHf(entryHf);
  const h = hysteresisFor(entryHf);
  const raw = RUNG_SHAPE.map((sh) => round2(1 + (entryHf - 1) * LADDER_RUNG_FACTORS[sh.id]));
  const hf: number[] = new Array(raw.length);
  // most severe first: the emergency floor, then each milder rung at least 0.01 above the next
  hf[raw.length - 1] = Math.max(raw[raw.length - 1]!, EMERGENCY_HF_MIN);
  for (let i = raw.length - 2; i >= 0; i--) hf[i] = round2(Math.max(raw[i]!, hf[i + 1]! + 0.01));
  if (!(hf[0]! < entryHf)) {
    throw new RangeError(`ladderFor(${entryHf}): the warn rung (${hf[0]}) would not sit below the entry — the buffer is too thin for four rungs`);
  }
  return Object.freeze(
    RUNG_SHAPE.map((sh, i) => Object.freeze({ id: sh.id, hf: hf[i]!, disarmHf: round2(hf[i]! + h), severity: sh.severity, action: sh.action, label: sh.label }))
  );
}

/**
 * The floor's ladder — what every position ran on before A4 and what a position whose entry HF is
 * not recorded still runs on. `rungFor` (without a ladder) returns the MOST severe rung of THIS
 * ladder whose threshold the HF is below.
 */
export const HF_LADDER: readonly HfRung[] = ladderFor(ENTRY_HF_FLOOR);

/**
 * A health factor wad (1e18) as the number the ladder math runs on, truncated to four decimals.
 * The keeper reads `StrategyRouter.entryHfWad(account)` through this: 1.55008e18 (the 1.55 slider
 * choice after the LTV was floored to whole bps) → 1.55, and `ladderFor` rounds each rung to two.
 */
export function hfFromWad(wad: bigint): number {
  if (typeof wad !== "bigint" || wad < 0n) throw new RangeError(`hfFromWad: expected a non-negative bigint, got ${String(wad)}`);
  return Number(wad / 10n ** 14n) / 1e4;
}

export function rungById(id: HfRungId, ladder: readonly HfRung[] = HF_LADDER): HfRung {
  const r = ladder.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown rung: ${id}`);
  return r;
}

/** The identity the slider runs on: LTV at entry = LT ÷ HF, floored to whole bps. */
export function ltvForEntryHfBps(ltBps: number, entryHf: number): number {
  assertBps(ltBps, "ltBps");
  if (typeof entryHf !== "number" || !Number.isFinite(entryHf) || entryHf < 1) throw new RangeError(`entryHf must be a finite number ≥ 1, got ${String(entryHf)}`);
  return Math.floor(ltBps / entryHf);
}

/** The collateral price fall that reaches HF 1 from an entry at `entryHf`: 100 × (1 − 1 ÷ HF), percent. */
export function drawdownToLiquidationPct(entryHf: number): number {
  if (typeof entryHf !== "number" || !Number.isFinite(entryHf) || entryHf < 1) throw new RangeError(`entryHf must be a finite number ≥ 1, got ${String(entryHf)}`);
  return 100 * (1 - 1 / entryHf);
}

/**
 * Entry health factor for a position opened at `ltvBps` against an asset whose
 * venue liquidation threshold is `ltBps`: HF = LT / LTV.
 * Both inputs are basis points read from chain / chosen by the user.
 */
export function entryHfForLtv(ltBps: number, ltvBps: number): number {
  assertBps(ltBps, "ltBps");
  assertBps(ltvBps, "ltvBps");
  if (ltvBps === 0) return Number.POSITIVE_INFINITY;
  return ltBps / ltvBps;
}

/**
 * Most severe rung triggered by `hf`, or null when healthy (HF ≥ warn).
 *
 * Fail-closed: NaN or negative input THROWS — a keeper that cannot read the
 * health factor must not conclude "healthy". +Infinity (Aave's no-debt
 * sentinel, type(uint256).max) is healthy.
 */
export function rungFor(hf: number, ladder: readonly HfRung[] = HF_LADDER): HfRung | null {
  if (typeof hf !== "number" || Number.isNaN(hf) || hf < 0) {
    throw new TypeError(`rungFor: unreadable health factor ${String(hf)} — fail closed`);
  }
  let hit: HfRung | null = null;
  for (const r of ladder) {
    if (hf < r.hf) hit = r;
  }
  return hit;
}

/**
 * Hysteresis: a rung that has fired stays armed until HF ≥ its disarmHf.
 * Returns true when the rung may be considered cleared.
 */
export function isRungCleared(rung: HfRung | HfRungId, hf: number, ladder: readonly HfRung[] = HF_LADDER): boolean {
  const r = typeof rung === "string" ? rungById(rung, ladder) : rung;
  if (typeof hf !== "number" || Number.isNaN(hf)) return false; // fail closed
  return hf >= r.disarmHf;
}

/**
 * Percentage price drop (of the collateral, vs. the borrowed stable) at which
 * HF reaches 1.0 and liquidation begins: 1 − LTV/LT.
 * Returns a percentage (e.g. 35.9 for 35.9%). 100 when there is no debt.
 */
export function liquidationDropPct(ltBps: number, ltvBps: number): number {
  assertBps(ltBps, "ltBps");
  assertBps(ltvBps, "ltvBps");
  if (ltvBps === 0) return 100;
  if (ltBps === 0) return 0;
  return Math.max(0, (1 - ltvBps / ltBps) * 100);
}

/**
 * Collateral price (as a fraction of today's) at which a given rung fires:
 * price_frac = rung.hf × LTV / LT. Useful for the "warning at −x%" rows.
 * Returns a percentage drop like liquidationDropPct.
 */
export function rungDropPct(rung: HfRung | HfRungId, ltBps: number, ltvBps: number, ladder: readonly HfRung[] = HF_LADDER): number {
  const r = typeof rung === "string" ? rungById(rung, ladder) : rung;
  assertBps(ltBps, "ltBps");
  assertBps(ltvBps, "ltvBps");
  if (ltvBps === 0) return 100;
  if (ltBps === 0) return 0;
  return Math.max(0, (1 - (r.hf * ltvBps) / ltBps) * 100);
}

export function assertBps(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new RangeError(`${name} must be an integer in [0, 10000] bps, got ${String(value)}`);
  }
}
