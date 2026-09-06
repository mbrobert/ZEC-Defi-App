# Risks — what can go wrong, what mitigates it, what does not

Written for the Base-first v1 tree of 2026-09-05. Every mitigation names the
code that enforces it; a mitigation without a code path is marked **plan**.
"Mitigated" never means "eliminated". The same list, in shorter words, is
shown in the app before every signature (`web/lib/copy.ts: RISKS`, thirteen
items; `prototype/*.html`, ten items).

Abbreviations: KYC = Know Your Customer; EEA = European Economic Area; HF =
health factor; LT = liquidation threshold; LTV = loan-to-value; IL =
impermanent loss; LP = liquidity provision; LLTV = liquidation loan-to-value
(Morpho's term); TWAP = time-weighted average price; MEV = maximal extractable
value; RPC = remote procedure call; DEX = decentralised exchange; ABI =
application binary interface; CI = continuous integration.

## 1 · Custodial entry (cbZEC)

**Risk.** cbZEC exists only because Coinbase holds the ZEC behind it. The only
way to mint it is to deposit ZEC into a Coinbase account and "Send ZEC on
Base"; the only way back is to send cbZEC to Coinbase and withdraw ZEC to a
**transparent** address. Coinbase knows the person, the amounts and the
destination address. Reserves sit in transparent t-addresses with no
third-party attestation and no stated cadence (proof-of-reserves page,
2026-09-02: 570.96 ZEC held against 551.34 cbZEC — `BASE-PIVOT-2026-09.md` §1).

**Mitigates.** Nothing technical. The product says so on the onboarding page
(`web/app/onboard/page.tsx`, `web/lib/onboarding.ts`) and in every review
sheet, and does not use the words "private", "shielded", "non-custodial" or
"locked payout address" about the entry (grep-tested across `web/app`,
`web/components`, `web/lib` in `web/test/copy.test.ts`; `prototype/test/
_harness.mjs: FORBIDDEN`). A holder who already has cbBTC or WETH never touches
this path.

**Does not.** Anyone who buys cbZEC on Aerodrome instead of wrapping still
depends on Coinbase's custody for the value of the token.

## 2 · KYC

**Risk.** Full KYC at Coinbase both ways. The wrap ties a Base address to a
verified identity, which then links to every position that address opens.

**Mitigates.** Stated on onboarding and review (`onboarding.ts`, `copy.ts:
kyc`). Nothing else.

## 3 · Jurisdiction

**Risk.** Wrap/unwrap is excluded in 100+ jurisdictions — all of the EEA,
Australia, Brazil, Singapore, Canada, Japan and New York among them; only the
US outside New York is confirmed, the UK is unverified (`BASE-PIVOT-2026-09.md`
§1, read 2026-09-04).

**Mitigates.** The onboarding page asks the jurisdiction **first**
(`web/lib/onboarding.ts: JURISDICTIONS`, `web/app/onboard/page.tsx`) and points
excluded users at spot / cbBTC / WETH instead. Buying cbZEC on Base and using
cbBTC/WETH are unaffected.

**Does not.** The check is self-declared; it is information, not enforcement.
Coinbase enforces its own rules at its own door.

## 4 · B20 issuer powers: seize, pause, rebase

**Risk.** cbZEC is a Base B20 precompile (`eth_getCode` returns `0xef`), not a
plain ERC-20. The standard gives the issuer blocklists, `burnBlocked` (seize,
not merely freeze), granular pause, and a rebase `multiplier()` on
`balanceOf` (live value `1e18` on 2026-09-05; `owner()` and `paused()` revert —
not exposed). Whether any restrictive policy is configured is not readable
from an explorer today.

**Mitigates (code).** Every contract path that can hold cbZEC survives a token
whose balance moves under it: keeper budgets are charged from calldata
amounts, never balance snapshots (`OilskinAccount._decodeTokenOp`); the venue
computes refunds and gains as bounded deltas that a rebase can only shrink
(`SnuggleLpVenue._refund`, `_gain`); a blocked leg is skipped and reported,
never bricking the rest of an exit (`closeMany` try/catch, `FeeSkipped`,
`ClaimSkipped`). `contracts/test/B20.t.sol` (10 tests) drives
`MockB20` through rebase up and down, blocked account, blocked treasury, paused
reward token, blocked swap. `VERIFIED-BASE-FACTS.md` records the live
`multiplier()` read and the fork test `test_fork_cbzecIsAB20WithLiveMultiplier`
re-reads it.

**Does not.** A seized or paused balance is gone or frozen for the user
regardless of what our contracts do. **The app's disclosure text says
"Whether any restrictive policy is configured is an on-chain read Oilskin
performs before touching cbZEC" — no shipped code performs that read**
(`grep multiplier contracts/src web/lib` finds nothing outside the fork
test). Either the read ships or the sentence goes: listed as must-fix in
`CHANGELOG.md`.

## 5 · cbZEC peg

**Risk.** cbZEC's 1:1 value to ZEC is a Coinbase promise, not a mechanism. In
a Coinbase incident cbZEC trades below ZEC and a ZEC/USD oracle overvalues
the collateral. Total supply was 603.25 cbZEC on 2026-09-05; the Aerodrome
cbZEC/USDC pool priced it at ≈1,020 USDC against Pyth's stale $1,035.20.

**Mitigates (v1).** cbZEC is not collateral anywhere in v1
(`CollateralRegistry` `enabled = false`; `StrategyRouter` reverts
`AssetDisabled`), so the peg cannot cause a liquidation through Oilskin today.
**Plan (v1.1):** `PythOracleAdapter.price()` reverts `PegBreak` when the pool
TWAP and Pyth ZEC/USD diverge beyond `maxDeviationBps` — built, tested
(15 tests), **not deployed and not used**.

**Does not.** Spot buyers of cbZEC and cbZEC LP holders carry the peg risk in
full; nothing in the product hedges it.

## 6 · cbZEC liquidity for liquidations

**Risk.** ≈$0.7M of DEX depth (2026-09-05). A liquidator who seizes even
$200K of cbZEC collateral has to sell into that pool and will move the price
badly; that is how lending markets accrue bad debt. Any cbZEC lending market
— ours or Aave's — is only as safe as cbZEC's exit liquidity, and that is out
of our hands.

**Mitigates.** No cbZEC collateral market exists and v1 does not create one.
**Plan:** a liquidity study sets the depth gate and LLTV before any v1.1
market (`BASE-PIVOT-2026-09.md` §3a).

**Does not.** The cbZEC/USDC gauge has `rewardRate() = 0`; cbZEC LP earns
nothing today (`services/yield`: `no_emissions`), so nothing in the product
draws liquidity there either.

## 7 · Our own market (if v1.1 ships)

**Risk.** Morpho Blue market creation is permissionless and immutable; if
Oilskin deploys a cbZEC/USDC market and a MetaMorpho vault, Oilskin owns the
LLTV and oracle choice, needs lenders (its own capital at risk if it seeds),
and its vault's lenders — possibly Oilskin — bear bad debt if cbZEC's exit
liquidity fails. Reputation risk is Oilskin's.

**Mitigates.** Nothing is deployed. `MorphoBlueVenue` reverts `VenueDisabled`
on every call; `MORPHO_BLUE.marketIds` is `{}` in shared. The web disclosure
`own-market` states the risk on every review.

## 8 · Liquidation (cbBTC / WETH on Aave v3)

**Risk.** Borrowing USDC against cbBTC or WETH is liquidated when the HF
falls below 1.0; Aave sells collateral at a bonus (7.5 % cbBTC, 5.0 % WETH at
the 2026-09-05 read). The liquidation thresholds at that read were 78.00 %
cbBTC and 83.00 % WETH.

**Mitigates (code).** The top LTV offered is derived on chain,
`floor(LT / entryHfFloor)` capped at 50 %
(`CollateralRegistry.maxOfferedLtvBps`; 5000 for both assets at the 2026-09-05
LT); `openLeveragedLp` reverts `EntryHfTooLow` below the 1.55 floor
(`StrategyRouter.sol`), and `unwind` reverts `ExitHfTooLow` if a withdrawal
would leave debt below it. The keeper ladder (shared `HF_LADDER`: warn 1.50,
repay 1.35, derisk 1.20, emergency 1.05, hysteresis 0.05) closes a fraction of
the LP ids and repays (`agent/src/dispatch/policy.ts`). Every HF, rung price
and liquidation drop the UI shows is computed from the live LT
(`web/components/wizard/SettingStep.tsx`, shared `ltvPresets`,
`liquidationDropPct`); tests forbid typed literals.

**Does not.** The **borrow-and-hold path bypasses the router**, so the entry
floor is a UI guard there, not a contract one (`FLOWS.md` §2). The keeper
cannot add collateral or repay from anything but the account's LP ids and
idle USDC; a fast crash outruns any ladder. And with the grant the web ships
today the keeper is refused for LP positions (§10).

## 9 · Impermanent loss

**Risk.** A concentrated-liquidity position changes token mix as price moves
and can be worth less than holding; tighter widths lose faster. Liquidation
risk and IL compound: the position that pays the loan is the one shrinking.

**Mitigates (code).** The gate applies an IL drag per width from recorded
volatility — `x = σ²/(4·f(w))`, `lpNet = (1 − e^{−x})(r/x − 1)` — and offers a
pool only when `lpNet > borrow` (`services/yield/src/gate.ts`, `model.ts`;
Monte Carlo validation in `scripts/lp-sim.py`). Pools without a calibrated σ
are refused (`no_volatility_input`), not guessed. **At the 2026-09-05 borrow
read of 4.828 % nothing clears**, so no LP position can be recommended
(`MODEL-NUMBERS-2026-09-05.md`).

**Does not.** The model is emissions-only (trading fees excluded — they go to
veAERO voters when staked in a gauge) and its emission inputs are the
2026-08-31 words. Advanced mode's custom widths are priced by the model only at
the preset widths, which the review says in red (`done-WEB` §6).

## 10 · Keeper dependence

**Risk.** Warnings, repay, de-risk and emergency unwind are performed by a
single Oilskin keeper process. If it is down, wrong, or refused, nobody acts.

**Mitigates (code).** The keeper acts only through `execAsKeeper` inside a
grant the user signed (`OilskinAccount.grant`), bounded per token per period,
revocable in one transaction (`revokeAll`); it can never withdraw collateral
(`withdrawAmount: 0` in `policy.ts`) or pay anyone but the account
(`StrategyRouter.unwind` pays `msg.sender`). Valuation is fail-closed
(`agent/src/engine/valuation.ts`); dispatch is idempotent and crash-safe
(`keeperStore.ts`); a progress watchdog keeps the process alive
(`watchdog.ts`). The user can always act from their own account (`FLOWS.md`
§8). `invariant_keeperNeverExceedsGrant` checks the budgets under random
sequences.

**Does not.**
- **Grant gap (must-fix before launch).** The web grants `StrategyRouter.unwind`
  only (`web/lib/plan.ts`); the keeper's plan for an account with LP ids begins
  with `SnuggleLpVenue.closeMany`, needs a grant for it, and is `REFUSED` when
  the grant is absent (`policy.ts: grantsNeeded`, `keeperDispatcher.ts`). With
  today's grant the keeper protects only idle USDC.
- The `warn` rung is a log line and a store record; no webhook, pager or
  e-mail is wired (`agent/src/index.ts` passes no `notify` hook).
- One keeper, one store, single-writer lock — no redundancy.
- An `UNKNOWN` valuation (any unreadable or disagreeing input) means **no**
  automated protection for that account; it escalates in the log only.
- Budgets are product-policy caps, not derived from the position.

## 11 · Smart-contract risk

**Risk.** `OilskinAccount`, the factory, the router, the venues, the adapter
and the registry are new code (2,856 lines, `AUDIT-SCOPE.md`). Aave v3,
Aerodrome, the Snuggle engine, Permit2 and CoW are third-party contracts with
their own histories; the Snuggle engine discloses AI-only audits.

**Mitigates (code + tests).** Stateless peripherals with no admin and no
storage; the router asserts it holds nothing; no standing allowances
(`_approveCallReset`; `invariant_noStandingAllowances`); reentrancy lock in
transient storage; revert data bubbled untouched; 181 unit / fuzz / invariant
tests green with the fee-never-touches-principal and user-can-always-exit
invariants. The one owned contract is the registry, which cannot touch an
account.

**Does not.** **No external audit has been done.** The fork suite (8 tests)
has not been run against Base from this container. The Aerodrome SwapRouter
address and its `exactInputSingle` shape are unprobed. Slither / Aderyn /
Halmos / Tenderly CI (`BASE-PIVOT-2026-09.md` item 20) is a **plan**.

## 12 · LP engine (Snuggle / MaxFi)

**Risk.** The engine takes its own 15 % of realised earnings, rebalances on its
own schedule, re-keys positions to new ids, enforces a 60-second minimum hold
after any deposit, and can refuse a withdrawal.

**Mitigates (code).** `closeMany` skips refused ids and reports them; the
keeper and the dashboard read `positionsOf(account)` fresh on every dispatch
and every paint rather than caching ids (`keeperDispatcher.ts`,
`web/lib/positions.ts`), so a re-key is picked up; the venue never depends on
enumeration for an exit (`close` / `closeMany` take explicit ids); the fork
test `test_fork_lpOpenCloseOnLiveEngine` exercises the live engine when
`FORK_URL` is set.

**Does not.** The engine's own contract risk is the user's. Fees the engine
keeps are not Oilskin's to refund. The 60-second hold (verified 2026-08 on the
engine source, `AUDIT-LEDGER-2026-08.md`) is not surfaced by the v1 web; a
close seconds after a deposit reverts and is reported as a refused id.

