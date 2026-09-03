/**
 * Core domain types shared by the agent, web app, and tooling.
 */

/** The two product modes. */
export type StrategyMode = "SIMPLE_LENDING" | "FULL_STRATEGY";

/** What happens to LP rewards in Full Strategy mode. */
export type RewardPreference = "COMPOUND" | "SEND_TO_ZCASH";

/** LP engine protocols we adapt to on Base (same underlying contracts). */
export type LpProtocol = "MAXFI" | "SNUGGLEFI";

/** Assets the user may borrow against ZEC collateral on Rhea (curated). */
export type BorrowAssetSymbol = "USDC" | "cbBTC" | "WETH";

/** Range-width presets, aligned with Snuggle's documented bands. */
export type RangePreset = "CONSERVATIVE" | "MODERATE" | "AGGRESSIVE" | "CUSTOM";

/** Parameters the LP engine (MaxFi/SnuggleFi) accepts at deposit time. */
export interface LpParams {
  /** Total range width in basis points (e.g. 800 = 8%). */
  rangeWidthBps: number;
  /** Delay before auto-repositioning after going out of range, in hours (0–168). */
  rebalanceDelayHours: number;
  /** Auto-compound matching-token fees back into the position. */
  autoCompoundEnabled: boolean;
}

export interface RangePresetDef {
  preset: Exclude<RangePreset, "CUSTOM">;
  label: string;
  description: string;
  /** Default value applied when the preset is selected. */
  defaultRangeWidthBps: number;
  /** Documented band for this preset (bps). */
  minRangeWidthBps: number;
  maxRangeWidthBps: number;
  defaultRebalanceDelayHours: number;
}

/** Rhea (NEAR) side of a user strategy. */
export interface LendingLeg {
  /** Rhea Multi-Chain Account id backing this user. */
  mcaId: string;
  suppliedZecAtomic: string; // ZEC has 8 decimals; atomic units as string
  borrowedAsset?: BorrowAssetSymbol;
  borrowedAmountAtomic?: string;
  /** Target loan-to-value chosen by the user, in bps (e.g. 4000 = 40%). */
  targetLtvBps?: number;
  healthFactor?: number;
}

/** Base side of a user strategy (Full mode only). */
export interface LpLeg {
  protocol: LpProtocol;
  poolId: string;
  /** On-chain position id inside our PositionVault. */
  vaultPositionId?: number;
  depositToken: BorrowAssetSymbol;
  depositAmountAtomic: string;
  params: LpParams;
  inRange?: boolean;
  pendingRewardsUsd?: number;
}

export type StrategyStatus =
  | "AWAITING_ZEC_DEPOSIT"
  | "SUPPLYING"
  | "ACTIVE_SIMPLE"
  | "BORROWING"
  | "BRIDGING_TO_BASE"
  | "ENTERING_LP"
  | "ACTIVE_FULL"
  | "UNWINDING"
  | "CLOSED"
  | "ERROR";

/** A user strategy as tracked by the agent + web app. */
export interface Strategy {
  id: string;
  owner: {
    /** Address on Base that owns the vault position / receives withdrawals. */
    baseAddress?: string;
    /** Zcash address (transparent t1/t3 fully supported; unified partial). */
    zcashAddress: string;
  };
  mode: StrategyMode;
  status: StrategyStatus;
  rewardPreference: RewardPreference;
  lending: LendingLeg;
  lp?: LpLeg;
  /**
   * Last health-ladder action dispatched for this strategy, keyed
   * "band:action" (e.g. "CRITICAL:EMERGENCY_UNWIND"). Persisted BEFORE the
   * handler runs so overlapping ticks and agent restarts never re-dispatch
   * the same action; rolled back if the handler throws so it retries.
   */
  lastDispatchedAction?: string;
  /**
   * Set alongside status "UNWINDING" when an emergency unwind is dispatched —
   * the id a resumed agent checks before dispatching again (idempotency).
   */
  inflightActionId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Health-factor alerting bands. */
export type HealthBand = "HEALTHY" | "WARNING" | "CRITICAL";

export interface HealthAssessment {
  strategyId: string;
  healthFactor: number;
  band: HealthBand;
  /** Suggested action when not healthy. */
  suggestedAction?: "NOTIFY" | "REDUCE_LEVERAGE" | "EMERGENCY_UNWIND";
}

/** 1-Click (NEAR Intents) swap statuses, verbatim from the API. */
export type OneClickStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED";

/** Curated pool registry entry. */
export interface CuratedPool {
  id: string;
  protocol: LpProtocol;
  /** Underlying DEX the LP engine manages (Snuggle supports several on Base). */
  dex: "AERODROME" | "UNISWAP_V3" | "PANCAKESWAP_V3" | "SUSHISWAP_V3";
  token0: string;
  token1: string;
  feeTierBps: number;
  /** Which curated borrow asset feeds this pool single-sided. */
  entryAsset: BorrowAssetSymbol;
  riskTag: "STABLE" | "BLUE_CHIP" | "VOLATILE";
  description: string;
  /** Underlying DEX pool address on Base (verified against the engine registry). */
  poolAddress?: string;
  /** The engine's bytes32 poolId from approvedPools — what deposits use. */
  enginePoolId?: string;
}
