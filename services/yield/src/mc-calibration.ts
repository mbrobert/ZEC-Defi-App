/**
 * The Monte-Carlo calibration of the closed form — the serving path's answer
 * to the closed form's one disclosed blind spot.
 *
 * THE DEFECT (audit wave 1, lens D HIGH-1). `src/model.ts`'s
 *     lpNet = (1 − e^{−x})(r/x − 1)
 * is correct algebra for a position that is ALWAYS in range. A real
 * concentrated position spends part of the year outside its band earning
 * nothing, and pays a swap+slippage cost at every re-centre. The closed form
 * ignores both, so it is OPTIMISTIC — and the size of the error scales with
 * the emissions level, which makes it *smallest* in today's deeply-negative
 * cells (+0.0 … +4.5 pt, which is all the committed validation run measures)
 * and *largest* exactly at the boundary where the gate flips. Measured at the
 * boundary the gap is 7.41 pt (300 bps, σ 0.40) to 32.18 pt (150 bps,
 * σ 0.33) — wider than the 4.828 % borrow rate the gate compares against. A
 * pool could be offered at "+5 % LP net vs 4.828 % borrow" while the product's
 * own Monte Carlo returns −27 %/yr for the same position.
 *
 * THE FIX. The gate no longer decides on the closed form alone. It also
 * prices the cell with an MC-CALIBRATED form and requires BOTH to clear the
 * borrow; a cell where they disagree is inside the model's own uncertainty
 * band and is refused with `within_model_uncertainty`. The closed form stays
 * the published headline (`lpNetPct`) so MODEL-NUMBERS and the web pin do not
 * move; the MC-calibrated number is served alongside it as `mcLpNetPct`.
 *
 * WHY A TWO-COEFFICIENT TABLE IS EXACT, NOT AN APPROXIMATION. In the Monte
 * Carlo (`scripts/lp-sim.py`) emissions accrue as
 *     Σ_t 1{in range} · r/H · mintValue_t
 * and neither `1{in range}` nor `mintValue` depends on r: the price path, the
 * re-centring schedule and the rebalance costs are all emissions-blind. So MC
 * lpNet is EXACTLY AFFINE in the net emissions rate:
 *
 *     mcLpNet(net) = net · inRangeEmissionsFactor + mcDragPct
 *
 * with `inRangeEmissionsFactor` = the value-weighted fraction of the year the
 * position is in range (≤ 1) and `mcDragPct` = the MC's own drag including
 * rebalance costs. Both are functions of (σ, width, rebalance delay, pool fee)
 * only. One MC run per pool × setting therefore calibrates the cell for EVERY
 * emissions level — including the boundary the gate actually decides at, which
 * is the level no committed validation row has ever sat on.
 *
 * FAIL CLOSED. A cell with no calibration entry is refused
 * (`mc_calibration_unavailable`). A calibration taken at a LOWER σ than the
 * live one is optimistic and is refused (`mc_calibration_stale`) — recalibrate
 * with `npm run model`. A calibration taken at a LOWER pool fee than the live
 * one is corrected downward rather than refused: extra fee is a known,
 * computable rebalance cost (`rebalancesPerYear × Δfee/2`), so the served
 * number just gets more conservative. A calibration taken at a HIGHER σ or
 * fee than live is conservative and is accepted as-is.
 */

import { existsSync, readFileSync } from "node:fs";

/** One calibrated pool × setting cell. */
export interface McCalibrationCell {
  poolId: string;
  setting: string;
  /** TOTAL tick span the cell was calibrated at — must match the served width exactly. */
  rangeWidthBps: number;
  rebalanceDelayHours: number;
  /** Annualized σ the MC ran at. A live σ ABOVE this invalidates the cell. */
  sigma: number;
  /** Pool fee (bps) the MC charged at each re-centre. A live fee ABOVE this is corrected for. */
  feeBps: number;
  /**
   * Value-weighted fraction of the year the position is in range:
   * `mcLpNet = net × this + mcDragPct`. It multiplies the NET emissions rate,
   * so it carries NO keep factor of its own. Below 1 for two compounding
   * reasons — time out of range, and emissions accruing on a base the drag is
   * shrinking — and above 1 only on the rare path set where the position
   * appreciates in numeraire terms faster than it decays.
   */
  inRangeEmissionsFactor: number;
  /** The MC's drag vs HODL including rebalance cost, percent (≤ 0). */
  mcDragPct: number;
  /** Reported for observability and for the fee correction. */
  timeInRange: number;
  rebalancesPerYear: number;
}

export interface McCalibration {
  generatedAt: string;
  method: string;
  paths: number;
  seed: number;
  cells: McCalibrationCell[];
}

/**
 * σ tolerance before a calibration counts as stale. Serving σ is a committed,
 * deliberately-edited file, so this is tight — it exists only to absorb the
 * JSON round-trip, not to paper over a recalibration.
 */
