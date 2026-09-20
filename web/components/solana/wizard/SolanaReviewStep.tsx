"use client";

import { fmtPct, fmtUsd } from "@/lib/format";
import { SOLANA_DISCLOSURES, SOLANA_KEEPER_NO_SELL, SOLANA_RISKS } from "@/lib/solana/copy";
import type { Mode } from "@/lib/mode";
import type { OpenStep, SolanaOpenPlan } from "@/lib/solana/plan";
import type { SolanaBorrowView, SolanaDisclosureId } from "@/lib/solana/yield";
import Chip from "@/components/Chip";

/**
 * Step 4: every number with its slot, the disclosures the yield route named, Oilskin's risk list, the steps to sign.
 * In Advanced mode, one more decision: whether the keeper may sell ZEC (founder's decision 1, on by default). Saying no
 * sets the grant's sell budget to zero and swaps the "keeper may sell" card for the one that says what that costs.
 */
export default function SolanaReviewStep({ plan, view, steps, acknowledged, onAcknowledge, mode, productMode, keeperMaySell, onKeeperMaySell }: {
  plan: SolanaOpenPlan; view: SolanaBorrowView; steps: OpenStep[]; acknowledged: boolean; onAcknowledge: (v: boolean) => void; mode: "demo" | "live";
  productMode: Mode; keeperMaySell: boolean; onKeeperMaySell: (v: boolean) => void;
}) {
  const ids = (view.disclosures.length ? view.disclosures : Object.keys(SOLANA_DISCLOSURES)) as SolanaDisclosureId[];
  const risks = SOLANA_RISKS
    .filter((r) => !["bridged", "kamino-owner", "usdc", "program-exit"].includes(r.id) && (mode === "demo" || r.id !== "demo"))
    .map((r) => (r.id === "keeper-sells" && !keeperMaySell ? SOLANA_KEEPER_NO_SELL : r));
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[19px]">Review</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">
          Every number below was read from Solana at slot {view.slot?.toLocaleString() ?? "—"} {view.source === "live" ? "" : "(a snapshot, not live) "}or computed from those reads. Read it as a description of the position today, not a promise.
        </p>
      </div>
      <div className="card p-5" data-testid="sol-review">
        <dl className="grid grid-cols-1 gap-2 text-[13px] sm:grid-cols-2">
          <div>
            <dt className="text-oil-ink3">Deposit</dt>
            <dd className="num">{plan.collateralZec} ZEC ≈ {fmtUsd(plan.collateralUsd)}</dd>
          </div>
          <div>
            <dt className="text-oil-ink3">Borrow</dt>
            <dd className="num">{plan.borrowUsdc > 0 ? `${fmtUsd(plan.borrowUsdc)} USDC` : "nothing"}</dd>
          </div>
          <div>
            <dt className="text-oil-ink3">Entry health factor</dt>
            <dd className="num">{Number.isFinite(plan.entryHf) ? plan.entryHf.toFixed(2) : "∞"}</dd>
          </div>
          <div>
            <dt className="text-oil-ink3">Loan-to-value</dt>
            <dd className="num">{fmtPct(plan.ltvBps / 100, 1)} (Kamino&rsquo;s cap 40 %)</dd>
          </div>
          <div>
            <dt className="text-oil-ink3">Liquidation begins at</dt>
            <dd className="num">{plan.liquidationPriceUsd !== null ? `${fmtUsd(plan.liquidationPriceUsd)} per ZEC` : "never — no debt"}</dd>
          </div>
          <div>
            <dt className="text-oil-ink3">Borrow rate after your borrow</dt>
            <dd className="num">{view.borrowAprAfterPct !== null ? `${fmtPct(view.borrowAprAfterPct)} a year` : "—"}</dd>
          </div>
        </dl>
        {view.refusals.length > 0 && (
          <p className="mt-3 text-[13px]">
            <Chip kind="crit">refused</Chip> The yield service refuses this position today ({view.refusals.join(", ")}); signing would be refused by the program or by Kamino too.
          </p>
        )}
      </div>

      {productMode === "advanced" && plan.borrowUsdc > 0 && (
        <div className="card p-5" data-testid="sol-keeper-sell">
          <div className="text-[14px] font-semibold">May the keeper sell your ZEC to protect this position?</div>
          <p className="mt-1 text-[13px] text-oil-ink2">
            Yes is Oilskin&rsquo;s default: when idle USDC cannot lift the health factor, the keeper pays USDC in and takes ZEC out at no worse than 2 % under Kamino&rsquo;s oracle price, within the daily budget you sign. No sets that budget to zero: the keeper may only repay from idle USDC, and a fall it cannot answer is yours to answer.
          </p>
          <div role="radiogroup" aria-label="May the keeper sell your ZEC" className="mt-3 flex flex-wrap gap-2">
            <button type="button" role="radio" aria-checked={keeperMaySell} className={`opt px-3 py-1.5 ${keeperMaySell ? "sel" : ""}`} onClick={() => onKeeperMaySell(true)} data-testid="sol-keeper-sell-yes">
              Yes — repay, and sell if it must
            </button>
            <button type="button" role="radio" aria-checked={!keeperMaySell} className={`opt px-3 py-1.5 ${keeperMaySell ? "" : "sel"}`} onClick={() => onKeeperMaySell(false)} data-testid="sol-keeper-sell-no">
              No — repay from idle USDC only
            </button>
          </div>
        </div>
      )}

      <div className="card p-5">
        <div className="text-[14px] font-semibold">What you will sign</div>
        <ol className="mt-2 space-y-2 text-[13px]">
          {steps.map((s, i) => (
            <li key={s.id}>
              <span className="num text-oil-ink3">{i + 1}.</span> <b>{s.title}</b> — {s.sentence}
            </li>
          ))}
        </ol>
        <p className="mt-2 text-[12px] text-oil-ink3">Separate transactions: together they would exceed Solana&rsquo;s transaction size. Each is one wallet prompt.</p>
      </div>

      <div className="space-y-3">
        {ids.map((id) => {
          const d = SOLANA_DISCLOSURES[id];
          return d ? (
            <div key={id} className="card p-4">
              <div className="text-[14px] font-semibold">{d.title}</div>
              <p className="mt-1 text-[13px] text-oil-ink2">{d.body}</p>
            </div>
          ) : null;
        })}
        {risks.map((r) => (
          <div key={r.id} className="card p-4" data-testid={`sol-risk-${r.id}`}>
            <div className="text-[14px] font-semibold">{r.title}</div>
            <p className="mt-1 text-[13px] text-oil-ink2">{r.body}</p>
          </div>
        ))}
      </div>

      <label className="flex items-start gap-3 text-[13.5px]">
        <input type="checkbox" className="mt-1" checked={acknowledged} onChange={(e) => onAcknowledge(e.target.checked)} data-testid="sol-ack-review" />
        <span>I have read these numbers and disclosures. I understand they describe today, that ZEC can fall far enough to liquidate this position, that Kamino&rsquo;s owner can change the market&rsquo;s rules, and that nothing here is advice.</span>
      </label>
    </div>
  );
}
