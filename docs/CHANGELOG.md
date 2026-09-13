# Changelog

Abbreviations: ABI = application binary interface; HF = health factor; LP =
liquidity provision; EIP = Ethereum Improvement Proposal.

## 2026-09-13 — Solana B5, part 1: the yield service reads Kamino's ZCASH market and shows the rate after the borrow

- **`/v1/solana/borrow`** (`services/yield/src/sources/kamino.ts`, `src/solanaBorrow.ts`; `SOLANA-ARCHITECTURE.md`
  §7 rewritten as built): one `getMultipleAccounts` reads the LendingMarket, both reserves and Scope, decoded
  strictly at byte offsets computed from klend-sdk 12.0.0's layouts and pinned to two mainnet captures
  (`VERIFIED-SOLANA-FACTS.md` Addendum 2). Shown, never gated (D4/D5): the borrow rate now and **after this
  borrow** on the reserve's own curve, utilisation, the pool's depth against its limit and its per-interval cap,
  the account's share, the identity at the chosen HF with `bindingCap` naming what decided (the chosen HF, the
  floor, Kamino's 40 % cap, the pool), the liquidation price and drawdown, the deposit room and the exit's
  per-interval withdrawal room, Scope's age. Refused only for safety: venue paused, borrowing disabled, an
  inactive reserve, a stale or out-of-band oracle, a borrow the pool cannot fund or its limits forbid, a deposit
  over the limit, an entry under the floor or over the cap, a stale read (then no number is served). `SOLANA_RPC_URL`
  turns the source on; `/healthz` carries its slot and staleness. +18 yield tests (167). Correction recorded: the
  3,000 ZEC / day cap bounds **withdrawals**, the 1 M USDC / day cap **borrows**; deposits meet the deposit limit
  alone. Also read live: Squads Protocol v4's program is immutable (Addendum 2).

## 2026-09-12 — `scripts/ledger-read.sh`: the Addendum 14 ledger re-read as a committed, parameterised script

