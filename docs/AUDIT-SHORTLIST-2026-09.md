# Audit shortlists — EVM (Base module) and Solana (Solana module)

Prepared 2026-09-12 for the RFP step in `BUILD-PLAN-2026-09-12.md` (A9, B7).
Everything with a dollar figure below is either a **published rate** with its
source named, or an **estimate derived from a published rate** and labelled as
such. Nothing is a quote; quotes come from the firms. No firm has been contacted.
Abbreviations: LOC = lines of code; RFP = request for proposal; CL = concentrated
liquidity; CPI = cross-program invocation (Solana's contract-to-contract call).

## 1 · What is being audited (size, from the tree)

| Component | LOC today | What changes before the RFP |
|---|---|---|
| `contracts/src` (Solidity) | 3,492 | + `MorphoBlueVenue` finish, slider floor / per-position ladder, `openLpOnly`, CCTP receive path — est. **4,500–5,500** at freeze |
| `agent/src` (keeper, TypeScript) | 5,558 | + Solana chain adapter, cross-chain position class, reserve logic — est. **8,000–9,000** |
| `services/yield/src` | 4,454 | gate → forecast, `/v1/forecast`; model unchanged |
| `packages/shared/src` | 1,515 | ladderFor(entryHf), slider identity |
| `solana/` (Anchor, Rust) | 0 | est. **2,000–3,500** program LOC + tests; CPIs into Kamino and CCTP V2 |

Two separate engagements, two separate firms, two separate report types. Both
firms need the cross-chain keeper design (`CROSSCHAIN-LOOP-2026-09-12.md`)
because each side of the five-step rung is in their scope.

## 2 · Published rate signals (not quotes)

| Firm | Published signal | Source |
|---|---|---|
| Trail of Bits | $25k per engineer-week (ARDC proposal) | 7BlockLabs, Zealynx |
| OpenZeppelin | $25k per engineer-week; Venus retainer $554,400 / 24 weeks | 7BlockLabs, Zealynx |
| Spearbit / Cantina | $32.5k–$48k per team-week; also runs competitions | Zealynx |
| Runtime Verification | $20k/week; ~3 weeks per 1,000 LOC quality floor | Zealynx |
| Dedaub | $3.5k per engineer-day, two-auditor minimum | Zealynx |
| Sherlock / Code4rena (competitive) | prize pools $37.5k–$500k across 2024–25 contests; Sherlock exploit cover ~2 % | 7BlockLabs |
| Zellic | competitive model with zero platform fee and a 96 % conditional-pool refund; also private audits (EVM **and** Solana) | 7BlockLabs |
| Lead time, all top-tier | **4–12 weeks** from inquiry to kickoff; fix-review 3–7 days; plan 8–16 weeks audit-start-to-mainnet for cross-chain systems | Zealynx |
| Rush | +20–40 % | 7BlockLabs |
| Solana firms (OtterSec, Neodyme, Sec3, Accretion, Offside Labs, Zenith, Pashov) | no published per-week rates found; quote only. Empirical: 163 multi-auditor Solana reviews averaged 10.3 findings, 51 % with ≥ 1 high/critical | SSRN 6552478 (Tsai, Wang, Zheng) |

## 3 · EVM shortlist (Base module)

| Firm | Why it fits Oilskin | Ask for |
|---|---|---|
| **Spearbit / Cantina** | Lending + CL-LP is their bread and butter (Morpho, Aave-adjacent work); can pair a private review with a Cantina competition on the same freeze | 2-week team review of `contracts/src` + keeper design review; Cantina contest as the second pair of eyes |
| **Trail of Bits** | Strongest on the keeper/off-chain side and on "what can an operator do" — the registry owner powers and the grant model are exactly their lens | 2 engineers × 3 weeks, contracts + `agent/` |
| **OpenZeppelin** | Reference-quality reports; the EIP-1167 clone + factory + timelock pattern is their home turf | 2 engineers × 2–3 weeks |
| **Zellic** | Does both EVM and Solana — one firm could see the cross-chain seam whole | ask whether one engagement can cover A5 + B3 together |
| **Cyfrin** | Mid-market rates, public pricing conversations, CodeHawks competition | quote for contracts only |
| **Dedaub** | Cheapest published day-rate among the named firms; strong static-analysis tooling | quote as the budget option |
| Competitive layer | **Sherlock** or **Code4rena** contest after the private review, before mainnet | pool sized to funds-at-risk at launch cap |

**Estimate, labelled:** at $25k/engineer-week, a 2-engineer × 3-week private review
is **$150k**; Spearbit's team-week band gives **$65k–$144k** for 2–3 weeks; Dedaub's
day-rate gives **$70k–$105k** for 2 auditors × 10–15 days. Fix-review adds
$25k–$50k. A competition on top: $40k–$100k pool. These are arithmetic on
published signals, not quotes; a firm may price the cross-chain keeper higher.

## 4 · Solana shortlist (Solana module)

| Firm | Why it fits | Ask for |
|---|---|---|
| **OtterSec** | Most-cited Solana auditor; Kamino's own programs have OtterSec reports — they already know the CPI surface Oilskin calls into | full program review + the Kamino CPI paths |
| **Neodyme** | Deep Solana runtime / account-validation expertise (the class of bug that dominates Anchor programs) | program review with account-constraint focus |
| **Sec3** | Solana-specific tooling (X-Ray) + manual; publishes audit reports; fast turnaround reputation | program review; ask about automated scan as a pre-audit |
| **Zellic** | See above — the one firm on both lists | joint scope with the EVM side |
| **Accretion** | Solana-only boutique; former Anza/Solana Labs engineers | quote |
| **Offside Labs** | Covered in the 163-review dataset; Solana + EVM | quote |
| Competitive layer | **Cantina** (runs Solana contests) or **Code4rena** | after the private review |

**Estimate, labelled:** no published per-week rates; Solana boutiques are generally
quoted per engagement. If they price like the EVM tier ($20k–$25k per engineer-
week), a 2,000–3,500-LOC Anchor program with Kamino + CCTP CPIs is a 2-engineer
× 2–3-week job: **$80k–$150k**, plus fix-review. Treat as a placeholder until two
quotes are in.

## 5 · The RFP package (identical for both, plus a chain-specific appendix)

**Written 2026-09-13:** `docs/RFP-EVM-2026-09-13.md` and `docs/RFP-SOLANA-2026-09-13.md`, both measured at
`e1d57a4`. Each carries the six items below and asks the same six questions, so quotes compare. **The EVM
package gained a §4b on 2026-09-16** — three questions we already know we cannot answer, each with the test
that pins today's behaviour (backlog O-4, C-1 and G-1). It is an addition to what we are asking, not a change
to the tree we are asking about. Both leave
§5 (deposit cap, allowlist size, funds at risk) blank: those are the founder's numbers and neither package
should be sent with them invented. Send both with "code freeze expected 2026-12-11" stated.


1. Fixed commit hash and a tag; the tree builds and every suite is green at it.
2. `docs/AUDIT-SCOPE.md` (updated to the new tree), `docs/BUILD-PLAN-2026-09-12.md`,
   `docs/CROSSCHAIN-LOOP-2026-09-12.md`, `docs/RISKS.md`, the relevant
   `VERIFIED-*-FACTS.md`, prior internal audit ledgers (`AUDIT-2026-09-06.md`,
   wave-2 file).
3. Trust model in one page: what the registry owner can do and when; the keeper
   grant; the Solana keeper delegation; Circle and OmniBridge as third parties.
4. The invariants already asserted in tests, and the ones you want them to
   attack: router balance-delta, `EntryHfTooLow` at the floor, ladder monotonic
   in HF, reserve never bridged, CCTP `mintRecipient` = the user's own account.
5. Launch parameters: deposit cap, allowlist, chains, the day-one funds-at-risk
   number — this is what sizes both the audit and any bounty.
6. Timeline asks: earliest kickoff, review length, fix-review window, whether
   they will publish the report.

## 5b · The lawyer's read

`docs/ROADMAP.md` §1 item 6 schedules "the lawyer's read on `AUDIT-SHORTLIST` §5" as part of H3.
**The checklist it points at does not exist yet.** `docs/BUILD-PLAN-2026-09-12.md` §4 records the
"get a lawyer's read" checklist as Cowork's and "not in the tree yet", alongside the forecast page
copy and the two disclosures. This section is where it goes when it is written.

Until then this is a list of one, and saying so is the point: a heading with a single bullet under it
is honest, and a heading that implied four when three were never written would not be.

Abbreviations: ZEC = Zcash's native coin; USDC = the borrowed asset; KYC = know-your-customer.

| # | Question | Where it came from |
|---|---|---|
| **L-1** | Routing a user's withdrawn USDC into a swap that ends in ZEC at an address they control — Door 1 — is a different question from lending against collateral, and it is not covered by whatever answer the lending side gets. The user's funds have left every Oilskin contract by then; Oilskin builds no transaction, signs nothing and never receives the funds; what it does is show a quote and a destination field. Whether that is a different regulated thing in any jurisdiction is counsel's to say. | `docs/ZEC-FORMS-AND-DOORS-2026-09-15.md` §3.4, founder's direction 2026-09-15 |

**Do not pre-empt the answer in the copy** (`CLAUDE.md` rule 4). Door 1 states the mechanism and
ships behind a disabled flag; nothing in the product asserts a legal position, and nothing should
start to while this is open. `ZEC-FORMS-AND-DOORS-2026-09-15.md` §6 makes counsel's answer one of the
two things the flag waits on — the other is Step Z1, the facts pass on the route itself.

When the rest of the checklist is written, the three items it carries go in this table above L-1, and
this paragraph goes away.

## 6 · Order of operations

Send the EVM RFPs the week A5 freezes and the Solana RFPs the week B3 freezes;
the 4–12-week lead time is the schedule's long pole, so inquiries can go out
**before** freeze with "code freeze expected <date>". Ask every firm the same
six questions so quotes compare. Decide with two quotes per side in hand.

Sources: Zealynx audit-timeline research; 7BlockLabs 2026 cost benchmarks;
Tsai, Wang & Zheng, *Solana Security Ecosystem Review 2025* (SSRN 6552478);
Sec3 and Accretion public pages.
