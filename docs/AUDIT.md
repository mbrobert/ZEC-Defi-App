# Audit status — Base-first v1 (2026-09-05)

**No external audit has been performed on this code.** This page records what
the tree itself proves, what the build carried over from the two pre-pivot
review waves, what it deliberately dropped, and what an auditor is asked to
attack. The scope, trust model, invariants and the unverified list are in
`AUDIT-SCOPE.md`; the pre-pivot ledgers are `AUDIT-LEDGER-2026-08.md`,
`SECURITY-REVIEW-2026-08.md` and `AUDIT-FINDINGS-2026-09-03.md` (history —
the code they audited no longer exists).

Abbreviations: HF = health factor; LT = liquidation threshold; LTV =
loan-to-value; LP = liquidity provision; ABI = application binary interface;
EIP = Ethereum Improvement Proposal; CI = continuous integration; EOA =
externally owned account.

## Green baseline (run on this tree, 2026-09-05)

| Suite | Result | Command |
|---|---|---|
| Contracts | 181 passed, 0 failed, **8 skipped** (fork, no `FORK_URL`), 13 suites; 5 invariants × 256 runs × depth 40, 0 reverts | `cd contracts && forge test` |
| Root ABI seam | 266 selectors / topics / errors across 17 contracts match `contracts/abi/oilskin-abi.json` | `node scripts/verify-abi.mjs` |
| Keeper | 139 tests / 29 suites; `verify-abi` 36/36 against `contracts/out` | `npm test -w @zyo/agent` |
| Yield | 105 tests | `npm test -w @zyo/yield` |
| Web | 89 unit; Playwright 12/12 (warm server) | `npm test -w @zyo/web`; `npx playwright test` |
| Shared | 52 | `npm test -w @zyo/shared` |
| Prototypes | 85 + 80 + 45 + 6 checks; 30,000 fuzzed reducer actions, 0 invariant violations | `node prototype/test/run-all.mjs` |

## What the tests prove about the money path

- **Ownership.** Only the factory initialises an account, once; only the
  owner can `exec` / `execBatch` / `grant` / `revoke`; the implementation is
  bricked; `accountOf` is predictable and `createAccountAndExec` runs the batch
  as the owner in one transaction (`Account.t.sol`, 48).
- **Peripheral rights.** Only the active target of the current `exec` may call
  back; rights are per-call and non-transitive; nested delegation restores the
  caller; reentrancy through every door reverts (`Account.t.sol`).
- **Keeper budgets.** Not-granted, expired, revoked, epoch-bumped and
  period-rolled grants behave; every ERC-20 and Permit2 token selector is
  charged, including inner and nested operations; malformed calldata fails
  closed; budgets are amount-based so a rebase cannot fool them
  (`Account.t.sol`, `B20.t.sol`); `invariant_keeperNeverExceedsGrant`.
- **Router.** A real EIP-712 Permit2 signature with spender = account; the
  entry-HF floor enforced exactly at the offered max; disabled / unregistered
  asset refused; pool must contain USDC; deadline and zero-borrow guards; the
  band protects the deposit; wrong-spender and reused-nonce permits refused;
  full unwind round trip; unwind on a disabled asset; exit-HF floor; swap
  `minOut`; refused ids reported; keeper unwind within a two-token grant;
  `sweep` pays the owner only; the router refuses EOAs; the router holds
  nothing after every call (`StrategyRouter.t.sol`, 26;
  `invariant_routerAndPeripheralsHoldNothing`).
- **LP venue.** Ids minted to the account; residual and bounce folding; dust
  floor per decimals; width / delay / deadline / zero-amount guards; band
  required / out of range / `slot0` revert / short return / no-code pool; the
  C-2 enumeration (empty, grows, prunes, re-key, 25 ids, glitch →
  `EnumerationFailed`, paused → `EngineUnreachable`, exit never depends on it);
  fee on yield only and path-independent; refused claims skipped; per-id
  try/catch close (`SnuggleLpVenue.t.sol`, 41; `invariant_feeNeverTouchesPrincipal`).
- **Aave venue and registry.** Supply / borrow / repay(all) / withdraw(all)
  under the account; live LT / LTV / rate reads follow the venue; allowances
  reset; `maxOfferedLtvBps` derived (7800 → 5000 cap; 7000 → 4516); floor
  bounds; cbZEC disabled with note; enabling requires the venue to list the
  asset (`CollateralVenues.t.sol`, 27).
