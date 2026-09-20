/**
 * Reserve sizing — the Solana-side USDC reserve of the cross-chain loop against ZEC's real price
 * history (`docs/MODEL-RESERVE-2026-09-19.md`; the question `ROADMAP.md` §1 item 4 and
 * `CROSSCHAIN-RUNBOOK-2026-09-13.md` §5 leave open).
 *
 * What the reserve is (`SOLANA-ARCHITECTURE.md` §14.3): the USDC that lifts the health factor (HF)
 * from the repay rung to its disarm level with no collateral change — R = D × (disarm₂ − rung₂) / disarm₂,
 * 4.11 % of the debt at the 1.625 entry Kamino's 40 % loan-to-value (LTV) cap implies. It makes ONE rung-2
 * repay atomic on Solana. Once spent, the next USDC has to cross from Base (five signed steps, Circle in the
 * middle) or the keeper sells the user's ZEC at rung 3 — which is the outcome the loan exists to avoid.
 *
 * So the model asks, on ZEC's own candles: how often does a drawdown run from the reserve's disarm level
 * to rung 3 inside the time a bridged top-up needs, and how does that change with a reserve of k × R?
 * Everything here is pure: the script `scripts/reserve-sizing.mjs` reads the dated sample and prints the
 * tables; `test/reserve-sizing.test.ts` pins the arithmetic and the sample's headline numbers.
 *
 * Model, not advice (CLAUDE.md rule 4): every input is stated, the founder decides the multiple.
 */
import { ladderFor, reserveFractionFor, type HfRung } from "@zyo/shared";

export type Candle = { t: number; o: number; h: number; l: number; c: number };
export type Series = { intervalMin: number; candles: Candle[] };

/** Close-to-close log returns. */
export function logReturns(candles: readonly Candle[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < candles.length; i++) out.push(Math.log(candles[i]!.c / candles[i - 1]!.c));
  return out;
}

/**
 * The series minus its mean. A drawdown model resampled from a month in which ZEC rallied would inherit the
 * rally as drift and see almost no drawdowns; the repo's liquidity simulation (`scripts/lp-sim.py`) is
 * zero-drift for the same reason, so the bootstrap resamples de-meaned returns and says so.
 */
export function demean(xs: readonly number[]): number[] {
  if (!xs.length) return [];
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.map((x) => x - m);
}

/** Sample standard deviation. */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return NaN;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

/** Realized volatility of a series: per bar, and annualized by √(bars per year). */
export function realizedVol(series: Series): { perBar: number; annualized: number; n: number } {
  const r = logReturns(series.candles);
  const perBar = stdev(r);
  const barsPerYear = (365 * 24 * 60) / series.intervalMin;
  return { perBar, annualized: perBar * Math.sqrt(barsPerYear), n: r.length };
}

/** Linear-interpolated quantile of a sample, q in [0, 1]. */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/**
 * For every start bar i, the worst drop within the next `bars` bars: 1 − min(low[i+1 … i+bars]) / close[i].
 * Close-to-low, because a liquidation engine and the keeper both see the wick, not the next close.
 */
export function worstDropWithin(candles: readonly Candle[], bars: number): { drops: number[]; worst: number; p95: number; p99: number; n: number } {
  const drops: number[] = [];
  for (let i = 0; i + bars < candles.length; i++) {
    let lo = Infinity;
    for (let j = i + 1; j <= i + bars; j++) lo = Math.min(lo, candles[j]!.l);
    drops.push(Math.max(0, 1 - lo / candles[i]!.c));
  }
  return { drops, worst: drops.length ? Math.max(...drops) : NaN, p95: quantile(drops, 0.95), p99: quantile(drops, 0.99), n: drops.length };
}

/** How often a drop of at least `threshold` occurred within the window, as a share of windows. */
export function frequencyOfDrop(drops: readonly number[], threshold: number): number {
  if (!drops.length) return NaN;
  return drops.filter((d) => d >= threshold).length / drops.length;
}

