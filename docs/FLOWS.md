# Flows — the exact calls the user signs

Every flow below is what `web/lib/plan.ts` builds and `web/lib/execute.ts`
runs, encoded from `contracts/abi/oilskin-abi.json` (`web/test/abi.test.ts`
compares the outer *and* inner selectors of every write against the compiled
artifact and fails on drift), and what the contracts then do. The wallet is
asked to sign only after `estimateGas` and an ETH-balance check pass and the
chain id is 8453 (`execute.ts: guardedWrite`). Nothing is signable until
`NEXT_PUBLIC_OILSKIN_FACTORY` / `_ROUTER` point at a deployment
(`plan.ts: planIsSignable`), and there is no deployment yet.

Abbreviations: HF = health factor, LT = liquidation threshold, LTV =
loan-to-value, LP = liquidity provision, EIP = Ethereum Improvement Proposal.

## 0 · The calling convention (read this first)

`Call { address target; uint256 value; bytes data; bool callback }`.
`callback` is the **peripheral opt-in** and defaults to false: a call with it
unset gives the target no rights over the account. So:

| you are calling | use |
|---|---|
| the router, a venue, the swap adapter | `execWithCallback(target, 0, data)`, or a `Call` with `callback: true` inside `execBatch` |
| a token, a pool, Permit2 | `exec(target, 0, data)`, or `callback: false` |
| the router, first time (no account yet) | `factory.createAccountAndExec([{router, 0, data, callback: true}])` |

A plain `exec` to the router now reverts `NotActivePeripheral` inside the
router — that is the fix, not a bug. On the **keeper** path the flag on the
call is ignored and the account reads `Permission.allowCallback` from the
grant instead: the owner decides which target may act back on the account,
never the keeper.

`factory.accountOf(wallet)` (CREATE2 prediction) is read first. It is the
Permit2 **spender** the user signs for and the address every position will
belong to, whether or not it has been deployed.

## 1 · Deposit — leveraged LP

```mermaid
sequenceDiagram
    actor U as Wallet
    participant P2 as Permit2
    participant F as OilskinAccountFactory
    participant A as OilskinAccount (owner = U)
    participant R as StrategyRouter
    participant AV as AaveV3Venue → Aave Pool
    participant LV as SnuggleLpVenue → engine

    Note over U: (1) approve — only if the collateral allowance to Permit2 is below the amount
    U->>P2: collateral.approve(Permit2, max)   [transaction, plain exec]
    Note over U: (2) EIP-712 signature, no transaction
    U->>U: sign PermitTransferFrom{token, amount, spender = accountOf(U), nonce, deadline}
    Note over U: web reads lpVenue.poolSqrtPriceX96(poolId) → band = price ± tolerance
    Note over U: (3) one transaction
    alt first-time user
        U->>F: createAccountAndExec([{router, 0, openLeveragedLp(p), callback: true}])
        F->>A: clone + initialize(U, calls) — or execBatchFromFactory if the clone already existed
    else account exists
        U->>A: execWithCallback(router, 0, openLeveragedLp(p))
    end
    A->>R: openLeveragedLp(p)  (msg.sender = A)
    R->>R: snapshot its own balance of the collateral asset, USDC and both pool tokens
    R->>A: execFromPeripheral: Permit2.permitTransferFrom(permit, {to: A, amount}, U, sig)
    R->>AV: execNestedPeripheral: supply(asset, amount) → registry must offer the asset HERE · approve · Pool.supply(onBehalfOf = A) · approve 0
    R->>AV: execNestedPeripheral: borrow(USDC, borrowAmount) → Pool.borrow(onBehalfOf = A) → VENUE reverts EntryHfTooLow below the floor
    R->>AV: healthFactor(A) re-read; the router raises its own EntryHfTooLow as a second named check
    R->>LV: execNestedPeripheral: open({poolId, USDC single-sided, width, delay, autoCompound, band, deadline})
    LV->>LV: band vs pool.slot0() · band width ≤ MAX_BAND_BPS · depositSingleSided → id minted to A · fold any refund
    R->>R: assert each snapshotted balance is UNCHANGED (RouterBalanceChanged otherwise)
    Note over U: (4) optional — keeper protection grant (see §5)
```