- The read-only `cast call --block` script behind VERIFIED-BASE-FACTS Addendum 14 is in the repo:
  `scripts/ledger-read.sh [rpc] [block]`, so the next re-read (paired with the yield sample's block) is one
  command and not a session's scratch file. Nothing else changed.

## 2026-09-12 — Keeper valuation: CI's one red on `51273f5` was a property test's premise (HF poisons replace, they do not add); the evaluator was right

- The `agent` job on `51273f5` failed "UNKNOWN is sticky" once (fast-check seed `-1022574623`, path
  `52:2:3:2:2:2`) and passed on the next push with the same code — a real counterexample the random
  search had not drawn before. Replayed deterministically: a one-unit USDC residual with no collateral
  is NO_DEBT (slice C), `hfMax` makes it UNKNOWN (G4), and `hfZero` rewrites the same field back to the
  shape Aave reports for that account, which is NO_DEBT again — a replacement, not an added poison.
  Test-only fix in `agent/test/valuation.test.ts`: a HF poison after an earlier HF poison must only keep
  UNKNOWN from becoming OK; every other poison keeps UNKNOWN sticky; a poison that could not apply is not
  one. Fixed property 1 / 1 at the CI seed, five unseeded runs green, agent **269 / 269**, `verify-abi`
  113 / 113, IDL seam 77 / 77 (`AUDIT-2026-09-12.md`, "Keeper valuation").

## 2026-09-12 (later) — A4.3: the risk slider in both prototypes (BUILD-PLAN D7 §2b)

- Both builds' pinned block gains, byte-equal and diffed against the built package: the six new shared keys
  (`LADDER_RUNG_FACTORS`, `EMERGENCY_HF_MIN`, `HF_HYSTERESIS_MIN`, `HF_HYSTERESIS_SPAN`, `MIN_LADDER_ENTRY_HF`,
  `HF_MARKS`) and `ladderFor` / `hysteresisFor` / `ladOf` / `entryHfAtLtv` / `offeredBounds` / `bindingPlain` /
  `ltvForHf` / `hfForBorrow` / `clampHf` / `needsHfAck` / `hfAckText` mirroring `packages/shared`. `LAD` stays the
  floor's ladder; every position (simple) and account (advanced) carries the entry HF its open recorded — the HF after
  the open, four decimals, as `StrategyRouter.entryHfWad` — and the keeper sim, the band, the ladder card and the
  chips run `ladOf(entry)`. The de-risk rung now lifts HF to its own re-arm level, as the keeper sizes a repay, not
  to the entry floor the prototypes used to claim.
- The setting is the slider on both pages: linear in the borrow from 1 % LTV (the prototypes stop there so a saved
  state stays a JSON number; the site reaches "borrow nothing") to the offered maximum, the stop named with its cap,
  the two marks disabled with the reason when under it, a typed HF and a typed borrow driving each other, the
  sub-mark acknowledgment holding the CTA. An untouched default re-derives on a collateral switch; a chosen HF is
  kept and pulled into range. The docs pages describe the derivation and show the marks and each asset's stop.
- Suites: simple 126 → **130**, advanced 114 → **116**, toggle 57 → **62**, fuzz 6 (its invariants now check the
  derived ladder and the HF ↔ LTV identity). One thing the advanced suite surfaced: withdrawing collateral down to
  the exit floor leaves the account under the warn rung of the ladder derived from its recorded entry (the record
  moves only at an open), so the keeper would act and new borrows are blocked until HF recovers — flagged for the
  founder with the floor decision.

## 2026-09-12 (later) — A4.4: the forecast judges the floor the chain enforces (BUILD-PLAN D7 §2b)

- `services/yield/src/sources/registry.ts`: `RegistrySource.entryHfFloor()` reads `CollateralRegistry.entryHfFloorWad()`
  (one `eth_call`, selector `0xe2baeb4e`) and truncates it to four decimals like every other wad the product reads;
  a zero, short, sub-1 or failed read throws by name. The server samples it with the rates when
  `COLLATERAL_REGISTRY_ADDRESS` is set (new, optional — nothing is deployed yet) and `/v1/forecast` judges
  `entry_hf_below_floor` against it, defaults `entryHf` to it, and says where the number came from:
  `entryHfFloorSource: "registry" | "shared"` and `entryHfFloorReadAt`. A read that fails keeps the last good
  one; past `staleAfterMs` the shared constant is served and said, the last read time kept — fail closed on
  the higher floor, never on a floor the chain may have raised since. `/v1/gate` is unchanged. Yield 146 → **149**.
- Left: A4.3, both prototypes; the founder's floor number (and the 50 % cap that binds above any floor on Base).

## 2026-09-12 (later) — A4.2: the risk slider on the site (BUILD-PLAN D7 §2b, the web half)

- **The setting is a health factor.** `web/components/wizard/SettingStep.tsx` is a slider from the lowest
  entry HF offered on the asset up to "borrow nothing", labelled with the HF and linear in the borrow; the
  borrow follows from debt = collateral × LT ÷ HF and a typed borrow drives the HF back, to the cent
  (`entryHfForBorrow`, `planLoan` over `entryHf`). The slider's stop is the smallest of the registry floor,
  Aave's own max LTV and Oilskin's 50 % borrow cap, and the one that binds is named on screen (shared
  `offeredLtvBounds`, `LtvBindingCap`); "Sheltered" 1.55 and "Expert" 1.30 are marks, disabled with the
  reason when they sit under that stop — which, with the floor at 1.55 and the cap at 50 %, they do on
  both Base assets (1.56 on cbBTC, 1.66 on WETH). Below the Sheltered mark the user ticks a sentence naming
  the HF, the drawdown and the first and last rung (`hfAcknowledgmentText`); it is unreachable on Base
  until the floor AND the cap move. The wizard state carries `entryHf` (+∞ = borrow nothing, refused as a
  position) and `hfAcknowledged`; `ltvPreset` and `presetsFor` are gone.
- **The ladder shown is the position's.** Every rung list — Setting, Review, the dashboard's band, keeper
  panel and notification banner — runs `ladderFor` on the entry HF: the chosen one in the wizard, the one
  the router recorded on the dashboard (`AccountRead.entryHf` / `entryHfStatus` from `entryHfWad`; the
  floor's ladder when nothing is recorded, and the band's line says which). The registry floor is read
  from the deployment (`Deployment.entryHfFloor` from `entryHfFloorWad`; refused when unreadable) and is
  the slider's minimum; demo mode uses the shared constant. The forecast query carries the chosen HF.
- Web unit 177 → **180** (179 + 1 skipped), Playwright **14 / 0 / 6** against a private `next dev`.
- Left: A4.3 the prototypes' slider and derived ladder; A4.4 the yield service reading the registry floor
  (`/v1/forecast` still serves `ENTRY_HF_FLOOR`); and the founder's floor number — with the cap at 50 %
  a 1.25 floor is unreachable on Base, so the cap is part of that decision.

## 2026-09-12 (later) — A4.1: the ladder is the position's own (BUILD-PLAN D7 §2b, the keeper half)

- **Shared** (`packages/shared/src/health.ts`): `ladderFor(entryHf)` — rung = 1 + (entry − 1) × 0.91 / 0.64
  / 0.36 / 0.09, emergency never under 1.05, hysteresis max(0.02, 0.05 × (entry − 1) ÷ 0.55), rungs kept
  strictly decreasing — with `HF_LADDER = ladderFor(ENTRY_HF_FLOOR)` reproducing 1.50 / 1.35 / 1.20 / 1.05
  number for number (the Solana seam's generated `ladder.rs` is byte-identical); `hysteresisFor`,
  `ltvForEntryHfBps` (LTV at entry = LT ÷ HF), `drawdownToLiquidationPct`, `hfFromWad`, `HF_MARKS`
  (Sheltered 1.55 / Expert 1.30 — marks, not modes), `MIN_LADDER_ENTRY_HF` = 1.10; `maxOfferedLtvBps`,
  `maxOfferedLtvStopBps`, `ltvPresets` and `isOfferableLtv` take the floor as a parameter. Shared 75 → **82**.
- **Contracts**: `StrategyRouter.entryHfWad[account]` — the health factor the venue measured at every open
  (leveraged or borrow-only), emitted as `EntryHfRecorded`; 0 for an account that never opened. Proven in
  `audit-regressions/EntryHfRecorded.t.sol`: the record is the returned HF, a top-up moves it, and with the
  registry floor set to 1.25 an open at 60 % LTV records 1.30, at 62.4 % records 1.25, and 63 % reverts
  `EntryHfTooLow` with nothing recorded. Forge 384 → **388** / 11 skipped. ABI bundle regenerated (427 entries).
- **Keeper**: `HealthMonitor.resolveLadder` reads the record each tick (`services/entryHf.ts`, a bounded
  `readContract`) and runs `ladderFor(entryHf)` for the account; the floor's ladder runs — and the account
  record says `entryHf: null` — when there is no router, the router reads 0, or the record is under 1.10
  (logged at error, naming the registry floor); a failed read keeps the last value at warn. The rung's disarm
  is written on the dispatch record (`disarmHf`) and the dispatcher sizes a repay to it and judges a resumed
  record against it; a record from before this build is judged against the floor's ladder. Store validation
  covers both fields. Keeper `verify-abi` 111 → **113**, tests 264 → **269** / 52 suites; IDL seam 77/77.
- Left for A4.2: the slider itself (wizard, dashboard, both prototypes), the yield service's floor read, and
  the founder's floor number (1.25 proposed). The Solana keeper still reads the global table (B stream).

## 2026-09-12 (late) — A3: the yield gate becomes a forecast (BUILD-PLAN D4/D5/D7), in two commits

- **The forecast service** (`b849b17`): `GET /v1/forecast` (`services/yield/src/forecast.ts`) prices every
  pool × setting at the entry health factor the user chose — both LP-net forms and the gap between them, the
  impermanent-loss drag, the break-evens, user net at the chosen LTV, the drawdown to liquidation, and the
  borrow rate AFTER this borrow on Aave's live two-slope curve (read every sample with the rates: strategy
  `0x86AB…bDC5`, optimal usage 90 %, slopes 4.70 % / 10 %, VERIFIED-BASE-FACTS Addendum 13). Unlike the gate
  it prices cells the gate stops at before the borrow comparison, and it refuses only for safety (the registry
  floor, a borrow the pool cannot fund, stale rates, a paused or inactive reserve, a disabled asset, the
  venue's LTV). `/v1/gate` is unchanged. `samples/demo-forecast.json` is the evaluator's own output on the
  recorded inputs, pinned cell for cell. Yield 131 → **146**.
- **The site** (this commit): the wizard reads the forecast (`web/lib/forecast.ts`, `useForecast`) and blocks
  on nothing it says. Simple mode shows every pool at its best setting and names the least-bad one as a loss
  when it is one; Advanced shows every pool × setting with both numbers and the gap; a card is disabled only
  by a safety refusal, with the reason. Before any new position — LP, hold or spot — Review carries one
  sentence the user ticks that names the forecast, the borrow cost and the drawdown for that position; it
  resets on any change. The liquidity hard-refusal reads `totalAToken − totalVariableDebt` from the same
  `getReserveData` words the rate comes from (`web/lib/reads.ts`; the snapshot carries the 2026-09-12 figure,
  24,768,504 USDC). `web/lib/gate.ts` keeps its shape as information; `recommend()` is rebuilt over forecast
  cells; the "own-market" risk item now states D3 and a "forecast" risk item joins the review list.
- **The prototypes** (both builds, pinned block still byte-equal): `forecast()` beside the unchanged `gate()`
  in the shared block, every card open with its forecast sentence, the acknowledgment in both review flows
  (`#revAck` / `#wizAck`), the empty-menu and "verdict" strings gone, the docs tables re-headed, the
  generator's comments updated and the block regenerated. The suites assert the new contract: a loss is shown
  and allowed, safety still refuses by name, the acknowledgment gates signing, the two builds agree on every
  forecast cell.
- **Copy**: README "The honest yield forecast", RISKS §14 "Yield forecast and rate drift", YIELD-SERVICE.md.
  Left on purpose: `MODEL-NUMBERS-2026-09-12.md`'s "No pool × setting clears the gate" is the generated gate
  record three suites parse; it is re-worded at the next model run.

## 2026-09-12 (evening) — Cowork's decisions folded in: BUILD-PLAN D1–D7 is the plan of record; the tree reconciled

- **New docs** from the founder's Cowork session: `docs/BUILD-PLAN-2026-09-12.md` (plan of record — §4
  rewritten here to the tree's true state, commit hash per step, and the S3 finding's consequences for the
  Solana lane), `docs/CROSSCHAIN-LOOP-2026-09-12.md`, `docs/AUDIT-SHORTLIST-2026-09.md`,
  `docs/research/SOLANA-ZEC-KAMINO-2026-09.md` (the 2026-09-11 read the facts file's provenance note had
  reported missing; the note now says when it arrived).
- **`CLAUDE.md` "What this is"** carries D3–D7: no cbZEC market on Base; the yield model a forecast, never a
  refusal; Simple mode allows every curated pool after acknowledgment; the cross-chain loop in v1 in both
  modes; a continuous health-factor slider above one registry floor (proposed 1.25, not pinned). Hard rules,
  conventions and `.claude/settings.json` unchanged.
- **`docs/DIRECTION-2026-09-11.md`** already carried the "Decided 2026-09-12" block, §3b and the revised §5
  (byte-identical to the bundle); §5 now says its cbZEC-market track is superseded by D3.
- **`docs/VERIFIED-SOLANA-FACTS.md` Addendum 1**: the CCTP V2 programs on Solana, the three Base contracts
  (each answering a selector with the others' addresses), Circle's fees 1 bp / 1.3 bp, the $53.1 M shared Fast
  allowance and the domain ids — every row re-probed read-only at slot 446,516,913 / Base block 51,227,239 /
  20:10 UTC, fresher than the draft's.
- **Stale phrases inventoried** (BUILD-PLAN §6): README, RISKS §14, web, the prototypes and the yield service
  still speak the gate's language; they are rewritten with A3 (gate → forecast) and A4 (the slider), one
  commit each, with the grep repeated in those commits.

## 2026-09-12 — Solana slice S4: the keeper agent on Solana

- **The keeper's Solana path** (`agent/src/solana/`, `docs/SOLANA-ARCHITECTURE.md` §5): discovery by
  program-account scan; valuation from **one simulated refresh** (both reserves, then the obligation) so the
  keeper reads Kamino's own numbers at the current slot, gated by fail-closed rules S1–S6 (freshness at the
  simulation slot, klend's six price checks, Scope age and dollar sanity, an independent price within 200 bps
  when configured, the recomputed HF within 100 bps of Kamino's); a plan that repays from the Account's idle
  USDC when that reaches the disarm level and otherwise sizes a sale to whichever of the disarm level and
  Kamino's 40 % LTV cap needs more ZEC, paying fair Scope value less at most the configured discount inside
  the grant's allowance, every clamp named; a dispatcher that simulates, classifies program refusals by anchor
  error name, persists the signature before broadcast, confirms, and collects the delegated ZEC; the Base
  monitor's tick order and idempotency record; observe-only without `KEEPER_SOLANA_KEYPAIR` (the CLI's
  default key is refused). The store is generic over an id codec (EVM / base58) and refuses a file written
  under the other. Proven: `verify-solana-idl` **77/77** against the committed IDL, +21 agent tests (**263**),
  and `solana/tests/keeper.spec.ts` on localnet (+5, **26/26**): repay-only at HF 1.30 (294.19 USDC → HF
  1.407), the funded sale at HF 1.16 landing inside the cap with the released ZEC collected to the unit,
  observe-only refusing by name. Harness: the specs hold a standing websocket subscription so
  `@solana/web3.js`'s 500 ms idle-close cannot race a confirmation (two of four runs had every owner-path
  confirmation time out and the process hang; three clean runs since), and the runner exits when mocha ends.
  Not deployed; no keeper runs anywhere.