/** The ladder's geometry at an entry HF: what price move reaches each rung, from entry and from rung 2's disarm level. */
export function ladderGeometry(entryHf: number): {
  rungs: readonly HfRung[];
  reserveFraction: number;
  fromEntryPct: Record<string, number>;
  fromDisarm2Pct: Record<string, number>;
  liquidationFromEntryPct: number;
  liquidationFromDisarm2Pct: number;
} {
  const rungs = ladderFor(entryHf);
  const repay = rungs.find((r) => r.id === "repay")!;
  const fromEntryPct: Record<string, number> = {};
  const fromDisarm2Pct: Record<string, number> = {};
  for (const r of rungs) {
    fromEntryPct[r.id] = (1 - r.hf / entryHf) * 100;
    fromDisarm2Pct[r.id] = (1 - r.hf / repay.disarmHf) * 100;
  }
  return {
    rungs,
    reserveFraction: reserveFractionFor(entryHf),
    fromEntryPct,
    fromDisarm2Pct,
    liquidationFromEntryPct: (1 - 1 / entryHf) * 100,
    liquidationFromDisarm2Pct: (1 - 1 / repay.disarmHf) * 100,
  };
}

/** mulberry32 — a small seeded generator so a run is reproducible and the test can pin it. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type SimInput = {
  /** Per-bar log returns to resample from (a block bootstrap keeps their short-range dependence). */
  returns: readonly number[];
  /** Bars per path. */
  bars: number;
  paths: number;
  seed: number;
  /** Block length for the bootstrap, in bars. */
  blockLen: number;
  /** Multiply every resampled return by this — 1 is the series as it is; > 1 stresses it. */
  scale: number;
  entryHf: number;
  /** The venue's liquidation threshold as a fraction (Kamino ZEC: 0.65). A sale repays x·p of debt but removes x·p·LT of borrowing power. */
  lt: number;
  /** The reserve held idle, as a multiple of the rung-2 requirement R. */
  reserveMultiple: number;
  /** Bars a bridged top-up (one R) takes to land after the reserve runs short; Infinity = it never comes. */
  landingBars: number;
  /** `bootstrap` (default) resamples blocks at random; `replay` walks the series in order from `startIndex + path`. */
  mode?: "bootstrap" | "replay";
  /** Replay only: the first path starts here; path p starts at startIndex + p, so `paths` rolling windows are walked. */
  startIndex?: number;
};

export type SimOutcome = {
  paths: number;
  /** Share of paths whose worst point reached at least this rung (or liquidation). */
  reachedRepay: number;
  reachedDerisk: number;
  reachedEmergency: number;
  reachedLiquidation: number;
  /** Share of paths on which a top-up had to be requested at all. */
  bridgeNeeded: number;
  /** Share of paths on which some ZEC was sold by the keeper (rung 3 or 4). */
  zecSold: number;
  avgRepays: number;
  /** Of paths where ZEC was sold, the mean share of the collateral that went. */
  avgSoldShareWhenSold: number;
};

/**
 * One position at `entryHf` under the derived ladder, walked through `paths` resampled price paths.
 *
 * Units: price 1 at entry, collateral 1 ZEC, debt in USD; HF = C·p·LT / D, so D at entry = LT / entryHf.
 * Debt is held constant apart from repayments (a month of interest is two orders of magnitude under the
 * moves modelled). Each bar the keeper ticks once — it polls every 30 s, so a bar is the coarse case — and
 * acts on the worst rung crossed:
 *
 *   emergency (rung 4): unwind — every ZEC sold, the debt repaid; the path ends.
 *   derisk    (rung 3): sell exactly the ZEC that lifts HF to rung 3's disarm level:
 *                       x = (target·D − C·p·LT) / (p·(target − LT)).
 *   repay     (rung 2): repay from idle USDC what lifts HF to rung 2's disarm level, or all of it if short;
 *                       if short, request one R from Base, landing `landingBars` later (one in flight at a time).
 *
 * Every rung disarms when it fires and re-arms once HF is back at its disarm level — the hysteresis the
 * keeper runs. HF < 1 counts as liquidation and ends the path; Kamino would liquidate a fifth at a time,
 * a detail below the resolution of a bar.
 */
