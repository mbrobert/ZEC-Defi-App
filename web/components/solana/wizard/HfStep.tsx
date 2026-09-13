"use client";

import { useState } from "react";
import type { HfRung } from "@zyo/shared";
import { fmtPct, fmtUsd } from "@/lib/format";
import { hfAcknowledgmentText, needsHfAcknowledgment } from "@/lib/wizard";
import { clampSolanaHf, solanaBindingWords, solanaHfForBorrow, type SolanaHfBounds, type SolanaOpenPlan } from "@/lib/solana/plan";
import { solanaRefusalPlain, type SolanaBorrowView } from "@/lib/solana/yield";
import Chip from "@/components/Chip";

/** What the keeper does at each rung, for a Kamino position (SOLANA-ARCHITECTURE.md §3 keeper_protect). */
export function solanaRungPlain(rung: HfRung): string {
  switch (rung.action) {
    case "notify":
      return "you are told your position is getting close to trouble — nothing is signed or moved";
    case "repay":
      return "part of your loan is repaid from the USDC sitting idle in your account";
    case "derisk":
      return "the keeper pays USDC in and takes out ZEC worth no less than 2 % under Kamino's oracle price, until the health factor is back above this rung";
    case "emergency-unwind":
      return "the keeper repays what it can and takes out the matching ZEC, inside your daily budgets, to stop a liquidation";
  }
}

/**
 * Step 3 — the same slider as Base (BUILD-PLAN D7 / §2b) on Kamino's numbers: debt = collateral × LT ÷ HF, with
 * Kamino's own 40 % cap as the lowest HF offered (1.625 today), named as such. The rate AFTER this borrow rides
 * beside the amount because on this pool a borrow moves it.
 */
