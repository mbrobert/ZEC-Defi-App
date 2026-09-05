/**
 * Yield-service domain types (Base-first v1).
 *
 * Terminology used throughout (defined once, here):
 *
 * • "engine-net APR" — the annualized return an engine position actually
 *   realized, measured from on-chain USD flows: (everything the owner got
 *   out − everything they put in) ÷ principal, annualized over the days the
 *   position was open. The engine's performance fee is ALREADY inside this
 *   number (PerformanceFeeCollected fires before the owner is paid), as is
 *   impermanent loss, rebalance realization, and fee capture at the engine's
 *   real range widths. It is NOT a model.
 *
 * • "user-net APR" — what an Oilskin user keeps on the whole collateral
 *   position: collateral supply APR (Aave) + LTV × (LP net − USDC borrow
 *   APR). Only Oilskin's performance fee (packages/shared FEES) is applied on
 *   top of engine-net; on the MODEL path the engine fee is applied too
 *   because gauge emissions are gross.
 *
 * • "emissions APR(w)" — the MARGINAL AERO emissions rate for a newly
 *   staked in-range position of range width w (sources/gauges.ts).
 *
 * • "gross fee APR" — trailing sampled pool economics (volume × feeTier ÷
 *   TVL × 365). Display/selection context only; nothing derives from it.
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
   * Entry INFLOWS, reconstructed from the deposit transaction's ERC-20
   * Transfer logs (receipts pass): token → atomic amount on the owner→vault
   * edge. Refunds are kept separately (below) so a refund in the OTHER
   * token of a single-sided deposit is never dropped (audit Lens F).
   */
  entryFlows?: Record<Address, string>;
  /** Same-tx vault→owner legs, token → atomic amount (raw; attributed at fold time). */
  entryRefunds?: Record<Address, string>;
  /**
   * Number of PositionCreated events in the deposit tx (any owner). When
   * > 1 the tx's transfers cannot be attributed to one position, so the
   * lifecycle is REFUSED (excluded, counted) rather than guessed
   * (audit wave 2: two Created in one tx each booked the full tx flows).
   */
  entryTxPositions?: number;
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
   * 2026-08-27 and again 2026-09-03: positions(oldId) empties after the
   * rebalance and later events reference the new id). Lifecycle folding
   * follows this chain.
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
  /** token → atomic in (deposit tx, owner→vault). */
  entryFlows: Record<Address, string>;
  /**
   * token → atomic refunded (deposit tx, vault→owner) AFTER attribution:
   * only legs in the position's pool tokens (or a deposited token) count.
   */
  entryRefunds: Record<Address, string>;
  /**
   * True when the deposit tx cannot be attributed to this one position
   * (several PositionCreated in one tx). Valued as excluded, never guessed.
   */
  ambiguousEntry: boolean;
  /** vault→owner legs in tokens unrelated to the position — ignored, counted. */
  unattributedRefundLegs: number;
  /** token → atomic out (withdraw amounts + harvests + staking rewards). */
  exitFlows: Record<Address, string>;
  harvests: number;
  rebalances: number;
}

export type ExclusionReason =
  | "unpriced"
  | "ambiguous_entry"
  | "short_position"
  | "dust_principal"
  | "absurd_outcome";

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
  /** Carried from the lifecycle; excluded from bands. */
  ambiguousEntry: boolean;
}

export interface CohortBand {
  windowDays: number;
  /** Number of closed positions in the band. */
  n: number;
  /** Positions excluded (sum of excludedReasons). */
  excluded: number;
  excludedReasons: Record<ExclusionReason, number>;
  totalPrincipalUsd: number;
  meanDaysOpen: number;
  /** Engine-net APR percentiles, as PERCENT (e.g. 34.2), principal-weighted. */
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  /** Unweighted median, for transparency alongside the weighted p50. */
  medianUnweighted: number;
}