export const MC_SIGMA_TOLERANCE = 1e-9;

export type McApplication =
  | { ok: true; cell: McCalibrationCell; mcLpNetPct: number; feeCorrectionPct: number }
  | { ok: false; reason: "mc_calibration_unavailable" | "mc_calibration_stale" };

class McCalibrationError extends Error {
  constructor(detail: string) {
    super(`mc calibration: ${detail}`);
    this.name = "McCalibrationError";
  }
}

function finite(x: unknown): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

/**
 * Load and validate a calibration file. Returns null when the file is absent
 * — the gate then refuses every cell with `mc_calibration_unavailable`, which
 * is the fail-closed direction. A file that EXISTS but is malformed throws:
 * a corrupt calibration must not degrade quietly into "no calibration".
 */
export function loadMcCalibration(path: string): McCalibration | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as McCalibration;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.cells)) {
    throw new McCalibrationError(`unexpected shape in ${path}`);
  }
  for (const c of raw.cells) {
    const where = `${c?.poolId}/${c?.setting}`;
    if (!c || typeof c.poolId !== "string" || typeof c.setting !== "string") {
      throw new McCalibrationError(`${path}: a cell is missing poolId/setting`);
    }
    if (!(finite(c.rangeWidthBps) && c.rangeWidthBps > 0)) throw new McCalibrationError(`${where}: rangeWidthBps`);
    if (!(finite(c.sigma) && c.sigma > 0 && c.sigma < 5)) throw new McCalibrationError(`${where}: sigma`);
    if (!(finite(c.feeBps) && c.feeBps >= 0)) throw new McCalibrationError(`${where}: feeBps`);
    if (!(finite(c.inRangeEmissionsFactor) && c.inRangeEmissionsFactor >= 0 && c.inRangeEmissionsFactor <= 2)) {
      throw new McCalibrationError(`${where}: inRangeEmissionsFactor must be in [0,2]`);
    }
    if (!(finite(c.mcDragPct) && c.mcDragPct <= 0)) throw new McCalibrationError(`${where}: mcDragPct must be ≤ 0`);
    if (!(finite(c.rebalancesPerYear) && c.rebalancesPerYear >= 0)) throw new McCalibrationError(`${where}: rebalancesPerYear`);
  }
  return raw;
}

/**
 * Prototype-safe lookup key. The separator cannot appear in a curated pool id
 * or a setting id, so `${poolId}${KEY_SEPARATOR}${setting}` is unambiguous.
 */
export const KEY_SEPARATOR = "|";

export function calibrationKey(poolId: string, setting: string): string {
  return `${poolId}${KEY_SEPARATOR}${setting}`;
}

export function calibrationIndex(cal: McCalibration | null): Map<string, McCalibrationCell> {
  const m = new Map<string, McCalibrationCell>();
  for (const c of cal?.cells ?? []) m.set(calibrationKey(c.poolId, c.setting), c);
  return m;
}

/**
 * Price one cell with the MC-calibrated form.
 *
 *   mcLpNet = net × inRangeEmissionsFactor + mcDragPct − feeCorrection
 *
 * `feeCorrection` charges the rebalance cost the calibration did NOT pay when
 * the pool's live fee is above the calibrated one: every re-centre swaps half
 * the position, so an extra `Δfee` costs `rebalancesPerYear × Δfee/2` of value
 * over the year. A live fee at or below the calibrated one earns no credit —
 * the calibration is then already conservative.
 */
export function applyMcCalibration(input: {
  index: Map<string, McCalibrationCell>;
  poolId: string;
  setting: string;
  rangeWidthBps: number;
  sigma: number;
  liveFeeBps: number;
  emissionsNetPct: number;
}): McApplication {
  const { index, poolId, setting, rangeWidthBps, sigma, liveFeeBps, emissionsNetPct } = input;
  const cell = index.get(calibrationKey(poolId, setting));
  if (!cell) return { ok: false, reason: "mc_calibration_unavailable" };
  // The width is a property of the setting; a mismatch means the presets moved
  // under the calibration and every coefficient in it is for another position.
  if (cell.rangeWidthBps !== rangeWidthBps) return { ok: false, reason: "mc_calibration_stale" };
  // A calibration run at a calmer σ than today's understates both the drag and
  // the time out of range. Refuse rather than extrapolate.
  if (sigma > cell.sigma + MC_SIGMA_TOLERANCE) return { ok: false, reason: "mc_calibration_stale" };
  const extraFeeBps = Number.isFinite(liveFeeBps) ? Math.max(0, liveFeeBps - cell.feeBps) : 0;
  const feeCorrectionPct = (100 * cell.rebalancesPerYear * (extraFeeBps / 10_000)) / 2;
  const mcLpNetPct = emissionsNetPct * cell.inRangeEmissionsFactor + cell.mcDragPct - feeCorrectionPct;
  return { ok: true, cell, mcLpNetPct, feeCorrectionPct };
}
