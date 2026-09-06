> **History (restored 2026-09-05 from the recovered copy).** Pre-audit findings, waves 1 and 2, on the pre-pivot design. The code these findings describe (PositionVault, RewardRouter, SnuggleAdapter, the NEAR / 1-Click leg) is gone (`BASE-PIVOT-2026-09.md`); Part 1 (live engine facts, 2026-09-03) and Part 6 (process lessons) remain binding and are cited from `contracts/src`, `agent/src`, `web/` and `BUILD-SPEC-2026-09.md`. `docs/PRE-AUDIT-2026-09-02.md` and `docs/YIELD-REALITY-2026-08-31.md`, which it refers to, are not in this tree.

# Project Oilskin — pre-audit findings, waves 1 and 2 (2026-09-03)

**Status of this document.** The code fixes these findings describe were written, tested green, and
committed locally as `11de0e2` (158 files, +33,538/−3,376) but were **lost when the cloud container was
recycled before the push completed**. GitHub `main` (`1989cc5`) contains round 1 only. This document is the
surviving record: it is written so the fixes can be re-implemented without repeating the 14 lens sweeps
that found them. Everything here was proved with a runnable proof-of-concept at the time; where a claim is
an on-chain observation the block height and date are given.

Read with: `docs/PRE-AUDIT-2026-09-02.md` (round 1, on GitHub) and `docs/YIELD-REALITY-2026-08-31.md`.

---

## Part 1 — Live-chain ground truth (verified against Base mainnet, 2026-09-03, head ≈ block 50,821,540)

Engine proxy `0x7D27CDfBFcC878F7E7349e216d44204BFd2AFd55`; implementation (EIP-1967 slot)
`0x359f90ee4c2e21cbf6e32c5a062eeef306822d28`. Method: `eth_getLogs` for `SnuggleRebalanced`
(topic0 `0x125c342de1fd6de2d82c27973075e1bf1f9764930449bc7eeae87efc59eadfaf`) and `PositionCreated`
(`0x122df793e932991c659ba0d9c044844fa40f9e9d8ef31c49a72f20eaf0731064`) over ~9,000 blocks — 95 and 19
events — then `eth_call` against `positions(uint256)` (`0x99fbab88`) and the enumeration getters.

### FACT 1 — CRITICAL. `userPositions(address) returns (uint256[])` DOES NOT EXIST on the live engine.

- `eth_call` with selector `0x613cf420` (`userPositions(address)`) → **execution reverted**, for every owner tried.
- `eth_call` with selector `0x5e1b4d99` (`userPositions(address,uint256)`) → returns one tokenId per index,
  reverts past the end.
- So the engine declares `mapping(address => uint256[]) public userPositions;` and the compiler-generated
  getter takes an index. `getUserPositions`, `userPositionCount`, `getPositionsByOwner`, `positionsOf`,
  `getUserPositionIds` all revert — they do not exist.

`ISnuggleVault.sol` declared the array-returning form and `SnuggleAdapter._liveIds()` called it. **Every path
that touches `_liveIds` would have reverted on Base from the first transaction** — deposits (the cap check),
withdrawals, claims, `consolidate`, and the views. The protocol was un-launchable and the offline suite was
green, because the mock implemented the interface we had written rather than the one the engine has. The
round-1 fork suite was never re-run after the C-1 holder redesign (no container egress), which is exactly
how this hid.

**Fix as implemented:** enumerate by index through a low-level `staticcall` until the end-of-list revert,
keep only ids the engine still reports the holder owns, and *measure* the end-of-list revert shape at runtime
with a canary probe rather than hard-coding `Panic(0x32)` — the mock reverts empty and the live shape was
never recorded, so assuming it would have been the same class of mistake.

### FACT 2 — re-key semantics are REPLACE, not append.

For three rebalanced owners (position lists of 13, 25 and 7 ids): the OLD id is **absent** from
`userPositions` and `positions(old)` returns `tokenId = 0, owner = 0` (deleted); the NEW id **is** in the
list. Enumerating until revert therefore yields exactly the live ids.

Two consequences: the round-1 C-1 premise (a keeper rebalance re-keys the tokenId) is confirmed correct, and
**real users hold 13–25 ids**, so a `MAX_ENGINE_POSITIONS = 16` cap must gate *our deposit path only* and
must never be able to block an exit.