## 13 · Price-band and swap floors (MEV)

**Risk.** A deposit or close through the engine swaps internally; without a
floor a sandwich takes the difference.

**Mitigates (code).** Every deposit and close carries a `PriceBand` checked
against `slot0()` at execution (`SnuggleLpVenue._checkBand`); every swap needs
`minOut > 0` (`AerodromeSwapAdapter`). The web quotes the band ± 100 bps
(Simple) and sizes `swapMinOut` from the position's tick split.

**Does not.** `swapMinOut` on unwind is sized from the indexer's USD value; an
empty cache blocks Simple mode, a zero cached value degrades the floor to 1
(`FLOWS.md` §3). CoW orders carry the user's slippage; solvers settle at or
better than the limit or not at all.

## 14 · Yield verdict and rate drift

**Risk.** The borrow rate (4.828 % on 2026-09-05; Compound v3 USDC was at
90.05 % utilisation, above its kink) moves; a position that clears today may
not tomorrow. Today nothing clears at all.

**Mitigates (code).** `/v1/gate` recomputes on every serve with `stale`
derived from `sampledAt`; 503 on stale rates; the UI re-derives `qualifies` as
`lpNetPct > borrowAprPct` and never shows a pool the served numbers do not
support (`web/lib/gate.ts`).

**Does not.** There is no auto-alert on negative carry for an open position;
the dashboard shows the numbers, the user decides.

