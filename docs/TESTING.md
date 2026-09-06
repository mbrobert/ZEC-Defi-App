# Testing — every suite, how to run it, what it proves

Counts are from running each suite on this tree on **2026-09-06**, after the
wave-1 audit fix round — not copied from build reports. Two audiences: the
automated suites, and a person clicking the demo (the tester's kit at the end).

Abbreviations: RPC = remote procedure call (a chain node endpoint); ABI =
application binary interface; HF = health factor; LT = liquidation threshold;
LTV = loan-to-value; LP = liquidity provision; TWAP = time-weighted average
price; EIP = Ethereum Improvement Proposal; CI = continuous integration;
MC = Monte Carlo.

## Summary

| Area | Command | Counted result |
|---|---|---|
| Contracts (Foundry) | `cd contracts && FOUNDRY_PROFILE=local forge test` | **244 passed, 0 failed, 8 skipped** (252 total), 18 suites — 6 invariants (+ a call-summary and a handler-liveness test) at 256 runs × depth 40; 11 fuzz tests × 512 runs |
| Contracts, fork | `FORK_URL=<Base RPC> forge test --match-path test/fork/BaseFork.t.sol -vv` | 8 tests; **skipped without `FORK_URL`** (`vm.skip`), reported as skipped, never as passed. Not run from this container — there is no chain RPC here |
| Root ABI seam | `node scripts/verify-abi.mjs` | **303** selectors / topics / errors across 17 contracts match `contracts/abi/oilskin-abi.json`; `--write` regenerates; exit 1 on drift |
| Shared | `npm test -w @zyo/shared` | **53** (7 files: evm, base, health, collateral, fees, width, pools) |
| Keeper | `npm test -w @zyo/agent` | tsc + its own `verify-abi` **54/54** + **171 tests / 36 suites** (~24 s) |
| Yield | `npm test -w @zyo/yield` | tsc + **131 tests** (17 files; RPC mocked at the JSON-RPC boundary with recorded chain words) |
| Web, unit | `npm test -w @zyo/web` | **125 tests** (14 files); the ABI-drift test and both model-number pins *ran* |
| Web, e2e | `cd web && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test` | **12 passed / 0 failed** (6 scenarios × desktop-1360 / phone-390), zero console errors asserted |
| Prototypes | `CHROMIUM_PATH=/opt/pw-browsers/chromium node prototype/test/run-all.mjs` | **verify-simple 118 · verify-advanced 109 · verify-toggle 56 · fuzz 6** (3 seeds × 5,000 actions × 2 builds = 30,000 reducer actions, 0 invariant violations) |

Prerequisites: Node ≥ 22; `npm install` at the root; `npm run build -w
@zyo/shared` (every consumer imports its `dist/`); Foundry with the two
libraries cloned into `contracts/lib` (`SETUP.md`); Playwright Chromium.
Offline container with a pre-fetched compiler: `FOUNDRY_PROFILE=local`.

**Beyond the default profile**, run in the fix round and reproducible:
`forge test --fuzz-runs 5000` (invariants excluded) → 236 passed / 8 skipped,
0 failed; invariants at `runs=1500 depth=120` → 8 passed, **180,000 calls each,
0 reverts, 0 discards**, spread over the Handler's 16 entry points (the new
`donate` action alone fires ~11,100 times per invariant).

A note on the e2e count: the suite now warms every route in
`e2e/global-setup.ts` before the first assertion. Without that, the first
scenario of a cold `next dev` could miss a 15-second expectation while
`/onboard` compiled — a harness artefact that used to read as flakiness. It is
removed at the source rather than papered over with looser timeouts.

## Contracts — what each suite proves (`contracts/test`)

