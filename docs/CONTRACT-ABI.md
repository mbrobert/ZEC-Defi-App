# Oilskin Base-first v1 — contract ABI (the seam the keeper and the web encode from)

**Source of truth is the compiled artifact, not this page.** `contracts/abi/oilskin-abi.json` is
generated from `contracts/out` by `node scripts/verify-abi.mjs --write` and carries the full ABI plus
every selector / topic / error for 17 contracts and interfaces (266 entries). Import that JSON;
run `node scripts/verify-abi.mjs` in your area's test script — it exits 1 on any drift. The previous
project lost this seam twice by encoding from a written document (AUDIT-FINDINGS Part 4); this
document is a *reading aid* and the tables below were pasted from `--print`, not typed.

Toolchain: solc 0.8.24, via-IR, EVM cancun (transient storage is used). All structs are ABI tuples.

---

## 0. How everything fits (read this before encoding anything)

```
wallet (EOA) ──owner──▶ OilskinAccount (EIP-1167 clone, one per wallet)
                            │ exec / execBatch            (owner only, plain CALLs)
                            │ execAsKeeper                (keeper, checked against grants)
                            ▼
              ┌──── active peripheral ──────────────────────────────────────┐
              │ StrategyRouter / AaveV3Venue / SnuggleLpVenue / SwapAdapter │
              └──── may call back: execFromPeripheral / execNestedPeripheral┘
                            ▼ (the ACCOUNT is msg.sender to all of these)
                 Aave v3 Pool · Snuggle engine · Permit2 · Aerodrome SwapRouter
```

* **Nobody calls a venue or the router from an EOA.** Every mutating call is
  `account.exec(target, 0, data)` (owner) or `account.execAsKeeper([{target, 0, data}])` (keeper).
  Calling `router.openLeveragedLp` directly from a wallet reverts (`msg.sender` has no account code).
* **First-time user, one transaction:** `factory.createAccountAndExec([{router, 0, openLeveragedLp(...)}])`
  from the wallet. The account address is known beforehand: `factory.accountOf(wallet)` — that is
  the Permit2 **spender** the user signs for.
* **Positions are the account's.** Aave `onBehalfOf` = account; Snuggle ids are minted to the
  account (it is `msg.sender` to the engine). Read them from chain with `ILpVenue.positionsOf(account)`
  and `ICollateralVenue.healthFactor/debt/collateral(account, …)`.
* **The router holds nothing** (it asserts `balanceOf(router)==0` at the end of every call), has no
  storage, no owner, no fee. Fee is taken only in `SnuggleLpVenue.claim/close` on realised yield.
* **Revert data bubbles untouched** through the account, so a failed `exec` surfaces the venue's /
  engine's / Aave's own error. Decode with the union of all error ABIs below.

### Encoding `exec` for the web (viem)

```ts
const data = encodeFunctionData({ abi: strategyRouterAbi, functionName: "openLeveragedLp", args: [params] });
// existing account:
writeContract({ address: account, abi: oilskinAccountAbi, functionName: "exec", args: [router, 0n, data] });
// first-time user:
writeContract({ address: factory, abi: factoryAbi, functionName: "createAccountAndExec", args: [[{ target: router, value: 0n, data }]] });
```

### Permit2 (collateral pull on open)

The user signs Permit2 `PermitTransferFrom` typed data with **spender = the account address**,
`permitted = {token: collateralAsset, amount: collateralAmount}`, a fresh unordered `nonce`, and a
`deadline`. Put `nonce`, `deadline`, `signature` in `OpenParams.permit`. The user must have approved
the canonical Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) on the token once. An empty
signature means "the account already holds `collateralAmount`" (no pull); `collateralAmount = 0`
means "borrow against collateral already supplied".

### Keeper grants — how the keeper is allowed to act

`account.grant(keeper, Permission)` (owner only). A grant is one root `(target, selector)` the
keeper may invoke via `execAsKeeper`, with per-period budgets:

```
Permission { target, selector, maxValuePerPeriod (wei), tokenLimits[] {token, amountPerPeriod}, period (s), expiry (unix) }
```

Rules the account enforces (tested, invariant-checked):
1. A keeper call whose root `(target, selector)` has no active grant reverts `NotGranted`.
2. **Every token operation anywhere in the call tree** — `transfer`, `approve`, `increaseAllowance`,
   `transferFrom`, Permit2 `approve`/`transferFrom` — is charged to the root grant's budget for that
   token. A token without a budget line reverts `TokenNotBudgeted`; over budget reverts
   `TokenBudgetExceeded(token, wanted, remaining)`. ETH `value` is charged to `maxValuePerPeriod`.
