# Changelog

Abbreviations: ABI = application binary interface; HF = health factor; LP =
liquidity provision; EIP = Ethereum Improvement Proposal.

## 2026-09-10 — Slice A: `positionsOf` works on the engine as it is

**Why.** The first fork run (Addendum 3) measured the live engine's end-of-list revert as EMPTY —
the shape of a bare `revert()`, an out-of-gas and a proxy miss alike — and the venue pinned
`Panic(0x32)`, so `positionsOf` reverted `EnumerationFailed(0x)` for every account on mainnet: no
dashboard position list, no keeper id discovery. Accepting `0x` on shape alone would have made a
transient failure read as a shorter list.

**Venue.** `SnuggleLpVenue.positionsOf` accepts a terminating revert of either measured shape only
when four checks agree (`RISKS.md` §12 "Design"): every engine probe runs under `PROBE_GAS` =
200,000 (sized ≥ 8× the dearest probe metered on the fork — Addendum 4) and a probe that exhausts it
is an out-of-gas, not an end (EIP-150; the venue refuses to probe below the 64/63 floor); the canary
at 2^256 − 1 must fail with the same bytes as the end; index k + 1 must fail like k and
`poolIdsCount()` must still answer, unchanged, afterwards; every id must read back as a full
`positions(id)` owned by the account (a mismatch fails closed instead of being filtered). Every
refusal is `EnumerationAmbiguous(fault, index, data)` with an 8-member `EnumerationFault` enum;
`EnumerationFailed` (a mid-list revert of another shape) and `EngineUnreachable` stay. ABI bundle
327 → **329** (the error and the `PROBE_GAS` view); no signature the web or the grant encodes moved.

**Keeper and web.** `@zyo/shared` `describeLpEnumerationFault` names each fault in plain words with
the caveat that a refusal is not an empty list. The keeper's `readLpState` carries it into the
REFUSED reason (never plans as "no positions"; idle USDC is not spent on a refused read). The web
reads `positionsOf` outside the multicall so the revert data survives, sets `AccountRead.lpUnreadable`
with the sentence, and the dashboard shows "Positions could not be read" with it — never "No LP
positions". The agent's ABI seam pins the enum's members against the Solidity source (72 → **75**
checks).

**Measured (Addendum 4).** Fork at block 51,127,409: end-of-list 12,660 gas, canary 12,660, a selector
the engine lacks 11,127 (so a proxy miss is not told apart by gas — residual (b)), a successful
index read 15,275, `positions(id)` 24,463; a live 42-id holder enumerates to 42, owner-corroborated.
`cast` at block 51,143,322: implementation slot `0x359f…2d28`, admin `0x7885…86cb`,
`maxPositionsPerUser()` = 500, `paused()` = false. The implementation's verified source (solc
0.8.33 via-IR) shows the compiler-generated getter and swap-and-pop bookkeeping.

**Tests.** Contracts 304 → **323** / 0 / 8 (23 suites): `EnumerationAmbiguity.t.sol` +18 (every
fault, both shapes, the last-index residual asserted as such), `SnuggleLpVenue.t.sol` +1 (the mock's
default end-of-list is now the measured empty shape, `setEndShape(Panic32)` kept), `LpVenueCliffs`
B11 re-flipped. Fork at the pinned block 4 / 4 → **5 / 3** (`test_fork_engineIndexGetterShape`
green, metering the probes). Keeper 233 → **234**, seam 75/75. Web 152 → **153** (151 / 2 skipped).
Shared 59 → **62**.

**Residuals, stated, not fixed.** An isolated failure at the LAST index is a list one shorter. A
getter-less implementation upgrade is an empty list for every account; only the EIP-1967 slot,
read off chain, can tell — comparing it would park id discovery on every engine upgrade until
re-measured, a product decision left to the founder (`RISKS.md` §12).

**Not done.** No `acceptVenue`, `Deploy.s.sol` untouched, nothing broadcast, `contracts/.env` not
written.

## 2026-09-09 — `RISKS.md` §8 residual (a) closed: the repay reaches every book, the receipt says which

