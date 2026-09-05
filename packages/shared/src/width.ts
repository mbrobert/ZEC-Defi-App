/**
 * LP range width and engine parameters — carried over from the audit spec.
 *
 * CONVENTION: `rangeWidthBps` is the TOTAL TICK SPAN of the position (what
 * ISnuggleVault/ILPAdapter take). Ticks are geometric — each tick is a factor
 * of 1.0001 — so the half-width in price terms is
 *
 *     halfWidth = 1.0001^(rangeWidthBps / 2) − 1
 *
 * NOT rangeWidthBps / 200. 300 ticks → ±1.51 %, 4500 ticks → ±25.23 %.
 * (AUDIT-FINDINGS Part 1 FACT 3, live-engine vectors asserted in test/width.test.ts.)
 * Every "±x %" a surface shows is derived via halfWidthFromBps /
 * formatHalfWidthPct — never typed, never linear.
 */

/** ln(1.0001): one tick's log-price step. */
export const LN_TICK_BASE = Math.log(1.0001);

/** Total-span bounds in bps, enforced here and in SnuggleLpVenue. */
export const RANGE_WIDTH_BOUNDS = { min: 150, max: 5000 } as const;

export const REBALANCE_DELAY_BOUNDS = { minHours: 0, maxHours: 168 } as const;

export type RangePreset = "CONSERVATIVE" | "MODERATE" | "AGGRESSIVE" | "CUSTOM";
export type NamedRangePreset = Exclude<RangePreset, "CUSTOM">;

/**
 * Correlated pairs (LST/ETH, stable/stable, ETH/BTC) move together, so the
 * same "risk posture" is a narrower band than for an uncorrelated pair.
 */
export type PairClass = "UNCORRELATED" | "CORRELATED";

export interface RangePresetDef {
  preset: NamedRangePreset;
  label: string;
  /** Prose only — no numbers. Numbers are derived at render time. */
  description: string;
  /** Total span in bps, per pair class. */
  rangeWidthBps: Readonly<Record<PairClass, number>>;
  defaultRebalanceDelayHours: number;
}

export const RANGE_PRESETS: readonly RangePresetDef[] = Object.freeze([
  {
    preset: "CONSERVATIVE",
    label: "Conservative",
    description: "Wide band. Stays in range through large moves; lower fee capture, rare rebalances.",
    rangeWidthBps: { UNCORRELATED: 4500, CORRELATED: 2356 },
    defaultRebalanceDelayHours: 48,
  },
  {
    preset: "MODERATE",
    label: "Moderate",
    description: "Balanced band. Good fee capture with tolerable rebalance frequency.",
    rangeWidthBps: { UNCORRELATED: 1500, CORRELATED: 784 },
    defaultRebalanceDelayHours: 12,
  },
  {
    preset: "AGGRESSIVE",
    label: "Aggressive",
    description: "Tight band. Maximum fee capture; frequent out-of-range periods and rebalances.",
    rangeWidthBps: { UNCORRELATED: 300, CORRELATED: 150 },
    defaultRebalanceDelayHours: 2,
  },
]);

export function rangePresetDef(preset: NamedRangePreset): RangePresetDef {
  const def = RANGE_PRESETS.find((p) => p.preset === preset);
  if (!def) throw new Error(`Unknown preset: ${preset}`);
  return def;
}

/** Total span in bps for a preset on a pair class. */
export function presetWidthBps(preset: NamedRangePreset, pairClass: PairClass = "UNCORRELATED"): number {
  return rangePresetDef(preset).rangeWidthBps[pairClass];
}

/** Parameters the LP engine (Snuggle/MaxFi) accepts at deposit time. */
export interface LpParams {
  /** TOTAL tick span (300 ticks → ±1.51 %; see halfWidthFromBps). */
  rangeWidthBps: number;
  /** Delay before auto-repositioning after going out of range, in hours. */
  rebalanceDelayHours: number;
  /** Auto-compound matching-token fees back into the position. */
  autoCompoundEnabled: boolean;
}

export function presetToLpParams(preset: NamedRangePreset, pairClass: PairClass = "UNCORRELATED"): LpParams {
  const def = rangePresetDef(preset);
  return {
    rangeWidthBps: def.rangeWidthBps[pairClass],
    rebalanceDelayHours: def.defaultRebalanceDelayHours,
    autoCompoundEnabled: true,
  };
}

