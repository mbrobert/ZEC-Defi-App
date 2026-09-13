# Oilskin Base module v1 — contract ABI (the seam the keeper and the web encode from)

**Source of truth is the compiled artifact, not this page.** `contracts/abi/oilskin-abi.json` is
generated from `contracts/out` by `node scripts/verify-abi.mjs --write` and carries the full ABI plus
every selector / topic / error for 19 contracts and interfaces — **440 entries** as of 2026-09-13 (257 functions, 49 events, 134 errors; the script counted 426 before this change, not the 424 once quoted here — the cross-chain step A5.1 added 6 functions, 3 events and 5 errors on `StrategyRouter`; the W3-LOW-5 fix added `SlipstreamLpVenue.earlyWithdrawPenalty` / `PenaltyUnreadable`, the W3-LOW-2 fix added `SlipstreamLpVenue.toRatioToleranceBps`, the W3-LOW-1 fix added `StrategyRouter.AmbiguousPositionId`, slice G added `SlipstreamLpVenue.unstakedOverflow`, 419 after slice F). 2026-09-11 (slice F) added `SlipstreamLpVenue` and `SlipstreamPoolSwapAdapter` (§4b, §6b), `StrategyRouter.LP_VENUE_DIRECT` / `SWAP_DIRECT` / `VenueWithdrawn` / `UnknownPool` / `CollateralShort`, `ILpVenue.ownedPool` on both venues, and two more router constructor arguments (330 across 17 on 2026-09-10 after slice C's `InsufficientLoanToken`; 327 before it). 2026-09-09 added `StrategyRouter.VenueRepaid` (`RISKS.md` §8 residual (a): the repay reaches every venue the account owes and the receipt says which; 326 before it). The wave-2 fix round (`AUDIT-2026-09-07.md`) added `CollateralRegistry.previousVenues`, `ICollateralVenue.borrowAgainst` on both venues, `MorphoBlueVenue.NoMarketCanFill` and `StrategyRouter.QuoteOutsideBand`, and dropped `PythOracleAdapter.NoUpdateInTx` (321 before it; 303 before `MorphoBlueVenue` was built).
Import that JSON; run `node scripts/verify-abi.mjs` in your area's test script — it exits 1 on any
drift. The previous project lost this seam twice by encoding from a written document
(AUDIT-FINDINGS Part 4); this document is a *reading aid* and every selector below was read out of
the regenerated bundle, not typed.

Toolchain: solc 0.8.24, via-IR, EVM cancun (transient storage is used). All structs are ABI tuples.

**What changed on 2026-09-06** (wave-1 audit fix round; the full rationale is in
`AUDIT-2026-09-06.md`): `Call` gained `callback`; `exec` became a plain call and `execWithCallback`
is the opt-in; `Permission` gained `allowCallback`; `StrategyRouter.openBorrowOnly` is new;
`ISwapAdapter.swap` takes a quote with a 500 bps cap instead of a bare `minOut`; venue registration
is propose/accept behind a timelock; `closeMany` / `claim` no longer revert on a stale first id;
`RouterHoldsBalance` became `RouterBalanceChanged`; `AccountExists`, `MixedPools` and `ZeroMinOut`
are gone. Nothing has ever been deployed, so nothing is versioned or aliased.

---

## 0. How everything fits (read this before encoding anything)

```
wallet (EOA) ──owner──▶ OilskinAccount (EIP-1167 clone, one per wallet)
                            │ exec                        (owner, PLAIN call — target gets nothing)
                            │ execWithCallback / execBatch(callback:true)   (owner, peripheral opt-in)
                            │ execAsKeeper                (keeper, checked against grants;
                            │                              rights come from Permission.allowCallback)
                            ▼
              ┌──── active peripheral ──────────────────────────────────────┐
              │ StrategyRouter / AaveV3Venue / SnuggleLpVenue / SwapAdapter │
              └──── may call back: execFromPeripheral / execNestedPeripheral┘
                            ▼ (the ACCOUNT is msg.sender to all of these)
                 Aave v3 Pool · Snuggle engine · Permit2 · Aerodrome SwapRouter
```

* **Nobody calls a venue or the router from an EOA.** Every mutating call is
  `account.execWithCallback(target, 0, data)` (owner) or
  `account.execAsKeeper([{target, 0, data, false}])` (keeper). Calling
  `router.openLeveragedLp` directly from a wallet reverts (`msg.sender` has no account code).
* **`callback` is the peripheral opt-in and defaults to false.** A plain `exec` to the router or a
  venue reverts `NotActivePeripheral` inside the callee — use `execWithCallback`. A token, a pool or
  Permit2 must always be a plain call. On the keeper path the flag on the `Call` is **ignored**: the
  account reads `Permission.allowCallback`, so the owner decides which target may act back on the
  account, never the keeper.
* **First-time user, one transaction:**
  `factory.createAccountAndExec([{router, 0, openLeveragedLp(...), true}])` from the wallet. It is
  **idempotent**: an account someone else already deployed for this owner is used (the batch is
  forwarded through `OilskinAccount.execBatchFromFactory`), so a front-runner cannot brick the flow.
  The account address is known beforehand: `factory.accountOf(wallet)` — that is the Permit2
  **spender** the user signs for.
* **Positions are the account's.** Aave `onBehalfOf` = account; Snuggle ids are minted to the
  account (it is `msg.sender` to the engine). Read them from chain with `ILpVenue.positionsOf(account)`
  and `ICollateralVenue.healthFactor/debt/collateral(account, …)`.
* **The router is not a holder — as a DELTA, not a zero.** Each entry point snapshots its balance of
  every token it will touch and requires it unchanged at exit (`RouterBalanceChanged`). A donation
  to the router is inert. Asserting an absolute zero was the wave-1 Critical: one base unit of USDC
  from anybody permanently bricked every open and every unwind, on an immutable contract with no
  rescue.
* **Revert data bubbles untouched** through the account, so a failed call surfaces the venue's /
  engine's / Aave's own error. Decode with the union of all error ABIs below. Note that
  `AaveV3Venue.EntryHfTooLow` and `StrategyRouter.EntryHfTooLow` share the selector `0xd40fd174` —
  identical signature; do not build logic that needs to tell them apart.

### Encoding for the web (viem)

```ts
const data = encodeFunctionData({ abi: strategyRouterAbi, functionName: "openLeveragedLp", args: [params] });
// existing account (the router needs peripheral rights):
writeContract({ address: account, abi: oilskinAccountAbi, functionName: "execWithCallback", args: [router, 0n, data] });
// first-time user:
writeContract({ address: factory, abi: factoryAbi, functionName: "createAccountAndExec",
                args: [[{ target: router, value: 0n, data, callback: true }]] });
// a token approve — plain, no rights:
writeContract({ address: account, abi: oilskinAccountAbi, functionName: "exec", args: [token, 0n, approveData] });
```

### Permit2 (collateral pull on open)

The user signs Permit2 `PermitTransferFrom` typed data with **spender = the account address**,
`permitted = {token: collateralAsset, amount: collateralAmount}`, a fresh unordered `nonce`, and a
`deadline`. Put `nonce`, `deadline`, `signature` in `OpenParams.permit` / `BorrowOnlyParams.permit`.
The user must have approved the canonical Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) on
the token once. An empty signature means "the account already holds `collateralAmount`" (no pull);
`collateralAmount = 0` means "borrow against collateral already supplied".

### Keeper grants — how the keeper is allowed to act

`account.grant(keeper, Permission)` (owner only). A grant is one root `(target, selector)` the
keeper may invoke via `execAsKeeper`, with per-period budgets:

