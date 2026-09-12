# Risks — what can go wrong, what mitigates it, what does not

Written for the Base module v1 tree of 2026-09-06, after the wave-1 audit
(`AUDIT-2026-09-06.md`) and the fix round it produced. Every mitigation names
the code that enforces it; a mitigation without a code path is marked **plan**.
"Mitigated" never means "eliminated". The same list, in shorter words, is shown
in the app before every signature (`web/lib/copy.ts: RISKS`; `prototype/*.html`).

Sections 1–15 are the standing risks. Sections 16–21 are the ones the audit
found or changed, including the ones that are now **fixed** — a fixed defect is
still a risk record, because the class it belongs to is what tells you where to
look next.

Abbreviations: KYC = Know Your Customer; EEA = European Economic Area; HF =
health factor; LT = liquidation threshold; LTV = loan-to-value; IL =
impermanent loss; LP = liquidity provision; LLTV = liquidation loan-to-value
(Morpho's term); TWAP = time-weighted average price; MEV = maximal extractable
value; RPC = remote procedure call; DEX = decentralised exchange; ABI =
application binary interface; CI = continuous integration; MC = Monte Carlo.

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
whose balance moves under it: keeper budgets are charged from calldata amounts,
never balance snapshots (`OilskinAccount._decodeTokenOp`), and the movers the
parser cannot read are refused outright rather than passing free
(`UnbudgetableSelector`); the venue computes refunds and gains as bounded
deltas that a rebase can only shrink (`SnuggleLpVenue._refund`, `_gain`); a
blocked leg is skipped and reported, never bricking the rest of an exit
(`closeMany` try/catch, `FeeSkipped`, `ClaimSkipped`).
`contracts/test/B20.t.sol` (10 tests) drives `MockB20` through rebase up and
down, blocked account, blocked treasury, paused reward token, blocked swap.
`VERIFIED-BASE-FACTS.md` records the live `multiplier()` read, and
`scripts/check-cbzec-b20.sh` — run by the CI fork job at the suite's pinned block —
re-reads it with `cast`, because no fork EVM can execute the B20 native contract
(the fork test that tried, `test_fork_cbzecIsAB20WithLiveMultiplier`, was retired
for it on 2026-09-12).

**Does not.** A seized or paused balance is gone or frozen for the user
regardless of what our contracts do. **The probe that now ships (slice E,
2026-09-10; `web/lib/b20.ts`, words in `@zyo/shared` `describeB20Probe`) reads
exactly two things and says so:** the live `multiplier()`, and whether an
`eth_call` of `transfer(from, 0)` FROM the user's own address is refused — a
zero-amount self-transfer needs no balance and fails when that address is
blocked or the token is paused. It runs on the spot page whenever cbZEC is on
either side of the order and a wallet is connected (demo mode says it did not
run), and the disclosure (`web/lib/copy.ts` "b20") now claims that and nothing
more. What it cannot see, and says: the issuer's policy itself (`owner()` and
`paused()` revert on the precompile), the blocklist as a whole, and anything
that changes after the read. Tests: `web/test/b20.test.ts`,
`packages/shared/test/b20.test.ts`.

## 5 · cbZEC peg

**Risk.** cbZEC's 1:1 value to ZEC is a Coinbase promise, not a mechanism. In
a Coinbase incident cbZEC trades below ZEC and a ZEC/USD oracle overvalues
the collateral. Total supply was 603.25 cbZEC on 2026-09-05; the Aerodrome
cbZEC/USDC pool priced it at ≈1,020 USDC against Pyth's stale $1,035.20.

**Mitigates (v1).** cbZEC is not collateral anywhere in v1
(`CollateralRegistry` `enabled = false`; `StrategyRouter` reverts
`AssetDisabled` and `AaveV3Venue.supply` reverts `AssetNotOffered`, so the flag
now holds on every path rather than depending on Aave having no market).
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

**Does not.** The cbZEC/USDC gauge read `rewardRate() = 0` on 2026-09-05 and
carries one epoch's vote since 2026-09-10 (0.083 % of the Voter, re-voted
weekly, ≈ 617 AERO/day at the read; `VERIFIED-BASE-FACTS.md` Addendum 8) that
nothing in the product can earn — the engine lists no cbZEC pool and the
verified SwapRouter cannot reach the pool (`docs/CBZEC-PATH-2026-09.md`). At
the 2026-09-05 read cbZEC LP earned
nothing today (`services/yield`: `no_emissions`), so nothing in the product
draws liquidity there either.

## 7 · Our own market (if v1.1 ships)

**Risk.** Morpho Blue market creation is permissionless and immutable; if
Oilskin deploys a cbZEC/USDC market and a MetaMorpho vault, Oilskin owns the
LLTV and oracle choice, needs lenders (its own capital at risk if it seeds),
and its vault's lenders — possibly Oilskin — bear bad debt if cbZEC's exit
liquidity fails. Reputation risk is Oilskin's.

**Mitigates.** Nothing is deployed, and no Oilskin market exists. The
`MorphoBlueVenue` that is built serves only the two EXISTING Base markets
(cbBTC/USDC and WETH/USDC, 86 % LLTV, curated by others, ids in
`VERIFIED-BASE-FACTS.md`); it has no function to add a market, so an Oilskin
cbZEC market would be a new venue and a registry `proposeVenue` → timelock →
`acceptVenue`. A venue built over no markets reports `enabled() == false` and
the registry refuses to enable an asset on it. The web disclosure `own-market`
states the risk on every review.

## 8 · Liquidation (cbBTC / WETH on Aave v3)

**Risk.** Borrowing USDC against cbBTC or WETH is liquidated when the HF
falls below 1.0; Aave sells collateral at a bonus (7.5 % cbBTC, 5.0 % WETH at
the 2026-09-05 read). The liquidation thresholds at that read were 78.00 %
cbBTC and 83.00 % WETH.

**Mitigates (code).** The top LTV offered is derived on chain,
`min(LT/entryHfFloor, venue.maxLtvBps, 5000)`
(`CollateralRegistry.maxOfferedLtvBps`; 5000 for both assets at the 2026-09-05
read), so an Aave LTV→0 deprecation takes the offer to 0 instead of advertising
a loan that reverts inside Aave. **`AaveV3Venue.borrow` itself reverts
`EntryHfTooLow` below the 1.55 floor**, so the floor holds on every path
through the venue — the router's leveraged open, the new `openBorrowOnly`, a
raw owner `execBatch`, a keeper call — and `unwind` reverts `ExitHfTooLow`
(on the **global** health factor) if a withdrawal would leave debt below it.
The keeper ladder (shared `HF_LADDER`: warn 1.50, repay 1.35, derisk 1.20,
emergency 1.05, hysteresis 0.05) closes a fraction of the LP **value** and
repays (`agent/src/dispatch/policy.ts`). Every HF, rung price and liquidation
drop the UI shows is computed from the live LT
(`web/components/wizard/SettingStep.tsx`, shared `ltvPresets`,
`liquidationDropPct`); tests forbid typed literals.

