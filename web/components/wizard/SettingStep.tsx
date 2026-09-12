"use client";

import { useState } from "react";
import { hysteresisFor, MIN_LADDER_ENTRY_HF, type CollateralSymbol } from "@zyo/shared";
import type { MarketRead } from "@/lib/reads";
import { planLoan } from "@/lib/math";
import { bindingPlain, clampEntryHf, entryHfForBorrow, hfAcknowledgmentText, needsHfAcknowledgment, SHELTERED_MARK, type HfBounds } from "@/lib/wizard";
import { fmtPct, fmtUsd, fmtUsd0 } from "@/lib/format";
import { rungPlain } from "@/lib/keeper";
import { KEEPER_GRANT_EXPIRY_DAYS } from "@/lib/plan";
import HealthBand from "@/components/HealthBand";
import Chip from "@/components/Chip";

/**
 * The risk slider (BUILD-PLAN-2026-09-12 D7 / §2b). One number to choose: the entry health factor.
 * It runs from the lowest HF offered on this asset (the registry floor, Aave's own max LTV or
 * Oilskin's borrow cap — whichever binds is named) up to "borrow nothing". The borrow follows from
 * debt = collateral × LT ÷ HF; typing a borrow drives the HF back. "Sheltered" and "Expert" are
 * marks, not modes; a mark under today's minimum is shown, disabled, with the reason. Below the
 * Sheltered mark the user ticks a sentence that names the drawdown they chose.
 *
 * The rung list is the ladder for THIS entry HF — the same `ladderFor` the keeper runs on the HF
 * the router records at the open — and says what happens at each rung in plain words, which ones
 * need a permission not yet granted, and that the first rung is a message rather than a transaction.
 */
