"use client";

import { HF_LADDER, type HfRung } from "@zyo/shared";
import { hfBand } from "@/lib/math";
import { fmtHf, fmtUsd0 } from "@/lib/format";
import Chip from "./Chip";

/**
 * Loan-health band (Curve-Llamalend-style price scale, from the prototype).
 * Shows DISTANCE TO DANGER on a price axis: the liquidation price (HF = 1),
 * the price at which each keeper rung fires (liqPrice × rung.hf — the ladder
 * comes from @zyo/shared, nothing typed here) and where the collateral trades
 * now. Colour zones follow rung severity; every zone is also labelled.
 *
 * `ladder` is the POSITION's (A4, BUILD-PLAN D7): derived from the entry HF the router recorded —
 * or chose, in the wizard — via `ladderFor`; the floor's `HF_LADDER` when nothing is recorded, and
 * `ladderNote` says which.
 *
 * The line under it says what the record does NOT cover, and it is not optional (backlog L-1). The
 * router is what re-records the entry HF on an owner action (D9); an owner who calls the venue
 * directly through their account's `exec` goes around it. That hatch is deliberate — closing it would
 * mean blocking the owner from their own funds — so the disclosure is the mitigation, and it belongs
 * beside the rungs rather than in a document nobody opens.
 */
export default function HealthBand({
  hf,
  priceUsd,
  liquidationPriceUsd,
  symbol,
  ladder = HF_LADDER,
  ladderNote,
  compact = false,
}: {
  hf: number | null;
  priceUsd: number;
  liquidationPriceUsd: number;
  symbol: string;
  ladder?: readonly HfRung[];
  ladderNote?: string;
  compact?: boolean;
}) {
  const band = hfBand(hf, ladder);
  if (hf === null) {
    // The read failed: say so, never draw a green band (audit wave 2, N-MED-2).
    return (
      <div data-testid="health-band-unreadable">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[13px] text-oil-ink2">Loan health</span>
          <Chip kind="warn">Unreadable</Chip>
        </div>
        <p className="mt-2 text-[12.5px] text-oil-ink2">The account read from the lending venue did not come back, or two reads of it disagree. This page cannot say whether the position is healthy; it will retry.</p>
      </div>
    );
  }
  const noDebt = !Number.isFinite(hf) || liquidationPriceUsd <= 0;

  if (noDebt) {
    return (
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-[13px] text-oil-ink2">Loan health</span>
          <Chip kind="good">No debt · HF ∞</Chip>
        </div>
        <div className="band">
          <div className="band-track">
            <div className="h-full flex-1 bg-status-good" />
          </div>
          <Tick x={50} label={`${symbol} now`} value={fmtUsd0(priceUsd)} color="#ECEADF" />
          <span className="band-zonelbl" style={{ left: "1%" }}>
            no debt — nothing can be liquidated
          </span>
        </div>
      </div>
    );
  }

  // Rung boundaries on the price axis, mildest → severest (descending price).
  const rungs = [...ladder].sort((a, b) => b.hf - a.hf).map((r) => ({ ...r, price: liquidationPriceUsd * r.hf }));
  const lo = liquidationPriceUsd * 0.72;
  const hi = Math.max(priceUsd * 1.18, liquidationPriceUsd * 2.05);
  const X = (p: number) => Math.max(0, Math.min(100, ((p - lo) / (hi - lo)) * 100));

  // Segments: [lo → emergency], [emergency → derisk], [derisk → repay], [repay → warn], [warn → hi]
  const bounds = [liquidationPriceUsd, ...rungs.map((r) => r.price).reverse()];
  const segs: { from: number; to: number; cls: string }[] = [];
  let prev = lo;
  for (let i = 0; i < bounds.length; i++) {
    const b = bounds[i];
    const sev = i === 0 ? 4 : rungs[rungs.length - i].severity;
    segs.push({ from: prev, to: b, cls: sev >= 3 ? "bg-status-crit" : "bg-status-warn" });
    prev = b;
  }
  segs.push({ from: prev, to: hi, cls: "bg-status-good" });

  return (
    <div data-testid="health-band">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] text-oil-ink2">Loan health</span>
        <Chip kind={band.kind}>
          {band.label} · HF <span className="num">{fmtHf(hf)}</span>
        </Chip>
      </div>
      <div className="band">
        <div className="band-track">
          {segs.map((s, i) => (
            <div key={i} className={`h-full ${s.cls}`} style={{ width: `${X(s.to) - X(s.from)}%` }} />
          ))}
        </div>
        <Tick x={X(liquidationPriceUsd)} label="Liquidation" value={fmtUsd0(liquidationPriceUsd)} color="#F06D80" />
        <Tick x={X(priceUsd)} label={`${symbol} now`} value={fmtUsd0(priceUsd)} color="#ECEADF" />
        {!compact &&
          rungs.map((r, i) => (
            <span
              key={r.id}
              className="band-zonelbl hidden sm:block"
              style={{ left: `${X(r.price) + 0.5}%`, top: i % 2 === 0 ? 44 : 56 }}
              title={`${r.label} rung fires at HF ${r.hf} — ${fmtUsd0(r.price)}`}
            >
              {r.label.toLowerCase()} {r.hf.toFixed(2)}
            </span>
          ))}
      </div>
      <div className="mt-2 text-[11.5px] text-oil-ink3" data-testid="ladder-line">
        Keeper ladder: {ladder.map((r) => `${r.label.toLowerCase()} < ${r.hf.toFixed(2)}`).join(" · ")} (re-arms at rung + {(ladder[0]!.disarmHf - ladder[0]!.hf).toFixed(2)})
        {ladderNote ? ` — ${ladderNote}` : ""}
      </div>
      {/* Backlog L-1 (docs/BACKLOG.md §2, from AUDIT-2026-09-11): your account's `exec` lets you call the
          lending venue yourself, which is the exit hatch and must stay open — intercepting it would mean
          blocking it. But the entry health factor these rungs derive from is re-recorded by the ROUTER, so
          a borrow or repay made around it leaves the record describing a position that no longer exists.
          The honest answer is to say so where the rungs are shown, not to pretend the record tracks
          everything. */}
      <div className="mt-1 text-[11.5px] text-oil-ink3" data-testid="ladder-scope">
        These rungs follow what you do <strong>through Oilskin</strong>. You can also call the lending venue straight from your account — that door
        stays open on purpose — but Oilskin does not see those borrows and repayments, so the entry health factor it recorded stays where it was and
        these rungs keep deriving from it.
      </div>
    </div>
  );
}

function Tick({ x, label, value, color }: { x: number; label: string; value: string; color: string }) {
  return (
    <div className="band-tick" style={{ left: `${x}%`, background: color }}>
      <span className="tk-lbl" style={{ color }}>
        {label}
      </span>
      <span className="tk-val num">{value}</span>
    </div>
  );
}