3. Budgets reset every `period` seconds from `periodStart` (fixed windows). `grantOf` / `tokenBudgetOf`
   expose limit and spent. `revoke(keeper,target,selector)` kills one grant; `revokeAll()` kills all
   (epoch bump) — the kill switch for a compromised keeper key.
4. Budgets are computed from **calldata amounts**, never from balance snapshots, so a rebasing token
   (cbZEC) cannot fool them, and the account never reads a balance across an external call.

**Recommended v1 "protection" grant** for the ladder (repay / derisk / emergency rungs), one grant:

```
target   = StrategyRouter, selector = unwind
tokenLimits = [ {USDC, ≤ debt per period},      // repay approval
                {WETH or cbBTC (pool token), …}, // swap approval + fee transfer
                {AERO, …} ]                      // reward-token fee transfer
period   = 86400, expiry = ≤ 30 d ahead, maxValuePerPeriod = 0
```
Every token the tree may *approve or transfer* must be listed: the USDC repay approval, the
non-USDC pool token's swap approval, and the performance-fee transfers (pool tokens + AERO). A
missing line makes the keeper call revert — by design. The router's `unwind` always pays the
**account** (never the keeper), and `withdrawAmount` is HF-gated, so a compromised keeper key can at
worst churn within budgets. Do **not** grant `openLeveragedLp`, `borrow`, `sweep` or raw token
selectors to a keeper.

### Health factor floor (what the chain enforces, what the UI may claim)

* `CollateralRegistry.entryHfFloorWad()` (1.55e18, from packages/shared `ENTRY_HF_FLOOR`).
* `CollateralRegistry.maxOfferedLtvBps(asset)` = floor(LT / floor) capped 5000, LT read live from
  the venue; 0 if disabled. **Never type an LTV.**
* `StrategyRouter.openLeveragedLp` reverts `EntryHfTooLow(hf, floor)` if the post-borrow HF is
  below the floor; `unwind` with a collateral withdraw and debt left reverts `ExitHfTooLow`.
* `AaveV3Venue.healthFactor(account)` is Aave's WAD HF; `type(uint256).max` = no debt.

### Price band (every deposit and close)

`PriceBand { minSqrtPriceX96, maxSqrtPriceX96 }` — both non-zero, `min ≤ max`. The venue reads the
pool's `slot0().sqrtPriceX96` at execution (`SnuggleLpVenue.poolSqrtPriceX96(poolId)` gives the same
read for quoting) and reverts `PriceOutOfBand` outside it, `PriceUnreadable` if the pool cannot be
read, `BandRequired` if a bound is zero. Quote the band from the current price ± your tolerance.

### Widths

`rangeWidthBps` is the **total tick span** (1 bps = 1 tick), bounds **[150, 5000]** enforced on chain
(`InvalidWidth`). Presets live in packages/shared; the ± a UI shows is derived off-chain
(half = exp(bps·ln1.0001/2) − 1), never on chain and never typed.

---

## 1. OilskinAccount  (`src/account/OilskinAccount.sol`)

| selector | function | notes |
|---|---|---|
| `0x0565bb67` | `exec(address target,uint256 value,bytes data) payable → bytes` | owner only; target becomes the active peripheral |
| `0x0b8707f6` | `execBatch((address,uint256,bytes)[] calls) payable → bytes[]` | owner only; atomic |
| `0x67729475` | `execAsKeeper((address,uint256,bytes)[] calls) → bytes[]` | keeper; each call checked against a grant |
| `0x7cc04026` | `execFromPeripheral((address,uint256,bytes)[] calls) → bytes[]` | only the active peripheral, only mid-exec |
| `0x53a8695d` | `execNestedPeripheral(address peripheral,uint256 value,bytes data) → bytes` | only the active peripheral |
| `0x345fe22c` | `grant(address keeper,(address target,bytes4 selector,uint256 maxValuePerPeriod,(address token,uint256 amountPerPeriod)[] tokenLimits,uint40 period,uint40 expiry))` | owner only |
| `0x5cf3693c` | `revoke(address keeper,address target,bytes4 selector)` | owner only |
| `0xa340fff4` | `revokeAll()` | owner only; epoch bump |
| `0x37ba97af` | `initialize(address owner,(address,uint256,bytes)[] initialCalls) payable → bytes[]` | factory only, once |
| `0x8da5cb5b` | `owner() → address` | |
| `0x6b744715` | `grantEpoch() → uint256` | |
| `0x6e58f6bc` | `grantOf(address keeper,address target,bytes4 selector) → (bool active,uint256 maxValuePerPeriod,uint256 valueSpent,uint40 period,uint40 expiry,uint40 periodStart)` | |
| `0xefaa1d8a` | `tokenBudgetOf(address keeper,address target,bytes4 selector,address token) → (uint256 amountPerPeriod,uint256 spent)` | |
| `0xa0b87a5c` | `grantTokens(address keeper,address target,bytes4 selector) → address[]` | |
| `0x2dd31000` | `FACTORY() → address` · `0x6afdd850` `PERMIT2() → address` · `0x92e30094` `MAX_TOKEN_LIMITS() → uint256` (8) | |
| `0x150b7a02` / `0xf23a6e61` / `0xbc197c81` | ERC-721 / 1155 receivers · `0x01ffc9a7` `supportsInterface` · `receive()` | |

