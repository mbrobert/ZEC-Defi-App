# Audit status — Base-first v1 (2026-09-06)

**No external audit has been performed on this code.** What has happened is an
internal adversarial audit — wave 1, four independent lenses, every Medium+
finding carried by an executed proof of concept — and a fix round that closed
all four Highs and the Critical. The findings, the seven lead decisions and the
residual risk are in **`AUDIT-2026-09-06.md`**; the scope, trust model,
invariants and the unverified list are in `AUDIT-SCOPE.md`; the risk register
is `RISKS.md`. The pre-pivot ledgers (`AUDIT-LEDGER-2026-08.md`,
`SECURITY-REVIEW-2026-08.md`, `AUDIT-FINDINGS-2026-09-03.md`) are history — the
code they audited no longer exists, though `AUDIT-FINDINGS` Part 1 (live engine
facts) and Part 6 (process lessons) are still binding.

Abbreviations: HF = health factor; LT = liquidation threshold; LTV =
loan-to-value; LP = liquidity provision; ABI = application binary interface;
EIP = Ethereum Improvement Proposal; CI = continuous integration; EOA =
externally owned account; MC = Monte Carlo.

## Green baseline (every suite run on this tree, 2026-09-06)

| Suite | Result | Command |
|---|---|---|
| Contracts | **244 passed, 0 failed, 8 skipped** (fork, no `FORK_URL`), 18 suites; 6 invariants + 2 liveness tests | `cd contracts && FOUNDRY_PROFILE=local forge test` |
| Root ABI seam | **303** selectors / topics / errors across 17 contracts match `contracts/abi/oilskin-abi.json` | `node scripts/verify-abi.mjs` |
| Keeper | **171 tests / 36 suites**; its own `verify-abi` **54/54** against `contracts/out` | `npm test -w @zyo/agent` |
| Yield | **131 tests** | `npm test -w @zyo/yield` |
| Web | **125 unit**; Playwright **12/12** | `npm test -w @zyo/web`; `npx playwright test` |
| Shared | **53** | `npm test -w @zyo/shared` |
| Prototypes | **118 + 109 + 56** checks + **6 fuzz** (3 seeds × 5,000 actions × 2 builds) | `node prototype/test/run-all.mjs` |

The fix round also ran the contracts suite at `--fuzz-runs 5000` (236 passed /
8 skipped, invariants excluded) and the invariants at `runs=1500 depth=120`
(8 passed, 180,000 calls each, 0 reverts, 0 discards, across 16 handler entry
points). `TESTING.md` records how each count was obtained.

## What the tests prove about the money path

- **Ownership.** Only the factory initialises an account, once; only the owner
  can `exec` / `execWithCallback` / `execBatch` / `grant` / `revoke`; the
  implementation is bricked; `accountOf` is predictable; `createAccountAndExec`
  runs the batch as the owner in one transaction and is **idempotent after a
  front-run**, forwarding through `execBatchFromFactory`, which refuses any
  caller but the factory and any owner but the real one (`Account.t.sol`, 50).
- **Peripheral rights are opt-in.** A plain `exec` grants the target nothing; a
  target that was not opted into cannot call back; rights are per-call and
  non-transitive; an inner call asking for rights reverts
  `CallbackNotPermitted`; nesting is bounded at 8; the keeper cannot set the
  flag — the grant does (`GrantEscape.t.sol`, `PeripheralCallback.t.sol`, 24).
- **Keeper budgets.** Not-granted, expired, revoked, epoch-bumped and
  period-rolled grants behave; a re-grant inside a live period carries spend
  forward; zero-amount lines, duplicate tokens and a zero selector are refused
  at grant time; every recognised ERC-20 and Permit2 selector is charged,
  including inner and nested operations; malformed calldata fails closed; the
  five unparsable movers are **refused** with `UnbudgetableSelector`; budgets
  are amount-based so a rebase cannot fool them (`Account.t.sol`, `B20.t.sol`,
  `GrantEscape.t.sol`); `invariant_keeperNeverExceedsGrant`.
- **The entry floor cannot be skipped.** `AaveV3Venue.borrow` enforces it, so
  the literal three-call hold batch the old UI built now reverts, and a
  first-time user's `createAccountAndExec` is atomic — the account is not even
  created. A 20 % drawdown inside the permit deadline on a 50 % LTV quote is
  caught with no attacker present. What remains possible is a raw owner call
  straight to Aave, asserted and named as a documented owner right
  (`EntryFloor.t.sol`, 10).
