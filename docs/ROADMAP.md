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

## 1 · Where we actually are (measured 2026-09-13 from the tree, HEAD `d2f7760`)

This is further along than the build plan assumed — the plan was written before
I could see this clone, and two of its biggest steps have already shipped.

| Area | State | Evidence |
|---|---|---|
| Contracts | **388 passed / 0 failed / 11 skipped**, 33 suites | `forge test` |
| Contracts, fork vs Base mainnet | **11 / 11 green** at block 51,222,568 — first all-green run | `test/fork/BaseFork.t.sol` |
| ABI seam | 425 selectors across 19 contracts | `verify-abi` |
| Shared | 85 | `@zyo/shared` |
| Keeper | 269 tests / 52 suites + 113/113 ABI + 77/77 Solana IDL seams | `@zyo/agent` |
| Yield service | 149 | `@zyo/yield` |
| Web | 180 unit (1 skipped) + 14 e2e | `@zyo/web` |
| Prototypes | 130 + 116 + 62 + 6 fuzz | `prototype/test` |
| Solana program | 7 unit + **26 localnet passing** — owner path 11, keeper ladder 11, world 4 | `anchor test` |
| **A3 gate → forecast** | **DONE** | `/v1/forecast`, `forecast.test.ts`, both prototype builds |
| **A4 risk slider** | **DONE** | registry `entryHfFloorWad` setter at 1.25, `EntryHfRecorded` per position, `ladderFor(entryHf)`, HF ↔ borrow both ways in web + prototypes + e2e |
| A1/A2/A6/A7/A8, B1–B4 | DONE | Sepolia package, Morpho venue, notifier, wallet pill, audit waves 2–3, Solana facts/architecture/program/keeper |

**Not done, and this is the whole remaining list:** the Sepolia deploy itself
(founder's key), the cross-chain loop (A5 + Stream C — CCTP in both directions),
the pool-size gate if `SOLANA-ARCHITECTURE.md` §7 is still unbuilt, a manual
walk-through by the founder, and the two audit packages.

## 2 · The four horizons

Each horizon's exit criteria are **binary** — true or false on the date, no
partial credit, no "nearly". Each carries a **backstop**: the thing that gets
cut if the criteria are not met, decided in advance so it is not re-litigated
under pressure.

### H1 — one week · **Friday 2026-09-18**

*Theme: start the audit clock, and put the thing on a testnet.*

- [ ] Audit inquiries sent: **4 EVM firms and 4 Solana firms** from the
      shortlist, same six questions to each, freeze date stated (founder)
- [ ] Base Sepolia deployed; `docs/DEPLOYMENTS.md` table filled; the 3 skipped
      Sepolia e2e tests **run and pass** (founder deploys, Claude Code verifies)
- [ ] Uncommitted Solana keeper work committed; `git status` clean
- [ ] Reconciliation posted: every BUILD-PLAN step marked done(hash) /
      in-progress / not-started, and BUILD-PLAN §6's grep list returns zero
- [ ] Beta scope agreed in writing — the "in" list and the "not in beta" list
      below, signed off by the founder

**Backstop:** if inquiries are not out by 2026-09-18, the end-of-year goal is
already at risk and the roadmap is re-cut that day, not in December.

### H2 — one month · **Friday 2026-10-16**

*Theme: everything in scope exists and the founder has driven it himself.*

- [ ] Cross-chain: A5 receiving side on Base (`openLpOnly`, CCTP
      `mintRecipient` = the user's own account) built, Anvil fork green
- [ ] Solana `depositForBurn` to the user's Base account, localnet green
- [ ] Pool-size gate live in the yield service (refuse a borrow the Kamino pool
      cannot fund below threshold)
- [ ] Founder has walked the manual test script **end to end on Sepolia**
      and on localnet, and written down what felt wrong
- [ ] At least two audit quotes in hand, one per chain
- [ ] Copy pass: the two disclosures (bridge/privacy, Circle) in the deposit
      flow; banned-words test green

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

## 4 · Standing rules that stop the circling

1. **The audit clock is the master clock.** Once a kickoff date is booked,
   everything schedules backwards from it.
2. **Not-on-the-roadmap work needs a trade.** Building something new means
   naming what comes off.
3. **Non-safety bugs go to `docs/BACKLOG.md`**, not to today. A bug is "safety"
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