`OpenParams` (`StrategyRouter.sol`): `collateralAsset`, `collateralAmount`,
`permit{nonce, deadline, signature}`, `borrowAmount` (> 0), `poolId`,
`rangeWidthBps` (total tick span, [150, 5000]), `rebalanceDelay` (seconds),
`autoCompound`, `band{minSqrtPriceX96, maxSqrtPriceX96}`, `deadline`. Web
defaults: deadline 20 minutes, band tolerance 100 bps of price in Simple mode,
up to 300 in Advanced (`plan.ts`). What the chain refuses: an asset that is not
enabled (`AssetDisabled(asset, note)` — cbZEC — or `AssetNotOffered` at the
venue), a disabled venue (`VenueDisabled`), a pool without USDC, a pool whose
two tokens are the same (`DegeneratePool`), a width outside the bounds, a band
wider than `MAX_BAND_BPS` (`BandTooWide`), a price outside the band, a
post-borrow HF below the 1.55 floor, an expired deadline, a wrong-spender or
reused Permit2 nonce.

## 2 · Deposit — borrow and hold (no LP)

Same steps (1) and (2). Step (3) is **one router call**, not a hand-built
batch:

```
execWithCallback(router, 0, openBorrowOnly({
  collateralAsset, collateralAmount, permit{nonce, deadline, signature},
  borrowAmount, deadline
}))                      — or the same call through factory.createAccountAndExec
```

Permit2 pull → `venue.supply` → `venue.borrow(USDC)` → the borrowed USDC lands
in the account and nothing is deployed; the router emits `BorrowOnlyOpened`.

**The entry-HF floor is chain-enforced on this path.** It used to be a UI guard
only: the shipped flow built `execBatch([permit2, supply, borrow])`, never
touched the router, and opened a first-time user at HF 1.07 against an
advertised 1.55. `AaveV3Venue.borrow` now reverts `EntryHfTooLow(hf, floor)`
itself, so the old batch would revert too — and the product no longer builds
it (`web/test/plan.test.ts` asserts the three-call shape cannot be produced by
either entry point).

What a user hand-writing their own calldata can still do, stated plainly:
`account.exec(aavePool, borrow(...))` goes straight to Aave and can open at
Aave's full LTV, below Oilskin's floor. That is the same owner-only door the
exit guarantee is made of; closing it would let the account be trapped by its
own policy. What is impossible is any sequence *through the Oilskin venue*
that opens debt below the floor — which is every sequence the web, the keeper,
the router or `createAccountAndExec` can produce.

## 3 · Unwind — close, repay, withdraw

Before signing, `web/lib/quote.ts` **fetches a real quote**: the pool's live
`sqrtPriceX96` with token order and `decimals()` read (not assumed),
cross-checked against the Chainlink price Aave uses, with the enforced floor
read back from `AerodromeSwapAdapter.minOutFor`. A pool more than 3 % from the
oracle is refused outright. Every failure is a refusal with a sentence —
never a smaller number.

```
execWithCallback(router, 0, unwind({
  collateralAsset, positionIds: [ids in one pool], band,
  swap: { quotedIn, quotedOut, maxSlippageBps ≤ 500, routeData: abi.encode(int24 tickSpacing) },
  repayAmount: max, withdrawAmount: max, deadline
}))
```

