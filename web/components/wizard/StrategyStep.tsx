"use client";

import { FEES, RANGE_WIDTH_BOUNDS, REBALANCE_DELAY_BOUNDS, type CollateralSymbol } from "@zyo/shared";
import { bestPerPool, cellsFor, entryFromCell, refusalPlain, unpricedPlain, userNetAtLtv, type ForecastCell, type ForecastView } from "@/lib/forecast";
import { useMode } from "@/lib/mode";
import { MAX_BAND_TOLERANCE_BPS } from "@/lib/plan";
import { recommend } from "@/lib/recommend";
import type { StrategyChoice, WizardState } from "@/lib/wizard";
import { fmtHalfWidth } from "@/lib/math";
import { fmtPct, fmtSignedPct } from "@/lib/format";
import { useNotifyPrefs, type NotifyChannel } from "@/lib/notifyPrefs";
import { TokenPair } from "@/components/TokenMark";
import Chip from "@/components/Chip";

/**
 * Strategy picker — the forecast, not a gate (BUILD-PLAN-2026-09-12 D4/D5, 2026-09-12).
 *   Simple:   every curated pool, one card each at its best-forecast setting, sorted by the net on
 *             the user's collateral at the chosen LTV; the best is marked, and when the best is a
 *             loss the recommendation says so. Hold stays a choice.
 *   Advanced: every pool × setting with both models' numbers and the gap between them, custom
 *             width / delay / price tolerance, keeper-protection toggle, hold and spot.
 * Nothing here is disabled for being a bad forecast; only the service's safety refusals disable a
 * card, with the reason.
 */