| File | Tests | Proves |
|---|---|---|
| `Account.t.sol` | 50 | CREATE2 prediction, idempotent `createAccount`, one-transaction `createAccountAndExec` **and its idempotency after a front-run** (`execBatchFromFactory` refuses any caller but the factory and any owner but the real one); owner-only `exec` / `execWithCallback` / `execBatch`; ERC-721/1155 receivers; reentrancy through every door; peripheral callback rights (opt-in per call, active target only, non-transitive, nested delegation restores, depth-bounded); keeper grants: not-granted, expiry, revoke, `NotRevocable`, `revokeAll` epoch, period reset, carry-forward on re-grant, value budget, every recognised token selector incl. Permit2, inner and nested operations charged, malformed calldata fails closed; amount-based budgets vs a rebasing token; 2 fuzz |
| `CollateralVenues.t.sol` | 31 (14 + 14 + 3) | `AaveV3Venue` supply / borrow / repay(all) / withdraw(all) under the account; **`supply` refuses an asset the registry does not offer here**; **`borrow` reverts `EntryHfTooLow`**; live LT / LTV / rate reads follow the venue; allowances reset; keeper repay within budget; `MorphoBlueVenue` disabled everywhere + `marketId`; registry `maxOfferedLtvBps` derived from **both** parameters (an LTV→0 deprecation takes the offer to 0), floor bounds, decimals read from the token, cbZEC disabled with note, **venue replacement timelocked / cancellable / re-checked at acceptance**, the two offer views agree on a disabled asset; 1 fuzz |
| `SnuggleLpVenue.t.sol` | 42 | Single / dual open minted to the account; residual and bounce folding; dust floor per decimals; width [150, 5000] / delay / deadline / zero-amount guards; band required / out of range / `slot0` revert / short return / no-code pool; the C-2 enumeration (empty, grows, prunes, re-key, 25 ids, glitch → `EnumerationFailed`, paused → `EngineUnreachable`, exit never depends on it); close fee on yield only; `harvest` vs `claimStakingRewards`; refused claims skipped; `closeMany` per-id try/catch; **`claim` reports mixed-pool and foreign ids instead of reverting, and carries a deadline**; increase; keeper close within budget; cbZEC rebase / downward rebase / blocked / paused; 2 fuzz |
| `StrategyRouter.t.sol` | 27 (24 + 3 adapter) | Full open with a real EIP-712 Permit2 signature (spender = account); first-time user in one tx; disabled / unregistered asset; pool must contain USDC; deadline / zero borrow; band protects the deposit; open against existing collateral; wrong-spender / reused-nonce permits; full unwind round trip; unwind on a disabled asset; repay-only; exit-HF floor; **the swap floor is relative to the quote and a sandwiched leg reverts instead of settling for dust**; refused ids reported; keeper unwind within a two-token grant; `sweep` to owner only; router refuses EOAs; swap-adapter guards (cap, zero quote, `minOutFor`); 1 fuzz |
| `audit-regressions/RouterDonation.t.sol` | 9 | **The wave-1 Critical, flipped**: a 1-wei donation no longer bricks open or unwind; a collateral-asset donation is inert too; the keeper's protection grant survives the same wei; any donation size is inert (5,000-run fuzz); a router that *gains* a token mid-call still reverts, measured from the entry balance; the exit floor holds when the residual debt is not USDC; a fixed repay against zero debt does not kill the exit; cbZEC stays out even after Aave lists it |
| `audit-regressions/EntryFloor.t.sol` | 10 | The exact three-call hold batch the old UI emitted no longer bypasses the floor; a first-time user cannot open an unprotected position (atomic — the account is not created); price drift between quote and inclusion is caught with no attacker; `openBorrowOnly` carries the same floor; and the documented residual: **raw Aave-pool calls remain the owner's right**, asserted by name |
| `audit-regressions/GrantEscape.t.sol` | 14 | A grant on a token cannot escalate to peripheral rights; the keeper cannot set the callback flag; the five unbudgetable movers are refused on the keeper path while the owner may still use them; zero / duplicate token lines and a zero selector refused at grant time; period-rolled views; `NotRevocable` |
| `audit-regressions/PeripheralCallback.t.sol` | 10 | `CallbackNotPermitted` for an inner call that asks for rights; depth bounded at 8 (the proof of concept drove 40); **the registry owner cannot swap a venue in one transaction**; the exit refuses a disabled venue but not a disabled asset; **the web's exact keeper grant cannot be redirected inside the delay**; peripheral reentrancy bounded and documented |
| `audit-regressions/LpVenueCliffs.t.sol` | 11 | A stale first id is reported, not fatal; the router's unwind survives a re-key; duplicate ids never paid twice; an empty revert shape fails closed instead of truncating the list; the canary that answers still fails closed; a degenerate `(X, X)` pool is refused on the way in and by the router; the fee bound holds on every path (5,000-run fuzz); an unbounded band window is refused and a real one still passes |
| `B20.t.sol` | 10 | Router open → rebase → unwind; blocked account mid-flow; paused reward token never blocks the exit; cbZEC refused as collateral; blocked treasury never bricks the user; seized idle balance is not our loss; swap is amount-based; blocked swap leaves no allowance; keeper budget survives a rebase; 1 fuzz |
| `PythOracleAdapter.t.sol` | 15 (12 + 3 TickMath) | TickMath canonical values and the two live pool ticks reproducing the verified prices (−198319 → 2,441 USDC/WETH; −23228 → 1,020 USDC/cbZEC); same-tx gate; stale update refused; max-age re-checked; excess fee refunded; peg break both directions; TWAP-not-spot; pool unreadable fails closed; non-positive price; `peek`; 1 fuzz |
| `Deploy.t.sol` | 7 | Verified constants; guard refuses unknown chain / unconfirmed mainnet / missing env / no code; guard catches Aave provider drift; deploy wires everything in the new order (registry with its immutable timelock → venue against the registry → assets, cbZEC disabled with note, two-step registry ownership); optional Pyth adapter |
| `invariant/Invariants.t.sol` | 6 invariants + call summary + 1 liveness test | User can always exit via raw `exec`; keeper never exceeds a grant; fee ≤ `performanceBps` of yield actually paid, never collateral; **a peripheral never acquires a balance of its own** (it holds exactly what was donated); **donations do not brick the protocol**; no standing allowances; every handler path is live, including a keeper unwind after a 1-wei donation |
| `fork/BaseFork.t.sol` | 8 (skipped) | Aave provider resolves to the verified addresses; reserve params live + cbZEC not listed; cbZEC B20 shape (`0xef` code, 8 decimals, `multiplier()`); cbZEC/USDC `slot0()` + token order + tick spacing 200; the engine's index-getter shape on the live engine (**logs the live end-of-list revert — still never recorded**); supply → borrow → repay → withdraw under the account; open → close on the live engine; Permit2 / Morpho / Pyth code present |

