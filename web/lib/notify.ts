/**
 * Pure logic for the in-app owner-notification channel (v1). No transport,
 * no state — see components/NotifyBanner.tsx for where this is used and
 * docs/ARCHITECTURE.md "Owner notifications (v1)" for why in-app is v1's
 * only channel: the health ladder is a pure function of on-chain data the
 * dashboard already reads, so nothing needs to be relayed from the keeper.
 */
import { HF_LADDER, rungFor, type HfRung } from "@zyo/shared";

/**
 * The rung currently firing for a live HF on the ACCOUNT's ladder (derived from its recorded entry
 * HF since A4; the floor's when nothing is recorded), or null when healthy / the HF is
 * not yet a readable number. Unlike the keeper's own `rungFor`, this never
 * throws: a dashboard mid-load sees `NaN`/`undefined` before the account
 * read resolves, and that must render "no alert", not crash the page. Every
 * other tile on the dashboard already surfaces an unreadable HF on its own.
 */
export function alertRungFor(hf: number | null | undefined, ladder: readonly HfRung[] = HF_LADDER): HfRung | null {
  if (typeof hf !== "number" || Number.isNaN(hf) || hf < 0) return null;
  return rungFor(hf, ladder);
}

/**
 * What the banner shows for a live health factor: nothing (healthy or not opted in), a rung, or —
 * when the account read failed — an "unreadable" alert. The failure case is its own state
 * because it used to render as "No debt" (audit wave 2, N-MED-2).
 */
export type BannerState = { kind: "unreadable" } | { kind: "rung"; rung: HfRung } | null;

export function bannerStateFor(hf: number | null | undefined, ladder: readonly HfRung[] = HF_LADDER): BannerState {
  if (hf === null || hf === undefined || Number.isNaN(hf)) return { kind: "unreadable" };
  const rung = alertRungFor(hf, ladder);
  return rung ? { kind: "rung", rung } : null;
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
