> **History.** Founder-run pre-audit self-review of the pre-pivot design (PositionVault / RewardRouter / SnuggleAdapter, the NEAR-Intents 1-Click payout leg, the Rhea health monitor), 2026-08-16. That code was deleted in the Base-first pivot (`BASE-PIVOT-2026-09.md`); findings that transferred (fail-closed health mapping, ladder hysteresis, deposit idempotence) are re-implemented and tested on the new surface (`AUDIT.md`). Kept as the record of what was found.

# Oilskin — internal security review (2026-08-16)

**Scope:** the on-chain contracts (`PositionVault`, `RewardRouter`, `SnuggleAdapter`)
and the off-chain agent's safety-critical paths (health ladder, reward routing,
1-Click quote handling). **This is a founder-run pre-audit self-review, not a
substitute for a professional third-party audit** — that is still required before
mainnet TVL (tracked in `docs/AUDIT.md`). Its purpose is to find and fix as much
as we can ourselves first, and to hand an auditor a clean, documented starting
point.

## Method

1. Mapped the attack surface against the vector classes that actually drain DeFi —
   drawn from 2025–2026 incident post-mortems and the classic canon (sources at the
   bottom). Both large-TVL and small-TVL failures, because our launch is
   deliberately small-TVL and small projects die to unglamorous bugs.
2. Read every money-handling function line by line against that map.
3. Wrote failing tests for each real finding, fixed it, and kept the test.
4. Re-ran the full suites. Current green baseline:
   - **Contracts:** 73 unit/scenario tests + 8 stateful-invariant suites
     (~82K+ randomized transitions) — `forge test`.
   - **Agent:** 72 tests including an adversarial/MEV suite — `npm test`.
   - **Prototype:** 1,728-combination logic grid + 90-action UI state-machine
     fuzz, zero console errors (`/tmp/fuzz-A.mjs`, `fuzz-B.mjs`; see `TESTING.md`).

## Attack-vector map → our exposure

