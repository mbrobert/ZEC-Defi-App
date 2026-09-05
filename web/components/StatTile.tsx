import type { ReactNode } from "react";

export default function StatTile({
  label,
  value,
  sub,
  tone,
  hint,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "good" | "warn" | "crit";
  hint?: string;
  testId?: string;
}) {
  const color = tone === "good" ? "text-status-good" : tone === "warn" ? "text-status-warn" : tone === "crit" ? "text-status-crit" : "";
  return (
    <div className="card px-3.5 py-3.5 sm:px-[18px] sm:py-4" data-testid={testId}>
      <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-oil-ink2">
        {label}
        {hint && (
          <span className="cursor-help text-[11px] text-oil-ink3" title={hint}>
            ⓘ
          </span>
        )}
      </div>
      <div className={`num mt-1 text-[22px] font-bold leading-tight tracking-tight sm:text-[27px] ${color}`}>{value}</div>
      {sub && <div className="num mt-0.5 text-[12.5px] text-oil-ink3">{sub}</div>}
    </div>
  );
}