```
Permission { address target; bytes4 selector; uint256 maxValuePerPeriod;
             TokenLimit[] tokenLimits {address token; uint256 amountPerPeriod};
             uint40 period; uint40 expiry; bool allowCallback }
```

Rules the account enforces (tested, invariant-checked):
1. A keeper call whose root `(target, selector)` has no active grant reverts `NotGranted`.
2. **Every DIRECT token operation in the call tree** — `transfer`, `approve`, `increaseAllowance`,
   `transferFrom`, Permit2 `approve` / single `transferFrom` — is charged to the root grant's budget
   for that token. A token without a budget line reverts `TokenNotBudgeted`; over budget reverts
   `TokenBudgetExceeded(token, wanted, remaining)`. ETH `value` is charged to `maxValuePerPeriod`.
3. **Token movers the parser cannot read are REFUSED, not passed free**: Permit2 batch
   `transferFrom`, Permit2 `permitTransferFrom` (single and batch), ERC-777 `send`, ERC-677
   `transferAndCall` all revert `UnbudgetableSelector(target, selector)` on the keeper path. The
   OWNER path may still use all four (the router's own Permit2 pull is one of them).
4. **What is NOT bounded**: value moved by a protocol the call tree talks to (an Aave `withdraw`, an
   engine withdrawal). The grant's target, and any peripheral it nests into, are trusted code — which
   is exactly why `allowCallback` exists and defaults to false. Say so in any UI that shows budgets.
5. Budgets reset every `period` seconds from `periodStart`, and a **re-grant inside a live period
   carries the spend forward** — every token's, listed again or not (W3-LOW-7) — rather than
   refilling the window. `grantOf` / `tokenBudgetOf` apply
   the roll in the view. `revoke(keeper,target,selector)` kills one grant (and reverts
   `NotRevocable` if there was none); `revokeAll()` kills all (epoch bump) — the kill switch.
6. Refused at grant time (`InvalidPermission`): `selector == bytes4(0)`, a `TokenLimit` with
   `amountPerPeriod == 0`, and duplicate tokens.
7. Budgets are computed from **calldata amounts**, never from balance snapshots, so a rebasing token
   (cbZEC) cannot fool them, and the account never reads a balance across an external call.
8. **Budgets are per grant, not per account.** Two grants that both list USDC give the keeper 2× the
   per-day USDC. A single-chain account issues exactly ONE grant; a cross-chain account (D6, 2026-09-13)
   issues TWO — `unwind` and `closeLpAndBurn`, both listing USDC — so its per-day USDC figure is the sum
   of the two lines and the prompt must say so.

**The v1 "protection" grant — one grant, and it must allow the callback:**

```
target      = StrategyRouter
selector    = unwind((address,uint256[],(uint160,uint160),(uint256,uint256,uint16,bytes),uint256,uint256,uint256))
            = 0x08435e75
tokenLimits = [ {USDC, ≥ 2× debt},        // repay approval
                {collateral / pool token, …}, // swap approval + fee transfer
                {AERO, …} ]                   // reward-token fee transfer
period = 86400, expiry ≤ 30 d ahead, maxValuePerPeriod = 0, allowCallback = TRUE
```
`allowCallback: true` is mandatory: the router must call back into the account to close, repay and
withdraw. A grant without it looks live in the UI and every dispatch reverts `NotActivePeripheral`
inside the router while nothing is broadcast — treat that as a configuration error, not a retryable
one. Every token the tree may *approve or transfer* must be listed — **each in its own decimals at
its own price** (a cbBTC user in the WETH/USDC pool needs a WETH line in wei; wave-2 G-HIGH-1).
`unwind` always pays the **account** (never the keeper); `withdrawAmount` is HF-gated and lands in
the account; and the swap quote must imply a pool price inside the close's price band
(`QuoteOutsideBand`, wave-2 G-MED-1), so a compromised keeper key can at worst churn within
budgets and within the band it committed to. Do **not** grant `openLeveragedLp`, `openBorrowOnly`, `openLpOnly`, `setSolanaRecipient`, `borrow`, `sweep`,
`closeMany` or raw token selectors to a keeper — the keeper's surface is one `unwind` per pool and, on a cross-chain account, one `closeLpAndBurn` per pool.

**The cross-chain "protection" grant (BUILD-PLAN D6 / A5.2, 2026-09-13) — a SECOND grant, for a paired account only:**

```
target      = StrategyRouter
selector    = closeLpAndBurn((uint256[],(uint160,uint160),(uint256,uint256,uint16,bytes),uint256,uint256,uint32,uint256))
            = 0xc01c93d7
tokenLimits = [ {USDC, ≥ the LP's USDC value + idle},   // the approve to Circle's TokenMessengerV2 for the burn
                {pool token, …}, {AERO, …} ]            // swap approval + fee transfer, as for unwind
period = 86400, expiry ≤ 30 d ahead, maxValuePerPeriod = 0, allowCallback = TRUE
```
The destination is not the keeper's to choose: the router burns only to `solanaRecipient(account)`, which the
OWNER set with a plain `exec` and no grant ever names (the seam refuses a third selector). The USDC line
bounds what can leave Base per period; it lands in the user's own Solana Account, nowhere else. The keeper
plans this call only for a rung 3–4 of an account whose Solana half names this account back (a *linked*
pair, `agent/src/solana/pair.ts`) and never while a burn is already in flight.

### Health factor floor (what the chain enforces, what the UI may claim)

* `CollateralRegistry.entryHfFloorWad()` (1.25e18, from packages/shared `ENTRY_HF_FLOOR`, pinned 2026-09-12), bounded
  (1, 10] and settable by the registry owner **without a timelock**.
* `CollateralRegistry.maxOfferedLtvBps(asset)` = `min(LT/floor, venue.maxLtvBps(asset))` — the floor and
  the venue's own max LTV are the only two ceilings (the 50 % product cap and its
  `MAX_OFFERED_LTV_CAP_BPS` getter were removed 2026-09-12, BUILD-PLAN D7) — both
  venue parameters read live; 0 if disabled. A `0` means "not offerable right now", not a bug —
  Aave deprecates by zeroing the LTV while keeping the threshold. **Never type an LTV.**
* **`AaveV3Venue.borrow` reverts `EntryHfTooLow(hf, floor)`** when the borrow would leave the
  account below the floor — so the floor holds on every path through the venue, including a raw
  owner `execBatch`. `StrategyRouter.openLeveragedLp` / `openBorrowOnly` re-read it as a second
  named check. `unwind` with a collateral withdraw and any debt left reverts `ExitHfTooLow`, gated
  on the **global** health factor.
* `CollateralRegistry.entryHfForLtv(asset, ltvBps)` **reverts** `AssetNotEnabled` /
  `VenueDoesNotKnowAsset` / `UnknownAsset` rather than answering a misleading `0`.
* `AaveV3Venue.healthFactor(account)` is Aave's WAD HF; `type(uint256).max` = no debt.

### Price band (every deposit, close and claim)

`PriceBand { uint160 minSqrtPriceX96; uint160 maxSqrtPriceX96 }` — both non-zero, `min ≤ max`, and
the WIDTH is bounded by `SnuggleLpVenue.MAX_BAND_BPS()` = 2500 bps of the lower bound in sqrt-price
space (`BandTooWide`), so "no band" cannot be expressed. The venue reads the pool's
`slot0().sqrtPriceX96` at execution (`poolSqrtPriceX96(poolId)` gives the same read for quoting) and
reverts `PriceOutOfBand` outside it, `PriceUnreadable` if the pool cannot be read, `BandRequired` if
a bound is zero. Quote the band from the current price ± your tolerance (the web sends 100–300 bps
of price).

### Swap floor (unwind)

