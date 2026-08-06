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
  private lastBand = new Map<string, string>();

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

        const prev = this.lastBand.get(s.id);
        this.lastBand.set(s.id, assessment.band);
        const worsened = assessment.band !== "HEALTHY" && assessment.band !== prev;
        const escalated =
          prev === "WARNING" && assessment.band === "CRITICAL";
        if (worsened || escalated) await this.onAction(assessment);
      } catch (err) {
        // Log-and-continue: one bad account must not stall the loop.
        console.error(`[health] ${s.id}:`, (err as Error).message);
      }
    }
    return out;
  }
}