export default function SettingStep({
  market,
  collateral,
  amount,
  bounds,
  entryHf,
  onChange,
  acknowledged,
  onAcknowledge,
  keeperProtection,
}: {
  market: MarketRead;
  collateral: CollateralSymbol;
  amount: number;
  bounds: HfBounds;
  /** The chosen entry HF; +∞ = borrow nothing. */
  entryHf: number;
  onChange: (entryHf: number) => void;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
  /** Whether the plan currently includes the keeper grant. */
  keeperProtection: boolean;
}) {
  const r = market.reserves[collateral]!;
  const finite = Number.isFinite(entryHf);
  const loan = planLoan({
    collateralAmount: amount,
    collateralPriceUsd: r.priceUsd,
    liquidationThresholdBps: r.liquidationThresholdBps,
    entryHf,
    borrowAprPct: market.usdcBorrowAprPct,
  });
  // The slider is linear in the BORROW (LTV, whole bps): its right-hand stop is the offered minimum HF,
  // its left-hand end is "borrow nothing". The thumb is labelled with the HF, which is what the
  // user is choosing; the mapping is the §2b identity and exact in both directions.
  const sliderMax = bounds.maxLtvBps;
  const sliderValue = finite ? Math.min(sliderMax, Math.max(0, loan.ltvBps)) : 0;
  const hfFromSlider = (ltvBps: number): number => (ltvBps <= 0 ? Number.POSITIVE_INFINITY : clampEntryHf((r.liquidationThresholdBps * 100) / ltvBps / 100, bounds));

  // The two typed fields hold a DRAFT while they are being edited and follow the state otherwise —
  // no effect re-syncs them, so nothing overwrites a half-typed number under the user's cursor.
  const hfShown = finite ? (Number.isInteger(Math.round(entryHf * 1e6) / 1e4) ? entryHf.toFixed(2) : entryHf.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")) : "";
  const borrowShown = finite ? loan.borrowUsdc.toFixed(2) : "0";
  const [hfDraft, setHfDraft] = useState<string | null>(null);
  const [borrowDraft, setBorrowDraft] = useState<string | null>(null);

  const commitHf = (text: string | null) => {
    setHfDraft(null);
    if (text === null) return;
    const v = Number(text);
    if (!Number.isFinite(v) || v < 1) return;
    onChange(clampEntryHf(v, bounds));
  };
  const commitBorrow = (text: string | null) => {
    setBorrowDraft(null);
    if (text === null) return;
    const v = Number(text.replace(/,/g, ""));
    if (!Number.isFinite(v) || v < 0) return;
    onChange(clampEntryHf(entryHfForBorrow(v, loan.collateralUsd, r.liquidationThresholdBps), bounds));
  };

  const ladderOk = finite && entryHf >= MIN_LADDER_ENTRY_HF;
  const needsAck = needsHfAcknowledgment(entryHf);
  const ackText = needsAck ? hfAcknowledgmentText({ entryHf, collateral, drawdownPct: loan.liquidationDropPct, rungs: loan.rungs.map((x) => x.rung) }) : "";
  const belowMin = finite && entryHf < bounds.minHf - 1e-9;

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px]">Choose your health factor</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">
          One number sets how much USDC you borrow against your {collateral} and how far its price can fall before liquidation. Health factor = collateral value × liquidation threshold ÷ debt; Aave&rsquo;s threshold for {collateral} is{" "}
          <b className="num text-oil-ink">{fmtPct(r.liquidationThresholdBps / 100, 0)}</b> ({market.source === "live" ? "read live" : "snapshot"}). Liquidation begins at 1.00.
        </p>
      </div>

      <div className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="hf-slider" className="text-[13px] text-oil-ink2">
            Entry health factor
          </label>
          <span className="num text-[22px] font-bold" data-testid="entry-hf">
            {finite ? entryHf.toFixed(2) : "∞"}
          </span>
        </div>
        <input
          id="hf-slider"
          type="range"
          className="mt-2 w-full"
          min={0}
          max={sliderMax}
          step={1}
          value={sliderValue}
          onChange={(e) => onChange(hfFromSlider(Number(e.target.value)))}
          aria-valuemin={bounds.minHf}
          aria-valuetext={finite ? `health factor ${entryHf.toFixed(2)}` : "borrow nothing"}
          data-testid="hf-slider"
          data-min-hf={bounds.minHf}
          data-binding={bounds.binding}
        />
        <div className="mt-1 flex justify-between text-[11.5px] text-oil-ink3">
          <span>borrow nothing</span>
          <span className="num">
            lowest offered {bounds.minHf.toFixed(2)} · {bindingPlain(bounds.binding, bounds.floor)}
          </span>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Quick marks">
          {bounds.marks.map((m) => {
            const on = finite && Math.abs(entryHf - m.hf) < 5e-3;
            return (
              <button
                key={m.id}
                type="button"
                className={`opt px-3 py-1.5 ${on ? "sel" : ""}`}
                disabled={!m.offered}
                title={m.why ?? undefined}
                onClick={() => m.offered && onChange(clampEntryHf(m.hf, bounds))}
                data-testid={`mark-${m.id}`}
                data-hf={m.hf}
              >
                <b>{m.label}</b> <span className="num text-[12px]">{m.hf.toFixed(2)}</span>
                {!m.offered && <Chip kind="mute">not offered today</Chip>}
              </button>
            );
          })}
          <span className="text-[11.5px] text-oil-ink3">marks, not modes — any health factor at or above {bounds.minHf.toFixed(2)} is yours to choose</span>
        </div>
        {bounds.marks.some((m) => !m.offered) && (
          <p className="mt-1 text-[11.5px] text-oil-ink3" data-testid="mark-why">
            {bounds.marks.filter((m) => !m.offered).map((m) => m.why).join(" ")}
          </p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block text-[12px] text-oil-ink3">
            Health factor
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min={bounds.minHf}
              className="num mt-1 w-full"
              value={hfDraft ?? hfShown}
              onFocus={() => setHfDraft(hfShown)}
              onChange={(e) => setHfDraft(e.target.value)}
              onBlur={() => commitHf(hfDraft)}
              onKeyDown={(e) => e.key === "Enter" && commitHf(hfDraft)}
              data-testid="hf-input"
            />
          </label>
          <label className="block text-[12px] text-oil-ink3">
            Borrow (USDC)
            <input
              type="text"
              inputMode="decimal"
              className="num mt-1 w-full"
              value={borrowDraft ?? borrowShown}
              onFocus={() => setBorrowDraft(borrowShown)}
              onChange={(e) => setBorrowDraft(e.target.value)}
              onBlur={() => commitBorrow(borrowDraft)}
              onKeyDown={(e) => e.key === "Enter" && commitBorrow(borrowDraft)}
              data-testid="borrow-input"
            />
          </label>
        </div>
        <p className="mt-1 text-[11.5px] text-oil-ink3">
          Either field drives the other: debt = collateral × threshold ÷ health factor. A borrow above the offered maximum is pulled back to it.
        </p>

        {belowMin && (
          <p className="note note-crit mt-3" role="alert" data-testid="hf-below-min">
            A health factor of {entryHf.toFixed(2)} is under the lowest offered for {collateral} today, {bounds.minHf.toFixed(2)} ({bindingPlain(bounds.binding, bounds.floor)}).
          </p>
        )}
      </div>

      <div className="card p-5">
        <div className="mb-3 grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-[12px] text-oil-ink3">You borrow</div>
            <div className="num mt-0.5 font-bold" data-testid="borrow-usdc">
              {fmtUsd(loan.borrowUsdc)} USDC
            </div>
            <div className="num text-[11.5px] text-oil-ink3" data-testid="ltv-line">
              {fmtPct(loan.ltvBps / 100, 1)} LTV · {fmtPct(market.usdcBorrowAprPct)} variable · {fmtUsd(loan.borrowCostUsdPerYear)}/yr
            </div>
          </div>
          <div>
            <div className="text-[12px] text-oil-ink3">Registry floor</div>
            <div className="num mt-0.5 font-bold" data-testid="entry-floor">
              {bounds.floor.toFixed(2)}
            </div>
            <div className="text-[11.5px] text-oil-ink3">the venue refuses any open under it</div>
          </div>
          <div>
            <div className="text-[12px] text-oil-ink3">Liquidation price</div>
            <div className="num mt-0.5 font-bold text-status-crit">{finite ? fmtUsd0(loan.liquidationPriceUsd) : "—"}</div>
            <div className="num text-[11.5px] text-oil-ink3">{finite ? `−${loan.liquidationDropPct.toFixed(1)}% from ${fmtUsd0(r.priceUsd)}` : "no debt, nothing to liquidate"}</div>
          </div>
        </div>
        <HealthBand hf={loan.entryHf} priceUsd={r.priceUsd} liquidationPriceUsd={loan.liquidationPriceUsd} symbol={collateral} ladder={loan.rungs.map((x) => x.rung)} compact />

        <h3 className="mt-4 text-[13.5px]">If {collateral} falls, this is what happens</h3>
        <p className="text-[11.5px] text-oil-ink3">
          {ladderOk
            ? `The rungs are set from the health factor you chose (${entryHf.toFixed(2)}); the keeper derives the same ladder from the number the router records when the position opens. Each rung re-arms ${hysteresisFor(entryHf).toFixed(2)} above its line.`
            : "With no loan there is nothing for the ladder to protect."}
        </p>
        <ul className="num mt-1.5 grid gap-1.5 text-[12.5px] text-oil-ink2" data-testid="rung-ladder">
          {loan.rungs.map(({ rung, priceUsd, dropPct }) => {
            const onChain = rung.action !== "notify";
            return (
              <li key={rung.id}>
                <b className="text-oil-ink">{rung.label}</b> (HF &lt; {rung.hf.toFixed(2)}, {collateral} at {fmtUsd0(priceUsd)}, −{dropPct.toFixed(1)}%): {rungPlain(rung, collateral)}
                {!onChain ? (
                  <span className="text-oil-ink3"> — a message, not a transaction.</span>
                ) : keeperProtection ? (
                  <span className="text-oil-ink3"> — only if you grant the keeper permission in the next step, and only while that permission is live.</span>
                ) : (
                  <span className="text-status-warn"> — nobody can do this for you unless you grant the keeper permission; today you would have to do it yourself.</span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-[11.5px] text-oil-ink3" data-testid="rung-caveat">
          The keeper permission is one call on your own account (close or reduce this position), capped by per-day token budgets, and it expires after {KEEPER_GRANT_EXPIRY_DAYS} days unless you renew it. You can revoke it at any
          time, and you can always act yourself. If the keeper is down or the permission has lapsed, nothing above happens automatically.
        </p>

        {needsAck && (
          <label className="note mt-3 flex items-start gap-2 text-[12.5px]" data-testid="hf-acknowledgment">
            <input type="checkbox" className="mt-[3px]" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} data-testid="hf-ack" />
            <span data-testid="hf-ack-text">{ackText}</span>
          </label>
        )}
        {!needsAck && finite && (
          <p className="mt-2 text-[11.5px] text-oil-ink3">
            At or above the Sheltered mark ({SHELTERED_MARK.hf.toFixed(2)}) no extra acknowledgment is asked here; the review step still names this position&rsquo;s forecast, borrow cost and drawdown before you sign.
          </p>
        )}
      </div>
    </div>
  );
}