Events: `Initialized(address indexed owner)` · `Executed(address indexed actor,address indexed target,uint256 value,bytes4 selector)` (topic0 `0x3293f0f9…`) · `Granted(address indexed keeper,address indexed target,bytes4 indexed selector,uint40 expiry,uint40 period,uint256 maxValuePerPeriod)` · `Revoked(address indexed keeper,address indexed target,bytes4 indexed selector)` · `AllGrantsRevoked(uint256 epoch)` · `KeeperSpend(address indexed keeper,address indexed token,uint256 amount)` (token = 0 ⇒ ETH).

Errors: `NotOwner()` `0x30cd7471` · `NotFactory()` · `AlreadyInitialized()` · `ZeroOwner()` · `Reentrancy()` `0xab143c06` · `NotActivePeripheral()` `0x7ee8a5e3` · `NotGranted(address keeper,address target,bytes4 selector)` `0x301e59b7` · `InvalidPermission()` · `ValueBudgetExceeded(uint256 wanted,uint256 remaining)` `0xbdc29de0` · `TokenNotBudgeted(address token)` `0x97c5302a` · `TokenBudgetExceeded(address token,uint256 wanted,uint256 remaining)` `0x9dd2e369`.

## 2. OilskinAccountFactory  (`src/account/OilskinAccountFactory.sol`)

| selector | function |
|---|---|
| `0x8086b8ba` | `accountOf(address owner) → address` (deterministic, before deployment) |
| `0x90184b02` | `isDeployed(address owner) → bool` |
| `0x9859387b` | `createAccount(address owner) → address` (anyone; idempotent; deploys for `owner` only) |
| `0x2e154f02` | `createAccountAndExec((address,uint256,bytes)[] calls) payable → (address account,bytes[] results)` (caller = owner; reverts `AccountExists` if deployed) |
| `0x3a4741bd` | `IMPLEMENTATION() → address` |

Event `AccountCreated(address indexed owner,address indexed account)` (topic0 `0xac631f30…`). Errors `ZeroOwner()`, `AccountExists(address)`, OZ `FailedDeployment()`.

## 3. ICollateralVenue → AaveV3Venue (`src/venues/AaveV3Venue.sol`), MorphoBlueVenue (disabled)

Mutators are called BY the account (`exec`); views take the account.

| selector | function | AaveV3Venue behaviour |
|---|---|---|
| `0xf2b9fdb8` | `supply(address asset,uint256 amount)` | approve-exact → `Pool.supply(asset, amount, account, 0)` → approve 0 |
| `0xf3fef3a3` | `withdraw(address asset,uint256 amount) → uint256` | `Pool.withdraw(asset, amount, account)`; max = all |
| `0x4b8a3529` | `borrow(address asset,uint256 amount)` | variable rate, `onBehalfOf` = account, funds to account |
| `0x22867d78` | `repay(address asset,uint256 amount) → uint256` | approves min(amount, debt); max = full debt; `NothingToRepay` if 0 |
| `0x6ad9f9df` | `healthFactor(address account) → uint256` | WAD; max when no debt |
| `0x5d462920` | `liquidationThresholdBps(address asset) → uint256` | live from PoolDataProvider (0 = not listed, e.g. cbZEC) |
| `0xc2f2d31c` | `maxLtvBps(address asset) → uint256` | live |
| `0xd449300d` | `debt(address account,address asset) → uint256` · `0xcc218ece` `collateral(address account,address asset) → uint256` · `0x99431ce5` `borrowRateRay(address asset) → uint256` | live |
| `0x238dafe0` | `enabled() → bool` | Aave true; Morpho **false** |
| `0xb883b058` | `assetPrice(address) → uint256` (Aave only) · `0x00d34411` `PROVIDER()` | |

