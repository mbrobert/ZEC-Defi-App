/**
 * Core domain types shared by the keeper, web app, yield service and tooling.
 * Base-only: every position is owned by the user's wallet through their
 * OilskinAccount; there is no bridge leg and no operator custody.
 */
import type { Address } from "./evm.js";
import type { TokenSymbol } from "./base.js";
import type { CollateralSymbol, CollateralVenueId } from "./collateral.js";
import type { HfRungId } from "./health.js";
import type { LpParams } from "./width.js";

export type { LpParams, RangePreset, RangePresetDef, PairClass, ChainLpParams } from "./width.js";

/** The two product modes. */
export type StrategyMode = "SIMPLE_LENDING" | "FULL_STRATEGY";

/** What happens to LP rewards in Full Strategy mode. */
export type RewardPreference = "COMPOUND" | "CLAIM_TO_WALLET";

/** LP engine protocols. DIRECT = our own Aerodrome position, no engine fee. */
export type LpProtocol = "MAXFI" | "SNUGGLEFI" | "DIRECT";

/**
 * Assets a pool can be entered with single-sided. v1 BORROWS only USDC
 * (see BORROW_ASSET); cbBTC/WETH entries are reached by swapping the
 * borrowed USDC inside the router transaction.
 */
export type LpEntryAsset = "USDC" | "cbBTC" | "WETH";
/** @deprecated pre-pivot name for LpEntryAsset; kept so imports compile while consumers migrate. */
export type BorrowAssetSymbol = LpEntryAsset;

/** Aave/Morpho side of a user strategy. */
export interface LendingLeg {
  venue: CollateralVenueId;
  collateral: CollateralSymbol;
  /** Atomic units (token decimals) as a decimal string — never a JS number. */
  collateralAmountAtomic: string;
  borrowedAsset?: TokenSymbol;
  borrowedAmountAtomic?: string;
  /** LTV chosen by the user at entry, in bps. Must be ≤ maxOfferedLtvBps(LT) at that time. */
  targetLtvBps?: number;
  /** Last health factor read from the venue. */
  healthFactor?: number;
}

/** LP side of a user strategy (Full mode only). */
export interface LpLeg {
  protocol: LpProtocol;
  poolId: string;
  /** Engine / venue position id, minted to the user's OilskinAccount. */
  positionId?: string;
  entryAsset: LpEntryAsset;
  entryAmountAtomic: string;
  params: LpParams;
  inRange?: boolean;
  pendingRewardsUsd?: number;
}

export type StrategyStatus =
  | "AWAITING_SIGNATURE"
  | "SUPPLYING"
  | "ACTIVE_SIMPLE"
  | "BORROWING"
  | "ENTERING_LP"
  | "ACTIVE_FULL"
  | "UNWINDING"
  | "CLOSED"
  | "ERROR";

/** A user strategy as tracked by the keeper + web app (a CACHE of chain state, never the authority). */
export interface Strategy {
  id: string;
  owner: {
    /** The connected wallet. Immutable owner of the OilskinAccount. */
    wallet: Address;
    /** The user's OilskinAccount clone (CREATE2-predictable; undefined until created). */
    account?: Address;
  };
  mode: StrategyMode;
  status: StrategyStatus;
  rewardPreference: RewardPreference;
  lending: LendingLeg;
  lp?: LpLeg;
  createdAt: string;
  updatedAt: string;
}

/** Keeper's view of one account's health, mapped through the ladder. */
export interface HealthAssessment {
  account: Address;
  healthFactor: number;
  /** null = healthy (no rung fired). */
  rung: HfRungId | null;
  suggestedAction?: "notify" | "repay" | "derisk" | "emergency-unwind";
  /** Liquidation threshold (bps) the assessment used — read from chain. */
  liquidationThresholdBps: number;
}

/** Curated pool registry entry. */
export interface CuratedPool {
  id: string;
  protocol: LpProtocol;
  /** Underlying DEX the LP engine manages (Snuggle supports several on Base). */
  dex: "AERODROME" | "UNISWAP_V3" | "PANCAKESWAP_V3" | "SUSHISWAP_V3";
  token0: string;
  token1: string;
  /**
   * Fee tier in bps. Aerodrome Slipstream fees are DYNAMIC — this is a sample;
   * read pool.fee() live where possible.
   */
  feeTierBps: number;
  /** Which entry asset feeds this pool single-sided. */
  entryAsset: LpEntryAsset;
  riskTag: "STABLE" | "BLUE_CHIP" | "VOLATILE";
  /** Drives which RANGE_PRESETS width column applies. */
  pairClass: "UNCORRELATED" | "CORRELATED";
  description: string;
  /** Underlying DEX pool address on Base (verified against the engine registry). */
  poolAddress?: string;
  /** The engine's bytes32 poolId from approvedPools — what engine deposits use. Absent for DIRECT pools. */
  enginePoolId?: string;
  /** Aerodrome gauge (DIRECT pools). rewardRate()/periodFinish() read live by the yield gate. */
  gauge?: string;
  /** Slipstream tick spacing (DIRECT pools). */
  tickSpacing?: number;
  /** Extra caveat the UI must show verbatim. */
  note?: string;
}
