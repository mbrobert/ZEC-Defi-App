/**
 * Pure logic for the in-app owner-notification channel (v1). No transport,
 * no state — see components/NotifyBanner.tsx for where this is used and
 * docs/ARCHITECTURE.md "Owner notifications (v1)" for why in-app is v1's
 * only channel: the health ladder is a pure function of on-chain data the
 * dashboard already reads, so nothing needs to be relayed from the keeper.
 */
import { rungFor, type HfRung } from "@zyo/shared";

/**
 * The rung currently firing for a live HF, or null when healthy / the HF is
 * not yet a readable number. Unlike the keeper's own `rungFor`, this never
 * throws: a dashboard mid-load sees `NaN`/`undefined` before the account
 * read resolves, and that must render "no alert", not crash the page. Every
 * other tile on the dashboard already surfaces an unreadable HF on its own.
 */
export function alertRungFor(hf: number | null | undefined): HfRung | null {
  if (typeof hf !== "number" || Number.isNaN(hf) || hf < 0) return null;
  return rungFor(hf);
}

/**
 * Whether a NEW browser notification should fire for the current rung, given
 * the id of the rung we last notified for (in this session). Fires once per
 * distinct rung — a steady "warn" is not repeated every poll, but recovering
 * and then falling back into "warn" (or worsening to "repay") fires again.
 */
export function shouldNotify(rung: HfRung | null, lastNotifiedRungId: string | null): boolean {
  return rung !== null && rung.id !== lastNotifiedRungId;
}