- **The router is not a holder, as a delta.** A donation of any size is inert
  (5,000-run fuzz); a router that gains a token *during* a call still reverts,
  measured from the entry balance and not from zero; the keeper's protective
  grant survives the same one wei; `invariant_peripheralsAcquireNothing` and
  `invariant_donationsDoNotBrickTheProtocol` with a live `donate` handler
  action (`RouterDonation.t.sol`, 9).
- **Router.** A real EIP-712 Permit2 signature with spender = account; disabled
  / unregistered asset refused; disabled venue refused on entry *and* exit;
  pool must contain USDC; deadline and zero-borrow guards; the band protects
  the deposit; wrong-spender and reused-nonce permits refused; full unwind round
  trip; unwind on a disabled asset; the exit floor read from the **global**
  health factor so non-USDC debt cannot sail past; a fixed repay against zero
  debt is a no-op; the swap floor is relative to the quote and a sandwiched leg
  reverts instead of settling for dust; refused ids reported at any index;
  keeper unwind within a two-token grant; `sweep` pays the owner only; the
  router refuses EOAs (`StrategyRouter.t.sol`, 27).
- **LP venue.** Ids minted to the account; residual and bounce folding; dust
  floor per decimals; width / delay / deadline / zero-amount guards; band
  required / out of range / **too wide** / `slot0` revert / short return /
  no-code pool; a degenerate `(X, X)` pool refused on the way in while a
  position that exists stays closable; the fee taken once per distinct token;
  the C-2 enumeration with the terminating revert required to be exactly
  `Panic(0x32)` and any other shape failing closed; a stale first id reported,
  not fatal, on `closeMany`, `claim` and the router's `unwind`; duplicate ids
  never paid twice; `claim` carrying a deadline (`SnuggleLpVenue.t.sol` 42,
  `LpVenueCliffs.t.sol` 11; `invariant_feeNeverTouchesPrincipal`).
- **Aave venue and registry.** Supply / borrow / repay(all) / withdraw(all)
  under the account; live LT / LTV / rate reads follow the venue; allowances
  reset; `maxOfferedLtvBps` derived from **both** venue parameters, so an
  LTV→0 deprecation takes the offer to 0; the two offer views agree on a
  disabled asset; venue replacement is timelocked, announced and cancellable,
  and the web's exact keeper grant cannot be redirected inside the delay; cbZEC
  stays out even after Aave lists it (`CollateralVenues.t.sol` 31,
  `PeripheralCallback.t.sol`).
- **B20.** Open → rebase → unwind; blocked account mid-flow (blocked leg
  skipped, the rest exits, raw `exec` proves the issuer holds it); paused
  reward token never blocks the exit; cbZEC refused as collateral; blocked
  treasury never bricks the user; seized idle balance is not our loss; swap is
  amount-based; blocked swap leaves no allowance; keeper budget survives a
  rebase (`B20.t.sol`, 10).
- **Deploy guard.** Refuses an unknown chain, an unconfirmed mainnet, missing
  env, an address without code, Aave provider drift; wires the registry with
  its immutable timelock, constructs the venue against the registry, registers
  cbZEC disabled with its note, and hands the registry over in two steps
  (`Deploy.t.sol`, 7).
- **Keeper (off chain).** Poisoned valuation snapshots plus random,
  sticky-UNKNOWN and positive sets; the audited "$9,500 debt at oracle price
  0 → HF ∞ → HEALTHY" shape is `UNKNOWN` end to end; random HF paths through
  the ladder; and the wave-1 proofs of concept re-run with their expectations
  flipped: an LP account walking the ladder is now **protected** under the
  web's single grant; a policy that would blind the fleet is a startup fatal;
  15 accounts with one wedged still all get evaluated; a full disk fails loudly
  with the last-good store intact; a crash between send and persist closes
  *less*, not more; the close fraction is a fraction of value; a refused grant
  is escalated once, not retried five times (`agent/test/*`, 171).
- **Web.** Every write the product can send is compared — outer *and* inner
  four bytes — against the compiled artifact's own selector table, with
  `callback` asserted true only for the router and the venues; the hold flow
  provably cannot build the old three-call batch; the grant the web asks users
  to sign is read from the keeper's own source and asserted identical; every
  published model number is re-rendered through the real formatters and
  compared cell by cell (`web/test/*`, 125; Playwright 12).

