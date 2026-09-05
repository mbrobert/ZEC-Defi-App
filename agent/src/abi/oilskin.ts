import { toFunctionSelector, type AbiEvent } from "viem";

/**
 * OilskinAccount / OilskinAccountFactory ABI fragments the keeper uses.
 *
 * Transcribed from contracts/src/account/*.sol and interfaces/IOilskinAccount.sol.
 * `scripts/verify-abi.mjs` diffs every selector, event topic and argument
 * layout below against contracts/out/*.json and fails the suite on drift
 * (AUDIT-FINDINGS Part 4: "the ABI seam broke twice").
 */

export const callStruct = {
  type: "tuple",
  components: [
    { name: "target", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
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
] as const;

/** Selectors the keeper hard-codes (grant checks). Pinned by verify-abi. */
export const KEEPER_SELECTORS = {
  "OilskinAccount.execAsKeeper": toFunctionSelector("execAsKeeper((address,uint256,bytes)[])"),
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
          { name: "swapMinOut", type: "uint256" },
          { name: "swapRouteData", type: "bytes" },
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
  { type: "error", name: "Expired", inputs: [{ name: "deadline", type: "uint256" }] },
  { type: "error", name: "ExitHfTooLow", inputs: [{ name: "healthFactor", type: "uint256" }, { name: "floor", type: "uint256" }] },
  { type: "error", name: "AssetNotRegistered", inputs: [{ name: "asset", type: "address" }] },
  { type: "error", name: "RouterHoldsBalance", inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] },
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
    name: "poolSqrtPriceX96",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "error", name: "PriceOutOfBand", inputs: [{ name: "sqrtPriceX96", type: "uint256" }, { name: "min", type: "uint160" }, { name: "max", type: "uint160" }] },
  { type: "error", name: "BandRequired", inputs: [] },
] as const;

export const erc20BalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Selectors of the root calls the keeper needs grants for (pinned by verify-abi). */
export const GRANT_SELECTORS = {
  "StrategyRouter.unwind": toFunctionSelector(
    "unwind((address,uint256[],(uint160,uint160),uint256,bytes,uint256,uint256,uint256))"
  ),
  "SnuggleLpVenue.closeMany": toFunctionSelector("closeMany(uint256[],(uint160,uint160))"),
} as const;
