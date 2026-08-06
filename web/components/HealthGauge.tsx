"use client";

import StatusPill from "./StatusPill";

/**
 * Health-factor meter. A meter (not a chart): labeled thresholds, status
 * color + text label together, value shown as a figure.
 */
export default function HealthGauge({ hf }: { hf: number }) {
  const finite = Number.isFinite(hf);
  // Map HF to 0..1 across a 1.0 → 3.0 display window.
  const t = finite ? Math.max(0, Math.min(1, (hf - 1) / 2)) : 1;
  const kind = !finite || hf >= 1.7 ? "good" : hf >= 1.5 ? "warn" : hf >= 1.2 ? "serious" : "critical";
  const label = !finite ? "No debt" : hf >= 1.7 ? "Healthy" : hf >= 1.5 ? "Comfortable" : hf >= 1.2 ? "Caution" : "At risk";
  const barColor =
    kind === "good"
      ? "bg-status-good"
      : kind === "warn"
        ? "bg-status-warn"
        : kind === "serious"
          ? "bg-status-serious"
          : "bg-status-critical";

  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-sm text-ink-muted">Health factor</span>
        <div className="flex items-center gap-2">
          <span className="text-xl font-bold text-white">{finite ? hf.toFixed(2) : "∞"}</span>
          <StatusPill kind={kind} label={label} />
        </div>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full bg-ink-raised">
        <div
          className={`h-full rounded-full ${barColor} transition-all`}
          style={{ width: `${t * 100}%` }}
        />
        {/* threshold ticks at HF 1.2 and 1.5 */}
        <div className="absolute top-0 h-full w-px bg-ink-bg" style={{ left: "10%" }} />
        <div className="absolute top-0 h-full w-px bg-ink-bg" style={{ left: "25%" }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-ink-muted">
        <span>1.0 liquidation</span>
        <span>1.2 critical</span>
        <span>1.5 warning</span>
        <span>3.0+</span>
      </div>
    </div>
  );
}
