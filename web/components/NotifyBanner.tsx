"use client";

import { useEffect, useRef } from "react";
import { alertRungFor, shouldNotify } from "@/lib/notify";
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
 * Renders nothing when the owner has not opted in, or nothing is firing.
 */
export default function NotifyBanner({ hf, collateral }: { hf: number; collateral: string }) {
  const { prefs } = useNotifyPrefs();
  const rung = alertRungFor(hf);
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

  if (!prefs.optIn || !rung) return null;
  return (
    <div className={`note ${rung.severity >= 3 ? "note-crit" : "note-warn"}`} role="alert" data-testid="notify-banner">
      <b className="text-oil-ink">
        {rung.label} (HF &lt; {rung.hf.toFixed(2)}).
      </b>{" "}
      {rungPlain(rung, collateral)}
    </div>
  );
}
