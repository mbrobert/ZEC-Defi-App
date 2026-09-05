/**
 * Health-factor ladder state machine with hysteresis and re-arm.
 *
 * The rungs come from packages/shared (`HF_LADDER`); this module only knows
 * their SHAPE. It never types a threshold of its own.
 *
 * Semantics (AUDIT-FINDINGS Part 4, "Working-hard ladder had zero hysteresis
 * … and was a one-way latch"):
 *   • a rung FIRES when HF < rung.hf and the rung is armed;
 *   • a fired rung stays fired until HF ≥ rung.disarmHf (= hf + hysteresis),
 *     at which point it RE-ARMS and can fire again on the next crossing;
 *   • several rungs may be crossed in one step (a gap down); the most severe
 *     newly-crossed rung is the one whose action dispatches, the others are
 *     marked fired so they do not fire "late" on the way down;
 *   • an EPISODE starts when the first rung fires from a fully-armed state and
 *     ends when every rung has re-armed. Episode numbers are allocated by the
 *     store (monotonic, persisted before dispatch), not here.
 *
 * Pure: no I/O, no clock, no randomness.
 */

export interface LadderRung {
  id: string;
  /** Fires when HF < hf. */
  hf: number;
  /** Re-arms when HF ≥ disarmHf. */
  disarmHf: number;
  /** Higher = more severe. */
  severity: number;
  action: string;
}

export interface LadderState {
  /** Ids of rungs currently fired (not armed). */
  fired: readonly string[];
}

export interface LadderStep {
  next: LadderState;
  /** Rungs newly crossed this step, mildest → most severe. */
  crossed: LadderRung[];
  /** Most severe newly crossed rung — the one to dispatch — or null. */
  fire: LadderRung | null;
  /** Rungs that re-armed this step. */
  rearmed: LadderRung[];
  episodeStarted: boolean;
  episodeEnded: boolean;
}

export const INITIAL_LADDER_STATE: LadderState = Object.freeze({ fired: Object.freeze([]) as readonly string[] });

export class LadderShapeError extends Error {
  constructor(msg: string) {
    super(`ladder: ${msg}`);
    this.name = "LadderShapeError";
  }
}

/**
 * Refuse a ladder that cannot behave: every rung needs disarm strictly above
 * trigger (otherwise no hysteresis — the exact bug), thresholds must be
 * strictly decreasing with severity, ids unique, everything finite and > 0.
 */
export function validateLadder(ladder: readonly LadderRung[]): void {
  if (ladder.length === 0) throw new LadderShapeError("empty");
  const ids = new Set<string>();
  const bySeverity = [...ladder].sort((a, b) => a.severity - b.severity);
  let prevHf = Number.POSITIVE_INFINITY;
  let prevSev = -Infinity;
  for (const r of bySeverity) {
    if (ids.has(r.id)) throw new LadderShapeError(`duplicate rung id ${r.id}`);
    ids.add(r.id);
    if (!Number.isFinite(r.hf) || r.hf <= 0) throw new LadderShapeError(`${r.id}: hf must be finite and > 0`);
    if (!Number.isFinite(r.disarmHf) || r.disarmHf <= r.hf) {
      throw new LadderShapeError(`${r.id}: disarmHf (${r.disarmHf}) must exceed hf (${r.hf}) — no hysteresis`);
    }
    if (!Number.isFinite(r.severity) || r.severity <= prevSev) {
      throw new LadderShapeError(`${r.id}: severity must strictly increase`);
    }
    if (r.hf >= prevHf) throw new LadderShapeError(`${r.id}: hf must strictly decrease with severity`);
    if (typeof r.action !== "string" || r.action.length === 0) throw new LadderShapeError(`${r.id}: missing action`);
    prevHf = r.hf;
    prevSev = r.severity;
  }
}

export function stepLadder(ladder: readonly LadderRung[], state: LadderState, hf: number): LadderStep {
  if (typeof hf !== "number" || Number.isNaN(hf) || hf < 0) {
    // Callers must never reach here with an unreadable HF — the valuation
    // returns UNKNOWN and the monitor skips the ladder. Throwing (not
    // "healthy") is the fail-closed backstop.
    throw new LadderShapeError(`unreadable health factor ${String(hf)}`);
  }
  const fired = new Set(state.fired);
  const wasClear = fired.size === 0;
  const crossed: LadderRung[] = [];
  const rearmed: LadderRung[] = [];

  for (const r of ladder) {
    if (fired.has(r.id)) {
      if (hf >= r.disarmHf) {
        fired.delete(r.id);
        rearmed.push(r);
      }
    } else if (hf < r.hf) {
      fired.add(r.id);
      crossed.push(r);
    }
  }

  crossed.sort((a, b) => a.severity - b.severity);
  const fire = crossed.length ? crossed[crossed.length - 1] : null;
  const isClear = fired.size === 0;
  const next: LadderState = { fired: Object.freeze([...fired].sort()) };
  return {
    next,
    crossed,
    fire,
    rearmed,
    episodeStarted: wasClear && crossed.length > 0,
    episodeEnded: !wasClear && isClear,
  };
}

/** The most severe rung whose threshold `hf` is below, or null when healthy. */
export function rungFor(ladder: readonly LadderRung[], hf: number): LadderRung | null {
  if (typeof hf !== "number" || Number.isNaN(hf) || hf < 0) {
    throw new LadderShapeError(`unreadable health factor ${String(hf)}`);
  }
  let hit: LadderRung | null = null;
  for (const r of ladder) if (hf < r.hf && (hit === null || r.severity > hit.severity)) hit = r;
  return hit;
}
