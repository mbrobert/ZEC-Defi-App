"use client";

import { useState } from "react";
import { FEES, feeBreakdown, shouldClaim } from "@zyo/shared";
import { fmtHalfWidth } from "@/lib/math";
import type { PositionView } from "@/lib/positions";
import { fmtAgo, fmtUsd } from "@/lib/format";
import Chip from "./Chip";
import { TokenPair } from "./TokenMark";

/**
 * One LP position. Yield breakdown: gross accrued → engine's cut is already
 * netted by the engine before payout → Oilskin performance fee (FEES) →
 * net claimable. All derived, nothing typed.
 */
export default function PositionCard({
  p,
  onClaim,
  onUnwind,
  busy,
  advanced = false,
}: {
  p: PositionView;
  onClaim: (p: PositionView) => void;
  onUnwind: (p: PositionView) => void;
  busy?: boolean;
  /** Advanced mode: raw position data from the engine. */
  advanced?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pool = p.pool;
  const gross = p.accruedRewardsUsd ?? 0;
  const fees = feeBreakdown(gross);
  const claim = shouldClaim(gross, 0.05, p.daysSinceFirstAccrual ?? 0);
  const pair = pool ? `${pool.token0}/${pool.token1}` : p.poolId;
  const netPct = p.entryUsdc && p.valueUsd ? ((p.valueUsd + fees.net - p.entryUsdc) / p.entryUsdc) * 100 : undefined;

  return (
    <div className="card mb-3.5 overflow-hidden" data-testid="position-card">
      <button className="flex w-full flex-wrap items-center gap-x-3.5 gap-y-2.5 px-4 py-3.5 text-left hover:bg-white/[.015] sm:px-5 sm:py-4" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <TokenPair a={pool?.token0 ?? "?"} b={pool?.token1} />
        <div className="min-w-0 flex-1 basis-[180px]">
          <div className="flex flex-wrap items-center gap-2 text-[15px] font-semibold">
            {pair}
            {pool && <span className="text-[12px] font-normal text-oil-ink3">{pool.dex.replace("_", " ").toLowerCase()}</span>}
            {p.inRange === true && <Chip kind="good">In range</Chip>}
            {p.inRange === false && <Chip kind="warn">Out of range</Chip>}
            {p.inRange === undefined && <Chip kind="mute">Range unknown</Chip>}
            {p.rangeWidthBps !== undefined && <Chip kind="mute">{fmtHalfWidth(p.rangeWidthBps)}</Chip>}
            {p.source === "cache" && <Chip kind="info">indexer cache</Chip>}
            {p.source === "demo" && <Chip kind="mute">demo</Chip>}
          </div>
          <div className="mt-0.5 text-[12.5px] text-oil-ink3">
            {p.positionId !== undefined ? `engine position #${p.positionId} · ` : ""}
            {p.preset !== "UNKNOWN" ? `${p.preset.toLowerCase()} · ` : ""}
            {p.openedAt ? `opened ${fmtAgo(p.openedAt)}` : "opened —"}
            {p.detailSource === "none" && " · details pending indexer"}
          </div>
        </div>
        <div className="order-3 flex w-full gap-5 sm:order-none sm:w-auto sm:gap-8">
          <Num label="Value" v={p.valueUsd !== undefined ? fmtUsd(p.valueUsd) : "—"} />
          <Num label="Since entry" v={netPct !== undefined ? `${netPct >= 0 ? "+" : ""}${netPct.toFixed(2)}%` : "—"} tone={netPct === undefined ? undefined : netPct >= 0 ? "good" : "crit"} />
          <Num label="Claimable" v={fmtUsd(fees.net)} />
        </div>
        <span className={`ml-auto text-oil-ink3 transition sm:ml-0 ${open ? "rotate-180" : ""}`} aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="border-t border-white/10 bg-oil-bg2 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap gap-8">
            <div className="grid min-w-[260px] flex-1 grid-cols-[1fr_auto] gap-y-1.5 text-[13.5px]">
              <span className="text-oil-ink2">AERO rewards accrued (engine-net)</span>
              <span className="num text-right font-semibold">{fmtUsd(fees.gross)}</span>
              <span className="text-oil-ink2">Oilskin performance fee ({FEES.performanceBps / 100}% of realised)</span>
              <span className="num text-right font-semibold text-oil-ink3">−{fmtUsd(fees.performanceFee)}</span>
              <span className="mt-1 border-t border-oil-line pt-2 font-semibold text-oil-ink">Net claimable to your wallet</span>
              <span className="num mt-1 border-t border-oil-line pt-2 text-right font-semibold">{fmtUsd(fees.net)}</span>
            </div>
            <div className="min-w-[220px] flex-1 text-[13px] text-oil-ink2">
              {p.entryUsdc !== undefined && (
                <div>
                  Entered with <b className="num text-oil-ink">{fmtUsd(p.entryUsdc)} USDC</b> borrowed against your collateral.
                </div>
              )}
              <div className="mt-1.5">
                {p.venue === "direct"
                  ? `Held directly on Aerodrome Slipstream (no engine, no engine fee), ${p.staked ? "staked in the pool's gauge: its trading fees go to veAERO voters and the position earns AERO emissions instead" : "NOT staked in the gauge: it earns the pool's trading fees, no AERO"}. The range does not move on its own.`
                  : "While staked in the Aerodrome gauge this pool’s trading fees go to veAERO voters; the position earns AERO emissions instead. The engine keeps 15% of what it harvests before it reaches your account."}
              </div>
              {p.earlyPenalty && p.earlyPenalty.bps > 0 && (
                <div className="mt-1.5 text-oil-ink3" data-testid="early-penalty">
                  Unstaking before {p.earlyPenalty.until.replace("T", " ").slice(0, 19)} UTC forfeits {p.earlyPenalty.bps >= 10_000 ? "all" : `${(p.earlyPenalty.bps / 100).toFixed(2)}%`} of the AERO earned so far to the gauge&rsquo;s minter (Aerodrome&rsquo;s early-unstake rule).
                </div>
              )}
              <div className="mt-1.5 text-oil-ink3">
                Claim guidance: {claim.claim ? "worth claiming" : claim.reason === "below-floor" ? "below the claim floor" : claim.reason === "gas-too-high" ? "gas would eat too much" : "wait"} (policy from @zyo/shared).
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2.5">
            <button className="btn-brass" disabled={busy || gross <= 0} onClick={() => onClaim(p)} data-testid="claim-btn">
              Claim rewards
            </button>
            <button className="btn-ghost" disabled={busy} onClick={() => onUnwind(p)} data-testid="unwind-btn">
              Unwind position
            </button>
            <span className="self-center text-[12px] text-oil-ink3">{p.autoCompound ? "Engine auto-compound is on: collected fees are reinvested by the engine itself." : "Engine auto-compound is off."}</span>
          </div>
          {advanced && (
            <dl className="mono mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 border-t border-white/10 pt-3 text-oil-ink2" data-testid="raw-position">
              <dt className="text-oil-ink3">engine position id</dt>
              <dd>{p.positionId !== undefined ? String(p.positionId) : "—"}</dd>
              <dt className="text-oil-ink3">engine pool id</dt>
              <dd>{p.enginePoolId ?? "—"}</dd>
              <dt className="text-oil-ink3">pool contract</dt>
              <dd>{p.pool?.poolAddress ?? "—"}</dd>
              <dt className="text-oil-ink3">ticks (lower / current / upper)</dt>
              <dd>
                {p.tickLower ?? "—"} / {p.tick ?? "—"} / {p.tickUpper ?? "—"}
              </dd>
              <dt className="text-oil-ink3">width · delay · auto-compound</dt>
              <dd>
                {p.rangeWidthBps ?? "—"} bps · {p.rebalanceDelayHours ?? "—"} h · {p.autoCompound === undefined ? "—" : p.autoCompound ? "on" : "off"}
              </dd>
              <dt className="text-oil-ink3">rebalances · lifetime AERO</dt>
              <dd>
                {p.totalRebalances ?? "—"} · {p.cumulativeRewardsAero !== undefined ? `${p.cumulativeRewardsAero.toFixed(4)} AERO` : "—"}
              </dd>
              <dt className="text-oil-ink3">sources</dt>
              <dd>
                row {p.source} · USD detail {p.detailSource}
              </dd>
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

function Num({ label, v, tone }: { label: string; v: string; tone?: "good" | "crit" }) {
  return (
    <div>
      <div className="text-[11.5px] text-oil-ink3">{label}</div>
      <div className={`num mt-px text-[15.5px] font-semibold ${tone === "good" ? "text-status-good" : tone === "crit" ? "text-status-crit" : ""}`}>{v}</div>
    </div>
  );
}