## 15 · Demo status

**Risk.** Someone mistakes the demo for a product. Nothing is deployed
(`CONTRACT-ABI.md` §10); no transaction has been signed or broadcast; the web
runs in demo mode with a labelled 2026-09-05 snapshot; CoW spot has been
exercised only in demo; the fork suite is skipped without an RPC.

**Mitigates.** A demo banner on every page and a `demo` disclosure in every
review (`web/components/Banners.tsx`, `copy.ts: demo`); `planIsSignable` is
false without a deployment; demo addresses are obviously synthetic
(`DEMO_DEPLOYMENT`, asserted absent from `VERIFIED-BASE-FACTS.md` by
`web/test/snapshot.test.ts`).

## Trust assumptions, in one list

1. The user's wallet key. It owns the account; a lost or stolen key is a lost
   or stolen account. Nothing in Oilskin can recover it.
2. Coinbase, for cbZEC's existence, peg and reserves (§1, §5).
3. Aave v3's oracle and liquidation logic; Aerodrome's pools; the Snuggle
   engine; Permit2; CoW's settlement — each third-party code we call, not
   audit.
4. The registry owner (a Safe — **plan**; the deploy script hands over in two
   steps) for *which* assets are offered and the entry floor within (1, 10].
   It cannot move funds.
5. The keeper key, bounded by the user's grant (§10).
6. The Oilskin treasury address as the fee recipient (immutable per venue).
7. The RPC the keeper and yield service read from; a lying RPC yields
   `UNKNOWN` (keeper) or refused samples (yield), not action.
8. The people who typed `VERIFIED-BASE-FACTS.md` from live reads on 2026-09-05
   and the tests that pin code to it — and the fact that four things are
   **not** in it: the Aerodrome SwapRouter, Multicall3, the Morpho market ids,
   the CoW vault relayer (`AUDIT-SCOPE.md`).
