"use client";

import { FEES, RANGE_WIDTH_BOUNDS, REBALANCE_DELAY_BOUNDS, type CollateralSymbol } from "@zyo/shared";
import { offeredEntries, reasonPlain, reasonText, rejectedEntries, type GateEntry, type GateView } from "@/lib/gate";
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
 * Strategy picker.
 *   Simple:   ONE recommendation from the served verdicts (lib/recommend) —
 *             the best clearing pool at the chosen LTV, or "hold" with the
 *             reason when nothing clears. No other choices.
 *   Advanced: every pool × setting that clears for this collateral, the
 *             rejected list with the model's numbers, custom width / delay /
 *             price tolerance, keeper-protection toggle, hold and spot.
 */
export default function StrategyStep({
  gate,
  state,
  ltvBps,
  borrowAprPct,
  onChange,
}: {
  gate: GateView;
  state: WizardState;
  ltvBps: number;
  borrowAprPct: number;
  onChange: (patch: Partial<WizardState>) => void;
}) {
  const { mode } = useMode();
  const { prefs: notifyPrefs, setPrefs: setNotifyPrefs } = useNotifyPrefs();
  const collateral: CollateralSymbol = state.collateral;
  const choice = state.strategy;
  const offered = offeredEntries(gate, collateral);
  const rejected = rejectedEntries(gate, collateral);
  const rec = recommend(gate, collateral, ltvBps);
  const isSel = (e: GateEntry) => choice?.kind === "lp" && choice.entry.poolId === e.poolId && choice.entry.setting === e.setting;
  const userNetAt = (e: GateEntry) => e.userNet.find((u) => u.ltvBps === ltvBps)?.userNetPct;
  const engineFeePct = gate.engineFeeBps !== null ? gate.engineFeeBps / 100 : null;
  const choose = (c: StrategyChoice) => onChange({ strategy: c });

  const gateLine = (
    <span className="text-oil-ink3" data-testid="gate-line">
      Gate: {gate.source === "live" ? "yield service" : "yield model, demo"}
      {gate.stale ? " · SAMPLE STALE — nothing is offered while it is" : ""}
      {gate.emissionsSampledAt ? ` · emissions sampled ${gate.emissionsSampledAt.slice(0, 16).replace("T", " ")}Z` : ""}
      {gate.volatilityAsOf ? ` · σ as of ${gate.volatilityAsOf}` : ""}
      {gate.mcCalibrationGeneratedAt ? ` · risk model calibrated ${gate.mcCalibrationGeneratedAt.slice(0, 10)}` : ""}
      {engineFeePct !== null ? ` · engine fee ${engineFeePct}%` : ""}
    </span>
  );

  if (mode === "simple") {
    return (
      <div className="space-y-5">
        <div>
          <h2 className="text-[19px]">Our recommendation</h2>
          <p className="mt-1 text-[13.5px] text-oil-ink2">
            One choice, worked out from live numbers: a pool is only recommended when its rewards — after every fee and after the loss from the price moving — beat the {fmtPct(borrowAprPct)} you pay to borrow, under BOTH of the two models we price it with. If they disagree, we do not offer it. {gateLine}
          </p>
        </div>
        {rec.kind === "lp" ? (
          <button type="button" role="radio" aria-checked={isSel(rec.entry)} className={`opt flex w-full min-w-0 items-center gap-3.5 ${isSel(rec.entry) ? "sel" : ""}`} onClick={() => choose({ kind: "lp", entry: rec.entry })} data-testid="recommendation-lp">
            <TokenPair a={rec.entry.pool.token0} b={rec.entry.pool.token1} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
                Put the USDC to work in {rec.entry.pool.token0}/{rec.entry.pool.token1}
                <Chip kind="brass">recommended</Chip>
              </div>
              <p className="mt-1 text-[13px] text-oil-ink2">{rec.why}</p>
              <p className="num mt-1 text-[12.5px] text-oil-ink3">
                {rec.entry.preset.toLowerCase()} band ({fmtHalfWidth(rec.entry.rangeWidthBps)}) · rewards {fmtPct(rec.entry.emissionsNetPct ?? NaN, 1)} after fees · impermanent-loss drag {fmtSignedPct(rec.entry.dragPct ?? NaN, 1)} · net {fmtSignedPct(rec.entry.lpNetPct ?? NaN, 1)} vs borrow {fmtPct(borrowAprPct)}
              </p>
            </div>
            <div className="flex-none text-right">
              <div className="num text-[17px] font-bold text-status-good">{fmtSignedPct(rec.userNetPct, 1)}</div>
              <div className="max-w-[90px] text-[11px] leading-tight text-oil-ink3">a year on your {collateral} (model)</div>
            </div>
          </button>
        ) : (
          <button type="button" role="radio" aria-checked={choice?.kind === "hold"} className={`opt w-full ${choice?.kind === "hold" ? "sel" : ""}`} onClick={() => choose({ kind: "hold" })} data-testid="recommendation-hold">
            <div className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
              Keep the borrowed USDC in your account
              <Chip kind="brass">recommended today</Chip>
            </div>
            <p className="mt-1 text-[13px] text-oil-ink2">{rec.why}</p>
            {rec.closest && (
              <p className="mt-1 text-[13px] text-oil-ink2" data-testid="recommendation-why-not">
                The closest one was {rec.closest.pool.token0}/{rec.closest.pool.token1} ({rec.closest.preset.toLowerCase()}): {rec.closestWhy}
              </p>
            )}
            <p className="mt-1 text-[12.5px] text-oil-ink3">You still get the USDC to use as you like, and you can close the loan any time. Nothing is put into a pool. Switch to Advanced to see every pool and why it was refused.</p>
          </button>
        )}
        <label className="flex cursor-pointer items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            className="accent-brass"
            checked={notifyPrefs.optIn}
            onChange={(e) => setNotifyPrefs({ ...notifyPrefs, optIn: e.target.checked })}
            data-testid="notify-optin"
          />
          Tell me in the app if this position needs attention — a banner on your dashboard, nothing signed or sent anywhere.
        </label>
        <p className="text-[12.5px] text-oil-ink3">Simple mode shows one recommendation. Advanced mode (top right) shows every pool with its numbers, custom band widths, and spot swaps.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px]">Choose a strategy</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">
          A pool is offered only when its emissions — after the engine&rsquo;s {engineFeePct !== null ? `${engineFeePct}%` : "cut"} and Oilskin&rsquo;s {FEES.performanceBps / 100}% fee, realised on the impermanent-loss-shrunk base, plus the IL drag — beat the live USDC borrow rate ({fmtPct(borrowAprPct)}) under <b className="text-oil-ink">both</b> the published closed form (LP net) and the Monte-Carlo-calibrated form (MC net), which also charges the time the position spends out of range. The closed form is the optimistic one — by up to 32 points at the boundary — so a cell where only it clears is refused as <span className="mono">within_model_uncertainty</span>. Emissions only; trading fees are not counted. {gateLine}
        </p>
      </div>

      {gate.unavailableReason && (
        <div className="note note-crit" role="alert" data-testid="gate-unavailable">
          The yield service refused to serve a verdict ({reasonText(gate.unavailableReason)}). No pool can be offered until it does.
        </div>
      )}

      <div className="grid gap-2.5" role="radiogroup" aria-label="Strategy">
        {offered.length === 0 && !gate.unavailableReason && (
          <div className="note note-warn" data-testid="gate-empty">
            <b className="text-oil-ink">No pool clears the gate for {collateral} at today&rsquo;s {fmtPct(borrowAprPct)} borrow rate.</b> The model finds every Aerodrome pool × width net negative once impermanent loss is priced in. Hold the USDC or swap it; the list below shows what each pool would need.
          </div>
        )}
        {offered.map((e) => {
          const un = userNetAt(e);
          return (
            <button key={`${e.poolId}-${e.setting}`} type="button" role="radio" aria-checked={isSel(e)} className={`opt flex w-full min-w-0 items-center gap-3.5 ${isSel(e) ? "sel" : ""}`} onClick={() => choose({ kind: "lp", entry: e })} data-testid={`strategy-${e.poolId}-${e.setting}`}>
              <TokenPair a={e.pool.token0} b={e.pool.token1} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold">
                  {e.pool.token0}/{e.pool.token1}
                  <Chip kind="mute">
                    {e.preset.toLowerCase()} · {fmtHalfWidth(e.rangeWidthBps)}
                  </Chip>
                  {rec.kind === "lp" && rec.entry === e && <Chip kind="brass">recommended</Chip>}
                  {e.stale && <Chip kind="warn">stale sample</Chip>}
                </div>
                <div className="num mt-0.5 truncate text-[12.3px] text-oil-ink3">
                  emissions {fmtPct(e.emissionsGrossPct ?? NaN, 1)} gross → {fmtPct(e.emissionsNetPct ?? NaN, 1)} after fees · IL drag {fmtSignedPct(e.dragPct ?? NaN, 1)} · LP net {fmtSignedPct(e.lpNetPct ?? NaN, 1)} · MC net {e.mcLpNetPct === null ? "—" : fmtSignedPct(e.mcLpNetPct, 1)} · borrow −{fmtPct(e.borrowAprPct ?? NaN, 2)}
                </div>
              </div>
              <div className="flex-none text-right">
                <div className="num text-[16px] font-bold text-status-good">{un !== undefined ? fmtSignedPct(un, 1) : "—"}</div>
                <div className="max-w-[90px] text-[11px] leading-tight text-oil-ink3">net on your {collateral} at {ltvBps / 100}% LTV</div>
              </div>
            </button>
          );
        })}

        <button type="button" role="radio" aria-checked={choice?.kind === "hold"} className={`opt ${choice?.kind === "hold" ? "sel" : ""}`} onClick={() => choose({ kind: "hold" })} data-testid="strategy-hold">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold">Hold the USDC</span>
            <Chip kind="mute">no LP</Chip>
          </div>
          <p className="mt-1 text-[12.8px] text-oil-ink2">Borrow and keep the USDC in your account. You pay the borrow rate; nothing is deployed. Liquidity without selling your {collateral}.</p>
        </button>
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
            <input className="input num" inputMode="numeric" value={state.customWidthBps ?? ""} placeholder={choice?.kind === "lp" ? String(choice.entry.rangeWidthBps) : "preset"} disabled={choice?.kind !== "lp"} onChange={(e) => onChange({ customWidthBps: e.target.value === "" ? null : Number(e.target.value.replace(/[^0-9]/g, "")) })} data-testid="custom-width" />
            <span className="mt-1 block text-[11.5px] text-oil-ink3">
              On-chain bounds {RANGE_WIDTH_BOUNDS.min}–{RANGE_WIDTH_BOUNDS.max}. {state.customWidthBps !== null && Number.isFinite(state.customWidthBps) && state.customWidthBps > 0 ? `= ${fmtHalfWidth(Math.max(1, state.customWidthBps))}` : ""} The model priced the preset width; a custom width changes IL drag in ways this page does not price.
            </span>
          </label>
          <label className="block">
            <span className="label">Rebalance delay (hours)</span>
            <input className="input num" inputMode="numeric" value={state.customDelayHours ?? ""} placeholder={choice?.kind === "lp" ? String(choice.entry.rebalanceDelayHours) : "preset"} disabled={choice?.kind !== "lp"} onChange={(e) => onChange({ customDelayHours: e.target.value === "" ? null : Number(e.target.value.replace(/[^0-9.]/g, "")) })} data-testid="custom-delay" />
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
          <input type="checkbox" className="accent-brass" checked={state.keeperProtection} onChange={(e) => onChange({ keeperProtection: e.target.checked })} data-testid="keeper-protection" />
          Grant the Oilskin keeper one revocable, budgeted permission — StrategyRouter.unwind and nothing else — so it can reduce or close this position at the ladder rungs. One extra transaction after opening; it expires after 30 days unless you renew it, and without it nobody acts for you.
        </label>
        <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13.5px]">
          <input
            type="checkbox"
            className="accent-brass"
            checked={notifyPrefs.optIn}
            onChange={(e) => setNotifyPrefs({ ...notifyPrefs, optIn: e.target.checked })}
            data-testid="notify-optin"
          />
          Tell me in the app if this position needs attention — nothing signed or sent anywhere; there is no email or push service yet.
        </label>
        {notifyPrefs.optIn && (
          <label className="mt-2 block max-w-xs">
            <span className="label">Alert channel</span>
            <select
              className="input"
              value={notifyPrefs.channel}
              onChange={(e) => setNotifyPrefs({ ...notifyPrefs, channel: e.target.value as NotifyChannel })}
              data-testid="notify-channel"
            >
              <option value="banner">Dashboard banner only</option>
              <option value="browser">Dashboard banner + a browser notification</option>
            </select>
            <span className="mt-1 block text-[11.5px] text-oil-ink3">
              Both read your health factor from chain whenever this app is open — nothing is sent to a server. A browser notification needs this tab&rsquo;s permission and only fires while your browser is running.
            </span>
          </label>
        )}
      </div>

      {rejected.length > 0 && (
        <details className="rounded-xl border border-dashed border-oil-line" data-testid="gate-rejected">
          <summary className="cursor-pointer list-none px-4 py-3 text-[13.5px] font-semibold text-oil-ink2">Not offered — and why ({rejected.length})</summary>
          <ul className="space-y-2 border-t border-white/10 px-4 py-3 text-[12.8px] text-oil-ink2">
            {rejected.map((e) => (
              <li key={`${e.poolId}-${e.setting}`} className="num">
                <b className="text-oil-ink">
                  {e.pool.token0}/{e.pool.token1}
                </b>{" "}
                {e.preset.toLowerCase()} ({fmtHalfWidth(e.rangeWidthBps)}): <span data-testid={`reason-${e.poolId}-${e.setting}`}>{reasonText(e.reason)}</span>
                {e.stale && " · sample stale"}
                {e.emissionsNetPct !== null && ` — emissions ${fmtPct(e.emissionsGrossPct ?? NaN, 2)} gross, ${fmtPct(e.emissionsNetPct, 2)} after fees`}
                {e.dragPct !== null && `, IL drag ${fmtSignedPct(e.dragPct, 2)}`}
                {e.lpNetPct !== null && `, LP net ${fmtSignedPct(e.lpNetPct, 2)} vs borrow ${fmtPct(e.borrowAprPct ?? NaN)}`}
                {e.mcLpNetPct !== null && `, MC net ${fmtSignedPct(e.mcLpNetPct, 2)}`}
                {e.breakEvenEmissionsMultiple !== null && ` · would clear at ${e.breakEvenEmissionsMultiple.toFixed(2)}× today's net emissions on the closed form alone`}
                {e.breakEvenSigma !== null && e.sigma !== null && ` or σ ≤ ${e.breakEvenSigma.toFixed(2)} (today ${e.sigma.toFixed(2)})`}
                {e.pool.note ? ` — ${e.pool.note}` : ""}
                <span className="block text-oil-ink3">{reasonPlain(e.reason)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
