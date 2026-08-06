const STYLES: Record<string, { cls: string; icon: string }> = {
  good: { cls: "chip-good", icon: "●" },
  warn: { cls: "chip-warn", icon: "▲" },
  serious: { cls: "chip-serious", icon: "■" },
  critical: { cls: "chip-serious", icon: "■" },
  info: { cls: "chip-info", icon: "◆" },
  gold: { cls: "chip-gold", icon: "⚡" },
  neutral: { cls: "chip-neutral", icon: "○" },
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
    <span className={`chip ${s.cls}`}>
      <span aria-hidden>{s.icon}</span>
      {label}
    </span>
  );
}
