/**
 * The yield service's `GET /v1/solana/borrow` as the web consumes it (services/yield/src/solanaBorrow.ts;
 * SOLANA-ARCHITECTURE.md §7): Kamino's ZCASH market as it is and what a borrow would do to it. Normalised
 * defensively — a number is a finite number or null; refusals are strings; the source is said — and a demo
 * snapshot (lib/solana/demo-borrow.json, the evaluator run on the 2026-09-12 capture) stands in offline,
 * labelled as such wherever it is shown.
 */
import demo from "./demo-borrow.json";

export type SolanaBorrowRefusal =
  | "kamino_unavailable"
  | "kamino_stale"
  | "venue_paused"
  | "borrow_disabled"
  | "reserve_not_active"
  | "oracle_stale"
  | "oracle_out_of_band"
  | "entry_hf_below_floor"
  | "venue_ltv_exceeded"
  | "pool_cannot_fund"
  | "borrow_limit_reached"
  | "borrow_cap_24h_reached"
  | "utilization_limit_reached"
  | "deposit_limit_reached";
export type SolanaBindingCap = "venue_max_ltv" | "chosen_hf" | "entry_hf_floor" | "pool_liquidity" | "borrow_limit" | "borrow_cap_24h";
export type SolanaDisclosureId = "forecast_not_advice" | "bridged_zec" | "kamino_parameters_mutable" | "usdc_freezable" | "program_exit_only" | "borrow_rate_moves" | "liquidation_at_chosen_hf";

export interface SolanaBorrowView {
  source: "live" | "demo" | "unavailable";
  configured: boolean;
  sampledAt: string | null;
  slot: number | null;
  stale: boolean;
  entryHf: number | null;
  entryHfFloor: number;
  entryHfFloorSource: string | null;
  ltvCapBps: number | null;
  liquidationThresholdBps: number | null;
  hfAtVenueCap: number | null;
  zecPriceUsd: number | null;
  usdcPriceUsd: number | null;
  oracleAgeS: number | null;
  oracleMaxAgeS: number | null;
  poolAvailableUsdc: number | null;
  poolBorrowedUsdc: number | null;
  poolSupplyUsdc: number | null;
  borrowLimitUsdc: number | null;
  remainingBorrowLimitUsdc: number | null;
  remaining24hBorrowUsdc: number | null;
  maxFundableUsdc: number | null;
  utilizationNowPct: number | null;
  borrowAprNowPct: number | null;
  depositLimitZec: number | null;
  remainingDepositZec: number | null;
  remaining24hWithdrawZec: number | null;
  collateralZec: number | null;
  collateralUsd: number | null;
  borrowAtVenueCapUsdc: number | null;
  borrowAtFloorUsdc: number | null;
  borrowAtChosenHfUsdc: number | null;
  borrowSuggestedUsdc: number | null;
  bindingCap: SolanaBindingCap | null;
  amountUsdc: number | null;
  hfAtEntry: number | null;
  ltvAtEntryBps: number | null;
  liquidationPriceUsd: number | null;
  drawdownToLiquidationPct: number | null;
  utilizationAfterPct: number | null;
  borrowAprAfterPct: number | null;
  poolSharePctAfter: number | null;
  refusals: string[];
  allowed: boolean;
  disclosures: string[];
  generatedAt: string | null;
}

const NUMBER_FIELDS = [
  "entryHf", "ltvCapBps", "liquidationThresholdBps", "hfAtVenueCap", "zecPriceUsd", "usdcPriceUsd", "oracleAgeS", "oracleMaxAgeS", "poolAvailableUsdc", "poolBorrowedUsdc", "poolSupplyUsdc", "borrowLimitUsdc", "remainingBorrowLimitUsdc", "remaining24hBorrowUsdc", "maxFundableUsdc", "utilizationNowPct", "borrowAprNowPct", "depositLimitZec", "remainingDepositZec", "remaining24hWithdrawZec", "collateralZec", "collateralUsd", "borrowAtVenueCapUsdc", "borrowAtFloorUsdc", "borrowAtChosenHfUsdc", "borrowSuggestedUsdc", "amountUsdc", "hfAtEntry", "ltvAtEntryBps", "liquidationPriceUsd", "drawdownToLiquidationPct", "utilizationAfterPct", "borrowAprAfterPct", "poolSharePctAfter", "slot",
] as const;
const BINDINGS: readonly SolanaBindingCap[] = ["venue_max_ltv", "chosen_hf", "entry_hf_floor", "pool_liquidity", "borrow_limit", "borrow_cap_24h"];

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function normalizeSolanaBorrow(raw: unknown, source: SolanaBorrowView["source"]): SolanaBorrowView {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out = {
    source,
    configured: r.configured === true,
    sampledAt: str(r.sampledAt),
    stale: r.stale !== false,
    entryHfFloor: num(r.entryHfFloor) ?? 0,
    entryHfFloorSource: str(r.entryHfFloorSource),
    bindingCap: BINDINGS.includes(r.bindingCap as SolanaBindingCap) ? (r.bindingCap as SolanaBindingCap) : null,
    refusals: strs(r.refusals),
    allowed: r.allowed === true && strs(r.refusals).length === 0,
    disclosures: strs(r.disclosures),
    generatedAt: str(r.generatedAt),
  } as Record<string, unknown>;
  for (const f of NUMBER_FIELDS) out[f] = num(r[f]);
  return out as unknown as SolanaBorrowView;
}

