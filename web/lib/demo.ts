/**
 * DEMO MODE — shown only when no wallet is connected (or NEXT_PUBLIC_FORCE_DEMO=1).
 *
 * Nothing here is a product constant. `DEMO_MARKET` is a SNAPSHOT of the chain
 * reads recorded in docs/VERIFIED-BASE-FACTS.md (Base mainnet, 2026-09-05
 * ~01:00 UTC) so the demo can run where no RPC is reachable; live mode
 * performs the same reads through lib/reads.ts and never consults this file.
 * Every derived number (presets, HF, liquidation price, net yield) is still
 * computed through the shared functions from these inputs.
 *
 * Gate rows are the yield model's own output (lib/demo-gate.json, generated
 * from the services/yield/samples/lp-model-<date>.json that demo-gate.json names in
 * its `source` — the same source as samples/MODEL-NUMBERS.md).
 */
import type { Address } from "viem";
import type { KeeperGrantRead } from "./keeper";
import type { PendingVenueRead } from "./reads";
import type { MarketRead } from "./reads";
import { BASE_TOKENS } from "./chain";
import { grantTokenLimits } from "./execute";
import { DEMO_DEPLOYMENT, UNWIND_SELECTOR } from "./plan";
import { normalizeGate, type GateView } from "./gate";
import DEMO_GATE_RAW from "./demo-gate.json";

export const DEMO_SNAPSHOT_AT = "2026-09-05T01:00:00Z";
export const DEMO_SNAPSHOT_SOURCE = "docs/VERIFIED-BASE-FACTS.md";

/** The model that produced demo-gate.json states these same inputs; the pin test cross-checks them. */
export { DEMO_GATE_RAW };

export const DEMO_MARKET: MarketRead = {
  readAt: DEMO_SNAPSHOT_AT,
  source: "snapshot",
  usdcBorrowAprPct: 4.828,
  reserves: {
    cbBTC: {
      symbol: "cbBTC",
      liquidationThresholdBps: 7800,
      ltvBps: 7300,
      liquidationBonusBps: 750,
      usageAsCollateralEnabled: true,
      borrowingEnabled: true,
      isActive: true,
      isFrozen: false,
      variableBorrowAprPct: 0.673,
      supplyAprPct: 0.012,
      priceUsd: 79630.89,
    },
    WETH: {
      symbol: "WETH",
      liquidationThresholdBps: 8300,
      ltvBps: 8000,
      liquidationBonusBps: 500,
      usageAsCollateralEnabled: true,
      borrowingEnabled: true,
      isActive: true,
      isFrozen: false,
      variableBorrowAprPct: 2.454,
      supplyAprPct: 1.843,
      priceUsd: 2453.45,
    },
    /** Not listed on Aave (config returns zeros) → null, exactly as a live read would decode it. */
    cbZEC: null,
    USDC: {
      symbol: "USDC",
      liquidationThresholdBps: 7800,
      ltvBps: 7500,
      liquidationBonusBps: 500,
      usageAsCollateralEnabled: true,
      borrowingEnabled: true,
      isActive: true,
      isFrozen: false,
      variableBorrowAprPct: 4.828,
      supplyAprPct: 3.921,
      priceUsd: 1.0,
    },
  },
};

/** Illustrative wallet + account for the demo dashboard. Obviously synthetic; not anyone's address. */
export const DEMO_OWNER: Address = "0x1111111111111111111111111111111111111111";
export const DEMO_ACCOUNT: Address = "0x2222222222222222222222222222222222222222";

export interface DemoPosition {
  id: string;
  poolId: string;
  preset: "CONSERVATIVE" | "MODERATE" | "AGGRESSIVE";
  rangeWidthBps: number;
  openedAt: string;
  entryUsdc: number;
  valueUsd: number;
  inRange: boolean;
  /** Gross accrued AERO rewards, USD (fee is derived at render). */
  accruedRewardsUsd: number;
  daysSinceFirstAccrual: number;
}

export interface DemoAccountState {
  collateral: { symbol: "cbBTC" | "WETH"; amount: number }[];
  /** USDC debt on Aave, human units. */
  debtUsdc: number;
  positions: DemoPosition[];
  activity: { at: string; kind: "open" | "claim" | "rung" | "rebalance" | "spot"; text: string }[];
}

/**
 * One cbBTC-backed position opened at the 40% preset. Debt is set to what
 * planLoan() would borrow for 0.5 cbBTC at the snapshot price and 40% LTV, so
 * the dashboard's HF/LTV/liquidation numbers agree with the wizard's. The LP
 * leg is illustrative: at today's borrow rate the gate offers no pool, so a
 * position like this could only have been opened under an earlier verdict.
 */
