# Internal security review — v0.5 (2026-08-06)

## Round 3: guarded fork suite re-run + a via-IR test-harness footgun

Re-ran the full fork suite (8 tests) against the live engine with the round-2
guards in place: **7/8 passed first try; the 1 failure was root-caused to the
test harness, not the protocol** — engine and adapter fully exonerated.

Fork-proven this round, on real Base liquidity:

- **Exposure cap live**: a $250k deposit against a $100k pool cap reverts
  `PoolExposureCapExceeded` in the vault (~230k gas) — the engine is never
  touched.
- **Slippage floor live**: demanding more USDC out than the pool can return
  reverts on the real engine close path.
- **Moderate-size economics**: a $50k single-sided open → 50% partial →
  full exit on Aerodrome WETH/USDC returned **49,999.999998 USDC of 50,000**
  (loss ≈ $0.000002) once timing was correct.

**T-1 (test-harness, would have masked/faked failures):** under `via_ir`,
solc may legally CSE repeated `block.timestamp` reads inside one function
(TIMESTAMP is transaction-invariant in real EVM), so a second
`vm.warp(block.timestamp + x)` can silently re-warp to the SAME second. Our
$50k fork test tripped exactly this: the post-partial warp was a no-op, the
full exit executed 0s after the re-deposit, and the engine *correctly*
reverted `MinimumHoldTimeNotMet`. Diagnosis confirmed two ways: (1) the
engine's verified source — `MIN_POSITION_HOLD_TIME` is a flat
`1 minutes` constant compared against per-position `depositTimestamp`
(`_main.sol:41,534-544`; live value 60 via `cast call`); (2) an on-fork probe
of the same $50k sequence succeeded at +90s. **Fix:** every multi-warp test
now derives all warp targets from a single cached timestamp read
(`EngineFork.t.sol`, `ScenarioMatrix.t.sol`) — warps can no longer be
silently elided by codegen. Full local suite re-verified green after the
change.

Product note (UX, feeds the app + agent): the engine's 60s hold restarts on
*every* deposit — including the internal re-deposit that implements partial
withdrawals. After any deposit **or partial withdrawal**, the remainder is
untouchable for 60s. The UI surfaces this as a short cooldown; the agent
treats `MinimumHoldTimeNotMet` (`0xb586467e`) as retry-after-60s, never as an
error.

## Round 2: fuzzing, invariants, adversarial + a fork-caught economic finding

Testing this round: an **8-invariant stateful suite** driving ~10,000 random
action sequences per invariant (≈82k state transitions) over every user- and
operator-controllable action; a **540-scenario enumerated matrix**
(pool × range × delay × pref × size × withdrawal-pattern), each asserting exact
value conservation; **62 agent tests** including hostile-RPC, hostile-1Click,
MEV/malicious-quote, and extreme-price grids; and **8 fork tests** against the
live Base engine.

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| F-4 | **Medium** (fork-caught) | Large deposits relative to pool TVL incur real AMM price impact (>1% round-trip at ~2.5% of pool TVL); our close-and-reopen partial-withdraw makes the kept portion cross that impact again | (1) **Per-pool exposure cap** (`maxDepositPerPool`, tracked `poolExposure`) bounds any pool's concentration; (2) **withdrawal slippage floor** (`minOut0/minOut1`) lets the owner/agent set a hard minimum, reverting on MEV sandwich or deep impact. Both fork-proven. |
| F-5 | Low | `withdraw` had no caller-supplied slippage protection — a sandwich on the engine close/re-deposit could silently reduce payout | `minOut0/minOut1` params on `withdraw`; `SlippageExceeded` revert; `poolTokensOf` view so the UI maps mins to the right assets |

**Invariants proven to hold across the whole search space:** USDC conservation
(nothing created/destroyed), adapter/vault never hold idle funds, matched token
never stranded in the router, `active == (shares>0)`, no share inflation,
intents payouts bounded by fees (principal never routed as reward).

**Adversarial results:** read client fails loud on every hostile transport
(500/429/malformed/JSON-RPC error) — never returns plausible-but-wrong data;
reward executor refuses every tampered quote (recipient swap, wrong dest asset,
poison deposit address); health bands proven monotonic across HF 0.5→5.0; the
claim engine never claims at a net loss across a 240-cell cost grid.

### On the 1-minute hold (UX)

The engine enforces a 60-second minimum hold after any deposit — its own
flash-loan/JIT-liquidity protection. It **cannot be removed** (third-party
contract) and shouldn't be (it protects the pools our users deposit into). It's
invisible to real users, who hold for days; it only appears if someone
withdraws seconds after depositing. The one place it touched our UX — a partial
withdrawal's re-deposit restarting the clock on the *remaining* funds — is now
mitigated by the exposure cap (fewer forced large partials) and surfaced: the
agent treats the revert as retry-later and the UI shows the unlock time. Fighting
it further (e.g. wrapping deposits to mask it) would strip protection from users,
so we surface it honestly instead.

