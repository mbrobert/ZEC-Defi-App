# Backlog — everything deliberately deferred, in one place

`docs/ROADMAP.md` rule 3: *a bug is "safety" only if it can lose or lock a user's funds, or let the keeper
exceed its grant. Everything else waits.* This file is where "waits" is written down, so that deferring is a
decision with a record rather than a thing that quietly happens. It is **not** a wish list: every entry was
found by a pass that could have fixed it and chose not to, and each says why.

Nothing here is a safety defect. Safety defects are fixed the day they are found, with a regression test, and
recorded in a dated `docs/AUDIT-*.md`. Six were found and fixed on 2026-09-13 alone.

Abbreviations: HF = health factor; LTV = loan-to-value; LP = liquidity provision; CCTP = Circle's
Cross-Chain Transfer Protocol; ATA = associated token account; RPC = remote procedure call.

**Status:** created 2026-09-13 at `59e3198`, from the observations already recorded in the audit ledgers.
Add to it from a pass; remove from it when the thing is done, naming the commit.

---

## 1 · Cross-chain, from `AUDIT-2026-09-13.md` Part 1

| # | What | Why it waits |
|---|---|---|
| **O-1** | A bridged rung crosses the *whole* need while the Solana-side USDC reserve sits unspent (`agent/src/solana/dispatcher.ts`) | Spending the reserve first would be cheaper and faster, but the reserve exists to make the repay rung atomic on Solana; draining it to save a bridge hop is a design change, not a fix, and it needs the Monte Carlo that sizes the reserve first |
| **O-3** | The keeper pays the delivery's rent and CCTP fee for the user, with no accounting (`agent/src/solana/delivery.ts`) | Real money, small amounts, and nothing to reconcile it against until a fee model exists. **Revisit before any launch with more than the 25 allowlisted addresses of D8** |
| **O-4** | `setSolanaRecipient` cannot tell a user's own token account from anyone else's — the router stores 32 opaque bytes (`contracts/src/router/StrategyRouter.sol`) | Base cannot verify a Solana ATA's owner. The mitigation is the UI deriving it and the user confirming; a contract-side fix would need an oracle or a signature scheme. **Named in the audit RFP as Q-A** (`docs/RFP-EVM-2026-09-13.md` §4b, 2026-09-16) |
| **O-6** | The reserve is checked at burn time only; the owner may withdraw it immediately afterwards (`solana/…/deposit_for_burn.rs`) | This is the documented design — `transfer_out` is the always-exit path and must never be gated. The keeper reports the shortfall. Recorded so no later reader mistakes it for an omission |

## 2 · The ladder and the entry record, from Part 3

| # | What | Why it waits |
|---|---|---|
| **L-2** | On Solana, `deposit` does not re-record the entry HF (`withdraw`, `repay` and `close_position` do) | A deposit only *raises* the HF, so the record stays lower than reality and the ladder is tighter than it needs to be — the safe direction, costing the owner nothing. Reading an HF there would mean refreshing the obligation inside `deposit`, which the instruction otherwise does not need |

## 3 · The keeper's feed policy, from Part 2

| # | What | Why it waits |
|---|---|---|
| **F-1** | The staleness bound is derived once, at startup, and never re-probed. A feed whose cadence changes during a long run is not re-measured | The escalation path catches it — three consecutive UNKNOWN valuations tell the owner. Re-probing on a stale streak is a judgement about how much to trust a feed that has just gone quiet, and belongs in a slice of its own |
| **F-2** | For a **deviation-only** feed such as Base ZEC/USD, the bound is still a volatility figure, not a liveness bound — no measurement can bound a heartbeat that has never fired | Recorded in `VERIFIED-BASE-FACTS.md` Addendum 17. It is why `ChainlinkOracleAdapter.maxAge` is unchosen (§5 below) rather than derived |

## 4 · The forecast, from Part 4

| # | What | Why it waits |
|---|---|---|
| **Y-1** | `cell.poolAvailableUsd` loses precision above 2^53 base units — about **$9 billion** at USDC's 6 decimals | Display-only, and far above any pool in scope. Recorded so the gap is not mistaken for an oversight |

## 5 · Decisions the founder has deferred, deliberately

| # | What | State |
|---|---|---|
| **D-1** | `ChainlinkOracleAdapter.maxAge` — an **immutable constructor parameter with no chosen value** | Founder's call, 2026-09-13: **leave it until later.** Nothing is blocked: cbZEC is registered-disabled (D3), the adapter is deployed by no script, and `VERIFIED-BASE-FACTS.md` Addendum 17 records the three honest ways to choose it. **The contract cannot ship without it** |

