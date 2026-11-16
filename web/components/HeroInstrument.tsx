"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { drawdownToLiquidationPct, ladderFor, ltvForEntryHfBps, type CollateralSymbol } from "@zyo/shared";
import type { MarketRead } from "@/lib/reads";
import { bindingPlain, hfBoundsFor } from "@/lib/wizard";
import { fmtPct, fmtUsd0 } from "@/lib/format";
import { TokenMark } from "./TokenMark";

/** The cautious end of the home-page slider. The wizard's own slider goes further; this is a preview. */
const HF_CAUTIOUS = 3;
/** The preview is quoted per this much collateral, so no wallet and no amount is needed to read it. */
const PER_USD = 10_000;
const ASSETS: readonly CollateralSymbol[] = ["cbBTC", "WETH"];

/**
 * The one decision the product asks for, on the landing page: how hard to borrow. Dragging the
 * health factor (HF) moves the borrow, the price fall that would liquidate, and the four levels at
 * which the keeper acts — the same shared functions the wizard and the keeper use, fed by the same
 * venue read as the table below it. Nothing here is typed: no reserve read, no instrument.
 */
export default function HeroInstrument({ market, source }: { market: MarketRead; source: "live" | "demo" | string }) {
  const [asset, setAsset] = useState<CollateralSymbol>("cbBTC");
  const bounds = useMemo(() => hfBoundsFor(market, asset), [market, asset]);
  const [hfRaw, setHfRaw] = useState<number>(1.55);

  if (!bounds) {
    return (
      <div className="instrument p-6" data-testid="hero-instrument-unreadable">
        <h2 className="text-[17px]">The lending venue could not be read</h2>
        <p className="mt-2 text-[13.5px] text-oil-ink2">Without {asset}&rsquo;s liquidation threshold this page cannot show what a borrow would look like, so it shows nothing instead of a guess.</p>
      </div>
    );
  }

  const hf = Math.min(HF_CAUTIOUS, Math.max(bounds.minHf, hfRaw));
  const ltvBps = ltvForEntryHfBps(bounds.ltBps, hf);
  const borrow = (PER_USD * ltvBps) / 10_000;
  const drop = drawdownToLiquidationPct(hf);
  const rungs = ladderFor(hf);
  // The slider runs cautious → bold, left to right, so its position is the distance from the cautious end.
  const span = HF_CAUTIOUS - bounds.minHf;
  const pos = span > 0 ? Math.round(((HF_CAUTIOUS - hf) / span) * 1000) : 0;
  const setPos = (p: number) => setHfRaw(Math.round((HF_CAUTIOUS - (p / 1000) * span) * 100) / 100);
  const price = market.reserves[asset]?.priceUsd;

  return (
    <div className="instrument p-5 sm:p-6" data-testid="hero-instrument">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[16px]">Try the one decision</h2>
        <div className="seg" role="radiogroup" aria-label="Collateral">
          {ASSETS.map((a) => (
            <button key={a} type="button" role="radio" aria-checked={asset === a} onClick={() => setAsset(a)}>
              <span className="inline-flex items-center gap-1.5">
                <TokenMark symbol={a} size={16} />
                {a}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4">
        <div>
          <div className="text-[12.5px] text-oil-ink3">Health factor at entry</div>
          <div className="num font-display text-[44px] font-semibold leading-none tracking-tight" data-testid="hero-hf">
            {hf.toFixed(2)}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[12.5px] text-oil-ink3">Borrow per {fmtUsd0(PER_USD)} of {asset}</div>
          <div className="num font-display text-[44px] font-semibold leading-none tracking-tight text-brass" data-testid="hero-borrow">
            {fmtUsd0(borrow)}
          </div>
        </div>
      </div>

      <label className="mt-5 block">
        <span className="sr-only">Health factor at entry, from cautious to the lowest offered</span>
        <input type="range" min={0} max={1000} step={1} value={pos} onChange={(e) => setPos(Number(e.target.value))} aria-valuetext={`Health factor ${hf.toFixed(2)}, borrowing ${fmtUsd0(borrow)} per ${fmtUsd0(PER_USD)}`} data-testid="hero-slider" />
      </label>
      <div className="mt-1.5 flex items-center justify-between text-[12px] text-oil-ink3">
        <span>Cautious · {HF_CAUTIOUS.toFixed(2)}</span>
        <span className="flex gap-1.5">
          {bounds.marks.filter((m) => m.offered).map((m) => (
            <button key={m.id} type="button" className="rounded-full border border-oil-line px-2.5 py-0.5 font-semibold text-oil-ink2 transition hover:border-brass hover:text-brass" onClick={() => setHfRaw(m.hf)}>
              {m.label} {m.hf.toFixed(2)}
            </button>
          ))}
        </span>
        <span title={`Stopped by ${bindingPlain(bounds.binding, bounds.floor)}`}>Lowest offered · {bounds.minHf.toFixed(2)}</span>
      </div>

      <p className="num mt-5 text-[13.5px] leading-relaxed text-oil-ink2">
        At {hf.toFixed(2)} you borrow {fmtPct(ltvBps / 100, 1)} of your collateral&rsquo;s value. {asset} would have to fall <b className="text-oil-ink">{fmtPct(drop, 1)}</b>
        {price !== undefined && Number.isFinite(price) ? <> — to about {fmtUsd0(price * (1 - drop / 100))} from {fmtUsd0(price)} — </> : " "}
        before the venue could liquidate. The keeper acts earlier, at four levels set by the number you chose:
      </p>

      <ol className="num mt-3 grid gap-px overflow-hidden rounded-xl border border-oil-line bg-oil-line text-[13px] sm:grid-cols-4" data-testid="hero-ladder">
        {rungs.map((r) => (
          <li key={r.id} className="bg-oil-bg2 px-3 py-2.5">
            <div className="text-oil-ink3">{r.label}</div>
            <div className="mt-0.5 font-semibold">
              below {r.hf.toFixed(2)}
            </div>
            <div className="text-[12px] text-oil-ink3">after a {fmtPct(100 * (1 - r.hf / hf), 1)} fall</div>
          </li>
        ))}
      </ol>

      <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[12px] text-oil-ink3">
          Aave v3 on Base, {source === "live" ? "read just now" : `snapshot of ${market.readAt.slice(0, 10)}`}. A preview: nothing is signed here.
        </span>
        <Link href="/new" className="btn-brass">
          Open a position
        </Link>
      </div>
    </div>
  );
}