export default function HfStep({ plan, bounds, view, entryHf, onChange, acknowledged, onAcknowledge, keeperProtection }: { plan: SolanaOpenPlan; bounds: SolanaHfBounds; view: SolanaBorrowView; entryHf: number; onChange: (hf: number) => void; acknowledged: boolean; onAcknowledge: (v: boolean) => void; keeperProtection: boolean }) {
  const finite = Number.isFinite(entryHf);
  const sliderMax = Math.round((bounds.ltBps * 100) / bounds.minHf / 100);
  const sliderValue = finite ? Math.min(sliderMax, Math.max(0, plan.ltvBps)) : 0;
  const hfFromSlider = (ltvBps: number) => (ltvBps <= 0 ? Number.POSITIVE_INFINITY : clampSolanaHf(bounds.ltBps / ltvBps, bounds));
  const [hfDraft, setHfDraft] = useState<string | null>(null);
  const [borrowDraft, setBorrowDraft] = useState<string | null>(null);
  const commitHf = (t: string | null) => {
    setHfDraft(null);
    if (t === null) return;
    const v = Number(t);
    if (Number.isFinite(v) && v >= 1) onChange(clampSolanaHf(v, bounds));
  };
  const commitBorrow = (t: string | null) => {
    setBorrowDraft(null);
    if (t === null) return;
    const v = Number(t.replace(/,/g, ""));
    if (Number.isFinite(v) && v >= 0) onChange(clampSolanaHf(solanaHfForBorrow(v, plan.collateralUsd, bounds.ltBps), bounds));
  };
  const needsAck = needsHfAcknowledgment(entryHf);
  const ackText = needsAck && plan.drawdownPct !== null ? hfAcknowledgmentText({ entryHf, collateral: "ZEC", drawdownPct: plan.drawdownPct, rungs: plan.rungs }) : "";
  const borrowRefusals = view.refusals.filter((r) => r !== "kamino_stale" && r !== "kamino_unavailable");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px]">Choose your health factor</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">
          One number sets how much USDC you borrow against your ZEC and how far its price can fall before Kamino liquidates. Health factor = collateral value × liquidation threshold ÷ debt; Kamino&rsquo;s threshold for ZEC is{" "}
          <b className="num text-oil-ink">{fmtPct(bounds.ltBps / 100, 0)}</b> ({view.source === "live" ? "read live" : "snapshot"}). Liquidation begins at 1.00.
        </p>
      </div>
      <div className="card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="sol-hf-slider" className="text-[13px] text-oil-ink2">
            Entry health factor
          </label>
          <span className="num text-[22px] font-bold" data-testid="sol-entry-hf">
            {finite ? entryHf.toFixed(2) : "∞"}
          </span>
        </div>
        <input id="sol-hf-slider" type="range" className="mt-2 w-full" min={0} max={sliderMax} step={1} value={sliderValue} onChange={(e) => onChange(hfFromSlider(Number(e.target.value)))} aria-valuemin={bounds.minHf} aria-valuetext={finite ? `health factor ${entryHf.toFixed(2)}` : "borrow nothing"} data-testid="sol-hf-slider" data-min-hf={bounds.minHf} data-binding={bounds.binding} />
        <div className="mt-1 flex justify-between text-[11.5px] text-oil-ink3">
          <span>borrow nothing</span>
          <span className="num">
            lowest offered {bounds.minHf.toFixed(3)} · {solanaBindingWords(bounds.binding, bounds.floor)}
          </span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Quick marks">
          {bounds.marks.map((m) => {
            const on = finite && Math.abs(entryHf - m.hf) < 5e-3;
            return (
              <button key={m.id} type="button" className={`opt px-3 py-1.5 ${on ? "sel" : ""}`} disabled={!m.offered} title={m.why ?? undefined} onClick={() => onChange(m.hf)} data-testid={`sol-mark-${m.id}`}>
                {m.label} {m.hf.toFixed(2)}
                {!m.offered ? " — not offered" : ""}
              </button>
            );
          })}
          <button type="button" className={`opt px-3 py-1.5 ${finite && Math.abs(entryHf - bounds.minHf) < 5e-3 ? "sel" : ""}`} onClick={() => onChange(bounds.minHf)} data-testid="sol-mark-max">
            Most Kamino allows {bounds.minHf.toFixed(3)}
          </button>
        </div>
        {bounds.marks.some((m) => !m.offered) && <p className="mt-2 text-[12px] text-oil-ink3">{bounds.marks.find((m) => !m.offered)!.why}</p>}

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-[13px] text-oil-ink2">
            Health factor
            <input className="input num mt-1 w-full" inputMode="decimal" value={hfDraft ?? (finite ? entryHf.toFixed(2) : "")} placeholder="∞" onChange={(e) => setHfDraft(e.target.value)} onBlur={() => commitHf(hfDraft)} onKeyDown={(e) => e.key === "Enter" && commitHf(hfDraft)} data-testid="sol-hf-input" />
          </label>
          <label className="text-[13px] text-oil-ink2">
            USDC to borrow
            <input className="input num mt-1 w-full" inputMode="decimal" value={borrowDraft ?? plan.borrowUsdc.toFixed(2)} onChange={(e) => setBorrowDraft(e.target.value)} onBlur={() => commitBorrow(borrowDraft)} onKeyDown={(e) => e.key === "Enter" && commitBorrow(borrowDraft)} data-testid="sol-borrow-input" />
          </label>
        </div>
      </div>

      <div className="card p-5" data-testid="sol-plan">
        <dl className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-oil-ink3">Loan-to-value at entry</dt>
            <dd className="num">{fmtPct(plan.ltvBps / 100, 1)}</dd>
          </div>
          <div>
            <dt className="text-oil-ink3">Liquidation begins at</dt>
            <dd className="num">{plan.liquidationPriceUsd !== null ? `${fmtUsd(plan.liquidationPriceUsd)} per ZEC (${plan.drawdownPct!.toFixed(1)} % below today)` : "never — no debt"}</dd>
          </div>
          <div>
            <dt className="text-oil-ink3">Borrow rate after your borrow</dt>
            <dd className="num" data-testid="sol-rate-after">
              {view.borrowAprAfterPct !== null ? `${fmtPct(view.borrowAprAfterPct)} a year` : view.borrowAprNowPct !== null ? `${fmtPct(view.borrowAprNowPct)} now` : "—"}
              {view.poolSharePctAfter !== null ? <span className="text-oil-ink3"> · you would be {fmtPct(view.poolSharePctAfter, 1)} of the pool&rsquo;s debt</span> : null}
            </dd>
          </div>
          <div>
            <dt className="text-oil-ink3">Pool can fund it</dt>
            <dd>{plan.borrowUsdc === 0 ? <Chip kind="mute">no borrow</Chip> : plan.fundable ? <Chip kind="good">yes</Chip> : <Chip kind="crit">no — {view.maxFundableUsdc !== null ? fmtUsd(view.maxFundableUsdc) : "unknown"} available</Chip>}</dd>
          </div>
        </dl>
        {borrowRefusals.length > 0 && (
          <ul className="mt-3 space-y-1 text-[13px]" data-testid="sol-borrow-refusals">
            {borrowRefusals.map((r) => (
              <li key={r} className="flex gap-2">
                <Chip kind="crit">refused</Chip>
                <span>{solanaRefusalPlain(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card p-5">
        <div className="text-[14px] font-semibold">What happens on the way down</div>
        <p className="mt-1 text-[12.5px] text-oil-ink3">The rungs for this entry health factor. {keeperProtection ? "Each on-chain rung runs only inside the permission you grant next, and the program checks every action." : "Without the keeper's permission only the first rung — a message — exists; you act yourself."}</p>
        <ol className="mt-3 space-y-1.5 text-[13px]">
          {plan.rungs.map((r) => (
            <li key={r.id} className="flex gap-3">
              <span className="num w-14 shrink-0 text-oil-ink2">HF {r.hf.toFixed(2)}</span>
              <span>{solanaRungPlain(r)}</span>
            </li>
          ))}
        </ol>
        {!plan.ladderOk && finite && <p className="mt-2 text-[12.5px] text-oil-warn">Below a health factor of 1.10 the rungs collapse onto each other; the keeper is effectively one action.</p>}
      </div>

      {needsAck && (
        <label className="flex items-start gap-3 text-[13.5px]" data-testid="sol-hf-ack">
          <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} />
          <span>{ackText}</span>
        </label>
      )}
    </div>
  );
}