Errors: `ZeroAmount()` `0x1f2a2005`, `NothingToRepay()` `0xd32e7fc6`; Morpho: every function reverts `VenueDisabled()` `0xc8071240`; `marketId((address,address,address,address,uint256)) → bytes32` is the only live Morpho helper.

## 4. ILpVenue → SnuggleLpVenue  (`src/venues/SnuggleLpVenue.sol`)

```
LpOpenParams { bytes32 poolId; uint256 amount0; uint256 amount1; uint24 rangeWidthBps; uint64 rebalanceDelay;
               bool autoCompound; PriceBand band; uint256 deadline }
```
`amount0`/`amount1` are the engine pool's token0/token1 (see `poolTokens`); one may be zero
(single-sided; the engine swaps to ratio); both non-zero = dual deposit, bounce folded.

| selector | function | notes |
|---|---|---|
| `0x641b9c30` | `open(LpOpenParams) → uint256 positionId` | engine id minted to the account |
| `0x02efe039` | `increase(uint256 positionId,uint256 amount0,uint256 amount1,PriceBand band,uint256 deadline) → uint256 newPositionId` | NEW id beside the old one (engine has no in-place increase) |
| `0x2623a0a9` | `close(uint256 positionId,PriceBand band) → (uint256 out0,uint256 out1,uint256 rewards)` | collect (fee) then withdraw (no fee); engine refusal bubbles |
| `0x812b00f2` | `closeMany(uint256[] positionIds,PriceBand band) → (uint256 out0,uint256 out1,uint256 rewards,uint256[] failed)` | per-id try/catch; ids in `failed` untouched |
| `0x6ba4c138` | `claim(uint256[] positionIds) → (uint256 fees0,uint256 fees1,uint256 rewards)` | net of fee; one pool per call (`MixedPools`) |
| `0xf867d46b` | `positionsOf(address account) → uint256[]` | C-2 index enumeration; reverts `EnumerationFailed`/`EngineUnreachable` rather than lying |
| `0xfbadbc39` | `poolTokens(bytes32 poolId) → (address token0,address token1,address pool)` | |
| `0x83966021` | `poolOf(uint256 positionId) → (bytes32 poolId,address owner)` | zeros once closed / re-keyed |
| `0xd6473b12` | `poolSqrtPriceX96(bytes32 poolId) → uint256` | the band read, for quoting |
| `0xc653c866` | `dustFloor(address token) → uint256` | 10^decimals / 1e5 |
| views | `performanceBps()` `treasury()` `ENGINE()` `REWARD_TOKEN()` `MAX_PERFORMANCE_BPS()` (2000) `MIN_WIDTH_BPS()` (150) `MAX_WIDTH_BPS()` (5000) `MAX_REBALANCE_DELAY()` `MAX_ENUMERATION()` (512) `DUST_DIVISOR()` `BPS()` | |

Events: `LpOpened(address indexed account,bytes32 indexed poolId,uint256 indexed positionId,uint256 amount0,uint256 amount1,uint24 rangeWidthBps)` · `LpIncreased(address indexed account,uint256 indexed positionId,uint256 indexed newPositionId,uint256 amount0,uint256 amount1)` · `LpClosed(address indexed account,uint256 indexed positionId,uint256 out0,uint256 out1,uint256 rewards)` · `LpCloseFailed(address indexed account,uint256 indexed positionId,bytes reason)` · `ClaimSkipped(address indexed account,uint256 indexed positionId)` · `PerformanceFee(address indexed account,address indexed token,uint256 gross,uint256 fee)` · `FeeSkipped(address indexed account,address indexed token,uint256 fee)` · `RefundFolded(address indexed account,address indexed token,uint256 amount,uint256 newPositionId)` · `RefundLeft(address indexed account,address indexed token,uint256 amount)`.

Errors: `FeeAboveCap(uint256,uint256)` · `ZeroAddress()` · `InvalidWidth(uint24)` `0xb2c36d99` · `InvalidDelay(uint64)` · `Expired(uint256)` `0xf80dbaea` · `ZeroAmounts()` · `PoolInactive(bytes32)` · `BandRequired()` `0x86e45e3c` · `PriceUnreadable(address)` `0x7fdeb21f` · `PriceOutOfBand(uint256 sqrtPriceX96,uint160 min,uint160 max)` `0xd92331cf` · `NotPositionOwner(uint256,address)` `0x606840e0` · `MixedPools()` · `EngineUnreachable()` `0xd148f8ee` · `EnumerationFailed(bytes)` `0xb1440723` · `TooManyPositions(uint256)`.

