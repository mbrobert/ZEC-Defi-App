const STYLES: Record<string, { cls: string; icon: string }> = {
  good: { cls: "border-status-good/40 text-status-good", icon: "●" },
  warn: { cls: "border-status-warn/40 text-status-warn", icon: "▲" },
  serious: { cls: "border-status-serious/40 text-status-serious", icon: "▲" },
  critical: { cls: "border-status-critical/40 text-status-critical", icon: "■" },
  neutral: { cls: "border-ink-border text-ink-muted", icon: "○" },
};

/** Status is never color-alone: icon + label always ship together. */
export default function StatusPill({
  kind,
  label,
}: {
  kind: keyof typeof STYLES;
  label: string;
}) {
  const s = STYLES[kind] ?? STYLES.neutral;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.cls}`}
    >
      <span aria-hidden>{s.icon}</span>
      {label}
    </span>
  );
}