### FACT 3 — `rangeWidthBps` is the TOTAL tick span (1 bps == 1 tick), not a half-width.

Live positions read back: width 1000 → tick span 1000 → upper/lower = 1.0001^1000 = **+10.52% total
(±5.13% per side)**; width 300 → 3.05% total (±1.51%); 1398 → 15.00% (±7.24%); 1823 → 20.00% (±9.54%);
953 → 10.00% (±4.88%). Spans that are not multiples of 100 (1398, 1823, 953) mean those pools have
tickSpacing 1–2; the engine rounds bounds to the pool's spacing.

**The product promised ±25% / ±8% / ±1.5% and the Monte Carlo was computed on those half-widths, but the
presets 2500/800/150 would have delivered only ±12.5% / ±4% / ±0.75% — half the advertised range.**

Conversion: `half = exp(bps · ln(1.0001) / 2) − 1`; inverse `bps = round(2 · ln(1+half) / ln(1.0001))`.

**Settled presets:** standard **4500 / 1500 / 300** → ±25.23% / ±7.79% / ±1.51%.
Correlated pairs halve the HALF-WIDTH, not the span (halving a span does not halve the ± it delivers):
**2356 / 784 / 150** → ±12.50% / ±4.00% / ±0.75%. Note 784 bps is **±4.00%**, not the ±3.8% an early draft
assumed, and the exact halving of ±0.75% is 149.4 → 149, which is one tick **below** the enforced floor, so
the correlated Aggressive preset is **150**. Bounds are **[150, 5000]** total tick span (the deployed vault
rejects >5000). No ± may ever be typed as a literal — it is computed, and three codebases now fail a test if
one is typed.

### FACT 4 — deposit and refund semantics.

`depositSingleSided` swaps to ratio inside the engine and mints with ≈ zero residual (the repo's own fork
assertion: 50,000 USDC in → 49,999.999998 used, no other-token refund). The dual-token
`deposit(amount0, amount1)` mints the balanced part and bounces the excess of the long leg to `msg.sender`.
There is **no `increaseLiquidity`** — every deposit mints a NEW tokenId, and `withdraw(id)` closes a whole id.
Partial exits are emulated (close → pay → re-deposit) and `consolidate` is close-all → re-mint.

### FACT 5 — the Aerodrome CL pool surface (verified on pool `0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59`, WETH/USDC).

`slot0()` (`0x3850c7bd`) EXISTS → live read sqrtPriceX96 = 3914411962643458104250485, tick = −198319.
`liquidity()` (`0x1a686502`) EXISTS. `token0()` = WETH (18 dec), `token1()` = USDC (6 dec),
`tickSpacing()` = 100, `fee()` = 871. `gauge()` and `stakedLiquidity()` **revert on the pool** — the gauge is
reached via the Voter. Price convention sanity check: (sqrtPriceX96/2^96)^2 = 2.441034e-9 raw token1/token0;
× 10^(dec0−dec1) = ~2,441 USDC per WETH.

This is what the re-mint price floor was built on — and it was probed **before** the code was written,
deliberately, because C-2 is what happens when it isn't.

---

## Part 2 — The two findings that matter most

### D1 — principal custody was not enforced (the most important finding in either wave)

Round 1 shipped an immutable `payoutHash` per position and advertised, on seven surfaces, that funds could
only ever reach the user's locked payout address. **The hash bound the reward route only.**
`PositionVault.withdraw(..., recipient, ...)` paid an arbitrary address, and `openFor` let the operator name
itself as `user` — and in the wallet-less v1 the operator *is* the owner. **The operator could redirect
principal**, while README, ARCHITECTURE, V1-SIMPLE, SECURITY-REVIEW, both FEEDBACK docs and the depositor-
facing prototype all said it could not.

**Fix as implemented.** Principal may leave a position to exactly two destinations: the position owner, or
the RewardRouter (which enforces `payoutHash` and the rolling 24h budget). Anything else reverts
`RecipientNotPermitted`. `withdrawToPayout` became the normal user path; `claimPrincipal` pays the owner and
takes no recipient argument; `detachToOwner` lost its arbitrary destination; `openFor` refuses
`user == msg.sender` and emits `OpenedFor(positionId, operator, user, payoutHash, token, amount)` so an
off-chain watcher can detect the pattern from logs alone.