export interface SolanaBorrowQuery {
  collateralZec?: number | null;
  amountUsdc?: number | null;
  entryHf?: number | null;
}
export function solanaBorrowPath(q: SolanaBorrowQuery): string {
  const p = new URLSearchParams();
  if (q.collateralZec && q.collateralZec > 0) p.set("collateral", String(q.collateralZec));
  if (q.amountUsdc && q.amountUsdc > 0) p.set("amount", String(q.amountUsdc));
  if (q.entryHf && Number.isFinite(q.entryHf) && q.entryHf >= 1) p.set("entryHf", String(q.entryHf));
  const s = p.toString();
  return `/v1/solana/borrow${s ? `?${s}` : ""}`;
}
export async function fetchSolanaBorrow(baseUrl: string, q: SolanaBorrowQuery, signal?: AbortSignal): Promise<SolanaBorrowView> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}${solanaBorrowPath(q)}`, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`solana borrow view: http ${res.status}`);
  return normalizeSolanaBorrow(await res.json(), "live");
}
/** The offline snapshot: the yield evaluator on the 2026-09-12 mainnet capture (slot 446,506,191). */
export function demoSolanaBorrow(): SolanaBorrowView {
  return normalizeSolanaBorrow(demo, "demo");
}
export function unavailableSolanaBorrow(reason: string): SolanaBorrowView {
  return normalizeSolanaBorrow({ configured: false, stale: true, refusals: [reason], allowed: false, disclosures: [], entryHfFloor: 0 }, "unavailable");
}

/** Plain words for each refusal — the reader has never used DeFi. */
export function solanaRefusalPlain(r: string): string {
  switch (r as SolanaBorrowRefusal) {
    case "kamino_unavailable":
      return "Kamino's market could not be read right now, so nothing can be offered.";
    case "kamino_stale":
      return "The last read of Kamino's market is too old to act on. Try again in a minute.";
    case "venue_paused":
      return "Kamino has put this market in emergency mode: no new borrowing.";
    case "borrow_disabled":
      return "Kamino has switched borrowing off on this market.";
    case "reserve_not_active":
      return "One of Kamino's reserves for this market is not active.";
    case "oracle_stale":
      return "The ZEC price Kamino uses is older than Kamino allows right now. Kamino itself would refuse this.";
    case "oracle_out_of_band":
      return "The oracle price is outside the range Kamino accepts for this token. Kamino itself would refuse this.";
    case "entry_hf_below_floor":
      return "This borrow starts under the entry health-factor floor the program enforces.";
    case "venue_ltv_exceeded":
      return "This borrow is more than Kamino's own loan-to-value cap allows against your ZEC.";
    case "pool_cannot_fund":
      return "The pool does not have this much USDC to lend right now.";
    case "borrow_limit_reached":
      return "This borrow would take the pool past Kamino's borrow limit for USDC.";
    case "borrow_cap_24h_reached":
      return "This borrow is more than Kamino lets the pool lend in the current 24-hour window.";
    case "utilization_limit_reached":
      return "This borrow would take the pool past the utilisation at which Kamino blocks borrowing.";
    case "deposit_limit_reached":
      return "This deposit would take the ZEC reserve past Kamino's deposit limit.";
    default:
      return `Refused: ${r}.`;
  }
}
export function solanaBindingPlain(b: SolanaBindingCap | null, floor: number): string {
  switch (b) {
    case "venue_max_ltv":
      return "Kamino's own 40 % loan-to-value cap";
    case "chosen_hf":
      return "the health factor you chose";
    case "entry_hf_floor":
      return `the entry floor of ${floor.toFixed(2)}`;
    case "pool_liquidity":
      return "what the pool has to lend right now";
    case "borrow_limit":
      return "Kamino's borrow limit for the pool";
    case "borrow_cap_24h":
      return "Kamino's 24-hour borrow cap for the pool";
    default:
      return "no limit";
  }
}