export const DEMO_ACCOUNT_STATE: DemoAccountState = {
  collateral: [{ symbol: "cbBTC", amount: 0.5 }],
  debtUsdc: 0.5 * DEMO_MARKET.reserves.cbBTC!.priceUsd * 0.4,
  positions: [
    {
      id: "demo-1",
      poolId: "aero-usdc-weth-5",
      preset: "MODERATE",
      rangeWidthBps: 1500,
      openedAt: "2026-08-30T14:03:00Z",
      entryUsdc: 0.5 * DEMO_MARKET.reserves.cbBTC!.priceUsd * 0.4,
      valueUsd: 0.5 * DEMO_MARKET.reserves.cbBTC!.priceUsd * 0.4 * 1.004,
      inRange: true,
      accruedRewardsUsd: 31.6,
      daysSinceFirstAccrual: 6,
    },
  ],
  activity: [
    { at: "2026-09-04T20:11:00Z", kind: "rebalance", text: "Engine rebalanced WETH/USDC position into the current band" },
    { at: "2026-09-02T09:40:00Z", kind: "claim", text: "Claimed AERO rewards to wallet" },
    { at: "2026-08-30T14:03:00Z", kind: "open", text: "Opened: supplied 0.5 cbBTC, borrowed USDC at 40%, deployed to WETH/USDC (Moderate)" },
    { at: "2026-08-30T14:02:00Z", kind: "open", text: "Created OilskinAccount for this wallet" },
  ],
};

/**
 * The keeper permission the demo account has granted — the SAME shape the
 * wizard asks a real user to sign: one target, one selector, allowCallback on,
 * per-day token budgets, and an expiry that is shown rather than assumed.
 * Fixed relative to the snapshot instant so the demo never drifts.
 */
export const DEMO_KEEPER_GRANT: KeeperGrantRead = {
  keeper: DEMO_DEPLOYMENT.keeper!,
  target: DEMO_DEPLOYMENT.router,
  selector: UNWIND_SELECTOR,
  active: true,
  maxValuePerPeriod: 0n,
  valueSpent: 0n,
  period: 86_400,
  // Granted with the demo position on 2026-08-30, 30 days.
  expiry: Math.floor(Date.parse("2026-08-30T14:03:00Z") / 1000) + 30 * 86_400,
  periodStart: Math.floor(Date.parse(DEMO_SNAPSHOT_AT) / 1000),
  allowCallback: true,
  // Sized by the SAME function the wizard uses (execute.ts grantTokenLimits, wave-2 G-HIGH-1):
  // USDC and cbBTC at 2 × the demo debt in their own units, AERO's flat line, and the WETH leg of
  // the demo's WETH/USDC position — the line the panel reported missing ("no WETH budget") from
  // 2026-09-08, when the pool-token check landed, until 2026-09-12 (the e2e dashboard scenario
  // had been red since; nothing here is typed any more).
  tokens: grantTokenLimits(
    0.5 * DEMO_MARKET.reserves.cbBTC!.priceUsd * 0.4,
    { symbol: "cbBTC", address: BASE_TOKENS.cbBTC.address as Address, decimals: BASE_TOKENS.cbBTC.decimals, priceUsd: DEMO_MARKET.reserves.cbBTC!.priceUsd },
    [
      { symbol: "WETH", address: BASE_TOKENS.WETH.address as Address, decimals: BASE_TOKENS.WETH.decimals, priceUsd: DEMO_MARKET.reserves.WETH!.priceUsd },
      { symbol: "USDC", address: BASE_TOKENS.USDC.address as Address, decimals: BASE_TOKENS.USDC.decimals, priceUsd: 1 },
    ]
  ).map((l) => ({
    ...l,
    symbol: Object.values(BASE_TOKENS).find((t) => t.address.toLowerCase() === l.token.toLowerCase())?.symbol ?? "?",
    spent: 0n,
  })),
  readAt: DEMO_SNAPSHOT_AT,
};

/** Demo mode shows no pending venue change — the honest default. */
export const DEMO_PENDING_VENUES: PendingVenueRead[] = [];

/**
 * Gate payload for demo mode: lib/demo-gate.json is GENERATED by
 * scripts/pin-model-numbers.mjs from the yield engineer's model output
 * (the services/yield/samples/lp-model-<date>.json named in demo-gate.json's
 * `source` — the same source as samples/MODEL-NUMBERS.md). test/snapshot.test.ts
 * and test/model-numbers.test.ts pin it to that doc. The demo shows exactly the
 * model's verdict at its recorded borrow rate — every refusal reason and
 * break-even — and offers hold / spot wherever the menu is empty.
 */
export function demoGate(): GateView {
  return normalizeGate(DEMO_GATE_RAW, "demo");
}
