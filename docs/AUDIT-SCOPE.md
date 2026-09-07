# Audit scope — Base-first v1 (tree of 2026-09-06)

What an auditor is asked to read, what it must guarantee, and what we have
not verified ourselves. Line counts are `wc -l` on this tree. The ABI seam
(selectors, errors, events) is `CONTRACT-ABI.md` and the generated
`contracts/abi/oilskin-abi.json` (303 entries); read the code, not the tables.
Wave 1 of the internal audit and the fix round it produced are in
`AUDIT-2026-09-06.md`.

Abbreviations: ABI = application binary interface; EVM = Ethereum Virtual
Machine; HF = health factor; LT = liquidation threshold; LTV = loan-to-value;
LP = liquidity provision; TWAP = time-weighted average price; RPC = remote
procedure call; EIP = Ethereum Improvement Proposal; MC = Monte Carlo.

## In scope — on chain (`contracts/src`, 3,492 lines, solc 0.8.24, via-IR, EVM cancun)

| Contract | Lines | Role | Owner / admin |
|---|---|---|---|
| `account/OilskinAccount.sol` | 642 | The user's account: `exec` (plain) / `execWithCallback` / `execBatch` (owner), `execAsKeeper` (grant-checked), `execFromPeripheral` / `execNestedPeripheral` (active peripheral only, depth ≤ 8), `execBatchFromFactory` (factory only), grants and budgets in transient-storage context | none; `owner` immutable after `initialize` |
| `account/OilskinAccountFactory.sol` | 81 | CREATE2 clones, `accountOf`, `createAccount`, idempotent `createAccountAndExec` | none |
| `account/Peripheral.sol` | 61 | Base for venues / router: `_exec`, `_execMany`, `_approveCallReset`; documents that a stateful peripheral must carry its own reentrancy guard | — |
| `router/StrategyRouter.sol` | 443 | `openLeveragedLp`, `openBorrowOnly`, `unwind`, `sweep`; stateless; asserts its balance of every token it touches is **unchanged** (a delta, not a zero) | none |
| `venues/AaveV3Venue.sol` | 189 | `ICollateralVenue` over Aave v3; provider-resolved addresses; LT / LTV read at call time; **enforces the registry's offer on `supply` and the entry HF floor on `borrow`** | none |
| `venues/SnuggleLpVenue.sol` | 651 | `ILpVenue` over the Snuggle engine; single fee chokepoint (once per distinct token); price band with a bounded width; width bounds; shape-exact enumeration; refund folding; stale ids reported at any index | none; `performanceBps`, `treasury` immutable |
| `venues/MorphoBlueVenue.sol` | 99 | Skeleton; every call reverts `VenueDisabled`; `enabled() == false` | none |
| `registry/CollateralRegistry.sol` | 257 | Asset → venue / enabled / note; `maxOfferedLtvBps` derived from LT **and** LTV; `entryHfFloorWad` in (1, 10]; **venue replacement behind an immutable timelock** with propose / accept / cancel and a `pendingVenue` view | `Ownable2Step` — the only owned contract |
| `swap/AerodromeSwapAdapter.sol` | 111 | One Slipstream `exactInputSingle`, recipient = account; floor derived from a caller quote with an on-chain 500 bps cap; `minOutFor` view | none |
| `oracle/PythOracleAdapter.sol` | 181 | v1.1 Morpho `IOracle` with same-tx Pyth refresh, `maxAge`, `PegBreak` vs pool TWAP — **built, not deployed, not used** | none |
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

From `contracts/test/invariant/Invariants.t.sol` — a Handler with **16
actions** (`supplyAndBorrow`, `openLp`, `accrueYield`, `ownerClaim`,
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
   (`invariant_peripheralsAcquireNothing`). This **replaces** the old
   `balanceOf(peripheral) == 0` assertion, which passed only because the
   Handler had no way to send a peripheral a token: it was vacuous while a
   one-wei donation would have bricked the protocol permanently.
5. **Donations do not brick the protocol** — after any sequence containing
   donations, the owner exit probe still succeeds
   (`invariant_donationsDoNotBrickTheProtocol`), with
   `test_handlerPathsAreLive` driving a keeper unwind *after* a 1-wei donation
   so the property is not vacuous either.
6. **No standing allowances** survive a call (`invariant_noStandingAllowances`).

Plus `invariant_callSummary` (coverage reporting only) and
`test_handlerPathsAreLive` (asserts every handler path is reachable, so none of
the above is vacuous).

Unit-level properties (244 tests, 11 fuzz tests at 512 runs by default, 5,000
in the fix round): only the factory initialises an account, exactly once; only
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
out of range / too wide / unreadable pool; enumeration shape-exact
(`Panic(0x32)` only) with every other shape failing closed; a stale first id
reported on `closeMany` / `claim` / `unwind`; degenerate pool refused on entry;
close fee on yield only and once per distinct token; B20 rebase up and down,
blocked account, blocked treasury, paused reward token, blocked swap; Pyth
same-tx gate, stale, peg break both directions; deploy guard refuses unknown
chain / missing env / no code / Aave provider drift.

## Not verified — say so before anyone relies on it

| Item | State | Where it bites |
|---|---|---|
| **Fork tests against Base** | `contracts/test/fork/BaseFork.t.sol`, 8 tests, `vm.skip` without `FORK_URL` — **never run from this container** (no RPC). Reported as SKIPPED, never as passed. They were updated for the new constructors and the callback opt-in, so they compile and will run under `FORK_URL`. | Aave provider resolution, live reserve params, cbZEC B20 shape, the engine's index-getter shape, supply → borrow → repay → withdraw under a real account, open → close on the live engine |
| **The engine's live end-of-list revert shape** | `test_fork_engineIndexGetterShape` *logs* it; it has never been recorded. The venue now requires exactly `Panic(0x32)` and fails closed on anything else — if the live engine's shape differs, enumeration fails closed (safe) but `positionsOf` stops working until the constant is confirmed. | `positionsOf`, the dashboard's position list, the keeper's id discovery |
| **Morpho Blue market ids** (cbBTC/USDC, WETH/USDC) | Discovered and chain-verified 2026-09-07 (`VERIFIED-BASE-FACTS.md`, Morpho addendum: both 86 % LLTV, ids recomputed from `idToMarketParams`). Still **not in code**: `MORPHO_BLUE.marketIds = {}` in shared and `MorphoBlueVenue` stays a disabled skeleton until it is built against them | v1.1 only |
| **cbZEC B20 policy** (blocklist, pause) | `owner()` / `paused()` revert on the precompile; `multiplier()` read once = 1e18 (2026-09-05). **No shipped code reads policy state; `web/lib/copy.ts:43` says it does** — open must-fix (`RISKS.md` §4) | cbZEC spot / LP users |
| **CoW `vaultRelayer`** | `COW_PROTOCOL.vaultRelayer = null` in shared; the web reads `settlement.vaultRelayer()` live | spot approve target |
| **The live engine's revert shape under `claim` / `closeMany` failure** | Modelled by mocks; the per-id try/catch behaviour has never been exercised against the live engine | which ids come back in `failed` |
| **Gauge-emission words** | 2026-08-31 block 50675328, not a fresh read; the MC calibration is derived from those same words | the yield verdict's inputs, not its logic |
| **The emissions anchor across restarts** | Corroboration history is in-process memory; a restart serves nothing for a pool until three refreshes have run | a blind window after every yield-service restart, fail-closed |
| **Static analysis / formal** | No Slither, Aderyn, Halmos or Tenderly run recorded | — |
| **External audit** | None. Wave 1 was internal, four lenses, with executed proofs of concept | everything |

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