- **B20.** Open → rebase → unwind; blocked account mid-flow (blocked leg
  skipped, the rest exits, raw `exec` proves the issuer holds it); paused
  reward token never blocks the exit; cbZEC refused as collateral; blocked
  treasury never bricks the user; seized idle balance is not our loss; swap is
  amount-based; blocked swap leaves no allowance; keeper budget survives a
  rebase (`B20.t.sol`, 10).
- **Deploy guard.** Refuses an unknown chain, an unconfirmed mainnet, missing
  env, an address without code, Aave provider drift; wires cbZEC disabled with
  its note and hands the registry over in two steps (`Deploy.t.sol`, 7).
- **Keeper (off chain).** 4,000 poisoned valuation snapshots plus random,
  sticky-UNKNOWN and positive sets; the audited "$9,500 debt at oracle price
  0 → HF ∞ → HEALTHY" shape is `UNKNOWN` end to end; 2,000 × 3 random HF paths
  through the ladder; idempotency keys survive a crash before and after send;
  real-process liveness (spawned daemon, lock held, SIGTERM exit 0, bad config
  exit 1 without echoing the key); redaction of keys, URL paths and secrets
  across full runs (`agent/test/*`).

## Carried over from the pre-pivot findings (`AUDIT-FINDINGS-2026-09-03.md`)

Re-implemented on the new surface, each with a test: the engine's
index-getter enumeration with a measured end-of-list shape (C-2); width
bounds [150, 5000] as a *total* tick span with the ± derived off chain; refund
folding after every deposit; the re-mint price band read from `slot0()`
failing closed; `verify-abi` wired into the suites; fail-closed health
mapping (`rungFor` throws on NaN; valuation `UNKNOWN`); ladder hysteresis and
re-arm; a progress watchdog instead of an elapsed-time one; bounded accrual and
deposit idempotence in the prototypes.

## Dropped with the design, not ported

Operator custody (`PositionVault`, `RewardRouter`, `openFor`, `payoutHash`,
`SimpleMultisig`), the NEAR Intents / 1-Click quote surface and its
recipient-binding trust assumption, the Rhea health monitor, ZEC-address
validation in the money path, per-pool exposure caps and per-token routing
caps (there is no shared vault to cap), the `MAX_ENGINE_POSITIONS` bound (the
account owns ids directly; nothing on chain iterates them on an exit path).

## Open items an auditor should attack first

1. **The grant seam.** The web grants `StrategyRouter.unwind` only; the keeper
   plans `SnuggleLpVenue.closeMany` + `unwind` and is refused without the
   second grant. Also: whether a grant on `closeMany` with pool-token budgets
   lets a compromised keeper key churn value out through the engine's
   internal swaps within budget (the fee transfers and the band are the only
   floors).
2. **`execFromPeripheral` reachability.** Any way for a target that is *not*
   the active peripheral to obtain callback rights, including via tokens with
   hooks (ERC-777-style) called from inside a venue's tree.
3. **Budget accounting from calldata.** Token operations expressed through
   selectors the account does not recognise (`permit`, `transferWithAuthorization`,
   `safeTransferFrom` on ERC-721 ids, multicall wrappers) executed by a keeper
   inside a granted tree.
4. **The band.** `PriceBand` is a spot `slot0()` check; a same-block price
   move within the tolerance, or a pool the caller controls, is the residual.
5. **Unwind swap floor.** `swapMinOut` is caller-supplied; the web sizes it
   from a cache and degrades to 1 on a zero value.
6. **Hold path.** The borrow-and-hold batch bypasses the router's entry-HF
   floor.
7. **Fee path.** `_takeFee` measures the gain per token as a balance delta
   around the claim; find a token / engine behaviour that inflates the delta
   (a rebase up mid-claim is the obvious one — `B20.t.sol` covers the
   downward case and the keeper-budget case).
8. **Everything under "Not verified" in `AUDIT-SCOPE.md`**, beginning with the
   fork suite and the SwapRouter.

## Before mainnet, in order

Run the 8 fork tests against Base and record the engine's live end-of-list
revert shape in `VERIFIED-BASE-FACTS.md` → probe and record the Aerodrome
SwapRouter → close the grant seam (web asks for `closeMany`, or the keeper's
plan changes) → make the hold path chain-enforce the entry floor or say it
does not → either ship the cbZEC policy read or remove the sentence → static
analysis in CI → an external audit of the 2,856 lines in scope → deploy with
`REGISTRY_OWNER` = a Safe and `TREASURY` ≠ the deployer.
