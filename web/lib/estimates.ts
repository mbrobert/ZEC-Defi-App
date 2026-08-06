/** Client-side estimate math for the wizard. */

/** Rhea's approximate liquidation threshold for ZEC collateral. */
export const LIQUIDATION_THRESHOLD = 0.7;

/** Health factor implied by a target LTV (independent of price). */
export function healthFactorForLtv(ltvBps: number): number {
  if (ltvBps <= 0) return Infinity;
  return LIQUIDATION_THRESHOLD / (ltvBps / 10_000);
}

/** ZEC price at which HF hits 1.0, given entry price and target LTV. */
export function liquidationPrice(entryPrice: number, ltvBps: number): number {
  if (ltvBps <= 0) return 0;
  return entryPrice * (ltvBps / 10_000) / LIQUIDATION_THRESHOLD;
}

export function borrowUsd(zecAmount: number, zecPrice: number, ltvBps: number): number {
  return zecAmount * zecPrice * (ltvBps / 10_000);
}

export function fmtUsd(v: number): string {
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function fmtZec(v: number): string {
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 4 })} ZEC`;
}

export function hfColor(hf: number): string {
  if (hf >= 1.7) return "text-status-good";
  if (hf >= 1.5) return "text-status-warn";
  if (hf >= 1.2) return "text-status-serious";
  return "text-status-critical";
}

export function hfLabel(hf: number): string {
  if (!Number.isFinite(hf)) return "No debt";
  if (hf >= 1.7) return "Healthy";
  if (hf >= 1.5) return "Comfortable";
  if (hf >= 1.2) return "Caution";
  return "At risk";
}