## 6 · New observations, from the coverage pass of 2026-09-16 (`AUDIT-2026-09-16.md`)

The eight reaches this section used to list are **done** — see the Done table below. Widening the
fuzz to them surfaced two things, neither of which is a safety defect and both of which are pinned by
a test so they cannot change silently.

| # | What | Why it waits |
|---|---|---|
| **G-1** | `tokenBudgetOf` is the one grant view that does not consult expiry, so after `revoke` it still reports the full budget while `grantOf` correctly says `active: false` (`contracts/src/account/OilskinAccount.sol`) | The authorisation path reads the expiry `revoke` zeroes and the keeper IS refused, so nothing can exceed a grant. Not user-visible either: `web/lib/reads.ts` carries `grantOf`'s `active` and `KeeperPanel` gates the budget rows on it. An integrator reading `tokenBudgetOf` alone would over-report — erring towards alarming a reader rather than towards trusting a dead keeper. It is a one-line change to an audited contract, for a reporting gap with no user-visible effect, on a tree heading for a freeze. **Named in the audit RFP as Q-C** (`docs/RFP-EVM-2026-09-13.md` §4b) |
| **C-1** | The one-click Close (`StrategyRouter.unwind`) reverts WHOLESALE when a two-book account holds one position that cannot be withdrawn, instead of degrading the way `closeMany`'s `failed` array does (`contracts/src/router/StrategyRouter.sol`) | Giving `unwind` partial-failure tolerance is a change to money movement across a trust boundary, and a product decision about what a half-finished Close should leave behind — not a thing to decide inside a coverage pass. No funds are lost or locked: the owner's raw `exec` exit works in the same state, asserted in the same test. The refusal is not only a mock switch — a real `decreaseLiquidity` reverts on its own slippage check against a moved price. **Founder's and the auditors' call** — named in the audit RFP as Q-B; the scenario is `test_obs_singleCloseUnderARefusingPositionManager` |

## 7 · `npm run status` and the prototype suite (observed 2026-09-16)

| # | What | Why it waits |
|---|---|---|
| **T-1** | The Prototypes row comes back red under `npm run status` while the same command alone is green with exit 0. Seen three times on 2026-09-16: twice as `verify-advanced 114 / 2 failed` (the two timing-sensitive checks — the corrupted-store probe and the 390 px overflow probe), and once as **`OUTPUT NOT PARSED (exit 1)` after 1,069 s**, against a standalone run of ~31 s — so that third one HUNG rather than failing an assertion | Not a product defect and not a test that is wrong about the product: the suite passes, repeatedly, run by itself. `scripts/status.mjs` runs its suites sequentially, so this is not status racing itself; the likeliest cause is the Playwright-driven prototype run being sensitive to a machine that has just finished six other suites, and the 17-minute case points at a hang (a port, a browser that did not exit) rather than a slow assertion. Diagnosing it means instrumenting the prototype harness's own timeouts, which is a slice of its own. **Worth doing before the freeze** — a status command a reader cannot trust is worse than no status command, and this is the file the repo points auditors at. Until then: re-run the prototypes alone and check the exit code, never the printed counts alone. **Partly guarded 2026-09-16:** every suite in `scripts/status.mjs` now carries a timeout (20 minutes by default, 5 for the prototypes against a measured 31 s) and a run that passes it is killed and reported as `TIMED OUT` by name, rather than as an unparseable failure a reader would go and fix a parser for. That bounds the cost of the hang; it does not explain it. **Instrumented 2026-09-18** — the slice this row asked for, so the next occurrence explains itself instead of leaving a count. (1) The harness runner (`prototype/test/_harness.mjs`) keeps the name of the last check that completed and, if none completes for 90 s (`OIL_STALL_S`; the fuzz suite gets 300 s because one check there is 5,000 actions inside one `evaluate`), prints `<suite>: STALLED … last completed: "<check>"` and exits 124 — Playwright's own exit handler then kills the browser, proven by tripping it: no Chromium left behind. It also lists every gap of ten seconds or more between checks, so a slow-but-green run says where the time went, and every summary line now carries the suite's seconds. (2) `run-all.mjs` runs each suite under its own 300 s ceiling (`OIL_SUITE_TIMEOUT_S`) and reports a timeout **by suite name** with its wall time. (3) `scripts/status.mjs` keeps a red suite's whole output in `<tmpdir>/oilskin-status/<area>.log` and names the file in the terminal and in `STATUS.md` — until now it captured that output and dropped it, which is why the three red rows of the 16th left no failing check's name and why this row can still only guess which two checks they were; its prototype parser reads the STALLED and TIMED OUT lines and puts the last completed check in the row. Beside the instrumentation, the 390 px overflow probes (four in the Simple suite, three in Advanced) no longer sample once after a fixed 80–200 ms sleep: `settledWidths` polls for up to 3 s, and a layout that never settles fails by the same name with the same numbers. The corrupted-store probe is untouched — both pages set the boot note synchronously inside `load()`, before `window.__oil` exists, so nothing in it is timing-sensitive on the page side; the kept log will say what it actually was. **Still open:** the hang is legible now, not explained. The row closes when a run reproduces it under this harness and the cause is named, or when twenty consecutive `npm run status` runs have not reproduced it. Alone on 2026-09-18: **130 · 116 · 62 · 6 in 29.8 s**; the first `npm run status` under the new harness is recorded in `CHANGELOG.md` |