## Carried over from the pre-pivot findings (`AUDIT-FINDINGS-2026-09-03.md`)

Re-implemented on the new surface, each with a test: the engine's index-getter
enumeration with a measured end-of-list shape (C-2, now shape-exact); width
bounds [150, 5000] as a *total* tick span with the ± derived off chain; refund
folding after every deposit; the re-mint price band read from `slot0()` failing
closed; `verify-abi` wired into the suites; fail-closed health mapping
(`rungFor` throws on NaN; valuation `UNKNOWN`); ladder hysteresis and re-arm; a
progress watchdog instead of an elapsed-time one; bounded accrual and deposit
idempotence in the prototypes. FACT 2 (a rebalance re-keys the position id) is
the reason `closeMany` must never revert on a stale id — wave 1 proved that had
never been true.

## Dropped with the design, not ported

Operator custody in the old sense (`PositionVault`, `RewardRouter`, `openFor`,
`payoutHash`, `SimpleMultisig`), the NEAR Intents / 1-Click quote surface and
its recipient-binding trust assumption, the Rhea health monitor, ZEC-address
validation in the money path, per-pool exposure caps and per-token routing caps
(there is no shared vault to cap), the `MAX_ENGINE_POSITIONS` bound (the
account owns ids directly; nothing on chain iterates them on an exit path).
Note that dropping the old custody model did **not** make the product
owner-free: see `RISKS.md` §16.

## Open items an auditor should attack first

1. **The registry owner's remaining powers.** Instant asset disable, instant
   entry-floor change, and a timelocked venue replacement that inherits every
   account's peripheral rights. Is two days plus three events actually
   actionable by a user? What does an owner that is *not* a multisig imply for
   the whole trust story (`RISKS.md` §16)?
2. **The trusted-code boundary.** The grant's target and any peripheral it
   nests into are trusted; budgets bound only direct token operations. Find a
   composition inside `StrategyRouter.unwind` that moves user value in a way no
   budget charges and no exit floor catches.
3. **Budget accounting from calldata, after the refusal list.** Token movers
   expressed through selectors the account neither recognises nor refuses
   (`permit`, `transferWithAuthorization`, ERC-721 `safeTransferFrom`,
   multicall wrappers) executed by a keeper inside a granted tree.
4. **The band and the quote.** `PriceBand` is a spot `slot0()` check bounded at
   2500 bps; the swap floor is relative to a caller-supplied quote capped at
   500 bps. Find a same-block move, a controlled pool, or a dishonest quote
   that survives both the web's 3 % oracle cross-check and the keeper's
   pool-derived quote.
5. **Enumeration.** A `Panic(0x32)` at index *k* from a cause other than the
   end of the list is still indistinguishable from a *k*-element list. Can that
   be induced on the live engine?
6. **Fee path.** `_takeFee` measures the gain per token as a balance delta
   around the claim; find a token / engine behaviour that inflates the delta (a
   rebase up mid-claim is the obvious one — `B20.t.sol` covers the downward
   case and the keeper-budget case).
7. **Peripheral-to-peripheral reentrancy.** Bounded at depth 8, not prevented.
   Today's venues are stateless; construct a composition where that stops being
   enough.
8. **The two-model gate.** Both forms are models. Find inputs where they agree
   and are both wrong, or where `mc_calibration_stale` is bypassed by a live σ
   that drifts within the accepted direction.
9. **Everything under "Not verified" in `AUDIT-SCOPE.md`**, beginning with the
   fork suite and the engine's live revert shape.

## Before mainnet, in order

Run the 8 fork tests against Base and record the engine's live end-of-list
revert shape in `VERIFIED-BASE-FACTS.md` → either ship the cbZEC B20 policy
read or delete the sentence that claims it (`RISKS.md` §4) → wire the keeper's
webhook to something that actually reaches a user, or stop promising "keeper
notify" before signing (`RISKS.md` §10) → make `REGISTRY_OWNER` a multisig with
a published delay and stand up a watcher on `VenueChangeProposed` →
static analysis in CI (Slither / Aderyn), with the contracts job ordered before
the agent job and `VERIFY_ABI_STRICT=1` → wave 2 of the internal audit against
the new surface → an external audit of the 3,492 lines in scope → deploy with
`TREASURY` ≠ the deployer.
