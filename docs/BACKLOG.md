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
| **O-4** | `setSolanaRecipient` cannot tell a user's own token account from anyone else's — the router stores 32 opaque bytes (`contracts/src/router/StrategyRouter.sol`) | Base cannot verify a Solana ATA's owner. The mitigation is the UI deriving it and the user confirming; a contract-side fix would need an oracle or a signature scheme. **Name it in the audit RFP as a question for the firm** |
| **O-5** | A mismatched Circle message is refused for ever, quietly after the first log (`agent/src/solana/attestation.ts`) | The attempt cap does eventually abandon it. A permanent-vs-transient classification is the right fix and is a small change; it is noise, not risk |
| **O-6** | The reserve is checked at burn time only; the owner may withdraw it immediately afterwards (`solana/…/deposit_for_burn.rs`) | This is the documented design — `transfer_out` is the always-exit path and must never be gated. The keeper reports the shortfall. Recorded so no later reader mistakes it for an omission |

## 2 · The ladder and the entry record, from Part 3

| # | What | Why it waits |
|---|---|---|
| **L-1** | The owner's raw `account.exec` straight to the protocol bypasses the router, and therefore bypasses D9's re-record of the entry HF | It is the exit hatch: intercepting it means blocking it, which is worse. A stale record left this way is the owner's own doing. **Owed: a line of dashboard copy** saying the ladder follows actions taken *through Oilskin* |
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
| **D-2** | `docs/handoff/2026-09-12-cowork/` — an untracked inbound bundle in the working tree | The founder's to keep or remove; deletions are his (CLAUDE.md rule 7). It is the only thing standing between `git status` and clean |

## 6 · Test coverage the fuzzer cannot reach (`AUDIT-2026-09-11.md`)

Eight handler actions, each 10–30 lines, that the invariant Handler cannot currently reach: a dead gauge at
open time and the enumeration window's own-position residual; `increase` on either venue; a fixed
`withdrawAmount` and the per-venue exit gate under fuzz (`CollateralShort`, `ExitHfTooLow` on a second venue);
a venue switch for WETH; a single-grant `revoke`; the pool adapter's partial-fill and paying-short modes; the
engine's pause; and a `closeMany` on the direct venue that unstakes but cannot withdraw.

**Why it waits:** none of them changes a property the suite asserts today — they widen the *reach* of the
fuzz, not its claims. **Worth doing before the freeze**, because an auditor will ask what the invariants
actually explore, and "eight named gaps" is a better answer than a number of runs.

---

## What is NOT in this file

- Anything that can lose or lock funds, or let the keeper exceed its grant — those are fixed, not listed.
- Unbuilt scope. What is built and what is not is `docs/BUILD-PLAN-2026-09-12.md` §4; what is in beta and
  what is not is `docs/BETA-SCOPE-2026-09-13.md`.
- Polish. Copy, naming and UI refinements accumulate into one pass in the week before the freeze
  (`ROADMAP.md` rule 5), not here.