Fuzz and invariant depth are set in `contracts/foundry.toml` (`[fuzz] runs =
512`, `[invariant] runs = 256, depth = 40`). Mocks (`test/mocks`) mirror the
verified engine semantics (index getter, replace-on-rekey, ≈0 single-sided
residual, long-leg bounce, new id per deposit, glitch / pause / refusal
switches) and `MockB20` (rebase, block, pause).

**Why the invariant suite is worth trusting now.** The old
`invariant_routerAndPeripheralsHoldNothing` asserted `balanceOf(peripheral) ==
0` and passed at 1,000 runs — **only because the Handler had no action that
could send a token to a peripheral.** It was vacuous while one base unit of
USDC would have permanently bricked the protocol. The Handler now has a
`donate` action, the invariant is a ghost-tracked equality rather than a zero,
and `test_handlerPathsAreLive` proves every path is reachable. Treat any
invariant whose Handler cannot reach the forbidden state as decoration.

## Keeper (`agent/test`, 21 files)

`npm test` runs `tsc`, then `scripts/verify-abi.mjs` (**54 checks**: selectors,
output layouts, event indexed layout, error declarations on the right contract,
the swap-adapter comparison, pinned Aave / Chainlink selectors including
`getRoundData` `0x9a6fc8f5` and `tickSpacing` `0xd0c93a7c`, and two structural
checks — `GRANT_SELECTORS` must contain **exactly one** entry and
`KEEPER_GRANT_SHAPE` must name `unwind` with `allowCallback: true`; skips
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
`reads`, `wizard`.

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
- **WHAT-IF emissions ×4 / ×6.35 / ×12 / off** — the only way to open the LP
  flow, because nothing clears at today's numbers; ×6.35 (simple) and ×12
  (advanced) land inside the **`within_model_uncertainty`** band, where the
  closed form would offer and the Monte Carlo refuses. Every surface stamps
  "not today's numbers" while it is on.
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

## CI (`.github/workflows/ci.yml`)

Runs the contracts suite and the agent + yield suites on push to `main` and
on pull requests. Gaps, unchanged: no shared / web / prototype jobs; no fork
job (needs a `BASE_BASE_RPC_URL`-class secret); the agent job runs before any
contracts compile, so its `verify-abi` skips there — order the jobs and set
`VERIFY_ABI_STRICT=1`; no static analysis (Slither / Aderyn).