**Irreducible residual, accepted and disclosed:** an operator naming a *second address it controls* as `user`
is not detectable on-chain in v1. This is now stated verbatim on the deposit modal, the FAQ and the footer
rather than papered over. It is the strongest argument for shipping user-signed positions before real money.

### D2 — 50% LTV was un-shippable

At the liquidation threshold of 0.70 used in the repo, entry health factor is `0.70 / ltv`:
Sheltered 30% → **2.3333**, Steady 40% → **1.7500**, Working hard 50% → **1.4000**.
**1.40 is below the product's own 1.50 heads-up rung** — the position is born inside its own alarm — and below
the agent's 1.55 entry floor, so the agent would have *refused to open* the setting the UI was selling.

Max offerable LTV = `floor(0.70 / 1.55 × 10000)` = **4516 bps**; highest whole-percent stop = **4500 (45%)**,
entry HF **1.5556**, liquidation drop 36%. Even relaxing the warn rung to the 1.35 the copy promises puts 50%
exactly on 1.40 = 1.35 + hysteresis, with zero margin.

**Decision: 50% retired; "Working hard" is 45%.** Both prototypes, web, the agent and the docs were moved.

> **Open verification item, and the assumption I am least comfortable with:** the 0.70 threshold has no
> source or date anywhere in the repo and was never re-sourced from live Rhea in either wave. Every number
> above moves if the real parameter differs. **Verify against live Rhea before mainnet.**

---

## Part 3 — Wave-1 findings by lens (9 lenses, ~180 findings)

Severity: Critical = loss/lock of user funds or payout bypass; High = funds at risk under plausible
conditions or stuck flows needing admin; Medium = wrong accounting or UX-visible wrong numbers, or griefing;
Low = hardening; Info = notes.

### Lens A — reentrancy, token quirks, clone hazards (1 High, 1 Med, 7 Low, 9 Info)
- Re-entrancy surface was genuinely closed: hook-bearing token probes during open/withdraw/claimSelf(paused)/
  router.compound hit every Vault/Adapter/Holder/Router door and all were shut. Only `setRewardPreference`
  and `claimUnmatched` on one's own position succeed mid-flight (benign).
- **High:** exit liveness rested on the unverified assumption that the engine prunes `userPositions` on
  re-key — superseded by FACT 2 (it does prune) but the code had no defence if it did not.
- **Med:** the "non-blocking" reward forward used `try IERC20.balanceOf() returns (uint256)`, which does not
  catch return-data decode failure — a reward token with a silent fallback bricks withdraw/claim/compound.
  Fix: raw staticcall + returndata length check + validation in `setRewardTokens`.
- Lows: `DUST_THRESHOLD` decimals-blind (1e3 raw ≈ $1 of cbBTC vs 1e-15 ETH); de-allowlisting did not stop
  `increase`; `routeToZcash` not bound to the quoted address; `Deploy.s.sol` reverts when OWNER ≠ broadcaster
  and never calls `setRewardTokens`.

### Lens B — access control, roles, admin surface (4 Med, 7 Low, 7 Info)
- **Med:** vault owner could redirect 100% of every position's rewards via `setRewardRouter(EOA)` → `claimTo`,
  with no delay or timelock, while AUDIT.md pointed at a section documenting owner powers that did not exist.
- **Med:** if Snuggle pauses or bricks `engine.withdraw`, principal was stuck with **no rescue path at all** —
  owner calls, operator consolidate, position owner and holder were all dead ends.
- **Med:** "a misconfigured reward token cannot brick exit" was false two ways (empty-return `balanceOf`
  escaping the `try`; a max-balance token overflowing the checked `rewards +=` sum → Panic 0x11).
- Lows: per-tx route cap is not a rate limit (full drain in one block); `renounceOwnership` + pause =
  permanent freeze with no pauser role; adapter owner an immutable EOA that cannot follow a Safe handover.
- Verified OK: exits/claims/preference never pausable and owner-only; no position-owner reassignment path;
  `rescueToken` cannot reach held rewards; Ownable2Step inert until accepted.