| Vector class | Seen in | Our exposure | Status |
|---|---|---|---|
| Share-inflation / first-depositor / donation (ERC-4626) | Countless vaults | **Low** — we don't mint fungible vault shares off a `balanceOf`; positions are per-user structs and adapter principal is tracked explicitly, not derived from token balance. | Reviewed, sound |
| Math error in liquidity accounting | Cetus ($223M, 2025) | **Medium** — CL exit/re-deposit math. Covered by invariants + slippage floors. | Reviewed; fork-verify at audit |
| Access-control / impersonation | Balancer v2 ($120M, 2025) | **Medium** — operator/owner/router/position-owner gates. | Reviewed, sound |
| Private-key / signer compromise | Bybit ($1.4B), Nobitex, Phemex, UPCX (2025) | **High (operational)** — owner = Safe multisig + timelock (deploy step); operator key is hot but power-bounded (can't move principal or change payout address). | Design mitigation; deploy-time |
| Reentrancy (incl. read-only) | The DAO; dForce, Curve-adjacent | **Low** — see below. | Reviewed, sound |
| Oracle / tick / price manipulation | Many | **Medium** — we consume engine/Rhea prices, don't publish any; withdrawal slippage floors bound MEV. | Reviewed; bounded |
| Bridge replay / recipient swap | Multiple 2026 bridge hacks | **Medium** — the 1-Click custody leg; recipient/destination/deposit-address checks + audit event. | Reviewed; **A1/A2 below** |
| Liveness / griefing DoS | Small-TVL projects | **Medium** — engine-position accumulation. | **F1 below — fixed** |

## Findings & fixes

Severity is our own pre-audit estimate.

### A3 — Health factor `NaN` classified HEALTHY (fail-open) · **High** · FIXED
`assessHealth` treated any non-finite HF as HEALTHY (`!Number.isFinite`), to handle
"no debt = +Infinity". But `NaN` (a 0/0 valuation, a bad price feed) is also
non-finite, so suspect data silently read as healthy and **no protection fired**.
Since the monitor only assesses positions that *have* a borrow leg, a NaN there is
never "no debt" — it is bad data. Fix: `NaN`/negative → `CRITICAL` + `NOTIFY`
(fail-closed to a human; we deliberately do **not** auto-unwind on a possibly-bad
number), while genuine `+Infinity` (no debt) stays HEALTHY.
Test: `agent/test/health.test.ts`.

### A4 — Escalation swallowed by band-only dedup · **High** · FIXED
`HealthMonitor` dispatched actions on *band* transitions and deduped on band. But
`REDUCE_LEVERAGE` (partial deleverage) and `EMERGENCY_UNWIND` are **both the
CRITICAL band** — so a position already CRITICAL that fell from the deleverage zone
into the emergency zone produced no new dispatch: **the emergency unwind never
fired.** Fix: dedupe on `band:action`, and advance the marker only *after* a
successful dispatch so a throwing handler is retried next tick instead of being
permanently deduped. Test: `agent/test/healthMonitor.test.ts` (escalation fires;
stable state doesn't re-alert; throwing handler retried).

### A2 — Reward route accepted any quote output value · **Medium** · FIXED
`routeToZcash` verified the quote's recipient, destination asset, and deposit-address
shape, but not the *output amount*. A tampered or mispriced quote could route real
USDC rewards to the bridge for a dust amount of ZEC out. Fix: require a positive
on-chain `minAmountOut` floor, and — when the API returns a USD figure — require the
output value to land within `maxQuoteValueLossBps` (default 5%) of what we send in;
otherwise refuse and let rewards accrue and retry. Blast radius was already bounded
by `maxRoutePerTx` and reward-only flows; this closes the value-loss gap.
Test: `agent/test/rewardExecutor.test.ts` (rejects near-zero output and missing floor).

### F1 — Engine-position accumulation could brick top-ups/compounding · **Medium** · FIXED
The engine has no in-place increase, so every `increase`/`compound` mints a fresh
engine position under the same vault positionId. The adapter caps these at
`MAX_ENGINE_POSITIONS = 16` (exit paths iterate them). Once at the cap, further
increases/compounds reverted with `TooManyEnginePositions` and there was **no way to
recover headroom short of a withdrawal** — a liveness DoS on compounding. (User exit
was never affected; `withdraw` always works and itself consolidates to one.) Fix:
added `consolidate(positionId)` (adapter + operator-gated vault passthrough) that
closes all engine positions and re-deposits 100% as one, moving no value and unable
to change ownership/principal/payout. Tests: `contracts/test/SnuggleAdapter.t.sol`
(collapse preserves principal; restores headroom after the cap) and
`PositionVault.t.sol` (operator-only; inactive reverts).

### F2 — `claim` underflow if a reward token equals a pool token · **Low** · FIXED
`_watchList` appended configured reward tokens after `token0/token1` without
dedupe. If an operator listed a pool token as a reward token, it appeared twice; the
second balance-diff underflowed (checked arithmetic) and **every claim reverted**
until reconfigured. Fix: `_watchList` now dedupes against the pool tokens and itself.
Test: `contracts/test/SnuggleAdapter.t.sol` (overlapping config still claims).

### A1 — 1-Click quote signature not verified · **Informational / hardening** · DEFERRED
`QuoteResponse.signature` is fetched but never checked. If the 1-Click endpoint signs
quotes, verifying the signature would harden the reward-routing leg against a
MITM'd/compromised quote endpoint (defense-in-depth atop A2's value floor). Deferred
because it needs the provider's exact signing scheme; noted for the integration
review. Nothing regresses without it.

## Reviewed and found sound (no change)

- **Reentrancy:** every state-mutating external on the vault and router is
  `nonReentrant`. The adapter exposes no external attack surface (all mutating
  entrypoints are `onlyVault`; config is `onlyOwner`). Pool tokens are USDC/WETH/cbBTC
  — no ERC-777-style transfer callbacks — so the "transfer to arbitrary recipient
  before final state write" in `withdraw` is not reenterable. Read-only reentrancy is
  N/A: we publish no price/among-shares view another protocol prices against.
- **Exposure-cap accounting:** `poolExposure` adds entry-token units on open/increase
  and releases the principal delta on withdraw; the adapter's `principal` is itself
  token-denominated, so the units are consistent (subtle — commented in-code).
- **Withdrawal invariant:** exit is exempt from `pause()` and can only ever send to
  the position owner via the adapter; the stateful invariant suite asserts the vault
  never retains idle principal across ~82K transitions.
- **Principal isolation:** principal never routes through the reward path; the router
  holds only rewards, transiently, within a single tx.

## Honest limitations of this review

- **A professional third-party audit is still required before mainnet.** This is
  internal work by the builder; it finds bugs, it does not certify their absence.
- **Fork tests did not run in this environment** (no archive-node RPC access here).
  The prior fork suite — adapter round-tripping deposits/partial-exits/full-exits
  against the deployed Base engine — remains the reference. `consolidate()` reuses the
  exact engine calls already fork-verified inside `withdraw()`'s re-deposit branch,
  but **`consolidate()` itself must be fork-verified before mainnet** (added to
  `docs/AUDIT.md`).
- Threat model assumes a semi-trusted operator (power-bounded) and a Safe multisig +
  timelock owner; both are deploy-time controls, not yet on-chain.

## Sources (2026-08 research)

Halborn "Biggest DeFi hacks of 2025"; CertiK / QuillAudits on read-only reentrancy
(dForce/Curve); OpenZeppelin ERC-4626 inflation-attack defense; Blockscout "When keys
beat code"; incident reporting on Cetus, Balancer v2, and the 2026 bridge exploit
wave. Full links in the research log kept with the project's business files.
