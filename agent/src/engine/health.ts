import type { HealthAssessment, HealthBand } from "@zyo/shared";

/**
 * Pure health-factor classification for a Rhea lending position.
 *
 * Bands (defaults; configurable):
 *   HF = +Infinity (no debt) → HEALTHY
 *   HF > warning            → HEALTHY
 *   critical < HF ≤ warning → WARNING   → NOTIFY user
 *   emergency < HF ≤ critical → CRITICAL → REDUCE_LEVERAGE (partial repay)
 *   HF ≤ emergency          → CRITICAL  → EMERGENCY_UNWIND (exit LP, repay)
 *   HF is NaN / negative     → CRITICAL  → NOTIFY (suspect data — escalate to a
 *                              human, but never auto-unwind on a bad feed, and
 *                              NEVER silently treat suspect data as HEALTHY)
 */
export interface HealthThresholds {
  warning: number; // e.g. 1.5
  critical: number; // e.g. 1.2
  emergency?: number; // default 1.05
}

export function assessHealth(
  strategyId: string,
  healthFactor: number,
  t: HealthThresholds
): HealthAssessment {
  const emergency = t.emergency ?? 1.05;
  let band: HealthBand;
  let suggestedAction: HealthAssessment["suggestedAction"];

  if (Number.isNaN(healthFactor) || healthFactor < 0) {
    // Suspect data (0/0 valuation, bad oracle, negative). A borrow leg exists
    // by the time we assess, so this is never "no debt" — fail CLOSED to a
    // human, do not auto-act on a possibly-bad number, and never call it
    // HEALTHY. This is the fix for the old `!Number.isFinite` fail-open where
    // NaN was swept in with +Infinity.
    band = "CRITICAL";
    suggestedAction = "NOTIFY";
  } else if (healthFactor === Infinity) {
    // Genuinely no debt → healthy.
    band = "HEALTHY";
  } else if (healthFactor > t.warning) {
    band = "HEALTHY";
  } else if (healthFactor > t.critical) {
    band = "WARNING";
    suggestedAction = "NOTIFY";
  } else if (healthFactor > emergency) {
    band = "CRITICAL";
    suggestedAction = "REDUCE_LEVERAGE";
  } else {
    band = "CRITICAL";
    suggestedAction = "EMERGENCY_UNWIND";
  }

  return { strategyId, healthFactor, band, suggestedAction };
}