### Lens C — arithmetic, fees, caps, idle, dust (1 High, 3 Med, 4 Low, 4 Info)
- **High:** incentive tokens (AERO) paid on a *full* exit are locked forever if not forwardable at that
  instant — `closed` ignores reward balances, every recovery path requires `active`, holder `exec` is
  adapter-only, no sweep existed. `Deploy.s.sol` never called `setRewardTokens`, so this was the launch state.
- **Med:** operator throttle bypassed via `router.compound` — 1-raw-unit compounds with no cooldown, each
  restarting the engine's 60s hold; measured **885 s of continuous exit blocking** per 15-compound chain.
- **Med:** the documented 10% Oilskin fee **did not exist on-chain** — 100% of rewards flowed on every path,
  and any future router-level fee was bypassable via un-pausable `claimSelf`/`withdraw`.
- **Med:** `MAX_ENGINE_POSITIONS` enforced inside `_liveIds`, which every exit path calls → >16 ids on a
  holder bricks withdraw/claim/consolidate permanently (and FACT 2 says real users hold 13–25).
- Verified by fuzz: `poolExposure == Σ shares` exactly under random sequences; withdraw split conservation
  and user-favourable rounding across USDC/cbBTC/WETH; router `totalHeld == Σ held == balance` every step.

### Lens D — Snuggle position lifecycle. **This is the answer to Matt's refund question.**

**Where partial-deposit refunds go — the definitive answer.** The code neither loops swapping nor pre-checks
the ratio. It makes **one** engine deposit call and books whatever bounces back as that position's **idle
balance on its own holder contract**. Nothing is lost: idle is paid out pro-rata on partial exits and in full
(plus AERO) on a full exit. It is never swept to the protocol.

But — as shipped in round 1 — it was **not redeployed at the next compound**, although the docs and FAQ said
it was (`increase` ignored idle). Only an operator `consolidate` (≤ 1/hour, and the agent never called it)
folded it, and each fold refunds again, so a slice was always idle. The position owner had no fold path.

Magnitudes: single-token deposits (open, top-up, compound) refund ≈ 0 — the engine swaps internally
(the fork evidence: 50,000 → 49,999.999998 USDC, no WETH back). The "0.88%" figure from a live receipt was a
*two-token* deposit. Two-token re-deposits (after any partial exit or consolidate) hand the engine the raw
close mix and it bounces the excess: **10% idle at a 55/45 mix, 40% at 70/30, 70% at 85/15, ~50% expected for
a random in-range exit**. Worst case found: 2,000 wei of WETH on a USDC-only holder (a public, predictable
address) made every partial exit and consolidate revert, and ~$0.004 of WETH parked ~100% of the position as
idle while `inRange` still reported "earning". Full exit always worked.

**Fix as implemented:** after **every** engine deposit, single-side-deposit whatever bounced back in the same
transaction; leftovers below a decimals-aware floor stay as attributed idle and are paid on exit; the false
"redeployed at next compound" claim was corrected in the docs.

Other lifecycle findings: an un-closable engine id locked the whole position (all-or-nothing loops → now
`try`/`catch` per id, paying what closed); any partial exit — even 1 bps — is a full close and re-mint with
the 60s hold restarting; `inRange` ≠ earning.

### Lens E — off-chain agent (4 High, 10 Med, 7 Low, 2 Info)
- **High:** the daemon **exited with code 0 after its first tick** — `startLoop` used `timer.unref()` and
  nothing else held the event loop. The entire protection ladder ran exactly once. Reproduced against the
  real entrypoint.
- **High:** `mapPortfolioToState` failed **OPEN** on the real Burrow view shape (`positions.REGULAR.borrowed`,
  no `healthFactor` field), on null portfolios and on map-shaped `borrowed` → Infinity → **HEALTHY with real
  debt**; it also never computed HF from prices.
- **High ×2:** recovery to HEALTHY was never persisted, so after a restart the next CRITICAL episode was
  deduplicated away; and bookkeeping writes gated dispatch, so a failed write skipped the protective action.
- **Med:** 1-Click quote echoes (`refundTo`, `refundType`, `originAsset`, `amount`) were never verified and
  `quoteHash` omitted them; `minAmountOut = 1` passed the "positive floor"; the refund address was the bare
  vault, not the locked payout.
