/**
 * Yield-service domain types (Base module v1).
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
  /**
   * rewardRate × 1yr × AERO/USD ÷ pool TVL, percent (0 when epoch inactive).
   * NULL when there is nothing behind it: no staked liquidity (an APR nobody
   * can earn) or a stakedLiquidity anchor that is not yet corroborated.
   */
  wholePoolAprPct: number | null;
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
   * True once `samples >= MIN_STAKED_SAMPLES` independent readings agree on
   * an anchor. Until then there is NOTHING to test a reading against, so no
   * APR is published and the gate refuses with `insufficient_samples`.
   * Wave-1 lens D HIGH-2: the old filter compared every reading against the
   * FIRST reading ever taken, which is by construction never an outlier —
   * one tiny first `stakedLiquidity` served 7,599.64 % against a true 3.80 %
   * with `outlier:false`, and pinned the anchor there for the life of the
   * process. An anchor is a claim about the pool and needs corroboration.
   */
  corroborated: boolean;
  /**
   * True when this reading fell outside the outlier band around the MEDIAN
   * of the corroborated history. The APRs are withheld and the gate refuses
   * to offer the pool. A run of consecutive outliers means the anchor itself
   * is wrong: the history is dropped and re-corroborated from scratch.
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
  /**
   * PoolDataProvider.getPaused(asset) — a SEPARATE call: the 10-word
   * configuration tuple carries isActive/isFrozen but NOT isPaused, so a
   * guardian-paused reserve used to decode as active and unfrozen and the
   * gate kept offering it while every supply/borrow reverted on chain
   * (wave-1 lens D LOW-1).
   */
  isPaused: boolean;
  /** getReserveConfigurationData word 0: the asset's decimals. */
  decimals: number;
  /**
   * getReserveData word 2: totalAToken — everything supplied to the reserve,
   * lent out or idle, in base units (decimal string; a bigint in JSON is not
   * portable). With `totalVariableDebtUnits` this is what the forecast's
   * liquidity hard-refusal and post-borrow rate are computed from
   * (2026-09-12, BUILD-PLAN A3): available ≈ totalAToken − totalVariableDebt.
   * The strategy's own denominator is the virtual balance + debt, which
   * differs from totalAToken by the treasury accrual (< 0.001 % on
   * 2026-09-12, block 51,227,701: 182,806,571.52 vs 182,807,909.55 USDC).
   */
  totalATokenUnits: string;
  /** getReserveData word 4: totalVariableDebt, base units (decimal string). */
  totalVariableDebtUnits: string;
}

/**
 * The borrow reserve's interest-rate curve, read live from the Pool's
 * strategy (`PoolDataProvider.getInterestRateStrategyAddress(USDC)` →
 * `DefaultReserveInterestRateStrategyV2.getInterestRateDataBps(USDC)`), so the
 * forecast can price the borrow rate AFTER a borrow of a given size instead
 * of quoting today's. Aave v3.2+ two-slope curve, all in bps:
 *   U ≤ Uopt: base + slope1 × U / Uopt
 *   U > Uopt: base + slope1 + slope2 × (U − Uopt) / (1 − Uopt)
 * Read 2026-09-12 at block 51,227,701 (docs/VERIFIED-BASE-FACTS.md
 * Addendum 13): Uopt 9000, base 0, slope1 470, slope2 1000 — which reproduces
 * the live 4.5146 % from the reserve's 86.45 % utilisation exactly.
 */
export interface AaveBorrowCurve {
  strategy: Address;
  optimalUsageBps: number;
  baseVariableBorrowRateBps: number;
  variableRateSlope1Bps: number;
  variableRateSlope2Bps: number;
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
  /** The borrow reserve's rate curve (see AaveBorrowCurve). Read with every sample; never defaulted. */
  borrowCurve: AaveBorrowCurve;
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
  | "collateral_paused"
  | "borrow_paused"
  | "no_emissions"
  | "no_staked_liquidity"
  | "insufficient_samples"
  | "staked_liquidity_outlier"
  | "emissions_implausible"
  | "emissions_below_borrow"
  | "no_volatility_input"
  | "mc_calibration_unavailable"
  | "mc_calibration_stale"
  | "net_below_borrow"
  | "within_model_uncertainty"
  | "net_out_of_bounds";

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
  /**
   * The SAME LP slice priced by the Monte-Carlo-calibrated form
   * (src/mc-calibration.ts): `net × inRangeEmissionsFactor + mcDragPct`,
   * minus a correction for any live pool fee above the calibrated one.
   * The closed form ignores time out of range and is therefore optimistic —
   * 7 to 32 points at the gate boundary (wave-1 lens D HIGH-1). `lpNetPct`
   * stays the published headline; the OFFER decision requires BOTH numbers
   * to clear the borrow. Null when no calibration covers the cell.
   */
  mcLpNetPct: number | null;
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
// Forecast (BUILD-PLAN-2026-09-12 D4/D5, step A3) — the same model as the
// gate, served as information at the entry HF the user chose. Nothing here
// is a profitability refusal; the only refusals are the safety ones in
// ForecastRefusal. The GateVerdict above is unchanged and /v1/gate still
// serves it (its tests pin the refusal order); the site no longer blocks on it.
// ---------------------------------------------------------------------------

/** Safety-only hard refusals (BUILD-PLAN §2). A cell with any of these may not be opened. */
export type ForecastRefusal =
  | "entry_hf_below_floor"
  | "collateral_disabled"
  | "rates_unavailable"
  | "rates_stale"
  | "collateral_not_active"
  | "collateral_paused"
  | "borrow_paused"
  | "venue_ltv_exceeded"
  | "pool_cannot_fund";

/** Why the LP slice could not be priced — shown, never a refusal. */
export type ForecastUnpricedReason =
  | "rates_unavailable"
  | "rates_stale"
  | "emissions_unavailable"
  | "emissions_stale"
  | "no_emissions"
  | "staked_liquidity_outlier"
  | "insufficient_samples"
  | "no_staked_liquidity"
  | "emissions_implausible"
  | "no_volatility_input"
  | "net_out_of_bounds";

/** Which limit decides the borrow at the chosen entry HF. */
export type ForecastBindingCap = "entry_hf_floor" | "venue_max_ltv" | "pool_liquidity" | "chosen_hf";

/** Ids of the disclosures the site must show with this cell; the words live in web/lib (copy rules apply there). */
export type ForecastDisclosureId =
  | "forecast_not_advice"
  | "model_uncertainty"
  | "no_forecast"
  | "emissions_dilutable"
  | "borrow_rate_moves"
  | "liquidation_at_chosen_hf"
  | "impermanent_loss";

export interface ForecastCell {
  poolId: string;
  setting: string;
  preset: string;
  collateral: string;
  rangeWidthBps: number;
  halfWidth: number;