`ISwapAdapter.swap` takes a **quote plus a bounded tolerance**, not a bare `minOut`. The enforced
floor is `amountIn × quotedOut / quotedIn × (10000 − maxSlippageBps) / 10000`, computed on the
amount ACTUALLY swapped, with `maxSlippageBps ≤ MAX_SLIPPAGE_BPS() = 500` on chain
(`SlippageTooHigh`) and `quotedIn`/`quotedOut`/derived-floor of zero refused (`ZeroQuote`).
`minOutFor(...)` is the same code as a pure view — show that number, do not recompute it; `Swapped`
carries it. **"Accept one base unit" is not expressible.**

### Widths

`rangeWidthBps` is the **total tick span** (1 bps = 1 tick), bounds **[150, 5000]** enforced on chain
(`InvalidWidth`). Presets live in packages/shared; the ± a UI shows is derived off-chain
(half = exp(bps·ln1.0001/2) − 1), never on chain and never typed.

---

## 1. OilskinAccount  (`src/account/OilskinAccount.sol`)

| selector | function | notes |
|---|---|---|
| `0x0565bb67` | `exec(address target,uint256 value,bytes data) payable → bytes` | owner only; **PLAIN call — the target gets no rights** |
| `0x0401f576` | `execWithCallback(address target,uint256 value,bytes data) payable → bytes` | owner only; the target becomes the active peripheral |
| `0xe82a13d1` | `execBatch((address,uint256,bytes,bool)[] calls) payable → bytes[]` | owner only; atomic; per-call `callback` |
| `0xfb3f24d3` | `execAsKeeper((address,uint256,bytes,bool)[] calls) → bytes[]` | keeper; each call checked against a grant; `callback` on the call is IGNORED (the grant decides) |
| `0x3bc5a750` | `execFromPeripheral((address,uint256,bytes,bool)[] calls) → bytes[]` | active peripheral only; a call with `callback: true` reverts `CallbackNotPermitted` |
| `0x53a8695d` | `execNestedPeripheral(address peripheral,uint256 value,bytes data) → bytes` | active peripheral only; depth ≤ `MAX_PERIPHERAL_DEPTH` |
| `0x41d4e839` | `execBatchFromFactory(address owner,(address,uint256,bytes,bool)[] calls) payable → bytes[]` | FACTORY only, and only for the real owner |
| `0x6429b6ce` | `grant(address keeper,(address target,bytes4 selector,uint256 maxValuePerPeriod,(address token,uint256 amountPerPeriod)[] tokenLimits,uint40 period,uint40 expiry,bool allowCallback))` | owner only |
| `0x5cf3693c` | `revoke(address keeper,address target,bytes4 selector)` | owner only; `NotRevocable` if nothing was granted |
| `0xa340fff4` | `revokeAll()` | owner only; epoch bump |
| `0x798b3276` | `initialize(address owner,(address,uint256,bytes,bool)[] initialCalls) payable → bytes[]` | factory only, once |
| `0x8da5cb5b` | `owner() → address` · `0x6b744715` `grantEpoch() → uint256` | |
| `0x6e58f6bc` | `grantOf(address keeper,address target,bytes4 selector) → (bool active,uint256 maxValuePerPeriod,uint256 valueSpent,uint40 period,uint40 expiry,uint40 periodStart,bool allowCallback)` | **7 outputs**; `valueSpent` is period-rolled |
| `0xefaa1d8a` | `tokenBudgetOf(address keeper,address target,bytes4 selector,address token) → (uint256 amountPerPeriod,uint256 spent)` | `spent` is period-rolled |
| `0xa0b87a5c` | `grantTokens(address keeper,address target,bytes4 selector) → address[]` | |
| `0x2dd31000` | `FACTORY()` · `0x6afdd850` `PERMIT2()` · `0x92e30094` `MAX_TOKEN_LIMITS()` (8) · `0x70545338` `MAX_PERIPHERAL_DEPTH()` (8) | |
| `0x150b7a02` / `0xf23a6e61` / `0xbc197c81` | ERC-721 / 1155 receivers · `0x01ffc9a7` `supportsInterface` · `receive()` | |

Events: `Initialized(address indexed owner)` (`0x908408e3…`) · `Executed(address indexed actor,address indexed target,uint256 value,bytes4 selector)` (`0x3293f0f9…`) · `Granted(address indexed keeper,address indexed target,bytes4 indexed selector,uint40 expiry,uint40 period,uint256 maxValuePerPeriod)` (`0x03c7c6dc…`) · `Revoked(address indexed keeper,address indexed target,bytes4 indexed selector)` (`0x213b44f8…`) · `AllGrantsRevoked(uint256 epoch)` (`0x1c64ba15…`) · `KeeperSpend(address indexed keeper,address indexed token,uint256 amount)` (`0xd0af272a…`; token = 0 ⇒ ETH).

Errors: `NotOwner()` `0x30cd7471` · `NotFactory()` `0x32cc7236` · `AlreadyInitialized()` `0x0dc149f0` · `ZeroOwner()` `0x9905827b` · `Reentrancy()` `0xab143c06` · `NotActivePeripheral()` `0x7ee8a5e3` · `NotGranted(address,address,bytes4)` `0x301e59b7` · `InvalidPermission()` `0x868a64de` · `ValueBudgetExceeded(uint256,uint256)` `0xbdc29de0` · `TokenNotBudgeted(address)` `0x97c5302a` · `TokenBudgetExceeded(address,uint256,uint256)` `0x9dd2e369` · **new:** `CallbackNotPermitted()` `0x873f13d6` · `NotRevocable(address,address,bytes4)` `0x4ad5cdb7` · `PeripheralDepthExceeded(uint256)` `0x6c6e6575` · `UnbudgetableSelector(address,bytes4)` `0xca2709b3`.

`IOilskinAccount` mirrors `exec`, `execWithCallback`, `execBatch`, `execAsKeeper`,
`execFromPeripheral`, `execNestedPeripheral`, `grant`, `revoke`, `revokeAll`, `owner`, `grantEpoch`,
`grantOf`, `grantTokens`, `tokenBudgetOf` with identical selectors.

## 2. OilskinAccountFactory  (`src/account/OilskinAccountFactory.sol`)

| selector | function |
|---|---|
| `0x8086b8ba` | `accountOf(address owner) → address` (deterministic, before deployment) |
| `0x90184b02` | `isDeployed(address owner) → bool` |
| `0x9859387b` | `createAccount(address owner) → address` (anyone; idempotent; refuses the factory itself) |
| `0xbc8b9a9f` | `createAccountAndExec((address,uint256,bytes,bool)[] calls) payable → (address account,bytes[] results)` (caller = owner; **idempotent** — an existing account is driven through `execBatchFromFactory`) |
| `0x3a4741bd` | `IMPLEMENTATION() → address` |

Event `AccountCreated(address indexed owner,address indexed account)` (`0xac631f30…`). Errors
`ZeroOwner()` `0x9905827b`, `InvalidOwner(address)` `0xb20f76e3`, OZ `FailedDeployment()`
`0xb06ebf3d`, `InsufficientBalance(uint256,uint256)` `0xcf479181`. **`AccountExists` is deleted** —
remove any handling of it.

## 3. ICollateralVenue → AaveV3Venue (`src/venues/AaveV3Venue.sol`), MorphoBlueVenue (`src/venues/MorphoBlueVenue.sol`)

