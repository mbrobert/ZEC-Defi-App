# Testing — every suite, how to run it, what it proves

Counts are from running each suite on this tree on **2026-09-13** (slice N, every suite
re-measured at `ecfb86f` + the sweep; the rows say when a count was last re-measured) —
not copied from build reports. Two audiences: the
automated suites, and a person clicking the demo (the tester's kit at the end).

Abbreviations: RPC = remote procedure call (a chain node endpoint); ABI =
application binary interface; HF = health factor; LT = liquidation threshold;
LTV = loan-to-value; LP = liquidity provision; TWAP = time-weighted average
price; EIP = Ethereum Improvement Proposal; CI = continuous integration;
MC = Monte Carlo.

## Summary

| Area | Command | Counted result |
|---|---|---|
| Contracts (Foundry) | `cd contracts && forge test` | **433 passed / 0 failed / 13 skipped** (446 total), 39 suites |
| Contracts, fork | `FORK_URL=<Base archive RPC> FORK_BLOCK=51222568 forge test --match-path test/fork/BaseFork.t.sol -vv`, then `scripts/check-cbzec-b20.sh <Base RPC> 51222568` | **13 / 13** |
| Root ABI seam | `node scripts/verify-abi.mjs` | **444** selectors / topics / errors across 19 contracts |
| Shared | `npm test -w @zyo/shared` | **114** |
| Solana, seams | `npm test -w @zyo/solana` | **14** |
| Solana, program unit | `cd solana && cargo test --manifest-path programs/oilskin/Cargo.toml` | **12** |
| Solana, localnet | `bash solana/scripts/localnet.sh` (terminal 1) · `cd solana && anchor test --skip-build --skip-local-validator` (terminal 2) | **36 passing / 0 failing** |
| Keeper | `npm test -w @zyo/agent` | **316 tests / 61 suites**, plus its own ABI seam **123 / 123** and the IDL seam **77 / 77** |
| Yield | `npm test -w @zyo/yield` | **179** |
| Web, unit | `npm test -w @zyo/web` | **199** |
| Web, e2e | `cd web && npx playwright test` | **18 passed / 0 failed / 6 skipped** |
| Web, e2e against Base Sepolia | `cd web && npx playwright test -c playwright.sepolia.config.ts` | **3 skipped by name** until `docs/DEPLOYMENTS.md` carries Sepolia addresses |
| Prototypes | `mkdir -p /tmp/build && cp services/yield/samples/MODEL-NUMBERS.md /tmp/build/ && node prototype/test/run-all.mjs` | **verify-simple 130 · verify-advanced 116 · verify-toggle 62 · fuzz 6** |

Since 2026-09-14 the same counts are also **generated**: `npm run status` runs every suite above that
needs nothing but this checkout (`-- --all` adds the fork, cargo, localnet and Playwright suites),
parses each runner's own summary line and writes `docs/STATUS.md`; `npm run status -- --check` exits 1
when that file is stale. The table below is still measured by hand, so it is the one that can drift:
if it and `docs/STATUS.md` disagree, STATUS.md is the one that was measured, and the row here needs
re-running. (That is exactly how README.md came to carry three different contract-suite counts at once.)

Counts are measured on the founder's Mac at the tree they name, and CI re-runs every one of them on each push
(§ CI below). **This table carries the command and today's number, nothing else** — `docs/ROADMAP.md` rule 7:
it is read often and was becoming a changelog inside table cells, which is how it came to state a superseded
407 for the contracts suite and 442 for the ABI seam on 2026-09-13 while the tree said 433 and 444. What each
suite *proves* is in the per-area sections below; what *changed and when* is `docs/CHANGELOG.md`.

**Running notes that are easy to lose.** The Playwright suites use Playwright's own Chromium; a `CHROMIUM_PATH`
that does not exist is ignored rather than forwarded (`prototype/test/_harness.mjs`). If anything else is
listening on **:3111**, the web e2e config's `reuseExistingServer` runs the suite against *that* server —
start your own `NEXT_PUBLIC_FORCE_DEMO=1 NEXT_PUBLIC_E2E_MOCK_WALLET=1 npx next dev -p 3112` and pass
`E2E_BASE_URL=http://127.0.0.1:3112`. A **second** Solana validator beside a running one needs its own ledger,
its own ports (RPC and RPC + 1) and its own `FIXTURES=` directory, with the specs run under
`OILSKIN_FIXTURES=`; sharing the default fixtures silently breaks the first validator's mint authorities.

Prerequisites: Node ≥ 22; `npm install` at the root; `npm run build -w
@zyo/shared` (every consumer imports its `dist/`); Foundry with the two
libraries cloned into `contracts/lib` (`SETUP.md`); Playwright Chromium.
Offline container with a pre-fetched compiler: `FOUNDRY_PROFILE=local`.

**Beyond the default profile**, run in the fix round and reproducible:
`forge test --fuzz-runs 5000` (invariants excluded) → 236 passed / 8 skipped,
0 failed; invariants at `runs=1500 depth=120` → 8 passed, **180,000 calls each,
0 reverts, 0 discards**, spread over the Handler's 16 entry points (the new
`donate` action alone fires ~11,100 times per invariant) — that line is the
2026-09-06 tree. **Re-run on 2026-09-12 on this tree (slice I, the nightly
configuration, 109 s on the founder's Mac): 9 of 10 invariants passed at
180,000 calls each, 0 reverts, and `invariant_singleCloseClearsEveryBook`
FAILED** — a state the default 256 × 40 never reaches; the shrunk sequence,
the root cause (`ZeroQuote` on a 6,192-wei WETH leg) and the fix are in the
2026-09-12 section at the end of this file and in `AUDIT-2026-09-12.md`. **With
the fix (NI-HIGH-1), the same configuration passes: 10 of 10 invariants,
180,000 calls each, 0 reverts, 113.6 s.**

A note on the e2e count: the suite now warms every route in
`e2e/global-setup.ts` before the first assertion. Without that, the first
scenario of a cold `next dev` could miss a 15-second expectation while
`/onboard` compiled — a harness artefact that used to read as flakiness. It is
removed at the source rather than papered over with looser timeouts.

## Contracts — what each suite proves (`contracts/test`)

| File | Tests | Proves |
|---|---|---|
| `Account.t.sol` | 50 | CREATE2 prediction, idempotent `createAccount`, one-transaction `createAccountAndExec` **and its idempotency after a front-run** (`execBatchFromFactory` refuses any caller but the factory and any owner but the real one); owner-only `exec` / `execWithCallback` / `execBatch`; ERC-721/1155 receivers; reentrancy through every door; peripheral callback rights (opt-in per call, active target only, non-transitive, nested delegation restores, depth-bounded); keeper grants: not-granted, expiry, revoke, `NotRevocable`, `revokeAll` epoch, period reset, carry-forward on re-grant, value budget, every recognised token selector incl. Permit2, inner and nested operations charged, malformed calldata fails closed; amount-based budgets vs a rebasing token; 2 fuzz |
| `CollateralVenues.t.sol` | 55 (14 Aave + 27 Morpho + 14 registry) | `AaveV3Venue` supply / borrow / repay(all) / withdraw(all) under the account; **`supply` refuses an asset the registry does not offer here**; **`borrow` reverts `EntryHfTooLow`**; live LT / LTV / rate reads follow the venue; allowances reset; keeper repay within budget; `MorphoBlueVenue` over the two verified Base markets: constructor refuses an unknown / wrong-loan-token / duplicate id, a venue over no markets is disabled and the registry refuses it, LLTV read live from `idToMarketParams` (8600; a 77 % market says 7700), `maxLtvBps` = LLTV, rate from the IRM, supply lands under the account, borrow pays the account with HF = LLTV / LTV and refuses below the floor, borrow beyond LLTV / withdraw below HF 1 revert inside Morpho, **repay after a year of interest approves exactly what Morpho pulls and closes by shares**, repay above owed takes only owed, two isolated markets (headroom borrow, worst-first repay with spill, worst-market HF, `repay(max)` clears both), keeper repay within budget, keeper withdraw pays the account; **wave 2:** `borrowAgainst` puts the debt in the supplied collateral's market and the headroom rule is only the `collateralAmount == 0` fallback (M-MED-1), a broken oracle on one market never gates repay / debt and reads as HF 0 on the debt market (M-MED-2), the fallback skips a market without idle liquidity and reverts `NoMarketCanFill` by name (M-LOW-1); registry `maxOfferedLtvBps` derived from **both** parameters (an LTV→0 deprecation takes the offer to 0), floor bounds, decimals read from the token, cbZEC disabled with note, **venue replacement timelocked / cancellable / re-checked at acceptance**, the two offer views agree on a disabled asset; 1 fuzz |
| `SnuggleLpVenue.t.sol` | 44 | Single / dual open minted to the account; residual and bounce folding; dust floor per decimals; width [150, 5000] / delay / deadline / zero-amount guards; band required / out of range / `slot0` revert / short return / no-code pool; the C-2 enumeration (empty, grows, prunes, re-key, 25 ids, glitch → `EnumerationFailed`, unreachable → `EngineUnreachable` **while the engine's own pause leaves views and exits alone and refuses opens with OZ's string — slice B, the measured pause scope**, exit never depends on it, **both terminal shapes — the mock's default is the measured empty revert, `setEndShape(Panic32)` the Solidity one**); close fee on yield only; `harvest` vs `claimStakingRewards`; refused claims skipped; `closeMany` per-id try/catch; **`claim` reports mixed-pool and foreign ids instead of reverting, and carries a deadline**; increase; keeper close within budget; cbZEC rebase / downward rebase / blocked / paused; 2 fuzz |
| `StrategyRouter.t.sol` | 29 (26 + 3 adapter) | Full open with a real EIP-712 Permit2 signature (spender = account); first-time user in one tx; disabled / unregistered asset; pool must contain USDC; deadline / zero borrow; band protects the deposit; open against existing collateral; wrong-spender / reused-nonce permits; full unwind round trip; unwind on a disabled asset; repay-only; exit-HF floor; **the swap floor is relative to the quote and a sandwiched leg reverts instead of settling for dust**; refused ids reported; keeper unwind within a two-token grant; `sweep` to owner only; router refuses EOAs; swap-adapter guards (cap, zero quote, `minOutFor`); 1 fuzz |
| `StrategyRouterCrossChain.t.sol` | 11 | **2026-09-13, D6 / A5.1** — the arrival: a V2 burn message from Solana (domain 5 → 6, built byte for byte as `VERIFIED-SOLANA-FACTS.md` Addendum 3 lays it out) delivered by anyone mints to the account less Circle's executed fee; replay, a wrong domain and an empty attestation refused by name. `openLpOnly`: the arrived USDC into the pool single-sided with no debt, no collateral and no entry-HF record, nothing on the router; every refusal by name; not a keeper power without a grant. `setSolanaRecipient`: the account's own record, clearable. `closeLpAndBurn`: close → the WETH leg swapped → the whole balance burned (the supply falls) to the recorded recipient, the emitted message decoding to domain 6 → 5, that recipient, that amount, the account as sender; a fixed amount leaves the rest; idle USDC burns with no ids; seven refusals by name incl. Circle's denylist bubbling up, a deployment without the loop, a messenger with no domain; a keeper inside a grant is bounded by the USDC budget and cannot redirect (no grant names `setSolanaRecipient`); an `unwind` grant does not cover the burn; `unwind` on an LP-only position still works (the shared close leg is unchanged) |
| `audit-regressions/RouterDonation.t.sol` | 9 | **The wave-1 Critical, flipped**: a 1-wei donation no longer bricks open or unwind; a collateral-asset donation is inert too; the keeper's protection grant survives the same wei; any donation size is inert (5,000-run fuzz); a router that *gains* a token mid-call still reverts, measured from the entry balance; the exit floor holds when the residual debt is not USDC; a fixed repay against zero debt does not kill the exit; cbZEC stays out even after Aave lists it |
| `audit-regressions/EntryFloor.t.sol` | 10 | The exact three-call hold batch the old UI emitted no longer bypasses the floor; a first-time user cannot open an unprotected position (atomic — the account is not created); price drift between quote and inclusion is caught with no attacker; `openBorrowOnly` carries the same floor; and the documented residual: **raw Aave-pool calls remain the owner's right**, asserted by name |
| `audit-regressions/MorphoEntryFloor.t.sol` | 11 | `EntryFloor.t.sol` replayed against `MorphoBlueVenue` (cbBTC moved to Morpho by propose → timelock → accept in `setUp`): the hold batch cannot open at Morpho's 86 % LLTV and the advertised 50 % passes at HF 1.72; a first-time user is refused atomically; oracle drift on the market's own oracle is caught; a fuzz that every accepted borrow is at or above the floor; **the venue takes nothing until the timelocked switch has landed** (proposed-not-accepted still refused, the old venue refuses after); the router's `openBorrowOnly` and the shipped keeper `unwind` grant work through the Morpho venue; thresholds are the market's, not a constant (a 77 % market registers at 49.67 %); raw Morpho calls remain the owner's right; the owner exits straight at Morpho with the asset disabled and the engine paused, to the wei; the router unwinds a disabled asset on Morpho |
| `audit-regressions/GrantEscape.t.sol` | 14 | A grant on a token cannot escalate to peripheral rights; the keeper cannot set the callback flag; the five unbudgetable movers are refused on the keeper path while the owner may still use them; zero / duplicate token lines and a zero selector refused at grant time; period-rolled views; `NotRevocable` |
| `audit-regressions/PeripheralCallback.t.sol` | 10 | `CallbackNotPermitted` for an inner call that asks for rights; depth bounded at 8 (the proof of concept drove 40); **the registry owner cannot swap a venue in one transaction**; the exit refuses a disabled venue but not a disabled asset; **the web's exact keeper grant cannot be redirected inside the delay**; peripheral reentrancy bounded and documented |
| `audit-regressions/LpVenueCliffs.t.sol` | 11 | A stale first id is reported, not fatal; the router's unwind survives a re-key; duplicate ids never paid twice; **B11 re-flipped in slice A: the measured empty shape enumerates in full and an isolated failure before the end (at index 0 or mid-list, under either shape) is `EnumerationAmbiguous(InconsistentEnd)`, not a shorter list**; the canary that answers still fails closed; a degenerate `(X, X)` pool is refused on the way in and by the router; the fee bound holds on every path (5,000-run fuzz); an unbounded band window is refused and a real one still passes |
| `audit-regressions/EnumerationAmbiguity.t.sol` | 18 | **Slice A (`RISKS.md` §12 "Design")**: an engine with every enumeration failure as a switch. Both terminal shapes enumerate (empty and `Panic(0x32)`, including empty lists); an isolated failure before the end is `InconsistentEnd` under either shape; **the last-index residual is asserted AS a residual** (A4 reads a 5-list as 4 and says so); an out-of-gas mid-list, at the canary, or at the k + 1 probe is `ProbeOutOfGas` / `InconsistentEnd`, never an end; the venue refuses to probe below the EIP-150 floor (`InsufficientGas`) and answers with the stipend; a canary that answers (`CanaryAnswered`) or fails with a third shape (`TerminalShapeUnknown`); an end that fails unlike the canary, in both directions, and a mid-list string revert are `EnumerationFailed`; an id owned by someone else, or by `address(0)`, is `OwnerMismatch` (fail closed, not filtered); a `positions(id)` that returns short, reverts, or carries a dirty owner word is `PositionUnreadable`; `poolIdsCount` changing under the read is `LivenessLost` and dying is `EngineUnreachable`; the product's own mock under both shapes |
| `audit-regressions/LoanDust.t.sol` | 5 | **Slice C (`RISKS.md` §8 "Rounding dust")**: `LoanDust.UNITS` = 100 loan-token units, 0 / 1 / 100 dust and 101 not; the fork scenario on the mock — the account holds exactly the borrow, Aave says one unit more (`bumpDebt`): `repay(max)` repays everything held, leaves the unit, `debt()` reports it, no allowance stands; Aave (`HealthFactorBelowOne`) refuses `withdraw(max)` while the unit is owed and releases the collateral once it is repaid; `repay(max)` with enough held clears to zero; an account holding no USDC is `InsufficientLoanToken(asset, 0, owed)` by name and a fixed amount above what is held is clamped; a two-book account whose CURRENT venue carries only a rounding unit sends the withdraw leg to the previous venue where the collateral is (defensive: the live venues never let collateral reach zero with debt outstanding, and the test says so) |
| `audit-regressions/VenueSwitch.t.sol` | 12 | **Wave-2 M-HIGH-1, flipped**: after `proposeVenue` → timelock → `acceptVenue` moves cbBTC to Morpho, the keeper's exact unwind repays the Aave position, the owner's Close withdraws the collateral, an LP unwind repays instead of only closing, `previousVenues` never duplicates, a new position resolves the current venue first, and positions on both venues are each reachable. **2026-09-09, `RISKS.md` §8 residual (a), flipped** (M1g–M1l): dust collateral on the Morpho pointer no longer hides the Aave debt (`repaid 0` before); a small healthy Morpho debt no longer absorbs the repay (Aave untouched before); a bounded repay goes to the worst book first; the Aave-only shape is unchanged; one `VenueRepaid` per venue, worst first, summing to `LeveragedLpUnwound.repaid`; the event's health factor is the worst book's. M1f's first Close now repays both books (40k, not 10k) |
| `audit-regressions/GrantShape.t.sol` | 3 | **Wave-2 G-HIGH-1**: the grant lines the web now sizes (each token in its own units at 2 × debt) let the keeper unwind a WETH/USDC LP for a cbBTC user; the old line (the collateral's number reused) is `TokenBudgetExceeded`; no line is `TokenNotBudgeted` |
| `audit-regressions/DustLegClose.t.sol` | 4 | **NI-HIGH-1 (2026-09-12), found by the nightly invariant configuration on its first local run** (`AUDIT-2026-09-12.md`): an open LP with 6,880 wei of WETH fee accrued (6,192 net of the venue's cut) — the web's exact single Close (`unwind(ids, repay max, withdraw max)`) succeeds, emits one `DustLegKept(account, WETH, 6192)`, leaves the dust in the account, repays the debt and returns the collateral, router and adapter holding nothing; the keeper's protective `unwind` inside its grant runs on the same state and nothing is charged for the kept leg; a 0.1-WETH leg is still swapped (no event, WETH 0 after, USDC up) and an empty quote is still the adapter's `ZeroQuote`; a 512-run fuzz over 1 wei … 0.001 WETH that the boundary is exactly `swapAdapter.minOutFor(net, quote) == 0` — kept below it, swapped at or above it, the Close clearing debt and collateral on both sides. **Failed first on `c7d90f1`**: three of the four `ZeroQuote()` (the fuzz's counterexample at 22,619 wei), the unchanged-behaviour test passing on both |
| `B20.t.sol` | 10 | Router open → rebase → unwind; blocked account mid-flow; paused reward token never blocks the exit; cbZEC refused as collateral; blocked treasury never bricks the user; seized idle balance is not our loss; swap is amount-based; blocked swap leaves no allowance; keeper budget survives a rebase; 1 fuzz |
| `PythOracleAdapter.t.sol` | 17 (14 + 3 TickMath) | TickMath canonical values and the two live pool ticks reproducing the verified prices (−198319 → 2,441 USDC/WETH; −23228 → 1,020 USDC/cbZEC); a fresh on-chain price answers with no refresh in the transaction and a stale one is `StalePrice`; refresh then price in one transaction, and in ONE top-level call through a bundle contract (the production shape, green under isolation); stale update refused; max-age re-checked; excess fee refunded; peg break both directions; TWAP-not-spot; pool unreadable fails closed; non-positive price; `peek`; 1 fuzz |
| `DeploySepolia.t.sol` | 8 | Base Sepolia constants are the facts document; guard refuses every other chain (including mainnet) and requires TREASURY / REGISTRY_OWNER before code — carried in the `Config` the test builds, never written to process env (`vm.setEnv` is process-wide and Foundry's parallel tests raced it into a `MissingEnv("TREASURY")` flake; slice 3, 2026-09-10); guard catches Aave provider drift; the substitutes are one function of the tick (pool token order / spacing / fee, engine pool approval + 60 s hold, both swap rates, round trip mints no value); a tick override moves pool and router together; the **unchanged** `Deploy.deploy()` wires the substitutes where the venues go (WBTC and WETH enabled at 5000 bps offered, cbZEC stand-in disabled with its note, two-step ownership); the faucet funds the mock router. The **positive** guard path needs the live chain and is proved by the dry run recorded in `DEPLOY-SEPOLIA.md` §3 |
| `Deploy.t.sol` | 11 | Verified constants; guard refuses unknown chain / unconfirmed mainnet / missing env / no code; guard catches Aave provider drift; **wave 2 (S-LOW-1):** on 8453 the treasury may not be the broadcaster and the registry owner must be a contract, both mainnet-only, and the two opt-ins are read into `Config` by `configFromEnv` (no more process-env races between parallel tests); deploy wires everything in the new order (registry with its immutable timelock → venue against the registry → assets, cbZEC disabled with note, two-step registry ownership); optional Pyth adapter |
| `invariant/Invariants.t.sol` | 10 invariants (incl. call summary, and one KNOWN FAILURE recorded as a test waiting for its fix) + 1 liveness test | User can always exit via raw `exec`; **user can always exit via the router** — `unwind` reaches the position whatever the registry points at, with the handler switching cbBTC between Aave and Morpho at random (wave-2 M-HIGH-1 / M-INFO-1); keeper never exceeds a grant; fee ≤ `performanceBps` of yield actually paid, never collateral; **a peripheral never acquires a balance of its own** (it holds exactly what was donated); **donations do not brick the protocol**; no standing allowances; every handler path is live, including a keeper unwind after a 1-wei donation; **the repay reaches every book** (2026-09-10): the handler opens on the registry's CURRENT venue — Morpho after its own test-only propose → warp → accept, never in `Deploy.s.sol` — while the Aave book stays open, and `repayAcrossProbe` (under a snapshot, ghosts written after the revert) funds the account to cover every book, runs the owner's `unwind(repay max)` and requires that no venue the registry names for cbBTC (pointer + `previousVenues`) still owes, or a revert carrying a custom-error name; the router-exit probe now sums debt and collateral across both venues and withdraws from each, the raw-exit probe clears the Morpho book at Morpho by shares, and the Morpho venue joins the acquire-nothing / no-standing-allowance / donation lists. `test_handlerPathsAreLive` proves the two-book state is reached; **slice D (2026-09-10): `singleCloseProbe` runs the web's exact single Close (`unwind(ids, repay max, withdraw max)`, funded with every book's `debt()`) on every two-book state under a snapshot and counts the runs that stranded the second venue's collateral; `invariant_KNOWN_singleCloseStrandsCollateral` asserts stranded == two-book runs (the bug, every time) and that no such run reverted or stranded nothing — a KNOWN FAILURE with the flip written into its message, and `test_handlerPathsAreLive` reaches it once** |
| `fork/BaseFork.t.sol` | 10 (skipped without `FORK_URL`; **9 / 1 / 0 against Base at block 51,127,409 after slice D, 2026-09-10** — 8 / 1 of 9 after slice C, 7 / 2 after slice B, 5 / 3 of 8 after slice A, 4 / 4 on the first run; the one failure is the cbZEC B20 harness limit) | Aave provider resolves to the verified addresses (pass); reserve params live + cbZEC not listed (pass); cbZEC B20 shape (`0xef` code, 8 decimals, `multiplier()`) — **fails inside any fork EVM**, the values were read live with `cast` instead; cbZEC/USDC `slot0()` + token order + tick spacing 200 (pass); the engine's index-getter shape on the live engine (**pass since slice A**: the end-of-list and the canary revert empty and identically, each probe shape is metered under the venue's stipend — 12,660 / 12,660 / 11,127 / 15,275 / 24,463 gas — a fresh address enumerates to nothing and a live 42-id holder to 42, owner-corroborated); supply → borrow → repay(max) → withdraw(max) under the account (**pass since slice C**: funded by the borrow alone, `repay(max)` repays everything held and leaves 2 units of rounding, Aave refuses `withdraw(max)` with `HealthFactorLowerThanLiquidationThreshold()` while they are owed, the top-up to `debt()` clears them, `withdraw(max)` returns 99,999,999 — Addendum 6); **the two-book withdraw-leg gas** (slice D, new, pass: a `MorphoBlueVenue` over the real markets on the fork's own registry, cbBTC switched by propose → timelock → accept, a book on each venue; each venue's `withdraw(max)` and the router's two views metered — `RISKS.md` §8 options, Addendum 7); open → close on the live engine (**pass since slice B**: entries selected by property land on the Aerodrome CL100 WETH/USDC entry — id minted to the account and auto-staked, `positionsOf` sees it, a close inside the 60 s hold is `MinimumHoldTimeNotMet()`, `closeMany` inside the hold reports every id, the close at +2 min returns 999.999999 USDC and 0 WETH — the single-sided deposit is a one-sided range, not a swap — venue holds nothing); **the engine's refusal shapes on an un-gauged entry** (new, pass: `NotPositionOwner()` ×4, `NoFeesToHarvest()`, `NoRewardAdapter()`, the venue's `claim` on a foreign id reports it, the un-gauged position closes); Permit2 / Morpho / Pyth code present (pass) |

Fuzz and invariant depth are set in `contracts/foundry.toml` (`[fuzz] runs =
512`, `[invariant] runs = 256, depth = 40`). Mocks (`test/mocks`) mirror the
verified engine semantics (index getter with the measured empty end-of-list, replace-on-rekey,
≈0 single-sided residual with the deposit kept one-sided, long-leg bounce, new id per deposit,
the engine's own revert names and arities measured in slice B, a pause that stops deposits only)
plus test switches labelled as such (glitch, unreachable, refused withdraw / claim), and `MockB20`
(rebase, block, pause).

**Why the invariant suite is worth trusting now.** The old
`invariant_routerAndPeripheralsHoldNothing` asserted `balanceOf(peripheral) ==
0` and passed at 1,000 runs — **only because the Handler had no action that
could send a token to a peripheral.** It was vacuous while one base unit of
USDC would have permanently bricked the protocol. The Handler now has a
`donate` action, the invariant is a ghost-tracked equality rather than a zero,
and `test_handlerPathsAreLive` proves every path is reachable. Treat any
invariant whose Handler cannot reach the forbidden state as decoration.

## Keeper (`agent/test`, 29 test files)

`npm test` runs `tsc`, then `scripts/verify-abi.mjs` (**75 checks**: selectors,
output layouts, event indexed layout, error declarations on the right contract,
the swap-adapter comparison, the `CollateralRegistry` and `AaveV3Venue` fragments,
the `ICollateralVenue` fragments the venue-aware reader encodes against the
interface AND against `MorphoBlueVenue`, pinned Aave / Chainlink selectors including
`getRoundData` `0x9a6fc8f5` and `tickSpacing` `0xd0c93a7c`, and two structural
checks — `GRANT_SELECTORS` must contain **exactly one** entry and
`KEEPER_GRANT_SHAPE` must name `unwind` with `allowCallback: true` — and,
since slice A, `SnuggleLpVenue.EnumerationFault`'s members read from the Solidity
source must equal shared `LP_ENUMERATION_FAULTS` in order, because the fault
travels as a `uint8`; skips
loudly if `contracts/out` is absent, `VERIFY_ABI_STRICT=1` makes that fatal),
then `node --test` over the suites. Inside: thousands of poisoned valuation
snapshots via `fast-check`; random HF paths through the ladder; price bands;
real-process and end-to-end runs (a spawned `dist/src/index.js` over an HTTP
JSON-RPC mock; in-process keeper mode over a behavioural account / router /
LP-venue mock that executes signed raw transactions); config strictness; store
atomicity, lock, tamper detection, duplicate rejection, monotonic counters; log
redaction across full runs.

The wave-1 proofs of concept are kept as regressions with their attack setups
intact and their expectations flipped: `fixC1-grant-ladder` (an LP account
walking the ladder is **protected** under the web's single unwind grant),
`fixC2-feeds` (per-feed heartbeats; a policy that would blind the fleet is a
startup fatal), `fixC3-availability` (15 accounts, one wedged, every other
account still evaluated on every tick), `fixC4-store` (a short write fails
loudly with the last-good store intact), `fixC7-notify` (a rung is `NOTIFIED`
only when a channel accepted it), `fixC9-crash-replay` (a replay after a lost
transaction closes *less*, not more).

`RISKS.md` §8 residual (a) is the `dispatcher.test.ts` block "RISKS §8 residual
(a)" (11): the 2026-09-08 router's receipt — the healthy Morpho book repaid, the
Aave debt riding — is FAILED naming the Aave venue; the fixed router's receipt
carries one `VenueRepaid` per book, worst first, and is CONFIRMED; USDC running
out on the worse book is CONFIRMED with a shortfall note when the dispatch-time
per-venue snapshot (`DispatchRecord.venueBooks`, slice 5, 2026-09-10) proves the
worse book was paid, and the retry is SUPERSEDED — FAILED without a snapshot, FAILED
as the wrong book when a book owed at dispatch was skipped with USDC left or paid
before the book in more trouble, FAILED for debt on a venue that owed nothing at
dispatch (`judgeUntouched`, also pinned pure); the
Aave-only shape with the reader on is CONFIRMED; a receipt naming no venue, and
venues unreadable at confirm time, are FAILED. The mock router models the fixed
rule, with `repayFirstHoldingVenueOnly` for the old one.

The wave-2 M-HIGH-2 fix is `venueReader.test.ts` (26; 2026-09-10 residual (b): both disagreement directions valued at the pessimistic health, repay sizing, the withdraw gate, monitor rung + one notice, dispatcher end to end) and `venueGuard.test.ts`
(8): every venue the registry names — current pointer and `previousVenues` — is
read through `ICollateralVenue` on a behavioural mock whose non-Aave venue has
Morpho's shape (worst-market health factor, per-market debt, LLTV read per
asset); the Aave path is unchanged and cross-checked, a Morpho position is OK
at 1.72 and never NO_DEBT, rungs fire on it through the monitor and the
dispatcher (an end-to-end repay SENT → CONFIRMED with `repaid > 0`), a
disagreement between the venue's health factor and the keeper's own feeds is
UNKNOWN in both directions, and the startup probe is fatal only for a venue that
does not answer the interface.

## Yield (`services/yield/test`, 17 files)

Strict Aave decoding (exact word counts, bounds, a half-readable sample
refused; fixture reproduces 4.828 % / LT 7800 / 8300, plus the new `getPaused`
read); gauge reads with **corroborated anchors** (the first reading is never an
anchor; a single anomalous reading cannot move it; an outlier withholds its
APR); `epochActive` re-derived from `periodFinish` at serve time; the gate's
twenty refusal reasons; the model; **`gate-guard.test.ts`** — seven tests that
feed the published break-even multiples through the shipped `evaluateGate` and
assert that seven of the eight cells the closed form alone would have offered
are refused, while the one cell where the two forms agree stays offerable;
**`model-pin.test.ts`** replays the recorded words through the real
`GaugeSource` + gate and asserts every served cell matches the Python sim's
closed-form cell; **`demo-gate.test.ts`** re-runs the gate over the committed
`demo-gate.json` and asserts **field-for-field equality on all 81 verdicts**;
server (503 on absent / stale rates, `degraded` array, the three fields the web
reads); bands (the performance fee never applied to a loss); config
(`near|rhea|oneclick|intents` knobs cannot reappear); event decoding; indexer;
lifecycles; cohorts; registry; RPC.

`scripts/lp-sim.py` additionally asserts, before running any cell, that its own
tolerance is below the borrow rate it validates (`min(preset ceiling, borrow ×
0.98)`) and **exits 2** if that is ever edited away; it exits 3 if `--as-of`
falls outside a recorded-active epoch, and it verifies the affine MC
calibration is exact (worst error 1.5e-13 pt).

## Web (`web/test` 14 files, `web/e2e`)

Unit: `abi.test.ts` (re-reads `contracts/abi/oilskin-abi.json`, builds **every
write the product can send** — open lp / open hold / first-time / existing,
unwind, claim, grant, revokeAll — and compares the outer *and inner* four bytes
against the compiled artifact's own selector table, asserting `callback` is
true only for the router and the venues and false for a token, a pool and
Permit2; fails on a stale bundle hash), `plan.test.ts` (including: the hold
flow can no longer build the three-call batch that skipped the entry floor),
`keeper.test.ts` (the grant the web asks users to sign is read from
`agent/src/abi/oilskin.ts`'s own `KEEPER_GRANT_SHAPE` and asserted identical;
the six grant states incl. `cannot-act`; the expiry warning window is read from
`agent/src/config.ts`), `quote.test.ts` (both pool token orderings, the oracle
cross-check, every refusal), `model-numbers.test.ts` (parses both published
model tables and compares every cell with what the app **renders**, through the
same formatters the components use — mutation-checked: moving one `mcLpNetPct`
by 0.01 fails three tests), `snapshot.test.ts` (demo market equals the
`VERIFIED-BASE-FACTS.md` tables; every external address the web uses appears in
the doc; demo addresses do not), `copy.test.ts` (the disclosure list covers
every topic; the banned entry words **and now "no operator custody" / "no owner
powers"** do not appear under `app/`, `components/`, `lib/`; every `GateReason`
has both Advanced text and a plain sentence, and no plain sentence leaks a
`snake_case` code), plus `execute`, `gate`, `math`, `onboarding`, `positions`,
`b20` (the cbZEC policy probe: what it reads, what it refuses to call clear), `reads` (now venue-aware: the Morpho venue's health, debt and collateral are
visible at the venue's own threshold, the worst venue's health factor is shown,
and any unreadable venue — or an Aave venue disagreeing with the pool read — is
`null`, never ∞), `wizard`.

E2E (`e2e/demo-flow.spec.ts`, `NEXT_PUBLIC_FORCE_DEMO=1`, no wallet, no RPC):
landing → onboarding (jurisdiction first, three steps, wallet-address help,
pinned cbZEC + counterfeit check); Simple wizard (collateral → computed setting
→ one recommendation with the closest miss named → review with plain sentences
→ simulated sign incl. keeper protection); Advanced wizard (every pool with the
model's numbers *and* the MC net, why-not list, custom controls, technical
detail naming `openBorrowOnly`); dashboard (tiles, ladder band, position card,
claim / unwind panels, the keeper panel's status / expiry / budgets / "not
bounded by them" caveat, Advanced raw data); spot; no horizontal overflow on
every page and wizard step in both modes. Each at 1360 px and 390 px.

## Prototypes (`prototype/test`)

`run-all.mjs` runs `verify-simple` (**118**), `verify-advanced` (**109**),
`verify-toggle` (**56**) and `fuzz` (**6**). `verify-toggle` diffs the
byte-equal shared block between the two pages, deep-equals `OIL_SHARED` against
the built `@zyo/shared`, checks the derived functions against shared's, checks
`OIL_CHAIN_READ` against `docs/VERIFIED-BASE-FACTS.md` and `OIL_MODEL` against
the published model numbers, and asserts cross-build parity verdict-for-verdict
across the boundary cells, 45 pool × width cells, the pauses, the corroboration
state and the re-vote. It also greps both builds for the five retired custody
claims (the exact patterns are the `CLAIMS` array in `verify-toggle.mjs`, and
`RISKS.md` §16 explains why each is false) and fails if any returns. Every suite
runs the removed-vocabulary
guard (`_harness.mjs: FORBIDDEN`) over the shipped pages and reports, **as
information**, which docs still mention that vocabulary — see
`/tmp/build/prototypes-removed-symbols-grep.json` and the verdict list in
`CHANGELOG.md`. The static checks scan the markup for any typed ±, HF, drop %,
rung, LT or borrow literal.

The fuzz suite is 3 seeds × 5,000 actions × 2 builds, now including
`renewGrant`, `revokeGrant`, `expireGrant`, `swapReverted`, the four simulation
levers and a pure `gateProbe`, with new invariant families: the grant's
remaining time stays in `[0, term]`; **an expired or revoked grant never lets a
rung fire**; every verdict's reason is a known one and carries a plain-English
sentence; an offered cell clears the borrow on *both* forms and never through a
pause or an uncorroborated anchor; the swap floor is always inside
`(0, quote]`.

## Clicking the demo — the tester's kit

Both prototypes carry a **🧪 Test kit** button (bottom-right; demo build only,
like the `window.__oil` seam the fuzz uses). It drops demo values into the
right field or flips a simulation:

- **Wallets**: connect Coinbase Wallet (demo `0x7a3F…0c1E`) or a second wallet
  (`0xB44e…e5F6`) — the second one sees "Nothing under this wallet"; disconnect.
- **Amounts** per asset: min ✓ · typical ✓ · whole wallet ✓ · below min ·
  over balance · negative · zero (the last four block at the reducer).
- **Price**: −25 / −40 / −55 / +30 % and reset — watch the HF band and the
  ladder rungs; a full crash walks through repay → de-risk → emergency.
- **Fast-forward** 1 / 30 days in bounded ticks — long enough to expire the
  keeper grant, watch the ladder refuse to act, and Renew to restore it.
- **Borrow rate** 9 % and reset — the gate re-runs on every pool.
- **WHAT-IF emissions ×5 / ×12.33 (simple) / ×8.67 (advanced) / off** — the
  only way to open the LP flow, because nothing clears at today's numbers; ×5
  is the smallest whole multiple above cbBTC/USDC's 4.56× break-even, and
  ×12.33 (WETH/USDC, simple) and ×8.67 (WETH/cbBTC at ±0.75 %, advanced) land
  inside the **`within_model_uncertainty`** band at the page's chain-read
  borrow, where the closed form would offer and the Monte Carlo refuses (the
  lever values are re-derived from the model on every re-pin, 2026-09-12).
  Every surface stamps "not today's numbers" while it is on.
- **Try the pre-fix raw batch at Aave's full LTV** — reverts at the borrow hop
  with `EntryHfTooLow(1.07, 1.55)`, both numbers computed from the live LT and
  Aave's own LTV, never typed.
- **Sandwich the unwind swap** — the confirm moves nothing and the activity
  says the call was atomic.
- **Failures**: wallet rejects the signature; router reverts mid-hop; engine
  bounces 12 % (refund folding + dust left idle); position out of range / back
  in; keeper offline / back; corrupt store (reset with a boot note); wipe
  store; "See an example" (never persisted).

Things to try to break: LTV above the per-asset top; width outside
[150, 5000]; borrowing while the warn rung is fired; topping up into a pool
that no longer clears; a second sign while one is in flight; closing the
modal mid-flight; two tabs; Enter/Space ×4 on Confirm (one position);
withdrawing collateral below the 1.55 floor; acting on an expired grant. Each
is prevented at the reducer and has a named check.

## CI (`.github/workflows/ci.yml`, `.github/workflows/nightly-invariants.yml`)

Since 2026-09-12 (slice I) every area has its own job on push to `main` and on
pull requests, and no job can go green over a suite it did not run:

| Job | Runs | Proves |
|---|---|---|
| `contracts` (three jobs: `unit`, `audit-regressions`, `invariant`) | `forge test -vv --threads 1 --match-path <group>` — `test/*.t.sol` minus the sub-directories (forge's `*` crosses `/`, so `--no-match-path "test/{audit-regressions,invariant,fork,halmos}/**"`; 9 files / 250 tests), `test/audit-regressions/*.t.sol` (17 / 132), `test/invariant/*.t.sol` (1 / 11); each job prints `contracts (<group>): P passed / F failed / S skipped of T` into the run summary | the 31 suites at `foundry.toml`'s 256 × 40, split so that no job compiles every test contract at once (below: why) |
| `contracts-build` | `forge build --skip test`, uploads `contracts/out` | one compile of the product contracts and scripts, shared by the two seam jobs (they read product artifacts only) |
| `abi-seam` | `node scripts/verify-abi.mjs`, then `VERIFY_ABI_STRICT=1 node agent/scripts/verify-abi.mjs`, both on the downloaded artifacts | the committed bundle equals the compiled artifacts (exit 1 on drift) and the keeper's seam runs with nothing skipped — before this slice the keeper job had no artifacts, printed `verify-abi: SKIP` on every run and stayed green |
| `agent` | `VERIFY_ABI_STRICT=1 npm test -w @zyo/agent`, `npm test -w @zyo/yield`, on the artifacts | keeper 123/123 strict + IDL seam 77/77 + 316 tests; yield 179 |
| `shared` | `npm test -w @zyo/shared` | 114 |
| `web` | `npm run typecheck -w @zyo/web`, `VERIFY_ABI_STRICT=1 npm test -w @zyo/web` | tsc clean; 199 tests, the ABI-drift test and both model pins RUN |
| `prototypes` | Playwright's Chromium (`playwright install --with-deps chromium`), `services/yield/samples/MODEL-NUMBERS.md` copied to `/tmp/build/` so `verify-toggle`'s model pin runs | 118 · 109 · 56 · 6 |
| `fork` | `forge test --match-path test/fork/BaseFork.t.sol -vv` at `FORK_BLOCK` (pinned in the workflow's `env`: 51,222,568) with `secrets.BASE_RPC_URL` as `FORK_URL`, then `scripts/check-cbzec-b20.sh` at the same block; the log is uploaded | the 11 fork tests and the B20 read. **Without the secret the job FAILS and its own summary line reads `fork: 11 skipped = NOT VERIFIED`** — the green check over eleven skipped tests is what this slice removed. With the secret, a skip (an engine entry the suite selects by property has vanished) also fails, by name. An RPC that no longer serves state at the pinned block fails with the RPC's error: move `FORK_BLOCK` forward deliberately, re-run, record the block |
| `static-analysis` | Slither (`--fail-high`), Aderyn, halmos — the halmos steps under `FOUNDRY_PROFILE=halmos` (`test = "test/halmos"`, so forge compiles src + the two harnesses, and `dynamic_test_linking = false`, because halmos has no `deployCode` cheat) | fails on a High or a violated account property (`AccountGrantHalmos` 4 / 4 locally, 2026-09-12); the router property is `continue-on-error` |
| `solana-seam` | `npm test -w @zyo/solana` | 14 |
| `solana-program` | Rust 1.98.1 + Agave 4.2.2 + anchor-cli 1.2.0 (crates.io): `gen-ladder --check`, `gen-addresses --check`, `anchor build`, `cargo test --lib`, `sync-idl.mjs --check` | the generated constants equal shared, both programs compile, 7 host tests, the committed IDL equals the build (the localnet 26 are not run in CI: they clone mainnet through a rate-limited public RPC) |

**The fork job is VERIFIED on CI since 2026-09-13.** `secrets.BASE_RPC_URL` was set that afternoon and run
`34768905298` was the first fully green run in the repository's history: **12 passed / 0 failed / 0 skipped at
block 51,222,568**, every other job green with it. Until then the job failed by design and printed
"NOT VERIFIED" rather than skipping quietly, which is why the red was honest and worth keeping. What it now
actually proves against Base mainnet includes the CCTP burn leg: an `OilskinAccount` burning 1,000 native USDC
through Circle's live TokenMessengerV2, with the FiatToken supply falling by exactly that.

Every Foundry job restores `contracts/cache` + `contracts/out` from
`actions/cache`, keyed on every `.sol` and `foundry.toml` (per group for the
three `contracts` jobs, `-build-` for `contracts-build`), with a prefix fallback.

**Why the contracts suite is three jobs (2026-09-12, evening).** The repository is
private, so `ubuntu-latest` is the 2-core / 7 GB standard runner. On it the `fork`
job compiles the 108 files its test needs in ~96 s, but a via-IR compile of all
138 — the ten top-level test contracts, the 19 audit regressions and the
invariant handler on top — never finished: seven jobs in a row (`485b3ff`,
`7041771`, `7b5f72a` ×2, `b849b17`, `5932d2a` ×2, `b933864` ×2) ended at 11–14
min with "the runner has received a shutdown signal" (exit 143), after a
fallback-restored cache and cold alike, with no compiler error in any log — the
signature of the runner running out of memory. The two cold compiles that had
passed earlier in the day (13–15 min) were the margin. `forge test --match-path`
compiles only the matched tests and their dependencies, so each group's job
stays inside the runner, and `--threads 1` keeps the biggest test contracts to
one solc process at a time. The first halmos run (`b933864`) ended the same
way for the same reason — halmos compiles the tree through `forge build` — so
its steps run under `FOUNDRY_PROFILE=halmos`, whose `test` directory is the two
harnesses. Locally the suite is still one command (`forge test`, 384 / 0 / 11);
CI's three summary lines add up to it.

`nightly-invariants.yml` (03:17 UTC daily, and `workflow_dispatch`) — **green on the runner 2026-09-13,
4 min 02 s, 10 / 10 invariants at 1500 × 120** (run `34762589751`) — runs the
invariant suite at `FOUNDRY_INVARIANT_RUNS=1500 FOUNDRY_INVARIANT_DEPTH=120`
— 180,000 handler calls per invariant, 17.6 × the push-time depth — and puts
Foundry's per-selector call summary (`[invariant] show_metrics`, the calls /
reverts / discards table) in the run summary, with the whole log uploaded as
the artifact `invariant-call-summary-<run id>` (90 days). Its first local run
(2026-09-12, 109 s on the founder's Mac) found a real failure — see the
2026-09-12 section below.

**How the workflows were validated on 2026-09-12.** `act` is not installed on
the founder's Mac, so no job was executed *as a job*; both files were dry-parsed
(PyYAML 6.0.3 plus structural checks: every job has `runs-on` and steps, every
step exactly one of `uses` / `run`, every `needs` resolves, every action is
pinned, every `${{ }}` expression starts with a known context, cron entries
have five fields), and every command each job runs was run locally, with the
counts in the Summary table. The first execution is the push that carries
this file.

**What the first real runs showed (2026-09-12, runs on `c7d90f1` … `d2f7760`).**
Eight of the ten jobs went green on the first push: `contracts`,
`contracts-build`, `abi-seam`, `agent`, `shared`, `web`, `prototypes`,
`solana-seam`. `fork` failed exactly as designed — its summary line reads
`fork: 11 skipped = NOT VERIFIED (secrets.BASE_RPC_URL is not available to this
run)` — because **the repository has no Actions secret at all** (`gh api
…/actions/secrets` → `total_count: 0`); the founder must create
`BASE_RPC_URL` under Settings → Secrets and variables → Actions → Repository
secrets, and the next push proves the fork at block 51,222,568.

**What the evening's runs showed (2026-09-12, run on `ceb976b`).** Eleven of the twelve jobs green
on the runner: `contracts (unit)` 250 / 0 / 0, `contracts (audit-regressions)` 136 / 0 / 0,
`contracts (invariant)` 2 / 0 / 0 (each ≈ 20 s on a warm per-group cache; 2–7 min cold),
`contracts-build`, `abi-seam`, `agent`, `shared`, `web`, `prototypes`, `solana-seam`, and
`static-analysis` — Slither 298 results / no High, Aderyn 0 High, halmos `AccountGrantHalmos`
4 / 4 (151 paths, 3.8 s) and `RouterBalanceHalmos` 1 / 1 (406 paths, 114 s). The one red job is
`fork`: `11 skipped = NOT VERIFIED`, because the `BASE_RPC_URL` secret still does not exist.
`static-analysis` failed on Slither's `--fail-high`: 305 results over 54
contracts, three High detectors, every one a pattern this codebase chose and
tests — triaged in `AUDIT-2026-09-12.md` ("Static analysis") and suppressed at
its site with the proof named; Aderyn and halmos run for the first time on the
push that carries that triage. The nightly workflow was run once by hand
(`workflow_dispatch`, run 34716244208): **10 / 10 invariants at 1500 × 120 in
4 min 58 s on the GitHub runner**, the call summary in the run summary and
uploaded as `invariant-call-summary-34716244208`. None of the three static
tools has run on the founder's Mac.

**What 2026-09-13's runs showed once the founder unblocked both (slice L, 14:19-14:29 UTC).** The founder raised
the account's Actions spending limit and created the `BASE_RPC_URL` secret (created 14:22:24 UTC; the repository
now has exactly one secret). Both moved, and the state is:

- **Jobs start again.** The run queued on `300550c` at 04:49 UTC began at 14:19:18 and finished: **twelve of the
  thirteen jobs green** - `contracts (unit)`, `contracts (audit-regressions)`, `contracts (invariant)`,
  `contracts-build`, `abi-seam`, `agent`, `shared`, `web`, `prototypes`, `solana-seam`, `solana-program` and
  `static-analysis` (Slither, Aderyn and halmos all pass on the A5/B3 tree).
- **The nightly is proven on the runner.** Its 08:17:46 UTC cron run (`34747326353`) died in 5 s with zero steps
  and the billing annotation - the block, not a test. Dispatched by hand at 14:24 once billing was fixed
  (`34762589751`): **success in 4 min 02 s**, all **10 invariants pass at 1500 x 120** plus
  `test_handlerPathsAreLive` (164.54 s of forge time, `Suite result: ok. 2 passed; 0 failed; 0 skipped`), the
  per-selector call summary in the run summary and uploaded as `invariant-call-summary-34762589751` (90 days).
  That is the first REAL result for the nightly workflow since the cache change, and it needed no `--threads 1`.
- **The fork job is still NOT VERIFIED, now for a different reason - the secret's VALUE is not a URL.** The
  first attempt (job started 14:19:18) predated the secret by three minutes and read the old
  `12 skipped = NOT VERIFIED`; secrets are resolved when a job STARTS, so a run queued before a secret exists
  never sees it - re-run the job rather than waiting. The re-run (14:24:08) does read the secret (the log shows
  `FORK_URL: ***`, masked and non-empty) and fails differently:
  `[FAIL: vm.createSelectFork: invalid rpc url: ***] setUp()`, summary line
  `fork: 0 passed / 1 failed / 0 skipped of 1 at block 51222568 (chain tip at run time: unknown)`. Two things
  name the cause without anyone reading the secret: Foundry then reports
  `Internal transport error: No such file or directory ... /contracts/***` - it fell back to resolving the value
  as a path relative to `contracts/`, which is what it does when the string has no URL scheme - and
  `cast block-number --rpc-url "$FORK_URL"` failed too, so the summary says `tip: unknown`. **The value needs to
  be a complete URL beginning with `https://`** (a bare host, an API key alone, or a stray newline all produce
  this); the founder updates the secret and re-runs the job - `ci.yml` now carries `workflow_dispatch` so a run
  can be taken again without a commit. Nothing else in the job changed, and no RPC URL was looked for elsewhere.

**The fork job is VERIFIED on the runner (2026-09-13, 16:32 UTC) — the last of slice I's twelve jobs to prove
itself.** With an archive endpoint in `BASE_RPC_URL`, run `34768905298` (`workflow_dispatch`, head `16cf235`,
job `103754763916`, started 16:32:50 UTC) printed exactly what the job was written to print:

```
fork: 12 passed / 0 failed / 0 skipped of 12 at block 51222568 (chain tip at run time: 51264012)
check-cbzec-b20: OK at block 51222568 (pinned), chain 8453
  code(cbZEC)   = 0xef  (B20 native contract; no fork EVM can execute it)
  decimals()    = 8
  symbol()      = cbZEC
  multiplier()  = 1000000000000000000  (1.000000000000000000 × — a rebase factor, printed not pinned)
```

The suite ran in 78.84 s (`Suite result: ok. 12 passed; 0 failed; 0 skipped`), every other job in that run green
(`static-analysis` included). `VERIFIED-BASE-FACTS.md` Addendum 10 carries the same line as the chain record.
**Every job in `ci.yml` has now proved itself on the runner**, which was not true from slice I (2026-09-12) until
this moment: the fork job stayed NOT VERIFIED for a day and a half through three distinct causes, in order — no
secret at all, a secret whose value was not a URL, and a secret pointing at a pruned node. Each failed
differently and each was read from the job's own output; none needed the secret to be looked at.

**The fork job needs an ARCHIVE endpoint, and which ones are (2026-09-13, 14:35-14:50 UTC).** The founder
updated the secret at 14:34:46 and the URL is now well-formed: the run on `7a4f5a4` (started 14:39:41) reads the
chain tip — the summary line ends `(chain tip at run time: 51260573)` instead of `unknown` — and fails deeper in,
inside `setUp()`:
`[FAIL: EVM error; database error: failed to get account for 0x4200…0011: error code -32603: state at block
#51222569 is pruned]`, with one backend also answering `HTTP error 410 … {"error":"This endpoint has been
discontinued."}` from a Lava gateway. That is a pruned full node: it serves the tip, not the state at
`FORK_BLOCK` (51,222,568 — about 38,000 blocks, 21 hours, behind the tip at that moment). A fork suite pinned to
any block needs an endpoint that keeps historical state, so moving `FORK_BLOCK` forward is not a fix — a pruned
node keeps roughly the last 128 blocks, minutes, not the life of a pin.

Probed read-only from the founder's Mac at exactly `FORK_BLOCK`, `cast balance --block 51222568` on the
`0x4200…0011` predeploy the suite trips over:

| Endpoint | State at block 51,222,568 |
|---|---|
| `https://mainnet.base.org` | **served** (`493004895633482039547`) |
| `https://base.drpc.org` | **served** (the same word) |
| `https://1rpc.io/base` | `error code -32603: state at block #51222569 is pruned` — the CI failure, character for character |
| `https://base-rpc.publicnode.com` | `HTTP 403 … Archive requests require a personal token` |

And the whole job was walked locally against the free public endpoint, cold, to prove it sustains what CI does
(no warm `~/.foundry/cache`): `FORK_URL=https://mainnet.base.org FORK_BLOCK=51222568 forge test --match-path
test/fork/BaseFork.t.sol --no-storage-caching` → **12 passed / 0 failed / 0 skipped in 85.6 s**, no rate-limit
error; then `scripts/check-cbzec-b20.sh https://mainnet.base.org 51222568` → OK (code `0xef`, decimals 8, symbol
cbZEC, `multiplier()` 1e18). So the suite and the block are sound and the only open item is the secret's value:
set it to an archive endpoint — `https://mainnet.base.org` needs no key and is verified above — and re-run the
job (`workflow_dispatch`, no commit needed). Addendum 10 of `VERIFIED-BASE-FACTS.md` stays as it is until the
RUNNER produces that line.

**What 2026-09-13's runs showed before that (slice L, checked 04:47 UTC).** The `BASE_RPC_URL` repository secret still
does not exist (`gh api …/actions/secrets` → `total_count: 0` at 02:42 and again at 04:47 UTC), so the `fork` job
read `11 skipped = NOT VERIFIED` on every push and the founder's fork verification is still the open item (create
the secret under Settings → Secrets and variables → Actions; the workflow then proves the fork at block
51,222,568 — 12 tests since A5.1 — on the next push). `nightly-invariants.yml`'s first scheduled run (03:17 UTC
daily) had not started by 04:47 UTC: GitHub's scheduler had not fired it, and from 04:34 UTC no job in the
repository could start at all — every job of the runs on `ecfb86f` and `fa578e2` completed as `failure` with
zero steps and the annotation *"The job was not started because recent account payments have failed or your
spending limit needs to be increased"* (the private repository's Actions minutes; the day's twenty-odd runs, the
16-minute Solana-toolchain job among them, spent them). Until the founder raises the spending limit or the
month rolls over, no push is checked by CI and the nightly cannot run; the last CI results that ran to the end
are: `ea1370e` (the refresh tool) eleven green + `fork`; `7a91157` (slice O) every job green including the new
`solana-program` job + `fork`; `2913589` (the refreshed snapshot) green except `fork` and `web` — the `web` red was
`web/test/solana-idl.test.ts` on the peers' `1bdbe63` (the program's IDL re-synced, the web's generated copy
not), fixed by their `ecfb86f`, which is the first run that could not start. Locally every suite is green at
`fa578e2` (the Summary above). The nightly's first real cron result is still to be recorded.

---

# History below this line — dated slice records, kept, not extended

**`docs/CHANGELOG.md` is the canonical record of what changed and when. Nothing new goes below this
line** (`docs/ROADMAP.md` rule 7). These sections are kept because several carry detail that never
reached the changelog — the Sepolia rehearsal package of slice J most of all — and because the audit
ledgers cite them. They describe the tree as it was on their date: **read the Summary above for what
is true today.**

## 2026-09-12 — Step 7: the Solana module, design before code

What was added and what proves it: `docs/VERIFIED-SOLANA-FACTS.md` (read live from
`api.mainnet-beta.solana.com`, slots 446,294,693 → 446,298,641; raw output in
`docs/research/solana-facts-2026-09-12.json`; reproducible with
`npm run facts -w @zyo/solana` and `npm run authorities -w @zyo/solana`);
`packages/shared/src/solana.ts` (+6 tests, shared 69 → **75**);
`docs/SOLANA-ARCHITECTURE.md`; the `solana/` workspace with an **empty** Anchor
program, the generated ladder module and its seam (**4** tests), the localnet
harness (`scripts/localnet.sh`, `scripts/patch-scope-fixture.mjs`,
`tests/localnet.spec.ts`). **Not run, by necessity:** `anchor build` and the
localnet smoke test — no Rust, Solana CLI or Anchor toolchain exists on the
founder's Mac; `solana/SETUP.md` gives the install and the first two commands,
and the versions pinned there (Anchor 1.2.0, Agave 4.2.2, `@anchor-lang/core`
1.2.0) are crates.io/npm/GitHub stable on 2026-09-12, to be confirmed at that
first build. Suites re-run green on this tree after the change, measured
2026-09-12: shared **75**, keeper seam **109/109** + **242** tests / 47 suites,
yield **131**, web unit **163** (161 passed + 2 skipped), Solana seam **4**. The
keeper seam reads one above the 2026-09-11 row in the Summary table (108) — a
re-measurement of the tree as it was, not an effect of this change (nothing
under `agent/` was touched); the web total matches its row.

## 2026-09-12 — Slice I: CI that proves what it claims

What changed: `.github/workflows/ci.yml` (ten jobs, table above) and
`.github/workflows/nightly-invariants.yml`; `scripts/check-cbzec-b20.sh`;
`contracts/test/fork/BaseFork.t.sol` (the B20 test retired, the direct-venue
close's band read before its prank); `prototype/test/verify-toggle.mjs`
(bigint-safe deep-equal) and both prototypes' `MORPHO_BLUE` block; this file,
`SETUP.md`, `README.md`, `DEPLOY-SEPOLIA.md`, `RISKS.md` §4,
`VERIFIED-BASE-FACTS.md` (Addendum 10, the reads at block 51,222,568).

Measured on this tree, 2026-09-12, founder's Mac (Foundry 1.8.1, Node 22.23.2,
Playwright 1.56.1): contracts **380 / 0 / 11** of 391; fork **11 / 0 / 0** at
block 51,222,568 and `check-cbzec-b20.sh` OK at the same block; root ABI seam
**424**; shared **75**; Solana seam **4**; keeper **110/110** strict + **242** /
47; yield **131**; web typecheck clean, web unit **167** (165 + 2 skipped);
prototypes **118 · 109 · 56 · 6**. Every number above was produced by the
command CI now runs, not copied.

**What the nightly configuration found.** `FOUNDRY_INVARIANT_RUNS=1500
FOUNDRY_INVARIANT_DEPTH=120 forge test --match-path test/invariant/Invariants.t.sol`
(109 s): 9 of 10 invariants pass at 180,000 calls each, 0 reverts;
`invariant_singleCloseClearsEveryBook` **fails** — "a two-book single Close
reverted although the account was funded to cover every book". Shrunk from 68
calls to 7: `switchVenue(true)` → `supplyAndBorrowOnCurrentVenue(1.47e8, …)`
(a Morpho book) → `openLp(200000)` → `accrueYield(…, w = 6880, …)` (6,880 wei
of WETH fee on the position) → `switchVenue(false)` →
`supplyAndBorrowOnCurrentVenue(9779, 4225)` (a second, tiny Aave book) →
`singleCloseProbe()`. Replayed deterministically with full traces: the LP close
pays the account 6,192 wei of WETH (the fee net of the venue's 10 %); the
router's `_toUsdc` then swaps that leg with the caller's quote (1 WETH →
2,453.45 USDC, 100 bps), and the adapter's floor `minOutFor(6192, …)` rounds to
**0**, so `AerodromeSwapAdapter.swap` refuses `ZeroQuote()` and the whole Close
reverts. The keeper's protection `unwind` is the same call with the same
quote shape, so on such an account it would revert too. Nothing in the
default 256 × 40 run reaches a WETH leg that small; the deep run does. The
finding, its severity, the fix and its regression test are
`AUDIT-2026-09-12.md` (the commit after this one); this section is the record
that the nightly job found it before it ever ran in CI.

**The fix, same day (NI-HIGH-1, `AUDIT-2026-09-12.md`).** `StrategyRouter._toUsdc`
asks the adapter for its floor (`minOutFor`) on the actual leg before swapping;
a real quote whose floor for that leg is zero USDC — a swap the adapter would
refuse by name — keeps the leg in the account, emits
`DustLegKept(account, token, amount)` and carries on; an empty quote is still
`ZeroQuote`. "Dust" is the enforcing code's own verdict at the caller's quote
and tolerance, not a typed threshold. Regression
`contracts/test/audit-regressions/DustLegClose.t.sol` (4, failed first on
`c7d90f1` with `ZeroQuote()`); the nightly configuration re-run on the fixed
tree: **10 of 10 invariants, 180,000 calls each, 0 reverts, 113.6 s**. ABI
424 → 425 (one event); web ABI regenerated; keeper seam 110/110 unchanged. The
keeper does not read the new event and the web's Close plan does not yet say a
dust leg may be kept — both open, recorded in the audit file.

## 2026-09-12 — Slice J: the Sepolia rehearsal package (nothing signed)

What was added: `docs/DEPLOYMENTS.md` (the template every deployed address must be written into,
and the one file the keeper env, the web env, the Sepolia Playwright suite and the check script
read); `deploy/sepolia/keeper.observe-only.env.example` and `deploy/sepolia/web.env.example`
(the four addresses, `CBZEC_ADDRESS` / `AERO_ADDRESS` and their `NEXT_PUBLIC_` twins explained —
the doubles `DeploySepolia.s.sol` prints, required on 84532 by name, refused on 8453);
`scripts/sepolia-postdeploy-check.sh` (`DEPLOY-SEPOLIA.md` §5.1–§5.4 as one read-only run;
exit 2 with the reason while the table is empty, exercised on 2026-09-12 against the template and
against a scratch copy with an address in every slot — every one of its 23 checks ran);
`scripts/sepolia-feed-policy.mjs` (the per-feed bounds the keeper will derive, computed by the
keeper's own `buildFeedPolicies` against the live Sepolia aggregators — 2,460 s for BTC/USD and
ETH/USD, 172,848 s for USDC/USD at block 46,734,590; `VERIFIED-BASE-FACTS.md` Addendum 11 has the
ten-round gaps behind them); `web/playwright.sepolia.config.ts`, `web/e2e/sepolia.spec.ts`,
`web/e2e/sepolia-deployment.ts` and `web/test/sepolia-deployment.test.ts`; `docs/SEPOLIA-REHEARSAL.md`
(one page: proves / cannot prove / the checklist); `DEPLOY-SEPOLIA.md` §6 rewritten so the
founder's part is the signed steps only.

Measured 2026-09-12: web typecheck clean; web unit **171** (170 + 1 skipped); Sepolia e2e
**3 skipped by name**; keeper **110/110** strict + **242** / 47 (unchanged — the keeper's code
did not change; the script imports its compiled `feeds.js`, `chain.js` and `config.js`).
Chain reads: Base Sepolia blocks 46,734,440 → 46,734,590, 18:19–18:24 UTC, public RPC, read-only.

## 2026-09-12 — Slice K: the yield gate on fresh chain reads

**The chain read.** `npm run backfill -w @zyo/yield -- sample` against
`https://base-rpc.publicnode.com` (the batched read is refused by
`mainnet.base.org` with `over rate limit`), token prices from GeckoTerminal,
`GECKO_MIN_INTERVAL_MS=15000` between the nine pool requests: **block
51,226,072 at 2026-09-12 19:31:30 UTC**, `services/yield/samples/gauge-emissions-2026-09-12.json`
(`VERIFIED-BASE-FACTS.md` Addendum 12 records every word). Five earlier
attempts were refused — first by the public RPC's burst limit, then by
GeckoTerminal's, which the sample's own retries kept re-tripping; the sample
now paces its requests (`GECKO_MIN_INTERVAL_MS`), fetches only the nine
Aerodrome pools it uses (twelve before), and writes to `services/yield/samples/`
under `tsx` as well as from `dist/` (the default path was one directory too
high under `tsx`, so the first successful read was lost on write).

**The model.** `npm run model` now runs `scripts/run-model.mjs`, which lifts
the as-of instant, the borrow rate, the supply rates and the liquidation
thresholds from the sample file (before, `package.json` carried
`--borrow 4.828 --supply cbBTC=0.012,WETH=1.843 --lt …` by hand); the
simulator keeps a lapsed gauge's would-be reading for the prototypes' re-vote
lever. `docs/MODEL-NUMBERS-2026-09-12.md` (= `samples/MODEL-NUMBERS.md`,
generated 2026-09-12T19:44:42Z, as of 19:31:31Z, borrow 4.5174 %):
**nothing clears; the best cell is cbBTC/USDC sheltered at −10.92 %/yr and
needs 4.56× today's net emissions;** seven cells priced, six of the seven
boundary cells refused `within_model_uncertainty`, worst optimism 31.96 pt;
one named validation breach (WETH/cbBTC working, +5.46 pt against a ±4.43
cap). The verdict paragraph is `RISKS.md` §14. The dry run of the recorded
2026-09-05 inputs reproduced the committed model to the last published digit
(only the ~1e-14 affine-error column differs) in 16 s.

**The pins.** Web: `demo-gate.json` regenerated and mirrored, every literal
moved (rows above). Prototypes: re-pinned by `prototype/scripts/gen-oil-model.mjs`,
checks derived from the block, levers re-derived. For a few hours two dated
reads sat side by side by rule — the market snapshot (the 2026-09-05 ledger
read) and the gate (the 2026-09-12 model), allowed to differ only when the gate
was the fresher read; the ledger re-read the same evening (next section) made
them one read at one block. The rule stays in `snapshot.test.ts` for the next
time one of them moves alone.

Measured 2026-09-12: yield **131**; web typecheck clean, web unit **171**
(170 + 1 skipped), web e2e **14 / 0 / 6**; prototypes **118 · 109 · 56 · 6**.

## 2026-09-12 — Ledger re-read: the demo's market snapshot is the yield sample's block

**What.** The top ledger of `docs/VERIFIED-BASE-FACTS.md` was read again, read-only, at the block slice
K's gauge sample was taken at — **51,226,072**, 2026-09-12T19:31:31Z — with `cast call --block 51226072`
against `mainnet.base.org` (paced; the publicnode endpoint refuses pinned-block calls without a token).
The 2026-09-05 figures stay as a drift column; Addendum 14 carries every raw word. `web/lib/demo.ts`
(`DEMO_SNAPSHOT_AT`, `DEMO_SNAPSHOT_BLOCK`, `DEMO_CBZEC_PRICE_USDC`, `DEMO_MARKET` at the yield
service's 4-dp digits: USDC 4.5174 / 3.5169, cbBTC 0.6716 / 0.0115 at 77,140.83, WETH 2.3861 / 1.7422
at 2,520.38), the demo banner, the spot page's cbZEC literal (1,020 → the pool's 1,125.01) and both
prototypes' `OIL_CHAIN_READ` (byte-equal) moved with it, so the demo, the prototypes and the model
quote one set of numbers.

**The tests.** Every test that had typed the old digits now derives them: `reads.test.ts` builds its
fake account (0.5 cbBTC at 40 % on Aave, 1 cbBTC at HF 1.72 on the Morpho-style venue) from the
snapshot price, the W3-MED-1 "Aave price wins" check and the wizard's carry read `DEMO_MARKET`,
`model-numbers` asserts the gate's borrow equals the snapshot's and names the block,
`verify-toggle`'s five facts checks format each figure from `OIL_CHAIN_READ` and look it up in the
ledger, `verify-simple` / `verify-advanced` compute the hold projections and the cbZEC spot output
from the page's chain read. The simple page's disagreement-band lever moved from ×12.33 to **×12.2**:
at the 4.5174 % borrow the band where the closed form clears and the Monte-Carlo net does not is
×12.20–×12.25 for WETH/USDC (measured by scanning the page's own `gate`); the advanced page's ×8.67
for WETH/cbBTC at 150 bps is still inside its (much wider) band.

**Measured** in a clean git worktree on HEAD (another session was mid-edit in the same web files;
nothing of theirs is in this commit): web typecheck clean, web unit **171** (170 + 1 skipped), web e2e
**14 / 0 / 6** against a private `next dev` on port 3222, prototypes **118 · 109 · 56 · 6**. Yield not
re-run: this commit does not touch it, and its working tree carried the other session's changes.

## 2026-09-12 — Solana slice S4: the keeper agent on Solana

What was added and what proves it: `agent/src/solana/` (layouts, reader, valuation, policy, dispatcher,
monitor, config, keeper, index — `SOLANA-ARCHITECTURE.md` §5 has the table), the store generalised over an
id codec (`store/keeperStore.ts`; the Base store's behaviour and its 242 tests unchanged),
`agent/scripts/verify-solana-idl.mjs` (**77/77** against the committed `solana/idl/oilskin.json`, synced by
`solana/scripts/sync-idl.mjs`), three new agent test files (+**21**, agent **263** / 51 suites), and
`solana/tests/keeper.spec.ts` (+**5**, localnet **26**). Measured on this tree: keeper `verify-abi` 110/110 +
`verify-solana-idl` 77/77 + 263; Solana seam 7; localnet 26 passing in 24 s (three runs; see below). Two rules
the run enforced on the spec itself: the keeper reads at `confirmed`, so every set-up write is awaited to
`confirmed`; and a warped validator's chain clock runs hours ahead of the host's, so the grant's expiry is
taken from `getBlockTime`, never `Date.now()`. **Observed, explained and fixed in the harness:** in two of the first four runs every
`owner-path.spec.ts` confirmation timed out at 30 s (`TransactionExpiredTimeoutError`, Anchor's `.rpc()`
confirms over the websocket) although the transactions had landed (the later refusal tests that depend on them
passed), and the mocha process then never exited — it held one open websocket. Cause, from
`@solana/web3.js` 1.99.0 `_updateSubscriptions`: the library flags the socket disconnected the instant its
subscription count hits zero and closes it 500 ms later; a `signatureSubscribe` that arrives while that close is
in flight reconnects into a closing socket, and every later confirmation on that connection waits its full
timeout. Fix: `tests/support/wsKeepalive.ts` holds one standing slot subscription per transacting spec
(`before` / `after`), so the count never reaches zero, and the runner passes `--exit` so a stuck socket can
never hold the process. Three consecutive runs after the fix: 26/26 in 24–25 s, each exiting on its own.
The runner's glob is quoted (`'tests/*.spec.ts'`) because an unquoted `tests/**/*.ts` is expanded by the
shell once a subdirectory exists and then matches only the helper.

## 2026-09-12 — A4.1: the ladder is the position's own (keeper, contracts, shared)

What was added and what proves it: shared `ladderFor(entryHf)` and its identities (+**7** `health.test.ts`,
shared **82**), `StrategyRouter.entryHfWad` / `EntryHfRecorded` (+**4** `audit-regressions/EntryHfRecorded.t.sol`,
forge **388** / 0 / 11 skipped, 33 suites), and the Base keeper's per-account ladder — `services/entryHf.ts`,
`HealthMonitor.resolveLadder`, `DispatchRecord.disarmHf`, `AccountRecord.entryHf` (+**5**: `healthMonitor.test.ts`
3, `keeperStore.test.ts` 1, `dispatcher.test.ts` 1; keeper `verify-abi` **113/113**, `verify-solana-idl` 77/77,
**269** tests / 52 suites). Measured on this tree: shared 82; forge 388 / 0 / 11; keeper 113 + 77 + 269; Solana seam
7 (the generated `ladder.rs` unchanged — `ladderFor(1.55)` is the old table); yield 146 and web unit 177 (176 + 1
skipped) re-run against the rebuilt shared package, unchanged. Two things the tests taught the code: the monitor's
mock HF is a float (1.2600000000048703), so the record's `hf` is asserted to 1e-6, not equality; and episode
numbers are store-wide, so an account whose first rung fires after another account's is in episode 2 — the test
asserts against the episode its own warn record carries. Not touched: the web's `HealthBand`, `KeeperPanel`,
`math.ts` and `keeper.ts` still read `HF_LADDER` (A4.2 moves them to the account's recorded entry HF), and the
Solana keeper's `SOLANA_LADDER` is still the global table (B stream, program state needed).

## 2026-09-12 — A4.2: the risk slider on the site

What was added and what proves it: shared `offeredLtvBounds` / `entryHfAtLtvBps` / `rungDropPctAtHf` /
`ladderForRecorded`; `web/lib/wizard.ts` rebuilt around `entryHf` (`hfBoundsFor`, `clampEntryHf`,
`entryHfForBorrow`, `needsHfAcknowledgment`, `hfAcknowledgmentText`); `planLoan` over an entry HF; the
account read's `entryHf` / `entryHfStatus` and the deployment's `entryHfFloor`; `SettingStep` as the slider;
the ladder threaded through `HealthBand`, `KeeperPanel`, `NotifyBanner`, the review and the dashboard. Measured
on this tree: web unit **180** (179 + 1 skipped), Playwright **14 / 0 / 6** against a private `next dev` on
port 3112 (the 3111 hazard above). Two things the browser run taught the code: the default HF must be clamped
to the asset's offered minimum at READ time, not written into state, or a wizard opened on WETH (1.66) keeps
1.66 after a switch to cbBTC (1.56); and a text field that an effect re-syncs from state loses a value typed
between the previous commit and that effect (seen once on the desktop viewport, not the phone) — the two typed
fields now hold a draft while focused and follow the state otherwise, with no effect. Not touched: the yield
service still serves `ENTRY_HF_FLOOR` (A4.4) and both prototypes still carry the three fixed settings (A4.3).

## 2026-09-12 — A4.3: the risk slider in both prototypes

What was added and what proves it: the pinned block's `ladderFor` / `ladOf` / `offeredBounds` / `entryHfAtLtv` /
`ltvForHf` / `hfForBorrow` / `clampHf` (byte-equal in `simple.html` and `index.html`, diffed against the built
`packages/shared` by `verify-toggle` — +5 checks, **62**), the slider with marks, typed fields and the sub-mark
acknowledgment on both pages, positions and accounts carrying the entry HF their open recorded, and the keeper sim,
band, ladder card and docs running the derived ladder. Measured on this tree: **simple 130 · advanced 116 · toggle 62
· fuzz 6** (all green, `run-all` exit 0). Three things the run taught the code: (1) the simple page's keyboard wiring
still named the removed `#riskSeg`, which threw at load and made every simple check time out on `window.__oil` — a
syntax check passes such a fault; a Playwright probe printing `pageerror` finds it in seconds; (2) with the ladder
derived from the recorded entry, the advanced suite's withdrawal tests (which pull the account to the exit floor)
leave the derived warn rung fired and the next `beginFlow` refused — the suite now re-arms with a price recovery and
derives its drop factors from the account's own rungs, chaining each factor from the HF the previous rung's action
left; (3) the fuzz invariant that pinned `sel.ltv` to 30 / 40 / 50 became the HF ↔ LTV identity, rounded, because
`7.8 × 100` is not 780 in floating point. Also fixed on the way: the docs tables' `table-layout: fixed`, without
which five text columns forced the 390 px docs view to 408 px.

## 2026-09-12 (night) — The floor pinned at 1.25, the product cap removed

The founder's numbers ("remove the cap to the Aave limit; floor can be 1.25"), applied at the source and
re-derived everywhere: `packages/shared` (`ENTRY_HF_FLOOR`, no `MAX_OFFERED_LTV_CAP_BPS`, `HF_LADDER` =
ladderFor(1.25)), `CollateralRegistry` (no cap getter — ABI bundle regenerated), the Solana program (`ladder.rs`
regenerated, rebuilt), the yield model re-run on the same sample, both demo recordings, both prototypes, every
suite. Measured on this tree: shared **85**; keeper **269** / 52 suites; yield **149**; web unit **180** (179 + 1
skipped) and Playwright **14 / 0 / 6**; prototypes **130 · 116 · 62 · 6**; Solana seam **7**, program unit tests
**8**, localnet **26 / 26** (two runs); contracts — see the row. Three things the reconciliation taught the code:
(1) `66.4 × 100` is not 6640 in floating point — the prototypes' percent → bps identity rounds now, without which
the slider's stop read 1.2499 on WETH; (2) the advanced prototype's post-flow wizard reset built the default for
cbBTC and re-labelled it with the flow's asset, so the LTV no longer matched the HF — caught by the fuzz
invariant on the identity, fixed at the source; (3) a stale registry read must never LOWER the served floor —
`/v1/forecast` serves the stricter of the last read and the constant as `registry_stale`. Also: the model report
prints exact LTVs (`62.4% (top)`) because whole-percent truncation could no longer name the served bps.

## 2026-09-13 — Slice M, the tool: the demo snapshot refresh as one command

**What.** `scripts/refresh-demo-snapshot.mjs --rpc <url> --block <n|latest> [--sample-rpc <url>] [--force]
[--skip-levers]` replaces the evening of hand work behind the 2026-09-12 ledger re-read (the section above).
Read-only, no key. Given a block — `latest` is resolved once and pinned — it runs, in order: the yield sample
pinned to the block (`npm run backfill -w @zyo/yield -- sample --block N`: every `eth_call` tagged, the sample
stamped with the block's own timestamp; the GeckoTerminal prices have no block and are recorded at the wall
clock as `pricesSampledAt`); the model on that sample (`model-inputs` + `scripts/run-model.mjs`, and
`package.json`'s `model` script re-pointed at it); `scripts/ledger-read.sh <rpc> N`, parsed into
`docs/research/ledger-read-<N>.json`; the USDC reserve read (`samples/aave-usdc-reserve-<date>.json`, curve +
totals) from the SAME sample and ledger words; `gen-demo-gate.mjs` / `gen-demo-forecast.mjs` on those files
(defaults re-pointed); the facts file's top ledger, regenerated from the record with the read it replaces as
the drift column — exactly the table shapes `web/test/snapshot.test.ts` and `prototype/test/verify-toggle.mjs`
parse; `web/lib/demo.ts` (`DEMO_SNAPSHOT_AT` / `DEMO_SNAPSHOT_BLOCK`, `DEMO_CBZEC_PRICE_USDC` = 100 ×
1.0001^(−tick), `DEMO_MARKET` at the service's 4-dp truncation, the USDC liquidity) and the demo banner in
`copy.ts`; both prototypes' `OIL_CHAIN_READ` (byte-equal, checked) and their `OIL_MODEL` through
`gen-oil-model.mjs`; the tester's-kit "disagreement band" levers, MEASURED by scanning each page's own `gate()`
in Chromium over ×1.00 … ×60.00 (a lever that fell out of its band moves on the page and in its test together;
a `--skip-levers` run leaves them); `docs/MODEL-NUMBERS-<date>.md` and the superseded banner on the previous
one; the dated sample names in the yield tests; a printed drift table. Every step whose output for that block
already exists is skipped, so **a second run at the same block is a no-op**; `--force` redoes them. The sample
and the ledger are checked against each other (rates, `totalAToken`, the cbZEC gauge's `rewardRate`) and a
mismatch is fatal — they must be one read. The tool never rewrites the prose that judges the numbers
(`RISKS.md` §14, the CHANGELOG, this file) or a test that typed a model figure: a person does that after the
run, and never softens the verdict.

**RPCs (probed 2026-09-13, read-only).** `mainnet.base.org` serves pinned-block reads at any depth but refuses a
batched burst, so the tool paces it (`RPC_BATCH_SIZE=1 RPC_PACE_MS=400`) when it is the sample RPC;
`base.drpc.org` and `1rpc.io/base` serve pinned batched calls thousands of blocks back; `base-rpc.publicnode.com`
serves them only within ~100 blocks of the tip (HTTP 403 "Archive requests require a personal token" beyond).
GeckoTerminal's free tier is ~30 requests/min and blocks ~15 min once tripped: the tool sets
`GECKO_MIN_INTERVAL_MS=2500` unless the environment says otherwise.

**Bootstrap, measured.** Run once at the block the 2026-09-12 ledger was read at (`--block 51226072`, the
sample and the model kept, the ledger re-read by `cast` in 42 lines): the top ledger regenerated with every
figure equal to the hand-written one and the 2026-09-05 read parsed from the doc as the drift column (from
then on the drift comes from the previous block's JSON record); two hand-typed errors surfaced — Pyth's
`publishTime` 1,788,550,194 is 2026-09-04T19:29:54Z, not the 00:49:54Z the doc said, and the committed
demo payloads named a model stamp (02:38:48) three regenerations behind the committed `lp-model` (02:43:16) —
both now the record's; the levers measured ×12.16–×12.25 (simple, WETH/USDC) and ×7.06–×10.23 (advanced,
WETH/cbBTC at 150 bps) at the 4.5174 % borrow, so ×12.2 and ×8.67 stay, and cbBTC/USDC first opens at
×4.56 (the kit's ×5). Suites on that state, in a clean worktree on `ac513d5` + this commit: yield **172**,
web typecheck clean, web unit **180** (179 + 1 skipped), web e2e **14 / 0 / 6** against a private `next dev`
on :3222, prototypes **130 · 116 · 62 · 6** — the advanced suite read two reds when run concurrently with the
yield and web suites on the same Mac ("corrupted store → fresh state" and the 390 px overflow probe, both
timing) and 116 / 0 alone, so the prototype suites are run by themselves. The refreshed snapshot at a
2026-09-13 block is the next commit.

**The refresh, measured (2026-09-13).** `node scripts/refresh-demo-snapshot.mjs --rpc https://mainnet.base.org
--block latest --sample-rpc https://base-rpc.publicnode.com` at 04:06 UTC: block **51,241,497** (2026-09-13T04:05:41Z, the
tip less the 20-block margin), the sample pinned through publicnode (batched, inside its ~100-block window), the
ledger through `mainnet.base.org` (paced), the model (`--redo-model` after the sim fix below), the two recordings,
the facts file's top ledger with the 2026-09-12 read as the drift column, `web/lib/demo.ts`, both prototypes, the
levers, `docs/MODEL-NUMBERS-2026-09-13.md`. Three false starts, recorded so the next run does not repeat them:
`base.drpc.org` and `1rpc.io/base` answer `eth_getBlockByNumber` for a block a minute old with `null` (hence the
20-block margin and publicnode for the sample); `mainnet.base.org` answers HTTP 429 for a minute after the paced
ledger read; GeckoTerminal refused two runs at a 2.5 s pace and blocks ~15–18 min from the LAST attempt — the pace
is 6 s now and the run waits the block out in silence. **The drift:** USDC borrow 4.5174 → **4.5143 %**, cbBTC
77,140.83 → 77,173.30, ETH 2,520.38 → 2,520.58; every gauge's `rewardRate` unchanged but the STAKED liquidity fell
62 % (cbBTC/USDC) and 74 % (WETH/USDC) and tripled on WETH/cbBTC, so the marginal emissions a new staker sees
went 6.15 → 16.31 % on cbBTC/USDC sheltered and 3.93 → 15.10 % on WETH/USDC sheltered; the cbZEC/USDC pool's
stake collapsed to 4.8 × 10¹⁰ (active L 1.6 × 10¹¹, tick −24,298 ≈ 1,135.52 USDC) and reads 326 / 1,031 / 5,241 %;
USDC available 24.78 M; AERO $0.5662. The best cell is −3.75 % (break-even 1.72×), every priced cell still
negative, 0 of 81 clear (`RISKS.md` §14 carries the verdict). **What the pin test found:** the sim had no
plausibility ceiling while `gate.ts` refuses above 1,000 % before the borrow and σ checks — the first reading
above it (cbZEC/USDC at two widths) made `lp-sim.py` say `no_volatility_input` where the gate says
`emissions_implausible`, and `model-pin.test.ts` refused the recording; the sim now refuses in the gate's order
from the gate's constant (`model-inputs.json` carries `bounds`, pinned). The closed form's tolerance breach moved
from WETH/cbBTC working (5.46 pt, now 2.42) to cbBTC/USDC working (6.03 pt against 4.42), recorded by name.
**Levers:** ×12.2 → ×3.17, ×8.67 → ×23.1, ×5 → ×2 (above). **Suites on the refreshed tree:** yield **172**,
web typecheck clean, web unit **198** (197 + 1 skipped), web e2e **18 / 0 / 6** on a private `next dev` :3222,
prototypes **130 · 116 · 62 · 6** (alone). **Idempotent, proven:** a further run at the same block left the
working tree byte-identical (`git status` and the diff's checksum compared before and after).

## 2026-09-13 — Slice N: the stale references and the vocabulary sweep (BUILD-PLAN §6), every suite re-measured

**Stripped, replaced in the same commit (CLAUDE.md #6).** The `/tmp/fix2` references: `web/test/model-numbers.test.ts`'s
skipped test pinned to the 2026-09-06 hand-off `/tmp/fix2/MODEL-NUMBERS-v2.md` deleted (the artefact is gone; the
in-repo report is the record) and both prototypes' `OIL_CONTRACTS` comment pointing at
`/tmp/fix2/CONTRACT-ABI-DELTA.md` now points at `docs/CONTRACT-ABI.md`; `docs/AUDIT-2026-09-06.md` and the
CHANGELOG's 2026-09-06 entry keep their source list as the record of that round. The gate vocabulary: the
report's summary line "No pool × setting clears the gate. The menu is empty…" → "No pool × setting beats the borrow
on both models. Every cell is shown and can be opened after the acknowledgment (BUILD-PLAN D4/D5)…" and "Clears the
gate:" → "Beats the borrow on both models:" in `services/yield/scripts/lp-sim.py`, with the three parsers moved
(`web/test/snapshot.test.ts`, `prototype/test/verify-toggle.mjs`) and the report regenerated through
`scripts/refresh-demo-snapshot.mjs --redo-model` at block 51,241,497 (numbers unchanged, stamp moved); the report's
title "Base-first yield gate" → "the Base module's yield model"; `README.md`'s "only when the yield gate says that
pool clears the borrow rate" → the forecast and the acknowledgment; the service row names `/v1/forecast` first;
"the yield gate reads `rewardRate` live" (`RISKS.md` §16) and the comments in `packages/shared/src/{base,pools,types}.ts`
and `web/lib/math.ts` → the yield service / the forecast; "Base-first" in both prototypes' headers and the two
suites' headers → "the Base module" (D1: both chains, both in full). `SETUP.md`'s CI paragraph, which still said CI
did not run the shared, web or prototype suites, now describes the slice I workflow. Left as they are, on purpose:
`services/yield/src/gate.ts` and `/v1/gate` (the module IS the gate and the endpoint stays for its consumers),
the dated section titles in this file and the CHANGELOG (history), and `packages/shared/src/collateral.ts`'s
"nothing is offered" (the venue offers no LTV — a different sentence). Not found anywhere outside history:
"expert tier" as a mode, "a registry flip away", "Advanced-only" for the cross-chain loop.

**Re-measured, 2026-09-13, in a clean worktree at `ecfb86f` + this commit** (the Solana program unit and localnet
counts are B3.1's own, 12 and 34, measured by that session with the toolchain):

| Suite | Count |
|---|---|
| Contracts (`forge test`) | **404 passed / 0 failed / 12 skipped** (416; 36 suites; 12 fork tests skip without `FORK_URL`) |
| Root ABI seam | **440** |
| Shared | **93** |
| Solana seams | **14** |
| Keeper | **271** tests + `verify-abi` **113 / 113** + `verify-solana-idl` **77 / 77** |
| Yield | **172** |
| Web unit | **197** (197 passed, 0 skipped); typecheck clean |
| Web e2e | **18 / 0 / 6** (a private `next dev` on :3222) |
| Prototypes | **130 · 116 · 62 · 6** (run alone) |

## 2026-09-13 — Solana B5, part 1: the yield service reads Kamino and shows the rate after the borrow
## 2026-09-13 — Internal audit of the Solana module and the cross-chain code (B6 + everything built today)

`docs/AUDIT-2026-09-13.md`. Two defects found and fixed with regression tests, six observations recorded.

- **S-1 (medium), keeper:** the bridge stall window measured a burn's age from `updatedAt`, which every tick
  rewrote — so it read ~0 for ever and the fallback to the single-chain path could never trigger. Now measured
  from `createdAt`. Pinned in `solana-monitor.test.ts` by a record two hours old whose `updatedAt` is now.
- **S-2 (medium), router:** `closeLpAndBurn` bounded Circle's fee only by "below the amount", so a compromised
  keeper could authorise a fee of the burn less one unit inside its USDC budget. Capped at `MAX_CCTP_FEE_BPS`
  (1 %, against Circle's real 1.3 basis points) and refused as `MaxFeeTooLarge`. Pinned in
  `audit-regressions/CctpFeeCap.t.sol` (3): the greedy fee and one unit over refused with nothing burned, the
  cap itself and Circle's real fee accepted with the bound reaching the message, and the keeper's grant path.
- Counts after: contracts **407 / 0 / 12** (37 suites), ABI **442**, keeper **311 / 60**, web **199**.

## 2026-09-13 — Stream C: the cross-chain glue end to end in code — attestation, delivery, and the runbook

BUILD-PLAN D6 / Stream C (`docs/CROSSCHAIN-RUNBOOK-2026-09-13.md`). The rung is now a resumable stage machine:
burn → receipt → Circle's attestation → delivery on Solana → the repay the ladder already performs.

- **Shared 93 → 98**: the receive-side addresses, Circle's attestation paths, and `parseAttestationResponse`
  judged against a **recorded live answer** (`docs/research/cctp-attestation-a9cb6989.json`). The reason it
  decodes the raw bytes rather than Circle's `decodedMessage`: Circle null-fills those fields for a non-EVM
  destination, and Solana is one.
- **Keeper 299 → 310 / 60 suites**: `attestation.test.ts` (the documented URL, waiting told from failing, a
  mismatch logged, a request that is really cancelled), `delivery.test.ts` (every account DERIVED from Circle's
  seeds lands on the address read from mainnet; the order, flags and data layout; the refusals),
  `bridge-stages.test.ts` (every transition that needs no validator), `solana-pair.test.ts` +1 (the idle USDC
  decides first, which is what ends the sequence).
- **Localnet 34 → 36** on a validator with the receive side cloned. The delivery test is the load-bearing one:
  a message the keeper builds, with a fabricated attestation, is refused by Circle's own cloned program **at the
  signature check** — which is only reachable if every account resolved, the discriminator matched and the Borsh
  params parsed. It asserts the absence of `AccountNotInitialized`, `ConstraintSeeds`, `ConstraintExecutable`
  and `InstructionFallbackNotFound` as much as the presence of the signature error.
- **What the validator taught us, and the code now carries:** the delivery is **1,264 bytes as a legacy
  transaction against the 1,232 limit**, so it rides a v0 transaction with an address lookup table exactly as
  the burn does. Without one configured the keeper refuses the delivery by name rather than sending something
  that cannot land. That makes the table a deploy artefact (`SOLANA-DEPLOY.md` step 2b).

## 2026-09-13 — A5.2: the keeper's cross-chain pair — the burn as a keeper action, up to the attestation

BUILD-PLAN D6 / A5 (`SOLANA-ARCHITECTURE.md` §14.7). **Base** (`agent/src/dispatch`): `planBurn` — one
`closeLpAndBurn` per pool sized to the need grossed up for Circle's fee (`grossForFee`), the rung's fraction as a
cap, `burnAmount = max`, `maxFee` from the expected proceeds plus one; `KeeperDispatcher.dispatchBurn` — the
router's recorded recipient must be the Solana Account's USDC token account (else a permanent refusal), the
`closeLpAndBurn` grant read whole, the ids priced by simulating the burn itself, simulate / persist / send;
`confirmBurn` — CONFIRMED only when our `BurnedToSolana`, Circle's `DepositForBurn` and the transmitter's
`MessageSent` agree on amount and recipient, the message and its nonce kept on the record. **Solana**
(`agent/src/solana`): `pair.ts` — the pair rule and the bridge decision; the dispatcher routes a linked pair's
rung 3–4 through an injected `BaseBurner` and waits while a burn is in flight; the monitor records the pair on
the account and the bridge stage on the dispatch, keeping a Base hash off the Solana `txHash` (the store checks
it against the base58 codec). `BASE_RPC_URL` / `BASE_ROUTER_ADDRESS` / `BRIDGE_STALL_S` in the Solana config.

- **Keeper:** 271 → **286** tests / 56 suites; seam 113 → **123 / 123** (the "exactly one root call" guard is now
  "exactly the two the product issues grants for"); IDL seam 77 / 77. `test/mockOilskin.ts` plays
  `closeLpAndBurn` with the three events and `solanaRecipient`.
- **Not built (Stream C):** the two-key process that wires the burner, Circle's attestation poll, the Solana
  `receive_message` delivery, the repay after it, and the runbook for each step failing.

## 2026-09-13 — B3.1: the Solana side of the loop — the entry record, the per-position ladder on chain, the reserve, `deposit_for_burn`

BUILD-PLAN D6 / B3 and the D7 parity the Solana program lacked (`SOLANA-ARCHITECTURE.md` §14, built as written).
`UserAccount` gains `entry_hf_bps` (written by `borrow`) and `base_account` (the owner's `set_base_account`), carved
from the reserved bytes so the layout length and every existing account are unchanged; `health.rs` derives the
ladder from the record in the integer twin of shared's rule and `keeper_protect` judges THAT ladder; the reserve is
the rung-2 requirement; `deposit_for_burn` is one CPI into the cloned Circle program with the Account PDA as the
burn authority. The keeper's Solana path (`agent/src/solana`) derives each account's ladder from the record, the
twin of the Base path's `resolveLadder`, and writes the rung's disarm level on the dispatch record.

- **Program unit:** 8 → **12**. **Seams:** 12 → **14** (`npm test -w @zyo/solana`). **IDL** re-synced (13 instructions);
  keeper seam **77 / 77**, keeper **271 / 52**.
- **Localnet:** 26 → **34 passing / 0 failing** (44 s) on a private validator (`RPC_PORT=9100`, `FIXTURES=fixtures-e2`)
  with the two CCTP V2 programs and five state accounts cloned. `crosschain.spec.ts` (8): the world (both programs
  executable, the domain-6 remote messenger names Base's `0x28b5…cf5d`); the borrow records ≈ 1.625 and the derived
  ladder is 1.57 / 1.40 / 1.23 / 1.06; `NoBaseAccount`; `set_base_account` refusals and the record; `ReserveShort` at
  one unit over, `InsufficientUsdcToClose`, `ZeroAmount`, nothing moved; a stranger cannot burn; the burn: USDC
  supply down by the amount, the reserve kept, Circle's event account decoded with shared's codec — domain 5 → 6,
  Base's messenger as recipient, the Base account as mint recipient, the amount, the fee bound, the Account PDA as
  sender; `keeper_protect` at HF 1.20 refuses `repay` as understated (de-risk is crossed on the derived ladder;
  on the floor's, 1.20 is not even repay). The ladder (11) and keeper (11) specs pass on the derived rungs.
- **What the run settled** (recorded in `VERIFIED-SOLANA-FACTS.md` Addendum 3's follow-up): the burn's account list
  needs a v0 transaction with an address lookup table (1,422 > 1,232 bytes as a legacy transaction; the ALT itself
  must be extended in chunks); the discriminator `[215, 60, 61, 46, 114, 55, 128, 176]` is accepted by the cloned
  program; `MessageSent` is `8 + rent_payer 32 + created_at 8 + Vec<u8>`.
- **Harness:** `scripts/localnet.sh` regenerates the mint fixtures on every run, so a second validator now REQUIRES
  `FIXTURES=fixtures-<name>` (the specs read `OILSKIN_FIXTURES`); the websocket port is RPC + 1 and both must be free.
  Running the script with the defaults beside a live validator replaces the keys that validator was started with —
  the :8899 validator on this Mac needs a restart before its specs run again (2026-09-13, this session's doing).
 (router, CCTP V2 doubles, one fork test)

BUILD-PLAN D6 / A5, first commit after the design (`SOLANA-ARCHITECTURE.md` §14). `StrategyRouter` gains
`openLpOnly`, `setSolanaRecipient` and `closeLpAndBurn` over Circle's CCTP V2 (`interfaces/ICctpV2.sol`,
transcribed from the verified implementations); the deploy script carries the messenger, the transmitter and the
two domains from the facts file and guards them last (an Aave or Slipstream drift is still named first); Base
Sepolia deploys with the loop off. `test/mocks/MockCctpV2.sol` reproduces the V2 message byte layout (148-byte
header, 228-byte burn body) so a unit test can hand the transmitter the message Circle would attest for a
Solana burn and read the message a Base burn emits.

- **Contracts:** 404 / 0 / 12 skipped (416), 36 suites on the merged tree (401 / 413 / 34 before slice O landed beside it) — +11 `StrategyRouterCrossChain.t.sol`, +2 `Deploy.t.sol`
  (a deployment without CCTP turns the loop off; a named messenger must hold code), the constructor test's
  four routers re-built with the two new arguments. Foundry 1.8 note for the next writer: a `view` helper
  that reads a mock (the band helper's `sqrtPriceX96()`) evaluated INSIDE the call after `vm.expectRevert`
  is the "next call" — build every params struct before the expectation.
- **Fork, at the pinned block 51,222,568 via `mainnet.base.org` (`base-rpc.publicnode.com` does not serve
  state at the pin):** 12 / 12 — `test_fork_cctpV2_theAccountsBurnLegBurnsNativeUsdcToASolanaRecipient`: the
  real TokenMessengerV2 names the recorded transmitter (domain 6, version 1) and Solana's messenger for
  domain 5; the account's approve → `depositForBurn` → approve-zero burns 1,000 native USDC (the FiatToken
  supply falls by exactly that) and Circle's `DepositForBurn` names our recipient and domain 5.
- **ABI seam:** 426 → **440** (`verify-abi --write`, web bundle synced); keeper seam 113 / 113, keeper 269 / 52
  unchanged; web unit suite green on the synced ABI (180 tracked tests; 198 seen with another session's
  untracked Solana files in the tree).
- **Not run here:** Slither / Aderyn / halmos (not installed on this Mac; CI runs them on every changed .sol).


What was added and what proves it: `services/yield/src/sources/kamino.ts` (one `getMultipleAccounts`, strict
decode at offsets computed from klend-sdk 12.0.0's borsh layouts and pinned to two mainnet captures —
`VERIFIED-SOLANA-FACTS.md` Addendum 2), `services/yield/src/solanaBorrow.ts` (the view: shown numbers and
safety-only refusals, BUILD-PLAN D4/D5), `GET /v1/solana/borrow` and the Kamino entry in `/healthz`
(`SOLANA_RPC_URL`), fixtures `test/fixtures/solana-*.json` (copies of the keeper's capture plus the live
LendingMarket), +**18** tests (yield **167**). The bytes corrected one assumption: klend's per-interval caps
count withdrawals and borrows, not deposits (`SOLANA-ARCHITECTURE.md` §7). Suites re-run green on this tree:
yield 167.

## 2026-09-13 — CI with the Rust toolchain; the Squads hand-over as a read-only check

`.github/workflows/ci.yml` gains `solana-program` (Rust 1.98.1, Agave 4.2.2 from `release.anza.xyz`, anchor-cli
1.2.0 from crates.io — the GitHub repository redirects, the crate does not): the generated constants against
shared, `anchor build` of both programs, the 7 host unit tests, and the committed IDL against the build. The
localnet specs stay a local run (`solana/SETUP.md`). `solana/scripts/authority.mjs` reads a program's upgrade
authority from the loader's own account layouts and, given `--expect <squads vault>`, checks the vault by owner
and prints the founder's `set-upgrade-authority` command (exit 2 while pending, 0 once done, 1 on refusal) —
`docs/SOLANA-DEPLOY.md` is the runbook, `DEPLOYMENTS.md` the record to fill. +5 seam tests (Solana seam 12).
Read live for it: Squads Protocol v4's program is immutable (`VERIFIED-SOLANA-FACTS.md` Addendum 2).

## 2026-09-13 — Solana B5, part 2: the web flow (wallet, wizard, position page)

What was added and what proves it: `web/lib/solana/` (env, addresses, hand-encoded instructions pinned to the
committed IDL by `scripts/sync-solana-idl.mjs` + `test/solana-idl.test.ts`, reads, plan, the route client with
plain-words refusals, copy with Kamino's quotation, execute, hooks), `web/components/solana/` (providers, wallet
button, five wizard steps, the position card), `web/app/solana` and `web/app/solana/new`, a nav tab, the Solana
wallet providers inside the existing ones. +18 web unit tests (**198**); `e2e/solana-flow.spec.ts` +2 scenarios
(the wizard end to end in demo mode with zero console errors; the positions page) at both viewports. Dependencies:
`@solana/web3.js` 1.99.0, `@solana/wallet-adapter-react` 0.15.40, `-react-ui` 0.9.40, `-base` 0.9.28; a root
`overrides` pin of `@types/react` to 18 because the mobile wallet adapter's React Native peer pulled React 19's
types into the tree and broke the providers' JSX types. Not exercised: the signed path against a live wallet
(next: a wallet-driven run on localnet).