export function simulateLadder(input: SimInput): SimOutcome {
  const { returns, bars, paths, seed, blockLen, scale, entryHf, lt, reserveMultiple, landingBars, mode = "bootstrap", startIndex = 0 } = input;
  if (!returns.length) throw new RangeError("no returns to resample");
  if (mode === "replay" && startIndex + paths - 1 + bars > returns.length) {
    throw new RangeError(`replay: ${paths} windows of ${bars} bars from ${startIndex} need ${startIndex + paths - 1 + bars} returns, have ${returns.length}`);
  }
  if (!(lt > 0 && lt < 1)) throw new RangeError(`lt must be in (0, 1), got ${lt}`);
  const rungs = ladderFor(entryHf);
  const rung = (id: HfRung["id"]) => rungs.find((r) => r.id === id)!;
  const REPAY = rung("repay"), DERISK = rung("derisk"), EMERGENCY = rung("emergency");
  const R = reserveFractionFor(entryHf); // as a share of the debt
  const rand = rng(seed);

  let reachedRepay = 0, reachedDerisk = 0, reachedEmergency = 0, reachedLiquidation = 0, bridgeNeeded = 0, zecSold = 0, repaysTotal = 0, soldShareTotal = 0;

  for (let p = 0; p < paths; p++) {
    let price = 1;
    let collateral = 1;
    let debt = lt / entryHf;
    let idle = reserveMultiple * R * debt;
    const armed = { repay: true, derisk: true, emergency: true };
    let landing = -1; // the bar at which a requested top-up lands
    let worst = 0; // 2 repay, 3 derisk, 4 emergency, 5 liquidation
    let repays = 0, bridged = false, sold = 0;
    const hfOf = () => (collateral * price * lt) / debt;

    let blockStart = 0, inBlock = blockLen; // the first bar opens a block
    for (let bar = 0; bar < bars; bar++) {
      let r: number;
      if (mode === "replay") r = returns[startIndex + p + bar]!;
      else {
        if (inBlock === blockLen) { blockStart = Math.floor(rand() * returns.length); inBlock = 0; }
        r = returns[(blockStart + inBlock++) % returns.length]!;
      }
      price *= Math.exp(scale * r);
      if (landing === bar) { idle += R * debt; landing = -1; }
      let hf = hfOf();
      if (hf < 1) { worst = 5; break; }
      if (!armed.repay && hf >= REPAY.disarmHf) armed.repay = true;
      if (!armed.derisk && hf >= DERISK.disarmHf) armed.derisk = true;
      if (!armed.emergency && hf >= EMERGENCY.disarmHf) armed.emergency = true;

      if (armed.emergency && hf <= EMERGENCY.hf) {
        worst = Math.max(worst, 4); sold += collateral; collateral = 0; debt = 0; break;
      }
      if (armed.derisk && hf <= DERISK.hf) {
        worst = Math.max(worst, 3);
        const target = DERISK.disarmHf;
        let x = (target * debt - collateral * price * lt) / (price * (target - lt));
        x = Math.min(Math.max(x, 0), collateral);
        collateral -= x; sold += x; debt -= x * price;
        armed.derisk = false;
        if (debt <= 1e-12) { debt = 0; break; }
        hf = hfOf();
      }
      if (armed.repay && hf <= REPAY.hf) {
        worst = Math.max(worst, 2);
        const need = debt * (1 - hf / REPAY.disarmHf); // the repay that lifts HF to disarm₂
        const pay = Math.min(need, idle);
        if (pay > 0) { debt -= pay; idle -= pay; repays++; }
        armed.repay = false;
        if (pay < need) { bridged = true; if (landing < 0 && Number.isFinite(landingBars)) landing = bar + landingBars; }
        if (debt <= 1e-12) { debt = 0; break; }
      }
    }
    if (worst >= 2) reachedRepay++;
    if (worst >= 3) reachedDerisk++;
    if (worst >= 4) reachedEmergency++;
    if (worst >= 5) reachedLiquidation++;
    if (bridged) bridgeNeeded++;
    if (sold > 0) { zecSold++; soldShareTotal += sold; }
    repaysTotal += repays;
  }
  return {
    paths,
    reachedRepay: reachedRepay / paths,
    reachedDerisk: reachedDerisk / paths,
    reachedEmergency: reachedEmergency / paths,
    reachedLiquidation: reachedLiquidation / paths,
    bridgeNeeded: bridgeNeeded / paths,
    zecSold: zecSold / paths,
    avgRepays: repaysTotal / paths,
    avgSoldShareWhenSold: zecSold ? soldShareTotal / zecSold : 0,
  };
}

/** Kraken's public OHLC rows are strings: [time, open, high, low, close, vwap, volume, count]. The last row is the open candle. */
export function parseKrakenOhlc(rows: readonly (readonly (string | number)[])[], { dropOpenCandle = true } = {}): Candle[] {
  const all = rows.map((r) => ({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]) }));
  for (const c of all) if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite) || c.l <= 0 || c.c <= 0) throw new RangeError(`bad candle ${JSON.stringify(c)}`);
  return dropOpenCandle ? all.slice(0, -1) : all;
}