**Router.** `StrategyRouter.unwind`'s repay leg no longer stops at the first venue holding anything
of the account's: it repays EVERY venue the registry names for the asset (`venueOf`, then
`previousVenues`) that the account still owes USDC on, lowest health factor first, until the amount
(max = all the USDC held) is spent, and emits one `VenueRepaid(account, venue, repaid)` per venue
reached. Dust collateral, or a small healthy debt, on the registry's new pointer used to absorb the
keeper's repay while the Aave debt that fired the rung rode on. The withdraw leg and its floor gate
stay on the venue holding the position; `LeveragedLpUnwound.healthFactor` is the worst across the
venues. ABI bundle 326 → **327** (the event); the `unwind` selector and the grant shape are
unchanged. Shape A of the brief (router iterates) over B (explicit venue in the calldata):
`docs/RISKS.md` §8 says why.

**Keeper.** `confirm()` reads the receipt's `VenueRepaid` events and, with the venue reader on,
re-reads every venue: a successful receipt that leaves a venue the account still owes without a
`VenueRepaid` is FAILED (naming the venue, and saying whether the account ran dry on the worse book
or the router skipped it); unreadable venues at confirm time are FAILED too. `repaid == 0` and "no
event" stay FAILED. `policy.ts` is unchanged. ABI seam 71 → **72** checks.

**Tests.** `VenueSwitch.t.sol` 6 → 12 (M1g–M1l, three of them failing on `400c03f`; M1f now expects
one Close to clear both books), `dispatcher.test.ts` +6. Contracts 304 / 0 / 8; keeper 221 / 45;
web 144 / 142 / 2 unchanged with the regenerated ABI.

**Not done.** No `acceptVenue`, `Deploy.s.sol` untouched, nothing broadcast.

## 2026-09-09 — M-HIGH-2's real fix: the keeper and the dashboard read every venue the registry names

**Keeper.** `agent/src/services/venues.ts` `VenueReader` replaces the Aave-only startup guard: on
every tick it reads, per collateral asset, `venueOf`, `previousVenues` and `isEnabled` from the
registry, classifies each venue (`PROVIDER()` = the Aave provider in `@zyo/shared` → the pool the
G1–G4 valuation reads; anything else → read through `ICollateralVenue` alone) and asks every venue
`healthFactor`, `debt` and `collateral` for the account. `agent/src/engine/venueValuation.ts` adds
guards V1–V4: the Aave venue must reproduce the pool snapshot, any other venue's health factor must lie
inside the band the keeper's own Chainlink feeds imply from the venue's collateral, debt and threshold
within `ORACLE_DEVIATION_BPS`, and the combined verdict is the worst venue — UNKNOWN (no rung, an
escalation after the streak) whenever any venue, pointer, threshold or feed is unreadable or the venue
and the feeds disagree. `agent/src/services/accountValuer.ts` is the one path the monitor and the
dispatcher's world check value through. Startup is fatal only for a venue that does not answer the
interface (`UnsupportedVenueError`); a non-Aave venue that answers is a warning. The ABI seam pins the
`ICollateralVenue` fragments against the interface and `MorphoBlueVenue` (61 → **71** checks). Without
a router the keeper still values the Aave pool alone and says so.

**Web.** `readVenueHealth` / `AccountRead.venues`: the dashboard's health factor is the worst venue's,
`null` ("unreadable", N-MED-2 kept) when the registry or any venue cannot be read or the Aave venue
disagrees with the pool read; holdings and debt on a non-Aave venue appear with that venue's live
threshold; `readUnsupportedVenues` now means "does not answer `ICollateralVenue`", so the Morpho venue
is supported and the banner / `venue-unsupported` / wizard opt-out remain for an unreadable venue
only. `COLLATERAL_VENUE_ABI` generated from the bundle (hash unchanged: no contract changed).

**Not done, by design.** `acceptVenue` is not introduced anywhere; `Deploy.s.sol` is untouched; cbBTC
and WETH stay on `AaveV3Venue`. Moving an asset to Morpho is still the registry owner's explicit
propose → timelock → accept. Residuals in `RISKS.md` §8.

**Counts.** Keeper 215 tests / 44 suites, `verify-abi` 71/71; web 144 tests, 142 passed, 2 skipped;
contracts unchanged 298 / 0 / 8.

## 2026-09-08 — Audit wave 2 fix round: every High, Medium and Low in `AUDIT-2026-09-07.md`