export default function StrategyStep({
  forecast,
  state,
  ltvBps,
  borrowAprPct,
  onChange,
  unsupportedVenues = [],
}: {
  forecast: ForecastView;
  state: WizardState;
  ltvBps: number;
  borrowAprPct: number;
  onChange: (patch: Partial<WizardState>) => void;
  /** Collateral assets whose registry venue does not answer the venue interface the keeper reads (audit wave 2, M-HIGH-2). */
  unsupportedVenues?: readonly CollateralSymbol[];
}) {
  const { mode } = useMode();
  const { prefs: notifyPrefs, setPrefs: setNotifyPrefs } = useNotifyPrefs();
  const collateral: CollateralSymbol = state.collateral;
  const venueUnsupported = unsupportedVenues.includes(collateral);
  const choice = state.strategy;
  const all = cellsFor(forecast, collateral, ltvBps);
  const cells = mode === "simple" ? bestPerPool(all, ltvBps) : all;
  const rec = recommend(forecast, collateral, ltvBps);
  const isSel = (c: ForecastCell) => choice?.kind === "lp" && choice.entry.poolId === c.poolId && choice.entry.setting === c.setting;
  const engineFeePct = forecast.engineFeeBps !== null ? forecast.engineFeeBps / 100 : null;
  const choose = (c: StrategyChoice) => onChange({ strategy: c, acknowledged: false });
  const borrowShown = forecast.borrowAprPct ?? borrowAprPct;

  const forecastLine = (
    <span className="text-oil-ink3" data-testid="gate-line">
      Forecast: {forecast.source === "live" ? "yield service" : "yield model, demo"}
      {forecast.stale ? " · SAMPLE STALE — read the numbers as history, not as today" : ""}
      {forecast.emissionsSampledAt ? ` · emissions sampled ${forecast.emissionsSampledAt.slice(0, 16).replace("T", " ")}Z` : ""}
      {forecast.volatilityAsOf ? ` · σ as of ${forecast.volatilityAsOf}` : ""}
      {forecast.mcCalibrationGeneratedAt ? ` · risk model calibrated ${forecast.mcCalibrationGeneratedAt.slice(0, 10)}` : ""}
      {engineFeePct !== null ? ` · engine fee ${engineFeePct}%` : ""}
    </span>
  );

  const card = (c: ForecastCell) => {
    const un = userNetAtLtv(c, ltvBps);
    const mcUn = userNetAtLtv(c, ltvBps, c.mcLpNetPct);
    const best = rec.kind === "lp" && rec.cell.poolId === c.poolId && rec.cell.setting === c.setting;
    const refused = !c.allowed && c.refusals.length > 0;
    const tone = un === null ? "text-oil-ink3" : un >= 0 ? "text-status-good" : "text-status-crit";
    return (
      <button
        key={`${c.poolId}-${c.setting}`}
        type="button"
        role="radio"
        aria-checked={isSel(c)}
        aria-disabled={refused}
        disabled={refused}
        className={`opt flex w-full min-w-0 items-center gap-3.5 ${isSel(c) ? "sel" : ""} ${refused ? "opacity-55" : ""}`}
        onClick={() => !refused && choose({ kind: "lp", entry: entryFromCell(c) })}
        data-testid={`strategy-${c.poolId}-${c.setting}`}
        data-priced={c.lpPriced ? "1" : "0"}
      >
        <TokenPair a={c.pool.token0} b={c.pool.token1} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
            {c.pool.token0}/{c.pool.token1}
            <Chip kind="mute">
              {c.preset.toLowerCase()} · {fmtHalfWidth(c.rangeWidthBps)}
            </Chip>
            {best && <Chip kind="brass">{rec.kind === "lp" && rec.positive ? "best forecast" : "least bad forecast"}</Chip>}
            {!c.lpPriced && <Chip kind="warn">not priced</Chip>}
            {c.lpPriced && c.clearsBorrow.both === true && <Chip kind="good">beats the borrow, both models</Chip>}
            {c.lpPriced && c.clearsBorrow.both !== true && <Chip kind="crit">below the borrow</Chip>}
            {c.stale && <Chip kind="warn">stale sample</Chip>}
          </div>
          {c.lpPriced ? (
            <div className="num mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-[12.3px] text-oil-ink3" data-testid={`forecast-${c.poolId}-${c.setting}`}>
              {/* Every number D5 asks for, in groups that wrap at the separators instead of mid-phrase; the
                  two-model comparison is the same fact, one step dimmer, because it qualifies LP net rather
                  than standing beside it. Do not collapse the text — BETA-SCOPE's yield row names it. */}
              <span>
                rewards {fmtPct(c.emissionsGrossPct ?? NaN, 1)} gross → {fmtPct(c.emissionsNetPct ?? NaN, 1)} after fees
              </span>
              <span aria-hidden="true" className="text-oil-ink3/50">·</span>
              <span>price-move drag {fmtSignedPct(c.dragPct ?? NaN, 1)}</span>
              <span aria-hidden="true" className="text-oil-ink3/50">·</span>
              <span>
                LP net {fmtSignedPct(c.lpNetPct ?? NaN, 2)}{" "}
                <span className="text-oil-ink3/70">
                  (stricter model {c.mcLpNetPct === null ? "—" : fmtSignedPct(c.mcLpNetPct, 2)}
                  {c.modelGapPts !== null ? `, gap ${c.modelGapPts.toFixed(2)} pt` : ""})
                </span>
              </span>
              <span aria-hidden="true" className="text-oil-ink3/50">·</span>
              <span>borrow −{fmtPct(c.borrowAprAfterPct ?? c.borrowAprNowPct ?? borrowShown, 2)}</span>
              {c.breakEvenEmissionsMultiple !== null && (
                <>
                  <span aria-hidden="true" className="text-oil-ink3/50">·</span>
                  <span>{`needs ${c.breakEvenEmissionsMultiple.toFixed(2)}× today's rewards to break even`}</span>
                </>
              )}
            </div>
          ) : (
            <div className="mt-0.5 text-[12.3px] text-oil-ink3" data-testid={`forecast-${c.poolId}-${c.setting}`}>
              No forecast: {unpricedPlain(c.lpUnpricedReason)}
              {c.emissionsNetPct !== null ? ` Rewards read at ${fmtPct(c.emissionsNetPct, 1)} after fees.` : ""}
            </div>
          )}
          {refused && (
            <div className="mt-0.5 text-[12.3px] text-status-crit" data-testid={`refusal-${c.poolId}-${c.setting}`}>
              {c.refusals.map((r) => refusalPlain(r, c.borrowVenue)).join(" ")}
            </div>
          )}
          {c.pool.note && <div className="mt-0.5 text-[12px] text-oil-ink3">{c.pool.note}</div>}
        </div>
        <div className="flex-none text-right">
          <div className={`num text-[16px] font-bold ${tone}`}>{un === null ? "—" : fmtSignedPct(un, 1)}</div>
          <div className="max-w-[96px] text-[11px] leading-tight text-oil-ink3">
            {un === null ? "no forecast" : `a year on your ${collateral} at ${ltvBps / 100}% LTV`}
            {mcUn !== null && un !== null ? ` (stricter ${fmtSignedPct(mcUn, 1)})` : ""}
          </div>
        </div>
      </button>
    );
  };

  const holdCard = (
    <button type="button" role="radio" aria-checked={choice?.kind === "hold"} className={`opt ${choice?.kind === "hold" ? "sel" : ""}`} onClick={() => choose({ kind: "hold" })} data-testid="strategy-hold">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">Keep the borrowed USDC in your account</span>
        <Chip kind="mute">no LP</Chip>
        {rec.kind === "hold" && <Chip kind="brass">recommended today</Chip>}
      </div>
      <p className="mt-1 text-[12.8px] text-oil-ink2">Borrow and hold. You pay the borrow rate; nothing is deployed; you can close the loan any time. Liquidity without selling your {collateral}.</p>
    </button>
  );

  const notify = (text: string) => (
    <label className="flex cursor-pointer items-center gap-2 text-[13.5px]">
      <input type="checkbox" className="accent-brass" checked={notifyPrefs.optIn} onChange={(e) => setNotifyPrefs({ ...notifyPrefs, optIn: e.target.checked })} data-testid="notify-optin" />
      {text}
    </label>
  );

  if (mode === "simple") {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-[19px]">The forecast</h2>
          <p className="mt-1 text-[13.5px] text-oil-ink2">
            Every pool, with the number our model expects it to earn or lose on your {collateral} over a year after every fee, the loss from the price moving, and the {fmtPct(borrowShown)} you pay to borrow. Two models price each pool and they disagree; the stricter one is shown in brackets. Any of them can be opened — read the number first. {forecastLine}
          </p>
        </div>
        <p className="note note-warn text-[13px]" data-testid="recommendation-note">
          {rec.kind === "lp" ? rec.why : rec.why}
          {rec.kind === "hold" && rec.closest ? ` The first pool below, ${rec.closest.pool.token0}/${rec.closest.pool.token1}: ${rec.closestWhy}` : ""}
        </p>
        <div className="grid gap-2.5" role="radiogroup" aria-label="Strategy">
          {cells.map(card)}
          {holdCard}
        </div>
        {notify("Tell me in the app if this position needs attention — a banner on your dashboard, nothing signed or sent anywhere.")}
        {venueUnsupported && (
          <p className="note note-crit" role="alert" data-testid="keeper-venue-unsupported">
            The Oilskin keeper cannot watch {collateral} right now: the registry points it at a lending contract that does not answer the venue interface the keeper reads, so this position would open without protection. Nothing will act for you if its health factor falls.
          </p>
        )}
        <p className="text-[12.5px] text-oil-ink3">Simple mode shows each pool at its best setting. Advanced mode (top right) shows every setting, custom band widths, and spot swaps.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px]">Choose a strategy</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">
          Every pool × setting, priced two ways. LP net is the published closed form: emissions after the engine&rsquo;s {engineFeePct !== null ? `${engineFeePct}%` : "cut"} and Oilskin&rsquo;s {FEES.performanceBps / 100}% fee, realised on the impermanent-loss-shrunk base, plus the IL drag. The stricter Monte-Carlo-calibrated form also charges the time the position spends out of range; the closed form is the optimistic one — by up to 32 points at the boundary — and the gap between them is printed on every row. Whether a cell beats the live USDC borrow rate ({fmtPct(borrowShown)}) on both forms is shown, not enforced. Emissions only; trading fees are not counted. {forecastLine}
        </p>
      </div>

      {forecast.unavailableReason && (
        <div className="note note-warn" role="alert" data-testid="gate-unavailable">
          The yield service could not be reached; the numbers below are the demo snapshot from {forecast.emissionsSampledAt.slice(0, 10) || "the last recording"}, not today&rsquo;s.
        </div>
      )}

      <div className="grid gap-2.5" role="radiogroup" aria-label="Strategy">
        {cells.map(card)}
        {holdCard}
        <button type="button" role="radio" aria-checked={choice?.kind === "spot"} className={`opt ${choice?.kind === "spot" ? "sel" : ""}`} onClick={() => choose({ kind: "spot" })} data-testid="strategy-spot">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Swap the USDC via CoW</span>
            <Chip kind="mute">spot</Chip>
          </div>
          <p className="mt-1 text-[12.8px] text-oil-ink2">Borrow, then take the USDC to the Spot page and place a CoW order from your wallet. Two signatures, two steps.</p>
        </button>
      </div>

      {/* Advanced controls */}
      <div className="card p-4" data-testid="advanced-controls">
        <h3 className="text-[14px]">Advanced settings</h3>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="label">Band width (total span, bps)</span>
            <input className="input num" inputMode="numeric" value={state.customWidthBps ?? ""} placeholder={choice?.kind === "lp" ? String(choice.entry.rangeWidthBps) : "preset"} disabled={choice?.kind !== "lp"} onChange={(e) => onChange({ customWidthBps: e.target.value === "" ? null : Number(e.target.value.replace(/[^0-9]/g, "")), acknowledged: false })} data-testid="custom-width" />
            <span className="mt-1 block text-[11.5px] text-oil-ink3">
              On-chain bounds {RANGE_WIDTH_BOUNDS.min}–{RANGE_WIDTH_BOUNDS.max}. {state.customWidthBps !== null && Number.isFinite(state.customWidthBps) && state.customWidthBps > 0 ? `= ${fmtHalfWidth(Math.max(1, state.customWidthBps))}` : ""} The model priced the preset width; a custom width changes IL drag in ways this page does not price.
            </span>
          </label>
          <label className="block">
            <span className="label">Rebalance delay (hours)</span>
            <input className="input num" inputMode="numeric" value={state.customDelayHours ?? ""} placeholder={choice?.kind === "lp" ? String(choice.entry.rebalanceDelayHours) : "preset"} disabled={choice?.kind !== "lp"} onChange={(e) => onChange({ customDelayHours: e.target.value === "" ? null : Number(e.target.value.replace(/[^0-9.]/g, "")), acknowledged: false })} data-testid="custom-delay" />
            <span className="mt-1 block text-[11.5px] text-oil-ink3">
              {REBALANCE_DELAY_BOUNDS.minHours}–{REBALANCE_DELAY_BOUNDS.maxHours} h before the engine re-centres an out-of-range position.
            </span>
          </label>
          <label className="block">
            <span className="label">Price tolerance (%)</span>
            <input className="input num" inputMode="decimal" value={(state.bandToleranceBps / 100).toString()} onChange={(e) => onChange({ bandToleranceBps: Math.round(Number(e.target.value.replace(/[^0-9.]/g, "")) * 100) || 0 })} data-testid="band-tolerance" />
            <span className={`mt-1 block text-[11.5px] ${state.bandToleranceBps > 100 ? "text-status-warn" : "text-oil-ink3"}`}>
              The deposit refuses if the pool price moved more than this between quote and execution. Max {MAX_BAND_TOLERANCE_BPS / 100}%. {state.bandToleranceBps > 100 ? "Above 1% a sandwich can take the difference." : ""}
            </span>
          </label>
        </div>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13.5px]">
          <input type="checkbox" className="accent-brass" checked={state.keeperProtection && !venueUnsupported} disabled={venueUnsupported} onChange={(e) => onChange({ keeperProtection: e.target.checked })} data-testid="keeper-protection" />
          Grant the Oilskin keeper one revocable, budgeted permission — StrategyRouter.unwind and nothing else — so it can reduce or close this position at the ladder rungs. One extra transaction after opening; it expires after 30 days unless you renew it, and without it nobody acts for you.
        </label>
        {venueUnsupported && (
          <p className="note note-crit mt-2" role="alert" data-testid="keeper-venue-unsupported">
            The keeper cannot watch {collateral} right now: Oilskin&rsquo;s registry points it at a lending contract that does not answer the venue interface the keeper reads, so no permission would protect this position. Nothing will act for you if its health factor falls.
          </p>
        )}
        <div className="mt-3">{notify("Tell me in the app if this position needs attention — nothing signed or sent anywhere; there is no email or push service yet.")}</div>
        {notifyPrefs.optIn && (
          <label className="mt-2 block max-w-xs">
            <span className="label">Alert channel</span>
            <select className="input" value={notifyPrefs.channel} onChange={(e) => setNotifyPrefs({ ...notifyPrefs, channel: e.target.value as NotifyChannel })} data-testid="notify-channel">
              <option value="banner">Dashboard banner only</option>
              <option value="browser">Dashboard banner + a browser notification</option>
            </select>
            <span className="mt-1 block text-[11.5px] text-oil-ink3">
              Both read your health factor from chain whenever this app is open — nothing is sent to a server. A browser notification needs this tab&rsquo;s permission and only fires while your browser is running.
            </span>
          </label>
        )}
      </div>
    </div>
  );
}
