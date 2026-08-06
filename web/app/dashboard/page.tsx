"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Strategy } from "@zyo/shared";
import { poolById } from "@zyo/shared";
import HealthGauge from "@/components/HealthGauge";
import StatusPill from "@/components/StatusPill";
import { fmtUsd } from "@/lib/estimates";

export default function Dashboard() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [zecPrice, setZecPrice] = useState(48.75);

  useEffect(() => {
    fetch("/api/strategies")
      .then((r) => r.json())
      .then((d) => setStrategies(d.strategies ?? []))
      .catch(() => undefined);
    fetch("/api/price")
      .then((r) => r.json())
      .then((d) => d.zecUsd && setZecPrice(d.zecUsd))
      .catch(() => undefined);
  }, []);

  const totalZec = strategies.reduce(
    (s, x) => s + Number(x.lending.suppliedZecAtomic) / 1e8,
    0
  );
  const totalRewards = strategies.reduce((s, x) => s + (x.lp?.pendingRewardsUsd ?? 0), 0);

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">Your strategies</h1>
        <Link href="/deposit" className="btn-primary text-sm">
          New strategy
        </Link>
      </div>

      {/* summary tiles */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Tile label="ZEC supplied" value={`${totalZec.toLocaleString()} ZEC`} sub={fmtUsd(totalZec * zecPrice)} />
        <Tile label="Active strategies" value={String(strategies.length)} sub={`${strategies.filter((s) => s.mode === "FULL_STRATEGY").length} full · ${strategies.filter((s) => s.mode === "SIMPLE_LENDING").length} simple`} />
        <Tile label="Unclaimed rewards" value={fmtUsd(totalRewards)} sub="claimed when they clear costs 3×" />
      </div>

      <div className="space-y-4">
        {strategies.map((s) => (
          <StrategyCard key={s.id} s={s} zecPrice={zecPrice} />
        ))}
        {strategies.length === 0 && (
          <div className="card p-10 text-center text-ink-muted">
            No strategies yet. <Link className="text-zec" href="/deposit">Create your first</Link>.
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-5">
      <div className="text-sm text-ink-muted">{label}</div>
      <div className="mt-1 text-2xl font-bold text-white">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-muted">{sub}</div>}
    </div>
  );
}

function StrategyCard({ s, zecPrice }: { s: Strategy; zecPrice: number }) {
  const zec = Number(s.lending.suppliedZecAtomic) / 1e8;
  const pool = s.lp ? poolById(s.lp.poolId) : undefined;
  const isFull = s.mode === "FULL_STRATEGY";

  return (
    <div className="card p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-ink-muted">{s.id}</span>
          <StatusPill
            kind={s.status.startsWith("ACTIVE") ? "good" : s.status === "ERROR" ? "critical" : "warn"}
            label={s.status.replace(/_/g, " ").toLowerCase()}
          />
          <span className="text-xs text-ink-muted">{isFull ? "Full strategy" : "Simple lending"}</span>
        </div>
        <div className="flex gap-2">
          {!isFull && (
            <button className="btn-ghost px-3 py-1.5 text-xs">Upgrade to full strategy</button>
          )}
          <button className="btn-ghost px-3 py-1.5 text-xs">Change rewards</button>
          <button className="btn-ghost px-3 py-1.5 text-xs">Withdraw</button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* lending leg */}
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Rhea Finance · NEAR
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-ink-muted">Supplied</div>
              <div className="font-bold text-white">{zec} ZEC</div>
              <div className="text-xs text-ink-muted">{fmtUsd(zec * zecPrice)}</div>
            </div>
            {s.lending.borrowedAsset ? (
              <div>
                <div className="text-xs text-ink-muted">Borrowed</div>
                <div className="font-bold text-white">
                  {fmtUsd(Number(s.lending.borrowedAmountAtomic ?? 0) / 1e6)}
                </div>
                <div className="text-xs text-ink-muted">
                  {s.lending.borrowedAsset} · {(s.lending.targetLtvBps ?? 0) / 100}% LTV
                </div>
              </div>
            ) : (
              <div>
                <div className="text-xs text-ink-muted">Borrowed</div>
                <div className="font-bold text-white">—</div>
                <div className="text-xs text-ink-muted">supply only</div>
              </div>
            )}
          </div>
          <HealthGauge hf={s.lending.healthFactor ?? Infinity} />
        </div>

        {/* lp leg */}
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-muted">
            {isFull && pool
              ? `${pool.protocol === "MAXFI" ? "MaxFi" : "SnuggleFi"} · Base`
              : "Base leg"}
          </div>
          {isFull && s.lp && pool ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-ink-muted">Pool</div>
                <div className="font-bold text-white">
                  {pool.token0}/{pool.token1}
                </div>
                <div className="text-xs text-ink-muted">
                  {pool.dex.replace("_", " ")} · {(pool.feeTierBps / 100).toFixed(2)}%
                </div>
              </div>
              <div>
                <div className="text-xs text-ink-muted">Range status</div>
                <div className="mt-0.5">
                  {s.lp.inRange ? (
                    <StatusPill kind="good" label="In range — earning" />
                  ) : (
                    <StatusPill kind="warn" label="Out of range" />
                  )}
                </div>
                <div className="mt-1 text-xs text-ink-muted">
                  ±{(s.lp.params.rangeWidthBps / 200).toFixed(2)}% · {s.lp.params.rebalanceDelayHours}h delay
                </div>
              </div>
              <div>
                <div className="text-xs text-ink-muted">Unclaimed rewards</div>
                <div className="font-bold text-status-good">
                  {fmtUsd(s.lp.pendingRewardsUsd ?? 0)}
                </div>
              </div>
              <div>
                <div className="text-xs text-ink-muted">Reward destination</div>
                <div className="text-sm font-medium text-white">
                  {s.rewardPreference === "SEND_TO_ZCASH" ? "→ Zcash wallet" : "→ compound"}
                </div>
                {s.rewardPreference === "SEND_TO_ZCASH" && (
                  <div className="break-all font-mono text-[10px] text-ink-muted">
                    {s.owner.zcashAddress}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex h-full min-h-24 items-center justify-center rounded-lg border border-dashed border-ink-border text-sm text-ink-muted">
              No Base position — upgrade to deploy borrowed capital into an LP strategy.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
