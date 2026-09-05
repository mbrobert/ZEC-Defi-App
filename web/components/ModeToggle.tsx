"use client";

import { useMode, type Mode } from "@/lib/mode";

/** Simple / Advanced — the product-wide toggle. Simple is the guided path; Advanced is the full suite. */
export default function ModeToggle() {
  const { mode, setMode } = useMode();
  const opt = (m: Mode, label: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === m}
      onClick={() => setMode(m)}
      className={`rounded-lg px-2.5 py-1 text-[12.5px] font-semibold transition ${mode === m ? "bg-oil-surface2 text-oil-ink shadow" : "text-oil-ink2 hover:text-oil-ink"}`}
      data-testid={`mode-${m}`}
    >
      {label}
    </button>
  );
  return (
    <div className="inline-flex gap-0.5 rounded-[11px] border border-oil-line bg-oil-bg2 p-0.5" role="radiogroup" aria-label="Simple or Advanced" title="Simple: the guided path with one recommended strategy. Advanced: every pool, custom width and delay, spot, claim / unwind / keeper controls, raw position data.">
      {opt("simple", "Simple")}
      {opt("advanced", "Advanced")}
    </div>
  );
}