- **Med:** `UpgradeExecutor` borrowed any amount ("abc", "−5", 100× collateral → HF 0.007) to any free-form
  address with no LTV or headroom check.
- Verified OK: band classification and monotonicity, claim gate and hard floor, keccak and ABI decoding
  (cast-verified), 15 s timeouts on both HTTP clients, no key or RPC-URL leakage in any log site.

### Lens F — yield service (3 Med, 8 Low, 4 Info) — **the maths checks out**
Six event topics and twelve selectors re-derived with an independent keccak; `f(w) = 2 − √(1−w) − 1/√(1+w)`
re-derived from the v3 amount formulas; every APR in the 2026-08-31 sample reproduced from raw chain words
for all 8 pools across decimals 6/8/18 and both token orderings; `lp-sim.py` re-run bit-identically; the
Monte-Carlo drag matches σ²/(4·f(w)) within 1.6 points; the 0.765 fee constant consistent everywhere.
**"Nothing qualifies" is true.**
- **Med:** a dead gauge RPC served the last sample (including a frozen `epochActive: true`) with `stale: false`.
- **Med:** single-sided refunds in the *other* token were dropped from entry principal → measured APR
  understated by 32 points on a 10-day position.
- **Med:** a `PositionWithdrawn` with short/empty data decoded to zero amounts and was served as a −3650% band.
- Low: a hard-coded 0.8% ZEC supply fallback against a measured 0.04%, and `lp-sim.py` shipping `SUPPLY = 4.0`
  — which overstated user yield by ~4 points in the published sample.

### Lens G — simple.html (7 Med, 16 Low, 14 Info)
- **Med:** `tickAccrue` applied the 43,200× demo speed-up linearly over unbounded `dt` — a 30-minute
  background tab multiplied debt 2–7×, drove the balance negative and fired the whole protection ladder with
  negative-dollar events. Even with the tab open and the price flat, Sheltered reached "full unwind" in 88 min.
- **Med:** `load()` trusted any `v:1` store — eight shapes crashed boot.
- **Med:** "See a live example" and Find-by-address silently **replaced the user's real position** in memory
  and storage.
- **Med:** closing and restarting the deposit modal mid-flight **credited the deposit twice** (7 ZEC → 14).
- **Med:** top-ups deployed new borrow into a pool that failed the gate, with an enabled CTA.
- Verified OK: width and delay on every card for every setting (123 checks), the gate rule, sign discipline,
  fee maths at 76.5% on earnings only, address forms, emissions-only language in source, DOM and tooltips.

### Lens H — index.html (1 High, 7 Med, 9 Low, 6 Info)
- **High:** the wizard's net-APY model flipped **positive** at widths ≤3.5% — 69 of 396 click-driven
  combinations positive, up to **+377%** — and at the one-click Aggressive preset cbBTC/USDC showed
  **+34.2% in green** where the repo's own Monte Carlo said −21%. The most dangerous single defect found:
  it invited a deposit into a position the project's own model says loses money.
- **Med:** 326 of 326 negative projections were painted green; a 100% LP withdrawal deleted the position's
  $45,000 debt while the preview said "debt unchanged" ($58k–$173k of phantom value per fuzz seed);
  Enter/Space on a focused Confirm created three positions from one deposit; −100 ZEC and 1e308 reached Confirm.

### Lens I — cross-cutting, shared, web, docs, CI (1 High, 9 Med, 10 Low, 5 Info)
- Shared crypto is **clean**: pure-TS SHA-256 matches NIST and node:crypto at every length 0–300;
  Base58Check rejects every typo, transposition, case-flip, homoglyph, off-by-one and neighbouring version byte.
- **High:** `RewardRouter` sent `min(claimed + held, cap)` rather than the quoted amount — a quote for 1,500
  routed 1,000, a quote for 300 routed 800. Short deposits become bridge refunds landing as unattributed
  vault balance that no code watches.
- **Med:** the "locked payout address / non-custodial" claims were not backed by code (→ D1);
  the on-chain `zcashAddress` was unvalidated, unbounded and owner-mutable; 8 of 8 tampered 1-Click quotes routed.
- **Med:** the web app had **no demo/mock label anywhere**, served "Your strategies" mock data to any visitor,
  and told users to "Send exactly N ZEC" to a mock address — saved only by that address's bad checksum.
