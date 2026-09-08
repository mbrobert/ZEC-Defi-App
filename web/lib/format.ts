export function fmtUsd(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: dp, minimumFractionDigits: dp });
}

export function fmtUsd0(v: number): string {
  return fmtUsd(v, 0);
}

export function fmtPct(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return "—";
  return `${v.toFixed(dp)}%`;
}

export function fmtSignedPct(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(dp)}%`;
}

export function fmtAmount(v: number, dp = 4): string {
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: dp });
}

export function fmtHf(hf: number | null): string {
  if (hf === null) return "unreadable";
  if (!Number.isFinite(hf)) return "∞";
  return hf.toFixed(2);
}

export function fmtAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function bpsToPct(bps: number, dp = 0): string {
  return `${(bps / 100).toFixed(dp)}%`;
}