## 2026-09-12 — Halmos runs: the account's four grant properties hold (4 / 4); the harness had failed on Foundry's dynamic test linking, not on a property

- On `73598d9` the three contracts jobs, `contracts-build` and both seam jobs were green on the runner
  (unit 250 / 0 / 0, audit-regressions 136 / 0 / 0, invariant 2 / 0 / 0; `nproc` 2, 7.8 GiB — the diagnosis
  confirmed), Slither 298 results / no High, Aderyn 0 High, and halmos ran its first step: **failed in
  `setUp()`** with `Unsupported cheat code: deployCode(string,bytes)`. Foundry 1.8 defaults
  `dynamic_test_linking` to true, which compiles every `new X(...)` inside a test contract into
  `vm.deployCode` (the `VmContractHelper*` artifacts); halmos has no such cheat. Bisected locally with
  three throw-away harnesses and halmos's own call stack. `[profile.halmos] dynamic_test_linking = false`
  (`contracts/foundry.toml`); with it `AccountGrantHalmos` is **4 passed / 0 failed** locally (halmos
  0.3.3, `--loop 4`, 33 paths, 0.9 s) — the grant budget cannot be exceeded through any calldata shape the
  parser recognises, and what it cannot budget is refused — and `RouterBalanceHalmos` (bounded `--loop 3`)
  is **1 passed / 0 failed**, 293 paths, 33 s (`AUDIT-2026-09-12.md`, "Halmos"). On the runner (`ceb976b`):
  4 / 4 (151 paths, 3.8 s) and 1 / 1 (406 paths, 114 s); eleven of twelve jobs green, `fork` NOT VERIFIED
  until the `BASE_RPC_URL` secret exists (`TESTING.md` "CI").

## 2026-09-12 — CI: the contracts suite as three jobs, halmos on its own profile — the runner is 2 cores / 7 GB and a whole-tree via-IR compile never finishes on it

- The previous entry's theory (partial recompiles) was wrong: with the exact-key cache the cold compile of
  `5932d2a` died the same way at 13.5 min, and so did `b933864` — seven jobs in a row since `485b3ff`,
  every one at "Compiling 138 files" then "the runner has received a shutdown signal" (exit 143). The
  repository is private, so `ubuntu-latest` is the 2-core / 7 GB runner; the `fork` job compiles the 108
  files its test needs in ~96 s on that same runner, so the 30 remaining test contracts (the ten
  top-level suites, the 19 audit regressions, the invariant handler) are what the runner cannot hold.
  `ci.yml`: `contracts` is a matrix of `unit` / `audit-regressions` / `invariant`, each
  `forge test -vv --threads 1 --match-path <group>` with its own cache key and a summary line
  (`contracts (<group>): P passed / F failed / S skipped of T`); `contracts-build` compiles
  `--skip test` (the seam jobs read product artifacts); the cache fallbacks are back. Aderyn passed on
  `b933864` (**0 High**) and halmos ran for the first time — and met the same shutdown while compiling,
  so both halmos steps now run under `FOUNDRY_PROFILE=halmos` (`foundry.toml`: `test = "test/halmos"`).
  Workflows re-parsed; the run of this commit is the test of all three changes. `docs/TESTING.md`
  "CI" carries the reasoning.

## 2026-09-12 — Aderyn's first run triaged (four Highs, no code change), and the compiler-cache fallback dropped from CI

- Slither passes on the runner since `7b5f72a` (296 results, no High), so Aderyn 0.6.8 ran for the
  first time: **4 High / 15 Low**. Every High is a false positive or a pattern this codebase chose,
  suppressed at its site with `// aderyn-ignore-next-line(<detector>)` and the reason
  (`AUDIT-2026-09-12.md`, "Aderyn"): the factory forwards `msg.value` in full, the Pyth refund goes to
  the fee's payer, the constructor reads cannot be re-entered, `uint16(tol)` is bounded by a `uint16`
  cap. (Second pass, same evening: the CI run of the first pass counted 4 → 1 — `eth-send-unchecked-address`
  anchors on the `refresh` function line, not on the refund call, so its ignore moved above the function.)
  Aderyn could not be run on this Mac (crates.io has 0.1.9; v0.6.8 needs nightly Rust), so the
  CI run of this commit is the check of these suppressions; halmos has still not run and is the next
  step in that job.
- `ci.yml` / `nightly-invariants.yml`: the Foundry cache is **exact key or nothing**. Since `485b3ff`
  every partial via-IR recompile after a `restore-keys` fallback (39 files) ended at ~11 min with "the
  runner has received a shutdown signal" (exit 143) — five jobs in four runs, no compiler error in
  any log — while both cold compiles of the day passed in 13–15 min. The cause is not known; a
  changed `.sol` now costs a cold compile on the runner until it is.

## 2026-09-12 — Ledger re-read: the demo's market snapshot is the yield sample's block, so the demo is one read

