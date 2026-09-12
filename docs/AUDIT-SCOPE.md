# Audit scope — Base module v1 (tree of 2026-09-06)

What an auditor is asked to read, what it must guarantee, and what we have
not verified ourselves. Line counts are `wc -l` on this tree. The ABI seam
(selectors, errors, events) is `CONTRACT-ABI.md` and the generated
`contracts/abi/oilskin-abi.json` (420 entries across 19 contracts as of 2026-09-11); read the code, not the tables.
Wave 3 of the internal audit (slice F's surface and what wave 2 left) and its fix round are in
`AUDIT-2026-09-11.md`.
Wave 1 of the internal audit and the fix round it produced are in
`AUDIT-2026-09-06.md`.

Abbreviations: ABI = application binary interface; EVM = Ethereum Virtual
Machine; HF = health factor; LT = liquidation threshold; LTV = loan-to-value;
LP = liquidity provision; TWAP = time-weighted average price; RPC = remote
procedure call; EIP = Ethereum Improvement Proposal; MC = Monte Carlo.

## In scope — on chain (`contracts/src`, 5,773 lines on 2026-09-11, solc 0.8.24, via-IR, EVM cancun)

| Contract | Lines | Role | Owner / admin |
|---|---|---|---|
| `account/OilskinAccount.sol` | 642 | The user's account: `exec` (plain) / `execWithCallback` / `execBatch` (owner), `execAsKeeper` (grant-checked), `execFromPeripheral` / `execNestedPeripheral` (active peripheral only, depth ≤ 8), `execBatchFromFactory` (factory only), grants and budgets in transient-storage context | none; `owner` immutable after `initialize` |
| `account/OilskinAccountFactory.sol` | 81 | CREATE2 clones, `accountOf`, `createAccount`, idempotent `createAccountAndExec` | none |
| `account/Peripheral.sol` | 61 | Base for venues / router: `_exec`, `_execMany`, `_approveCallReset`; documents that a stateful peripheral must carry its own reentrancy guard | — |
| `router/StrategyRouter.sol` | 755 | `openLeveragedLp`, `openBorrowOnly`, `unwind`, `sweep`; stateless; asserts its balance of every token it touches is **unchanged** (a delta, not a zero). Since 2026-09-11: two LP venues (engine first, then direct — by pool id on open, by `ownedPool` on unwind) and the withdraw leg visiting every venue holding the account's collateral, one `VenueWithdrawn` each | none |
| `venues/SlipstreamLpVenue.sol` | 833 | `ILpVenue` directly over the cbZEC/USDC pool's second-deployment position manager and gauge (2026-09-11): to-ratio swap through the pool under a band-derived floor, centred two-sided mint, gauge stake when alive, fee once per distinct token on what `claim` / `close` collect, enumeration = gauge `stakedValues` + NPM enumerable filtered by pool, fails closed by name | none; `performanceBps`, `treasury` immutable; constructor cross-checks pool ↔ NPM ↔ gauge ↔ adapter |
| `swap/SlipstreamPoolSwapAdapter.sol` | 190 | `ISwapAdapter` over one pool's own `swap` with `uniswapV3SwapCallback` paying the pool from the account (2026-09-11): floor on the account's balance delta, partial fill refused, callback only from the bound pool while a swap is in flight, once | none |
| `interfaces/ISlipstream.sol` + `libraries/LiquidityAmounts.sol` | 166 + 97 | the second deployment's NPM / gauge / pool / Voter subsets, every signature from the verified sources (Addendum 9); vendored Uniswap-lineage liquidity math | — |
| `venues/AaveV3Venue.sol` | 189 | `ICollateralVenue` over Aave v3; provider-resolved addresses; LT / LTV read at call time; **enforces the registry's offer on `supply` and the entry HF floor on `borrow`** | none |
| `venues/SnuggleLpVenue.sol` | 757 | `ILpVenue` over the Snuggle engine; single fee chokepoint (once per distinct token); price band with a bounded width; width bounds; enumeration that accepts a terminal revert only when gas, shape, consistency and ownership agree; refund folding; stale ids reported at any index; `ownedPool` (2026-09-11) | none; `performanceBps`, `treasury` immutable |
| `venues/MorphoBlueVenue.sol` | ~330 | `ICollateralVenue` over the two verified Base Morpho markets; entry floor + registry gate in the venue; per-market isolation (worst-market HF, headroom borrow, worst-first repay); `libraries/MorphoMath.sol` reproduces Morpho's share/interest arithmetic. Deployed but not the registry's venue until propose → timelock → accept | `CollateralVenues.t.sol` (MorphoBlueVenueTest), `audit-regressions/MorphoEntryFloor.t.sol` |
| `registry/CollateralRegistry.sol` | 257 | Asset → venue / enabled / note; `maxOfferedLtvBps` derived from LT **and** LTV; `entryHfFloorWad` in (1, 10]; **venue replacement behind an immutable timelock** with propose / accept / cancel and a `pendingVenue` view | `Ownable2Step` — the only owned contract |
| `swap/AerodromeSwapAdapter.sol` | 111 | One Slipstream `exactInputSingle`, recipient = account; floor derived from a caller quote with an on-chain 500 bps cap; `minOutFor` view | none |
| `oracle/PythOracleAdapter.sol` | 181 | v1.1 Morpho `IOracle` with permissionless Pyth refresh, `maxAge`, `PegBreak` vs pool TWAP (the same-transaction gate was removed in the wave-2 fix round, P-MED-1) — **built, not deployed, not used** | none |
| `libraries/TickMath.sol` | 48 | Vendored tick → sqrt-price | — |
| `interfaces/*.sol` | 729 | `IOilskinAccount`, `ICollateralRegistry` (new), `ICollateralVenue`, `ILpVenue`, `ISwapAdapter`, `IAaveV3`, `ISnuggleVault` (verified 2026-09-03 shape), `IAerodromeCLPool`, `IAerodromeSwapRouter`, `IMorphoBlue`, `IPermit2`, `IPyth` | — |
| `script/Deploy.s.sol` | 266 | `BaseAddresses` (from `VERIFIED-BASE-FACTS.md` only), env-driven config, mainnet guard, registry → venue deploy order, 2-day default venue timelock, two-step registry handover | — |

Dependencies compiled in: OpenZeppelin v5.7.0 (`Clones`, `Ownable2Step`,
`IERC20*`, receivers, `Math`), forge-std v1.16.2 (tests only).

## In scope — off chain

| Area | Lines | Safety-critical paths |
|---|---|---|
| `agent/src` | 5,558 | `engine/valuation.ts` (fail-closed HF), `engine/feeds.ts` (per-feed measured staleness + startup self-check), `engine/ladder.ts` (hysteresis / re-arm), `dispatch/policy.ts` (one root `unwind` per pool; value-sized selection), `dispatch/quote.ts` (pool-derived swap quote), `dispatch/keeperDispatcher.ts` (grant read → simulate → persist → send → confirm), `monitors/healthMonitor.ts` (bounded dispatch, quarantine, rung re-arm), `store/keeperStore.ts` (verified atomic writes, heartbeat lock, tamper, `.bak`), `notify/notifier.ts`, `log.ts` (redaction), `config.ts` |
| `web/lib` (+ `app/`, `components/`) | 7,319 excl. the 3,524-line generated ABI | `plan.ts` (the calls users sign, and the `callback` flags), `quote.ts` (the swap quote and its oracle cross-check), `execute.ts` (guarded writes, band quoting, grant sizing), `keeper.ts` (grant status incl. `cannot-act`), `gate.ts` / `math.ts` (the client's two-model re-derivation), `tickmath.ts`, `reads.ts` / `positions.ts` (chain reads incl. `pendingVenue`), `cow.ts` (spot), `onboarding.ts`, `copy.ts` (disclosures + banned words) |
| `services/yield/src` | 4,454 | `sources/aave.ts` (incl. `getPaused`), `sources/gauges.ts` (corroborated anchors, strict decoding), `gate.ts` + `model.ts` + `mc-calibration.ts` (the two-model gate), `bands.ts` (fee on gains only), `server.ts` (503 on stale / degraded) |
| `packages/shared/src` | 1,515 | `base.ts` (addresses), `health.ts`, `collateral.ts`, `fees.ts` (fee on gains only), `width.ts` |

Out of scope: `prototype/` (no money path), `services/yield` backfill /
bands (informational), `contracts/test/mocks` (test doubles).

## Trust model, as it now stands

- **The user owns everything.** `OilskinAccount.owner` is the wallet that
  created it, set once by the factory. Every Aave position (`onBehalfOf` =
  account) and every engine id (minted to the account) belongs to the account.
  `exec` is owner-only with no other gate, and is now a **plain** call: the
  owner can call any target with any calldata and grant it nothing, so no
  Oilskin contract, grant, registry state or keeper can stand between the user
  and their funds (invariant 1 below).
- **Peripheral rights are opt-in, per call, and non-transitive.** A target
  receives the right to call back into the account only when the owner sets
  `Call.callback` (or, on the keeper path, when the owner's grant sets
  `allowCallback` — the keeper cannot). The set of targets that need it is
  enumerable: `StrategyRouter`, `AaveV3Venue`, `SnuggleLpVenue`,
  `AerodromeSwapAdapter`. Nesting is bounded at `MAX_PERIPHERAL_DEPTH = 8`.
  Peripherals hold nothing and own nothing: no storage beyond immutables, no
  owner, no upgrade path, and the router's balance of every token it touches is
  **unchanged** across every call (a delta, so a donation is inert).
- **The keeper is grant-bounded, and its whole surface is one call.** A keeper
  call must match an active grant `(keeper, target, selector)`; the shipped
  grant is `StrategyRouter.unwind` with `allowCallback: true` and nothing else.
  ETH value and every **direct** token operation in the call tree (`transfer`,
  `approve`, `increaseAllowance`, `transferFrom`, Permit2 `approve` / single
  `transferFrom`) is charged against per-token per-period budgets computed from
  **calldata**; an unbudgeted token reverts; five movers the parser cannot read
  are **refused** rather than passed. **What is not bounded**: value moved by a
  protocol the tree talks to (an Aave `withdraw`, an engine withdrawal) — the
  grant's target and the peripherals it nests into are *trusted code*, which is
  why `allowCallback` exists and defaults to false. Budgets are per grant, not
  per account. The owner kills one grant with `revoke` or all with `revokeAll`.
- **The registry owner is an owner.** It can disable any asset **instantly**,
  set the entry HF floor **instantly** within (1, 10], and replace the venue
  contract an asset points at **after an immutable timelock** (2 days as
  deployed) — and the replacement inherits every calling account's peripheral
  rights on every subsequent router call. Propose / accept / cancel each emit,
  and `pendingVenue` is readable, so a watcher can see a change coming; the
  delay is a **warning, not a prohibition**. It cannot directly move funds and
  `unwind` still works on a disabled *asset*. Nothing on chain requires that
  owner to be a multisig. See `RISKS.md` §16 — and do not describe this system
  as having "no operator custody".
- **The fee** is `SnuggleLpVenue.performanceBps` (immutable, ≤
  `MAX_PERFORMANCE_BPS` 2000) on the *gain* collected at `claim` / `close`,
  taken **once per distinct pool token**, paid to the immutable `treasury`;
  principal is withdrawn afterwards and never taxed; a treasury that cannot
  receive skips the fee. Off chain, the same fee is never applied to a loss.
- **Third parties we call and do not control:** Aave v3 (pool, data provider,
  oracle via the provider), the Snuggle engine, Aerodrome pools / gauges /
  Slipstream SwapRouter, Permit2, Pyth (v1.1), CoW settlement (web only),
  Chainlink feeds (keeper valuation and the web's quote cross-check).

## Invariants actually asserted

From `contracts/test/invariant/Invariants.t.sol` — a Handler with **21
actions** (the 16 below plus `switchVenue`, `routerExitProbe`,
`supplyAndBorrowOnCurrentVenue`, `repayAcrossProbe`, `singleCloseProbe`, and
since wave 3 (W3-MED-3) `openDirectLp`, `accrueDirectReward`,
`ownerCloseDirect`, `keeperUnwindDirect` — 25 in all; `donate` now targets
seven peripherals × five tokens) (`supplyAndBorrow`, `openLp`, `accrueYield`, `ownerClaim`,
`ownerCloseOne`, `keeperUnwind`, `keeperAttack`, `rekey`, `toggleAsset`,
`revokeAll`, `regrant`, `warp`, `glitchEnumeration`, `rawExitProbe`,
`ownerExit`, **`donate`**), at the default profile 256 runs × depth 40 per
invariant, and re-run in the fix round at 1,500 × 120 (180,000 calls each,
0 reverts, 0 discards):

1. **The user can always exit via raw `exec`** — under random sequences, a
   glitching engine enumeration, a disabled asset, no grants, and token
   donations to every peripheral (`invariant_userCanAlwaysExitViaExec`,
   snapshot probe).
2. **A keeper never exceeds a grant** — no un-granted call succeeds, budgets
   never overspent, the keeper never ends up holding a token or a position
   (`invariant_keeperNeverExceedsGrant`).
3. **The fee never touches principal** — the treasury never holds more than
   `performanceBps` of the yield the engine actually paid, and never holds any
   collateral (`invariant_feeNeverTouchesPrincipal`).
4. **A peripheral never acquires a balance of its own** — its balance equals
   exactly what the Handler donated to it, for every token × peripheral pair
   (`invariant_peripheralsAcquireNothing`; seven peripherals including
   `SlipstreamLpVenue` and `SlipstreamPoolSwapAdapter`, five tokens including
   cbZEC, since wave 3). This **replaces** the old
   `balanceOf(peripheral) == 0` assertion, which passed only because the
   Handler had no way to send a peripheral a token: it was vacuous while a
   one-wei donation would have bricked the protocol permanently.
5. **Donations do not brick the protocol** — after any sequence containing
   donations, the owner exit probe still succeeds
   (`invariant_donationsDoNotBrickTheProtocol`), with
   `test_handlerPathsAreLive` driving a keeper unwind *after* a 1-wei donation
   so the property is not vacuous either.
6. **No standing allowances** survive a call (`invariant_noStandingAllowances`).
7. **The product's own exit reaches the position after a venue switch**
   (`invariant_userCanAlwaysExitViaRouter`), **the repay reaches every book**
   (`invariant_repayReachesEveryBook`), and since 2026-09-11 **one Close
   clears every book** — a two-book account funded to cover every book strands
   no collateral and the call never reverts (`invariant_singleCloseClearsEveryBook`;
   the one named exception, W3-LOW-1's `AmbiguousPositionId` on an id both LP venues
   claim, the probe resolves the documented way before asking again).

Plus `invariant_callSummary` (coverage reporting only) and
`test_handlerPathsAreLive` (asserts every handler path is reachable, so none of
the above is vacuous).

Unit-level properties (363 passed on 2026-09-11 after wave 3, 12 fuzz tests at 512 runs by
default, 5,000 in the wave-1 fix round): only the factory initialises an account, exactly once; only
the owner can `exec`; a plain call grants nothing and `execFromPeripheral`
refuses a call that asks for rights; reentrancy through every door reverts;
peripheral depth bounded; grants expire, revoke, epoch-bump, period-roll and
carry spend forward on a re-grant; zero/duplicate token lines and a zero
selector refused; every recognised token selector including Permit2's is
charged and the five unparsable movers refused; malformed calldata for a
recognised selector fails closed; `maxOfferedLtvBps = min(LT/floor,
venue.maxLtvBps, 5000)`; `EntryHfTooLow` at the venue on every borrowing path
including a raw batch; `ExitHfTooLow` on the global HF; unwind works on
disabled assets and refuses a disabled venue; a fixed repay against zero debt
is a no-op; the swap floor is relative to the quote, capped at 500 bps, and a
sandwich reverts; venue replacement timelocked, announced, cancellable;
Permit2 wrong-spender / reused-nonce refused; width bounds; band required /
out of range / too wide / unreadable pool; enumeration that accepts the
measured empty end-of-list (or `Panic(0x32)`) only when gas, shape,
consistency and ownership agree, every fault named; a stale first id
reported on `closeMany` / `claim` / `unwind`; degenerate pool refused on entry;
close fee on yield only and once per distinct token; B20 rebase up and down,
blocked account, blocked treasury, paused reward token, blocked swap; Pyth
fresh-without-refresh, stale, one-call bundle, peg break both directions; deploy guard refuses unknown
chain / missing env / no code / Aave provider drift.

## Not verified — say so before anyone relies on it

| Item | State | Where it bites |
|---|---|---|
| **Fork tests against Base** | `contracts/test/fork/BaseFork.t.sol`, 10 tests, `vm.skip` without `FORK_URL` — **run against Base mainnet on 2026-09-10 at block 51,127,409: 4 passed / 4 failed of 8 on the first run, 5 / 3 after slice A, 7 / 2 after slice B, 8 / 1 after slice C, 9 / 1 of 10 after slice D** — the one failure is the cbZEC B20 harness limit (`VERIFIED-BASE-FACTS.md` Addenda 3–6; `TESTING.md`). Reported as SKIPPED without `FORK_URL`, never as passed. | Aave provider resolution, live reserve params, cbZEC B20 shape, the engine's index-getter shape, supply → borrow → repay → withdraw under a real account, open → close on the live engine |
| **The two-book Close** | **Resolved 2026-09-11 (slice F, `RISKS.md` §8 option 1)**: the withdraw leg visits every venue holding the account's collateral, one `VenueWithdrawn` each; `invariant_singleCloseClearsEveryBook` (stranded == 0) replaces the KNOWN-FAILURE invariant; M1m–M1q pin it. Not yet re-measured on the fork (the slice-D gas figures at block 51,127,409 are the estimate: ≈ 362k per extra Aave venue, ≈ 189k per extra Morpho venue). | — |
| **The direct Slipstream venue on the cbZEC pool itself** | The venue is proved on the fork against the same deployment's WETH/USDC ts-10 pool (live NPM and gauge) and against the cbZEC pool's live pointers; the cbZEC pool's own mint, swap and close cannot run in a fork EVM (the B20 precompile, Addendum 3) and were NOT executed anywhere — the mocks carry the verified semantics (Addendum 9). Not read: the gauge factory's early-withdraw penalty for this pool. | the first real cbZEC/USDC open; a fast close's AERO |
| **The engine's single-sided deposit** | **Measured 2026-09-10 (slice B)**: it is NOT swapped to ratio — the verified mint library builds a one-sided range on the deposited token's side of the price, so the product's borrowed-USDC open holds only USDC and earns nothing until the price enters the range (`RISKS.md` §12, `ISnuggleVault` FACT 4 corrected). What the yield model should assume for this shape is not verified and is a product decision (slice E memo). | every leveraged LP open; the yield verdict |
| **The engine's live end-of-list revert shape** | **Recorded 2026-09-10: empty `0x`**, and `positionsOf` redesigned for it the same day (slice A): gas under a measured stipend, canary / end / k + 1 shape agreement, liveness before and after, `positions(id).owner` per id — `EnumerationAmbiguous(fault, …)` otherwise, named by the keeper and the web (`RISKS.md` §12, Addendum 4; fork test green at block 51,127,409). **Still not verifiable on chain:** a getter-less implementation upgrade reads as an empty list for every account; the EIP-1967 slot (`0x359f…2d28`) is the only off-chain guard and is NOT compared by any shipped code — a product decision left open. An isolated failure at the last index is a list one shorter. | `positionsOf`, the dashboard's position list, the keeper's id discovery |
| **Morpho Blue market ids** (cbBTC/USDC, WETH/USDC) | Discovered and chain-verified 2026-09-07, re-read at block 51,003,524 (`VERIFIED-BASE-FACTS.md`, Morpho addendum: both 86 % LLTV, ids recomputed from `idToMarketParams`). **In code**: `Deploy.s.sol` `MORPHO_MARKET_*` constants, shared `MORPHO_BLUE.marketIds`, and `MorphoBlueVenue` re-derives each at construction | venue deployed; registry still on Aave |
| **cbZEC B20 policy** (blocklist, pause) | `owner()` / `paused()` revert on the precompile; `multiplier()` 1e18 on 2026-09-05 and 2026-09-10. **Shipped probe (slice E, 2026-09-10)**: `multiplier()` plus an `eth_call` of a zero-amount self-transfer from the user's address, on the spot page, with the disclosure rewritten to claim exactly that (`RISKS.md` §4). Still not readable: the policy itself, the blocklist as a whole, anything after the read. | cbZEC spot users |
| **The Slipstream SwapRouter and the cbZEC/USDC pool** | **Verified negative (slice E, Addendum 8)**: `0xBE6D…18a5` reverts with no data on USDC → cbZEC at tick spacing 200 and 100 (`eth_call` with balance and allowance overrides; the WETH → USDC control returns a quote), because the pool was created by the second CLFactory `0xf8f2…61Ef` (sanctioned by the FactoryRegistry, its own NPM `0xe1f8…8b53`). `AerodromeSwapAdapter` must not be pointed at that pair; a direct pool-swap path does not exist in this repo. | any cbZEC swap on Oilskin's side (CoW is the only one today) |
| **CoW `vaultRelayer`** | `COW_PROTOCOL.vaultRelayer = null` in shared; the web reads `settlement.vaultRelayer()` live | spot approve target |
| **The live engine's revert shape under `claim` / `closeMany` failure** | **Measured 2026-09-10 (slice B, Addendum 5)** on the live engine at block 51,127,409: `NotPositionOwner()` for a foreign and a never-minted id on `withdraw` / `harvest` / `claimStakingRewards`, `MinimumHoldTimeNotMet()` inside the hold, `NoFeesToHarvest()`, `NoRewardAdapter()`, `UseClaimStakingRewards()`; `closeMany` and `claim` report each and revert on none; the mocks carry the same selectors. Not exercisable on demand: `NotStaked()`, the deposit-side errors and the pause (source-derived). | which ids come back in `failed` |
| **Gauge-emission words** | 2026-08-31 block 50675328, not a fresh read; the MC calibration is derived from those same words | the yield verdict's inputs, not its logic |
| **The emissions anchor across restarts** | Corroboration history is in-process memory; a restart serves nothing for a pool until three refreshes have run | a blind window after every yield-service restart, fail-closed |
| **Static analysis / formal** | See slice H in `CHANGELOG.md` / `AUDIT-2026-09-11.md`: what ran on this Mac, what could not, and the install commands | — |
| **A stranger's tokens and the direct venue's list** | **Fixed 2026-09-11 (wave 3, W3-MED-2)**: the staked list is always whole, unstaked tokens are scanned through a window, `unstakedOverflow` names the rest. Residual: the account's OWN unstaked position (a gauge-dead open, a half-failed `closeMany`) can sit beyond the window while a stranger pads the holdings | keeper protection on a direct-venue account |
| **External audit** | None. Waves 1–3 were internal, with executed proofs of concept for every Medium or worse | everything |

**Resolved since the 2026-09-05 scope** and no longer on this list: the
Aerodrome Slipstream SwapRouter (`0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5`,
code-verified 2026-09-06, factory read back) and Multicall3
(`0xcA11bde05977b3631167028862bE2a173976CA11`, code-verified) are now in
`VERIFIED-BASE-FACTS.md`'s addendum, together with the negative result that the
circulating "UniversalRouter" `0x6Cb442acF35158D5eDa88fe602Ef9Cf89694fFEa`
has **no code on Base**. Also resolved by the fix round, not by verification:
the web ↔ keeper grant seam (one grant, one selector, asserted from the
keeper's own source), the web's `swapMinOut` degradation (the field no longer
exists), and the borrow-and-hold entry floor (enforced at the venue).

## Deployment facts an auditor needs

Nothing is deployed. The addresses the contracts will bind to are in
`CONTRACT-ABI.md` §10 and `script/Deploy.s.sol: BaseAddresses`, every one from
`VERIFIED-BASE-FACTS.md`. Deploy order is **registry → venue → register
assets** (the venue takes the registry at construction); the registry's
venue-replacement timelock is immutable and defaults to 2 days
(`REGISTRY_TIMELOCK_DELAY`); `REGISTRY_OWNER` is required on mainnet and
handed over with `Ownable2Step` (`acceptOwnership` is a separate transaction).
The engine proxy `0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55` and its verified
behaviours are from `AUDIT-FINDINGS-2026-09-03.md` Part 1 (head ≈ block
50,821,540).

## Not in this audit — the Solana module

`solana/` (added 2026-09-12) is a design record and a scaffold with **no
instruction handlers**; nothing in it executes on any chain. When it is built it
gets its own audit by a Solana firm (`SOLANA-ARCHITECTURE.md` §10 names the
candidates and the scope); it does not widen this one. The read-only facts
readers and the ladder seam (`npm test -w @zyo/solana`) are tooling, not
protocol code.
