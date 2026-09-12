import { toFunctionSelector, type AbiEvent } from "viem";

/**
 * OilskinAccount / OilskinAccountFactory ABI fragments the keeper uses.
 *
 * Transcribed from contracts/src/account/*.sol and interfaces/IOilskinAccount.sol.
 * `scripts/verify-abi.mjs` diffs every selector, event topic and argument
 * layout below against contracts/out/*.json and fails the suite on drift
 * (AUDIT-FINDINGS Part 4: "the ABI seam broke twice").
 */

/**
 * `Call` — the 4-tuple the account executes. `callback` is the PERIPHERAL
 * OPT-IN (contracts fix round 1, D3): false = the target gets no rights over
 * the account. On the KEEPER path the flag on the call is ignored — the
 * account reads `Permission.allowCallback` from the grant — so the keeper
 * sends `callback: false` and the grant must carry `allowCallback: true`.
 */
export const callStruct = {
  type: "tuple",
  components: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "callback", type: "bool" },
  ],
} as const;

export const accountCreatedEvent = {
  type: "event",
  name: "AccountCreated",
  inputs: [
    { name: "owner", type: "address", indexed: true },
    { name: "account", type: "address", indexed: true },
  ],
} as const satisfies AbiEvent;

export const oilskinAccountFactoryAbi = [
  accountCreatedEvent,
  {
    type: "function",
    name: "accountOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "isDeployed",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export const oilskinAccountAbi = [
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "execAsKeeper",
    stateMutability: "nonpayable",
    inputs: [{ name: "calls", ...callStruct, type: "tuple[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    type: "function",
    name: "grantEpoch",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "grantOf",
    stateMutability: "view",
    inputs: [
      { name: "keeper", type: "address" },
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
    ],
    outputs: [
      { name: "active", type: "bool" },
      { name: "maxValuePerPeriod", type: "uint256" },
      { name: "valueSpent", type: "uint256" },
      { name: "period", type: "uint40" },
      { name: "expiry", type: "uint40" },
      { name: "periodStart", type: "uint40" },
      { name: "allowCallback", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "tokenBudgetOf",
    stateMutability: "view",
    inputs: [
      { name: "keeper", type: "address" },
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
      { name: "token", type: "address" },
    ],
    outputs: [
      { name: "amountPerPeriod", type: "uint256" },
      { name: "spent", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "grantTokens",
    stateMutability: "view",
    inputs: [
      { name: "keeper", type: "address" },
      { name: "target", type: "address" },
      { name: "selector", type: "bytes4" },
    ],
    outputs: [{ name: "tokens", type: "address[]" }],
  },
  // Errors the keeper classifies (all declared on OilskinAccount).
  { type: "error", name: "NotGranted", inputs: [{ name: "keeper", type: "address" }, { name: "target", type: "address" }, { name: "selector", type: "bytes4" }] },
  { type: "error", name: "ValueBudgetExceeded", inputs: [{ name: "wanted", type: "uint256" }, { name: "remaining", type: "uint256" }] },
  { type: "error", name: "TokenNotBudgeted", inputs: [{ name: "token", type: "address" }] },
  { type: "error", name: "TokenBudgetExceeded", inputs: [{ name: "token", type: "address" }, { name: "wanted", type: "uint256" }, { name: "remaining", type: "uint256" }] },
  { type: "error", name: "Reentrancy", inputs: [] },
  // Raised INSIDE the router's frame when the grant's `allowCallback` is false:
  // a mis-issued grant, not a market condition. Classified separately.
  { type: "error", name: "NotActivePeripheral", inputs: [] },
  { type: "error", name: "CallbackNotPermitted", inputs: [] },
  { type: "error", name: "UnbudgetableSelector", inputs: [{ name: "target", type: "address" }, { name: "selector", type: "bytes4" }] },
] as const;

/** Selectors the keeper hard-codes (grant checks). Pinned by verify-abi. */
export const KEEPER_SELECTORS = {
  "OilskinAccount.execAsKeeper": toFunctionSelector("execAsKeeper((address,uint256,bytes,bool)[])"),
} as const;

// ---------------------------------------------------------------------------
// StrategyRouter / SnuggleLpVenue — the two targets the keeper's grants name.
// Transcribed from contracts/out (StrategyRouter.json, SnuggleLpVenue.json).
// ---------------------------------------------------------------------------

export const priceBandStruct = {
  type: "tuple",
  components: [
    { name: "minSqrtPriceX96", type: "uint160" },
    { name: "maxSqrtPriceX96", type: "uint160" },
  ],
} as const;

/**
 * The swap quote the router hands the adapter for the non-USDC LP leg.
 * The adapter enforces `amountIn × quotedOut / quotedIn × (10000 − maxSlippageBps) / 10000`
 * on the amount ACTUALLY swapped, so the quote is a RATE, not an absolute floor —
 * a leg that comes back larger or smaller than quoted is protected in proportion.
 * `swapMinOut: 1` is not expressible any more, and that is the point.
 */
export const swapQuoteStruct = {
  type: "tuple",
  components: [
    { name: "quotedIn", type: "uint256" },
    { name: "quotedOut", type: "uint256" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "routeData", type: "bytes" },
  ],
} as const;

export const strategyRouterAbi = [
  {
    type: "function",
    name: "unwind",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "collateralAsset", type: "address" },
          { name: "positionIds", type: "uint256[]" },
          { name: "band", ...priceBandStruct },
          { name: "swap", ...swapQuoteStruct },
          { name: "repayAmount", type: "uint256" },
          { name: "withdrawAmount", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "usdcFromLp", type: "uint256" },
      { name: "repaid", type: "uint256" },
      { name: "withdrawn", type: "uint256" },
      { name: "healthFactor", type: "uint256" },
    ],
  },
  { type: "function", name: "USDC", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "LP_VENUE", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "SWAP", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  // The direct Slipstream venue over the cbZEC/USDC pool and its pool-direct adapter (2026-09-11);
  // zero on a deployment without them. The keeper reads BOTH venues' `positionsOf`; the router
  // resolves an unwind's ids to the venue that says the account owns them (`ownedPool`).
  { type: "function", name: "LP_VENUE_DIRECT", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "SWAP_DIRECT", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "REGISTRY", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  /**
   * What an unwind actually did. `confirm` reads it from the receipt: a repay
   * rung whose transaction succeeded with `repaid == 0` is NOT confirmed — that
   * is exactly how a venue switch stranded positions while the keeper reported
   * success (audit wave 2, M-HIGH-1).
   */
  {
    type: "event",
    name: "LeveragedLpUnwound",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "collateralAsset", type: "address", indexed: true },
      { name: "closedCount", type: "uint256", indexed: false },
      { name: "failedCount", type: "uint256", indexed: false },
      { name: "usdcFromLp", type: "uint256", indexed: false },
      { name: "repaid", type: "uint256", indexed: false },
      { name: "withdrawn", type: "uint256", indexed: false },
      { name: "healthFactor", type: "uint256", indexed: false },
    ],
  },
  /**
   * WHICH book the repay reached: one per venue `unwind` repaid, worst health
   * factor first. `confirm` refuses a receipt that leaves a venue the account
   * still owes without one of these — `LeveragedLpUnwound.repaid` is a total
   * and cannot say where it went (RISKS §8 residual (a), closed 2026-09-09).
   */
  {
    type: "event",
    name: "VenueRepaid",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "venue", type: "address", indexed: true },
      { name: "repaid", type: "uint256", indexed: false },
    ],
  },
  /**
   * WHICH venue the withdraw leg reached: one per venue holding the account's collateral, current
   * pointer first (RISKS §8 "two-book Close", option (1), 2026-09-11). The keeper never sets a
   * withdraw, so its receipts carry none of these; `summarizeUnwinds` reads them for completeness
   * and the dashboard's activity shows them.
   */
  {
    type: "event",
    name: "VenueWithdrawn",
    inputs: [
      { name: "account", type: "address", indexed: true },
      { name: "venue", type: "address", indexed: true },
      { name: "withdrawn", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "Expired", inputs: [{ name: "deadline", type: "uint256" }] },
  { type: "error", name: "ExitHfTooLow", inputs: [{ name: "healthFactor", type: "uint256" }, { name: "floor", type: "uint256" }] },
  { type: "error", name: "UnknownPool", inputs: [{ name: "poolId", type: "bytes32" }] },
  { type: "error", name: "CollateralShort", inputs: [{ name: "asked", type: "uint256" }, { name: "withdrawn", type: "uint256" }] },
  { type: "error", name: "AssetNotRegistered", inputs: [{ name: "asset", type: "address" }] },
  { type: "error", name: "VenueDisabled", inputs: [{ name: "venue", type: "address" }] },
  // The DELTA form. `RouterHoldsBalance` (an absolute zero-balance assertion, and a
  // permanent denial of service for one base unit of anybody's USDC) is gone.
  { type: "error", name: "RouterBalanceChanged", inputs: [{ name: "token", type: "address" }, { name: "balanceBefore", type: "uint256" }, { name: "balanceAfter", type: "uint256" }] },
  // The swap quote must imply a pool price inside the close's own band (audit wave 2, G-MED-1).
  // The keeper builds both from the same live price, so this is a bug signal, never a market one.
  { type: "error", name: "QuoteOutsideBand", inputs: [{ name: "impliedSqrtPriceX96", type: "uint256" }, { name: "minSqrtPriceX96", type: "uint160" }, { name: "maxSqrtPriceX96", type: "uint160" }] },
] as const;

export const lpVenueAbi = [
  {
    type: "function",
    name: "closeMany",
    stateMutability: "nonpayable",
    inputs: [
      { name: "positionIds", type: "uint256[]" },
      { name: "band", ...priceBandStruct },
    ],
    outputs: [
      { name: "out0", type: "uint256" },
      { name: "out1", type: "uint256" },
      { name: "rewards", type: "uint256" },
      { name: "failed", type: "uint256[]" },
    ],
  },
  {
    type: "function",
    name: "positionsOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "ids", type: "uint256[]" }],
  },
  {
    type: "function",
    name: "poolOf",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      { name: "poolId", type: "bytes32" },
      { name: "owner", type: "address" },
    ],
  },
  {
    type: "function",
    name: "ownedPool",
    stateMutability: "view",
    inputs: [
      { name: "positionId", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [
      { name: "poolId", type: "bytes32" },
      { name: "owned", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "poolTokens",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "pool", type: "address" },
    ],
  },
  {
    type: "function",
    name: "poolSqrtPriceX96",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "MAX_BAND_BPS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint256" }] },
  { type: "error", name: "PriceOutOfBand", inputs: [{ name: "sqrtPriceX96", type: "uint256" }, { name: "min", type: "uint160" }, { name: "max", type: "uint160" }] },
  { type: "error", name: "BandRequired", inputs: [] },
  { type: "error", name: "BandTooWide", inputs: [{ name: "min", type: "uint160" }, { name: "max", type: "uint160" }, { name: "maxBps", type: "uint256" }] },
  { type: "error", name: "EnumerationFailed", inputs: [{ name: "reason", type: "bytes" }] },
  // Slice A (2026-09-10, RISKS §12): `positionsOf` names why it refused. `fault` is the venue's
  // EnumerationFault enum as a uint8 — named from @zyo/shared LP_ENUMERATION_FAULTS, whose order
  // verify-abi pins against the Solidity source.
  { type: "error", name: "EngineUnreachable", inputs: [] },
  { type: "error", name: "EnumerationAmbiguous", inputs: [{ name: "fault", type: "uint8" }, { name: "index", type: "uint256" }, { name: "data", type: "bytes" }] },
  { type: "error", name: "PriceUnreadable", inputs: [{ name: "pool", type: "address" }] },
] as const;

/**
 * CollateralRegistry — read by the venue-aware reader (audit wave 2, M-HIGH-2): which venue each
 * collateral asset currently resolves to (`venueOf`), every venue it was pointed at before
 * (`previousVenues`, kept by `acceptVenue` so positions opened there stay reachable), and whether
 * the asset is enabled. Read once per tick; nothing about a venue is cached across ticks.
 */
export const collateralRegistryAbi = [
  {
    type: "function",
    name: "venueOf",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "isEnabled",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "previousVenues",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "address[]" }],
  },
] as const;

/**
 * AaveV3Venue — `PROVIDER()` is what identifies a venue as the `AaveV3Venue` over the pool the
 * keeper's G1–G4 valuation reads directly; such a venue is cross-checked against that pool snapshot
 * instead of against the feed-implied bounds (services/venues.ts).
 */
export const aaveVenueAbi = [
  { type: "function", name: "PROVIDER", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

/**
 * ICollateralVenue — the views the venue-aware reader calls on EVERY venue the registry names for an
 * account's collateral (`venueOf` and `previousVenues`), whatever the venue is built over (audit
 * wave 2, M-HIGH-2). `healthFactor` is WAD with `type(uint256).max` for no debt; on Morpho it is the
 * WORST market's; `debt` and `collateral` are raw token units; `liquidationThresholdBps` is read
 * live (Aave's LT, Morpho's LLTV). Pinned by verify-abi against the interface artifact AND against
 * `MorphoBlueVenue`, so the Morpho venue is known to answer exactly these selectors.
 */
export const collateralVenueAbi = [
  {
    type: "function",
    name: "healthFactor",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "debt",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "asset", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "collateral",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "asset", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "liquidationThresholdBps",
    stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "enabled", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "bool" }] },
] as const;

/** AerodromeSwapAdapter — the keeper never calls it directly; it decodes its reverts. */
export const swapAdapterAbi = [
  {
    type: "function",
    name: "minOutFor",
    stateMutability: "pure",
    inputs: [
      { name: "amountIn", type: "uint256" },
      { name: "quotedIn", type: "uint256" },
      { name: "quotedOut", type: "uint256" },
      { name: "maxSlippageBps", type: "uint16" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "function", name: "MAX_SLIPPAGE_BPS", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint16" }] },
  { type: "error", name: "ZeroQuote", inputs: [] },
  { type: "error", name: "SlippageTooHigh", inputs: [{ name: "bps", type: "uint16" }, { name: "cap", type: "uint16" }] },
  { type: "error", name: "InsufficientOutput", inputs: [{ name: "out", type: "uint256" }, { name: "minOut", type: "uint256" }] },
] as const;

/**
 * SlipstreamLpVenue — the direct venue over the cbZEC/USDC pool (2026-09-11). The keeper reads the
 * same ILpVenue views it reads on the engine venue, asks `ownedPool` because a staked id is the
 * gauge's on the NFT's books, and decodes the venue's own refusals. `positionsOf` there fails
 * closed with `PositionsUnreadable(bytes)` when the gauge or the position manager did not answer.
 */
export const directLpVenueAbi = [
  ...lpVenueAbi.filter((x) => x.type === "function" && ["closeMany", "positionsOf", "poolOf", "ownedPool", "poolTokens", "poolSqrtPriceX96", "MAX_BAND_BPS"].includes(x.name)),
  {
    type: "function",
    name: "positionRange",
    stateMutability: "view",
    inputs: [
      { name: "positionId", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "staked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "unstakedOverflow",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "held", type: "uint256" },
      { name: "scanned", type: "uint256" },
    ],
  },
  { type: "error", name: "PositionsUnreadable", inputs: [{ name: "reason", type: "bytes" }] },
  { type: "error", name: "PriceUnreadable", inputs: [{ name: "pool", type: "address" }] },
  { type: "error", name: "PriceOutOfBand", inputs: [{ name: "sqrtPriceX96", type: "uint256" }, { name: "min", type: "uint160" }, { name: "max", type: "uint160" }] },
  { type: "error", name: "BandRequired", inputs: [] },
  { type: "error", name: "BandTooWide", inputs: [{ name: "min", type: "uint160" }, { name: "max", type: "uint160" }, { name: "maxBps", type: "uint256" }] },
  { type: "error", name: "PoolInactive", inputs: [{ name: "poolId", type: "bytes32" }] },
  { type: "error", name: "NotPositionOwner", inputs: [{ name: "positionId", type: "uint256" }, { name: "owner", type: "address" }] },
  { type: "error", name: "RangeExcludesPrice", inputs: [{ name: "tick", type: "int24" }, { name: "tickLower", type: "int24" }, { name: "tickUpper", type: "int24" }] },
] as const;

/**
 * SlipstreamPoolSwapAdapter — the pool-direct adapter the direct venue's leg swaps through; the
 * keeper never calls it directly and decodes its reverts (a partial fill or a pool paying less
 * than it says is refused by name, never half-done).
 */
export const poolSwapAdapterAbi = [
  ...swapAdapterAbi,
  { type: "error", name: "PartialFill", inputs: [{ name: "amountIn", type: "uint256" }, { name: "consumed", type: "uint256" }] },
  { type: "error", name: "NotPoolPair", inputs: [{ name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }] },
  { type: "error", name: "WrongRoute", inputs: [{ name: "given", type: "int24" }, { name: "expected", type: "int24" }] },
  { type: "error", name: "NotPool", inputs: [{ name: "caller", type: "address" }] },
  { type: "error", name: "NoSwapInFlight", inputs: [] },
] as const;

export const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
] as const;

/**
 * Aerodrome Slipstream CL pool — the keeper reads `tickSpacing()` from the pool
 * behind an engine poolId to build the adapter's `routeData`
 * (`abi.encode(int24 tickSpacing)`). No in-repo artifact exists for a live
 * pool; the selector is pinned in scripts/verify-abi.mjs.
 */
export const clPoolAbi = [
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int24" }] },
] as const;

/**
 * Selectors of the ROOT calls the keeper needs grants for (pinned by verify-abi).
 *
 * There is exactly one. The keeper's whole plan is one `StrategyRouter.unwind`
 * per pool — the router closes the LP ids itself through the nested path — so
 * the single `Permission` the user signs covers every rung. A separate root
 * `SnuggleLpVenue.closeMany` (what the keeper planned before fix round 1) was
 * outside that grant, and every protective rung was refused (audit C-HIGH-1).
 */
export const GRANT_SELECTORS = {
  "StrategyRouter.unwind": toFunctionSelector(
    "unwind((address,uint256[],(uint160,uint160),(uint256,uint256,uint16,bytes),uint256,uint256,uint256))"
  ),
} as const;

/**
 * The grant the web must sign for the keeper, in full. `allowCallback` MUST be
 * true: the router acts back on the account (`execNestedPeripheral`) and a
 * grant without it fails with `NotActivePeripheral()` raised inside the
 * router's frame — a mis-issued grant, not a market condition.
 */
export const KEEPER_GRANT_SHAPE = {
  targetRole: "StrategyRouter",
  selector: GRANT_SELECTORS["StrategyRouter.unwind"],
  allowCallback: true,
} as const;
