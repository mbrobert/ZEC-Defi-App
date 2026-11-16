/**
 * Whether a page may lead to a signature on the numbers it holds. In a live (wallet-connected) session the
 * amounts are sized from the view, so the view must have come from the live service and be fresh: the offline
 * snapshot (which the hook falls back to when the service is down) carries an old price and would size a loan
 * whose real health factor lands far from the one shown. Demo sessions sign nothing, so they are never blocked.
 */
import type { SolanaBorrowView } from "./yield";

export const SOLANA_STALE_VIEW_WORDS = "The live rates could not be read, so this page will not size a loan from an old snapshot. Try again shortly.";
export const BASE_STALE_MARKET_WORDS = "The live market read failed, so this page will not size a loan from an old snapshot. Try again shortly.";

export function canSignWithView(view: Pick<SolanaBorrowView, "source" | "stale">, sessionMode: "demo" | "live"): boolean {
  if (sessionMode !== "live") return true;
  return view.source === "live" && !view.stale;
}

/** The same rule for the Base market read (`"live"` against the bundled snapshot). */
export function canSignWithMarketSource(source: "live" | "snapshot", sessionMode: "demo" | "live"): boolean {
  return sessionMode !== "live" || source === "live";
}
