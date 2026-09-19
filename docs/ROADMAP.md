# Roadmap — beta into audit before 2026-12-31

The plan of record for *what* is `docs/BUILD-PLAN-2026-09-12.md`. This file is
*when*, *how we know*, and *what gets cut when a date is at risk*. Founder's
goal, 2026-09-13: **beta code frozen and handed to auditors before the end of
the year.** Abbreviations: HF = health factor; LTV = loan-to-value; CCTP =
Circle's Cross-Chain Transfer Protocol; RFP = request for proposal; LOC = lines
of code.

## 0 · The one number that decides the year

Top-tier audit firms quote **4–12 weeks from first inquiry to kickoff**
(`docs/AUDIT-SHORTLIST-2026-09.md`). Nothing in the code is the binding
constraint on "in audit before December 31" — **the calendar is**. Inquiries
sent in week 1 put kickoff between mid-October and mid-December. Inquiries sent
in November do not.

> **The single highest-leverage action on this roadmap costs nothing and takes
> an afternoon: send the inquiry emails this week**, with "code freeze expected
> 2026-12-11" stated. Everything else has slack. This does not.

## 1 · Where we actually are (re-measured 2026-09-13 at HEAD `7b90995`)

**Every suite's command and today's count live in one place: `docs/TESTING.md`'s
summary table.** They are deliberately not repeated here. This section used to
carry its own copy, measured at `d2f7760`, and by the end of that same day every
number in it was wrong — contracts 388 → 433, the ABI seam 425 → 444, shared
85 → 99, the keeper 269 → 316, web 180 → 199, the Solana localnet 26 → 36. Rule 7
below is about `TESTING.md`; it applies to this file just as much.

Which workstream is where is `docs/BUILD-PLAN-2026-09-12.md` §4, reconciled
against `git log` at `18c8684`. In one line: **A1–A9 and B1–B6 have all shipped
code, and the cross-chain loop (D6) is now built on both chains and in the
keeper** — A5.1 `e931bc0`, B3.1 `1bdbe63`, A5.2 `b369e81`, Stream C `2868e7e`.
A8 closed at `dfa6e00`; the launch parameters are decided (D8, `0f04137`); both
RFP packages are written and re-measured at the current tree (`16cf235`,
`9a97ed2`); the audit inquiries went out on 2026-09-13.

**Not done — and this is the whole remaining list:**

