# Beta scope — the "in" and "not in beta" lists (draft, 2026-09-13)

> **AMENDED BY THE FOUNDER, 2026-09-14:** *"These things need to be included in beta: cross
> chain loop, perps too."* The cross-chain loop has moved from "Not in beta" to **In beta**
> (decision **D11**), which closes `ROADMAP.md` §3's scope valve early. **Perps is accepted in
> principle and blocked on one answer** — see the row at the foot of "Not in beta" and
> `docs/PERPS-FEASIBILITY-2026-09-14.md`, which prices both and names the trade. The rest of this
> draft stands as written.
>
> **This is a draft for the founder's sign-off**, the deliverable `docs/ROADMAP.md`
> §2 H1 asks for ("Beta scope agreed in writing — the 'in' list and the 'not in
> beta' list … signed off by the founder"). Nothing here is decided until the
> founder confirms or amends it. Abbreviations: HF = health factor,
> LTV = loan-to-value, LT = liquidation threshold, LP = liquidity provision,
> CCTP = Circle's Cross-Chain Transfer Protocol, PDA = program-derived address,
> RFP = request for proposal.

**Interpretation I am applying (say so if wrong).** `docs/ROADMAP.md` §0 states
the goal as "beta code frozen and handed to auditors before the end of the
year" — so "beta" here means *the code inside the frozen, audited hash*, not a
live product beta with real user funds. Nothing in this document authorizes a
public launch; launch is a separate, later decision (`ROADMAP.md` §2 "End of
year" and "2027 launch plan"). The two lists below say what gets **built,
tested and sent to auditors** at the `beta-audit-1` freeze (target
2026-12-11), and what is deliberately left for v1.1 **after** that audit.

## In beta

Grounded in `docs/BUILD-PLAN-2026-09-12.md` decisions D1–D7 and each
workstream's actual state (§4 of that file, reconciled 2026-09-13), not intent.

| Area | What ships | Grounding |
|---|---|---|
| Base collateral | cbBTC and WETH, borrow USDC on **Aave v3**. **`MorphoBlueVenue` is OUT of beta scope from 2026-09-14 (D12)** — see the row below | D2, A2 `06be2f7` |
| cbZEC on Base | **Registered but disabled** — no Morpho market created for it (D3); Zcash holders enter through the Solana module instead | D3 |
| Risk model | One continuous HF slider, both directions, one on-chain registry floor (1.25, pinned 2026-09-12); Sheltered (1.55) / Expert (1.30) survive as marks, not modes; ladder rungs derive from the entry HF the user chose | D7, A4 (`de2b3de` the floor pin, A4.1–A4.4 the mechanism) |
| Yield model | `/v1/forecast` — advisory, both LP-net models shown side by side, IL drag, break-evens, liquidation price, borrow-rate-after-this-borrow; a DYOR acknowledgment, not a gate; hard refusals stay safety-only (registry floor, pool cannot fund, stale oracle, paused venue, disabled asset) | D4, D5, A3 `b849b17` + the wizard/prototype work that carries this row |
| LP venue | Aerodrome Slipstream through the MaxFi/Snuggle engine, Simple and Advanced modes | pre-existing, unchanged by D1–D7 |
| Spot | Buy/sell through CoW Protocol (Advanced mode) | `web/lib/cow.ts`, `web/app/spot/page.tsx`; `RISKS.md` trust-assumptions item 3 and 8 already carry CoW as a trusted third party |
| Base keeper | Warn / repay / derisk / emergency-unwind inside the user's signed, scoped grant; owner notifications in-app and by webhook | pre-existing + A6 `1fed88d` |
| Solana module | ZEC (bridged via NEAR Intents / OmniBridge) as collateral on Kamino's ZCASH market, USDC borrowed, an Anchor program's PDA owns the obligation (klend requires this — `release_obligation` cannot exist, §S3 finding); Solana keeper protects it | D1, B1–B4 (B3 core instructions built, localnet 34/34 at B3.1) |
| Solana risk model parity | Entry-HF and per-position ladder recorded on chain, same identity as Base (D7); Kamino's own 40 % LTV cap binds regardless (entry HF ≥ 1.625 on ZEC) | B3.1 `1bdbe63` |
| Solana web flow | Wallet adapter, five-screen deposit/borrow wizard on Kamino's live numbers, position page with an exit hatch | B5 part 1 `67307df`, part 2 (2026-09-13) |
| Wallet UX | EIP-6963 multi-wallet connect, restyled | A7 `13f3af5` |
| Base Sepolia rehearsal | Deploy package prepared (mock LP venue, swap adapter, Sepolia profile, `DEPLOYMENTS.md` template) — **not yet deployed; needs the founder's key** | A1, `e2350e3`/`17fc8f7`/`b3b482f` |
| **All forms of ZEC** (the form registry and Door 2) | **IN, by founder's direction 2026-09-15** (`docs/ZEC-FORMS-AND-DOORS-2026-09-15.md`). cbZEC stops being *the* ZEC and becomes *a* ZEC: one row in `packages/shared/src/zecForms.ts`, described by its properties — custody, who can freeze it, whether identity is required, which venue lends against it — each row pinned to a `VERIFIED-*-FACTS.md` section it does not compile without. Door 2 is the onboarding question "where is your ZEC?", which routes to every path from that answer and, for the first time, names the Solana lane as the one that ends in a loan. **Costs the audit nothing: no Solidity, no Anchor.** `CollateralRegistry.sol` keys assets by address, so the audited surface does not care which ZEC it is | §2 and §4 of that plan; steps 1–4 landed 2026-09-15 |
| **Cross-chain loop** (ZEC on Kamino → USDC via CCTP V2 → LP on the user's own Base account, D6) | **IN, by founder's decision D11 (2026-09-14)** — this closes `ROADMAP.md` §3's scope valve early. Built on both chains and internally audited: Base receiving side `e931bc0`, Solana burn and reserve `1bdbe63`, the keeper's pair `b369e81`, attestation + delivery + stage machine + runbook `2868e7e`, the cross-chain forecast `f69a377`, `AUDIT-2026-09-13.md` Part 1. **Costs the audit nothing extra — both RFP packages already scope it.** What is left is not code: a keeper process holding a Base key beside the Solana one, the address lookup table both transactions need, and **one end-to-end run on devnet ↔ Sepolia, which nothing has ever done** | A5, B3.1, A5.2, Stream C |

## Not in beta

| Item | Why it's out | Path back in |
|---|---|---|
| cbZEC/USDC Morpho market on Base | Explicit decision D3 — wait for Aave or another curator to list cbZEC first, rather than Oilskin creating the market itself | Revisit when an external market lists cbZEC; no code change needed on our side beyond flipping the registry, which is exactly why `RISKS.md` §16 says a "registry flip away" is still a real access-control event, not a triviality |
| Two external audits (A9 EVM, B7 Solana) | By definition happen after the freeze, not part of the frozen code itself; A9 and B7 are both **not started** — `docs/AUDIT-SHORTLIST-2026-09.md` has the firm shortlist. `docs/ROADMAP.md` §0's whole argument is that sending the inquiry emails this week is the one action that is actually late | H1 (this week): inquiries sent, six questions, freeze date stated. H3: RFP packages sent at the tagged hash |
| Launch parameters (deposit cap, allowlist size, day-one funds at risk) | A launch decision, not a beta-scope one — `ROADMAP.md` §2 "End of year" puts this after both audits, not before | Decided at or after the H3 freeze |
| **Long/short (perps)** — delta-neutral "earn funding on your ZEC" | **ACCEPTED IN PRINCIPLE by the founder 2026-09-14; blocked on one answer, not on effort.** Measured 2026-09-13/14 (`VERIFIED-PERPS-FACTS-2026-09-14.md`): **there is no ZEC perp on Base** — Avantis lists BTC/ETH/SOL/XRP/HYPE and Synthetix left Base in 2025 — so this is a **third chain, HyperEVM (999)**, not an extension of an existing module. The trade is real: funding paid shorts **+10.7 % to +22.4 % annualised over the last 31 days**, negative in only 3–5 % of hours, on a market with $476 M open interest. The architecture fits — CoreWriter (`0x3333…3333`, chain-verified) lets **a contract own its own position**, so "you own your account" survives, and it is EVM, so Solidity/Foundry/the grant model carry over. Cost: ~3–5 weeks and one new risk class (**the short leg can be liquidated**; the keeper's ladder has no concept of that today) | **Answer the venue question in `PERPS-FEASIBILITY-2026-09-14.md` §4**, and send the audit firms a scope diff **this week**, while they are still scoping and have not quoted |
| **Door 1** — sending withdrawn USDC out as ZEC to the user's own Zcash address | **Built and shipped DARK** behind `NEXT_PUBLIC_ZEC_EXIT_ENABLED`, which is off. Not a scheduling decision: **nothing about the NEAR Intents route has been read into a `VERIFIED-*-FACTS.md` file** — not the endpoints, not a fee, not the signer set, not the withdrawal delay, not what happens to an intent nobody fills. `CLAUDE.md` rule 3 forbids offering a route nobody has read, so `/v1/exit-quote` refuses with the reason and the name of the document that would unblock it, and the UI renders nothing at all rather than a greyed-out button. Zero Solidity, zero Anchor, so being in the tree costs the freeze nothing | **Two things, and both must land.** Step Z1 — `docs/VERIFIED-ZEC-ROUTES-<date>.md`, the facts pass in §3.3 of the plan, routed to a Cowork research batch. And counsel's answer to `AUDIT-SHORTLIST-2026-09.md` §5b L-1. The flag flips at v1.1, not at the freeze |
| **ZSA work** (Zcash Shielded Assets, ZIP 226/227) | **Not scheduled, deliberately, and written down so it is not re-litigated in November.** ZIP 226, 227 and 228 are all `Draft`; ZIP 220 and 230 are `Withdrawn`; the last activated upgrade is NU6.2 (2026-06-03) and **NU7 has no date**. Zcash also has no Turing-complete compute, so there is no Zcash-side contract that could hold collateral or run a ladder — this is not a scheduling question. **Nothing on the roadmap depends on a Draft ZIP** | Revisit when NU7 has a date. Founder, 2026-09-15: "we will work later on more when ZSA actually go live" |
| Tokenized stocks | **Not in the current plan of record.** Item 10 of the superseded `docs/BASE-PIVOT-2026-09.md` numbering; D1–D7 and the Stream A/B/C framework that replaced it do not name it | A new decision, not on `ROADMAP.md` today |
| **`MorphoBlueVenue`** (the second Base lending venue) | **OUT from 2026-09-14 — this is the trade D12 makes for perps** (`ROADMAP.md` rule 2: new work names what comes off). It duplicates Aave's role for the same two assets; the registry pointer was always going to stay Aave at launch; D3 keeps cbZEC off it; and it is disabled on Sepolia because no Morpho market exists there. **A user loses nothing visible.** The code stays in the repo and keeps its tests — it leaves the *frozen, audited scope*, which is what costs money | Re-enter at v1.1 with its own smaller review, or sooner if a curator lists cbZEC on Morpho and D3's condition is met |

## What this does not cover

Operational readiness (the founder walking the manual test script end to end,
copy pass, the two disclosures) is tracked directly in `ROADMAP.md` §2 H1/H2
and is not duplicated here. This document is scope — *what code* — not
*whether it's ready*.

## Founder: confirm or amend

If this matches your intent, say so and I'll mark the H1 checklist item done
in `docs/ROADMAP.md` with this file as the record. If any row is wrong —
especially the cross-chain loop's conditional framing, or if spot/CoW should
not be in beta — tell me and I'll redraft.
