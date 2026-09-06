# Testing — every suite, how to run it, what it proves

Counts are from running each suite on this tree on 2026-09-05 (not copied from
build reports). Two audiences: the automated suites, and a person clicking the
demo (the tester's kit at the end).

Abbreviations: RPC = remote procedure call (a chain node endpoint); ABI =
application binary interface; HF = health factor; LT = liquidation threshold;
LTV = loan-to-value; LP = liquidity provision; TWAP = time-weighted average
price; EIP = Ethereum Improvement Proposal; CI = continuous integration.

## Summary

| Area | Command | Counted result |
|---|---|---|
| Contracts (Foundry) | `cd contracts && forge test` | **181 passed, 0 failed, 8 skipped**, 13 suites — 5 invariants × 256 runs × depth 40 (10,240 calls each, 0 reverts); 8 fuzz tests × 512 runs |
| Contracts, fork | `FORK_URL=<Base RPC> forge test --match-path test/fork/BaseFork.t.sol -vv` | 8 tests; **skipped without `FORK_URL`** (`vm.skip`), reported as skipped, never as passed. Not run from this container |
| Root ABI seam | `node scripts/verify-abi.mjs` | 266 selectors / topics / errors across 17 contracts match `contracts/abi/oilskin-abi.json`; `--write` regenerates; exit 1 on drift |
| Shared | `npm test -w @zyo/shared` | **52** (7 files: evm, base, health, collateral, fees, width, pools) |
| Keeper | `npm test -w @zyo/agent` | tsc + `verify-abi` **36/36** + **139 tests / 29 suites** (~17 s) |
| Yield | `npm test -w @zyo/yield` | tsc + **105 tests** (14 files; RPC mocked at the JSON-RPC boundary with recorded chain words) |
| Web, unit | `npm test -w @zyo/web` | **89 tests** (11 files); the ABI-drift test and the MODEL-NUMBERS pin *ran* (they skip loudly only if the bundle / `/tmp/build/MODEL-NUMBERS.md` is absent) |
| Web, e2e | `cd web && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test` | **12/12** (6 scenarios × desktop-1360 / phone-390) against a warm `next dev`; zero console errors asserted |
| Prototypes | `CHROMIUM_PATH=/opt/pw-browsers/chromium node prototype/test/run-all.mjs` | **verify-simple 85 · verify-advanced 80 · verify-toggle 45 · fuzz 6** (3 seeds × 5,000 actions × 2 builds = 30,000 reducer actions, 0 invariant violations) |

Prerequisites: Node ≥ 22; `npm install` at the root; `npm run build -w
@zyo/shared` (every consumer imports its `dist/`); Foundry with the two
libraries cloned into `contracts/lib` (`SETUP.md`); Playwright Chromium.
Offline container with a pre-fetched compiler: `FOUNDRY_PROFILE=local`.

A note on the e2e count: on a cold `next dev` in a slow container the first
scenario can miss its 15-second expectation while `/onboard` compiles
(11/12 on the first cold run here); pre-warming the routes or pointing
`E2E_BASE_URL` at a running server gives 12/12. That is compile latency, not
a product failure — the phone-390 run of the same scenario, second on the
same server, passes cold.

## Contracts — what each suite proves (`contracts/test`)

| File | Tests | Proves |
|---|---|---|
| `Account.t.sol` | 48 | CREATE2 prediction, idempotent `createAccount`, one-transaction `createAccountAndExec`; owner-only `exec` / `execBatch`; ERC-721/1155 receivers; reentrancy through every door; peripheral callback rights (active target only, non-transitive, nested delegation restores); keeper grants: not-granted, expiry, revoke, `revokeAll` epoch, period reset, value budget, every token selector incl. Permit2, inner and nested operations charged, malformed calldata fails closed; amount-based budgets vs a rebasing token; 2 fuzz |
| `CollateralVenues.t.sol` | 27 | `AaveV3Venue` supply / borrow / repay(all) / withdraw(all) under the account; live LT / LTV / rate reads follow the venue; allowances reset; HF = LT/LTV; keeper repay within budget; keeper withdraw pays the account; `MorphoBlueVenue` disabled everywhere + `marketId`; registry `maxOfferedLtvBps` derived (7800 → 5000 cap; 7000 → 4516), floor bounds, decimals read from the token, cbZEC disabled with note, enable requires the venue to list the asset; 1 fuzz |
| `SnuggleLpVenue.t.sol` | 41 | Single / dual open minted to the account; residual and bounce folding; dust floor per decimals; width [150, 5000] / delay / deadline / zero-amount guards; band required / out of range / `slot0` revert / short return / no-code pool; C-2 enumeration (empty, grows, prunes, re-key, 25 ids, glitch → `EnumerationFailed`, paused → `EngineUnreachable`, exit never depends on it); close fee on yield only; `harvest` vs `claimStakingRewards`; refused claims skipped; `closeMany` per-id try/catch; claim chokepoint + path independence; increase; keeper close within budget; cbZEC rebase / downward rebase / blocked / paused; 2 fuzz |
| `StrategyRouter.t.sol` | 26 | Full open with a real EIP-712 Permit2 signature (spender = account); first-time user in one tx; entry-HF floor enforced exactly at the offered max; disabled / unregistered asset; pool must contain USDC; deadline / zero borrow; band protects the deposit; open against existing collateral; wrong-spender / reused-nonce permits; full unwind round trip; unwind on a disabled asset; repay-only; exit-HF floor; swap `minOut`; refused ids reported; keeper unwind within a two-token grant; `sweep` to owner only; router refuses EOAs; router holds nothing after every call; swap-adapter guards; 1 fuzz |
| `B20.t.sol` | 10 | Router open → rebase → unwind; blocked account mid-flow; paused reward token never blocks the exit; cbZEC refused as collateral; blocked treasury never bricks the user; seized idle balance is not our loss; swap is amount-based; blocked swap leaves no allowance; keeper budget survives a rebase; 1 fuzz |
| `PythOracleAdapter.t.sol` | 15 | TickMath canonical values and the two live pool ticks reproducing the verified prices (−198319 → 2,441 USDC/WETH; −23228 → 1,020 USDC/cbZEC); same-tx gate; stale update refused; max-age re-checked; excess fee refunded; peg break both directions; TWAP-not-spot; pool unreadable fails closed; non-positive price; `peek`; 1 fuzz |
| `Deploy.t.sol` | 7 | Verified constants; guard refuses unknown chain / unconfirmed mainnet / missing env / no code; guard catches Aave provider drift; deploy wires everything (cbZEC disabled note, two-step registry ownership); optional Pyth adapter |
| `invariant/Invariants.t.sol` | 5 invariants + 1 liveness test | User can always exit via raw `exec`; keeper never exceeds a grant; fee ≤ `performanceBps` of yield actually paid, never collateral; router + venues + adapter hold zero; no standing allowances; every handler path is live |
| `fork/BaseFork.t.sol` | 8 (skipped) | Aave provider resolves to the verified addresses; reserve params live + cbZEC not listed; cbZEC B20 shape (`0xef` code, 8 decimals, `multiplier()`); cbZEC/USDC `slot0()` + token order + tick spacing 200; the engine's index-getter shape on the live engine (logs the live end-of-list revert — record it in `VERIFIED-BASE-FACTS.md` on first run); supply → borrow → repay → withdraw under the account; open → close on the live engine in the first active WETH/USDC pool; Permit2 / Morpho / Pyth code present |

Fuzz and invariant depth are set in `contracts/foundry.toml` (`[fuzz] runs =
512`, `[invariant] runs = 256, depth = 40`); the build report also ran
`--fuzz-runs 5000` and 768 × 64 green. Mocks (`test/mocks`) mirror the
verified engine semantics (index getter, replace-on-rekey, ≈0 single-sided
residual, long-leg bounce, new id per deposit, glitch / pause / refusal
switches) and `MockB20` (rebase, block, pause).

## Keeper (`agent/test`)

`npm test` runs `tsc`, then `scripts/verify-abi.mjs` (36 checks: selectors,
output layouts, event indexed layout, error declarations on the right
contract, the two grant selectors, `execAsKeeper`, six pinned Aave / Chainlink
selectors — skips loudly if `contracts/out` is absent; `VERIFY_ABI_STRICT=1`
makes that fatal), then `node --test` over 12 files. Inside: 4,000 poisoned
valuation snapshots (+1,500 random, +1,000 sticky-UNKNOWN, +500 positive) via
`fast-check`; 2,000 × 3 random HF paths through the ladder; 1,000 price
bands; 6 real-process / end-to-end runs (a spawned `dist/src/index.js` over an
HTTP JSON-RPC mock; in-process keeper mode over a behavioural
account / router / LP-venue mock that executes signed raw transactions);
config strictness; store atomicity, lock, tamper detection, duplicate
rejection, monotonic counters; log redaction across full runs.

## Yield (`services/yield/test`)

14 files. Strict Aave decoding (12 / 10 words exactly, bounds, a half-readable
sample refused; fixture reproduces 4.828 % / LT 7800 / 8300); gauge reads,
outlier gate, `epochActive` re-derived at serve time; the gate's thirteen
refusal reasons; the model; **`model-pin.test.ts`** replays the recorded words
through the real `GaugeSource` + gate and asserts every served cell equals the
Python sim's closed-form cell to 0.01 pt (54 cells) and that
`samples/model-inputs.json` matches what `@zyo/shared` exports; server
(503 on absent / stale rates); config (`near|rhea|oneclick|intents` knobs
cannot reappear); event decoding; indexer; lifecycles; cohorts; bands;
registry; RPC.

## Web (`web/test`, `web/e2e`)

Unit: `abi.test.ts` (re-reads `contracts/abi/oilskin-abi.json`, fails on any
signature / selector / output-layout drift and on a stale bundle hash),
`snapshot.test.ts` (demo market equals the `VERIFIED-BASE-FACTS.md` Aave table
and Chainlink answers — the test parses the doc; every external address the
web uses appears in the doc; demo addresses do not; `demo-gate.json` equals
`MODEL-NUMBERS.md` cell by cell), `copy.test.ts` (the disclosure list covers
every BASE-PIVOT item-19 topic; the four banned entry words — `RISKS.md` §1
lists them — do not appear under `app/`, `components/`, `lib/`),
`plan.test.ts`, `execute.test.ts`, `gate.test.ts`,
`math.test.ts`, `onboarding.test.ts`, `positions.test.ts`, `reads.test.ts`,
`wizard.test.ts`.

E2E (`e2e/demo-flow.spec.ts`, `NEXT_PUBLIC_FORCE_DEMO=1`, no wallet, no RPC):
landing → onboarding (jurisdiction first, three steps, wallet-address help,
pinned cbZEC + counterfeit check, already-on-Base); Simple wizard (collateral
→ computed setting → one recommendation → review with plain sentences →
simulated sign incl. keeper protection); Advanced wizard (every pool with the
model's numbers, why-not list, custom controls, technical detail); dashboard
(tiles, ladder band, position card, claim / unwind panels, Advanced raw
data); spot (gated in Simple; demo quote, cbZEC pin, slippage guard,
disclosures in Advanced); no horizontal overflow on every page and wizard
step in both modes. Each at 1360 px and 390 px.

## Prototypes (`prototype/test`)

`run-all.mjs` runs `verify-simple` (85), `verify-advanced` (80),
`verify-toggle` (45) and `fuzz` (6). `verify-toggle` diffs the byte-equal
shared block between the two pages, deep-equals `OIL_SHARED` against the built
`@zyo/shared`, checks the derived functions against shared's, checks
`OIL_CHAIN_READ` against `docs/VERIFIED-BASE-FACTS.md` and `OIL_MODEL` against
`/tmp/build/MODEL-NUMBERS.md` (skipped with a named check if absent). Every
suite runs the removed-vocabulary guard (`_harness.mjs: FORBIDDEN`) over the
shipped pages and reports, as information, which docs still mention that
vocabulary. The static checks scan the markup for any typed ±, HF, drop %,
rung, LT or borrow literal.

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
- **Fast-forward** 1 / 30 days in bounded ticks (accrual clamped per tick).
- **Borrow rate** 9 % and reset — the gate re-runs on every pool.
- **WHAT-IF emissions ×4 / off** — the only way to open the LP flow, because
  nothing clears at today's numbers; every surface stamps "not today's
  numbers" while it is on.
- **Failures**: wallet rejects the signature; router reverts mid-hop (the
  whole transaction is undone); engine bounces 12 % (refund folding + dust
  left idle); position out of range / back in; keeper offline / back; corrupt
  store (reset with a boot note); wipe store; "See an example" (never
  persisted, never replaces a real position).

Things to try to break: LTV above the per-asset top; width outside
[150, 5000]; borrowing while the warn rung is fired; topping up into a pool
that no longer clears; a second sign while one is in flight; closing the
modal mid-flight; two tabs (a stale tab cannot clobber a credited deposit);
Enter/Space ×4 on Confirm (one position); withdrawing collateral below the
1.55 floor; closing an LP "to wallet" and expecting the debt to vanish. Each
is prevented at the reducer and has a named check in `verify-simple.mjs` or
`verify-advanced.mjs`.

## CI (`.github/workflows/ci.yml`)

Runs the contracts suite and the agent + yield suites on push to `main` and
on pull requests. Gaps: no shared / web / prototype jobs; no fork job (needs
a `BASE_RPC_URL` secret); the agent job runs before any contracts compile, so
its `verify-abi` skips there — order the jobs and set `VERIFY_ABI_STRICT=1`;
no static analysis.
