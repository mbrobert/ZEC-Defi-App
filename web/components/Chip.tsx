import type { ReactNode } from "react";

export type ChipKind = "good" | "warn" | "crit" | "info" | "brass" | "mute";

const ICON: Record<ChipKind, string> = {
  good: "●",
  warn: "▲",
  crit: "■",
  info: "◆",
  brass: "◈",
  mute: "○",
};

/** Status is never colour-alone: icon + label always ship together. */
export default function Chip({ kind, children, title }: { kind: ChipKind; children: ReactNode; title?: string }) {
  return (
    <span className={`chip chip-${kind}`} title={title}>
      <span aria-hidden className="text-[9px]">
        {ICON[kind]}
      </span>
      {children}
    </span>
  );
}