Fifteen ids (3 High, 7 Medium, 4 Low, plus the Info wording), each with a test that failed on the
tree before the fix (`docs/AUDIT-2026-09-07.md` §"Fix round" lists id → commit → test path).

**Contracts.** `StrategyRouter.unwind` resolves the venue that HOLDS the calling account's position
(`venueOf`, then the registry's new `previousVenues`), so a venue switch no longer strands what was
opened on the old venue (M-HIGH-1; `test/audit-regressions/VenueSwitch.t.sol`). `ICollateralVenue`
gained `borrowAgainst(collateral, loanToken, amount)`; the router uses it after it has just supplied
a collateral, so on Morpho the debt lands in that collateral's market (M-MED-1). `MorphoBlueVenue`
reads no oracle for `debt`, never for a market with no debt, and reads an unreadable debt market as
health factor 0 rather than reverting, so a repay is never gated by another market's feed (M-MED-2);
its headroom fallback skips markets without enough idle liquidity and reverts `NoMarketCanFill` by
name (M-LOW-1). The router refuses a swap quote that implies a pool price outside the close's own
band (`QuoteOutsideBand`, G-MED-1). `PythOracleAdapter` lost its same-transaction gate: the max-age
and peg rules carry the safety, and every venue view and third-party liquidation now works without a
bundle (P-MED-1; `foundry.toml` pins `isolate = true` and CI runs plain `forge test`, P-LOW-1). The
mainnet deploy guard refuses a treasury equal to the broadcaster and a registry owner without code,
and its two opt-ins travel in `Config` so tests stop racing on process env (S-LOW-1). The invariant
handler gained `switchVenue` and a router-exit probe behind `invariant_userCanAlwaysExitViaRouter`
(M-INFO-1). ABI bundle 321 → **326** entries.

**Keeper.** `confirm()` reads `LeveragedLpUnwound` from the receipt and refuses to call a repay that
repaid nothing CONFIRMED (M-HIGH-1). A startup venue guard refuses to run when the registry points any
enabled asset at a venue that is not the `AaveV3Venue` over the pool it reads (M-HIGH-2). Channels
declare whether they reach a person; a warning only the keeper's own log and store accepted is
`LOGGED_ONLY` (retried, never terminal), startup is fatal without a person-facing channel unless
`NOTIFY_ALLOW_LOG_ONLY=1`, and an event for an account not yet discovered is deferred and attached on
registration instead of dropped (N-MED-1). The owner-history cap is per kind (N-LOW-1). `CHAIN_ID`
other than 8453 is a named `ConfigError` (S-MED-1).

**Web.** Every keeper-budget line is sized in its own token's decimals and price, an unknown or
unpriced pool token refuses the grant with the reason, the dashboard re-grant includes the pool tokens
of live positions, and `describeGrant` reports `no-budget` per token (G-HIGH-1). `readDeployment`
marks assets the registry points at an unreadable venue; the dashboard says so, offers no keeper
permission for them, and the wizard never plans one (M-HIGH-2). An unreadable health factor is
`null` — "Unreadable" on the tile, an alert in the banner — never `+∞` / "No debt" (N-MED-2). Two
absolute claims about what the keeper cannot do are now banned words (G-MED-1).

**Docs.** `RISKS.md` §8/§10, `CONTRACT-ABI.md`, `DEPOSIT-FLOW.md` (box K0, borrowAgainst, the exit
venue rule, the quote band), `DEPLOY-SEPOLIA.md` (§6.2: keeper and web are mainnet-only; §7: unset
the Sepolia env before a mainnet run), `VERIFIED-BASE-FACTS.md` ("would be covered when FORK_URL is
set"), `ARCHITECTURE.md` (Pyth), `AUDIT-2026-09-06.md` (the B-MED-3 wording), `TESTING.md` and
`README.md` counts.

## 2026-09-07 — Step 2: `MorphoBlueVenue` built over the two verified Base Morpho Blue markets

**Facts first.** The cbBTC/USDC and WETH/USDC Morpho Blue markets on Base were
re-discovered through the Morpho GraphQL API (`marketId`, `lltv`, `oracleAddress`,
`irmAddress`, `state`, filtered by `chainId_in` / `collateralAssetAddress_in` /
`loanAssetAddress_in`; 50 markets, two `listed`) and every governing field
re-read from Morpho Blue `0xBBBB…FFCb` with `cast call` at block 51,003,524:
`idToMarketParams` (USDC loan, 86 % LLTV, AdaptiveCurve IRM, Chainlink-fed
oracles), `market()` totals, oracle `price()`, IRM `borrowRateView`, both ids
recomputed with `cast keccak`. Recorded with dates in
`docs/VERIFIED-BASE-FACTS.md` (Morpho addendum, second read). The oracle split is
unchanged: cbBTC and WETH price through the Chainlink feeds already on the
markets; cbZEC would be Pyth-only and has no market, so `PythOracleAdapter`
stays unused.

**Contracts.** `MorphoBlueVenue` is no longer a skeleton. It implements
`ICollateralVenue` over a fixed list of market ids given at construction (each
re-read from `idToMarketParams`, re-hashed, checked to lend the one loan token,
one market per collateral; no admin, no add-market function). Same entry-side
policy as `AaveV3Venue`: `supply` checks the registry's offer at THIS venue,
`borrow` reverts `EntryHfTooLow` against the account's WORST market health
factor (Morpho positions are isolated per market). `liquidationThresholdBps` =
`maxLtvBps` = the live LLTV (one threshold on Morpho). Debt is computed as
Morpho will accrue it (`libraries/MorphoMath.sol`, virtual shares + Taylor
compounding), so `repay(max)` closes every market by shares with no dust. A
venue over no markets reports `enabled() == false`. Constructor signature
changed: `(morpho, registry, loanToken, bytes32[] marketIds)`; ABI bundle and
web ABI regenerated — **303 → 321 entries** (200 functions, 30 events, 91
errors; the venue went from 3 live entries to 19 functions + 13 errors).

**Deploy.** `Deploy.s.sol` builds the venue over the two ids
(`MORPHO_MARKET_IDS`, default = the verified constants) AFTER the registry and
leaves the registry pointing cbBTC and WETH at Aave: moving an asset is
`proposeVenue` → 2-day timelock → `acceptVenue`, never at deploy. Base Sepolia
passes an empty id list (no market exists there).

**Tests.** `CollateralVenues.t.sol` `MorphoBlueVenueTest` (22) mirrors the Aave
suite: construction guards, live LLTV, supply/borrow/repay/withdraw under the
account, exact-to-the-wei repay after a year of interest, two isolated markets
(headroom borrow, worst-first repay, worst-market HF), keeper budgets.
`audit-regressions/MorphoEntryFloor.t.sol` (11) replays `EntryFloor.t.sol`
against Morpho: the hold batch cannot open at Morpho's 86 % LLTV, first-time user
atomic, oracle drift caught, a fuzz that every accepted borrow is at or above
the floor, the venue takes nothing until the timelocked switch has landed, the
router's `openBorrowOnly` and the shipped keeper grant work through the Morpho
venue, thresholds are the market's not a constant, and the owner exits straight
at Morpho in every broken state. Nothing was broadcast.

## 2026-09-06 — wave-1 audit, the fix round, and this docs pass (commits `9b23864`, `52f4a70`)

**Audit.** An internal adversarial audit ran as four independent lenses, with
every Medium-or-worse finding carried by an executed proof of concept: **1
Critical, 10 High, 23 Medium, 24 Low, 8 Info**. The Critical and all ten Highs
are fixed. The findings, the seven binding lead decisions, what was deferred and
the residual-risk list are in the new **`docs/AUDIT-2026-09-06.md`**.

The two that mattered most were silent: a **$0.000001 permanent denial of
service** (the router asserted an absolute zero balance on a public address, on
an immutable contract with no rescue — one base unit from anybody bricked every
open and every unwind for everybody), and the fact that the **keeper had never
protected anybody** — its plan's first call sat outside the only grant users
sign, and its staleness constant was shorter than the live USDC feed's
heartbeat, so every account read UNKNOWN on every tick.

**Contracts (breaking ABI change; nothing was ever deployed).** `Call` gained
`callback` — peripheral rights are now opt-in per call, `exec` is a plain call
and `execWithCallback` is the opt-in, and on the keeper path the flag comes
from `Permission.allowCallback` so the owner, never the keeper, decides.
`StrategyRouter.openBorrowOnly` is new and the "hold" flow uses it;
`AaveV3Venue.borrow` enforces the entry health-factor floor itself and
`supply` enforces the registry's offer. `ISwapAdapter.swap` takes a quote with
an on-chain 500 bps cap (`minOut = 1` is unrepresentable). Venue replacement is
propose → immutable delay → accept, announced and cancellable, with a
`pendingVenue` view. `closeMany` / `claim` / `unwind` no longer revert on a
stale first id; `claim` gained a band, a deadline and a `failed` array; the
band's width, the fee-per-distinct-token, the global exit-HF gate,
`maxOfferedLtvBps` reading both venue parameters, and an idempotent
`createAccountAndExec` all landed. `RouterHoldsBalance` → `RouterBalanceChanged`;
`AccountExists`, `MixedPools`, `ZeroMinOut` deleted. **ABI seam 266 → 303.**

**Code (all suites green, counted by running them on this tree).** contracts
**244** / 8 fork skipped (was 181) · agent **171** (139) · yield **131** (105) ·
web **125** unit (89) + Playwright **12** · shared **53** (52) · prototypes
**118 + 109 + 56** checks + **6** fuzz (85 + 80 + 45 + 6) · root ABI seam
**303/303** (266) · agent ABI seam **54/54** (was failing on four signatures).

**Custody language is now honest everywhere.** A timelocked registry owner is
still an owner: it can disable any asset instantly, move the entry floor
instantly, and replace a venue after the delay — and the delay is a warning, not
a prohibition. Every surface that claimed otherwise was rewritten:
`web/lib/copy.ts` and `web/lib/plan.ts` (plus a new `operator-powers`
disclosure and a live pending-venue banner), both prototypes,
`docs/BUILD-SPEC-2026-09.md:16` and
`:50` (with a dated correction note), `README.md`, `docs/ARCHITECTURE.md`,
`docs/AUDIT-SCOPE.md`. The two phrases are in the web's `BANNED_WORDS` and are
grep-tested in `web/test/copy.test.ts` and `prototype/test/verify-toggle.mjs`.

**Yield.** The gate prices every cell twice — the published closed form and a
Monte-Carlo-calibrated form — and offers only when both clear the borrow; at the
boundary the closed form was 0.2–32 points optimistic, and seven of the eight
cells it would have offered at their own published break-even are now refused as
`within_model_uncertainty`. Emissions anchors need three corroborating readings;
the performance fee is never applied to a loss; a paused Aave reserve is read
and refused; `demo-gate.json` is generated by calling the real gate.

**Docs.** Rewritten to the shipped code: `ARCHITECTURE.md`, `FLOWS.md`,
`CONTRACT-ABI.md`, `RISKS.md` (now 21 sections — the audit findings are recorded
as risk classes, each with what mitigates it and what does not), `AUDIT.md`,
`AUDIT-SCOPE.md`, `TESTING.md`, `README.md`, `SETUP.md`. New:
`AUDIT-2026-09-06.md`. Corrected in place: `BUILD-SPEC-2026-09.md` (the custody
claim, with a dated retraction rather than a silent edit).
`MODEL-NUMBERS-2026-09-05.md` and `YIELD-SERVICE.md` were regenerated by the
yield area in the same round. `VERIFIED-BASE-FACTS.md` gained a 2026-09-06
addendum: the Aerodrome Slipstream SwapRouter
`0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5` and Multicall3 are code-verified,
and the circulating "UniversalRouter" `0x6Cb442acF35158D5eDa88fe602Ef9Cf89694fFEa`
has **no code on Base**.

**Retired vocabulary.** The prototype harness reports which files still mention
the dead NEAR / Rhea / 1-Click / shielded design. All 16 are historical ledgers
or removal records and are correct as they stand — each carries a "History"
banner or names the vocabulary only to say it was deleted. Verdicts file by
file: `/tmp/fix2/done-DOCS.md`.

**Still open after this round** (each with a code pointer in `RISKS.md`):

1. `web/lib/copy.ts:43` still says Oilskin performs an on-chain cbZEC B20 policy
   read before touching cbZEC. **No shipped code does** (`RISKS.md` §4). Ship
   the read or delete the sentence.
2. The keeper's notification chain ends at a webhook — no mailer, no pager, no
   per-user routing — so "→ keeper notify" in the pre-sign copy is still a
   promise it cannot keep alone (`RISKS.md` §10).
3. `REGISTRY_OWNER` is not required to be a multisig, and no watcher on
   `VenueChangeProposed` exists (`RISKS.md` §16).
4. The 8 fork tests have still never run: the engine's live end-of-list revert
   shape is unrecorded, and the venue now requires exactly `Panic(0x32)`
   (`AUDIT-SCOPE.md`).
5. Cross-grant budget aggregation, the trusted-code boundary inside a grant, and
   six Lens-D lows are deferred with reasons (`AUDIT-2026-09-06.md` §4).

## 2026-09-05 — Base-first v1 (commit `b4333d7` + this docs pass)

**Product.** The NEAR / Rhea / 1-Click design is gone. A wallet on Base
deposits cbBTC or WETH on Aave v3, borrows USDC, and holds it or deploys it
through the Snuggle engine into an Aerodrome pool that clears the yield gate;
spot via CoW. Positions live in a per-wallet `OilskinAccount`; the router is
stateless; the keeper acts only inside a revocable grant. cbZEC is spot-only
(registered as collateral, disabled with reason; no market, no emissions).

**Code (all suites green on this tree).** contracts 181 / 8 fork skipped ·
agent 139 · yield 105 · web 89 + Playwright 12 · shared 52 · prototypes 216
checks · ABI seams 266/266 and 36/36. Details and deviations from the spec:
`/tmp/build/done-*.md` at build time; the durable record is `AUDIT.md`,
`AUDIT-SCOPE.md`, `TESTING.md`.

**Verdict.** At the 2026-09-05 borrow read (4.828 %) no pool × setting clears
the gate (`MODEL-NUMBERS-2026-09-05.md`); the product recommends holding USDC.

**Docs.** Rewritten to the shipped code: `README.md`, `SETUP.md`,
`ARCHITECTURE.md`, `FLOWS.md`, `RISKS.md`, `AUDIT.md`, `AUDIT-SCOPE.md` (new),
`TESTING.md`, `PRIVACY.md`. Deleted (dead design, nothing linked to them):
`RHEA-SDK.md`, `INTEGRATIONS.md`, `RUN-DEMO.md` (folded into `SETUP.md`). Kept
as history with a one-line header: `AUDIT-LEDGER-2026-08.md` (the old
`AUDIT.md`), `SECURITY-REVIEW-2026-08.md`, `FEEDBACK-ANSWERS.md`,
`FEEDBACK-ANSWERS-2.md`, `V1-SIMPLE.md`, `UX-TEARDOWN.md`, `POOLS.md`. Restored
from the recovered copies, with headers: `AUDIT-FINDINGS-2026-09-03.md`,
`CBZEC-2026-09.md` (both cited by code and by `BASE-PIVOT-2026-09.md`;
`research/VENUES-2026-09.md` and `INFRA-2026-09.md`, also cited there, were not
recoverable). `VERIFIED-BASE-FACTS.md`: PoolDataProvider casing corrected to
EIP-55 (same hex) and an explicit "not verified" list appended.
`YIELD-SERVICE.md`: two stale references fixed.

**Must-fix found while documenting (not changed — outside the docs area).**
*Superseded: items 1 and 3 were fixed in the 2026-09-06 round above; item 2 is
still open; item 4's root `package.json` description is unchanged.*

1. Web ↔ keeper grant seam: the web grants `StrategyRouter.unwind` only; the
   keeper's plan needs `SnuggleLpVenue.closeMany` too and is refused for LP
   positions (`RISKS.md` §10).
2. The web's B20 disclosure says Oilskin reads cbZEC policy state on chain
   before touching cbZEC; no shipped code does (`RISKS.md` §4).
3. The borrow-and-hold path bypasses the router's entry-HF floor
   (`FLOWS.md` §2).
4. `services/yield/src/abi.ts` comment names the deleted
   `agent/src/vendor/keccak.ts`; root `package.json` description still says
   Rhea / NEAR Intents.