- **Med:** `rangeWidthBps` meant total width in shared/contracts/web and half-width in simple.html and the
  docs — the seam that became FACT 3.
- CI triggered on `main` while the repo branch was `master`, and its contracts job would have failed cloning
  libs into an already-vendored `contracts/lib/`.

---

## Part 4 — Wave 2: four of the six round-2 fixes did not hold

Wave 2 re-tested the fixes rather than re-auditing from scratch. This is the most transferable lesson in the
whole exercise: **a green regression test proves the tested path, not the fix.**

| Round-2 fix | Wave-2 verdict | What was actually wrong |
|---|---|---|
| Agent fail-closed health mapping | **BROKEN** | A debt asset whose oracle multiplier reads 0 still valued debt at $0 → HF = +Infinity → **HEALTHY with $9,500 of live debt**. The new store cross-check could not catch it. |
| Daemon liveness watchdog | **WORSE THAN THE BUG** | It measured elapsed time, not progress. A healthy-but-slow tick was killed mid-unwind and the supervisor restarted into the same wall forever: 9 of 40 accounts at HF 1.01 ever assessed, 31 never. |
| Dispatch idempotency key | **BROKEN BOTH WAYS** | `ep-${Date.now()}` minted at dispatch and persisted after: a crash gave the restart a *different* key (double unwind), while one episode reused one key per action so a rung firing twice was deduped away (missed protection). The source comment claiming key stability was false. |
| UpgradeExecutor resume | **DOUBLE-BORROWS** | A crash between `rhea.borrow` returning and the txId persist, with the relayer not yet settled, made resume conclude "never landed" and re-issue — 2× the intended debt. |
| Yield `entryRefunds` | **MOVED** | Two `PositionCreated` in one tx each booked the full tx flows; an unrelated vault→owner leg counted as a refund → a served band p50 of **+36,496,350%**. |
| Contracts `_liveIds` redesign | **NEW HIGH** | It made "cannot enumerate" indistinguishable from "owns nothing": any `userPositions` revert made a full withdraw close the position, pay nothing, zero the principal and lock the funds, with every recovery door gated on `p.active`. |

Wave 2 also found, on the seams between the six areas fixed in parallel:
- The agent's `requireHeadroom` refused any borrow below HF 1.55 while shared, both prototypes, the web
  slider and the docs all offered 50% LTV (HF 1.40) — the product could not open its own top setting (→ D2).
- `index.html`'s Conservative width slider ran to **8100 bps** — 3,100 of 5,301 stops would revert
  `InvalidLpParams` — and labelled its maximum ±49.9% against a vault ceiling of ±28.4%.
