import type { HealthAssessment, HealthBand } from "@zyo/shared";
import { assessHealth, type HealthThresholds } from "../engine/health.js";
import type { RheaService } from "../services/rhea.js";
import type { StrategyStore } from "../store/strategyStore.js";

export type HealthActionHandler = (a: HealthAssessment) => Promise<void>;

/** HF must clear the band threshold by this margin before we call it improved. */
export const HF_HYSTERESIS = 0.05;

const BAND_RANK: Record<HealthBand, number> = { CRITICAL: 0, WARNING: 1, HEALTHY: 2 };

/**
 * Polls Rhea health factors for every active strategy with a borrow leg and
 * dispatches band transitions to the handler (notify / deleverage / unwind).
 *
 * Dispatch discipline:
 *   • Only *transitions* dispatch — a position sitting at WARNING does not
 *     re-alert every tick.
 *   • The dispatch marker is set (in memory AND persisted on the strategy as
 *     `lastDispatchedAction`) BEFORE the handler runs, and rolled back if it
 *     throws. Overlapping ticks and agent restarts therefore cannot
 *     double-dispatch a slow unwind, while a failed handler still retries.
 *   • EMERGENCY_UNWIND additionally persists `status: "UNWINDING"` plus an
 *     `inflightActionId`, so whatever executes the unwind can resume
 *     idempotently after a crash.
 *   • Hysteresis: a band is only LEFT (in the improving direction) once HF
 *     clears the band's threshold by HF_HYSTERESIS — an HF flapping across
 *     1.2 does not spam alternating alerts or repeated partial unwinds.
 */
export class HealthMonitor {
  /** Last dispatched state per strategy, keyed `band:action` (see class doc). */
  private lastState = new Map<string, string>();
  /** Last assessment (post-hysteresis) per strategy, for sticky bands. */
  private lastAssessed = new Map<string, { band: HealthBand; action: HealthAssessment["suggestedAction"] }>();
  private seeded = false;

  constructor(
    private readonly rhea: RheaService,
    private readonly store: StrategyStore,
    private readonly thresholds: HealthThresholds,
    private readonly onAction: HealthActionHandler
  ) {}

  /** Sticky-band assessment: worsening applies immediately, improving needs margin. */
  private assessWithHysteresis(strategyId: string, healthFactor: number): HealthAssessment {
    const fresh = assessHealth(strategyId, healthFactor, this.thresholds);
    const prev = this.lastAssessed.get(strategyId);
    let result = fresh;

    if (prev && Number.isFinite(healthFactor)) {
      const emergency = this.thresholds.emergency ?? 1.05;
      if (BAND_RANK[fresh.band] > BAND_RANK[prev.band]) {
        // Improving out of a band: require margin above that band's threshold.
        const exitThreshold =
          prev.band === "CRITICAL" ? this.thresholds.critical : this.thresholds.warning;
        if (!(healthFactor > exitThreshold + HF_HYSTERESIS)) {
          result = { strategyId, healthFactor, band: prev.band, suggestedAction: prev.action };
        }
      } else if (
        fresh.band === "CRITICAL" &&
        prev.band === "CRITICAL" &&
        prev.action === "EMERGENCY_UNWIND" &&
        fresh.suggestedAction === "REDUCE_LEVERAGE" &&
        !(healthFactor > emergency + HF_HYSTERESIS)
      ) {
        // De-escalating within CRITICAL also needs margin above the emergency rung.
        result = { strategyId, healthFactor, band: prev.band, suggestedAction: prev.action };
      }
    }

    this.lastAssessed.set(strategyId, { band: result.band, action: result.suggestedAction });
    return result;
  }

  async tick(): Promise<HealthAssessment[]> {
    const out: HealthAssessment[] = [];
    const strategies = await this.store.list();

    // Seed dispatch markers from the store once, so a restarted agent does
    // not re-dispatch the action it already fired before the crash.
    if (!this.seeded) {
      for (const s of strategies) {
        if (s.lastDispatchedAction) this.lastState.set(s.id, s.lastDispatchedAction);
      }
      this.seeded = true;
    }

    for (const s of strategies) {
      const hasDebt = s.lending.borrowedAmountAtomic && s.lending.borrowedAmountAtomic !== "0";
      if (!hasDebt || s.status === "CLOSED") continue;

      try {
        const state = await this.rhea.getAccountState(s.lending.mcaId);
        const assessment = this.assessWithHysteresis(s.id, state.healthFactor);
        out.push(assessment);

        // Patch FUNCTION: applied to the CURRENT record at write time, so a
        // concurrent writer's nested lending fields are never clobbered by a
        // snapshot taken before this await.
        await this.store.update(s.id, (cur) => ({
          ...cur,
          lending: { ...cur.lending, healthFactor: state.healthFactor },
        }));

        const stateKey = `${assessment.band}:${assessment.suggestedAction ?? ""}`;
        const prev = this.lastState.get(s.id);
        if (assessment.band !== "HEALTHY" && stateKey !== prev) {
          // Mark BEFORE dispatching (memory + store) so an overlapping tick or
          // a crash-restart cannot dispatch the same action twice; roll back
          // on throw so a failed handler is retried next tick.
          this.lastState.set(s.id, stateKey);
          const isUnwind = assessment.suggestedAction === "EMERGENCY_UNWIND";
          await this.store.update(s.id, (cur) => ({
            ...cur,
            lastDispatchedAction: stateKey,
            ...(isUnwind ? { status: "UNWINDING" as const, inflightActionId: stateKey } : {}),
          }));
          try {
            await this.onAction(assessment);
          } catch (err) {
            if (prev === undefined) this.lastState.delete(s.id);
            else this.lastState.set(s.id, prev);
            await this.store
              .update(s.id, (cur) => ({ ...cur, lastDispatchedAction: prev }))
              .catch(() => {});
            throw err;
          }
        } else {
          this.lastState.set(s.id, stateKey);
        }
      } catch (err) {
        // Log-and-continue: one bad account must not stall the loop.
        console.error(`[health] ${s.id}:`, (err as Error).message);
      }
    }
    return out;
  }
}
