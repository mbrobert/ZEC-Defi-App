"use client";

import { ENTRY_HF_FLOOR, MAX_OFFERED_LTV_CAP_BPS, type CollateralSymbol, type LtvPreset, type LtvPresetId } from "@zyo/shared";
import type { MarketRead } from "@/lib/reads";
import { planLoan } from "@/lib/math";
import { fmtPct, fmtUsd, fmtUsd0 } from "@/lib/format";
import { rungPlain } from "@/lib/keeper";
import { KEEPER_GRANT_EXPIRY_DAYS } from "@/lib/plan";
import HealthBand from "@/components/HealthBand";
import Chip from "@/components/Chip";

/**
 * The 30 / 40 / top setting. `presets` came from ltvPresets(LT) with LT read
 * from the venue — the third card's percentage is computed per asset, and a
 * preset above the venue's own max LTV is marked not offered rather than
 * rendered as a number that would revert.
 *
 * The rung list below is the one place the product used to over-promise: it
 * read "→ keeper derisk" beside every rung whether or not any permission
 * existed, and the permission it asked for could not honour those actions at
 * all. Each rung now says what happens in plain words, says which ones need a
 * permission you have not granted yet, and says that the first rung is a
 * message rather than a transaction.
 */
export default function SettingStep({
  market,
  collateral,
  amount,
  presets,
  selected,
  onSelect,
  keeperProtection,
}: {
  market: MarketRead;
  collateral: CollateralSymbol;
  amount: number;
  presets: LtvPreset[];
  selected: LtvPresetId;
  onSelect: (id: LtvPresetId) => void;
  /** Whether the plan currently includes the keeper grant. */
  keeperProtection: boolean;
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
          <b className="num text-oil-ink">{fmtPct(r.liquidationThresholdBps / 100, 0)}</b> ({market.source === "live" ? "read live" : "snapshot"}); the top setting is min({MAX_OFFERED_LTV_CAP_BPS / 100}%, Aave&rsquo;s own max LTV of{" "}
          {fmtPct(r.ltvBps / 100, 0)}, floor(threshold ÷ {ENTRY_HF_FLOOR})) so every position opens at HF ≥ {ENTRY_HF_FLOOR}. The venue itself refuses a borrow under that floor, so a position cannot be opened below it by any route.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Setting">
        {presets.map((p) => {
          const sel = p.id === selected;
          const unlisted = p.ltvBps === 0;
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
                <span className="text-[22px] font-bold">{unlisted ? "—" : fmtPct(p.ltvBps / 100, 0)}</span>
                {p.id === "top" && p.offerable ? <Chip kind="brass">top for {collateral}</Chip> : p.offerable ? <Chip kind="mute">offered</Chip> : <Chip kind="crit">not offered</Chip>}
              </div>
              {unlisted ? (
                <p className="mt-2 text-[12px] text-oil-ink3">Aave is not lending against {collateral} at this setting right now, so Oilskin has nothing to offer here.</p>
              ) : (
                <dl className="num mt-2 grid grid-cols-2 gap-y-1 text-[12.5px]">
                  <dt className="text-oil-ink3">Entry HF</dt>
                  <dd className="text-right">{p.entryHf?.toFixed(2) ?? "—"}</dd>
                  <dt className="text-oil-ink3">Liquidation if {collateral} falls</dt>
                  <dd className="text-right">−{p.liquidationDropPct.toFixed(1)}%</dd>
                </dl>
              )}
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

        <h3 className="mt-4 text-[13.5px]">If {collateral} falls, this is what happens</h3>
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
      </div>
    </div>
  );
}
