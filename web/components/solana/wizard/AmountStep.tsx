"use client";

import { fmtAgo, fmtPct, fmtUsd } from "@/lib/format";
import { solanaRefusalPlain, type SolanaBorrowView } from "@/lib/solana/yield";
import Chip from "@/components/Chip";

/**
 * Step 2: how much ZEC. The pool as it is rides beside the field — what it can lend today, the rate now, the
 * deposit room — each with the slot and time it was read, and "snapshot" when it is the demo.
 */
export default function AmountStep({ amount, onAmount, view, walletZec, mode }: { amount: string; onAmount: (v: string) => void; view: SolanaBorrowView; walletZec: number | null; mode: "demo" | "live" }) {
  const n = Number(amount);
  const valid = Number.isFinite(n) && n > 0;
  const poolRefusals = view.refusals.filter((r) => r !== "entry_hf_below_floor" && r !== "venue_ltv_exceeded");
  const asOf = view.slot !== null ? `slot ${view.slot.toLocaleString()}${view.sampledAt ? `, ${fmtAgo(view.sampledAt)}` : ""}` : "no read";
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px]">How much ZEC?</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">The ZEC moves from your wallet into your own Oilskin account and on into Kamino as collateral. You can withdraw it whenever the debt allows.</p>
      </div>
      <div className="card p-5">
        <label htmlFor="zec-amount" className="text-[13px] text-oil-ink2">
          ZEC to deposit
        </label>
        <div className="mt-2 flex items-center gap-3">
          <input id="zec-amount" className="input num w-full text-[20px]" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => onAmount(e.target.value.replace(/[^0-9.]/g, ""))} data-testid="zec-amount" />
          {walletZec !== null && (
            <button type="button" className="btn btn-quiet" onClick={() => onAmount(String(walletZec))} data-testid="zec-max">
              max {walletZec}
            </button>
          )}
        </div>
        {valid && view.zecPriceUsd !== null && (
          <p className="mt-2 text-[13px] text-oil-ink2">
            About <b className="num text-oil-ink">{fmtUsd(n * view.zecPriceUsd)}</b> at Scope&rsquo;s ZEC price of <span className="num">{fmtUsd(view.zecPriceUsd)}</span>
            {view.oracleAgeS !== null ? ` (${view.oracleAgeS}s old at the read)` : ""}.
          </p>
        )}
        {mode === "live" && walletZec === null && <p className="mt-2 text-[12.5px] text-oil-ink3">Your wallet holds no ZEC on Solana yet.</p>}
      </div>

      <div className="card p-5" data-testid="pool-view">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[14px] font-semibold">Kamino&rsquo;s USDC pool right now</div>
          <Chip kind={view.source === "live" ? (view.stale ? "warn" : "good") : "mute"}>{view.source === "live" ? (view.stale ? "stale read" : "read live") : "snapshot"}</Chip>
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-oil-ink3">Can lend today</dt>
            <dd className="num text-[15px]" data-testid="pool-fundable">
              {view.maxFundableUsdc !== null ? fmtUsd(view.maxFundableUsdc) : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-oil-ink3">Borrow rate now</dt>
            <dd className="num text-[15px]">{view.borrowAprNowPct !== null ? `${fmtPct(view.borrowAprNowPct)} a year` : "—"}</dd>
          </div>
          <div>
            <dt className="text-oil-ink3">Pool lent out</dt>
            <dd className="num">{view.utilizationNowPct !== null ? fmtPct(view.utilizationNowPct, 1) : "—"}</dd>
          </div>
          <div>
            <dt className="text-oil-ink3">ZEC deposit room left</dt>
            <dd className="num">{view.remainingDepositZec !== null ? `${view.remainingDepositZec.toLocaleString(undefined, { maximumFractionDigits: 2 })} ZEC` : "—"}</dd>
          </div>
        </dl>
        <p className="mt-2 text-[12px] text-oil-ink3">Read at {asOf}. Your borrow raises the rate for everyone; the next step shows the rate after it.</p>
        {poolRefusals.length > 0 && (
          <ul className="mt-3 space-y-1 text-[13px]" data-testid="pool-refusals">
            {poolRefusals.map((r) => (
              <li key={r} className="flex gap-2">
                <Chip kind="crit">refused</Chip>
                <span>{solanaRefusalPlain(r)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
