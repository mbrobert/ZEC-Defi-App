# Changelog

Abbreviations: ABI = application binary interface; HF = health factor; LP =
liquidity provision; EIP = Ethereum Improvement Proposal.

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