/** Which preset (if any) a set of params corresponds to, for the selector UI. */
export function presetForParams(params: LpParams, pairClass: PairClass = "UNCORRELATED"): RangePreset {
  const hit = RANGE_PRESETS.find((p) => p.rangeWidthBps[pairClass] === params.rangeWidthBps);
  return hit ? hit.preset : "CUSTOM";
}

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

/**
 * Half width in PERCENT from a total tick span: exp(ticks · ln 1.0001 / 2) − 1.
 * 300 → 1.5113…, 1000 → 5.1271…, 4500 → 25.232…
 */
export function halfWidthFromBps(totalRangeWidthBps: number): number {
  return (Math.exp((totalRangeWidthBps * LN_TICK_BASE) / 2) - 1) * 100;
}

/**
 * Exact inverse of halfWidthFromBps: total tick span from a half width in
 * percent, 2 · ln(1 + half/100) / ln 1.0001, rounded to an integer tick.
 * Round-trips every integer span.
 */
export function bpsFromHalfWidth(halfWidthPct: number): number {
  return Math.round((2 * Math.log(1 + halfWidthPct / 100)) / LN_TICK_BASE);
}

/**
 * "±1.51%" under ±2 % (two decimals — tight bands need them), "±25.2%" otherwise.
 */
export function formatHalfWidthPct(totalRangeWidthBps: number): string {
  const half = halfWidthFromBps(totalRangeWidthBps);
  const dp = half < 2 ? 2 : 1;
  return `±${half.toFixed(dp)}%`;
}

/** Full price multiplier across the whole span: 1.0001^ticks (4500 → 1.5683). */
export function spanPriceRatio(totalRangeWidthBps: number): number {
  return Math.exp(totalRangeWidthBps * LN_TICK_BASE);
}

export function rebalanceDelayHoursToSeconds(hours: number): number {
  return Math.round(hours * 3600);
}

/** Shape ILPAdapter.LpParams / ISnuggleVault take (rebalanceDelay is uint64 seconds). */
export interface ChainLpParams {
  rangeWidthBps: number;
  rebalanceDelay: bigint;
  autoCompound: boolean;
}

/** Validate then convert to the on-chain tuple. Throws on invalid params. */
export function lpParamsToChain(params: LpParams): ChainLpParams {
  const errors = validateLpParams(params);
  if (errors.length) throw new RangeError(`Invalid LpParams: ${errors.join(" ")}`);
  return {
    rangeWidthBps: params.rangeWidthBps,
    rebalanceDelay: BigInt(rebalanceDelayHoursToSeconds(params.rebalanceDelayHours)),
    autoCompound: params.autoCompoundEnabled,
  };
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Returns a list of human-readable problems; empty means valid.
 * Rejects NaN/±Infinity/non-integers and enforces both bounds tables.
 */
export function validateLpParams(params: LpParams): string[] {
  const errors: string[] = [];
  const { rangeWidthBps, rebalanceDelayHours, autoCompoundEnabled } = params ?? ({} as LpParams);

  if (!isFiniteNumber(rangeWidthBps) || !Number.isInteger(rangeWidthBps)) {
    errors.push("rangeWidthBps must be a finite integer.");
  } else if (rangeWidthBps < RANGE_WIDTH_BOUNDS.min || rangeWidthBps > RANGE_WIDTH_BOUNDS.max) {
    errors.push(
      `rangeWidthBps must be between ${RANGE_WIDTH_BOUNDS.min} and ${RANGE_WIDTH_BOUNDS.max} (total span, ${formatHalfWidthPct(RANGE_WIDTH_BOUNDS.min)} to ${formatHalfWidthPct(RANGE_WIDTH_BOUNDS.max)}).`,
    );
  }

  if (!isFiniteNumber(rebalanceDelayHours)) {
    errors.push("rebalanceDelayHours must be a finite number.");
  } else if (
    rebalanceDelayHours < REBALANCE_DELAY_BOUNDS.minHours ||
    rebalanceDelayHours > REBALANCE_DELAY_BOUNDS.maxHours
  ) {
    errors.push(
      `rebalanceDelayHours must be between ${REBALANCE_DELAY_BOUNDS.minHours} and ${REBALANCE_DELAY_BOUNDS.maxHours}.`,
    );
  }

  if (typeof autoCompoundEnabled !== "boolean") {
    errors.push("autoCompoundEnabled must be a boolean.");
  }
  return errors;
}