export interface PoolBands {
  /** Curated pool id (packages/shared pools.ts) when matched, else engine poolId. */
  poolId: string;
  enginePoolId: Hex;
  bands: CohortBand[];
  computedAt: string; // ISO
  /** Highest block folded into these bands. */
  asOfBlock: number;
  methodology: "closed-position-flows-v2";
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
 * APRs are MARGINAL for newly staked in-range liquidity at the given TOTAL
 * range width (bps, tick span) — see sources/gauges.ts for the model.
 *
 * `stale` is never stored here: it is computed at serve time from
 * `sampledAt` (audit Lens F: a dead gauge RPC once served a frozen
 * `epochActive:true` as fresh).
 */
export interface EmissionsSample {
  poolId: string;
  pool: Address;
  /** The pool's CL gauge (resolved via the Aerodrome Voter, cached). */
  gauge: Address;
  rewardRateWeiPerSec: string;
  periodFinish: number;
  /** rewardRate > 0 AND periodFinish > now (at sample time). */
  epochActive: boolean;
  /** rewardRate × 1yr × AERO/USD ÷ pool TVL, percent (0 when epoch inactive). */
  wholePoolAprPct: number;
  /**
   * TOTAL width bps (e.g. "4500") → APR percent for a staked position of
   * that width. Null when the pool has no staked liquidity to share with
   * (division by zero is never served as an APR).
   */
  aprByWidthPct: Record<string, number> | null;
  /** Instantaneous staked liquidity (uint128 as decimal string). */
  stakedLiquidity: string;
  /** Rolling stakedLiquidity samples averaged into the APR (max 12). */
  samples: number;
  /**
   * True when this reading fell outside the outlier band around the FIRST
   * reading for the pool (audit round 3). The APRs are still reported for
   * observability, but the gate refuses to offer the pool.
   */
  outlier: boolean;
  sqrtPriceX96: string;
  feePips: number;
  aeroUsd: number;
  sampledAt: string; // ISO
}

/** One Aave v3 reserve as read from PoolDataProvider (strictly decoded). */
export interface AaveReserve {
  symbol: string;
  address: Address;
  /** getReserveData: liquidityRate (ray) → percent. */
  supplyAprPct: number;
  /** getReserveData: variableBorrowRate (ray) → percent. */
  variableBorrowAprPct: number;
  /** getReserveConfigurationData, bps. */
  ltvBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  usageAsCollateralEnabled: boolean;
  borrowingEnabled: boolean;
  isActive: boolean;
  isFrozen: boolean;
}

/**
 * The strategy's funding + collateral rates, from Aave v3 on Base. `stale`
 * is computed at SERVE time from `sampledAt`; it is never part of the
 * stored sample.
 */
export interface AaveRatesSample {
  source: "aave-v3-base";
  dataProvider: Address;
  /** The one asset v1 borrows. */
  borrow: AaveReserve;
  /** cbBTC / WETH (v1 collateral), keyed by symbol. */
  collateral: Record<string, AaveReserve>;
  sampledAt: string;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

export type GateReason =
  | "collateral_disabled"
  | "collateral_not_active"
  | "rates_unavailable"
  | "rates_stale"
  | "emissions_unavailable"
  | "emissions_stale"
  | "no_emissions"
  | "no_staked_liquidity"
  | "staked_liquidity_outlier"
  | "emissions_below_borrow"
  | "no_volatility_input"
  | "net_below_borrow";

export interface GateUserNet {
  ltvBps: number;
  offerable: boolean;
  /** collateral supply + LTV × (lpNet − borrow), percent. */
  userNetPct: number;
}

export interface GateVerdict {
  poolId: string;
  setting: string;
  preset: string;
  collateral: string;
  rangeWidthBps: number;
  /** Exact price half-width fraction the model prices the width at. */
  halfWidth: number;
  qualifies: boolean;
  reason: GateReason | null;
  /** Gross in-range emissions APR at this width, percent (null if unknown). */
  emissionsGrossPct: number | null;
  /** In-range rate after the engine fee (engine pools) and Oilskin's performance fee. */
  emissionsNetPct: number | null;
  /** Net emissions actually realized over a year on the drag-shrunk base (≤ emissionsNet). */
  emissionsRealizedPct: number | null;
  /** Closed-form IL + rebalance drag, percent (≤ 0; null without σ). */
  dragPct: number | null;
  /** emissionsRealized + drag = (1 − e^{−x})(r/x − 1), percent. */
  lpNetPct: number | null;
  borrowAprPct: number | null;
  collateralSupplyAprPct: number | null;
  /** Annualized σ used for drag (null when not calibrated for the pool). */
  sigma: number | null;
  /** Largest σ at which this pool/width would still clear the borrow. */
  breakEvenSigma: number | null;
  /** Multiple of today's net emissions at which this pool/width would clear the borrow. */
  breakEvenEmissionsMultiple: number | null;
  userNet: GateUserNet[];
}

// ---------------------------------------------------------------------------
// API payloads
// ---------------------------------------------------------------------------

export interface PoolPayload {
  id: string;
  name: string;
  venue: string;
  riskTag: string;
  protocol: string;
  pairClass: string;
  /** Extra caveat the UI must show verbatim (from the curated registry). */
  note?: string;
  live: PoolLiveSample | null;
  /** Gauge emissions (AERODROME pools only); null when unavailable/failed. */
  emissions: (EmissionsSample & { stale: boolean }) | null;
  /** Gate verdicts for every setting × enabled collateral. */
  gate: GateVerdict[];
  bands: PoolBands | null;
  /** Set when bands are absent: e.g. "backfill_pending". */
  bandsUnavailableReason?: string;
}

export interface PoolsResponse {
  pools: PoolPayload[];
  rates: (AaveRatesSample & { stale: boolean }) | null;
  generatedAt: string;
  stale: boolean;
  methodologyUrl: string;
}