Mutators are called BY the account; views take the account. `ICollateralVenue`'s signatures are
unchanged. `AaveV3Venue`'s **constructor changed** to `(IPoolAddressesProvider provider,
ICollateralRegistry registry)` — deploy order is registry → venue → register assets.

| selector | function | AaveV3Venue behaviour |
|---|---|---|
| `0xf2b9fdb8` | `supply(address asset,uint256 amount)` | **registry must point `asset` at THIS venue and have it enabled** (`AssetNotOffered`) → approve-exact → `Pool.supply(asset, amount, account, 0)` → approve 0 |
| `0xf3fef3a3` | `withdraw(address asset,uint256 amount) → uint256` | `Pool.withdraw(asset, amount, account)`; max = all; gated on nothing |
| `0x4b8a3529` | `borrow(address asset,uint256 amount)` | variable rate, `onBehalfOf` = account → then reads the account's GLOBAL health factor and reverts **`EntryHfTooLow(hf, floor)`** below `REGISTRY.entryHfFloorWad()` |
| — | `borrowAgainst(address collateralAsset,address loanToken,uint256 amount)` | **new (wave-2 M-MED-1):** what the router calls after it has just supplied `collateralAsset`. On Aave — one cross-collateral position — it is exactly `borrow`, floor included; on Morpho the debt lands in that collateral's market |
| `0x22867d78` | `repay(address asset,uint256 amount) → uint256` | approves min(amount, debt, what the account holds) — slice C: an exact-balance `max` repays everything held and leaves Aave's rounding unit, which `debt()` reports and `LoanDust` classifies; max with enough held = Aave's own full-debt path; `NothingToRepay` if 0 owed; `InsufficientLoanToken(asset, held, owed)` if the account holds none; gated on nothing |
| `0x6ad9f9df` | `healthFactor(address account) → uint256` | WAD; max when no debt |
| `0x5d462920` | `liquidationThresholdBps(address asset) → uint256` · `0xc2f2d31c` `maxLtvBps(address) → uint256` | live from the PoolDataProvider (0 = not listed, e.g. cbZEC) |
| `0xd449300d` | `debt(address,address)` · `0xcc218ece` `collateral(address,address)` · `0x99431ce5` `borrowRateRay(address)` | live |
| `0x238dafe0` | `enabled() → bool` | Aave true; Morpho true when built over ≥ 1 market, false over none (Sepolia) |
| `0xb883b058` | `assetPrice(address) → uint256` · `0x00d34411` `PROVIDER()` · `0x06433b1b` `REGISTRY()` | |

Errors: `ZeroAmount()` `0x1f2a2005`, `NothingToRepay()` `0xd32e7fc6`, **`InsufficientLoanToken(address,uint256,uint256)` `0xaed251f3`** (slice C), `ZeroAddress()` `0xd92e233d`,
**new:** `AssetNotOffered(address asset,address venue)` `0xbff4059e`, `EntryHfTooLow(uint256,uint256)`
`0xd40fd174` (same selector as the router's — identical signature).
**MorphoBlueVenue** — same `ICollateralVenue` selectors, constructor
`(IMorphoBlue morpho, ICollateralRegistry registry, address loanToken, bytes32[] marketIds)`. Differences
from Aave, per function: `supply` → `Morpho.supplyCollateral(params, amount, account, "")` after the same
registry gate (`AssetNotOffered`) and `NoMarket(asset)` if no market here takes it; `withdraw` →
`withdrawCollateral(params, amount, account, account)`, max = the position's collateral,
`NothingToWithdraw` if 0; `borrowAgainst(collateral, LOAN_TOKEN, amount)` → that collateral's market
(`NoCollateralPosition` if the account holds nothing there); `borrow` → only `LOAN_TOKEN`
(`NotLoanToken`), from the market with the most headroom among those whose oracle answers and that hold
`amount` of idle loan token (`NoCollateralPosition` if none holds collateral, **`NoMarketCanFill(amount)`**
if none can lend it — wave-2 M-LOW-1), then **`EntryHfTooLow`** against the WORST market's HF; `repay` →
worst market first, whole-market repays by shares, max = every market (`NothingToRepay` if 0), and never
gated by any market's oracle; `healthFactor` = min over markets, where a market with no debt never reads
its oracle and a market with debt whose oracle reverts reads **0** (wave-2 M-MED-2);
`liquidationThresholdBps` = `maxLtvBps` = live LLTV / 1e14 (0 = no market); `debt(account, LOAN_TOKEN)` =
Σ markets incl. interest Morpho will accrue this block, with no oracle read;
`borrowRateRay(LOAN_TOKEN)` = the highest market rate, per-second WAD × 365 days × 1e9. Extras:
`marketId((address,address,address,address,uint256)) → bytes32` `0xdf3fb657`, `MORPHO()` `0x3acb5624`,
`REGISTRY()`, `LOAN_TOKEN()`, `marketIdOf(address) → bytes32`, `marketParamsOf(address) → MarketParams`,
`collaterals() → address[]`, `oraclePrice(address) → uint256` (1e36-scaled loan per collateral).
Construction errors: `MarketNotCreated(bytes32)`, `MarketIdMismatch(bytes32,bytes32)`,
`WrongLoanToken(bytes32,address)`, `DuplicateCollateral(address)`. Selectors for all of these are in
`contracts/abi/oilskin-abi.json` (regenerated).

## 4. ILpVenue → SnuggleLpVenue  (`src/venues/SnuggleLpVenue.sol`)

```
LpOpenParams { bytes32 poolId; uint256 amount0; uint256 amount1; uint24 rangeWidthBps; uint64 rebalanceDelay;
               bool autoCompound; PriceBand band; uint256 deadline }
