/**
 * Yield-service domain types.
 *
 * Terminology used throughout (defined once, here):
 *
 * • "engine-net APR" — the annualized return an engine position actually
 *   realized, measured from on-chain USD flows: (everything the owner got
 *   out − everything they put in) ÷ principal, annualized over the days the
 *   position was open. The engine's 15% performance fee is ALREADY inside
 *   this number (PerformanceFeeCollected fires before the owner is paid),
 *   as is impermanent loss, rebalance realization, and fee capture at the
 *   engine's real range widths. It is NOT a model.
 *
 * • "user-net APY" — what an Oilskin user keeps: supply APY on the whole
 *   position plus LTV × (engine-net × 0.90 − borrow APR). Only Oilskin's
 *   10% platform fee is applied on top of engine-net (the engine's cut is
 *   already netted); the fee constant lives in @zyo/shared PLATFORM_FEE.
 *
 * • "gross fee APR" — trailing sampled pool economics (volume × feeTier ÷
 *   TVL × 365). Display/selection context only; bands never derive from it.
 */

export type Hex = `0x${string}`;
export type Address = Hex;

// ---------------------------------------------------------------------------
// Engine event stream (decoded from verified topics — see engine/events.ts)
// ---------------------------------------------------------------------------

export type EngineEventKind =
  | "PositionCreated"
  | "PositionWithdrawn"
  | "FeesHarvested"
  | "StakingRewardsClaimed"
  | "PerformanceFeeCollected"
  | "SnuggleRebalanced";

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  transactionHash: Hex;
  logIndex: number;
}

export interface EngineEventBase {
  kind: EngineEventKind;
  tokenId: string; // uint256 as decimal string
  blockNumber: number;
  /** Unix seconds; filled by the indexer's timestamp pass. */
  timestamp?: number;
  transactionHash: Hex;
  logIndex: number;
}

export interface PositionCreatedEvent extends EngineEventBase {
  kind: "PositionCreated";
  owner: Address;
  poolId: Hex; // bytes32 engine registry key
  tickLower: number;
  tickUpper: number;
  liquidity: string; // uint128 as decimal string
  staked: boolean;
  /**
   * Entry principal, reconstructed from the deposit transaction's ERC-20
   * Transfer logs (receipts pass). token → atomic amount (net of same-tx
   * refunds back to the depositor).
   */
  entryFlows?: Record<Address, string>;
}

export interface PositionWithdrawnEvent extends EngineEventBase {
  kind: "PositionWithdrawn";
  owner: Address;
  amount0: string;
  amount1: string;
}

export interface FeesHarvestedEvent extends EngineEventBase {
  kind: "FeesHarvested";
  recipient: Address;
  amount0: string;
  amount1: string;
}

export interface StakingRewardsClaimedEvent extends EngineEventBase {
  kind: "StakingRewardsClaimed";
  recipient: Address;
  rewardToken: Address;
  amount: string;
}

export interface PerformanceFeeCollectedEvent extends EngineEventBase {
  kind: "PerformanceFeeCollected";
  token: Address;
  amountA: string;
  amountB: string;
  amountC: string;
}

export interface SnuggleRebalancedEvent extends EngineEventBase {
  kind: "SnuggleRebalanced";
  /**
   * Rebalancing RE-KEYS the underlying position: `tokenId` is the OLD id,
   * `newTokenId` continues the same economic position (verified live
   * 2026-08-27: positions(oldId) empties after the rebalance and later
   * events reference the new id). Lifecycle folding follows this chain.
   */
  newTokenId: string;
  pool: Address;
  tickLower: number;
  tickUpper: number;
  amount0: string;
  amount1: string;
  flag: boolean;
  count: number;
}

export type EngineEvent =
  | PositionCreatedEvent
  | PositionWithdrawnEvent
  | FeesHarvestedEvent
  | StakingRewardsClaimedEvent
  | PerformanceFeeCollectedEvent
  | SnuggleRebalancedEvent;

// ---------------------------------------------------------------------------
// Lifecycles & cohorts
// ---------------------------------------------------------------------------

/** One engine position folded from its event stream. */
export interface PositionLifecycle {
  tokenId: string;
  poolId: Hex;
  owner: Address;
  openedBlock: number;
  openedAt?: number;
  closedBlock?: number;
  closedAt?: number;
  /** token → atomic in (deposit tx). */
  entryFlows: Record<Address, string>;
  /** token → atomic out (withdraw amounts + harvests + staking rewards). */
  exitFlows: Record<Address, string>;
  /** FeesHarvested events whose recipient WAS the owner (owner exit flows). */
  harvests: number;
  /**
   * FeesHarvested events paid to a non-owner recipient (auto-compound legs):
   * value re-entered the position instead of leaving — never owner flows.
   */
  internalHarvests: number;
  rebalances: number;
  /**
   * True when the pool was missing from the registry map, so non-zero exit
   * amounts could not be attributed to tokens. Valuation treats this as
   * unpriced (excluded + counted) — never a fabricated −100% loss.
   */
  unattributed?: boolean;
}