---

# Internal security review — v0.4 (2026-08-06)

Self-audit by the building agent. **This does not replace a third-party audit**
— commission one before mainnet TVL (note: the MaxFi/Snuggle engine itself
discloses AI-only audits so far; weigh that in position limits).

## Fixed this round

| ID | Severity | Finding | Fix |
|----|----------|---------|-----|
| F-1 | **High** (fork-caught) | Partial-withdraw re-deposit called the engine's dual `deposit` with one side = 0 when a closed position returned single-sided funds → CL pool reverts minting zero liquidity → **partial withdrawals would brick** whenever price hadn't crossed the range | Branch to `depositSingleSided` when only one token remains; mock updated to mirror engine behavior (`ZeroLiquidityMinted`) |
| F-2 | Medium | Unbounded engine-position array per vault position (`increase` appends) → gas-DoS of withdraw/claim loops | `MAX_ENGINE_POSITIONS = 16` cap + `TooManyEnginePositions` |
| F-3 | Low | No local bounds on user LP params (engine would revert late, wasting gas, and future engines may not) | Vault rejects rangeWidth outside 10–5000 bps and delay > 30 days (`InvalidLpParams`) |

## Engine behaviors that constrain us (fork-verified)

- **`MinimumHoldTimeNotMet` (0xb586467e)**: 1-minute minimum hold after any
  deposit — and our partial-withdraw re-deposit **restarts the clock**, as does
  every compound/increase. Agent must treat this revert as retry-later;
  UI should surface "withdrawals available ~1 min after last deposit".
- Fees route through the engine with **15% performance fee** before reaching us.
- `ref` (referral) locks on first deposit per depositor — adapter passes the
  treasury; deploy adapters fresh if the referral must change.

## Accepted risks / open items (unchanged from RISKS.md, restated)

1. **Operator custody over in-flight funds (High, by design, v1 — corrected
   2026-09-02)**: `openFor`/`increase` let the single trusted operator assign
   idle vault balances to positions — including to a position the operator
   itself owns, which it can then withdraw anywhere after the engine's 60s
   hold. The earlier wording here ("never exfiltrate — funds stay in user
   positions") was **wrong**: between bridge arrival and `openFor`, and for
   any idle top-ups, the operator hot key is effectively full custody. The
   internal audit (docs/PRE-AUDIT-2026-09-02.md, H-2/A-01) both demonstrated
   the exfiltration and showed the same key either can or cannot run the
   protection ladder depending on who owns positions — the design must pick
   one. Mainnet gate: deterministic per-user deposit forwarders as the
   intents recipient (`openFor(user)` pulls only from `forwarderOf(user)`),
   plus an on-chain per-position `payoutRecipient` locked at open with
   `withdraw`/`deleverage` constrained to it — then a compromised operator
   can misTIME actions but cannot redirect funds. Until that lands, this line
   is the product's honest custody disclosure. Mitigation today: one operator
   key, event trail, caps.
2. **Reward routing quote binding (Medium)**: on-chain can't verify the 1-Click
   deposit address pays the user's zaddr. Agent hard-verifies + quoteHash audit
   trail + per-token caps; rewards only, never principal.
3. **claimStakingRewards-vs-harvest probing (Low)**: adapter try/catches the
   staking claim then falls back to harvest. If a future engine version makes
   `claimStakingRewards` silently no-op on unstaked positions, claims would
   under-collect (never lose funds). Re-verify on engine upgrades.
4. **Re-deposit slippage (Low/Medium)**: the engine applies its own TWAP +
   slippage config on deposits; our re-deposit trusts it. Fork round-trip loss
   assertion (>90% back) guards regressions in CI.
5. **rewardTokens list is owner-set (Low)**: a malicious/broken token in the
   sweep list could revert claims. Owner-gated; keep the list short and vetted.
6. **SimpleMultisig is TESTING ONLY** — no signature replay concerns (tx-store
   model), but no timelock, no guard modules; mainnet admin = Safe + timelock.

## Standing protections (verified by tests)

ReentrancyGuard on all vault entrypoints; withdrawal exempt from pause;
operator cannot move principal to arbitrary addresses; adapter callable only
by vault; forceApprove (USDT-pattern safe) with resets; allowlisted adapters +
tokens; per-token routing caps; principal never transits the RewardRouter.

Suites: 41 unit/fuzz (local) + 3 fork tests against the live Base engine.