```
`amount0`/`amount1` are the engine pool's token0/token1 (see `poolTokens`); one may be zero
(single-sided; the engine does NOT swap — it mints a one-sided range on that token's side of the price, measured 2026-09-10, `ISnuggleVault` FACT 4); both non-zero = dual deposit at a centred range, bounce folded.

| selector | function | notes |
|---|---|---|
| `0x641b9c30` | `open(LpOpenParams) → uint256 positionId` | engine id minted to the account; a pool whose two tokens are the same is refused (`DegeneratePool`) |
| `0x02efe039` | `increase(uint256 positionId,uint256 amount0,uint256 amount1,PriceBand band,uint256 deadline) → uint256 newPositionId` | NEW id beside the old one (engine has no in-place increase) |
| `0x2623a0a9` | `close(uint256 positionId,PriceBand band) → (uint256 out0,uint256 out1,uint256 rewards)` | collect (fee) then withdraw (no fee); engine refusal bubbles |
| `0x812b00f2` | `closeMany(uint256[] positionIds,PriceBand band) → (uint256 out0,uint256 out1,uint256 rewards,uint256[] failed)` | per-id try/catch; the batch's pool comes from **the first id the caller actually owns**, so a stale id at index 0 is reported, never fatal; all-stale returns "everything failed" |
| `0x388a2c47` | `claim(uint256[] positionIds,PriceBand band,uint256 deadline) → (uint256 fees0,uint256 fees1,uint256 rewards,uint256[] failed)` | **changed**: was `claim(uint256[])` → 3 values. Band + deadline because every position is opened with `autoCompound = true`; foreign / mixed-pool / re-keyed ids are REPORTED |
| `0xf867d46b` | `positionsOf(address account) → uint256[]` | index enumeration; the end-of-list revert (empty on the live engine, or `Panic(0x32)`) is accepted only when gas (a 200,000 stipend, EIP-150), shape (canary = end = k + 1), liveness and `positions(id).owner` agree; else `EnumerationAmbiguous(fault, index, data)` / `EnumerationFailed` / `EngineUnreachable` — "cannot enumerate" is never "owns nothing" (`RISKS.md` §12) |
| `0xfbadbc39` | `poolTokens(bytes32 poolId) → (address token0,address token1,address pool)` | |
| `0x83966021` | `poolOf(uint256 positionId) → (bytes32 poolId,address owner)` | zeros once closed / re-keyed; never reverts |
| `0xd6473b12` | `poolSqrtPriceX96(bytes32 poolId) → uint256` | the band read, for quoting |
| `0xc653c866` | `dustFloor(address token) → uint256` | 10^decimals / 1e5 |
| views | `0x0b57b453` `performanceBps()` · `0x61d027b3` `treasury()` · `0x4785e8d4` `ENGINE()` · `0x99248ea7` `REWARD_TOKEN()` · `0x317fc02a` `MAX_PERFORMANCE_BPS()` (2000) · `0x34d4052a` `MIN_WIDTH_BPS()` (150) · `0xa555c806` `MAX_WIDTH_BPS()` (5000) · **`0x58e9ea7c` `MAX_BAND_BPS()` (2500)** · `0xc0f59c94` `MAX_REBALANCE_DELAY()` · `0x165693f5` `MAX_ENUMERATION()` (512) · **`0x13b7cac4` `PROBE_GAS()` (200000, slice A)** · `0x4fa8f116` `DUST_DIVISOR()` · `0x249d39e9` `BPS()` | |

Events: `LpOpened(address indexed account,bytes32 indexed poolId,uint256 indexed positionId,uint256 amount0,uint256 amount1,uint24 rangeWidthBps)` · `LpIncreased(…)` · `LpClosed(address indexed account,uint256 indexed positionId,uint256 out0,uint256 out1,uint256 rewards)` · `LpCloseFailed(address indexed account,uint256 indexed positionId,bytes reason)` · `ClaimSkipped(address indexed account,uint256 indexed positionId)` · `PerformanceFee(address indexed account,address indexed token,uint256 gross,uint256 fee)` · `FeeSkipped(…)` · `RefundFolded(…)` · `RefundLeft(…)`.

Errors: `FeeAboveCap(uint256,uint256)` `0x7159abd8` · `ZeroAddress()` `0xd92e233d` · `InvalidWidth(uint24)` `0xb2c36d99` · `InvalidDelay(uint64)` `0x2161f0ea` · `Expired(uint256)` `0xf80dbaea` · `ZeroAmounts()` `0x213c7cc5` · `PoolInactive(bytes32)` `0x3ec8a600` · `BandRequired()` `0x86e45e3c` · `PriceUnreadable(address)` `0x7fdeb21f` · `PriceOutOfBand(uint256,uint160,uint160)` `0xd92331cf` · `NotPositionOwner(uint256,address)` `0x606840e0` · `EngineUnreachable()` `0xd148f8ee` · **`EnumerationAmbiguous(uint8,uint256,bytes)` `0x52e93923`** (fault = `EnumerationFault` {InsufficientGas, ProbeOutOfGas, CanaryAnswered, TerminalShapeUnknown, InconsistentEnd, LivenessLost, PositionUnreadable, OwnerMismatch}, in that order) · `EnumerationFailed(bytes)` `0xb1440723` · `TooManyPositions(uint256)` `0x3ff29beb` · **new:** `BandTooWide(uint160,uint160,uint256)` `0x6dc2c272` · `DegeneratePool(bytes32,address)` `0x46b3c09f`. **`MixedPools()` is deleted.**

## 4b. ILpVenue → SlipstreamLpVenue  (`src/venues/SlipstreamLpVenue.sol`, 2026-09-11)

The direct venue over the cbZEC/USDC pool `0x0Fc4…8566` on the SECOND Slipstream deployment (NPM
`0xe1f8…8b53`, gauge `0x8779…81FB`; `VERIFIED-BASE-FACTS.md` Addenda 8–9). The same `ILpVenue`
selectors as §4 — `open` `0x641b9c30`, `increase` `0x02efe039`, `close` `0x2623a0a9`, `closeMany`
`0x812b00f2`, `claim` `0x388a2c47`, `positionsOf` `0xf867d46b`, `poolTokens` `0xfbadbc39`, `poolOf`
`0x83966021`, `performanceBps` `0x0b57b453`, `treasury` `0x61d027b3`, `poolSqrtPriceX96` `0xd6473b12`
— plus **`ownedPool(uint256 positionId,address account) → (bytes32 poolId,bool owned)`** `0xf19009ee`
(on BOTH venues and on `ILpVenue`: a staked NFT is the GAUGE's on the NFT's books and the account's
on the gauge's, so `poolOf` alone cannot answer "does this account own it") and
`positionRange(uint256 positionId,address account) → (int24 tickLower,int24 tickUpper,uint128
liquidity,bool staked)` `0x599b84b1` (the static range the dashboard shows) and
`earlyWithdrawPenalty(uint256 positionId,address account) → (uint256 penaltyBps,uint256 until)` `0xb31e1567`
(W3-LOW-5: the gauge factory's early-withdraw penalty on the AERO while the window is open — 10,000 bps
for 10 s on the cbZEC/USDC pool at the 2026-09-11 read; `PenaltyUnreadable(bytes)` `0xbd7e2085` when the
factory cannot be read), `toRatioToleranceBps((uint160,uint160) band) → uint256` `0xd956e520` (W3-LOW-2: the slippage
tolerance the to-ratio swap on open runs under — half the band's price span, capped at the adapter's
500) and `unstakedOverflow(address account) → (uint256 held,uint256 scanned)` `0xed7ef4b4` (wave 3,
W3-MED-2: how many unstaked Slipstream tokens the account holds versus how many `positionsOf`
scans — `held > scanned` means tokens beyond the window are not listed; the staked list is never
truncated). Its ONE pool id is
`POOL_ID()` `0xe0d7d0e9` = `bytes32(uint256(uint160(pool)))` (`@zyo/shared` `directPoolId`);
`poolTokens` of any other id returns zeros. Views: `POOL()` `0x7535d246`, `NPM()` `0x82ff8414`,
`GAUGE()` `0x7651b1e6`, `VOTER()` `0x8ebf2fd6`, `SWAP()` `0x04d84108`, `TOKEN0()` / `TOKEN1()` /
`TICK_SPACING()`, `REWARD_TOKEN()`, the width / band / enumeration bounds as §4.

Semantics that differ from §4: a single-sided `open` is swapped to the centred range's ratio through
`SWAP` (the pool-direct adapter, §6b) under a floor derived from the caller's band and capped at the
adapter's 5 %; the mint is two-sided, centred on the current tick, rounded outward to the tick
spacing; the NFT is `approve`d to the gauge and `deposit`ed when `VOTER.isAlive(gauge)`, else held
unstaked (`StakeSkipped`); `rebalanceDelay` / `autoCompound` are accepted and ignored (no
rebalancer); `close` = gauge `withdraw` (pays the AERO) or NPM `collect` (fees while unstaked) — fee
once per distinct token — then `decreaseLiquidity` / `collect` / `burn`, principal untaxed;
`closeMany` reports an id the gauge or the NPM refused and leaves it where it is; `claim` = gauge
`getReward` or NPM `collect`; `positionsOf` = gauge `stakedValues` + NPM `tokenOfOwnerByIndex`
filtered by pool, failing closed with **`PositionsUnreadable(bytes reason)`** `0x66c1607b`.

Events: `LpOpened` (as §4) · **`LpMinted(address indexed account,uint256 indexed positionId,int24
tickLower,int24 tickUpper,uint128 liquidity,uint256 used0,uint256 used1,bool staked)`**
(`0xd429198c…`) · `LpIncreased` · `LpClosed` · `LpCloseFailed` · `ClaimSkipped` · `PerformanceFee` ·
`FeeSkipped` · `RefundLeft` · **`StakeSkipped(address indexed account,uint256 indexed
positionId,bytes reason)`** (`0x5211a034…`) · **`SwappedToRatio(address indexed account,address
indexed tokenIn,uint256 amountIn,uint256 amountOut)`** (`0xc273386b…`).

Errors: the §4 set it shares (`FeeAboveCap`, `ZeroAddress`, `InvalidWidth`, `InvalidDelay`,
`Expired`, `ZeroAmounts`, `PoolInactive`, `BandRequired`, `PriceUnreadable`, `PriceOutOfBand`,
`BandTooWide`, `NotPositionOwner`, `DegeneratePool`, `TooManyPositions`) plus **`PoolMismatch(string
what)`** `0x260b52df` (constructor cross-checks: `pool.nft`, `pool.gauge`, `gauge.nft`, `gauge.pool`,
`gauge.rewardToken`, `swap.POOL`, `pool.tokens`), `PositionsUnreadable(bytes)` `0x66c1607b`,
**`RangeExcludesPrice(int24 tick,int24 tickLower,int24 tickUpper)`** `0x3168591b`.

## 5. CollateralRegistry  (`src/registry/CollateralRegistry.sol`, Ownable2Step)

Constructor: `(address initialOwner, uint256 entryHfFloorWad, uint256 timelockDelay)`.
`TIMELOCK_DELAY` is **immutable**, bounded `[1 hour, 30 days]`; the deploy script defaults it to
2 days (`REGISTRY_TIMELOCK_DELAY`).

| selector | function |
|---|---|
| `0x370f8b5c` | `maxOfferedLtvBps(address asset) → uint256` — `min(LT/floor, venue.maxLtvBps)`, no product cap (2026-09-12), 0 if disabled |
| `0xcc36b103` | `entryHfForLtv(address asset,uint256 ltvBps) → uint256` — **reverts** for a disabled / unlisted asset |
| `0xe2baeb4e` | `entryHfFloorWad() → uint256` |
| `0x0e68ec95` | `config(address asset) → (address venue,uint8 decimals,address priceFeed,bool enabled,string note)` |
| `0x9015d371` | `isEnabled(address) → bool` · `0xe1441a56` `venueOf(address) → address` · `0x71a97305` `assets() → address[]` |
| `0x7c9189e7` | `register(address asset,address venue,address priceFeed,bool enabled,string note)` (owner) — **first registration only** |
| `0xbf31b757` | `proposeVenue(address asset,address venue,address priceFeed)` (owner) — starts the clock |
| `0xb61826b2` | `acceptVenue(address asset)` (owner) — after `eta` |
| `0x06ad4a24` | `cancelVenueChange(address asset)` (owner) |
| `0x5e043289` | `pendingVenue(address asset) → (address venue,address priceFeed,uint40 eta)` — **watch this**: a non-zero `venue` is a pending redirection of user funds |
| `0x7267d09a` | `setEnabled(address asset,bool enabled,string note)` (owner) — **immediate in both directions** |
| `0xca0f0725` | `setEntryHfFloor(uint256 wad)` (owner, (1,10] WAD) — **immediate, not timelocked** |
| `0x5ba1c1a9` | `TIMELOCK_DELAY()` · `0x169070eb` `MIN_TIMELOCK_DELAY()` (1 h) · `0x2a083ca3` `MAX_TIMELOCK_DELAY()` (30 d) · `0x6a146024` `WAD()` · `0x249d39e9` `BPS()` |
| OZ | `owner() pendingOwner() transferOwnership(address) acceptOwnership() renounceOwnership()` |

Events `AssetRegistered(address indexed asset,address indexed venue,uint8 decimals,address priceFeed,bool enabled)` (`0x59232194…`) · `AssetEnabled(address indexed asset,bool enabled,string note)` (`0x42a6f4a9…`) · `EntryHfFloorSet(uint256)` (`0x98b6d9d9…`) · **new:** `VenueChangeProposed(address indexed asset,address indexed currentVenue,address indexed proposedVenue,address priceFeed,uint40 eta)` (`0xabc5b6d3…`) · `VenueChangeCancelled(address indexed asset,address indexed proposedVenue)` (`0xe2ab07b5…`) · `VenueChangeAccepted(address indexed asset,address indexed previousVenue,address indexed newVenue)` (`0xc81b3a86…`) (+ OZ ownership events). **New (wave-2 M-HIGH-1):** `previousVenues(address asset) → address[]` — every venue the asset was pointed at before the current one; `acceptVenue` appends the venue it replaces (a venue that becomes current again leaves the list). `StrategyRouter.unwind` repays EVERY venue in `[venueOf(asset), ...previousVenues(asset)]` the calling account still owes USDC on, lowest health factor first (one `VenueRepaid` each, 2026-09-09), and withdraws from the first venue holding the position, so a switch never strands an open position; opens still use `venueOf` only.

Errors `ZeroAddress()` `0xd92e233d` · `VenueDisabled(address)` `0x251897fd` · `UnknownAsset(address)` `0xad61e2ba` · `InvalidHfFloor(uint256)` `0x4a3368d2` · `VenueDoesNotKnowAsset(address)` `0xa2fef359` · **new:** `AssetNotEnabled(address)` `0xf6f24b83` · `InvalidTimelock(uint256)` `0x81872b29` · `AssetAlreadyRegistered(address)` `0x9690e53c` · `NoPendingChange(address)` `0x3c89b279` · `TimelockNotElapsed(uint40)` `0x4b1b3dcf` · OZ `OwnableUnauthorizedAccount(address)`.

cbZEC is registered `enabled=false, note="no collateral market on Base yet"` — show `note` verbatim.
`src/interfaces/ICollateralRegistry.sol` is the three-view interface the venue reads
(`entryHfFloorWad`, `isEnabled`, `venueOf`); it is not in the verify-abi contract list — use
`CollateralRegistry`'s ABI.

## 6. ISwapAdapter → AerodromeSwapAdapter  (`src/swap/AerodromeSwapAdapter.sol`)

| selector | member |
|---|---|
| `0xaa212198` | `swap(address tokenIn,address tokenOut,uint256 amountIn,uint256 quotedIn,uint256 quotedOut,uint16 maxSlippageBps,uint256 deadline,bytes routeData) → uint256 amountOut` |
| `0xea6f620b` | `minOutFor(uint256 amountIn,uint256 quotedIn,uint256 quotedOut,uint16 maxSlippageBps) → uint256` (pure — the same code the swap enforces) |
| `0xe229cd76` | `MAX_SLIPPAGE_BPS() → uint16` (500) · `0x249d39e9` `BPS()` · `0x32fe7b26` `ROUTER()` |

Called by the account; recipient is always the account; `routeData = abi.encode(int24 tickSpacing)`
(Slipstream `exactInputSingle`). Event
`Swapped(address indexed account,address indexed tokenIn,address indexed tokenOut,uint256 amountIn,uint256 amountOut,uint256 minOut)`
(`0xc9163c3b…` — it gained the enforced floor). Errors `ZeroAmount()` `0x1f2a2005` ·
`Expired(uint256)` `0xf80dbaea` · `SameToken()` `0x201b580a` · `InsufficientOutput(uint256,uint256)`
`0x2c19b8b8` · `ZeroAddress()` `0xd92e233d` · **new:** `ZeroQuote()` `0x69f8a2c0` ·
`SlippageTooHigh(uint16,uint16)` `0xe4617933`. **`ZeroMinOut()` is deleted.**

Live SwapRouter, code-verified 2026-09-06: **`0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5`**
(factory `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A`). The "UniversalRouter"
`0x6Cb442acF35158D5eDa88fe602Ef9Cf89694fFEa` that circulates publicly has **no code on Base** — do
not use it.

## 6b. ISwapAdapter → SlipstreamPoolSwapAdapter  (`src/swap/SlipstreamPoolSwapAdapter.sol`, 2026-09-11)

The pool-direct adapter for the ONE pool the verified SwapRouter cannot reach: the same `swap`
`0xaa212198` / `minOutFor` `0xea6f620b` / `MAX_SLIPPAGE_BPS` `0xe229cd76` (= 500) as §6, plus
**`uniswapV3SwapCallback(int256 amount0Delta,int256 amount1Delta,bytes data)`** `0xfa461e33` — the
pool's callback, accepted only from `POOL()` `0x7535d246`, only while a swap is in flight, only once,
paying the pool exactly the positive delta of the input token from the calling account
(`execFromPeripheral` → charged to a keeper's budget like any transfer). `routeData` =
`abi.encode(int24 tickSpacing)` as §6, and it must be the pool's (`WrongRoute(int24 given,int24
expected)` `0xf7364524`). Differences from §6, stated: the output is MEASURED as the account's
balance delta (never a return value); the input consumed must be exactly `amountIn`
(**`PartialFill(uint256 amountIn,uint256 consumed)`** `0x20aae256`, never half-done); the pair must
be the pool's (**`NotPoolPair(address,address)`** `0x0014ed04`); **`NotPool(address caller)`**
`0x4a1576a2`, **`NoSwapInFlight()`** `0x9af5fad2`, `Reentrancy()` `0xab143c06`. Views: `TOKEN0()`,
`TOKEN1()`, `TICK_SPACING()`, `BPS()`. Event `Swapped` as §6.

## 7. StrategyRouter  (`src/router/StrategyRouter.sol`) — stateless but for two per-account records (`entryHfWad` since A4, `solanaRecipient` since A5.1)

```
Permit2Pull      { uint256 nonce; uint256 deadline; bytes signature }
SwapQuote        { uint256 quotedIn; uint256 quotedOut; uint16 maxSlippageBps; bytes routeData }
OpenParams       { address collateralAsset; uint256 collateralAmount; Permit2Pull permit;
                   uint256 borrowAmount; bytes32 poolId; uint24 rangeWidthBps; uint64 rebalanceDelay;
                   bool autoCompound; PriceBand band; uint256 deadline }
