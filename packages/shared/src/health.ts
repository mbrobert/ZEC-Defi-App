/**
 * Health-factor ladder — ONE source for the keeper, web, and prototypes.
 *
 * Every number a surface shows about health is derived from these constants
 * and from the venue's live liquidation threshold. No surface may type an HF,
 * an LTV cap, or a "±" of its own.
 */

/**
 * Minimum health factor a freshly opened position must have. Fixes the top
 * LTV we OFFER per asset: floor(LT / ENTRY_HF_FLOOR), capped by
 * MAX_OFFERED_LTV_CAP_BPS in collateral.ts.
 */
export const ENTRY_HF_FLOOR = 1.55;

/** Rung disarms (re-arms for next time) once HF climbs back above rung + this. */
export const HF_HYSTERESIS = 0.05;

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

/**
 * Ordered mildest → most severe. `rungFor` returns the MOST severe rung whose
 * threshold the HF is below.
 */
export const HF_LADDER: readonly HfRung[] = Object.freeze([
  rung("warn", 1.5, 1, "notify", "Warning"),
  rung("repay", 1.35, 2, "repay", "Repay"),
  rung("derisk", 1.2, 3, "derisk", "De-risk"),
  rung("emergency", 1.05, 4, "emergency-unwind", "Emergency"),
]);

export function rungById(id: HfRungId): HfRung {
  const r = HF_LADDER.find((x) => x.id === id);
  if (!r) throw new Error(`Unknown rung: ${id}`);
  return r;
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
export function rungFor(hf: number): HfRung | null {
  if (typeof hf !== "number" || Number.isNaN(hf) || hf < 0) {
    throw new TypeError(`rungFor: unreadable health factor ${String(hf)} — fail closed`);
  }
  let hit: HfRung | null = null;
  for (const r of HF_LADDER) {
    if (hf < r.hf) hit = r;
  }
  return hit;
}

/**
 * Hysteresis: a rung that has fired stays armed until HF ≥ its disarmHf.
 * Returns true when the rung may be considered cleared.
 */
export function isRungCleared(rung: HfRung | HfRungId, hf: number): boolean {
  const r = typeof rung === "string" ? rungById(rung) : rung;
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
export function rungDropPct(rung: HfRung | HfRungId, ltBps: number, ltvBps: number): number {
  const r = typeof rung === "string" ? rungById(rung) : rung;
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