## 5. CollateralRegistry  (`src/registry/CollateralRegistry.sol`, Ownable2Step)

| selector | function |
|---|---|
| `0x370f8b5c` | `maxOfferedLtvBps(address asset) → uint256` (derived, capped 5000, 0 if disabled) |
| `0xcc36b103` | `entryHfForLtv(address asset,uint256 ltvBps) → uint256` (WAD; LT/LTV) |
| `0xe2baeb4e` | `entryHfFloorWad() → uint256` |
| `0x0e68ec95` | `config(address asset) → (address venue,uint8 decimals,address priceFeed,bool enabled,string note)` |
| `0x9015d371` | `isEnabled(address) → bool` · `0xe1441a56` `venueOf(address) → address` · `0x71a97305` `assets() → address[]` |
| `0x7c9189e7` | `register(address asset,address venue,address priceFeed,bool enabled,string note)` (owner) |
| `0x7267d09a` | `setEnabled(address asset,bool enabled,string note)` (owner) · `0xca0f0725` `setEntryHfFloor(uint256 wad)` (owner, (1,10] WAD) |
| OZ | `owner() pendingOwner() transferOwnership(address) acceptOwnership() renounceOwnership()` |

Events `AssetRegistered(address indexed asset,address indexed venue,uint8 decimals,address priceFeed,bool enabled)` · `AssetEnabled(address indexed asset,bool enabled,string note)` · `EntryHfFloorSet(uint256)` (+ OZ ownership events). Errors `ZeroAddress()` · `VenueDisabled(address)` `0x251897fd` · `UnknownAsset(address)` · `InvalidHfFloor(uint256)` · `VenueDoesNotKnowAsset(address)` · OZ `OwnableUnauthorizedAccount(address)`.

cbZEC is registered `enabled=false, note="no collateral market on Base yet"` — show `note` verbatim.

## 6. ISwapAdapter → AerodromeSwapAdapter  (`src/swap/AerodromeSwapAdapter.sol`)

`0x16725787` `swap(address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,uint256 deadline,bytes routeData) → uint256 amountOut` — called by the account; recipient is always the account; `routeData = abi.encode(int24 tickSpacing)` (Slipstream `exactInputSingle`). `ROUTER()` view. Event `Swapped(address indexed account,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut)`. Errors `ZeroAmount()` `ZeroMinOut()` `0x2870c094` `Expired(uint256)` `SameToken()` `InsufficientOutput(uint256,uint256)` `ZeroAddress()`.

⚠ The Aerodrome SwapRouter **address is not in VERIFIED-BASE-FACTS**; Deploy.s.sol requires `AERODROME_SWAP_ROUTER` from env after probing.

## 7. StrategyRouter  (`src/router/StrategyRouter.sol`) — stateless

```
OpenParams   { address collateralAsset; uint256 collateralAmount; (uint256 nonce,uint256 deadline,bytes signature) permit;
               uint256 borrowAmount; bytes32 poolId; uint24 rangeWidthBps; uint64 rebalanceDelay; bool autoCompound;
               PriceBand band; uint256 deadline }
UnwindParams { address collateralAsset; uint256[] positionIds; PriceBand band; uint256 swapMinOut; bytes swapRouteData;
               uint256 repayAmount; uint256 withdrawAmount; uint256 deadline }
```

| selector | function | notes |
|---|---|---|
| `0x3c2639d6` | `openLeveragedLp(OpenParams) → (uint256 positionId,uint256 healthFactor)` | Permit2 pull → supply → borrow USDC → LP open (USDC single-sided; pool must contain USDC) → HF ≥ floor |
| `0xebf64f1c` | `unwind(UnwindParams) → (uint256 usdcFromLp,uint256 repaid,uint256 withdrawn,uint256 healthFactor)` | closeMany (skips refused ids) → swap non-USDC leg → repay (max = min(debt, held)) → withdraw (max = all; HF-gated if debt remains). Works on DISABLED assets. |
| `0x780469bb` | `sweep(address[] tokens)` | whole balances to `account.owner()` — earnings to the wallet |
| views | `REGISTRY() LP_VENUE() SWAP() PERMIT2() USDC()` | |