On chain (`StrategyRouter.unwind`): the batch's pool is derived from the first
id the account **actually owns** → `SnuggleLpVenue.closeMany(ids, band)` — each
id: collect yield (`claimStakingRewards` → `harvest`), take `performanceBps` of
the gain once per distinct token, then `withdraw(id)`; refused, re-keyed or
foreign ids are reported in `failed` and skipped, **at index 0 like anywhere
else** → `AerodromeSwapAdapter.swap(nonUsdcToken → USDC, amount, quotedIn,
quotedOut, maxSlippageBps, deadline, routeData)`, which enforces
`amountIn × quotedOut / quotedIn × (10000 − maxSlippageBps) / 10000` on the
amount actually swapped → `AaveV3Venue.repay(USDC, min(debt, held))` — a fixed
repay against zero debt is a **no-op, not a revert** → `AaveV3Venue.withdraw
(asset, all)` → if a withdrawal happened and any debt remains, the **global**
health factor must be ≥ the floor or `ExitHfTooLow`.

Works on a **disabled asset**; refuses through a **disabled venue**
(`VenueDisabled`) — then the owner's raw `exec` to Aave is the escape.
Proceeds land in the account; nothing is sent to the wallet here — see §4 for
`sweep`.

There is no `swapMinOut` any more, so the old "degrade the floor to 1 when the
cache is empty" fallback cannot be expressed at all: `ZeroQuote` is the
adapter's answer to an unpriced swap, and the web refuses to build the call.

## 4 · Claim — rewards to the wallet

```
account.execBatch([
  { SnuggleLpVenue, claim(ids, band, deadline), callback: true },   // one pool per call; net of performanceBps
  { StrategyRouter,  sweep([AERO, token0, token1]), callback: true } // whole balances → account.owner()
])
```

`claim` carries the same price band and deadline as every other
engine-touching entry point (every position is opened with `autoCompound =
true`, so a compounding harvest inside the engine can swap) and returns
`(fees0, fees1, rewards, uint256[] failed)`: an id the account does not own, or
one the engine re-numbered, or one in another pool is **reported**, never a
revert. `sweep` can pay only `IOilskinAccount(msg.sender).owner()`; it is the
single path from the account to the wallet that the router offers.

## 5 · Keeper protection grant (optional, revocable)

```
account.grant(keeper, Permission{
  target: StrategyRouter,
  selector: unwind((address,uint256[],(uint160,uint160),(uint256,uint256,uint16,bytes),uint256,uint256,uint256))  = 0x08435e75,
  maxValuePerPeriod: 0,
  tokenLimits: [{USDC, 2× the debt}, {collateral, 2× debt-equivalent}, {AERO, 1e23}, {each pool token, …}],
  period: 86400, expiry: now + 30 days,
  allowCallback: true
})
```

**`allowCallback: true` is required.** The router must call back into the
account to close, repay and withdraw; a grant without it *looks live in the UI*
and every dispatch reverts `NotActivePeripheral` inside the router while the
position rides to liquidation. The keeper classifies that as a permanent
configuration error, escalates it, and broadcasts nothing; the dashboard's
keeper panel shows it as the distinct state `cannot-act`.

One grant is enough and one grant is all the keeper needs — the plan is a
single root `StrategyRouter.unwind` per pool. **Do not sign a
`SnuggleLpVenue.closeMany` grant**; it is no longer used and would widen the
keeper's surface for nothing. `web/test/keeper.test.ts` reads the keeper's own
`KEEPER_GRANT_SHAPE` from `agent/src/abi/oilskin.ts` and asserts the grant the
web asks users to sign is exactly the grant the keeper plans.

Budgets are product-policy caps sized at sign time
(`web/lib/execute.ts: grantTokenLimits`: 2× the whole **debt** in USDC — not
the position at sign time, because a compounded LP grows — 2× the
borrow-equivalent in the collateral and each pool token at the snapshot price,
`1e23` = 100,000 AERO per day). The chain refuses a zero line and a duplicate
token, and the web refuses both locally rather than letting the user pay gas to
learn it. A re-grant inside a live period does **not** refill the budget: spend
carries forward per token. What the budgets do **not** bound: value moved by a
protocol the call tree talks to (an Aave `withdraw`, an engine withdrawal) —
the grant's target and any peripheral it nests into are trusted code, which is
exactly why `allowCallback` exists and defaults to false. `revoke(keeper,
router, unwind)` or `revokeAll()` ends it; either is an owner transaction, and
`revoke` on a key that was never granted reverts `NotRevocable` instead of
emitting a `Revoked` event that means nothing.