/** A lifecycle valued in USD, ready for cohort math. */
export interface ValuedLifecycle {
  tokenId: string;
  poolId: Hex;
  closedAt: number;
  daysOpen: number;
  principalUsd: number;
  outUsd: number;
  /** (outUsd − principalUsd)/principalUsd × 365/daysOpen, as a fraction. */
  netAprFraction: number;
  /** True when some flow could not be priced; excluded from bands. */
  unpriced: boolean;
}

/** Minimum closed positions a window needs before percentiles are served. */
export const MIN_COHORT_N = 5;

export interface CohortBand {
  windowDays: number;
  /** Number of closed positions in the band (always present, even when tiny). */
  n: number;
  /** Positions excluded (unpriced flows or open < minDays). */
  excluded: number;
  totalPrincipalUsd: number;
  meanDaysOpen: number;
  /**
   * Engine-net APR percentiles, as PERCENT (e.g. 34.2), principal-weighted.
   * null when n < MIN_COHORT_N — one whale would BE every percentile, which
   * misleads worse than admitting the sample is too small.
   */
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  /** Unweighted median, for transparency alongside the weighted p50. */
  medianUnweighted: number | null;
  /** Set when percentiles are withheld. */
  reason?: "insufficient_sample";
}

export interface PoolBands {
  /** Curated pool id (packages/shared pools.ts) when matched, else engine poolId. */
  poolId: string;
  enginePoolId: Hex;
  bands: CohortBand[];
  computedAt: string; // ISO
  /** Highest block folded into these bands. */
  asOfBlock: number;
  methodology: "closed-position-flows-v1";
}

// ---------------------------------------------------------------------------
// Live sampling
// ---------------------------------------------------------------------------

export interface PoolLiveSample {
  poolId: string;
  poolAddress: Address;
  /** GeckoTerminal reserve_in_usd. */
  tvlUsd: number;
  volume24hUsd: number;
  feeTierBps: number;
  /** volume × fee ÷ TVL × 365, percent. */
  grossFeeAprPct: number;
  /** Token USD prices from the same sample (feeds emissions math). */
  baseTokenAddress?: Address;
  quoteTokenAddress?: Address;
  baseTokenPriceUsd?: number;
  quoteTokenPriceUsd?: number;
  sampledAt: string; // ISO
  source: "geckoterminal" | "onchain";
}

/**
 * Aerodrome gauge emissions for one pool (AERO paid to staked CL liquidity).
 * APRs are MARGINAL for newly staked in-range liquidity at the given range
 * width — see sources/gauges.ts for the model and its precision notes.
 */
export interface EmissionsSample {
  /** rewardRate × 1yr × AERO/USD ÷ pool TVL, percent. */
  wholePoolAprPct: number;
  /** width (fraction, e.g. "0.04") → APR percent for a staked position of that width. */
  aprByWidthPct: Record<string, number>;
  /** periodFinish > now — false means the epoch lapsed and APRs are 0. */
  epochActive: boolean;
  sampledAt: string; // ISO
  /** The pool's CL gauge (resolved via the Aerodrome Voter, cached). */
  gauge: Address;
  /** Rolling stakedLiquidity samples averaged into the APR (max 12). */
  samples: number;
}

export interface RatesSample {
  /** USDC borrow APR — the strategy's funding cost. */
  borrowAprPct: number;
  /** USDC supply APR (context only). */
  supplyAprPct: number;
  /** ZEC supply APR — the collateral side's own earnings. */
  zecSupplyAprPct: number | null;
  asset: string;
  market: string;
  sampledAt: string;
  source: "rhea-burrow";
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface PoolPayload {
  id: string;
  name: string;
  venue: string;
  riskTag: string;
  live: PoolLiveSample | null;
  /** Gauge emissions (AERODROME pools only); null when unavailable/failed. */
  emissions: EmissionsSample | null;
  bands: PoolBands | null;
  /** Set when bands are absent: e.g. "backfill_pending". */
  bandsUnavailableReason?: string;
}

export interface PoolsResponse {
  pools: PoolPayload[];
  rates: RatesSample | null;
  generatedAt: string;
  stale: boolean;
  methodologyUrl: string;
}