- `docs/VERIFIED-BASE-FACTS.md`'s top ledger re-read read-only at block **51,226,072** (2026-09-12T19:31:31Z,
  the block slice K's gauge sample was taken at; `cast call --block` against mainnet.base.org, paced), the
  2026-09-05 figures kept as a drift column; Addendum 14 carries the raw words. A week's drift: USDC borrow
  4.828 → **4.5174 %**, cbBTC 79,630.89 → **77,140.83**, ETH 2,453.45 → 2,520.38, the cbZEC pool 1,020 →
  ≈ 1,125 USDC while Pyth's ZEC/USD is still the 2026-09-04 update (8.0 days old); the pool's active
  liquidity fell 155× within the hour after the read when the tick crossed a spacing boundary.
  `web/lib/demo.ts` (`DEMO_SNAPSHOT_AT`, `DEMO_SNAPSHOT_BLOCK`, `DEMO_CBZEC_PRICE_USDC`, `DEMO_MARKET` at
  the yield service's 4-dp digits), the demo banner, the spot page's cbZEC literal and both prototypes'
  `OIL_CHAIN_READ` (byte-equal) moved; every test that had typed the old digits derives them now
  (`reads.test.ts`'s fake account, W3-MED-1, the wizard carry, `verify-toggle`'s facts checks, the
  hold and spot checks in `verify-simple` / `verify-advanced`); the simple page's disagreement-band lever
  is ×12.2 at this borrow (×12.33 at 4.828 %). Measured in a clean worktree on HEAD (another session was
  mid-edit in the same files; nothing of theirs is here): web typecheck clean, unit **171** (170 + 1
  skipped), e2e **14 / 0 / 6**, prototypes **118 · 109 · 56 · 6**. Yield not re-run (untouched by this
  commit). `docs/TESTING.md` has the section.

## 2026-09-12 — Static analysis, second pass: the swap adapters' High is Slither's `reentrancy-balance`, not `reentrancy-eth`

- The triage commit (`485b3ff`) suppressed the five swap-adapter findings as `reentrancy-eth`; Slither
  reports them under `reentrancy-balance`, a High-severity detector of its own ("balance read before
  the call, used after it"), so the second CI run still failed `--fail-high` at 301 results. The two
  `slither-disable-next-line` comments now name both detectors, the NatSpec and the audit table say
  `reentrancy-balance`, and the CI command run locally (Slither in a scratch venv, same flags) exits 0 at
  **296 results, no High**; `forge build` clean (comments only). Also on record: the `contracts` job of
  `485b3ff` and the `contracts-build` job of `7041771` ended at ~11 min with "the runner has received a
  shutdown signal" (exit 143) while recompiling 39 via-IR files after the cache key changed — the log
  shows `Compiling 39 files with Solc 0.8.24` and then the signal, no compiler error; the two cold
  compiles earlier in the day took 13–15 min on the runner and passed. The push of this commit re-runs
  them.

## 2026-09-12 — NI-HIGH-1 follow-ups closed: the keeper reads `DustLegKept`, the Close plan says a dust leg is kept

- `agent/src/abi/oilskin.ts` gains the `DustLegKept` fragment (seam 110 → 111); `summarizeUnwinds`
  sums kept legs per token and a CONFIRMED repay's note names them ("left in the account, not
  swapped (below the quote's floor): …"); `dispatcher.test.ts` +1. `web/lib/plan.ts`: the Close
  plan's plain sentence and technical note now say a leftover too small for the floor to price stays
  in the account instead of failing the close (`plan.test.ts` asserts both). Keeper 263 → 264 / 51; web 171.

## 2026-09-12 — CI, first real runs: the fork job says NOT VERIFIED (no secret exists yet), Slither's Highs triaged, the nightly invariants green on the runner

- Eight of ten `ci.yml` jobs green on the first push. `fork`: `11 skipped = NOT VERIFIED` — the
  repository has no Actions secret; `BASE_RPC_URL` is the founder's to create. `static-analysis`:
  Slither's three High detectors (`arbitrary-send-eth` on the account's own raw call,
  `reentrancy-eth` on the batch executor and the two swap adapters' balance-delta floors,
  `uninitialized-state` on a pushed-to array mapping) are by design and proved by existing tests —
  suppressed at their sites with the proof named, the Mediums and Lows recorded with verdicts
  (`AUDIT-2026-09-12.md`, "Static analysis"); one Medium left open for the founder: the Pyth
  adapter ignores `conf`. `nightly-invariants.yml` run by hand: 10 / 10 at 1500 × 120 in 4 min 58 s,
  artifact uploaded. Contracts 384 / 0 / 11 unchanged.

## 2026-09-12 — Slice K: the yield gate on fresh chain reads

- **Slice K** — the first live gauge sample since 2026-08-31: block 51,226,072 at 19:31:30 UTC
  (`samples/gauge-emissions-2026-09-12.json`, `VERIFIED-BASE-FACTS.md` Addendum 12); the model
  regenerated from it at the live **4.5174 %** borrow (`docs/MODEL-NUMBERS-2026-09-12.md`):
  **nothing clears** — cbBTC/USDC sheltered nets **−10.92 %** (−5.29 % on the 2026-08-31 words;
  its gauge pays a marginal staker 6.15 % gross, down from 14.13 %) and needs **4.56×** today's
  emissions; WETH/USDC sheltered no longer beats the borrow before drag; the cbZEC/USDC gauge
  carries its first vote (≈ 617 AERO/day) and is refused below the borrow or for no σ; every priced
  cell's LP slice is negative, so no borrow rate opens the menu (`RISKS.md` §14). Machinery so the
  next run is one command: `scripts/run-model.mjs` lifts as-of / borrow / supply / LT from the
  sample (no typed numbers in `package.json`), the sample paces GeckoTerminal
  (`GECKO_MIN_INTERVAL_MS`), fetches only the nine pools it uses, and writes to the right directory
  under `tsx`; `prototype/scripts/gen-oil-model.mjs` re-pins both prototypes' `OIL_MODEL` block
  from the model file (hand-edited before); the yield, web and prototype suites derive their model
  expectations from the model / the pinned block instead of literals, pin the closed form's one
  tolerance breach by name (WETH/cbBTC working, +5.46 pt at today's emissions), and state the rule
  under which the demo's two dated reads (2026-09-05 market snapshot, 2026-09-12 gate) may differ.
  Also fixed on the way: the advanced wizard's "no pool clears … at today's X % borrow rate"
  quoted the market snapshot's rate instead of the gate's; the demo keeper grant lacked the WETH
  line the panel has required since 2026-09-08 (the e2e dashboard scenario had been red since);
  `verify-toggle`'s deep-equal died on a `bigint` (slice I). Counts: yield 131; web unit 171
  (170 + 1), web e2e 14 / 0 / 6; prototypes 118 · 109 · 56 · 6.

## 2026-09-12 — Slice J: the Base Sepolia rehearsal package, nothing signed

- **Slice J** — `docs/DEPLOYMENTS.md` is the template a testnet deployment fills in (chain id,
  block, date, deployer / treasury / registry owner and the hand-off state, the eight Oilskin
  addresses, the five substitutes `deploySubstitutes` prints, the logged tick, the pool id, the tx
  hashes) and the ONE file everything else reads an address from: `deploy/sepolia/
  keeper.observe-only.env.example` (no `KEEPER_PRIVATE_KEY` line by design; `CBZEC_ADDRESS` /
  `AERO_ADDRESS` are the MockB20 / MockERC20 doubles, required on 84532 by name and refused on
  8453) and `deploy/sepolia/web.env.example` (their `NEXT_PUBLIC_` twins); `scripts/
  sepolia-postdeploy-check.sh` runs `DEPLOY-SEPOLIA.md` §5.1–§5.4 read-only in one go (exit 2
  with the reason while the table is empty); `scripts/sepolia-feed-policy.mjs` prints the per-feed
  staleness bounds the keeper WILL derive, computed by the keeper's own `buildFeedPolicies`
  against the live Sepolia aggregators — **2,460 s** for BTC/USD and ETH/USD (1,230 s max gap × 2
  on a 1,200 s heartbeat), **172,848 s** for USDC/USD (daily), at block 46,734,590
  (`VERIFIED-BASE-FACTS.md` Addendum 11); `web/playwright.sepolia.config.ts` + `web/e2e/
  sepolia.spec.ts` run the web against the LIVE testnet deployment, no wallet, no yield service,
  and are **skipped by name** until `DEPLOYMENTS.md` has addresses (3 skipped today; the CI
  `prototypes` job runs the config); `web/test/sepolia-deployment.test.ts` (+4, web 167 → **171**)
  pins the parser; `docs/SEPOLIA-REHEARSAL.md` is the one-page proves / cannot-prove / checklist;
  `DEPLOY-SEPOLIA.md` §6 is now the founder's signed steps only.

## 2026-09-12 — Slice I: CI that proves what it claims (`c7d90f1`), and what its nightly found (NI-HIGH-1, the commit after it)

- **Slice I** — `.github/workflows/ci.yml` has ten jobs: `shared`, `web` (typecheck + unit with
  `VERIFY_ABI_STRICT=1` and the model doc published to `/tmp/build/` so both pins run), `prototypes`
  (Playwright's Chromium), `contracts-build` → `abi-seam` (the root bundle against the artifacts, the
  keeper's seam STRICT — it had printed `SKIP` on every CI run and stayed green) and `agent` (strict
  seam + yield), `fork` (the 11 fork tests at a pinned `FORK_BLOCK` = 51,222,568 with
  `secrets.BASE_RPC_URL`; **without the secret the job fails and its summary line reads
  `fork: 11 skipped = NOT VERIFIED`**), `static-analysis` and `solana-seam` unchanged.
  `nightly-invariants.yml` runs the invariant suite at 1500 × 120 with Foundry's call summary in
  the run summary and as an artifact. `scripts/check-cbzec-b20.sh` replaces
  `test_fork_cbzecIsAB20WithLiveMultiplier` (no fork EVM executes cbZEC's code `0xef`); the fork
  suite went **11 / 11** at block 51,222,568 once a harness defect was fixed (the direct-venue
  close's band was read after the prank). `verify-toggle` had died since 2026-09-07 on a `bigint`
  in `@zyo/shared`; bigint-safe now, and both prototypes' `MORPHO_BLUE` block synced (56 / 56).
  Counts: contracts 380 / 0 / 11 of 391; ABI seam 424; shared 75; Solana seam 4; keeper 110/110 +
  242; yield 131; web 167 (166 + 1 skipped); prototypes 118 · 109 · 56 · 6. Chain reads at
  51,222,568 in `VERIFIED-BASE-FACTS.md` Addendum 10 — the cbZEC/USDC gauge now has an emissions
  vote (≈ 617 AERO / day to 2026-09-17) and USDC borrows at 4.5205 %.
- **NI-HIGH-1** — found by the nightly invariant configuration (1500 × 120) on its first local run:
  `invariant_singleCloseClearsEveryBook` broke because the LP close paid the account 6,192 wei of
  WETH fee and `StrategyRouter._toUsdc` swapped it with the caller's honest quote, whose floor for a
  leg that small is zero — `AerodromeSwapAdapter.swap` refused `ZeroQuote()` and the whole unwind
  (the web's Close and the keeper's protective one alike) reverted for a fee worth less than one
  USDC unit. The router now asks the adapter for `minOutFor` on the actual leg first; a real quote
  whose floor is zero keeps the leg in the account and emits `DustLegKept(account, token, amount)`;
  an empty quote is still `ZeroQuote`. `audit-regressions/DustLegClose.t.sol` (4, three failing
  first on `c7d90f1`); the nightly configuration re-run green, 10 / 10 at 180,000 calls each.
  Contracts 380 → **384** passed; ABI 424 → **425**; keeper seam 110/110 unchanged; web ABI
  regenerated. `AUDIT-2026-09-12.md`, `RISKS.md` §13, `CONTRACT-ABI.md`, `ARCHITECTURE.md`,
  `DEPOSIT-FLOW.md`. Open: the keeper does not read the event; the Close plan's copy does not yet
  say a dust leg may be kept.

## 2026-09-11 — Wave-3 Lows, fixed in order (one commit each; `AUDIT-2026-09-11.md` carries each status)

- **W3-LOW-1** — `StrategyRouter._lpVenueForIds` asks both LP venues about the first owned id and
  refuses `AmbiguousPositionId(id)` when both claim it (the engine's and the position manager's id
  counters are independent) instead of routing the batch to the engine's; the owner closes such an id
  through the venue's own `close`. `audit-regressions/LpVenueRouting.t.sol` (3) collides engine id 1
  with Slipstream token 1 on a fresh fixture. ABI 420 → 421; keeper seam 109 → 110; contracts 363 →
  366 passed.
- **W3-LOW-2** — `SlipstreamLpVenue.toRatioToleranceBps(band)`: the to-ratio swap's tolerance is
  half the band's own price span, capped at the adapter's 500 bps, wherever inside the band the price
  sits — before, it was measured from the band's edge to the current price and a price that had
  drifted to the edge swapped with zero tolerance. `audit-regressions/DirectVenueBandEdge.t.sol` (4);
  the pre-fix refusal was reproduced first. ABI 421 → 422.
- **W3-LOW-3** — `web/lib/gate.ts` `gateForDeployment(gate, deployment)` drops DIRECT-pool verdicts
  when the deployment names no direct venue, so the wizard never offers a pool it cannot open there
  (before, the Permit2 signature was collected and only the band quote refused). `web/test/gate.test.ts`
  (+1); two web test fixtures updated for the slice-F types.
- **W3-LOW-4** — the Close plan's `swap quote` line says "within N% of the Chainlink price Aave uses"
  when a cross-check was possible and "no oracle cross-check was possible: Aave has no price for
  <token>, so the pool's own price is the only one this quote rests on" when it was not (cbZEC); the
  plan stays signable. `web/test/plan.test.ts` (+1). Web 163 → **165** (163 passed, 2 skipped).
- **W3-LOW-5** — the gauge factory's early-withdraw penalty read live: 10,000 bps for 10 seconds on
  the cbZEC/USDC pool (block 51,193,797, Addendum 9). `SlipstreamLpVenue.earlyWithdrawPenalty(id,
  account)` (fails closed by name), the position read and card carry it, the Close plan says what is
  forfeited and until when. `audit-regressions/DirectVenuePenalty.t.sol` (4), `plan` and `reads` (+1
  each). ABI 422 → 424.
- **W3-LOW-6** — `AerodromeSwapAdapter.swap` compares its floor to the account's `tokenOut` balance
  delta, not the SwapRouter's return value (its NatSpec had claimed the delta all along; a probe on
  the unfixed adapter showed a router paying 2 % short of its return value passing a 1 % floor).
  `audit-regressions/SwapAdapterFloor.t.sol` (3); `MockAerodromeSwapRouter.setShortPayBps`. On this
  run the fuzzer built W3-LOW-1's collision (engine id 1 and Slipstream token 1, both mocks minting
  from 1) inside `invariant_singleCloseClearsEveryBook`; the probe now follows LOW-1's documented
  resolution (direct twin closed through its own venue, router asked again) instead of counting the
  named refusal as a failed Close.
- **W3-LOW-7** — a re-grant inside a live period keeps EVERY token's spend, listed again or not:
  spends are stamped with a per-grant generation (`spendGen`) that a period roll or a non-carrying
  re-grant bumps, voiding them all at once (a probe on the unfixed account moved 150 in one period
  against a 100-per-period line through two owner re-grants). `audit-regressions/GrantCarry.t.sol` (3).
  No signature changed; `ARCHITECTURE.md`, `CONTRACT-ABI.md` §1 item 5 and the web's grant note say so.

## 2026-09-11 — Slice H: static analysis and symbolic execution wired into CI; nothing ran locally

None of Slither, Aderyn or halmos is installed on the founder's Mac and none was installed by the
session (the brief: name the command, continue). `AUDIT-2026-09-11.md` §Slice H carries the three
install commands. Added: a `static-analysis` CI job on every push and pull request — Slither
`--fail-high` over `src/`, Aderyn failing on a non-empty `high_issues` in its JSON report, halmos on
`contracts/test/halmos/` — with the reports uploaded; five halmos properties: four on the account's
grant budget and calldata parser (an ungranted root call always reverts `NotGranted`; a recognised
mover is charged exactly its calldata amount and never past the budget; the five unparsable movers
always revert; a non-mover is never charged) that fail the job when violated, and one bounded
router-balance property expected to time out (`continue-on-error`). No Slither / Aderyn finding was
triaged and no property was proved in this session — the honest count is zero of each until the
first run; the files compile under Forge and `forge test` does not run them.

## 2026-09-11 — Slice G: wave-3 adversarial audit with executed proofs of concept (`AUDIT-2026-09-11.md`)

**Scope.** What wave 2 did not cover — `SnuggleLpVenue` beyond `closeMany` / `_takeFee` /
`_tryWithdraw`, `AerodromeSwapAdapter` beyond `minOutFor` / `swap`, the account's parser beyond the
unwind tree, the Pyth adapter's TWAP arithmetic, `web/lib/quote.ts`, the yield gate's decision path,
the invariant Handler's blind spots — and everything slice F changed. **Count: 0 Critical, 0 High,
3 Medium, 7 Low, 10 Info.** Every Medium fixed in the same commit with a PoC that failed first.

**Fixed.** W3-MED-1: keeper protection could never be granted for a cbZEC/USDC position (no Aave
price for cbZEC) — the pool's own USDC price now sizes that budget line (`poolImpliedUsdPrices`,
wizard and dashboard). W3-MED-2: anyone could make the direct venue's `positionsOf` revert by
sending the account 512 Slipstream NFTs, switching the keeper off for it — the staked list is now
always whole, unstaked tokens are scanned through a window, `unstakedOverflow(account)` names the
rest, the keeper warns and the dashboard shows it. W3-MED-3: the invariant suite did not exercise
the direct venue or the pool-direct adapter — four Handler actions, the keeper's direct unwind with
its cbZEC budget, seven peripherals × five tokens under `donate`, both new contracts under the
peripheral, allowance, fee and grant properties (256 × 40, 10,240 calls, 0 reverts).

**Listed, not fixed (the founder chooses; costs in the doc).** W3-LOW-1 same numeric id on both LP
venues routes to the engine's; W3-LOW-2 the to-ratio swap's tolerance is zero at the band's edge;
W3-LOW-3 the wizard offers a direct pool on a deployment without the direct venue; W3-LOW-4 the
cbZEC leg's Close has no oracle cross-check and does not say so; W3-LOW-5 the gauge's early-withdraw
penalty is not read; W3-LOW-6 `AerodromeSwapAdapter` checks its floor on the router's return value
while its NatSpec claims the balance delta; W3-LOW-7 the grant's spend carry-forward is one hop deep.

**Counts.** Contracts 360 → **363 passed, 0 failed, 12 skipped** (26 suites; invariants 256 × 40,
10,240 calls, 0 reverts); root ABI 419 → **420**; keeper seam 108 → **109**, tests **242**; web 161 →
**163** (161 passed, 2 skipped); shared **69**; yield **131**.

**Not done.** No `acceptVenue`, `Deploy.s.sol` untouched, nothing broadcast; the fork tests were not
re-run against Base in this session.

## 2026-09-12 (night) — Solana slice S3: keeper_protect built and the ladder walked on localnet; release_obligation found impossible

`keeper_protect` is the keeper's one instruction, and the chain now checks what Base decides off-chain: a live
grant, a rung that is actually crossed and is the most severe the grant allows (warn is notify-only), budgets
charged from the arguments before any CPI, and an outcome — HF at the rung's disarm level or a budget
exhausted — without which the instruction fails. Because Kamino refuses to release collateral while LTV is
above its cap, the sale path is "repay first, then release what the repayment earned": the keeper pays USDC
into the Account in the same transaction, the program repays it, withdraws the ZEC that payment covers at the
Scope price less the grant's allowance, and delegates exactly that to the keeper; the program never swaps.
Localnet **21/21** (ladder 6: refusals by name at every step, the repay-only path at HF 1.30, the sale path at
HF 1.17 with the keeper's pull bounded to the unit, budgets, revocation), host unit **7**.

`release_obligation` (decision 3) cannot be built: klend's ownership transfer needs Kamino's global admin to
approve it and refuses the initiate step under CPI or beside any other instruction, so a PDA-owned obligation
is untransferable; the exit hatch is `close_position` + `transfer_out` (SOLANA-ARCHITECTURE §3, §12).

## 2026-09-12 (evening) — Solana slice S2: decisions taken, the owner path built and proven on localnet

The founder decided `SOLANA-ARCHITECTURE.md` §12 (keeper may sell collateral to stop a liquidation; Squads
multisig; `release_obligation` yes; the rate is shown, never a refusal; no fees; one audit for both modules)
and installed the toolchain. The Anchor program now carries every owner instruction of §3, with the entry and
exit floors enforced in the program, `kamino.rs` (klend builders, CPI helpers, byte-verified readers), and a
second seam (`generated/addresses.rs` from shared). Localnet **15/15**, host unit **5**, seams **7**. What the
run taught and the code now embodies: klend marks a reserve stale after every state change (refresh again
before the post-action view); klend closes an emptied obligation (deposit re-creates it); Kamino's own 40 %
cap binds before the 1.55 floor on this market. Harness: `--warp-slot` above mainnet (klend's `slots_elapsed`
overflows otherwise) and `programs/mock_scope` at Scope's program id (a future-dated Scope timestamp is refused,
verified) so tests stamp prices fresh and can move them. Reader SDKs isolated in `solana/readers`.

## 2026-09-12 — Step 7: the Solana module, design before code

**Direction.** `DIRECTION-2026-09-11.md` copied into the repo; `CLAUDE.md`, `README.md` and the
package descriptions now say what the founder decided: chain-agnostic, ZEC-holder-centric, a Base module and
a Solana module both built in full, never a notify-only "lite" variant. The product-describing "Base-first"
labels became "Base module"; dated audit and research records keep theirs.

**Facts (Step 7a).** `VERIFIED-SOLANA-FACTS.md`, read live 2026-09-12 (slots 446,294,693 → 446,298,641) with
the reader committed as `solana/scripts/read-facts.mjs` and its raw output as
`research/solana-facts-2026-09-12.json`: the ZCASH market and its two reserves decoded field by field (LTV 40,
LT 65, cap 13,000 ZEC, $2 M USDC limit, the five-point rate curve, 180 s / 240 s oracle ages, the $400–$2,000
band), the Scope chain (430 = MostRecentOf(Pyth Lazer 407, Chainlink 428), 15 % divergence, 7,200 s), the
bridged ZEC mint (authority = PDA `["authority"]` of the bridge program `dahP…CPxe`, proven; no freeze
authority; minting observed), every program's upgrade authority, all 45 obligations (one is 58.8 % of the
debt), the USDC projection against Base's live Aave rate (+$84 K crosses it, +$358 K empties the pool),
Jupiter depth (400 ZEC at 0.56 % impact) and Kamino's own disclosure wording, verbatim. The research file
the handoff cites does not exist anywhere; the drift table records where the direction memo's numbers moved.
`packages/shared/src/solana.ts` carries the addresses and a dated snapshot (+6 tests).

**Design (Step 7b).** `SOLANA-ARCHITECTURE.md`: Account and Grant PDAs, a program-owned Kamino obligation,
typed owner instructions with the entry and exit floors in the program, one keeper instruction the chain
gates on the refreshed health factor and on its own outcome, the ladder generated from shared, the
pool-size gate, the deposit-flow disclosures, the risks (`RISKS.md` §22, `PRIVACY.md` §6), the audit scope
(`AUDIT-SCOPE.md`), the localnet test plan, and seven decisions for the founder. `ARCHITECTURE.md` points at it.

**Scaffold (Step 7c).** `solana/` as a sibling npm workspace: Anchor 1.2.0 / Agave 4.2.2 pins, an empty
program (no handlers, by instruction), `generated/ladder.rs` from `gen-ladder.mjs` with a seam test
(`npm test -w @zyo/solana`, 4), the localnet harness with the two fixtures (Scope timestamps, ZEC mint
authority), `SETUP.md`, key-path deny rules in `.claude/settings.json`, a CI job for the seam. Not run here:
`anchor build` and the localnet smoke test (no toolchain on the founder's Mac).

## 2026-09-11 — Slice F: the two decisions implemented — one Close clears every book; cbZEC/USDC held directly on Slipstream

**Two-book Close (RISKS §8, option 1).** `StrategyRouter.unwind`'s withdraw leg now visits every
venue the registry names for the asset that holds the account's collateral, current pointer first,
each gated on its own global health factor, one `VenueWithdrawn(account, venue, withdrawn)` per venue;
`max` = everything everywhere, a fixed amount is a total taken in venue order and refused by name
(`CollateralShort`) when the venues cannot meet it. Selector, `UnwindParams` and the keeper grant
unchanged; the keeper still sets `withdrawAmount = 0`. `invariant_KNOWN_singleCloseStrandsCollateral`
flipped to `invariant_singleCloseClearsEveryBook` (stranded == 0, never a revert on a funded two-book
account); `VenueSwitch.t.sol` M1f rewritten and M1m–M1q added. The keeper's `summarizeUnwinds` reads
the new event (`withdrawnByVenue`); a CONFIRMED-with-shortfall repay now tells the owner ONCE through
a dedicated `shortfall` event, the rung is re-armed by the existing bounded rule, and the re-armed
retry's SUPERSEDED is bookkeeping (`healthMonitor.test.ts`, end to end). The web's Close says the
collateral sits in N places and comes back from all of them in the one transaction.

**cbZEC/USDC held directly (CBZEC-PATH memo, option 1).** `SlipstreamLpVenue` over the second
Slipstream deployment's position manager `0xe1f8…8b53` and the pool's gauge `0x8779…81FB`, and
`SlipstreamPoolSwapAdapter` over the pool's own `swap` with the callback (the verified SwapRouter
cannot reach this pool). Two-sided range centred on the price (a single-sided deposit is swapped to
ratio through the pool under a floor from the caller's band, capped at 5 %), staked in the gauge when
the Voter says it is alive, fee once per distinct token on what `claim` / `close` collect, principal
untaxed, no rebalancer. Every signature from the verified sources (VERIFIED-BASE-FACTS Addendum 9).
The router takes a second venue and adapter (`LP_VENUE_DIRECT`, `SWAP_DIRECT`; zero on Sepolia):
a pool id is resolved on the engine venue first, then the direct one; an unwind's ids by
`ILpVenue.ownedPool(id, account)` — new on both venues, because a staked NFT is the gauge's on the
NFT's books. `Deploy.s.sol` wires both (`DEPLOY_DIRECT_LP_VENUE`, default true; the guard checks the
pool names the recorded manager, gauge and factory). Keeper: both venues' `positionsOf`, the direct
venue's `PositionsUnreadable` named, the callback's cbZEC payment charged to the grant's budget
(`test_keeperUnwindOnTheDirectPoolIsBudgeted`). Web: `lpPoolId` (the padded pool address), claims
target the venue that holds the id, positions carry `venue` and `staked`, a `direct-venue`
disclosure. Shared: `lpMenu()` = engine menu + direct pools; `offerablePools()` unchanged (the
prototypes' eight). Fork: open → close on the deployment's WETH/USDC ts-10 pool with the live NPM and
gauge, and the cbZEC pool's live pointers; the cbZEC pool's own mint cannot run in a fork EVM.

**Counts.** Contracts 329 → **360 passed, 0 failed, 12 skipped** (25 suites; +24 `SlipstreamLpVenue.t.sol`,
+5 `VenueSwitch.t.sol`, +2 `DeployTest`, +2 fork; the invariant group still one test, 10 invariants,
10,240 calls, 0 reverts); root ABI 330 → **419** entries across 19 contracts; keeper seam 76 → **108**,
tests 237 → **242** (47 suites); shared **69**; web 156 → **161** (159 passed, 2 skipped); yield **131**.
Prototypes not run on this Mac (no Playwright Chromium at `/opt/pw-browsers`); `offerablePools()` and
every constant they deep-equal are unchanged.

**Not done.** No `acceptVenue` anywhere; `Deploy.s.sol` keeps cbBTC and WETH on `AaveV3Venue`;
nothing broadcast; the gauge factory's early-withdraw penalty for this pool was not read.

## 2026-09-10 — Slice E: the cbZEC path with numbers (memo), and the B20 claim made true

**Probes (read-only, blocks 51,146,494–51,146,674; Addendum 8).** The verified Slipstream SwapRouter
`0xBE6D…18a5` cannot route USDC → cbZEC: `exactInputSingle` at tick spacing 200 and 100 reverts with
no data under `eth_call` balance and allowance overrides (USDC slot 9 verified against `balanceOf`;
the WETH → USDC control through the same router returns 24.417813 USDC for 0.01 WETH). The cbZEC
pool sits on a second, FactoryRegistry-approved Slipstream CLFactory `0xf8f2…61Ef` (owner and fee
manager `0xE6A4…2075`, 1,414 pools, its own NPM `0xe1f8…8b53`, gauge factory `0x3852…6AbB`), which
names no router. **The cbZEC/USDC gauge has its first emissions vote**: `rewardRate()`
7,140,520,125,989,201 wei AERO/s (≈ 617 AERO/day ≈ $336/day at the Chainlink AERO/USD 0.5449),
`periodFinish` 2026-09-17, 0.083 % of the Voter, `isAlive`; 0.086 % of the pool's active liquidity
is staked; pool ≈ 666k USDC + 206 cbZEC, tick −23,756 (≈ 1,075.5 USDC/cbZEC). The engine still
lists no cbZEC pool.

**Memo.** `docs/CBZEC-PATH-2026-09.md`: (1) direct Slipstream integration bypassing the engine
(≈ 2,300 lines across ≈ 12 files, a second audit surface, binds to the second deployment's NPM and
gauge, ≈ 137 % emissions APR on a $89k centred position while this epoch's vote and the range hold);
(2) cbZEC LP out of v1, spot only (≈ 0 new lines, ≈ 60 removed, no cbZEC yield); (3) wait for an
engine listing (0 lines, no lever, the engine's single-sided placement problem again). No choice made.

**The must-fix.** `web/lib/copy.ts` claimed the app reads B20 policy state; nothing did. Now
`web/lib/b20.ts` reads `multiplier()` and simulates a zero-amount `transfer(from, 0)` FROM the user's
address (refused when blocked or paused, needs no balance), `@zyo/shared` `describeB20Probe` writes
the sentence with what was NOT seen, the spot page shows it whenever cbZEC is on either side with a
wallet connected (demo says it did not run), and the disclosure claims exactly that. `RISKS.md` §4,
`AUDIT-SCOPE.md`. The stale "no emissions" claims (facts §Aerodrome and "what this settles", RISKS §6,
the Sepolia substitute note, the onboarding note, the two dated plans) now point at the 2026-09-10 read.

**Tests.** Shared 65 → **69**; web 154 → **156** (154 passed, 2 skipped); copy test green with the
rewritten disclosure.

**Not done.** No `acceptVenue`, `Deploy.s.sol` untouched, `AerodromeSwapAdapter` not pointed at cbZEC,
nothing broadcast, `contracts/.env` not written.

## 2026-09-10 — Slice D: the two-book Close, measured and parked with a test waiting

**What.** After a venue switch an account can hold collateral on both venues; the web's Close is one
`unwind(ids, repay max, withdraw max)` and the router's withdraw leg stops at the first venue holding
anything, so the second venue's collateral stays behind, debt-free. Not fixed here — `RISKS.md` §8
now carries the two options with numbers: (1) the router's withdraw leg iterating every venue that
holds the account's collateral, each gated by its own exit floor (one new `VenueWithdrawn` event,
`unwind` selector and grant unchanged, ≈ 362k gas per extra Aave venue / ≈ 189k per extra Morpho
venue at the fork's figures — ≈ $0.005 / $0.003 of L2 execution at the base fee read the same day);
(2) the web planning one Close per venue (no ABI change, Simple-mode wording written, the keeper must
keep `withdrawAmount = 0`). The choice is the founder's.

**Proof waiting for the fix.** `Handler.singleCloseProbe` runs the web's exact call on every two-book
state the fuzz reaches, funded with every book's `debt()`, and counts the runs that stranded
collateral; `invariant_KNOWN_singleCloseStrandsCollateral` asserts the strand happens every time
(and that no such run reverted or stranded nothing), with the flip written into its message;
`test_handlerPathsAreLive` reaches the state. Invariants 9 → **10**; the group is still one test.

**Measured.** `test_fork_twoBookWithdrawLegGas` (fork 10 tests, 9 / 1 at block 51,127,409): a
`MorphoBlueVenue` over the two verified markets on the fork's own registry, cbBTC switched by
propose → timelock → accept, a book on each venue; the router's two views per venue cost 158,648
gas on Aave / 63,987 on Morpho, a `withdraw(max)` leg 203,462 / 125,152 (Addendum 7).

**Not done.** No `acceptVenue` (the fork test switches ITS OWN registry, deployed in the test),
`Deploy.s.sol` untouched, nothing broadcast.

## 2026-09-10 — Slice C: one dust threshold, applied wherever "fully repaid" or "holds nothing" is decided

**Why.** Measured at block 51,127,409 (Addendum 3): Aave reads a same-block supply of 1e8 cbBTC as
99,999,999 and a borrow of 10,000 USDC as 10,000,000,001. `AaveV3Venue.repay(max)` approved and Aave
pulled the full debt, so an account holding exactly what it borrowed died in `transferFrom`; and
every exact-equality reading of "no debt" — the router's exit routing, the keeper's `confirm` and
NO_DEBT verdict, the dashboard's tile — would have misread the residual.

**The threshold.** `LOAN_DUST_UNITS` = **100 units of the loan token** (`packages/shared/src/dust.ts`,
with the rationale; `contracts/src/libraries/LoanDust.sol` mirrors it and the agent's ABI seam pins
the two, 75 → **76** checks). Units, not a percentage, because rounding is additive per operation:
two orders above the largest error measured or derivable, five below the smallest amount anyone
spends a transaction on.

**Where it is applied.** `StrategyRouter._holdsPosition` (a residual is not a position, so a
two-book Close is not routed to a venue with nothing to withdraw; the repay leg still clears it);
`AaveV3Venue.repay` approves what Aave will pull and never more than the account holds — an
exact-balance `max` repays everything held and leaves the rounding, an account holding no USDC is
`InsufficientLoanToken(asset, held, owed)` by name (ABI 329 → **330**); the keeper's Aave G-guards and
venue valuation read a residual on the USDC row / a venue's `debt` as NO_DEBT (the pool's finite,
enormous HF is not a fault; literally nothing owed still demands `MAX_UINT256`); `confirm()` does not
count a venue owing at most the threshold as untouched and `judgeUntouched` treats such a
dispatch-time book as owing nothing; the web's pool leg and venue leg both read such a residual as
HF ∞ so they agree, `AccountRead.debtIsDust` drives the dashboard's "no debt" and `otherDebtUsdc`
excludes it. `MorphoBlueVenue.repay(max)` already clears by shares; unchanged.

**What it does not do.** The venues do not forgive dust: on the fork an exact-balance `repay(max)`
left 2 units (Aave's read plus the repay's own rounding) and `withdraw(max)` reverted
`HealthFactorLowerThanLiquidationThreshold()` (`0x6679996d`) until they were repaid; the aToken hands
back 99,999,999 of 100,000,000 cbBTC. The app must ask for the full `debt()`, never the borrow
(Addendum 6, `RISKS.md` §8).

**Tests.** `test_fork_supplyBorrowRepayWithdrawUnderTheAccount` green at the pinned block, funded by
the borrow alone and then by `debt()` (fork 7 / 2 → **8 / 1** of 9); `LoanDust.t.sol` +5 (contracts
324 → **329** / 0 / 9, `MockAave.bumpDebt` models the +1); keeper 234 → **237** (the never-NO_DEBT and
poison properties scoped to debts above the threshold, USDC row only); web 153 → **154**; shared
62 → **65**.

**Not done.** No `acceptVenue`, `Deploy.s.sol` untouched, nothing broadcast, `contracts/.env` not
written.

## 2026-09-10 — Slice B: open → close on the engine's real Aerodrome entry; the mocks carry the measured revert shapes

**Fork test.** `test_fork_lpOpenCloseOnLiveEngine` selects the engine's entry by PROPERTY (active,
WETH/USDC, a position adapter that answers `getTWAPTick(pool, 300)`, the pool's `factory()` = the
Slipstream CLFactory, a reward adapter set) instead of "first active WETH/USDC", which was the
Uniswap stub at index 0. It lands on the Aerodrome CL100 WETH/USDC entry (index 24 logged, pool
`0xb2cc…DC59`, gauge `0xF33a…e0c8`) and proves, at block 51,127,409: minted to the account and
auto-staked; `positionsOf` sees the id (slice A); a close inside the 60 s hold is
`MinimumHoldTimeNotMet()`; `closeMany` inside the hold reports every id; the close at +2 min pays
the account 999.999999 USDC and 0 WETH (9,999 bps of 1,000 back; the test bounds it at 98 %); the
venue holds nothing. `BaseAddresses.AERODROME_CL_FACTORY` added (chain-read). A new
`test_fork_engineRefusalShapesOnUnstakedEntry` opens on an un-gauged Uniswap entry (index 17
logged) and measures, raw from the account: `NotPositionOwner()` for a foreign AND a never-minted id
on `withdraw` / `harvest` / `claimStakingRewards`, `NoFeesToHarvest()`, `NoRewardAdapter()`; the
venue's `claim` on a foreign id reports it. Fork at the pinned block: 5 / 3 of 8 → **7 / 2 of 9**.

**The finding.** The engine does NOT swap a single-sided deposit to ratio. Its verified mint library
(`SnuggleRebalanceLib.executeMint`, Sourcify) builds a one-sided "snuggle" range on the deposited
token's side of the price — below it for USDC, from the lower of TWAP and spot — so every position
the product opens (borrowed USDC in single-sided) holds only USDC until the price falls into the
range and earns no fees or emissions while it waits. `ISnuggleVault` FACT 4 and the router's header
said the opposite and are corrected (FACT 5 added with the measured shapes); `CONTRACT-ABI.md` too.
`RISKS.md` §12 carries it; whether to open dual-sided, accept the limit-order shape, or price it is
for the founder (slice E memo).

**Mocks.** `MockSnuggleVault` declares the engine's errors by name and arity (`NotPositionOwner()`,
`PoolNotApproved()`, `TokenNotInPool()`, `DeadlineExpired()`, `NoFeesToHarvest()`,
`NoRewardAdapter()`; `NotOwner` / `Expired` / `PoolNotApproved(bytes32)` gone), reverts them under the
engine's conditions (a never-minted id is `NotPositionOwner()`, a zero harvest reverts, an un-gauged
pool refuses `claimStakingRewards`), pauses deposits only with OZ's string, and separates
`setUnreachable` (a proxy / node failure → `EngineUnreachable`) from `setPaused`. Test switches
(`WithdrawRefused`, `ClaimRefused`) are labelled as switches. Header says what was measured and what
is source-derived.

**Tests.** Contracts 323 → **324** / 0 / 9 (`SnuggleLpVenue.t.sol` +1: the pause refuses opens, not
closes or views; the unreachable test renamed to what it tests). Keeper unchanged at 234 (re-run).

**Not done.** No `acceptVenue`, `Deploy.s.sol` addresses only (one factory constant), nothing
broadcast, `contracts/.env` not written.

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