**On Morpho Blue (when the registry is moved there).** The same floor holds in
`MorphoBlueVenue.borrow` / `borrowAgainst`, read from the registry and checked
against the account's WORST market (Morpho positions are isolated per market, so
the venue's health factor is the minimum over its markets). **The keeper and the
dashboard read every venue the registry names** (wave-2 M-HIGH-2; the reader
shipped 2026-09-09): for each collateral asset, `venueOf(asset)` and every
entry of `previousVenues(asset)` is asked `ICollateralVenue.{healthFactor,
debt, collateral, liquidationThresholdBps}` for the account, on every tick
(`agent/src/services/venues.ts`, `web/lib/reads.ts`). The Aave pool is still
read directly and valued by the four G1–G4 guards, and the Aave venue's answers
must reproduce that pool snapshot. Any other venue is accepted only when its
health factor lies inside the band the keeper's own Chainlink feeds imply from
the venue's collateral, debt and threshold — a single-market position makes the
band a point; a multi-market Morpho position may sit anywhere between its worst
market and the aggregate — within `ORACLE_DEVIATION_BPS`, the same bound that
governs Chainlink against Aave's oracle, because threshold and debt are the
venue's own words and only the price can differ. Outside the band, or with
anything unreadable (a registry pointer, a previous venue, a threshold, a
feed), the account is UNKNOWN: no rung runs, the escalation fires after the
configured streak, and the dashboard shows "unreadable", never "No debt"
(`agent/src/engine/venueValuation.ts`, guards V1–V4). The ladder runs on the
WORST venue. Startup is fatal only for a venue that does not answer the
interface; a venue that answers but is not Aave is a warning, and the web marks
an asset unsupported only on such a venue. **Accepting a venue switch on
mainnet is still the registry owner's explicit, separate step** — `proposeVenue`
→ timelock → `acceptVenue` — and nothing in the keeper, the web or the deploy
script performs it; `Deploy.s.sol` leaves cbBTC and WETH on `AaveV3Venue`. The
switch itself no longer strands positions opened on Aave — the router's exit
path follows the position through `CollateralRegistry.previousVenues` (wave-2
M-HIGH-1). **Residual (a), fixed 2026-09-09.** Until then the keeper's
protective `unwind` was resolved by the router to the FIRST venue holding
anything of the account's, so dust collateral or a small, healthy debt on the
registry's new pointer took the repay while the debt that fired the rung rode
on — a CONFIRMED that protected nothing, or a silent `repaid 0`. Now the repay
leg of `StrategyRouter.unwind` visits EVERY venue the registry names for the
asset (`venueOf`, then `previousVenues`) that the account still owes USDC on,
lowest health factor first, until the amount (max = all the USDC the account
holds) is spent, and emits one `VenueRepaid(account, venue, repaid)` per venue
reached; the withdraw leg and its health-factor gate stay on the venue holding
the position. The keeper's `confirm()` reads those events and refuses (FAILED)
any successful receipt that leaves a venue the account still owes without one,
re-reading every venue through the same reader the world check uses and
failing closed when it cannot; `repaid == 0` and "no event" stay FAILED as
before. This is shape A of the two the brief allowed — the router iterates,
the calldata is unchanged — not shape B (an explicit venue in `UnwindParams`):
the router already knew every venue and read each one's debt; the same
worst-first rule already governs `MorphoBlueVenue.repay` across its markets;
the signed grant's `unwind` selector does not move; the web's Close needs no
venue picker a Simple-mode user would have to understand; and the owner's
Close now clears both books in one transaction. What it costs, and how it is
told apart (slice 5, 2026-09-10): the dispatcher persists every book the
account has — venue, USDC owed, health factor — right before the broadcast
(`DispatchRecord.venueBooks`), and `confirm()` judges an untouched venue
against that snapshot (`judgeUntouched`). A two-book account whose USDC runs
out on the worse book leaves the healthier one untouched: with the snapshot
proving that book was the worse one and the USDC gone, the receipt is
CONFIRMED with a shortfall note, and the retry's world check re-values the
account — SUPERSEDED once the worse book sits above the rung's disarm, one
warn-level event, no second transaction. A book owed at dispatch and skipped
while USDC remained, USDC that reached a book the keeper never sized, debt on
a venue that owed nothing at dispatch, or a balance that cannot be re-read
after the receipt are FAILED; `repaid == 0`, "no event" and venues that
cannot be re-read stay FAILED; a record without a snapshot keeps the stricter
2026-09-09 rule (an untouched venue is never confirmed). A repay
is only ever as wide as the asset the rung named: a venue that the dominant
collateral's registry history does not name is out of that call's reach, and
the same rule reports it FAILED rather than CONFIRMED. Tests:
`contracts/test/audit-regressions/VenueSwitch.t.sol` (M1g–M1l),
`agent/test/dispatcher.test.ts` ("RISKS §8 residual (a)"), and since
2026-09-10 `invariant_repayReachesEveryBook` (`contracts/test/invariant/`):
the handler now opens on the registry's current venue, so the fuzz reaches
accounts owing USDC on both Aave and Morpho, and after an owner
`unwind(repay max)` with USDC to cover, no venue the registry names for the
asset may still owe (or the call reverted with a named error) — the two-book
state the 2026-09-07 audit's M-INFO-1 said no invariant could see.
**Residual (b), policy set 2026-09-10.** The cbBTC market's oracle is BTC/USD
while the keeper's feed is cbBTC/USD, so a cbBTC depeg beyond
`ORACLE_DEVIATION_BPS` is a disagreement the venue cannot see. It no longer
leaves the account UNKNOWN with a keeper that never acts. The rule
(`agent/src/engine/venueValuation.ts`): (1) a *protective* repay, derisk or
emergency is sized and fired against the PESSIMISTIC of the two implied
healths — the venue's own health factor when its oracle is the pessimist, the
floor the keeper's feeds imply when the venue is the optimist — so the ladder
runs early and never at the optimist's figure; (2) anything that would
WITHDRAW collateral treats the verdict as UNKNOWN (`valuationForWithdraw`; the
keeper has no withdraw path, and the web's Close, which withdraws, is refused
with the reason for as long as the disagreement lasts — the owner's raw exec
stays open, as for every refusal); (3) the dashboard shows the account as
unreadable with the reason, never as healthy (`web/lib/reads.ts` applies the
same 3 % bound against the Aave-oracle prices the page already reads); (4) the
owner is told once per episode (`oracle-disagreement` keeper event) and every
tick it persists is logged. Tests in both directions:
`agent/test/venueReader.test.ts` (verdict and direction, repay sizing, the
withdraw gate, monitor rung + notice, dispatcher end to end) and
`web/test/reads.test.ts` / `web/test/plan.test.ts`. What it does not do: it
does not decide which price is right. A venue-optimistic disagreement makes
the keeper repay more than the venue's own oracle would require — the price of
protection — and a venue-pessimistic one is acted on at the venue's figure
because that is the price it liquidates at. Morpho has ONE threshold: a
borrow is allowed up to the 86 % LLTV and liquidated below it, with no gap
between "max LTV" and "liquidation threshold" as on Aave, so the registry's
derived offer is min(86 / 1.55 = 55.5 %, 86 %, 50 % cap) = 50 %, and a position
opened at 50 % has HF 1.72. Two things the Aave path does not have: (1) the
cbBTC market's oracle is Chainlink **BTC/USD** with no cbBTC leg — it assumes
cbBTC = BTC, so a cbBTC depeg does not move that market's price and the venue's
health factor, which reads the market's oracle, would not see it until
liquidations already happened elsewhere; the keeper's Chainlink cbBTC/USD feed
is the independent view, and the V4 band above is where the two meet. (2)
Interest accrues per market on every touch; the venue computes debt the way
Morpho will (`MorphoMath`) without reading any oracle, and the keeper reads
`debt()` from the venue, not from `position()` shares. (3) A market with debt
whose oracle cannot be read has health factor 0 at the venue — a borrow or
withdraw fails closed at the floor, a repay is never gated by any market's
oracle (wave-2 M-MED-2), and the keeper reads that 0 as UNKNOWN, not as a rung.