1. **The Base Sepolia deploy itself** (founder's key). The only H1 item left.
2. **Beta scope signed off** — `docs/BETA-SCOPE-2026-09-13.md` is drafted and
   waiting on the founder to confirm or amend it.
3. **The cross-chain loop's operational half.** The code is built; **nothing has
   crossed a chain.** Three things are missing, and two of them are the founder's:
   a process that holds a Base key beside the Solana one (`runSolanaKeeper` takes
   a `baseBurner` and is given none, so a linked pair's rungs 3–4 quietly take the
   Solana-only path), the address lookup table both cross-chain transactions need
   (the delivery measured 1,264 bytes against the 1,232 legacy limit), and the run
   end to end on devnet ↔ Sepolia. Valve date **2026-11-13** (§3).
4. **Two questions behind that loop that are not code.** Nothing yet *chooses*
   Fast over Standard when the Fast allowance is exhausted; and the reserve —
   today the rung-2 requirement, 4.11 % of the debt at a 1.625 entry — has never
   been sized against a real ZEC drawdown. Both are
   `docs/CROSSCHAIN-RUNBOOK-2026-09-13.md` §5.
5. **The founder's own walk-through**, end to end on Sepolia and on localnet,
   with what felt wrong written down (H2).
6. **The H3 items**: one internal audit wave over everything merged since the
   last, the `beta-audit-1` tag, the RFP packages sent at that hash, and the
   lawyer's read on `AUDIT-SHORTLIST` §5.

## 2 · The four horizons

Each horizon's exit criteria are **binary** — true or false on the date, no
partial credit, no "nearly". Each carries a **backstop**: the thing that gets
cut if the criteria are not met, decided in advance so it is not re-litigated
under pressure.

### H1 — one week · **Friday 2026-09-18**

*Theme: start the audit clock, and put the thing on a testnet.*

- [x] **Audit inquiries sent** — founder, **2026-09-13**. This was the one item
      with no slack (§0); the clock is running. Kickoff windows from here:
      mid-October at the fast end, mid-December at the slow end.
- [ ] Base Sepolia deployed; `docs/DEPLOYMENTS.md` table filled; the 3 skipped
      Sepolia e2e tests **run and pass** (founder deploys, Claude Code verifies)
      — **the only H1 item left**, and the prerequisites are in
      `docs/DEPLOY-SEPOLIA.md` (its §5.2 numbers were wrong until 2026-09-13:
      they carried the superseded 1.55 floor and the deleted 50 % cap)
- [x] Uncommitted Solana keeper work committed; `git status` clean — nothing
      outstanding but the untracked `docs/handoff/` bundle, which was the
      founder's to keep or remove; **gone by 2026-09-18** (`BACKLOG.md` D-2, Done)
- [x] **Reconciliation posted** — first at `57d1670`, re-verified against `git log`
      at **2026-09-13 / `18c8684`** in `BUILD-PLAN` §4 and its preamble (the plan
      of record carries it; a separate file would only rot beside it). §6's grep
      list now returns **zero on live files** — the last one was a comment in
      `lp-sim.py` (`87a6f72`)
- [ ] Beta scope agreed in writing — the "in" list and the "not in beta" list,
      drafted in `docs/BETA-SCOPE-2026-09-13.md`, signed off by the founder

**Backstop:** if inquiries are not out by 2026-09-18, the end-of-year goal is
already at risk and the roadmap is re-cut that day, not in December.

### H2 — one month · **Friday 2026-10-16**

*Theme: everything in scope exists and the founder has driven it himself.*

- [x] Cross-chain: A5 receiving side on Base (`openLpOnly`, CCTP
      `mintRecipient` = the user's own account) built, Anvil fork green —
      **built 2026-09-12** (`e931bc0`, A5.1); the fork suite burns native USDC
      through Circle's real messenger at block 51,222,568 (**13 / 13**,
      `docs/TESTING.md`). Ticked 2026-09-18 on reconciliation against `git log`
- [x] Solana `depositForBurn` to the user's Base account, localnet green —
      **built 2026-09-12** (`1bdbe63`, B3.1): one CPI into the cloned Circle
      program with the Account PDA as burn authority; localnet **36 passing / 0
      failing** with the burn's message decoded as Circle would attest it
- [x] Pool-size gate live in the yield service (refuse a borrow the Kamino pool
      cannot fund below threshold) — **live since 2026-09-12** (`67307df`, B5
      part 1): `/v1/solana/borrow` refuses `pool_cannot_fund` from Kamino's own
      reserve read (`services/yield/src/solanaBorrow.ts`, pinned by
      `services/yield/test/solana-borrow.test.ts`)
- [ ] Founder has walked the manual test script **end to end on Sepolia**
      and on localnet, and written down what felt wrong
- [ ] At least two audit quotes in hand, one per chain
- [x] Copy pass: the two disclosures (bridge/privacy, Circle) in the deposit
      flow; banned-words test green — the bridged-token and Circle-freeze
      disclosures sit in the Solana wizard (`937d4fa`, `web/lib/solana/copy.ts`)
      and the custody note on the Base side (`b9849aa`); `web/test/copy.test.ts`
      scans `app/`, `components/` and `lib/` and is green inside the web unit
      count in `docs/STATUS.md`

**Backstop:** no new features after this date without removing one. If A5 is
not building by 2026-10-16, the scope valve (§3) opens early.

### H3 — three months · **Friday 2026-12-11 — HARD FREEZE**

*Theme: stop building.*

- [ ] Cross-chain end to end on Solana devnet ↔ Base Sepolia, or formally cut
- [ ] Internal audit wave over everything merged since 2026-09-12, findings
      fixed, regression tests in `contracts/test/audit-regressions/`
- [ ] Every suite green, counts quoted in `docs/TESTING.md`
- [ ] Freeze commit **tagged** `beta-audit-1`; RFP packages sent at that hash
- [ ] Launch parameters written down: deposit cap, allowlist size, day-one
      funds at risk (sizes the audit and any bounty)
- [ ] Lawyer's read done on the three items in `AUDIT-SHORTLIST` §5

**Backstop:** 2026-12-11 is not negotiable. Anything unfinished ships as v1.1
*after* audit. A moving target is the one thing that reliably wastes an audit
fee — firms price a fixed hash, and re-scoping mid-review costs weeks.

### End of year · **Thursday 2026-12-31**

- [ ] Two firms engaged at the tagged hash, kickoff dates in writing
- [ ] Bug bounty scoped (percentage of funds-at-risk at the launch cap)
- [ ] 2027 launch plan one page: audit → fix round → re-review → capped launch

Then 2027: fix rounds, re-review, and a guarded launch behind the cap and
allowlist. Launch is not an end-of-year goal and never was.

## 3 · The scope valve — decided once, in advance

The cross-chain loop (founder's decision D6) is the largest remaining piece and
the one that doubles the audit surface on *both* chains. It is therefore the
designated valve.

**Decision date: Friday 2026-11-13.** On that date, if the loop is not running
end to end on devnet ↔ Sepolia with the reserve rule enforced, it is **cut from
beta** and ships as v1.1 after the audit. Cutting it does not cost the product
anything a user can see today: the Base gate refuses every pool at current
emissions anyway, so the loop's destination is not yet worth reaching.

This is written down now so that in November it is a checkbox, not an argument.

> ### The valve was closed early — founder, 2026-09-14 (D11)
>
> *"These things need to be included in beta: cross chain loop, perps too."* The
> loop is **in beta**, so this valve no longer decides its fate. That is a
> defensible call: the code is built on both chains, internally audited
> (`AUDIT-2026-09-13.md` Part 1), and **already inside both RFP packages' scope**,
> so including it adds nothing to the audit. What is left is a keeper process
> holding two keys, an address lookup table, and one end-to-end run.
>
> **Closing a valve means keeping a fallback, or the November argument simply
> moves.** The fallback, decided now: if the devnet ↔ Sepolia run has not passed
> by **2026-11-13**, the loop **ships disabled behind a flag** at the freeze —
> audited as code, off in the product — rather than the freeze moving. Nothing
> has crossed a chain for real yet, and that is the one item that can still
> surprise us.
>
> **Perps is the new valve.** It is accepted in principle and is a *third chain*
> (HyperEVM — there is no ZEC perp on Base), roughly the size of the Solana
> module, landing in the last quarter before a freeze that is not moving.
> `docs/PERPS-FEASIBILITY-2026-09-14.md` prices it, names the four options and
> recommends two together: put it in beta, **tell the audit firms this week while
> they are still scoping**, and take the Morpho venue out of beta scope to pay for
> the surface. Its own decision date is **2026-11-13** as well: not building by
> then, and it is v1.1.

## 4 · Standing rules that stop the circling

1. **The audit clock is the master clock.** Once a kickoff date is booked,
   everything schedules backwards from it.
2. **Not-on-the-roadmap work needs a trade.** Building something new means
   naming what comes off.
3. **Non-safety bugs go to `docs/BACKLOG.md`** — which now exists (created 2026-09-13) — not to today. A bug is "safety"
   only if it can lose or lock a user's funds, or let the keeper exceed its
   grant. Everything else waits.
4. **Two-strike rule.** Two failed attempts at the same fix → stop, write up
   what was tried, ask the founder. No third attempt unprompted.
5. **Polish is batched.** Copy, naming, and UI refinements accumulate into one
   pass in the week before freeze — never inline, never mid-slice.
6. **Research goes to Cowork in batches**, not one question at a time, and never
   for something already in a `VERIFIED-*-FACTS.md` file.
7. **Docs stop growing inline.** `docs/TESTING.md` rows have become multi-page
   changelogs inside table cells; that file is now expensive to read and is read
   often. History moves to `docs/CHANGELOG.md`; each TESTING row keeps the
   command and the current count only.

## 5 · Cadence — five lines every Friday

Claude Code posts, and the founder ticks the checklist artifact:

```
Shipped:   <commit hashes, one line each>
Counts:    <the suites that changed, with numbers>
Blocked:   <what needs the founder, or nothing>
Next week: <the two or three things>
Freeze risk: <the one thing that could move 2026-12-11, or "none">
```

Five minutes. If "Freeze risk" says the same thing two Fridays running, the
scope valve opens early.

## 6 · Model and cost policy (added 2026-09-13 after a $100 day)

Published list prices, read from Anthropic's pricing page 2026-09-13, per
million tokens:

| Model | Input | Output | Cached input read |
|---|---|---|---|
| Fable 5.1 | $10 | **$50** | $0.25 |
| Opus 5 | $5 | $25 | $0.50 |
| Sonnet 5 | $2 | **$10** | $0.20 |
| Haiku 4.5 | $1 | $5 | $0.10 |

Two things follow, and they are the whole policy:

- **Output is where the gap lives — 5× between Fable 5.1 and Sonnet 5.**
  Reasoning/effort tokens are billed as output. "Fable 5.1 on extra effort" is
  the most expensive configuration available, because it maximises the $50/MTok
  category. Cached *input* is nearly the same price on both ($0.25 vs $0.20), so
  long sessions are not the main driver — **the model and the effort level are.**
- **The expensive thinking on this project is already done and written down.**
  `BUILD-PLAN` §2b, `SOLANA-ARCHITECTURE`, the two facts files and three audit
  ledgers are the output of it. What remains is execution against written specs.
  Execution is Sonnet work.

**Default: Sonnet 5.** Implementing a written spec, tests, UI wiring, doc edits,
greps, running suites, chasing a failing assertion.

**Escalate to Opus 5** — half Fable's price — and come back down after:
adversarial audit passes; any change to money movement across a trust boundary
(keeper rungs, CCTP path, reserve accounting, grant budgets); a design document
before code; a bug that survived two Sonnet attempts.

**Fable 5.1: reserve it.** On this project there is little left that needs it.
If it goes on, it comes off the same day.

**Habits worth more than they look:** `/clear` between unrelated tasks; one task
per prompt; ask for suite counts, not full logs; never re-read a large doc the
session already read; keep `TESTING.md` small (rule 7 above).
