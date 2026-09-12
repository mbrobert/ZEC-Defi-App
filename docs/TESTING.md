# Testing — every suite, how to run it, what it proves

Counts are from running each suite on this tree on **2026-09-12** (slice I; the
rows say when a count was last re-measured) — not copied from build reports. Two audiences: the
automated suites, and a person clicking the demo (the tester's kit at the end).

Abbreviations: RPC = remote procedure call (a chain node endpoint); ABI =
application binary interface; HF = health factor; LT = liquidation threshold;
LTV = loan-to-value; LP = liquidity provision; TWAP = time-weighted average
price; EIP = Ethereum Improvement Proposal; CI = continuous integration;
MC = Monte Carlo.

## Summary

| Area | Command | Counted result |
|---|---|---|
| Contracts (Foundry) | `cd contracts && forge test` | **388 passed, 0 failed, 11 skipped** (399 total), 33 suites (2026-09-12 A4.1: +4 `audit-regressions/EntryHfRecorded.t.sol` — the router records the venue-measured entry HF on every open and emits `EntryHfRecorded`, a never-opened account reads 0, a top-up moves the record, and with the floor moved to 1.25 by the owner's setter an open at 60 % LTV records 1.30 and at 62.4 % records 1.25 while 63 % reverts `EntryHfTooLow` with nothing recorded, 384 → 388; NI-HIGH-1: +4 `audit-regressions/DustLegClose.t.sol`, 380 → 384; slice I: `test_fork_cbzecIsAB20WithLiveMultiplier` retired for `scripts/check-cbzec-b20.sh` — 12 → 11 skipped without `FORK_URL`, re-measured 380 / 0 / 11; 2026-09-11 wave-3 Lows: +3 `audit-regressions/GrantCarry.t.sol` (W3-LOW-7), +3 `audit-regressions/SwapAdapterFloor.t.sol` (W3-LOW-6), +4 `audit-regressions/DirectVenuePenalty.t.sol` (W3-LOW-5), +4 `audit-regressions/DirectVenueBandEdge.t.sol` (W3-LOW-2), +3 `audit-regressions/LpVenueRouting.t.sol` (W3-LOW-1); slice G / wave 3: +3 `audit-regressions/DirectVenueEnumeration.t.sol` (W3-MED-2); the Handler gains four direct-venue actions — 25 in all — and `donate` covers seven peripherals × five tokens (W3-MED-3), the invariant group still one test; slice F: +24 `SlipstreamLpVenue.t.sol` — the direct venue and the pool-direct adapter, incl. the router opening and unwinding on the direct pool and the keeper's callback payment charged to its budget; +5 `VenueSwitch.t.sol` M1m–M1q and M1f rewritten for one Close clearing both venues; +2 `DeployTest`; +2 fork tests skipped without `FORK_URL`; `invariant_KNOWN_singleCloseStrandsCollateral` flipped to `invariant_singleCloseClearsEveryBook` — still 10 invariants, one test; 2026-09-10 slice D: +1 fork test skipped without `FORK_URL`, the `KNOWN_singleCloseStrandsCollateral` invariant joins the invariant group, reported as one test; slice C: +5 `audit-regressions/LoanDust.t.sol`; slice B: +1 `SnuggleLpVenue.t.sol` pause semantics, +1 fork test skipped without `FORK_URL`; slice A: +18 `audit-regressions/EnumerationAmbiguity.t.sol`, +1 `SnuggleLpVenue.t.sol`; 304 / 0 / 8 on 2026-09-09, after `RISKS.md` §8 residual (a): +6 `VenueSwitch.t.sol` M1g–M1l; 298 / 0 / 8 on 2026-09-08 after the wave-2 fix round: +6 `VenueSwitch.t.sol`, +3 `GrantShape.t.sol`, +5 `MorphoBlueVenueTest`, +2 `StrategyRouterTest`, +1 `DeployTest`, +2 `PythOracleAdapterTest`, +1 invariant; the row read 276 / 284 / 20 before it) — **9 invariants** (+ a call-summary and a handler-liveness test) at 256 runs × depth 40, **10,240 calls, 0 reverts** (Foundry 1.8 reports the invariant group as one test, hence "2 tests" for that suite; 2026-09-10 slice 2: +`invariant_repayReachesEveryBook` with two new handler actions, `supplyAndBorrowOnCurrentVenue` and `repayAcrossProbe`, so the fuzz reaches accounts owing USDC on both Aave and Morpho — 304 / 0 / 8 unchanged, re-measured); 11 fuzz tests × 512 runs. Measured on the founder's Mac, Foundry 1.8.1, 2026-09-10. **Isolation is pinned in `foundry.toml`** (`isolate = true`, every top-level call its own transaction) so local and CI agree without a flag; `forge test --no-isolate` prints the same 304 / 0 / 8. The `--no-isolate` requirement of 2026-09-07 is gone with the Pyth adapter's same-transaction gate (wave-2 P-MED-1) |
| Contracts, fork | `FORK_URL=<Base RPC> FORK_BLOCK=51222568 forge test --match-path test/fork/BaseFork.t.sol -vv`, then `scripts/check-cbzec-b20.sh <Base RPC> 51222568` | **11 tests — 11 passed / 0 failed / 0 skipped against Base mainnet at block 51,222,568 on 2026-09-12** (slice I; public RPC, Foundry 1.8.1, founder's Mac; the first all-green run of this file). What changed to get there, and only this: (1) `test_fork_directVenueOpenCloseOnTheSecondDeployment` — never run against Base before — failed `NotOwner()` on its first run because the close's band was computed *after* `vm.prank(alice)` and `_forkBand`'s `slot0()` staticcall consumed the prank, so the close reached the account as the test contract; the band is now read before the prank (a harness defect, no product code touched) and the test passes: open 1,276,935 gas, close 534,277 gas, 400 USDC in → 199.84 USDC + 0.0629 WETH back = 400.72 USDC-equivalent, position burnt (`VERIFIED-BASE-FACTS.md` Addendum 10). (2) `test_fork_cbzecIsAB20WithLiveMultiplier` is **retired**: no fork EVM can execute cbZEC's code `0xef` (it failed `OpcodeNotFound` at every block it was ever run — 2026-09-07, 09-10 and 09-12 at 51,222,568), so its four assertions are now `scripts/check-cbzec-b20.sh`, `cast` against the RPC at the same pinned block — OK on 2026-09-12: code `0xef`, `decimals()` 8, `symbol()` cbZEC, `multiplier()` 1e18 (printed, never pinned). The CI `fork` job runs both at `FORK_BLOCK` and fails, saying `NOT VERIFIED`, when the RPC secret is absent (CI section below). History — 12 tests (2026-09-11: +`test_fork_directVenueOpenCloseOnTheSecondDeployment` on the second factory's WETH/USDC ts-10 pool, +`test_fork_directVenueBindsToTheCbzecPool`; not yet run against Base — the two are skipped without `FORK_URL` like the rest); **skipped without `FORK_URL`** (`vm.skip`), reported as skipped, never as passed. **Run against Base mainnet on 2026-09-10 at block 51,127,409 (public RPC, founder's Mac, Foundry 1.8.1): 4 passed / 4 failed / 0 skipped on the first run** — the same 4 + 4 as the founder's 2026-09-07 run at block 51,001,138 — **5 / 3 / 0 at the same block after slice A** (`test_fork_engineIndexGetterShape` passes and meters the four probe shapes, `VERIFIED-BASE-FACTS.md` Addendum 4), **and 7 / 2 / 0 of 9 after slice B** (`test_fork_lpOpenCloseOnLiveEngine` re-pointed by property at the Aerodrome CL100 entry passes — open, hold refusal, close, 9,999 bps back, one-sided range — and the new `test_fork_engineRefusalShapesOnUnstakedEntry` measures the six refusal selectors the mocks now carry, Addendum 5). What each failure means is in `VERIFIED-BASE-FACTS.md` Addendum 3 and `RISKS.md` §8, §11, §12: cbZEC's B20 native contract cannot execute inside a fork EVM (`OpcodeNotFound` on code `0xef`, harness limitation); the live engine's end-of-list revert is empty `0x`, which slice A's redesign of `positionsOf` now enumerates (that test is the one that turned green); the engine's first active WETH/USDC entry is a stub whose position adapter reverts `NotImplemented()` (`0xd6234725`), which slice B's property-based selection steps over to the real Aerodrome entry (that test turned green too, and showed the single-sided deposit is a one-sided range); Aave's scaled-balance rounding reads 1 unit under on the aToken and 1 unit over on the debt (the collateral assertion was widened to ±1; the repay then fails on the +1 because the fixture funds exactly the borrow). No product code was changed to make any of them green |
| Root ABI seam | `node scripts/verify-abi.mjs` | **425** selectors / topics / errors across 19 contracts match (2026-09-12 NI-HIGH-1: +`StrategyRouter.DustLegKept`, 424 before; 2026-09-11 W3-LOW-5: +`SlipstreamLpVenue.earlyWithdrawPenalty` / `PenaltyUnreadable`; W3-LOW-2: +`SlipstreamLpVenue.toRatioToleranceBps`; W3-LOW-1: +`StrategyRouter.AmbiguousPositionId`; slice G: +`SlipstreamLpVenue.unstakedOverflow`; slice F: +`SlipstreamLpVenue`, +`SlipstreamPoolSwapAdapter`, `StrategyRouter.VenueWithdrawn` / `LP_VENUE_DIRECT` / `SWAP_DIRECT` / `UnknownPool` / `CollateralShort`, `ILpVenue.ownedPool`; 330 across 17 before) `contracts/abi/oilskin-abi.json`; `--write` regenerates; exit 1 on drift |
| Shared | `npm test -w @zyo/shared` | **85** (12 files; 2026-09-12 A4.2: +3 `health.test.ts` — `entryHfAtLtvBps` truncating to four decimals and `rungDropPctAtHf`, `ladderForRecorded`'s fallback rule for every unusable record, `offeredLtvBounds` naming the cap that stops the slider on both Base assets at the 1.55 and the 1.25 floor, the floor on a 60 % threshold, Aave's LTV when smallest, LTV→0 offering nothing, and the tie order; A4.1: +7 `health.test.ts` — `ladderFor(1.55)` is `HF_LADDER` number for number, the worked rows 1.30 → 1.27 / 1.19 / 1.11 / 1.05, 1.25 → 1.23 / 1.16 / 1.09 / 1.05, 1.625 → 1.57 / 1.40 / 1.23 / 1.06 and 2.60 → 2.46 / 2.02 / 1.58 / 1.14, a sweep from 1.10 upward with every ladder strictly decreasing and passing the keeper's shape, the hysteresis and LTV identities, `maxOfferedLtvBps` / `ltvPresets` with the floor as a parameter, and `hfFromWad` truncating a router record to four decimals; 2026-09-12: +6 `solana.test.ts` — every Solana address decodes to 32 bytes of base58, the reserves point at the mints and Scope indices the facts file recorded, no LTV/LT/rate outside the dated snapshot, the entry rule on Kamino's numbers 6500 → 4193 → 4100 → min(·, 4000) at HF 1.625 with the rung drops 7.7 / 16.9 / 26.2 / 35.4 / 38.5 %, and `kaminoCurveAprBps` reproducing the projection table; 69 on 2026-09-11: the cbZEC pool test now asserts `lpMenu()` / `lpPoolId` / `directPoolId` / `poolByLpPoolId` and the per-epoch note; `offerablePools()` unchanged; evm, base, health, collateral, fees, width, pools, chains, lpEnumeration, dust, b20 — slice E: the B20 probe's words — clear only when the multiplier read AND the zero-amount self-transfer both succeeded, blocked names the reason, no wallet or a failed simulation is never clear, a rebased multiplier is shown; slice C: `LOAN_DUST_UNITS` = 100, pinned against `LoanDust.sol`, 0 / 1 / 100 dust and 101 not, the human-unit form; slice A, 2026-09-10: the LP enumeration fault names in the contract's enum order and the sentence each becomes; the per-chain tables of slice 6, 2026-09-10: Sepolia rows pinned to the facts addendum, checksums, `chainTable` / `resolveTokens` / `collateralAssetsFor` and their named errors) |
| Solana, seams | `npm test -w @zyo/solana` | **7** (`ladder-seam.test.mjs` 4: the committed `generated/ladder.rs` equals `@zyo/shared` rung for rung; `addresses-seam.test.mjs` 3: `generated/addresses.rs` equals shared's `solana.ts` key for key, no LTV/threshold/rate constant among them; node:test, no Rust toolchain, no validator) |
| Solana, program unit | `cd solana && cargo test --manifest-path programs/oilskin/Cargo.toml --lib` | **7** (`keeper_protect.rs`: the most severe allowed crossed rung is the expected one; the sale floor prices ZEC in USDC less the allowance; `health.rs`: HF 1.625 at Kamino's top LTV clears the floor; a 45 % LTV is refused by OUR floor even where a venue would allow it; no debt and shared-dust debt read as healthy; the offered cap is min(shared 50 %, venue); the rung drops match the facts file) |
| Solana, localnet | `cd solana && bash scripts/localnet.sh` (terminal 1) · `anchor test --skip-local-validator` (terminal 2) | **26 passing / 0 failing** (2026-09-12, 24 s; Solana 4.2.2 / Anchor 1.2.0, the cloned ZCASH market with the Scope mock; build the agent first, `npm run build -w @zyo/agent`): `keeper.spec.ts` 5 — the keeper AGENT (the real reader, dispatcher and monitor from `@zyo/agent`, `runSolanaKeeper` in-process with `maxTicks`, a throwaway keeper key under `fixtures/`): tick 1 discovers the Account by program-account scan and values it from one simulated refresh at HF 1.63, fires nothing, records the owner and the base58 codec; price −20 % (HF 1.30) crosses repay and the keeper plans repay-only from the Account's idle USDC (294.19 USDC, expected HF 1.4070), signs, sends, confirms — the grant's `repayUsdcSpent` equals the USDC that left the Account, the keeper's own USDC did not move, the store's CONFIRMED record carries the signature; the next tick at the same price fires nothing; price −34 % (HF 1.16) with the idle USDC transferred out crosses de-risk and the keeper pays USDC in at the Scope price, the program repays and releases ZEC inside Kamino's 40 % cap, the keeper collects exactly the ZEC delegated (every USDC paid went to the debt, nothing left delegated, `sellZecSpent` equals the ZEC collected); observe-only on a fresh store records the next fall and REFUSES by name, nothing signed; `ladder.spec.ts` 6 — warn is notify-only and a healthy account refuses repay by name; a stranger with no grant is refused; price −20 % (HF 1.30) crosses repay: naming de-risk is refused, a 10 USDC action is refused as ineffective, 400 USDC of the Account's idle USDC lifts HF to the disarm level and the grant's spend records it; price −34 % (HF 1.17) crosses de-risk: naming repay is refused as understated, a sale paying less than the Scope floor is refused, then the keeper pays 1,500 USDC in, the program repays it, releases 1 ZEC and delegates exactly that — the keeper pulls it and cannot pull one unit more; a repay above the period's remaining budget is refused; after revoke_all the keeper is refused by name; `localnet.spec.ts` 4 — the world and both mint fixtures; `owner-path.spec.ts` 11 — init_account creates the Account PDA, both ATAs and a Kamino obligation OWNED BY THE ACCOUNT; deposit reaches Kamino; a 45 % borrow is refused (Kamino's 40 % cap binds first, our 1.55 floor behind it); the top-preset borrow lands at HF 1.625; an over-withdraw is refused; close_position refuses when the Account is short; repay half then all; withdraw all (klend closes the emptied obligation, proven); transfer_out, and a stranger cannot; grant shape / slippage cap / revoke twice / revoke_all; a second cycle re-creates the obligation on deposit and close_position repays and withdraws in one instruction |
| Keeper | `npm test -w @zyo/agent` | tsc + its own `verify-abi` **113/113** (2026-09-12 A4.1: +`StrategyRouter.entryHfWad(address)` and the `EntryHfRecorded` event, the record the keeper's ladder derives from; NI-HIGH-1 follow-up: +`StrategyRouter.DustLegKept`, read by `summarizeUnwinds` into `dustKept` and named in a CONFIRMED receipt's note, 111/111; +1 `dispatcher.test.ts` — 264 tests / 51 suites then) + `verify-solana-idl` **77/77** (2026-09-12 Solana S4: the hand-written Solana layouts pinned to `solana/idl/oilskin.json` — instruction and account discriminators, `keeper_protect`'s account order, writable/signer flags and 25-byte data, `UserAccount` 154 / `Grant` 165 bytes derived from the IDL's field types, the 25 program error codes, klend's discriminators recomputed from their names) (2026-09-11 W3-LOW-1: +`AmbiguousPositionId`; slice G: +`unstakedOverflow`; slice F: the `SlipstreamLpVenue` and `SlipstreamPoolSwapAdapter` fragments, `VenueWithdrawn`, `ownedPool`; 76 before; pins `CollateralRegistry`, `AaveV3Venue`, the `ICollateralVenue` fragments against the interface and `MorphoBlueVenue`, since 2026-09-09 `StrategyRouter.VenueRepaid`, since slice A `SnuggleLpVenue.EngineUnreachable` / `EnumerationAmbiguous` plus the `EnumerationFault` enum members against the Solidity source, and since slice C `LoanDust.UNITS` against shared `LOAN_DUST_UNITS`) + **269 tests / 52 suites** (2026-09-12 A4.1, the ladder is the account's: +3 `healthMonitor.test.ts` — an account the router recorded at 1.30 runs 1.27 / 1.19 / 1.11 / 1.05: 1.28 fires nothing while a record-less account at 1.49 warns on the floor's ladder, 1.26 warns with disarm 1.30 on the record and 1.18 repays with 1.22, bouncing between the trigger and the disarm fires nothing, 1.23 re-arms repay inside the same episode, and the entry HF and the disarm survive a reopen; a failed router read keeps the last recorded value and a router reading 0 afterwards returns the account to the floor's ladder, said in the log and the store; a record under 1.10 runs the floor's ladder at error naming the registry floor, and no router at all means the floor's ladder with no read attempted; +1 `keeperStore.test.ts` — `entryHf` and `disarmHf` persist across reopen, `null` is the stated no-record, a string or a non-positive value is refused on load; +1 `dispatcher.test.ts` — a resumed record is judged against the disarm it carries (SUPERSEDED at HF 1.38 ≥ 1.22, nothing sent) while a record without one is judged against the floor's 1.40 and acts, and an unknown rung is REFUSED by name; Solana S4: +21 in three files — `solana-layouts.test.ts` 8: the mainnet fixture at slot 446,506,191 decodes to the facts file's numbers, PDAs and encoders, base58 of the discriminator for memcmp, valuation from cached bytes is UNKNOWN by name; `solana-policy.test.ts` 5: repay-only from idle USDC, the sale sized to the disarm level AND Kamino's cap at fair value, idle first then the keeper's with a discount inside the allowance, budget clamps named and short capital refused, refusals by name; `solana-monitor.test.ts` 8: discovery and a healthy position, NO_DEBT at the dust line, the ladder with the idempotency record on disk before dispatch and re-arm / episode end, an aborted tick writes nothing, UNKNOWN streaks escalate then reset, a permanent refusal is REFUSED then ABANDONED not retried while a transient FAILED is retried under one key then ABANDONED, SENT persisted before broadcast then confirmed on resume, observe-only LOGGED_ONLY → NOTIFIED and REFUSED by name; 2026-09-11 slice F: +4 `dispatcher.test.ts` — `VenueWithdrawn` summarised, both venues' `positionsOf` read and one unwind planned per pool, a router without a direct venue sees only the engine's ids, the direct venue's `PositionsUnreadable` is REFUSED by name; +1 `healthMonitor.test.ts` — a CONFIRMED-with-shortfall repay tells the owner once, re-arms, and the re-armed retry's SUPERSEDED is bookkeeping; 2026-09-10: slice C +3 — a one-unit USDC residual is NO_DEBT on the pool (`valuation.test.ts`, with the never-NO_DEBT and poison properties scoped to debts above the threshold) and on a venue (`venueReader.test.ts`), and a rounding unit appearing on another book between dispatch and confirm is not an untouched debt (`dispatcher.test.ts`); slice A +1 in `dispatcher.test.ts` — a refused `positionsOf` is REFUSED with the fault named, never planned as "no positions"; slice 4 residual (b) +3 in `venueReader.test.ts`; slice 5 per-venue snapshot +5 in `dispatcher.test.ts`, +1 in `keeperStore.test.ts`; slice 6 chain tables +3 in `config.test.ts` — 84532 resolves the Sepolia table, a missing double is refused by variable name, 8453 unchanged) (~30 s; 2026-09-09: +6 `dispatcher.test.ts` "RISKS §8 residual (a)" on top of the venue-aware reader's +23 `venueReader.test.ts`, `venueGuard.test.ts` 6 → 8) |
| Yield | `npm test -w @zyo/yield` | tsc + **149 tests** (21 files; 2026-09-12 A4.4: +2 `entry-floor.test.ts` — `RegistrySource` is one `eth_call` to `entryHfFloorWad()` (selector `0xe2baeb4e`, the ABI bundle's) truncated to four decimals, and a zero, short, sub-1 or failed read throws by name; +1 `forecast.test.ts` — with a registry at 1.25 the route serves `entryHfFloor` 1.25 with `entryHfFloorSource: "registry"` and its read time, 1.30 on cbBTC is allowed and 1.20 refused by name, the default `entryHf` is the served floor, and a read that fails past `staleAfterMs` returns the shared constant (said, the last read time kept, 1.30 refused again — fail closed on the higher floor); `config.test.ts` covers `COLLATERAL_REGISTRY_ADDRESS` (optional, lower-cased, refused when not an address); the two "until A4" tripwires reworded; A3: +11 `forecast.test.ts` — the HF identity at 1.55 / 1.30 / 1.25 and Kamino's 1.625, Aave's curve reproducing the live 4.5146 % at block 51,227,701 and kinking at 90 %, a cell the gate refuses `net_below_borrow` priced by the forecast with both forms and the gap, a cell refused BEFORE pricing priced anyway, a gauge paying nothing priced as the drag alone, a σ-less cell unpriced by name and still allowed, the nine safety refusals by name, the post-borrow rate and liquidation price with a deposit size, the slider's ends, `/v1/forecast` filtering / 400s / 200-with-refusals when rates are absent or stale; +1 `aave.test.ts` — the strategy address and curve read strictly, a mute strategy fails the whole sample; +3 `demo-forecast.test.ts` — `samples/demo-forecast.json` is `evaluateForecast()` cell for cell, 27 priced / 54 allowed / 0 beat the borrow, the web mirror byte-identical; 131 before — 17 files; RPC mocked at the JSON-RPC boundary with recorded chain words; re-measured 2026-09-12 on the regenerated model: `model-pin`, `demo-gate` and `gate-guard` now pin `lp-model-2026-09-12.json` and `gauge-emissions-2026-09-12.json`, take the borrow / supply / LT they compare against from the model file, derive the lapsed-gauge list from the sample's own words, and pin the closed form's ONE tolerance breach by name — `aero-weth-cbbtc/working`, +5.46 pt against a ±4.43 cap — instead of asserting every row inside tolerance; `RISKS.md` §14) |
| Web, unit | `npm test -w @zyo/web` | **180 tests, 179 passed, 1 skipped** (19 files; 2026-09-12 A4.2, the risk slider: `wizard.test.ts` rebuilt around `hfBoundsFor` — the slider's stop is the smallest of the floor, Aave's max LTV and Oilskin's 50 % cap, named (the cap binds on both Base assets today at 1.56 / 1.66, and still at a 1.25 floor; a 60 % threshold makes the floor bind; Aave's LTV binds when smallest; LTV→0, frozen and unlisted offer nothing), the identity both ways to the cent, the clamp, the sub-mark acknowledgment naming HF, drawdown and first/last rung without a banned word, and `deriveReview` flagging an HF under the offered minimum, borrow nothing, and the un-ticked acknowledgment while a ticked 1.30 at a 1.25 floor derives 1.27 / 1.19 / 1.11 / 1.05; `math.test.ts` — `planLoan` over an entry HF (1.95 borrows exactly the old 40 % figure, ladder `ladderFor(1.95)` = 1.86 / 1.61 / 1.34 / 1.09 with hysteresis 0.09, the floor's HF gives `HF_LADDER`, +∞ is no debt, sub-1 and NaN refused) and `hfBand` on a position's ladder; `notify.test.ts` +1 and `reads.test.ts` +1 — the router's entry-HF record read as recorded / none / unreadable and the deployment's floor read (refused when unreadable); A3: +5 `forecast.test.ts` — the demo forecast's 81 / 27 / 54 / 0 and the best cell's numbers, user net at the chosen LTV reproducing the model's ladder, `entryFromCell`'s informational `qualifies` / `reason`, the words covering the service's unions and the acknowledgment naming the position's numbers, `normalizeForecast` re-deriving `allowed` from the refusal list; +1 `wizard.test.ts` — the acknowledgment starts un-ticked and the liquidity hard-refusal names the pool's balance for hold and spot, a snapshot without the field cannot refuse, a cell's safety refusal is a problem while its profitability never is; `model-numbers` and `execute` now assert the least-bad cell is recommended as a loss rather than refused; 171 before — 18 files; 2026-09-12 ledger re-read: the market snapshot is block 51,226,072 — the same block and the same digits as the gate — and `reads.test.ts`'s fake account, the W3-MED-1 price check and the wizard's carry derive from `DEMO_MARKET` instead of typing 79,630.89 / 4.828 / 0.012, while `model-numbers` and `snapshot` pin the two reads as equal; slice K: every literal model pin moved to the 2026-09-12 cells — best cell cbBTC/USDC sheltered lpNet −10.92 / mcLpNet −10.89 / break-even 4.56× / user net −4.62 / −6.16 / −7.71, WETH/USDC sheltered refused before pricing, the cbZEC pool refused below the borrow (its gauge is voted) — the demo gate's borrow and supply may differ from the 2026-09-05 market snapshot's ONLY as the fresher dated read (`snapshot.test.ts`, `model-numbers.test.ts`), the app's three-decimal rendering is compared at that precision, and the demo keeper grant is sized by `grantTokenLimits`; slice J: +4 `sepolia-deployment.test.ts` — the `DEPLOYMENTS.md` parser that gates the Sepolia rehearsal suite: the committed template yields no addresses (skip by name), a filled table yields the four addresses and the block, one missing double or a `pending` router is null, a missing file or section is null; slice I: with `services/yield/samples/MODEL-NUMBERS.md` copied to `/tmp/build/` — which the CI web job now does — the demo-gate pin RUNS instead of skipping "not published yet"; the one remaining skip is the `/tmp/fix2/MODEL-NUMBERS-v2.md` handover doc; 165 + 2 before; 2026-09-11 wave-3 Lows: +1 `plan` and +1 `reads` (W3-LOW-5, the penalty window), +1 `gate` (W3-LOW-3, `gateForDeployment`), +1 `plan` (W3-LOW-4, the cross-check sentence); slice G: +2 `execute` — W3-MED-1, a pool token Aave does not list is refused without a pool price and sized from the pool's own price with one, `poolImpliedUsdPrices` reads slot0 and the token order; slice F: +4 `plan` — the two-place Close wording and its unchanged encoding, a Close on a direct position, a claim targeting the direct venue (refused by name without one), an open on a direct pool encoding the padded pool address; +1 `reads` — `LP_VENUE_DIRECT` read as null, zero or an address; `abi` now pins the two new contracts; slice E: +2 `b20` — the probe reads `multiplier()` and simulates `transfer(from, 0)` FROM the user's address, a refused simulation is blocked with its reason, an RPC failure and a missing wallet are unknown and never clear; slice C: +1 `reads` — a one-unit residual on the pool and on every venue reads HF ∞ on both legs and `debtIsDust`, the tile's decision, never a zero; slice A: +1 `reads` — a refused `positionsOf` is `lpUnreadable` with the fault named, never an empty list; slice 6: +4 `chain` tests — the default build is the mainnet tables, 84532 resolves Sepolia, a missing double and an unknown chain fail by name; the two skips predate the wave-2 round; 2026-09-09: +6 venue-aware `reads` tests; 2026-09-10 slice 4: +3 residual (b) `reads` tests and +1 `plan` test — a venue whose price is disputed is unreadable and its Close is refused); the ABI-drift test and both model-number pins *ran* |
| Web, e2e | `cd web && npx playwright test` (Playwright's own Chromium; `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` was a container path). **If anything else is listening on :3111** the config's `reuseExistingServer` runs the suite against it — start your own `NEXT_PUBLIC_FORCE_DEMO=1 NEXT_PUBLIC_E2E_MOCK_WALLET=1 npx next dev -p 3112` and run with `E2E_BASE_URL=http://127.0.0.1:3112` (A3 found a stray server serving live prices) | **14 passed / 0 failed / 6 skipped** on 2026-09-12 (A4.2: the SIMPLE scenario drives the slider both ways — the offered minimum 1.56 on cbBTC with the 50 % cap named and both marks disabled with the reason, a typed HF of 1.95 borrowing 15,428.17 at 40.0 % LTV, a typed borrow of 12,000 reading back HF 2.51, a typed 30,000 pulled back to the cap's 19,285.21, and the ladder of THAT entry HF (warn 1.86, emergency 1.09) on the Setting step, the review and the dashboard, whose ladder line says it derives from the recorded 1.95; the landing page shows the lowest HF per asset with the binding cap; A3: the SIMPLE scenario now walks the forecast — every pool a card, the least-bad named as a loss, hold picked — and the acknowledgment on Review holds Continue until ticked and names the borrow cost and the drawdown; the ADVANCED scenario asserts 24 cards with both models' numbers and the gap and no empty-menu banner; the overflow sweep ticks the acknowledgment on Review; the review's disclosure list carries "No cbZEC lending market on Base" and "The yield forecast is a model"), and before that re-run on the 2026-09-12 demo gate and again after the ledger re-read (the wizard borrows 15,428.17 USDC against 0.5 cbBTC at 77,140.83; the demo spot quote shows 7,714 for 0.1 cbBTC) (7 demo scenarios × desktop-1360 / phone-390, zero console errors asserted; the 6 skips are the Sepolia suite below, by name, because the default config's `testDir` includes it). **The dashboard scenario had been red since 2026-09-08 and nobody had run the suite** (the row read "12 passed" from 2026-09-06): the demo keeper grant carried USDC / cbBTC / AERO lines and the wave-2 G-HIGH-1 pool-token check the panel gained that day reported "no WETH budget" for the demo's WETH/USDC position. Slice K sizes the demo grant with the wizard's own `grantTokenLimits` (`web/lib/demo.ts`) — the same three lines to the unit, plus the WETH leg — so nothing there is typed any more. Slice K also moved the model literals (4.52 % borrow, LP net −10.92 %, MC net −10.89 %, 4.56×, emissions sampled 2026-09-12 19:31Z) and fixed one sentence: the advanced wizard's "No pool clears the gate … at today's X % borrow rate" printed the market snapshot's 4.83 % while describing a verdict computed at the gate's 4.52 % — it now quotes the gate's rate (`StrategyStep.tsx`) |
| Web, e2e against Base Sepolia | `cd web && npx playwright test -c playwright.sepolia.config.ts` | **3 skipped, by name** on 2026-09-12 (slice J) — "docs/DEPLOYMENTS.md has no Base Sepolia addresses yet — deploy (DEPLOY-SEPOLIA.md §4), fill the table, then this suite runs". `web/e2e/sepolia.spec.ts` reads the four addresses from `DEPLOYMENTS.md` (`e2e/sepolia-deployment.ts`), starts `next dev` on 84532 with them and, against the LIVE testnet with no wallet and no yield service, checks that the build is not the demo snapshot, that the onboarding pins the cbZEC DOUBLE and links it on sepolia.basescan.org, that spot says CoW is Base mainnet only naming chain 84532, and that the dashboard asks for a wallet — zero console errors apart from the absent yield service. The CI `prototypes` job runs it (skipping by name today; a real run the day the table is filled) |
| Prototypes | `mkdir -p /tmp/build && cp services/yield/samples/MODEL-NUMBERS.md /tmp/build/ && CHROMIUM_PATH="$(node -e "console.log(require('playwright').chromium.executablePath())")" node prototype/test/run-all.mjs` | **verify-simple 130 · verify-advanced 116 · verify-toggle 62 · fuzz 6** (2026-09-12 A4.3, the slider in both builds: the pinned block carries `ladderFor` / `ladOf` / `offeredBounds` / `entryHfAtLtv` / `ltvForHf` / `hfForBorrow` / `clampHf` mirroring shared, byte-equal in both pages and diffed against the built package — toggle +5: the six new shared keys byte-equal, `ladderFor` rung for rung with shared at 1.55 / 1.3 / 1.25 / 1.625 / 1.95 / 2.6, `ladOf`'s fallback rule, `offeredBounds` and `entryHfAtLtv` against shared for both assets, the identity both ways and the clamp; simple +4: the slider's stop per asset with the cap named, the ladder derived from the entry, a typed HF driving the borrow and the ladder in the hint, a typed borrow driving the HF back with the clamp, the sub-mark acknowledgment unreachable on Base today; the flow now opens at the default (the Sheltered mark pulled up to 1.56), the position records its entry HF as the router would and its ladder is 1.51 / 1.36 / 1.20 / 1.05, the partial unwind lifts HF to the de-risk rung's re-arm level (1.25), the keyboard test drives the collateral radiogroup; advanced +2: the marks disabled on WETH with the reason, the slider's range and stop, the default 1.66 with its ladder in the chip, the reducer pulling 1.2 up and taking a typed borrow, the hold checks at an explicit 2.7666 (30.00 %), and the account-level ladder derived from the recorded entry with price factors chained from each rung's action — the withdrawal tests leave the account under the derived warn rung, so a recovery re-arms it first; fuzz: `setHf` / `setBorrow` and `wiz hf` / `borrow` / `hfAck` actions, the invariants on the derived ladder and on the HF ↔ LTV identity; A3: both builds carry `forecast()` beside the unchanged `gate()` in the pinned block — simple +8 checks: WETH/USDC sheltered, which the gate stops at `emissions_below_borrow`, is priced by the forecast on both forms with a user-net ladder; a σ-less pool is unpriced by name and still allowed, a lapsed gauge reads gross 0, a guardian pause is the only refusal; the best cell is a loss on both forms and allowed; no card is greyed out at today's numbers and every card carries its sentence; the default pool is the best forecast; the CTA is NOT blocked by the forecast; the acknowledgment holds Sign in wallet, names the forecast / borrow / drawdown, is refused by the reducer when un-ticked and resets on a setting change; a top-up into a below-the-borrow pool is allowed while a paused collateral still blocks it by name — advanced +5: 0 of 9 beat the borrow while every one can be opened with the best pre-selected and Continue on, no row aria-disabled and the σ-less rows say "no forecast", a paused collateral greys every row and blocks Continue, the HOLD and LP acknowledgments name their numbers and hold Confirm; toggle +1: of the cells the gate stops at, every one with a σ is priced by `forecast()` on both forms and the rest unpriced by name, all allowed, and the 27-cell forecast agrees between the builds; fuzz: the forecast invariants — refuses only for the safety list, prices every σ cell with a trustworthy reading, `both` means both forms above the borrow, the gate's `ok` reads as beating the borrow, always a sentence — plus `ack` actions on the simple reducer; the suites' direct flow dispatches tick the acknowledgment first, as a user would; before A3: **verify-simple 118 · verify-advanced 109 · verify-toggle 56 · fuzz 6** (3 seeds × 5,000 actions × 2 builds = 30,000 reducer actions, 0 invariant violations), re-run after the 2026-09-12 ledger re-read (the facts checks derive every literal from `OIL_CHAIN_READ`; the simple page's disagreement-band lever is ×12.2 at the 4.5174 % borrow — ×12.33 was its 4.828 % value — and the advanced page's ×8.67 still sits inside its band) and on 2026-09-12 after slice K re-pinned both pages' `OIL_MODEL` block from `lp-model-2026-09-12.json` with the new `prototype/scripts/gen-oil-model.mjs` (the block was hand-edited before; the generator preserves every hand-written field and takes every number from the model). The suites' model checks now derive their expectations from the pinned block — the borrow the model ran at (`OIL_MODEL.borrowPctAtGeneration`, 4.5174 %), the count of priced cells, the boundary refusals, the worst optimism — instead of literals, and the tester's-kit levers moved with the model: ×5 opens cbBTC/USDC (the smallest whole multiple above its 4.56× break-even), ×12.33 (simple, WETH/USDC) and ×8.67 (advanced, WETH/cbBTC at ±0.75 %) sit inside the band where the two forms disagree at the pages' chain-read borrow. The pages' chain-read block (prices, rates, LT) is still the dated 2026-09-05 ledger read; at that 4.828 % borrow even cbBTC/USDC sheltered is refused before pricing (net emissions 4.70 %), so the hero shows a dash, which the sign-discipline check now accepts for a cell refused before pricing. Run on 2026-09-12 with Playwright 1.56.1's own Chromium (the `/opt/pw-browsers/chromium` path was a container's; `playwright.chromium.executablePath()` is what CI and the Mac use). Two things were broken and are fixed in slice I: `verify-toggle` had died on its first shared check since 2026-09-07 — `JSON.stringify` throws on the `bigint` `MORPHO_BLUE.lltvWad` that `@zyo/shared` gained that day — so its deep-equal is now bigint-safe, and once it ran it found the pages' `MORPHO_BLUE` block still at `marketIds: {}`; both pages now carry the two verified market ids and the LLTV word. With `/tmp/build/MODEL-NUMBERS.md` present the model pin **runs** (it used to report "skipped — file absent") |

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

## Keeper (`agent/test`, 24 test files)

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
| `agent` | `VERIFY_ABI_STRICT=1 npm test -w @zyo/agent`, `npm test -w @zyo/yield`, on the artifacts | keeper 110/110 strict + IDL seam 77/77 + 263 tests; yield 131 |
| `shared` | `npm test -w @zyo/shared` | 75 |
| `web` | `npm run typecheck -w @zyo/web`, `VERIFY_ABI_STRICT=1 npm test -w @zyo/web` | tsc clean; 167 tests, the ABI-drift test and both model pins RUN |
| `prototypes` | Playwright's Chromium (`playwright install --with-deps chromium`), `services/yield/samples/MODEL-NUMBERS.md` copied to `/tmp/build/` so `verify-toggle`'s model pin runs | 118 · 109 · 56 · 6 |
| `fork` | `forge test --match-path test/fork/BaseFork.t.sol -vv` at `FORK_BLOCK` (pinned in the workflow's `env`: 51,222,568) with `secrets.BASE_RPC_URL` as `FORK_URL`, then `scripts/check-cbzec-b20.sh` at the same block; the log is uploaded | the 11 fork tests and the B20 read. **Without the secret the job FAILS and its own summary line reads `fork: 11 skipped = NOT VERIFIED`** — the green check over eleven skipped tests is what this slice removed. With the secret, a skip (an engine entry the suite selects by property has vanished) also fails, by name. An RPC that no longer serves state at the pinned block fails with the RPC's error: move `FORK_BLOCK` forward deliberately, re-run, record the block |
| `static-analysis` | Slither (`--fail-high`), Aderyn, halmos — the halmos steps under `FOUNDRY_PROFILE=halmos` (`test = "test/halmos"`, so forge compiles src + the two harnesses, and `dynamic_test_linking = false`, because halmos has no `deployCode` cheat) | fails on a High or a violated account property (`AccountGrantHalmos` 4 / 4 locally, 2026-09-12); the router property is `continue-on-error` |
| `solana-seam` | `npm test -w @zyo/solana` | 7 |

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

`nightly-invariants.yml` (03:17 UTC daily, and `workflow_dispatch`) runs the
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
taken from `getBlockTime`, never `Date.now()`. **Observed once, not explained:** on the first of three runs
the `owner-path.spec.ts` transactions all landed (the later refusal tests that depend on them passed) but
every confirmation timed out at 30 s (`TransactionExpiredTimeoutError`, Anchor's legacy websocket
confirmation); the validator was healthy and advancing, a websocket probe afterwards subscribed and confirmed
in 300 ms, and the two following runs passed 26/26 in 24 s. If it recurs, restart the validator and rerun
before reading it as a code fault.

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
