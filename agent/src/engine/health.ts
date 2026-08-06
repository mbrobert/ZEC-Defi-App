import type { HealthAssessment, HealthBand } from "@zyo/shared";

/**
 * Pure health-factor classification for a Rhea lending position.
 *
 * Bands (defaults; configurable):
 *   HF > warning            → HEALTHY
 *   critical < HF ≤ warning → WARNING   → NOTIFY user
 *   emergency < HF ≤ critical → CRITICAL → REDUCE_LEVERAGE (partial repay)
 *   HF ≤ emergency          → CRITICAL  → EMERGENCY_UNWIND (exit LP, repay)
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

  if (healthFactor > t.warning || !Number.isFinite(healthFactor)) {
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