- The correlated presets had been halved in **span** rather than half-width (→ FACT 3's 2356/784/150).
- simple.html applied the 10% fee to **losses** in live-band mode while `bands.ts` did not — 10 of 27 band
  cells disagreed — under a comment asserting the two rules were identical.
- Nothing canonicalized the payout string at `openFor`: the vault hashed raw calldata while the agent hashed
  the normalized form, so a trailing-newline paste locks a hash the agent can never match — and
  `PayoutHashMismatch` is non-retryable by design.
- `rebalanceDelayHours` (shared) vs `rebalanceDelay` (contract, **seconds**) with no converter anywhere.
- The fee chokepoint was path-dependent: the same reward paid 10% via `claim` and **0%** via `withdraw`,
  `sweepClosed`, or engine `autoCompound`.
- `detachToOwner` could be armed on a **healthy** position (two free owner `increase` calls 24h apart
  manufacture the 60s hold refusal at both the arm and the fire) and then hand the whole holder away.
- Two browser tabs on one origin destroyed a credited deposit and its locked payout address.
- The Working-hard ladder had **zero hysteresis** (warn = repay = 1.35): 13 warn/restore cycles in 6,000
  flat-price ticks, printing "HF back to 1.35 (above 1.35)"; and it was a one-way latch — after a full unwind
  a top-up redeployed $9,257 that no rung ever protected, HF falling to 0.53 with no events logged.
- 13 choice controls in index.html were keyboard-unreachable: a keyboard-only user could complete only
  Simple lending.

**The ABI seam broke twice.** The agent derived contract selectors from a written document rather than the
compiled artifacts, and later the price-band arguments landed after the agent had encoded the old signatures
— `scripts/verify-abi.mjs` (which diffs every selector, calldata layout and event decoder against
`contracts/out/`) caught it at 74/86. Eleven of the twelve mismatches were errors declared on the wrong
contract, so those revert paths were misclassified and would never have matched in production.
**That script, wired into the agent's own suite, is the durable fix — not the twelve corrections.**

---

## Part 5 — What round 3 built (all lost; this is the re-implementation spec)

Contracts: D1 principal custody as described above; index enumeration with a runtime-measured end-of-list;
`MAX_ENGINE_POSITIONS` gating deposits only; per-id `try`/`catch` close paying what closed; permissionless
`sweepClosed`; a two-stage `probeWithdraw` → `detachToOwner` escape hatch requiring a persistent, non-transient
engine refusal; `reactivateStuck` as a recovery door **not** gated on `p.active`; one internal `_payRewards()`
so the fee is path-independent; global + per-destination + per-position 24h route caps; role-based throttles
covering `compound`; refund folding after every engine deposit; a re-mint **price band**
(`minSqrtPriceX96`/`maxSqrtPriceX96` on withdraw/withdrawToPayout/consolidate) read from the pool's `slot0()`
and failing closed — deliberately a price band rather than a value floor, because a single-token remainder's
value is independent of price and a value floor would pass while the swap is robbed.
Final: **236 passed / 9 skipped**, green at `--fuzz-runs 5000` and 768 invariant runs × 98,304 calls.

Agent: real fail-closed valuation (four independent guards; non-empty `borrowedAssets` ⇒ `adjD > 0` or
UNKNOWN, property-tested over 4,000 adversarial portfolios); a **progress** watchdog with exponential backoff;
an idempotency key `mca:episode:dispatchSeq:action` from a monotonic counter persisted **before** first
dispatch, proved stable across crash-restart and distinct per rung firing; `requestId` passed into
`rhea.borrow` with an attempt marker; an absolute ZEC-price floor on 1-Click routing; a temp-file + `link()`
store lock. Final: **361 tests**, `verify-abi.mjs` 91/91.

Yield: staleness impossible to serve as fresh; refund attribution rebuilt (multi-position tx refused rather
than guessed); an absolute `|netApr| ≤ 20` bound so an absurd band is impossible by construction; the model
re-run at the preset widths. Final: **136 tests**.

Prototypes: bounded accrual; store validation; deposit idempotence; ladder hysteresis and re-arm; two-tab
safety; real Base58Check; keyboard reachability; the honest custody rewrite. simple.html **234 checks** +
123,261 fuzz checks over 5,400 stateful actions; index.html **56**; toggle **18**.

Shared/web: `entryHfForLtv`/`warnHfForLtv` from one liquidation constant; the offerable-LTV cap;
`RANGE_WIDTH_BOUNDS [150, 5000]`; `lpParamsToChain` as the only way to build the on-chain struct; a demo
banner on every web page. **38** shared + **22** web tests.

Docs: `PRE-AUDIT-2026-09-03.md` (round-2 ledger), `AUDIT-SCOPE.md` (the paid auditor's brief),
`CBZEC-2026-09.md`, and corrections to AUDIT/RISKS/FLOWS/ARCHITECTURE/TESTING/V1-SIMPLE.

---

## Part 6 — Process lessons (the ones worth keeping)

1. **Push every green commit immediately.** Rounds 2–3 were lost precisely because a verified, committed tree
   sat local while a push payload was prepared. Round 1 survived because it was pushed the moment it was green.
2. **Verify the external contract against the chain, not against your own mock.** The mock implements the
   interface you wrote; only the chain has the interface that exists. C-2 was invisible to a green suite.
3. **Probe before building on an assumption.** `slot0()` was confirmed live before the price floor was written.
   `userPositions` was not, in round 1, and that is the whole difference.
4. **Re-test fixes adversarially, as a separate wave.** Four of six round-2 fixes did not hold. A fix round
   that is never attacked is a hypothesis.
5. **Machine-check every seam between components.** `verify-abi.mjs` caught a real break that reading could not.
   The same applies to numbers shared across surfaces — pin them to one generated source and fail the build on drift.
6. **Never type a derived number.** Every typed ±, threshold and APR in this codebase was wrong at least once.