## 6 · Keeper action — what the keeper sends

The keeper signs nothing on the user's behalf; it sends its own transaction to
the user's account (`agent/src/dispatch/keeperDispatcher.ts`), after reading
`grantOf` for the root call and simulating from its own address:

```
account.execAsKeeper([
  { StrategyRouter, unwind({ positionIds: ids_pool1, band, swap, repayAmount: 0,   withdrawAmount: 0, deadline }), callback: false },
  …one per pool, most valuable first…
  { StrategyRouter, unwind({ positionIds: ids_poolN, band, swap, repayAmount: max, withdrawAmount: 0, deadline }), callback: false }
])
```

**One root call per pool, and nothing else** — the same selector and target the
user signed. `unwind` closes the ids itself through the nested path, so no
second grant is needed; the account takes `allowCallback` from the grant, not
from the `callback: false` on the call. Only the last call repays, so one repay
sweeps everything the earlier closes produced plus any idle USDC.

Which ids: **a fraction of the account's LP value**, not of the id count — ⅓ at
`repay`, ⅔ at `derisk`, everything at `emergency-unwind` — each id priced by
simulating the very call that would close it, and the whole action additionally
capped by the USDC actually needed to reach the rung's disarm. The band is the
pool's live `sqrtPriceX96` ± `BAND_TOLERANCE_BPS`; the swap quote comes from
that same live price. Collateral is never withdrawn (`withdrawAmount: 0`). The
account charges every direct token operation in the tree to the grant's budgets
and reverts `NotGranted` / `TokenNotBudgeted` / `TokenBudgetExceeded` /
`UnbudgetableSelector` otherwise.

The `warn` rung produces no transaction at all — it is a notification, and the
UI says so. It reaches the log channel and, when `NOTIFY_WEBHOOK_URL` is set,
an HTTP endpoint; there is no mailer and no per-user routing yet
(`RISKS.md` §10).

## 7 · Spot — CoW Protocol (Advanced mode)

1. `TradingSdk.getQuote({kind: SELL, owner, sellToken, buyToken, amount,
   slippageBps})` (`web/lib/cow.ts`).
2. If `allowance(sellToken, owner → vaultRelayer) < amount`:
   `sellToken.approve(vaultRelayer, amount)` [transaction], with
   `vaultRelayer` read from `GPv2Settlement.vaultRelayer()` — not typed.
3. The wallet signs the EIP-712 order (`postSwapOrderFromQuote`); the order is
   posted to the CoW order book.
4. `getOrder(orderUid)` polled: `open → fulfilled | expired | cancelled`. An
   unfilled order expires with nothing spent. Oilskin never holds the tokens.
   Slippage is bounded [10, 300] bps with a warning above 100 (`SLIPPAGE_*`).

cbZEC is one of the four spot tokens; its address is pinned and any other
`0xb2000…` address is flagged counterfeit (shared `classifyCbZecAddress`).
Exercised only in demo mode so far (no wallet in the build container).

## 8 · The user can always leave without Oilskin

Every position is the account's, and `exec` is owner-only with no other gate:
`account.exec(AavePool, withdraw(...))`, `account.exec(engine, withdraw(id,
false))`, `account.exec(token, transfer(wallet, amount))` all work with no
router, no venue, no registry state and no grant — and now genuinely as *plain*
calls, granting those targets nothing. The property
`invariant_userCanAlwaysExitViaExec` in
`contracts/test/invariant/Invariants.t.sol` probes it under snapshot after
random sequences, a glitching engine, a disabled asset, and token donations to
every peripheral.