---

## Done — removed from the lists above, kept here so the record is not just an absence

The rule at the top of this file is "remove from it when the thing is done, naming the commit". A row
that simply vanishes leaves a reader wondering whether it was fixed or forgotten, so each one moves
here first with what closed it. The commit is the one that removed the row — `git log --oneline --
docs/BACKLOG.md` finds it, and `git log -S` on the regression test's name finds it exactly.

| # | Was | Closed | Regression test |
|---|---|---|---|
| **O-5** | A mismatched Circle message failed the rung correctly but was then resumed and the identical error re-logged every tick until the attempt cap | **2026-09-16.** `SolanaDispatchResult`'s `FAILED` arm gains `permanent?`, the same word the `REFUSED` arm already used; the dispatcher sets it on `mismatch`, and the monitor abandons a permanent failure on the first tick with one escalation instead of running it to `maxDispatchAttempts`. Circle is deterministic about a nonce — the message it returns for one is the message it keeps returning — so every retry was noise in front of the single line a person has to act on | `agent/test/solana-monitor.test.ts`, "a PERMANENT failure is ABANDONED on the first tick and never retried"; `agent/test/bridge-stages.test.ts`, the mismatch case now asserts `permanent`, and a companion case asserts the failures retrying *can* fix are **not** marked permanent, so the flag cannot widen into a way to abandon a rung during an outage |
| **L-1** | The owner's raw `account.exec` bypasses the router and so bypasses D9's re-record of the entry HF. **Owed: a line of dashboard copy** | **2026-09-16.** The hatch stays open — intercepting it would mean blocking the owner from their own funds — so the disclosure is the mitigation, and it sits beside the rungs rather than in a document nobody opens. `HealthBand` renders it under the ladder line, and the Advanced prototype carries the same sentence | `web/e2e/demo-flow.spec.ts`, the dashboard case asserts `ladder-scope` says "through Oilskin" and "Oilskin does not see those borrows and repayments" |
| **D-2** | `docs/handoff/2026-09-12-cowork/` — an untracked inbound bundle in the working tree, the only thing between `git status` and clean | **2026-09-18.** The directory is gone from the working tree — the founder removed it; every file in it was already in the repo at its real path. `.gitignore` still carries the `docs/handoff/` line that kept it out of `git status` meanwhile — harmless, and the founder's to drop. `git status` is clean | none — nothing to regress |
| **§6, all eight** | Eight handler actions the invariant Handler could not reach, named by letter in `AUDIT-2026-09-11.md` W3-MED-3: a dead gauge at open time and the enumeration residual; `increase` on either venue; a fixed `withdrawAmount` and the per-venue exit gate under fuzz; a venue switch for WETH; a single-grant `revoke`; the pool adapter's partial-fill and paying-short modes; the engine's pause; and a `closeMany` that unstakes but cannot withdraw | **2026-09-16.** Nine actions added (b splits across two venues) and registered; one new hook on a test double (`MockSlipstreamNpm.setRefuseDecrease`) because the gauge's own refusal reaches a different state. Deep sweep re-run at 1,500 × 120 = **180,000 calls, 2,150 reverts, 0 failures**. Two observations fell out — G-1 and C-1 above — which is what the reach was for | `contracts/test/invariant/Invariants.t.sol`, `test_theEightNamedGapsAreReached`: each gap proved by the EFFECT of its branch, not by the call returning, because an action that no-ops widens nothing and a run count cannot tell the difference |

## What is NOT in this file

- Anything that can lose or lock funds, or let the keeper exceed its grant — those are fixed, not listed.
- Unbuilt scope. What is built and what is not is `docs/BUILD-PLAN-2026-09-12.md` §4; what is in beta and
  what is not is `docs/BETA-SCOPE-2026-09-13.md`.
- Polish. Copy, naming and UI refinements accumulate into one pass in the week before the freeze
  (`ROADMAP.md` rule 5), not here.
