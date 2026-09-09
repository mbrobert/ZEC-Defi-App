# Risks — what can go wrong, what mitigates it, what does not

Written for the Base-first v1 tree of 2026-09-06, after the wave-1 audit
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
`VERIFIED-BASE-FACTS.md` records the live `multiplier()` read and the fork test
`test_fork_cbzecIsAB20WithLiveMultiplier` re-reads it.

**Does not.** A seized or paused balance is gone or frozen for the user
regardless of what our contracts do. **The app's disclosure text still says
"Whether any restrictive policy is configured is an on-chain read Oilskin
performs before touching cbZEC" (`web/lib/copy.ts:43`) — no shipped code
performs that read.** `grep -r "multiplier(" contracts/src web/lib agent/src`
finds nothing outside the fork test and the mocks. Either the read ships or the
sentence goes; it is still an open must-fix (`CHANGELOG.md`).

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

**Does not.** The cbZEC/USDC gauge has `rewardRate() = 0`; cbZEC LP earns
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
M-HIGH-1). Two residuals: (a) the keeper's protective `unwind` is resolved by
the router to the first venue holding the asset, so an account with positions
on BOTH the Aave pool and the Morpho venue for the same asset may see the repay
land on the healthier one; `confirm()` then sees a repay that did not lift the
combined health factor and the re-arm bound escalates instead of retrying for
ever (C-MED-2); (b) because the cbBTC market's oracle is BTC/USD while the
keeper's feed is cbBTC/USD, a cbBTC depeg beyond the bound makes the Morpho
position UNKNOWN rather than acted on early — the owner is told; the keeper
does not guess which price is right. Morpho has ONE threshold: a
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
**At the 2026-09-05 borrow read of 4.828 % nothing clears**, so no LP position
can be recommended (`MODEL-NUMBERS-2026-09-05.md`).

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

**Risk.** `OilskinAccount`, the factory, the router, the venues, the adapter
and the registry are new code (3,492 lines, `AUDIT-SCOPE.md`). Aave v3,
Aerodrome, the Snuggle engine, Permit2 and CoW are third-party contracts with
their own histories; the Snuggle engine discloses AI-only audits.

**Mitigates (code + tests).** Stateless peripherals with no admin and no
storage; the router's balance of every token it touches is unchanged across
every call; no standing allowances (`_approveCallReset`;
`invariant_noStandingAllowances`); reentrancy lock in transient storage;
peripheral rights opt-in per call and bounded in depth; revert data bubbled
untouched; **244 unit / fuzz / invariant tests green** (plus 8 fork tests
skipped), with 6 invariants including the user-can-always-exit and
fee-never-touches-principal properties and the two new donation properties.
The one owned contract is the registry, which cannot touch an account — but
see §16 for what it *can* do.

**Does not.** **No external audit has been done.** Wave 1 was an internal
adversarial audit (four lenses), not an external one. The fork suite (8 tests)
has not been run against Base from this container, so the engine's live
end-of-list revert shape is still unrecorded. Slither / Aderyn / Halmos /
Tenderly CI (`BASE-PIVOT-2026-09.md` item 20) is a **plan**. Peripheral-to-
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
for an exit (`close` / `closeMany` take explicit ids); enumeration fails closed
on any revert shape other than `Panic(0x32)`; the fork test
`test_fork_lpOpenCloseOnLiveEngine` exercises the live engine when `FORK_URL`
is set.

**Does not.** The engine's own contract risk is the user's. Fees the engine
keeps are not Oilskin's to refund. The 60-second hold (verified 2026-08,
`AUDIT-LEDGER-2026-08.md`) is not surfaced by the v1 web; a close seconds after
a deposit reverts and is reported as a refused id. And a `Panic(0x32)` at index
*k* from some cause other than the end of the list is still indistinguishable
from the end of a *k*-element list — a property of the engine's generated
getter that no amount of care in our venue removes.

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
(`agent/src/dispatch/quote.ts`).

**Does not.** The quote is still caller-supplied: a dishonest quote still gives
a bad floor. What changed is that the lie is an explicit number in calldata
that a reviewer, a simulation, an event reader or a UI can compare against the
market, instead of a silent default of 1. An oracle-priced absolute floor is
not available to this contract for the pairs Aave does not list (AERO, cbZEC,
USDT, LINK legs), and a rule that protected only some pools would read as if it
protected all of them. `PriceBand` remains a spot `slot0()` check: a same-block
move within the tolerance is the residual. CoW orders carry the user's
slippage; solvers settle at or better than the limit or not at all.

## 14 · Yield verdict and rate drift

**Risk.** The borrow rate (4.828 % on 2026-09-05; Compound v3 USDC was at
90.05 % utilisation, above its kink) moves; a position that clears today may
not tomorrow. Today nothing clears at all.

**Mitigates (code).** `/v1/gate` recomputes on every serve with `stale` derived
from `sampledAt`, and now actually **sends** `stale`, `emissionsSampledAt`
(the oldest sample behind the verdicts) and `engineFeeBps`, so the client's
staleness guard is no longer dead code in live mode; 503 on stale rates;
`/healthz` returns 503 with a `degraded` array when a source is dead or the MC
calibration is missing. The UI re-derives the offer from **both** models and
fails closed on a null calibration (`web/lib/gate.ts`, `lib/math.ts:
clearsGate`). A reserve that Aave's guardian has paused is read
(`getPaused`) and refused (`collateral_paused` / `borrow_paused`). An
implausible emissions APR above 1,000 % is refused (`emissions_implausible`)
rather than served, mirroring the 1-ray bound on the borrow side.

**Does not.** There is no auto-alert on negative carry for an open position;
the dashboard shows the numbers, the user decides. The gate compares an annual
outcome against a *nominal* borrow rate; the compounded debt cost is ~0.12 pt
higher, i.e. the gate is that much permissive on the borrow side (audit
D-LOW-3, not fixed). The gauge history that corroborates an emissions anchor is
in-process memory, so a restart serves nothing for a pool until three refreshes
have run — fail-closed, but a restart is a blind window.

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