  // --- the position at the chosen entry HF (the identity debt = collateral × LT ÷ HF) ---
  entryHf: number;
  entryHfFloor: number;
  liquidationThresholdBps: number | null;
  /** floor(LT / HF) in bps; null without a live LT. */
  ltvAtEntryBps: number | null;
  /** The venue's own maximum LTV for this collateral (Aave `ltv`), bps; null without rates. */
  venueMaxLtvBps: number | null;
  bindingCap: ForecastBindingCap | null;
  /** 100 × (1 − 1 / HF): the collateral price fall that reaches HF 1. */
  drawdownToLiquidationPct: number;
  /** USD price of the collateral behind `liquidationPriceUsd`, and where it came from. */
  collateralPriceUsd: number | null;
  liquidationPriceUsd: number | null;
  depositUsd: number | null;
  borrowUsd: number | null;

  // --- the borrow side ---
  borrowAprNowPct: number | null;
  /** The venue curve re-priced with this borrow added (Aave strategy V2); null without the curve or a deposit size. */
  borrowAprAfterPct: number | null;
  /** Which borrow rate `userNetPct` uses: "after" when a deposit size was given, else "now". */
  userNetBorrowBasis: "after" | "now" | null;
  /** USDC the pool can lend right now (totalAToken − totalVariableDebt), whole units. */
  poolAvailableUsd: number | null;
  collateralSupplyAprPct: number | null;

  // --- the LP slice, priced whenever the inputs exist (the gate stops earlier) ---
  lpPriced: boolean;
  lpUnpricedReason: ForecastUnpricedReason | null;
  emissionsGrossPct: number | null;
  emissionsNetPct: number | null;
  emissionsRealizedPct: number | null;
  dragPct: number | null;
  lpNetPct: number | null;
  mcLpNetPct: number | null;
  mcUnavailableReason: "mc_calibration_unavailable" | "mc_calibration_stale" | null;
  /** lpNetPct − mcLpNetPct, points: how optimistic the closed form is on this cell. */
  modelGapPts: number | null;
  sigma: number | null;
  breakEvenSigma: number | null;
  breakEvenEmissionsMultiple: number | null;
  /** supply + LTV × (lpNet − borrow) at the chosen LTV, closed form / Monte-Carlo form. */
  userNetPct: number | null;
  mcUserNetPct: number | null;
  /** Does the LP slice beat the borrow it is funded with? Information, not a gate. */
  clearsBorrow: { closedForm: boolean | null; monteCarlo: boolean | null; both: boolean | null };

  // --- what the site must do with it ---
  refusals: ForecastRefusal[];
  /** True when `refusals` is empty: the position may be opened after the acknowledgment. */
  allowed: boolean;
  disclosures: ForecastDisclosureId[];
}

export interface ForecastResponse {
  entryHf: number;
  /** The floor every cell's `entry_hf_below_floor` was judged against: the registry's when read, else shared's. */
  entryHfFloor: number;
  /**
   * "registry" = `CollateralRegistry.entryHfFloorWad` read live and fresh; "registry_stale" = the last read
   * is past `staleAfterMs` and the served floor is the stricter of it and the shared constant; "shared" = the
   * deploy-default constant (no registry configured, or no read yet).
   */
  entryHfFloorSource: "registry" | "registry_stale" | "shared";
  /** When the registry was last read successfully, or null. Present even when the served floor fell back to shared's, so a stale read is visible. */
  entryHfFloorReadAt: string | null;
  depositUsd: number | null;
  borrowAprPct: number | null;
  ratesSampledAt: string | null;
  emissionsSampledAt: string | null;
  volatilityAsOf: string;
  engineFeeBps: number;
  stale: boolean;
  mcCalibrationGeneratedAt: string | null;
  settings: { id: string; preset: string; rebalanceDelayHours: number }[];
  cells: ForecastCell[];
  generatedAt: string;
  methodologyUrl: string;
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