BorrowOnlyParams { address collateralAsset; uint256 collateralAmount; Permit2Pull permit;
                   uint256 borrowAmount; uint256 deadline }
UnwindParams     { address collateralAsset; uint256[] positionIds; PriceBand band; SwapQuote swap;
                   uint256 repayAmount; uint256 withdrawAmount; uint256 deadline }
LpOnlyParams     { uint256 usdcAmount; bytes32 poolId; uint24 rangeWidthBps; uint64 rebalanceDelay;
                   bool autoCompound; PriceBand band; uint256 deadline }                      (2026-09-13, D6)
BurnParams       { uint256[] positionIds; PriceBand band; SwapQuote swap; uint256 burnAmount;
                   uint256 maxFee; uint32 minFinalityThreshold; uint256 deadline }            (2026-09-13, D6)
```

| selector | function | notes |
|---|---|---|
| `0x3c2639d6` | `openLeveragedLp(OpenParams) → (uint256 positionId,uint256 healthFactor)` | Permit2 pull → supply → borrow USDC → LP open (USDC single-sided; pool must contain USDC) |
| `0x16e05d79` | `openBorrowOnly(BorrowOnlyParams) → uint256 healthFactor` | **new** — the "hold" shape; same registry gate, deadline, floor and delta assertions; nothing deployed |
| `0x08435e75` | `unwind(UnwindParams) → (uint256 usdcFromLp,uint256 repaid,uint256 withdrawn,uint256 healthFactor)` | closeMany on the venue that says the account owns the first id (`ownedPool`: the engine venue first, then the direct one; stale ids reported at any index) → swap the non-USDC leg under the quote through THAT venue's adapter → repay on EVERY venue the account owes, lowest HF first, one `VenueRepaid` each (a fixed repay against zero debt is a no-op) → **since 2026-09-11** withdraw from EVERY venue holding the account's collateral, current pointer first, each gated on its own GLOBAL HF, one `VenueWithdrawn` each (`max` = all everywhere; a fixed amount is a total in venue order, `CollateralShort` if unmet). Works on a DISABLED ASSET; refuses through a DISABLED VENUE. Selector unchanged |
| `0x780469bb` | `sweep(address[] tokens)` | whole balances to `account.owner()` — earnings to the wallet |
| `0x7d24b87e` | `openLpOnly(LpOnlyParams) → uint256 positionId` | **2026-09-13, D6 / A5.1** — USDC the account already holds (arrived by CCTP from the user's Solana account, or idle) → `lpVenue.open` single-sided; no supply, no borrow, `entryHfWad` untouched; `ZeroAmount` / `UsdcShort(asked, held)` / `PoolWithoutUsdc` / `UnknownPool` / `Expired`; balance-delta assertions |
| `0xf182211c` | `setSolanaRecipient(bytes32 recipient)` | **2026-09-13** — the account's USDC TOKEN ACCOUNT on Solana as CCTP's `mintRecipient`, set by the owner through a plain `exec`; zero clears; `closeLpAndBurn` burns only to it |
| `0xc01c93d7` | `closeLpAndBurn(BurnParams) → (uint256 usdcFromLp,uint256 burned)` | **2026-09-13** — `unwind`'s close-and-settle leg (same `ownedPool` rule, band, quote floor, dust-leg rule), then approve TokenMessengerV2 for exactly `burned` → `depositForBurn(burned, SOLANA_DOMAIN, solanaRecipient[account], USDC, 0, maxFee, minFinalityThreshold)` → approve 0; `burnAmount = max` = the whole balance after the close; `CrossChainDisabled` on a deployment without a messenger, `NoSolanaRecipient(account)`, `MaxFeeNotBelowAmount(maxFee, amount)`, `UsdcShort`, `ZeroAmount`; the keeper's rung action for a cross-chain position under a grant whose USDC budget the approve is charged against |
| views (2026-09-13) | `0x3ee4e060` `CCTP_MESSENGER()` · `0x4191ea87` `SOLANA_DOMAIN()` · `0x1986f661` `solanaRecipient(address) → bytes32` | Circle's TokenMessengerV2 (`VERIFIED-SOLANA-FACTS.md` Addenda 1, 3) and Solana's domain 5; `address(0)` / 0 on Base Sepolia (the loop is off there) |
| views | `0x06433b1b` `REGISTRY()` · `0xbe14899f` `LP_VENUE()` · `0x04d84108` `SWAP()` · `0x6afdd850` `PERMIT2()` · `0x89a30271` `USDC()` · **new (2026-09-11)** `0x37829814` `LP_VENUE_DIRECT()` · `0x44757dfe` `SWAP_DIRECT()` (both zero on a deployment without the direct venue) | |

Events `LeveragedLpOpened(address indexed account,address indexed collateralAsset,uint256 collateralAmount,uint256 borrowed,bytes32 indexed poolId,uint256 positionId,uint256 healthFactor)` (`0x6c145e8b…`) · **new** `BorrowOnlyOpened(address indexed account,address indexed collateralAsset,uint256 collateralAmount,uint256 borrowed,uint256 healthFactor)` (`0xcc55d9e7…`) · `LeveragedLpUnwound(address indexed account,address indexed collateralAsset,uint256 closedCount,uint256 failedCount,uint256 usdcFromLp,uint256 repaid,uint256 withdrawn,uint256 healthFactor)` (`0x56a4f848…`; `healthFactor` is the worst across the venues named for the asset) · **new (2026-09-09)** `VenueRepaid(address indexed account,address indexed venue,uint256 repaid)` (`0x327daf51…`, one per venue the repay reached, worst first) · **new (2026-09-11)** `VenueWithdrawn(address indexed account,address indexed venue,uint256 withdrawn)` (`0x117e568a…`, one per venue the withdraw leg reached, current pointer first) · **new (2026-09-12, NI-HIGH-1)** `DustLegKept(address indexed account,address indexed token,uint256 amount)` (`0xac2f9283…`, a non-USDC leg the caller's quote could not price — the adapter's floor for it is zero — left in the account instead of reverting the unwind) · `Swept(address indexed account,address indexed token,address indexed to,uint256 amount)` (`0xddb9e887…`).

Errors `ZeroAddress()` `0xd92e233d` · `Expired(uint256)` `0xf80dbaea` · `AssetNotRegistered(address)` `0x1a2a9e87` · `AssetDisabled(address asset,string note)` `0x121ab360` · `VenueDisabled(address)` `0x251897fd` (**now reachable on `unwind`**) · `ZeroBorrow()` `0x774257f7` · `PoolWithoutUsdc(bytes32)` `0x3a20909e` · `EntryHfTooLow(uint256,uint256)` `0xd40fd174` · `ExitHfTooLow(uint256,uint256)` `0x73cd1b85` · **new:** `RouterBalanceChanged(address token,uint256 balanceBefore,uint256 balanceAfter)` `0xc690fd22` · **new (2026-09-11):** `UnknownPool(bytes32 poolId)` `0x180b8555` (neither LP venue serves it) · `CollateralShort(uint256 asked,uint256 withdrawn)` `0xb73f0d17` (a fixed withdraw the venues could not meet) · `AmbiguousPositionId(uint256 positionId)` `0x22222d01` (W3-LOW-1: an id both LP venues claim for the account; close it through the venue). **`RouterHoldsBalance` is deleted — remove every reference.** Constructor (2026-09-11): `(registry, lpVenue, swapAdapter, permit2, usdc, lpVenueDirect, swapAdapterDirect)` — the last two together or both zero.

Cross-chain events (2026-09-13): `LpOnlyOpened(address indexed account,uint256 usdcAmount,bytes32 indexed poolId,uint256 positionId)` (`0x1a6874c0…`) · `SolanaRecipientSet(address indexed account,bytes32 recipient)` (`0xf088ad1a…`) · `BurnedToSolana(address indexed account,uint256 amount,bytes32 indexed recipient,uint256 maxFee,uint32 minFinalityThreshold,uint256 closed,uint256 failedCount,uint256 usdcFromLp)` (`0x87cda9b4…`). Circle's own `DepositForBurn` and `MessageSent` fire from the messenger and the transmitter in the same transaction (`interfaces/ICctpV2.sol`, §9).

Cross-chain errors (2026-09-13): `ZeroAmount()` `0x1f2a2005` · `UsdcShort(uint256 asked,uint256 held)` `0xfa82ac0c` · `CrossChainDisabled()` `0x8ecd0542` · `NoSolanaRecipient(address)` `0x6c99c2d5` · `MaxFeeNotBelowAmount(uint256 maxFee,uint256 amount)` `0x78b7d035`.

## 8. PythOracleAdapter (v1.1, built, UNUSED)  (`src/oracle/PythOracleAdapter.sol`)

`0xd828d374` `refresh(bytes[] updateData) payable` — posts the Pyth update (fee from msg.value, rest refunded); permissionless, and nothing requires it in the same transaction as the read (the same-transaction gate was removed — wave-2 P-MED-1) · `0xa035b1fe` `price() → uint256` — Morpho `IOracle`: 1 base unit in quote units × 1e36; reverts Pyth `StalePrice` past `maxAge`, `PegBreak(uint256 pythE8,uint256 twapE8,uint256 deviationBps)` `0x5963163c` beyond `maxDeviationBps` vs the Aerodrome cbZEC/USDC TWAP · `0x59e02dd7` `peek() → (pythPriceE8,publishTime,twapE8,deviationBps)` (diagnostic, no gate) · `0x48534330` `twapPriceE8()` · immutables `PYTH PRICE_ID POOL BASE_TOKEN QUOTE_TOKEN BASE_DECIMALS QUOTE_DECIMALS BASE_IS_TOKEN0 maxAge maxDeviationBps twapWindow`. Event `Refreshed(uint256,uint256,uint256)` (`0x9ff2bd21…`). Other errors `ZeroAddress InvalidConfig NonPositivePrice(int64) InsufficientFee(uint256,uint256) RefundFailed PoolTokensMismatch(address,address) TickOutOfRange(int24)`.

## 9. External surfaces we encode against (verified selectors)

* `ISnuggleVault`: `positions(uint256)` **`0x99fbab88`**, `userPositions(address,uint256)`
  **`0x5e1b4d99`** (index getter, reverts past the end — FACT 1; `userPositions(address)` does NOT
  exist), `approvedPools(bytes32)` `0x35d75781`, `deposit` `0x948d2b91`, `depositSingleSided`
  `0xc1e27131`, `withdraw(uint256,bool)` `0x38d07436`, `harvest` `0xddc63262`, `claimStakingRewards`
  `0x8fad2627`, `updateParameters` `0x3c351238`, `poolIds` `0x69883b4e` / `poolIdsCount` `0x3fd37a6a`.
* `IAerodromeCLPool`: `slot0()` **`0x3850c7bd`**, `liquidity()` `0x1a686502`, `token0()` `0x0dfe1681`,
  `token1()` `0xd21220a7`, `tickSpacing()` `0xd0c93a7c`, `fee()` `0xddca3f43`, `observe(uint32[])`
  `0x883bdbfd` (TWAP; probe before v1.1).
* `IPermit2.permitTransferFrom(((address,uint256),uint256,uint256),(address,uint256),address,bytes)`
  `0x30f28b7a`; `DOMAIN_SEPARATOR()` `0x3644e515`.
* `IPyth`: `getPriceNoOlderThan` `0xa4ae35e0`, `getPriceUnsafe` `0x96834ad3`, `getUpdateFee`
  `0xd47eed45`, `updatePriceFeeds` `0xef9e5e28`.
* The keeper additionally pins Chainlink `getRoundData(uint80)` `0x9a6fc8f5` (per-feed heartbeat
  measurement) and ERC-20 `decimals()`; see `agent/scripts/verify-abi.mjs` (71 checks, including the
  `ICollateralVenue` fragments the venue-aware reader encodes, pinned against the interface and `MorphoBlueVenue`).

## 10. Addresses (Base 8453) — from VERIFIED-BASE-FACTS only, mirrored in `script/Deploy.s.sol::BaseAddresses`

*Added 2026-09-11 (Addenda 8–9):* the second Slipstream CLFactory `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`
(`AERODROME_CL_FACTORY_2`), its NonfungiblePositionManager `0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53`
(`AERODROME_NPM_2`) and the cbZEC/USDC gauge `0x8779E34E5d38358B0cB957c553B40cC1208C81FB`
(`AERODROME_CBZEC_USDC_GAUGE`) — what `SlipstreamLpVenue` binds to; the deploy guard checks the pool
names all three.

USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` · WETH `0x4200000000000000000000000000000000000006` · cbBTC `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` · cbZEC `0xB2000000000000000000008501b13360000cb2EC` (B20) · AERO `0x940181a94A35A4569E4529A3CDfB74e38FD98631` · Aave provider `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D` / pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` / data provider `0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A` / oracle `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156` · Chainlink cbBTC/USD `0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D`, ETH/USD `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` · Pyth `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`, ZEC/USD id `0xbe9b59d1…bb24` · Aerodrome cbZEC/USDC pool `0x0Fc47C17AF86078d809358db1b4db2DeBC988566` · **Aerodrome Slipstream SwapRouter `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5`** and **Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`** (both code-verified 2026-09-06) · Morpho `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` · Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` · Snuggle engine `0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55`.

**Our own deployment addresses do not exist: nothing is deployed and nothing has been broadcast.**