Events `LeveragedLpOpened(address indexed account,address indexed collateralAsset,uint256 collateralAmount,uint256 borrowed,bytes32 indexed poolId,uint256 positionId,uint256 healthFactor)` · `LeveragedLpUnwound(address indexed account,address indexed collateralAsset,uint256 closedCount,uint256 failedCount,uint256 usdcFromLp,uint256 repaid,uint256 withdrawn,uint256 healthFactor)` · `Swept(address indexed account,address indexed token,address indexed to,uint256 amount)`.

Errors `ZeroAddress()` · `Expired(uint256)` · `AssetNotRegistered(address)` `0x1a2a9e87` · `AssetDisabled(address asset,string note)` `0x121ab360` · `VenueDisabled(address)` · `ZeroBorrow()` · `PoolWithoutUsdc(bytes32)` · `EntryHfTooLow(uint256 hf,uint256 floor)` `0xd40fd174` · `ExitHfTooLow(uint256 hf,uint256 floor)` `0x73cd1b85` · `RouterHoldsBalance(address,uint256)`.

`swapMinOut` must be > 0 whenever a non-USDC leg comes back (the adapter reverts `ZeroMinOut`); quote it from the band.

## 8. PythOracleAdapter (v1.1, built, UNUSED)  (`src/oracle/PythOracleAdapter.sol`)

`0xd828d374` `refresh(bytes[] updateData) payable` — posts the Pyth update (fee from msg.value, rest refunded) and arms `price()` for this tx · `0xa035b1fe` `price() → uint256` — Morpho `IOracle`: 1 base unit in quote units × 1e36; reverts `NoUpdateInTx()` `0xb23dd9ac` unless refreshed in the same tx, Pyth `StalePrice` past `maxAge`, `PegBreak(uint256 pythE8,uint256 twapE8,uint256 deviationBps)` `0x5963163c` beyond `maxDeviationBps` vs the Aerodrome cbZEC/USDC TWAP · `0x59e02dd7` `peek() → (pythPriceE8,publishTime,twapE8,deviationBps)` (diagnostic, no gate) · `0x48534330` `twapPriceE8()` · immutables `PYTH PRICE_ID POOL BASE_TOKEN QUOTE_TOKEN BASE_DECIMALS QUOTE_DECIMALS BASE_IS_TOKEN0 maxAge maxDeviationBps twapWindow`. Event `Refreshed(uint256 fee,uint256 pythPriceE8,uint256 publishTime)`. Other errors `ZeroAddress InvalidConfig PoolTokensMismatch(address,address) NonPositivePrice(int64) InsufficientFee(uint256,uint256) RefundFailed TickOutOfRange(int24)`.

## 9. External surfaces we encode against (verified selectors)

* `ISnuggleVault`: `positions(uint256)` **`0x99fbab88`**, `userPositions(address,uint256)` **`0x5e1b4d99`** (index getter, reverts past the end — FACT 1; `userPositions(address)` `0x613cf420` does NOT exist), `approvedPools(bytes32)` `0x35d75781`, `deposit` `0x948d2b91`, `depositSingleSided` `0xc1e27131`, `withdraw(uint256,bool)` `0x38d07436`, `harvest` `0xddc63262`, `claimStakingRewards` `0x8fad2627`, `poolIds`/`poolIdsCount`.
* `IAerodromeCLPool`: `slot0()` **`0x3850c7bd`**, `liquidity()` **`0x1a686502`**, `token0/token1/tickSpacing/fee`, `observe(uint32[])` (TWAP; probe before v1.1).
* `IPermit2.permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)` `0x30f28b7a`; `IPyth.getPriceNoOlderThan/getPriceUnsafe/getUpdateFee/updatePriceFeeds`.

## 10. Addresses (Base 8453) — from VERIFIED-BASE-FACTS only, mirrored in `script/Deploy.s.sol::BaseAddresses`

USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` · WETH `0x4200000000000000000000000000000000000006` · cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` · cbZEC `0xB2000000000000000000008501b13360000cb2EC` (B20) · AERO `0x940181a94A35A4569E4529A3CDfB74e38FD98631` · Aave provider `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` / pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` / data provider `0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A` / oracle `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156` · Chainlink cbBTC/USD `0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D`, ETH/USD `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` · Pyth `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`, ZEC/USD id `0xbe9b59d1…bb24` · Aerodrome cbZEC/USDC pool `0x0Fc47C17AF86078d809358db1b4db2DeBC988566` · Morpho `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` · Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` · Snuggle engine `0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55`. Our own deployment addresses do not exist yet (nothing is deployed).
