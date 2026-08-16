import type { HealthAssessment } from "@zyo/shared";
import { assessHealth, type HealthThresholds } from "../engine/health.js";
import type { RheaService } from "../services/rhea.js";
import type { StrategyStore } from "../store/strategyStore.js";

export type HealthActionHandler = (a: HealthAssessment) => Promise<void>;

/**
 * Polls Rhea health factors for every active strategy with a borrow leg and
 * dispatches band transitions to the handler (notify / deleverage / unwind).
 * Only *transitions* are dispatched, so a position sitting at WARNING does
 * not re-alert every tick.
 */
export class HealthMonitor {
  /** Last dispatched state per strategy, keyed as `band:action` so an escalation
   *  WITHIN a band (REDUCE_LEVERAGE → EMERGENCY_UNWIND, both CRITICAL) still
   *  dispatches. Deduping on band alone let the emergency-unwind step be
   *  swallowed when a position was already CRITICAL. */
  private lastState = new Map<string, string>();

  constructor(
    private readonly rhea: RheaService,
    private readonly store: StrategyStore,
    private readonly thresholds: HealthThresholds,
    private readonly onAction: HealthActionHandler
  ) {}

  async tick(): Promise<HealthAssessment[]> {
    const out: HealthAssessment[] = [];
    const strategies = await this.store.list();

    for (const s of strategies) {
      const hasDebt = s.lending.borrowedAmountAtomic && s.lending.borrowedAmountAtomic !== "0";
      if (!hasDebt || s.status === "CLOSED") continue;

      try {
        const state = await this.rhea.getAccountState(s.lending.mcaId);
        const assessment = assessHealth(s.id, state.healthFactor, this.thresholds);
        out.push(assessment);

        await this.store.update(s.id, {
          lending: { ...s.lending, healthFactor: state.healthFactor },
        });

        const stateKey = `${assessment.band}:${assessment.suggestedAction ?? ""}`;
        const prev = this.lastState.get(s.id);
        // Dispatch on any non-healthy state we have not already acted on —
        // including a same-band action escalation (partial deleverage →
        // emergency unwind). Advance the marker only AFTER a successful
        // dispatch so a throwing handler is retried next tick rather than
        // being permanently deduped.
        if (assessment.band !== "HEALTHY" && stateKey !== prev) {
          await this.onAction(assessment);
        }
        this.lastState.set(s.id, stateKey);
      } catch (err) {
        // Log-and-continue: one bad account must not stall the loop.
        console.error(`[health] ${s.id}:`, (err as Error).message);
      }
    }
    return out;
  }
}
