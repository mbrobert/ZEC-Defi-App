"use client";

import { ENTRY_HF_FLOOR, FEES } from "@zyo/shared";
import { fmtHalfWidth } from "@/lib/math";
import { reasonText } from "@/lib/gate";
import type { PlannedCall } from "@/lib/plan";
import type { ReviewDerivation, WizardState } from "@/lib/wizard";
import { fmtAmount, fmtPct, fmtSignedPct, fmtUsd, fmtUsd0 } from "@/lib/format";
import Disclosures from "@/components/Disclosures";
import Chip from "@/components/Chip";
import { useMode } from "@/lib/mode";

export default function ReviewStep({ state, d, calls, marketSource }: { state: WizardState; d: ReviewDerivation; calls: PlannedCall[]; marketSource: "live" | "snapshot" }) {
  const y = d.yieldPlan;
  const { mode } = useMode();

  return (
    <div className="space-y-5" data-testid="review">
      <div>
        <h2 className="text-[19px]">Review</h2>
        <p className="mt-1 text-[13.5px] text-oil-ink2">
          Every number below is computed from the venue read ({marketSource === "live" ? "live" : "snapshot"}) and the gate. Nothing is typed in.
        </p>
      </div>

      {d.problems.length > 0 && (
        <div className="note note-crit" role="alert" data-testid="review-problems">
          <ul className="list-disc pl-4">
            {d.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="card divide-y divide-white/10">
        <Sec>Loan</Sec>
        <Row k="Collateral" v={`${fmtAmount(d.amount, 8)} ${d.asset.symbol} ≈ ${fmtUsd(d.loan.collateralUsd)} at ${fmtUsd(d.priceUsd)}`} />
        <Row k="Liquidation threshold (Aave, read)" v={fmtPct(d.liquidationThresholdBps / 100, 0)} />
        <Row k="Setting" v={`${fmtPct(d.preset.ltvBps / 100, 0)} LTV${d.preset.id === "top" ? " (top for this asset)" : ""}`} />
        <Row k="Borrow" v={`${fmtUsd(d.loan.borrowUsdc)} USDC at ${fmtPct(d.borrowAprPct)} variable (${fmtUsd(d.loan.borrowCostUsdPerYear)}/yr today)`} />
        <Row k="Health factor at entry" v={`${d.loan.entryHf.toFixed(2)} (floor ${ENTRY_HF_FLOOR})`} />
        <Row k="Liquidation begins" v={`${d.asset.symbol} at ${fmtUsd0(d.loan.liquidationPriceUsd)} (−${d.loan.liquidationDropPct.toFixed(1)}%)`} tone="crit" />
        {d.loan.rungs.map(({ rung, priceUsd, dropPct }) => (
          <Row key={rung.id} k={`Keeper ${rung.label.toLowerCase()} rung (HF < ${rung.hf.toFixed(2)})`} v={`${d.asset.symbol} at ${fmtUsd0(priceUsd)} (−${dropPct.toFixed(1)}%) → ${rung.action.replace("-", " ")}`} />
        ))}

        <Sec>Strategy</Sec>
        {state.strategy?.kind === "lp" && d.verdict && d.lpParams ? (
          <>
            <Row k="Pool" v={`${d.verdict.pool.token0}/${d.verdict.pool.token1} · ${d.verdict.pool.dex.replace("_", " ").toLowerCase()} · via Snuggle engine`} />
            <Row k="Range" v={`${d.verdict.preset.toLowerCase()} · ${fmtHalfWidth(d.lpParams.rangeWidthBps)} (${d.lpParams.rangeWidthBps} bps total span) · rebalance delay ${d.lpParams.rebalanceDelayHours}h · auto-compound ${d.lpParams.autoCompoundEnabled ? "on" : "off"}`} />
            {d.customWidth && <Row k="Custom width" v={`the model priced ${fmtHalfWidth(d.verdict.rangeWidthBps)} — your ${fmtHalfWidth(d.lpParams.rangeWidthBps)} band has a different impermanent-loss drag that this page does not price`} tone="crit" />}
            <Row k="Price tolerance" v={`±${(state.bandToleranceBps / 100).toFixed(2)}% — the deposit refuses if the pool price has moved further since the quote`} />
            <Row
              k="Gate"
              v={d.gateOk ? `clears: LP net ${fmtSignedPct(d.verdict.lpNetPct ?? NaN, 2)} > borrow ${fmtPct(d.verdict.borrowAprPct ?? NaN)}` : `does NOT clear — ${reasonText(d.verdict.reason)}`}
              tone={d.gateOk ? "good" : "crit"}
            />
            {y && (
              <>
                <Row k="Gross AERO emissions on deployed USDC (model)" v={`${fmtUsd(y.grossEmissionsUsd)}/yr (${fmtPct(d.verdict.emissionsGrossPct ?? NaN, 2)})`} />
                <Row k="Engine fee" v={`−${fmtUsd(y.engineFeeUsd)}/yr`} />
                <Row k={`Oilskin performance fee (${FEES.performanceBps / 100}% of realised)`} v={`−${fmtUsd(y.oilskinFeeUsd)}/yr`} />
                <Row k="Realised after IL-shrunk base" v={`${fmtUsd(y.realizedEmissionsUsd)}/yr (${fmtPct(d.verdict.emissionsRealizedPct ?? NaN, 2)})`} />
                <Row k={`IL + rebalance drag (σ ${d.verdict.sigma?.toFixed(2) ?? "—"})`} v={`${fmtUsd(y.dragUsd)}/yr (${fmtSignedPct(d.verdict.dragPct ?? NaN, 2)})`} />
                <Row k="LP net" v={`${fmtUsd(y.lpNetUsd)}/yr (${fmtSignedPct(y.lpNetPct, 2)})`} tone={y.lpNetUsd >= 0 ? "good" : "crit"} />
                <Row k="Borrow cost" v={`−${fmtUsd(y.borrowCostUsd)}/yr`} />
                <Row k={`Supply interest on your ${d.asset.symbol} (${fmtPct(d.supplyAprPct, 3)})`} v={`${fmtUsd(y.supplyInterestUsd)}/yr`} />
                <Row k="Net per year (model)" v={`${fmtUsd(y.totalUsd)} · ${fmtSignedPct(y.userNetPct, 2)} on your ${d.asset.symbol}`} tone={y.totalUsd >= 0 ? "good" : "crit"} />
              </>
            )}
          </>
        ) : state.strategy?.kind === "hold" ? (
          <>
            <Row k="Hold" v="Borrowed USDC stays in your Oilskin account. Nothing deployed, no LP risk." />
            <Row k="Borrow cost" v={`−${fmtUsd(d.loan.borrowCostUsdPerYear)}/yr at ${fmtPct(d.borrowAprPct)}`} />
            <Row k={`Supply interest on your ${d.asset.symbol} (${fmtPct(d.supplyAprPct, 3)})`} v={`${fmtUsd(d.loan.collateralUsd * d.supplyAprPct / 100)}/yr`} />
            <Row k="Net carry per year" v={`−${fmtUsd(d.holdCostUsdPerYear)}`} tone={d.holdCostUsdPerYear > 0 ? "crit" : "good"} />
          </>
        ) : state.strategy?.kind === "spot" ? (
          <>
            <Row k="Spot" v="Borrowed USDC stays in your account; place the CoW order from the Spot page afterwards (separate signature)." />
            <Row k="Net carry per year" v={`−${fmtUsd(d.holdCostUsdPerYear)} until the USDC is used`} tone={d.holdCostUsdPerYear > 0 ? "crit" : "good"} />
          </>
        ) : (
          <Row k="Strategy" v="not chosen" tone="crit" />
        )}
      </div>

      <Disclosures scope="review" open />

      <div className="card p-5" data-testid="planned-calls">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-[15px]">Exactly what you will sign</h3>
          <Chip kind="mute">
            {calls.filter((c) => c.required && c.wallet === "transaction").length} transaction{calls.filter((c) => c.required && c.wallet === "transaction").length === 1 ? "" : "s"} · {calls.filter((c) => c.required && c.wallet === "signature").length} signature
          </Chip>
        </div>
        <ol className="mt-3 space-y-3">
          {calls.map((c) => (
            <li key={c.step} className={`rounded-xl border border-oil-line bg-oil-bg2 p-3.5 ${c.required ? "" : "opacity-55"}`} data-testid={`call-${c.kind}`}>
              <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-semibold">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-brass text-[12px] text-brass-on">{c.step}</span>
                {c.title}
                <Chip kind="mute">{c.wallet === "signature" ? "signature · free" : "transaction · network fee"}</Chip>
                {!c.required && <Chip kind="mute">already done</Chip>}
                {c.required && !c.encodable && <Chip kind="warn">needs a live deployment</Chip>}
              </div>
              <p className="mt-1.5 text-[13.5px] leading-relaxed text-oil-ink">{c.plain}</p>
              {mode === "advanced" && (
                <>
                  <div className="mono mt-2 text-oil-ink3">
                    to: {c.toLabel} · {c.functionName}
                  </div>
                  <dl className="mono mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-oil-ink2">
                    {c.args.map((a) => (
                      <div key={a.name} className="contents">
                        <dt className="text-oil-ink3">{a.name}</dt>
                        <dd>{a.value}</dd>
                      </div>
                    ))}
                  </dl>
                  <p className="mt-2 text-[12.5px] text-oil-ink2">{c.note}</p>
                </>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function Sec({ children }: { children: string }) {
  return <div className="px-4 pb-1 pt-3 text-[11.5px] font-bold uppercase tracking-wider text-oil-ink3">{children}</div>;
}

function Row({ k, v, tone }: { k: string; v: string; tone?: "good" | "crit" }) {
  return (
    <div className="flex items-start justify-between gap-6 px-4 py-2.5 text-[13.5px]">
      <span className="flex-none text-oil-ink2">{k}</span>
      <span className={`num text-right ${tone === "good" ? "text-status-good" : tone === "crit" ? "text-status-crit" : "text-oil-ink"}`}>{v}</span>
    </div>
  );
}
