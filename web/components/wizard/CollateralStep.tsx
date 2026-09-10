"use client";

import { COLLATERAL_SYMBOLS, type CollateralSymbol } from "@zyo/shared";
import { COLLATERAL_ASSETS } from "@/lib/chain";
import type { MarketRead } from "@/lib/reads";
import { fmtAmount, fmtPct, fmtUsd } from "@/lib/format";
import { amountNumber } from "@/lib/wizard";
import { TokenMark } from "@/components/TokenMark";
import Chip from "@/components/Chip";

export default function CollateralStep({
  market,
  collateral,
  amount,
  balance,
  wrongNetwork = false,
  onCollateral,
  onAmount,
}: {
  market: MarketRead;
  collateral: CollateralSymbol;
  amount: string;
  /** Wallet balance in human units, when known (live mode). */
  balance?: number;
  wrongNetwork?: boolean;
  onCollateral: (c: CollateralSymbol) => void;
  onAmount: (a: string) => void;
}) {
  const r = market.reserves[collateral];
  const amt = amountNumber(amount);

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px]">Choose collateral</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">The asset you lock up to borrow against. cbBTC and WETH are accepted by Aave v3 today; cbZEC is listed but disabled, with the reason.</p>
      </div>
      {wrongNetwork && (
        <div className="note note-warn" role="alert" data-testid="wrong-network-note">
          Your wallet is on another network. Switch it to Base (banner above) before continuing — every step here reads and writes Base only.
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Collateral">
        {COLLATERAL_SYMBOLS.map((sym) => {
          const a = COLLATERAL_ASSETS[sym];
          const res = market.reserves[sym];
          const usable = a.enabled && !!res && res.usageAsCollateralEnabled && res.isActive && !res.isFrozen;
          const sel = collateral === sym;
          return (
            <button
              key={sym}
              type="button"
              role="radio"
              aria-checked={sel}
              disabled={!usable}
              className={`opt ${sel ? "sel" : ""}`}
              onClick={() => usable && onCollateral(sym)}
              data-testid={`collateral-${sym}`}
            >
              <div className="flex items-center gap-2.5">
                <TokenMark symbol={sym} size={28} />
                <span className="font-semibold">{sym}</span>
                {usable ? <Chip kind="good">live</Chip> : <Chip kind="mute">disabled</Chip>}
              </div>
              {usable && res ? (
                <dl className="num mt-3 grid grid-cols-2 gap-y-1 text-[12.5px]">
                  <dt className="text-oil-ink3">Price</dt>
                  <dd className="text-right">{fmtUsd(res.priceUsd)}</dd>
                  <dt className="text-oil-ink3">Liq. threshold</dt>
                  <dd className="text-right">{fmtPct(res.liquidationThresholdBps / 100, 0)}</dd>
                  <dt className="text-oil-ink3">Liq. penalty</dt>
                  <dd className="text-right">{fmtPct(res.liquidationBonusBps / 100, 1)}</dd>
                </dl>
              ) : (
                <p className="mt-3 text-[12.5px] leading-relaxed text-oil-ink2" data-testid={`disabled-reason-${sym}`}>
                  {a.disabledReason ?? "Venue reports this reserve as unusable right now."}
                </p>
              )}
              {a.riskNotes.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[11.5px] text-oil-ink3">
                  {a.riskNotes.map((n) => (
                    <li key={n}>· {n}</li>
                  ))}
                </ul>
              )}
            </button>
          );
        })}
      </div>

      <div>
        <label className="label" htmlFor="amount">
          Amount of {collateral} to supply
        </label>
        <div className="relative">
          <input
            id="amount"
            className="input pr-28 text-[17px]"
            inputMode="decimal"
            value={amount}
            onChange={(e) => onAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            data-testid="amount"
          />
          <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2 text-[13px] text-oil-ink3">
            {collateral}
            {balance !== undefined && (
              <button type="button" className="rounded-md border border-brass/35 px-2 py-0.5 text-[12px] font-semibold text-brass hover:bg-brass/10" onClick={() => onAmount(String(balance))}>
                MAX {fmtAmount(balance, 6)}
              </button>
            )}
          </div>
        </div>
        <p className="num mt-1.5 text-[13px] text-oil-ink2">
          ≈ {r ? fmtUsd(amt * r.priceUsd) : "—"} at {r ? fmtUsd(r.priceUsd) : "—"} per {collateral}
          <span className="text-oil-ink3"> · {market.source === "live" ? "Aave oracle, live" : `snapshot ${market.readAt.slice(0, 10)}`}</span>
        </p>
        {balance !== undefined && amt > balance && (
          <p className="mt-1 text-[13px] text-status-warn" data-testid="over-balance">
            Your wallet holds {fmtAmount(balance, 6)} {collateral} on Base — you cannot supply more than that. If your {collateral} is on another network or an exchange, move it to Base first.
          </p>
        )}
        {balance !== undefined && balance === 0 && (
          <p className="mt-1 text-[13px] text-oil-ink2" data-testid="zero-balance">
            This wallet holds no {collateral} on Base yet. {collateral === "cbBTC" ? "Buy cbBTC in Coinbase and send it to this wallet on Base, or swap for it on the Spot page (Advanced)." : "Bridge ETH to Base and wrap it, or swap for WETH on the Spot page (Advanced)."}
          </p>
        )}
      </div>
    </div>
  );
}
