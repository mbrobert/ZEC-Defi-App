"use client";

import { useEffect, useRef } from "react";
import { HF_LADDER, type HfRung } from "@zyo/shared";
import { alertRungFor, bannerStateFor, shouldNotify } from "@/lib/notify";
import { useNotifyPrefs } from "@/lib/notifyPrefs";
import { rungPlain } from "@/lib/keeper";

/**
 * The in-app owner-notification channel (docs/ARCHITECTURE.md "Owner
 * notifications (v1)"): this computes the same public health ladder the
 * keeper computes and shows it directly, whenever the dashboard is open.
 * Nothing is relayed from the keeper — nothing can be yet (no data plane
 * exists between this app and that process), so this is honest about what
 * it promises: you are told when you have the app open, not paged.
 *
 * Renders nothing when the owner has not opted in, or nothing is firing. An account read that
 * failed renders an "unreadable" alert — never silence (audit wave 2, N-MED-2).
 */
export default function NotifyBanner({ hf, collateral, ladder = HF_LADDER }: { hf: number | null; collateral: string; ladder?: readonly HfRung[] }) {
  const { prefs } = useNotifyPrefs();
  const state = bannerStateFor(hf, ladder);
  const rung = hf === null ? null : alertRungFor(hf, ladder);
  const lastNotifiedRungId = useRef<string | null>(null);

  useEffect(() => {
    if (!prefs.optIn || prefs.channel !== "browser") return;
    if (!shouldNotify(rung, lastNotifiedRungId.current)) return;
    if (!rung) return;
    lastNotifiedRungId.current = rung.id;
    if (typeof window === "undefined" || !("Notification" in window)) return;
    const fire = () => new Notification(`Oilskin — ${rung.label}`, { body: rungPlain(rung, collateral) });
    if (Notification.permission === "granted") fire();
    else if (Notification.permission !== "denied") {
      void Notification.requestPermission().then((p) => {
        if (p === "granted") fire();
      });
    }
  }, [prefs.optIn, prefs.channel, rung, collateral]);

  if (!prefs.optIn) return null;
  if (state?.kind === "unreadable") {
    return (
      <div className="note note-warn" role="alert" data-testid="notify-unreadable">
        <b className="text-oil-ink">Oilskin cannot read your health factor right now.</b> The account read from the lending venue did not come back, so this page cannot tell you whether {collateral} needs attention. That is not the same as being safe: check again shortly, or read your position directly on the lending venue.
      </div>
    );
  }
  if (!rung) return null;
  return (
    <div className={`note ${rung.severity >= 3 ? "note-crit" : "note-warn"}`} role="alert" data-testid="notify-banner">
      <b className="text-oil-ink">
        {rung.label} (HF &lt; {rung.hf.toFixed(2)}).
      </b>{" "}
      {rungPlain(rung, collateral)}
    </div>
  );
}