**Rounding dust, measured 2026-09-10 (fork at block 51,127,409).** Aave keeps
balances scaled by an index and rounds on every read: a supply of exactly
1.00000000 cbBTC read back as 0.99999999 (`getUserReserveData` →
99,999,999 with liquidityIndex 1.002030…e27), and a borrow of exactly 10,000
USDC read back as 10,000.000001 in the same block (`debt()` →
10,000,000,001). The second one bit: `AaveV3Venue.repay(USDC, max)` approved,
and Aave pulled, the full debt, so an account holding exactly what it borrowed
could not repay through the venue — Aave reverted `ERC20: transfer amount
exceeds balance` (the fork test stopped there on 2026-09-10). **Policy, slice C
(2026-09-10).** ONE threshold, `LOAN_DUST_UNITS` = **100 units of the loan
token** (`packages/shared/src/dust.ts`, mirrored as `LoanDust.UNITS` in
`contracts/src/libraries/LoanDust.sol`; the agent's ABI seam fails if the two
differ), in units and not a percentage because rounding is additive per
operation: two orders of magnitude above the largest error measured or
derivable (a unit per Aave operation, a unit per Morpho market from
`toAssetsUp`), five below the smallest amount anyone would spend a transaction
on. It governs every place "fully repaid" or "holds nothing" is DECIDED:
`StrategyRouter._holdsPosition` no longer counts a residual at or below it as a
position, so a two-book Close is not sent to a venue with nothing to withdraw
(the repay leg still visits and clears it); `AaveV3Venue.repay` now approves
what Aave will pull and never more than the account holds — an exact-balance
`repay(max)` repays everything held and leaves the rounding unit, which
`debt()` reports, and an account holding no USDC is refused by name
(`InsufficientLoanToken`) instead of inside Aave's `transferFrom`;
`MorphoBlueVenue.repay(max)` already goes by shares per market and clears to
zero, and its partial path leaves at most a unit, so it needed no change; the
keeper's valuation reads a residual at or below the threshold as `NO_DEBT` on
the pool (`valuation.ts`, G1/G3/G4 relaxed only for that case: the pool's
finite, enormous health factor is not a fault, while literally nothing owed
still demands `MAX_UINT256`) and on any venue (`venueValuation.ts`), so the
ladder does not run and the monitor does not escalate over a unit; `confirm()`
does not count a venue owing at most a unit as "left untouched", and
`judgeUntouched` treats a dispatch-time book at or below it as owing nothing;
the dashboard shows "no debt" from `AccountRead.debtIsDust` — the pool's USDC
row and every venue's `debt` at or below the threshold — never from a USD
figure being exactly zero, and both the pool leg and the venue leg read such a
residual as HF ∞ so they agree. **What the threshold does not do:** Aave and
Morpho still refuse to release the last of the collateral while a single unit
is owed — measured on the fork (`VERIFIED-BASE-FACTS.md` Addendum 6): after an
exact-balance `repay(max)` left **two** units (the unit Aave read over, plus one
from the repay's own rounding), `withdraw(max)` reverted inside Aave with
`HealthFactorLowerThanLiquidationThreshold()` until they were repaid; and the
aToken's rounding hands back one unit of cbBTC less than was supplied
(99,999,999 of 100,000,000), which is not recoverable. A close that wants every satoshi back must repay the
full `debt()` the venue reports, and the app must ask for that amount, not the
borrow. Tests: `contracts/test/audit-regressions/LoanDust.t.sol`,
`test_fork_supplyBorrowRepayWithdrawUnderTheAccount` (green at block
51,127,409), `agent/test/valuation.test.ts` / `venueReader.test.ts` /
`dispatcher.test.ts` (slice C cases), `web/test/reads.test.ts` (slice C),
`packages/shared/test/dust.test.ts`.

**Two-book Close — the options, measured (slice D, 2026-09-10; not implemented).**
After a venue switch an account can hold collateral on BOTH venues (a book
opened on Aave, another on Morpho once the pointer moved). The repay leg of
`StrategyRouter.unwind` reaches every book (residual (a) above); the WITHDRAW
leg goes to the first venue holding anything of the account's — the current
pointer first — and stops. The web's Close is ONE `unwind(ids, repay max,
withdraw max)` (`web/lib/plan.ts encodeUnwindWrite`), so on a two-book account
it repays everything and returns only one venue's collateral; the other
venue's collateral stays where it is, debt-free, until a second Close. Nothing
is lost, but the Simple-mode promise "one transaction… returns your cbBTC" is
false for that account. Proved and parked as a KNOWN FAILURE:
`invariant_KNOWN_singleCloseStrandsCollateral` (`contracts/test/invariant/`)
runs the web's exact call on every two-book state the fuzz reaches and asserts
the strand happens every time; `test_handlerPathsAreLive` reaches that state.
The day the fix lands that invariant goes red and is flipped to "stranded ==
0". Numbers, from the fork at block 51,127,409 (`test_fork_twoBookWithdrawLegGas`,
a `MorphoBlueVenue` over the two verified markets on the fork's own registry,
cbBTC switched by propose → 2-day timelock → accept, a book on each venue,
everything metered raw through the account; `VERIFIED-BASE-FACTS.md` Addendum
7): the router's two views per venue (`debt` + `collateral`) cost **158,648**
gas on Aave and **63,987** on Morpho; a `withdraw(max)` leg costs **203,462** on
Aave and **125,152** on Morpho. At the base fee read at block 51,146,494
(**0.005 gwei**, gas price 0.006 gwei; ETH/USD 2,437.27 from the Chainlink
feed at the same read) one extra Aave leg is ≈ 362k gas ≈ 0.0000022 ETH ≈
**$0.005** of L2 execution, one extra Morpho leg ≈ 189k gas ≈ **$0.003**; the L1
data fee of the transaction is not in these figures and was not read.

*Option (1) — the router's withdraw leg iterates every venue holding the
account's collateral, each gated by that venue's own exit floor.* Shape:
`withdrawAmount` keeps its meaning per venue (`max` = everything there); one
`VenueWithdrawn(account, venue, withdrawn)` per venue reached, mirroring
`VenueRepaid`; `LeveragedLpUnwound.withdrawn` sums. ABI change: **yes, one
new event** (the `unwind` selector and `UnwindParams` do not move); grant
shape: **unchanged** (same selector; the keeper never sets a withdraw, and
`policy.ts` keeps `withdrawAmount = 0`). Gas: the current single Close plus,
per extra venue, its views and its leg (≈ 362k Aave / ≈ 189k Morpho). Router
code: the loop and the event, ≈ 25 lines in `StrategyRouter.sol`; the
invariant flips; the keeper's `summarizeUnwinds` learns the event
(≈ 15 lines) and the web's plan text names both venues. What it does not
cover: a venue whose exit floor refuses (debt left on it below the floor)
reverts the whole Close today and would still — the per-venue gate is the same
rule applied twice, and a partial withdraw on one venue with a refusal on the
other would need a "best effort" flag the calldata does not carry.

*Option (2) — the web plans one Close per venue holding collateral; no
contract change.* The venue-aware read already lists each venue's collateral;
`buildUnwindPlan` emits N steps, each the same `unwind(withdraw max)`, and the
router's routing rule (first venue holding anything, current pointer first,
a rounding residual not counting — slice C) sends the second call to the
second venue on its own. Simple-mode wording: "Your collateral sits in two
places, because Oilskin changed the lending contract while your position was
open. Closing takes two signatures, one per place; each returns that place's
collateral, and nothing is lost between them." Gas: N transactions, each a
full Close (the repay leg on the second is a no-op, the LP close and swap
empty). ABI: **none**; grant: **unchanged**. What the keeper must never do:
withdraw — the second Close is the owner's alone, and the keeper's grant must
keep `withdrawAmount = 0` in the plan and in the simulation guard, or a
"helpful" keeper would move collateral to the account, which is exactly the
power the grant is documented not to carry. Cost: ≈ 40 lines in `plan.ts`
plus the wording, and a plan test per venue count. What it does not cover: a
user who signs the first Close and walks away is left with a debt-free book
on the second venue — visible on the dashboard, but a state the product has
to explain.

**Decided by the founder, 2026-09-10: option (1); implemented 2026-09-11
(slice F).** `StrategyRouter._withdrawAcross` visits every venue the registry
names for the asset that holds the account's collateral, current pointer
first, asks each for the amount, gates each on ITS OWN global health factor
(`ExitHfTooLow`, the same rule applied per venue) and emits one
`VenueWithdrawn(account, venue, withdrawn)` per venue reached;
`LeveragedLpUnwound.withdrawn` is the sum. `withdrawAmount = max` returns
everything from every venue; a fixed amount is a TOTAL taken in venue order,
never more than a venue holds, and `CollateralShort(asked, withdrawn)` if the
venues together cannot meet it — never silently less. With nothing held
anywhere the current pointer is asked as before, so its own named refusal is
what the caller sees. The `unwind` selector (`0x08435e75`), `UnwindParams`
and the keeper's grant did not move; the keeper's plans keep `withdrawAmount
= 0` and its receipts carry no `VenueWithdrawn`. The invariant flipped:
`invariant_singleCloseClearsEveryBook` asserts a two-book account funded to
cover every book strands nothing and never reverts — with one named
exception since wave 3: an id both LP venues claim is W3-LOW-1's
`AmbiguousPositionId`, which the probe resolves the documented way (the direct
twin closed through its own venue) before asking again (256 runs × depth 40,
10,240 calls, 0 reverts); `VenueSwitch.t.sol` M1m–M1q pin one Close clearing
both venues, the per-venue gate, the fixed-amount rule, the Aave-only shape
plus its one event, and the unchanged selector; the web's Close says "your
cbBTC sits in N places … this same transaction returns it from every one of
them" when the account read counts more than one venue holding collateral.
What it still does not cover: a venue whose exit floor refuses reverts the
whole Close (option (1)'s stated cost) — the transaction is atomic, nothing
moves, and the owner's raw exec to the other venue remains.

**Does not.** The floor binds only sequences that go through the Oilskin venue.
A user who hand-writes `account.exec(aavePool, borrow(...))` can still open at
Aave's full LTV — that is the same owner-only door the exit guarantee is made
of, and closing it would let the account be trapped by its own policy. The
keeper cannot add collateral, and can repay only from the account's LP ids and
idle USDC; a fast crash outruns any ladder.

## 9 · Impermanent loss, and the model that prices it

**Risk.** A concentrated-liquidity position changes token mix as price moves
and can be worth less than holding; tighter widths lose faster. Liquidation
risk and IL compound: the position that pays the loan is the one shrinking.

**Mitigates (code).** The gate prices every cell **twice** and offers only when
both models clear the borrow: the closed form
`lpNet = (1 − e^{−x})(r/x − 1)`, `x = σ²/(4·f(w))`, and the
Monte-Carlo-calibrated form `mcLpNet = net × inRangeEmissionsFactor + mcDragPct`
whose coefficients come from a full MC run per pool × setting
(`services/yield/src/gate.ts`, `mc-calibration.ts`, `scripts/lp-sim.py`).
Pools without a calibrated σ are refused (`no_volatility_input`), not guessed.
**At the live borrow reads of 4.828 % (2026-09-05) and 4.5174 % (2026-09-12)
nothing clears** — every priced cell's LP slice is net negative before the
borrow is even charged — so no LP position can be recommended
(`MODEL-NUMBERS-2026-09-12.md`, §14).

**Does not.** The model is emissions-only (trading fees excluded — they go to
veAERO voters when staked in a gauge) and its emission inputs are the
2026-08-31 words. Advanced mode's custom widths are priced only at the preset
widths; a width the MC has never run is refused (`mc_calibration_stale`)
rather than guessed. See §21 for the boundary the second model exists to guard.

## 10 · Keeper dependence

**Risk.** Warnings, repay, de-risk and emergency unwind are performed by a
single Oilskin keeper process. If it is down, wrong, or refused, nobody acts.

**Mitigates (code).** The keeper acts only through `execAsKeeper` inside a
grant the user signed (`OilskinAccount.grant`), bounded per token per period,
revocable in one transaction (`revokeAll`); it pays nobody but the account
(`StrategyRouter.unwind` pays `msg.sender`); its own plans never withdraw
collateral (`withdrawAmount: 0` in `policy.ts`) — but the **permission** does
allow an `unwind` with a withdraw, bounded by the router's exit health-factor
floor and always into the account, and the pre-sign copy says so; a token mover
the budget cannot parse is refused, not passed; the swap quote it sends must
imply a pool price inside the close's own price band, so a keeper-chosen quote
cannot drive the swap floor below the market (wave-2 G-MED-1). Its whole surface is **one root
`StrategyRouter.unwind` per pool**, which is exactly the one `Permission` the
web asks the user to sign, and `agent/scripts/verify-abi.mjs` fails the build
if the plan ever contains anything else. Valuation is fail-closed
(`engine/valuation.ts`); staleness is measured per feed (§20); a rung is sized
by LP **value**, not by id count, from a real simulation of the closing call;
dispatch persists the nonce and the ids before broadcasting and is idempotent
(`keeperStore.ts`, format v3, verified writes, `.bak`, heartbeat lock); one
wedged account is bounded, quarantined and its rung re-armed rather than
starving the fleet; every rung and escalation reaches a notifier
(`notify/notifier.ts`). The user can always act from their own account
(`FLOWS.md` §8). `invariant_keeperNeverExceedsGrant` checks the budgets under
random sequences.

**Does not.**
- **A grant without `allowCallback: true` looks live and can do nothing** — the
  dispatch would revert `NotActivePeripheral` inside the router. The keeper
  classifies that as a permanent configuration error and escalates; the
  dashboard shows it as `cannot-act`; but a user who signed such a grant
  elsewhere is unprotected until they re-grant.
- **Delivery stops at a webhook.** The notifier has a log channel and an HTTP
  channel; there is no mailer, no pager and no per-user routing. Something
  downstream must fan `{kind, severity, account, owner, rung, hf, status, key,
  reasons, at}` out to the account owner. Until that exists, "→ keeper notify"
  in the pre-sign copy is a promise the keeper cannot keep on its own.
- **Collateral outside `AAVE_V3_RESERVES` (cbBTC, WETH, USDC) is UNKNOWN.** A
  user who supplies wstETH/cbETH/USDbC to their own account is unprotected
  until they withdraw it. It is now an immediate, named, notified escalation
  with the reason stored per account — but it is still no protection.
- One keeper, one store, single-writer lock — no redundancy; a second instance
  is refused until the first's heartbeat goes stale.
- Any `UNKNOWN` valuation means **no** automated protection for that account.
- Budgets are product-policy caps, not derived from the position, and they are
  **per grant, not per account**: two grants listing the same token give the
  keeper the sum. The product issues exactly one.
- After a crash between send and persist the keeper knows the nonce it used but
  does not scan for the transaction; it re-reads the world and re-sizes. A
  duplicate close remains theoretically possible if a broadcast lands after a
  quarantine re-arms the rung — bounded, monotone-improving, and visible in the
  ledger.

## 11 · Smart-contract risk

**Risk.** `OilskinAccount`, the factory, the router, the venues, the adapters
and the registry are new code (5,773 lines on 2026-09-11, `AUDIT-SCOPE.md`,
of which the direct Slipstream venue, its pool-direct swap adapter, their
interfaces and the vendored liquidity math are 1,286 — slice F). Aave v3,
Aerodrome, the Snuggle engine, Permit2 and CoW are third-party contracts with
their own histories; the Snuggle engine discloses AI-only audits.

**Mitigates (code + tests).** Stateless peripherals with no admin and no
storage; the router's balance of every token it touches is unchanged across
every call; no standing allowances (`_approveCallReset`;
`invariant_noStandingAllowances`); reentrancy lock in transient storage;
peripheral rights opt-in per call and bounded in depth; revert data bubbled
untouched; **363 unit / fuzz / invariant tests green** (2026-09-11, slice G;
plus 12 fork tests skipped without `FORK_URL`), with 10 invariants including the user-can-always-exit (raw and via the
router), repay-reaches-every-book, one-Close-clears-every-book,
fee-never-touches-principal and the two donation properties.
The one owned contract is the registry, which cannot touch an account — but
see §16 for what it *can* do.

**Does not.** **No external audit has been done.** Waves 1–3 were internal
adversarial audits with executed proofs of concept (`AUDIT-2026-09-06.md`,
`AUDIT-2026-09-07.md`, `AUDIT-2026-09-11.md`), not external ones. The fork suite (10 tests
since slice D) was run against Base mainnet on 2026-09-10 at block 51,127,409:
4 passed, 4 failed of 8 on the first run, 7 / 2 after slices A and B, 8 / 1
after slice C, 9 / 1 of 10 after slice D (the cbZEC B20 harness limit is the
one left) (`VERIFIED-BASE-FACTS.md` Addendum 3; the founder's 2026-09-07 run
at block 51,001,138 had the same 4 + 4). The engine's live end-of-list revert
shape was recorded — empty `0x`, not `Panic(0x32)` — and `positionsOf` was
redesigned for it the same day (slice A, §12, with the gas of every probe
shape measured, Addendum 4); the Aave flow reached repay and stopped on a
1-unit rounding shortfall and, with the dust policy of slice C (§8), runs to
the end; the open → close flow stopped on a stub adapter
the engine lists first and, re-pointed at the real Aerodrome entry (slice B,
§12, Addendum 5), opened, was refused inside the hold, and closed — showing the
single-sided deposit is a one-sided range, not a swap to ratio; and
the cbZEC B20 test cannot execute inside a fork EVM at all (its values were
read live with `cast`). No product code was changed to turn any of these
green. Slither / Aderyn / Halmos CI (`BASE-PIVOT-2026-09.md` item 20) exists since
2026-09-11 (slice H: a `static-analysis` job failing on a new High, four halmos
properties on the account's grant budget and parser, one bounded router
property) — but **none of the three tools has run on the founder's Mac**, so
no Slither or Aderyn finding has been triaged yet and no halmos property has
been proved (`AUDIT-2026-09-11.md` §Slice H has the install commands). Tenderly
is still a plan. Peripheral-to-
peripheral reentrancy is bounded at depth 8, not prevented: venue A → B → A is
reachable, and today's venues are stateless, which is the only reason nothing
breaks — a future venue with per-call state must carry its own guard
(`Peripheral.sol` says so).

## 12 · LP engine (Snuggle / MaxFi)

**Risk.** The engine takes its own 15 % of realised earnings, rebalances on its
own schedule, re-keys positions to new ids, enforces a 60-second minimum hold
after any deposit, and can refuse a withdrawal.

**Mitigates (code).** `closeMany` and `claim` skip refused ids and report them
— **including at index 0**, which is what makes a keeper rebalance between the
keeper's read and its dispatch survivable; the keeper and the dashboard read
`positionsOf(account)` fresh on every dispatch and every paint rather than
caching ids, so a re-key is picked up; the venue never depends on enumeration
for an exit (`close` / `closeMany` take explicit ids); enumeration accepts a
terminating revert only when gas, shape, consistency and ownership all agree
(the design below, slice A, 2026-09-10) and otherwise fails closed with the
fault named; the fork tests `test_fork_engineIndexGetterShape` and
`test_fork_lpOpenCloseOnLiveEngine` exercise the live engine when `FORK_URL`
is set (first run 2026-09-10 — see "Measured" below).

**Does not.** The engine's own contract risk is the user's. Fees the engine
keeps are not Oilskin's to refund. The 60-second hold (verified 2026-08,
`AUDIT-LEDGER-2026-08.md`) is not surfaced by the v1 web; a close seconds after
a deposit reverts and is reported as a refused id. And an isolated failure at
the LAST index of the list (k = n − 1, with the terminal shape) is still
indistinguishable from a list one shorter — the k + 1 probe below cannot see
it — a property of the engine's generated getter that no amount of care in our
venue removes; the two residuals the design leaves are stated under it.

**Measured 2026-09-10 (fork at block 51,127,409; `VERIFIED-BASE-FACTS.md`
Addendum 3).** The live engine's end-of-list revert is *empty*:
`userPositions(account, 0)` for a fresh address and the canary at 2^256 − 1
both revert with zero bytes of data, through the proxy and at the unchanged
implementation `0x359F…2D28`. That is not `Panic(0x32)`, so `positionsOf`
reverted `EnumerationFailed(0x)` for every account on the live engine until
slice A (below): the dashboard's position list and the keeper's id discovery
could not work on mainnet as built, while exits (`close` / `closeMany` by
explicit id) did not depend on it and still could. The empty shape is also
exactly the shape of a bare `revert()`, an out-of-gas or a proxy miss, so the
ambiguity the pin was written to remove cannot be removed by shape on this
engine — which is why the design below removes it by other means and names
what it cannot remove. Second measurement: the engine's registry entry at index 0
(poolId `0x0ab2…65e2`) is one of 81 entries — of 214, all flagged active —
that name the Uniswap v3 WETH/USDC pool `0xd0b5…F224` under 81 different
token pairs, with a fee field of 9999 and a position adapter `0xCCBf…CED2`
whose `getTWAPTick` reverts `NotImplemented()`; `depositSingleSided` into any
of them reverts, and the venue bubbles that error unchanged. None of the
twelve curated `enginePoolId`s in `packages/shared/src/pools.ts` is one of
those 81 (all twelve sit on minting adapters), but a user-typed id could be,
and the fork test's "first active WETH/USDC pool" selection is. The engine
lists no cbZEC pool at all.

**Design, slice A (2026-09-10): enumeration on the engine as it is.** The
verified source of the implementation (`0x359f…2d28`, solc 0.8.33 via-IR,
Blockscout, read 2026-09-10) shows `userPositions` is the compiler-generated
getter of `mapping(address => uint256[]) public userPositions`; the engine
keeps every listed id owned by the lister (`_removePosition` swap-and-pop,
`_replacePositionId` in place, `positionIndexInUser` per id) and caps a list
at `maxPositionsPerUser()` = 500 (read live, `VERIFIED-BASE-FACTS.md`
Addendum 4). `positionsOf` therefore no longer pins `Panic(0x32)`. It accepts a
terminating revert of either measured shape — empty (the live engine) or
`Panic(0x32)` (a Solidity array read, what the mocks produced) — but never on
shape alone: four independent checks must agree, and every failure names its
reason through `EnumerationAmbiguous(fault, index, data)`.

1. *Gas (EIP-150).* Every engine probe is a `staticcall` under a fixed
   stipend, `PROBE_GAS`, and the venue first checks it holds at least 64/63
   of that plus slack so the callee receives exactly the stipend
   (`InsufficientGas` otherwise). A probe that failed after consuming the
   whole stipend is an out-of-gas, not an end of list (`ProbeOutOfGas`).
   This works only because the measured empty revert is a `REVERT` that
   returns its unused gas, not an `INVALID` that burns it all: the node
   reports `execution reverted`, and the fork meters the end-of-list, the
   canary, a successful index read and a `positions(id)` read at the gas
   figures in Addendum 4; the stipend is sized from those, at least 8× the
   most expensive of them, and must be re-measured on any engine upgrade.
2. *Shape agreement.* The canary at 2^256 − 1 must fail (`CanaryAnswered`)
   with one of the two terminal shapes (`TerminalShapeUnknown`); the revert
   that ends the list at index k must be byte-identical to the canary's; a
   mid-list revert of any other shape is `EnumerationFailed(data)` as before.
3. *Consistency (k, k + 1, liveness).* Index k + 1 must fail exactly like k
   (`InconsistentEnd`) — an isolated failing index before the true end used
   to read as a shorter list; `poolIdsCount()` must answer before the canary
   and again after the terminal probe, with the same value (`LivenessLost`).
4. *Corroboration.* Each id read at index i is checked against
   `positions(id)`: the read must succeed with the full 17-word struct and a
   clean address word (`PositionUnreadable`), and the owner must be the
   account (`OwnerMismatch`) — a mismatch is corruption or a foreign engine,
   not a row to skip, so it fails closed instead of being filtered.

Off chain, the keeper and the web decode `EnumerationAmbiguous`,
`EnumerationFailed` and `EngineUnreachable` by name (`@zyo/shared`
`describeLpEnumerationFault`): the keeper REFUSES the dispatch with the fault
named and never plans against an empty list, and the dashboard shows
"positions unreadable" with the fault, never "No positions". *Residuals,
stated.* (a) An isolated failure at the last index is a list one shorter (the
"Does not" above). (b) A proxy miss — an implementation swap that drops the
getter — reverts empty at every index for every account and is, by shape, gas
and consistency, an empty list. The venue cannot read the proxy's
implementation slot; the keeper and the web can (EIP-1967 slot, `0x359f…2d28`
at the 2026-09-10 read, admin `0x7885…86cb`), and comparing it to the recorded
value before trusting an empty list is the only guard. Taking it means an
engine upgrade parks id discovery — and every LP close the keeper would plan —
until the shape is re-measured; that is a product decision, recorded here and
not made. (c) The stipend bounds what the engine may spend per probe: an
engine that legitimately grew past it would read as out-of-gas and fail
closed. Tests: `contracts/test/audit-regressions/EnumerationAmbiguity.t.sol`
(every fault, both terminal shapes, the last-index residual asserted as such),
`LpVenueCliffs.t.sol` B11 (flipped: the empty shape enumerates, an isolated
failure before the end fails closed), `SnuggleLpVenue.t.sol` (both mock
shapes), the fork test, `agent/test/dispatcher.test.ts` and
`web/test/reads.test.ts` (fail closed, fault named).

**Measured, slice B (2026-09-10, fork at block 51,127,409; `VERIFIED-BASE-FACTS.md`
Addendum 5).** The open → close fork test now selects the engine's entries by
property — active, WETH/USDC, a position adapter that answers `getTWAPTick`,
the pool's `factory()` the Slipstream CLFactory, a reward adapter set — and
lands on the Aerodrome CL100 WETH/USDC entry (index 24, pool `0xb2cc…DC59`,
gauge `0xF33a…e0c8`). A 1,000 USDC single-sided open mints to the account, is
auto-staked in the gauge, is seen by `positionsOf`, refuses a close inside the
60 s hold with `MinimumHoldTimeNotMet()`, and closes two minutes later for
**999.999999 USDC and 0 WETH**. That last number is the finding: **the engine
does not swap a single-sided deposit to ratio.** Its verified mint library
builds a one-sided "snuggle" range on the deposited token's side of the price
(below it for USDC, from the lower of TWAP and spot), so every position the
product opens — the router deposits the borrowed USDC single-sided — holds
only USDC until the price falls into the range, and earns no trading fees and
no gauge emissions while it waits (Slipstream gauges pay staked liquidity that
is in range). `ISnuggleVault` FACT 4 said the opposite and is corrected; the
yield model's in-range assumption (§9, §14) is not what the engine mints, and
whether the product should open dual-sided (a centred range, which needs a
swap of half the USDC on the way in), accept the limit-order shape, or price
it differently is a product decision the slice E memo lays out — not made
here. The engine's refusal shapes were measured raw from the account on an
un-gauged entry and are now the mocks' shapes, selector for selector:
`NotPositionOwner()` for a foreign and a never-minted id alike on `withdraw`,
`harvest` and `claimStakingRewards`; `NoFeesToHarvest()` for a harvest with
nothing to collect; `NoRewardAdapter()` for `claimStakingRewards` where there
is no gauge; `UseClaimStakingRewards()` for a harvest on a staked id;
`claimStakingRewards` on a fresh staked id returns 0 without reverting. The
venue's `_claimOne` (claimStakingRewards, then harvest, then `ClaimSkipped`)
already tolerated all of them; the mock used to pay a zero harvest silently and
to pause its views and exits, which the live engine does not — only deposits
and rebalances carry `whenNotPaused`. Tests: `SnuggleLpVenue.t.sol`
(`test_positionsOfFailsClosedWhenEngineUnreachable`,
`test_pausedEngineRefusesOpensButNotCloses`), the two fork tests.

**The direct Slipstream venue (slice F, 2026-09-11; `CBZEC-PATH-2026-09.md`
option 1, decided 2026-09-10).** cbZEC/USDC is not an engine pool and the
verified SwapRouter cannot reach it (Addendum 8), so it is held through
Oilskin's own `SlipstreamLpVenue` on the SECOND Slipstream deployment's
position manager `0xe1f8…8b53` and the pool's gauge `0x8779…81FB`, and swapped
through `SlipstreamPoolSwapAdapter` — the pool's own `swap` with the callback
paying the pool from the account (Addendum 9). Behind the same `ILpVenue`:
the router resolves a pool id to the engine venue first, then the direct one
(`UnknownPool` otherwise), and an unwind's ids to the venue that says the
account owns the first of them (`ILpVenue.ownedPool`, new — a staked NFT is
the gauge's on the NFT's books and the account's on the gauge's, and the
gauge has no id → depositor view). *What it does differently, on purpose:*
the position is two-sided and centred — a single-sided deposit is first
swapped to the range's ratio through the pool under a floor derived from the
caller's own price band, capped at the adapter's 5 % — then minted and staked
in the gauge when the Voter says it is alive (otherwise held unstaked and
said so, `StakeSkipped`); there is no rebalancer, the range is static; the
fee chokepoint is on what `claim` / `close` collect (AERO from the gauge, any
trading fees accrued while unstaked), once per distinct token, principal
untaxed. *Risk lines it adds, each stated in code or copy:* a killed or
unvoted gauge pays nothing (the yield gate reads `rewardRate` live and the
pool note says the vote is weekly); the range does not follow the price (the
dashboard shows it; the disclosure says it earns nothing outside it); an
early-withdraw penalty on the AERO — read 2026-09-11: 100 % of the reward for
ten seconds after staking, shown live by `earlyWithdrawPenalty` on the position
and in the Close plan (W3-LOW-5, Addendum 9); the pool IS the depth (≈ $0.9M on 2026-09-10); the
second factory's fee manager `0xE6A4…2075` sets the pool's swap fee (§16); the
callback is a new door — accepted only from the bound pool, only while a swap
is in flight, only once, paying exactly the pool's positive delta and never
the other token (`SlipstreamLpVenue.t.sol`, the adapter tests); and, since
the wave-3 audit (`AUDIT-2026-09-11.md` W3-MED-2), enumeration that a stranger
cannot switch off — the gauge's staked list (the account's own deposits) is
always returned whole, the account's unstaked Slipstream tokens are scanned
through a window of `MAX_ENUMERATION`, and `unstakedOverflow(account)` names
what the window did not reach (the keeper warns, the dashboard says so);
before that, 512 dust NFTs sent by anyone made `positionsOf` revert and the
keeper refuse every rung for the account. *Residuals:*
(a) the engine's and the NPM's id spaces are independent counters; since the
W3-LOW-1 fix an id BOTH venues claim for the account is refused by name
(`AmbiguousPositionId`) instead of routed to the engine's, and the owner closes
that id through the venue's own `close` — `LpVenueRouting.t.sol`; (a′) an unstaked position the account
itself holds can sit beyond the window when a stranger pads the holdings, and
is then invisible to the keeper and the dashboard until the padding is
cleared — the owner's raw exec reaches it; (b) the
pool-direct swap has no price limit beyond the tick bounds — the floor is the
protection, and a partial fill (liquidity running out) is refused by name
(`PartialFill`), never half-done; (c) mint and decrease minimums are zero
because the whole call is one transaction whose price was checked against the
band at the start and moved only by the venue's own bounded swap — a
same-block move inside the band is the same residual as §13's. Proved on the
fork on the deployment's WETH/USDC ts-10 pool (open → positionsOf → close on
the live NPM and gauge, `test_fork_directVenueOpenCloseOnTheSecondDeployment`)
and on the cbZEC pool's live pointers (`test_fork_directVenueBindsToTheCbzecPool`);
the cbZEC pool's own mint cannot run in a fork EVM (Addendum 3).

## 13 · Price-band and swap floors (MEV)

**Risk.** A deposit or close through the engine swaps internally; without a
floor a sandwich takes the difference. On unwind, the non-USDC leg is sold on a
public DEX.

**Mitigates (code).** Every deposit, close and claim carries a `PriceBand`
checked against `slot0()` at execution (`SnuggleLpVenue._checkBand`), and the
band's **width** is bounded (`MAX_BAND_BPS = 2500`, `BandTooWide`) so "no band"
cannot be expressed. Every swap is bounded by a **quote plus a capped
tolerance**: `amountIn × quotedOut / quotedIn × (10000 − maxSlippageBps) /
10000` on the amount actually swapped, `maxSlippageBps ≤ 500` on chain, zero
quote refused; `minOutFor` is a pure view so the caller, the keeper simulation
and the UI show the number the chain enforces, and `Swapped` logs it. The web
fetches a real quote from the pool's live price, cross-checks it against the
Chainlink price Aave uses, and refuses a pool more than 3 % off the oracle
(`web/lib/quote.ts`); the keeper builds its quote from the same live pool price
(`agent/src/dispatch/quote.ts`). The cbZEC/USDC leg (2026-09-11) goes through
`SlipstreamPoolSwapAdapter`, the pool's own `swap`: the same quote-plus-capped-
tolerance floor, checked against the account's BALANCE DELTA, with a partial
fill refused by name and the callback accepting only the bound pool while a
swap is in flight; since the wave-3 W3-LOW-6 fix `AerodromeSwapAdapter` measures
the delta the same way (its floor used to be checked on the SwapRouter's return
value while its NatSpec claimed otherwise); the venue's own to-ratio swap on
open takes its tolerance from the caller's band, capped at the same 5 %.

**A leg the quote cannot price (NI-HIGH-1, `AUDIT-2026-09-12.md`, 2026-09-12).** The
floor above is relative to the caller's quote, so for a leg small enough it rounds to
ZERO USDC — and a zero floor is a swap the adapter refuses by name (`ZeroQuote`).
Until 2026-09-12 the router sent that swap anyway, so 6,192 wei of WETH fee paid
out by the close reverted the whole unwind, the keeper's protective one included
(found by the nightly invariant configuration, 180,000 calls per invariant, on its
first local run). `StrategyRouter._toUsdc` now asks the adapter for `minOutFor` on
the actual leg first: zero under a real quote means the leg stays in the account,
`DustLegKept(account, token, amount)` says so, and the unwind goes on; an empty
quote is still `ZeroQuote`. "Dust" is therefore whatever the enforcing code could
not protect at the caller's own quote and tolerance — no threshold was typed.
Regression: `contracts/test/audit-regressions/DustLegClose.t.sol`.

**Does not.** The quote is still caller-supplied: a dishonest quote still gives
a bad floor. What changed is that the lie is an explicit number in calldata
that a reviewer, a simulation, an event reader or a UI can compare against the
market, instead of a silent default of 1. An oracle-priced absolute floor is
not available to this contract for the pairs Aave does not list (AERO, cbZEC,
USDT, LINK legs), and a rule that protected only some pools would read as if it
protected all of them. `PriceBand` remains a spot `slot0()` check: a same-block
move within the tolerance is the residual. CoW orders carry the user's
slippage; solvers settle at or better than the limit or not at all.

## 14 · Yield forecast and rate drift

**Risk.** The borrow rate moves (4.828 % on 2026-09-05, 4.5174 % on
2026-09-12; Compound v3 USDC was at 90.05 % utilisation, above its kink, on
2026-09-05) and so do the gauges; a forecast that reads one way today reads
another way tomorrow. Today every forecast is a loss — and not because of
the borrow rate.

**What changed on 2026-09-12 (BUILD-PLAN D4/D5, step A3).** The yield model no
longer refuses anything for profitability. It is served as a forecast
(`/v1/forecast`): both LP-net forms with the gap between them, the drag, the
break-evens, the net at the loan-to-value the user chose, the liquidation
drawdown, and the borrow rate after the user's own borrow on Aave's curve
(read live: optimal usage 90 %, slopes 4.70 % and 10 %, Addendum 13). A
user may open any pool after ticking one sentence that states those numbers
for their position — including a pool the model expects to lose money. The
only refusals left are safety: the registry entry floor, a borrow the pool
cannot fund (24.77 M USDC available on 2026-09-12), stale rates, a paused or
inactive reserve, a disabled asset. That is the founder's decision, and the
copy says what it means: a first-time user can now open a position the model
forecasts at −10.92 % a year on the deployed USDC. The acknowledgment names
that number; nothing hides it.

**The forecast on the live read of 2026-09-12** (`MODEL-NUMBERS-2026-09-12.md`;
gauge words and Aave rates read at block 51,226,072, 19:31 UTC,
`VERIFIED-BASE-FACTS.md` Addendum 12; σ still the 2026-08-31 realized
values). At the live USDC borrow of **4.5174 %** no pool × setting beats the
borrow on both models, and the picture is worse than on 2026-09-05, not
better: the AERO price rose 18 % but the gauges pay a marginal staker far
less. The best cell, cbBTC/USDC at the sheltered width, forecasts
**−10.92 %/yr** on the LP slice (−5.29 % before; gross emissions fell from
14.13 % to 6.15 %) and would need **4.56 ×** today's net emissions to break
even (2.02 × before), or a realized σ of 0.04 in place of 0.40 — which
BTC/USD does not have. WETH/USDC at the sheltered width no longer even beats
the borrow before impermanent loss (3.01 % net against 4.52 %); its steady
and working widths need 11.2 × and 10.9 ×. WETH/cbBTC needs 7.4 × at steady
and 7.1 × at working. **Every priced cell's LP net is negative, so no borrow
rate — not even 0 % — would turn one positive at today's emissions;** the
only lever is the gauge vote, which is Aerodrome's voters', not ours. The
cbZEC/USDC gauge received its first vote in the week (≈ 617 AERO a day to
2026-09-17, on about $1 M of pool liquidity): 1.06 / 3.34 / 16.99 % gross at
the three widths, below the borrow at the two wider ones and without a
calibrated σ at the narrowest, where it would beat the borrow only if
cbZEC's realized σ were under 0.08 — it is not. The two-model check still
does its work, now as a printed gap: at each priced cell's own break-even the
closed form is 0.1 to **32.0 points** more optimistic than the Monte-Carlo
form, and six of the seven cells the closed form alone would call positive
there are not, on the stricter form. Recorded rather than smoothed: at
TODAY's emissions the closed form's published headline for WETH/cbBTC at the
working width (−82.90 %) sits **5.46 points** above the Monte-Carlo form
(−88.36 %), outside the tolerance the sim caps at 0.98 × the borrow rate;
both numbers are shown on that cell, the published column is too optimistic
there — pinned by name in `services/yield/test/model-pin.test.ts` — and
whether the headline should become the Monte-Carlo number is the founder's
call. For a product whose forecast may be a loss on every pool, this is what
"may" means today: it is a loss on every pool, it has been on every read
since 2026-08-31, it stays one at any borrow rate, and it turns positive only
if AERO emissions on the majors' gauges rise roughly four- to eleven-fold or
a pool with a calibrated σ well below today's arrives. Until then the
product is a forecast that says "no" in numbers, a user who may say "yes"
anyway, and hold-USDC and spot beside it.

**Mitigates (code).** `/v1/forecast` never 503s: missing or stale inputs
become safety refusals inside each cell, so the site always shows the picture
and says what may not be opened; `/v1/gate` is unchanged and its 503-on-stale
contract still holds for the consumers that read it. Stale is derived at
serve time from `sampledAt`, never stored; the client re-derives `allowed`
from the refusal list and never trusts the flag; a stale payload allows
nothing. The acknowledgment resets whenever the collateral, amount, setting or
strategy changes, so a user cannot tick it for one position and sign
another. A reserve that Aave's guardian has paused is read (`getPaused`) and
refused (`collateral_paused` / `borrow_paused`); a borrow above the pool's
lendable balance is refused (`pool_cannot_fund`) from the same
`getReserveData` words the rate came from, on the service and again in the
wizard from its own chain read. An implausible emissions APR above 1,000 %
is unpriced (`emissions_implausible`), never served as a return.

**Does not.** There is no auto-alert on negative carry for an open position;
the dashboard shows the numbers, the user decides. The forecast compares an
annual outcome against a *nominal* borrow rate; the compounded debt cost is
~0.12 pt higher, i.e. the comparison is that much friendly on the borrow side
(audit D-LOW-3, not fixed). The "after this borrow" rate is Aave's curve
only; a `MorphoBlueVenue` position is shown at today's rate with the basis
named, because Morpho's adaptive IRM is not modelled yet. The gauge history
that corroborates an emissions anchor is in-process memory, so a restart
serves no forecast for a pool until three refreshes have run — fail-closed,
but a restart is a blind window. And a forecast is not a fence: a user who
reads −10.92 % and ticks the box loses money the model said they would.

## 15 · Demo status

**Risk.** Someone mistakes the demo for a product. Nothing is deployed
(`CONTRACT-ABI.md` §10); no transaction has been signed or broadcast; the web
runs in demo mode with a labelled snapshot; CoW spot has been exercised only in
demo; the fork suite is skipped without an RPC.

**Mitigates.** A demo banner on every page and a `demo` disclosure in every
review (`web/components/Banners.tsx`, `copy.ts: demo`); `planIsSignable` is
false without a deployment; demo addresses are obviously synthetic
(`DEMO_DEPLOYMENT`, asserted absent from `VERIFIED-BASE-FACTS.md` by
`web/test/snapshot.test.ts`).

---

## 16 · Operator powers: a timelocked owner is still an owner

*Added 2026-09-11 (slice F):* the cbZEC/USDC pool's second Slipstream factory
`0xf8f2…61Ef` has its own owner and fee manager, `0xE6A4…2075`, which sets that
pool's swap fee and unstaked fee (Addendum 8), and Aerodrome's Voter decides
each week whether the gauge pays anything; neither is Oilskin, and neither is
bounded by anything in this repo. They join the trust list below.

**Risk.** `CollateralRegistry` is the one owned contract, and the venue it
names for an asset receives every calling account's peripheral rights on every
router call. Before the fix round, replacing that venue was a single owner
transaction with no delay and no announcement, and `unwind` did not even check
the venue's own `enabled()` — so the owner could point an asset at a contract
of its choosing and drain the accounts that used it, which is why the audit
graded "no operator custody" as false.

**Mitigates (code).** Replacing an existing asset's venue is now
`proposeVenue` → **immutable `TIMELOCK_DELAY`** (2 days in `Deploy.s.sol`,
bounded [1 h, 30 d]) → `acceptVenue`, each step emitting the old and new venue
and the `eta` (`VenueChangeProposed` / `Accepted` / `Cancelled`), with
`pendingVenue(asset)` as the view. `register` is first-registration only. Every
path that follows the registry now asserts the venue's own `enabled()`, entry
and exit. The web renders a live pending-venue banner from `pendingVenue`,
naming the asset, the proposed contract and the date, and a standing
`operator-powers` disclosure states the powers plainly. The registry is handed
over with `Ownable2Step` and the deploy script requires `REGISTRY_OWNER` on
mainnet.

**Does not — and this is the honest statement.** The registry owner can still:

* **disable any asset instantly**, in one transaction, with no delay — a denial
  of new positions for every user of that asset (exits are unaffected, by
  design);
* **change the entry health-factor floor instantly**, anywhere in (1.0, 10.0].
  Raising it makes existing positions un-toppable-up and refuses new borrows;
  lowering it to just above 1.0 lets the product offer far more leverage than
  it advertises today. This is **not** timelocked. It cannot move existing
  funds, but it changes what the product will do with the next transaction a
  user signs;
* **replace the venue an asset points at** after the delay, and that
  replacement receives every calling account's peripheral rights on every
  subsequent router call.

**The delay and the events are a warning, not a prohibition.** A user who is
asleep, whose watcher is down, or who does not read chain events is not
protected by them; the protection is real only to the extent that somebody is
watching *and* the user acts inside the window, and both actions available
(revoke the grant, exit) require the user to transact. Nothing on chain
requires the owner to be a multisig. **Therefore no Oilskin surface may say
"no operator custody" or "no owner powers"** — the phrases are in
`web/lib/copy.ts: BANNED_WORDS`, `web/test/copy.test.ts` and
`prototype/test/verify-toggle.mjs` enforce it, and `CollateralRegistry`'s
contract-level doc comment states the powers instead of the claim. Making the
owner a multisig with a published delay and a live watcher is a **plan**.

## 17 · Denial of service by donation (fixed — recorded as a class)

**Risk (was Critical).** `StrategyRouter` asserted an **absolute** zero balance
of the collateral asset and USDC at the end of every call
(`RouterHoldsBalance`). Anyone can send tokens to any address. One base unit of
USDC — $0.000001, from anybody — permanently disabled every open, every unwind
and the keeper's only protective grant, for every user, on an immutable
contract with no owner, no storage and no rescue.

**Mitigates (code).** The non-holder property is now a **delta**: each entry
point snapshots its balance of every token it will touch and requires it
unchanged at exit (`RouterBalanceChanged(token, before, after)`). A
pre-existing donation is inert; a token that actually sticks to the router
still reverts, proved by a `LeakyAccount` test that pushes one base unit at the
router *during* the call and is caught relative to the entry balance, not zero.
`testFuzz_FIX_B9_anyDonationSizeIsInert` sweeps the borrow range × dust size at
5,000 runs.

**The class, which is the point.** The invariant that should have caught this —
`invariant_routerAndPeripheralsHoldNothing`, asserting `balanceOf(peripheral)
== 0` — passed at 1,000 runs only because the Handler had **no action that
could send a token to a peripheral**. It was vacuous. It is replaced by
`invariant_peripheralsAcquireNothing` (a peripheral's balance must equal
exactly what was donated to it) plus `invariant_donationsDoNotBrickTheProtocol`,
and the Handler gained a `donate(seed, amount)` action that fires ~11,100 times
per invariant at the raised settings, with `test_handlerPathsAreLive` driving a
keeper unwind *after* a donation. **Any assertion about a public address's
absolute state is a denial-of-service surface, and any invariant whose Handler
cannot reach the state it forbids is decoration.** Both are now checkable.

**Does not.** Only the router had an absolute-balance assertion in shipped
code. The remaining one is `StrategyRouter.t.sol::_assertRouterEmpty`, a test
fixture with no donation in it, which legitimately asserts zero.

## 18 · The entry floor that one path skipped (fixed)

**Risk (was High).** The entry health-factor floor lived only in
`StrategyRouter.openLeveragedLp`. The shipped "hold" strategy built
`execBatch([permit2, supply, borrow])` and never touched the router, so a
first-time user could open at **HF 1.07 against an advertised 1.55** — 6.5 %
from liquidation, with the UI's own number on the screen — and the keeper had
no room to act.

**Mitigates (code).** The floor is now a property of the **venue call**:
`AaveV3Venue.borrow` reads the account's global health factor after the borrow
and reverts `EntryHfTooLow(hf, floor)`. `StrategyRouter.openBorrowOnly` is the
supported hold shape, with the same registry gate, deadline and delta
assertions, and the web builds it (`web/test/plan.test.ts` asserts the old
three-call batch cannot be produced by either entry point).
`test_FIX_E2_firstTimeUserCannotOpenAnUnprotectedPosition` drives the literal
first-time-user transaction through `createAccountAndExec` and shows it is
atomic — the account is not even created.

**Does not.** As in §8: an owner calling Aave directly from their own account
can still open below the floor. The product's job is never to *build* such a
sequence, and it no longer does.

## 19 · Unbudgeted peripheral authority (fixed)

**Risk (was High).** Every contract the account called became the active
peripheral with authority to call back into the account, and the budget parser
recognised six selectors with no gate on the rest. A raw `exec` to a hostile
token — cbZEC is a B20 precompile with an issuer-controlled implementation —
or a keeper grant on "1 wei of X" escalated to a full drain.

**Mitigates (code).** Rights are **opt-in per call**: `Call.callback`, false by
default; `exec` is a plain call and `execWithCallback` is the opt-in; on the
keeper path the flag is ignored and the account reads
`Permission.allowCallback`, so the **owner** decides which target may act back,
never the keeper. `execFromPeripheral` reverts `CallbackNotPermitted` if an
inner call asks for rights, and nesting is bounded at `MAX_PERIPHERAL_DEPTH =
8`. The set of targets that genuinely need re-entry is enumerable and small —
`StrategyRouter`, `AaveV3Venue`, `SnuggleLpVenue`, `AerodromeSwapAdapter` —
and nothing else is ever called with the flag set. The four token movers the
budget parser could not read (Permit2 batch `transferFrom`, Permit2
`permitTransferFrom` single and batch, ERC-777 `send`, ERC-677
`transferAndCall`) are **refused** on the keeper path with
`UnbudgetableSelector` rather than budgeted — refusing fails closed and is
loud; budgeting would have added four calldata decoders for a capability no
Oilskin flow uses, and `permitTransferFrom` in particular reaches outside the
account into the owner's wallet to spend an unspent signature.

**Does not.** The budget still does not bound a **call tree**: value moved by a
protocol the tree talks to (an Aave `withdraw`, an engine withdrawal) is not
charged, and cannot be without the account understanding every protocol it
touches. The true boundary is stated in `IOilskinAccount`'s doc comment and in
the UI: *the grant's target, and any peripheral it nests into, are trusted
code.* Budgets are also per grant, not per account (§10).

## 20 · Protection that could not fire, and staleness that blinded it (fixed)

**Risk (was two independent Highs).** Before the fix round the keeper had
**never protected anybody**, for two reasons that each disabled it fleet-wide:

* the plan's first root call was `SnuggleLpVenue.closeMany`, which the single
  `Permission` the web asks users to sign (target = router, selector = unwind)
  does not cover — so the dispatcher refused every protective rung and an LP
  account rode from healthy to HF 0.97 with **zero transactions broadcast**;
* the global `PRICE_MAX_AGE_S` of 10,800 s was shorter than the live USDC/USD
  round age of **44,475 s** — normal for a $1-pegged feed whose deviation
  threshold rarely trips — so every borrower's debt row failed the staleness
  guard, every account read `UNKNOWN` on every tick, and the ladder had never
  once run.

**Mitigates (code).** The plan is now **one root `StrategyRouter.unwind` per
pool and nothing else** — `unwind` closes the ids itself through the nested
path — so every call the keeper makes is the call the user signed for;
`GRANT_SELECTORS` must contain exactly one entry and `verify-abi` fails the
build otherwise. Staleness is **per feed and measured**: the keeper walks each
aggregator's own `getRoundData` history at startup, enforces
`max(observed gap) × slack` floored by `FEED_MIN_MAX_AGE_S`, logs the bounds it
will enforce, and a policy that would leave every account `UNKNOWN` is a **loud
fatal** (`FEED_SELFCHECK=fatal` by default). A stablecoin's long heartbeat is
treated as normal, not as an outage.

**Does not.** A grant issued without `allowCallback: true` still produces
nothing (§10). Untracked collateral still means `UNKNOWN` for that user. The
webhook is still the end of the delivery chain. And the lesson generalises:
**a protection whose failure mode is silence needs a test that asserts the
protection fired, not one that asserts the code ran** — which is why the
harvested proofs of concept are kept as regressions with their attack setups
intact.

## 21 · Model uncertainty at the offer boundary (guarded)

**Risk (was High).** The served closed form is **7–32 points optimistic at the
gate boundary** because it ignores time out of range. Every committed
validation row sat in today's deeply-negative cells, where the gap is smallest
(+0.0 … +4.4 pt); the gap is largest exactly where the decision is made. At the
Aggressive setting the gate would have offered a pool the product's own Monte
Carlo says loses money — a wrong number shown to a user who has never used
DeFi, which is the threat model.

**Mitigates (code).** The gate prices every cell twice and offers only when
**both** clear the borrow. `lpNetPct` stays the published headline; `mcLpNetPct`
— the same cell priced by the MC-calibrated affine form, one MC run per pool ×
setting, coefficients in `samples/mc-calibration.json` — is what the decision
needs. In between, the cell is refused with `within_model_uncertainty`. The
guard fails closed one-sidedly: no calibration → `mc_calibration_unavailable`;
a calibration taken at a calmer σ or a different width →
`mc_calibration_stale`; a stormier σ is accepted as conservative; a live pool
fee above the calibrated one becomes a computed haircut, not a refusal. There
is no path back to the closed form alone — `mcCalibration` is a required field
of `GateInputs`, so the type system forced every call site to be explicit, and
a missing file is a `/healthz` 503. At the documents' own published break-even
multiples, **seven of the eight cells the closed form alone would have offered
are now refused**; the eighth (cbBTC/USDC sheltered) is where the two forms
genuinely agree, and it stays offerable — this is a guard, not a blanket. The
web re-derives the same two-model decision client-side and fails closed on a
null calibration.

**Does not.** The MC is itself a model, calibrated on recorded volatility from
a finite history; where both agree they can still be wrong together. The
simulator's own tolerance is now structurally bounded below the borrow rate it
validates (`min(preset ceiling, borrow × 0.98)`, exit 2 if that invariant is
ever edited away), but a tolerance is not an error bar on reality. And a
neighbouring class survives: the emissions anchor is corroborated by only three
in-process readings, so a restart blinds a pool until it re-corroborates.

---

## 22 · Solana module: bridged ZEC on Kamino (design stage, 2026-09-12)

Nothing of this module is built; the risks are recorded now because the design
(`SOLANA-ARCHITECTURE.md`) and the copy it specifies depend on them. Every
number is from `VERIFIED-SOLANA-FACTS.md` (read live 2026-09-12).

**Risk — the bridge is in the trust path.** Solana ZEC is minted only by the
bridge token program `dahPEoZG…CPxe` through its PDA (program-derived address)
`FvULaw…NYds` (proven: seeds `["authority"]`); that program is upgradeable by
`5kx8Aa…Web6`, itself a PDA whose controller was not identified. Behind it sit
NEAR's OmniBridge custody of the locked ZEC and Wormhole messaging. The token has
no freeze authority, but its supply is as sound as the bridge program's
governance. Kamino's own wording — "On Solana, ZEC is a bridged representation
available through NEAR Intents. Holding or transferring it on Solana does not
provide Zcash's shielded transaction privacy." — is the floor for Oilskin's copy.

**Risk — the venue's owner is a real owner.** The ZCASH market's
`lendingMarketOwner` `A11Ezn…zMeR` can change LTV (40 %), liquidation
threshold (65 %), caps (13,000 ZEC / $2 M), the rate curve and the oracle
configuration at any time; no timelock is visible on chain. Kamino Lend, Scope
and Farms are all upgradeable. Kamino's obligation orders (its own stop-loss)
are disabled on this market, so the only automated protection is Oilskin's
keeper.

**Risk — a small, lopsided pool.** $358 K USDC borrowable; +$84 K of new
borrowing prices the pool above Base's Aave USDC rate (4.547 %), +$358 K empties
it; one obligation holds 58.8 % of all debt. A user could *be* the market.
**Mitigates (design):** the pool-size gate (`SOLANA-ARCHITECTURE.md` §7) refuses
an amount the pool cannot fund below the threshold and states the concentration.

**Risk — liquidation depth and terms.** $4.5 M of ZEC liquidity across 30 pools;
a 400 ZEC sale moved price 0.56 % at read; Kamino's bonus is 2–7 % with a 50 %
protocol cut, close factor 20 %, at most $500 K per liquidation.

**Risk — the oracle.** Scope entry 430 = the more recent of Pyth Lazer and
Chainlink, refused above 15 % divergence or two hours of age; the reserve refuses
a price older than 180 s or outside $400–$2,000. A halted price halts the
reserve — and the keeper (fail-closed, as on Base).

**Risk — USDC can be frozen** by Circle (`7dGbd2…Crar`), including the account's
own USDC token account; a frozen account cannot repay from idle USDC.

**Risk — Oilskin's own program is upgradeable** until the founder decides its
authority policy (`SOLANA-ARCHITECTURE.md` §12 (2)). Copy may not claim "no
operator powers" before that.

**Does not (yet).** The program and the keeper process are built and proven on localnet (2026-09-12,
26/26: the owner path, the keeper ladder, and the keeper agent itself repaying from idle USDC and selling
inside a grant), but nothing is deployed and no keeper runs anywhere, so no automated protection exists on
Solana until a deployment and a funded keeper key exist. On mainnet the keeper refuses to act without an
independent ZEC price (Jupiter) agreeing with Scope within 200 bps; the localnet runs Scope-only under an
explicit flag and says so in its log. The exit hatch is `close_position` + `transfer_out`; a
wallet-signed hand-over of the Kamino obligation is impossible on klend (its
transfer needs Kamino's admin and refuses CPI). The keeper's sale margin is
bounded by the grant's allowance (≤ 5 %) and the pre-sign copy must state it. Decided 2026-09-12: the keeper **may sell collateral** to stop a
liquidation, bounded per period and priced off Scope — so the pre-sign copy
must say the keeper can sell ZEC, and how much; the program's upgrade authority
goes to a Squads multisig at deploy, and until that handover a single deployer
key holds it.

## Trust assumptions, in one list

1. The user's wallet key. It owns the account; a lost or stolen key is a lost
   or stolen account. Nothing in Oilskin can recover it.
2. Coinbase, for cbZEC's existence, peg and reserves (§1, §5).
3. Aave v3's oracle and liquidation logic; Aerodrome's pools and SwapRouter;
   the Snuggle engine; Permit2; CoW's settlement — each third-party code we
   call, not audit.
4. **The registry owner** (a multisig — **plan**; the deploy script hands over
   in two steps) for which assets are offered, the entry floor, and which venue
   contract each asset points at. It cannot move existing funds directly, but
   the venue it names receives peripheral rights on every subsequent router
   call, and only the venue replacement is timelocked (§16).
5. The keeper key, bounded by the user's grant (§10), and the four contracts
   the grant's call tree nests into, which are trusted code (§19).
6. The Oilskin treasury address as the fee recipient (immutable per venue).
7. The RPC the keeper and yield service read from; a lying RPC yields
   `UNKNOWN` (keeper) or refused samples (yield), not action.
8. The people who typed `VERIFIED-BASE-FACTS.md` from live reads on 2026-09-05
   and 2026-09-06 and the tests that pin code to it — and the fact that things
   remain **not** in it: the Morpho market ids, the CoW vault relayer, the
   engine's live end-of-list revert shape, and any cbZEC B20 policy state
   (`AUDIT-SCOPE.md`).
9. **For the Solana module, when it exists (§22):** the OmniBridge / Wormhole
   bridge and the program that mints Solana ZEC; Kamino Lend, Scope and Farms
   and their upgrade authorities; the ZCASH market's owner; Circle's freeze
   authority over USDC; and the people who read `VERIFIED-SOLANA-FACTS.md`
   from the chain on 2026-09-12.
