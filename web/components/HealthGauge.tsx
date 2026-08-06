"use client";

import StatusPill from "./StatusPill";

/**
 * Health-factor band gauge (Curve-Llamalend-inspired; see docs/UX-TEARDOWN.md).
 *
 * Instead of a fill bar (which reads as "progress"), the scale shows the risk
 * ZONES — at risk (<1.2), caution (1.2–1.5), healthy (≥1.5) — with a marker at
 * the current HF, so users see *distance to danger*. Thresholds match the
 * agent: warns at 1.5, de-risks below 1.2. When `zecPrice` and `liqPrice` are
 * provided, the footer states the liquidation price in dollars — the number
 * users actually reason about.
 */
export default function HealthGauge({
  hf,
  zecPrice,
  liqPrice,
}: {
  hf: number;
  zecPrice?: number;
  liqPrice?: number;
}) {
  const finite = Number.isFinite(hf);
  // Display window 1.0 → 3.0; zone boundaries at 1.2 / 1.5.
  const X = (v: number) => Math.max(0, Math.min(1, (v - 1) / 2)) * 100;
  const marker = finite ? X(hf) : 100;
  const kind = !finite || hf >= 1.5 ? "good" : hf >= 1.2 ? "warn" : "serious";
  const label = !finite
    ? "No debt"
    : hf >= 1.7
      ? "Healthy"
      : hf >= 1.5
        ? "Comfortable"
        : hf >= 1.2
          ? "Caution"
          : "At risk";

  const fmt = (v: number) =>
    v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm text-ink-muted">Health factor</span>
        <div className="flex items-center gap-2">
          <span className="num text-xl font-bold text-ink-hi">{finite ? hf.toFixed(2) : "∞"}</span>
          <StatusPill kind={kind} label={label} />
        </div>
      </div>

      <div className="relative h-2.5 overflow-hidden rounded-full">
        <div className="absolute inset-0 flex">
          <div className="h-full bg-status-serious" style={{ width: `${X(1.2)}%` }} />
          <div className="h-full bg-status-warn" style={{ width: `${X(1.5) - X(1.2)}%` }} />
          <div className="h-full flex-1 bg-status-good" />
        </div>
        {/* current-HF marker */}
        <div
          className="absolute top-0 h-full w-[3px] rounded bg-ink-hi shadow-[0_0_6px_rgba(0,0,0,.8)] transition-all"
          style={{ left: `calc(${marker}% - 1.5px)` }}
        />
      </div>

      <div className="mt-1 flex justify-between text-[10px] text-ink-muted">
        <span>1.0 liquidation</span>
        <span>1.2 de-risk</span>
        <span>1.5 warn</span>
        <span>3.0+</span>
      </div>

      {finite && zecPrice !== undefined && liqPrice !== undefined && (
        <p className="num mt-1.5 text-xs text-ink-muted">
          Liquidation begins if ZEC falls to{" "}
          <b className="text-status-serious">{fmt(liqPrice)}</b> (now {fmt(zecPrice)},{" "}
          {Math.round((1 - liqPrice / zecPrice) * 100)}% below)
        </p>
      )}
    </div>
  );
}
