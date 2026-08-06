import type { LpParams, RangePreset, RangePresetDef } from "./types.js";

/**
 * Range-width presets aligned with Snuggle's documented bands:
 *   Aggressive 0.5–3%, Moderate 3.5–15%, Conservative 15–50%.
 */
export const RANGE_PRESETS: RangePresetDef[] = [
  {
    preset: "CONSERVATIVE",
    label: "Conservative",
    description:
      "Wide range (15–50%). Stays in range through large moves; lower fee APR, fewer rebalances.",
    defaultRangeWidthBps: 2500,
    minRangeWidthBps: 1500,
    maxRangeWidthBps: 5000,
    defaultRebalanceDelayHours: 48,
  },
  {
    preset: "MODERATE",
    label: "Moderate",
    description:
      "Balanced range (3.5–15%). Good fee capture with tolerable rebalance frequency.",
    defaultRangeWidthBps: 800,
    minRangeWidthBps: 350,
    maxRangeWidthBps: 1500,
    defaultRebalanceDelayHours: 12,
  },
  {
    preset: "AGGRESSIVE",
    label: "Aggressive",
    description:
      "Tight range (0.5–3%). Maximum fee capture; frequent out-of-range periods and rebalances.",
    defaultRangeWidthBps: 150,
    minRangeWidthBps: 50,
    maxRangeWidthBps: 300,
    defaultRebalanceDelayHours: 2,
  },
];

export const REBALANCE_DELAY_BOUNDS = { minHours: 0, maxHours: 168 } as const;

export function presetToLpParams(preset: Exclude<RangePreset, "CUSTOM">): LpParams {
  const def = RANGE_PRESETS.find((p) => p.preset === preset);
  if (!def) throw new Error(`Unknown preset: ${preset}`);
  return {
    rangeWidthBps: def.defaultRangeWidthBps,
    rebalanceDelayHours: def.defaultRebalanceDelayHours,
    autoCompoundEnabled: true,
  };
}

export function validateLpParams(params: LpParams): string[] {
  const errors: string[] = [];
  if (params.rangeWidthBps < 1 || params.rangeWidthBps > 5000) {
    errors.push("rangeWidthBps must be between 1 (0.01%) and 5000 (50%).");
  }
  if (
    params.rebalanceDelayHours < REBALANCE_DELAY_BOUNDS.minHours ||
    params.rebalanceDelayHours > REBALANCE_DELAY_BOUNDS.maxHours
  ) {
    errors.push("rebalanceDelayHours must be between 0 and 168 (7 days).");
  }
  return errors;
}
