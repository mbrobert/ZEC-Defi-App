"use client";

import { ENTRY_HF_FLOOR, MAX_OFFERED_LTV_CAP_BPS, type CollateralSymbol, type LtvPreset, type LtvPresetId } from "@zyo/shared";
import type { MarketRead } from "@/lib/reads";
import { planLoan } from "@/lib/math";
import { fmtPct, fmtUsd, fmtUsd0 } from "@/lib/format";
import HealthBand from "@/components/HealthBand";
import Chip from "@/components/Chip";

/**
 * The 30 / 40 / top setting. `presets` came from ltvPresets(LT) with LT read
 * from the venue — the third card's percentage is computed per asset, not typed.
 */
export default function SettingStep({
  market,
  collateral,
  amount,
  presets,
  selected,
  onSelect,
}: {
  market: MarketRead;
  collateral: CollateralSymbol;
  amount: number;
  presets: LtvPreset[];
  selected: LtvPresetId;
  onSelect: (id: LtvPresetId) => void;
}) {
  const r = market.reserves[collateral]!;
  const cur = presets.find((p) => p.id === selected) ?? presets[0];
  const loan = planLoan({
    collateralAmount: amount,
    collateralPriceUsd: r.priceUsd,
    liquidationThresholdBps: r.liquidationThresholdBps,
    ltvBps: cur.ltvBps,
    borrowAprPct: market.usdcBorrowAprPct,
  });

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px]">Choose a setting</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">
          How much USDC to borrow against your {collateral}, as a share of its value. Aave&rsquo;s liquidation threshold for {collateral} is{" "}
          <b className="num text-oil-ink">{fmtPct(r.liquidationThresholdBps / 100, 0)}</b> ({market.source === "live" ? "read live" : "snapshot"}); the top setting is min({MAX_OFFERED_LTV_CAP_BPS / 100}%, floor(threshold ÷ {ENTRY_HF_FLOOR})) so every position opens at HF ≥ {ENTRY_HF_FLOOR}.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Setting">
        {presets.map((p) => {
          const sel = p.id === selected;
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={sel}
              disabled={!p.offerable}
              className={`opt ${sel ? "sel" : ""}`}
              onClick={() => p.offerable && onSelect(p.id)}
              data-testid={`preset-${p.id}`}
              data-ltv={p.ltvBps}
            >
              <div className="flex items-center justify-between">
                <span className="text-[22px] font-bold">{fmtPct(p.ltvBps / 100, 0)}</span>
                {p.id === "top" ? <Chip kind="brass">top for {collateral}</Chip> : p.offerable ? <Chip kind="mute">offered</Chip> : <Chip kind="crit">not offered</Chip>}
              </div>
              <dl className="num mt-2 grid grid-cols-2 gap-y-1 text-[12.5px]">
                <dt className="text-oil-ink3">Entry HF</dt>
                <dd className="text-right">{p.entryHf?.toFixed(2) ?? "—"}</dd>
                <dt className="text-oil-ink3">Liquidation if {collateral} falls</dt>
                <dd className="text-right">−{p.liquidationDropPct.toFixed(1)}%</dd>
              </dl>
            </button>
          );
        })}
      </div>

      <div className="card p-5">
        <div className="mb-3 grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-[12px] text-oil-ink3">You borrow</div>
            <div className="num mt-0.5 font-bold" data-testid="borrow-usdc">
              {fmtUsd(loan.borrowUsdc)} USDC
            </div>
            <div className="num text-[11.5px] text-oil-ink3">{fmtPct(market.usdcBorrowAprPct)} variable · {fmtUsd(loan.borrowCostUsdPerYear)}/yr</div>
          </div>
          <div>
            <div className="text-[12px] text-oil-ink3">Health factor at entry</div>
            <div className="num mt-0.5 font-bold" data-testid="entry-hf">
              {loan.entryHf.toFixed(2)}
            </div>
            <div className="text-[11.5px] text-oil-ink3">floor {ENTRY_HF_FLOOR}</div>
          </div>
          <div>
            <div className="text-[12px] text-oil-ink3">Liquidation price</div>
            <div className="num mt-0.5 font-bold text-status-crit">{fmtUsd0(loan.liquidationPriceUsd)}</div>
            <div className="num text-[11.5px] text-oil-ink3">−{loan.liquidationDropPct.toFixed(1)}% from {fmtUsd0(r.priceUsd)}</div>
          </div>
        </div>
        <HealthBand hf={loan.entryHf} priceUsd={r.priceUsd} liquidationPriceUsd={loan.liquidationPriceUsd} symbol={collateral} compact />
        <ul className="num mt-3 grid gap-1 text-[12.5px] text-oil-ink2 sm:grid-cols-2">
          {loan.rungs.map(({ rung, priceUsd, dropPct }) => (
            <li key={rung.id}>
              <b className="text-oil-ink">{rung.label}</b> (HF &lt; {rung.hf.toFixed(2)}): {collateral} at {fmtUsd0(priceUsd)} (−{dropPct.toFixed(1)}%) → keeper {rung.action.replace("-", " ")}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
