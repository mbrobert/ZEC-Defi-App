# Beta scope — the "in" and "not in beta" lists (draft, 2026-09-13)

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
| Base collateral | cbBTC and WETH, borrow USDC on Aave v3 (Morpho Blue venue also built for both, registry pointer stays Aave at launch) | D2, A2 `06be2f7` |
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

## Not in beta

| Item | Why it's out | Path back in |
|---|---|---|
| **Cross-chain loop** (ZEC on Kamino → USDC via CCTP V2 → LP on Base, D6) | **Conditional, not a flat no — this is the scope valve** (`ROADMAP.md` §3). A5 (Base receiving side) is done; B3.1 (Solana burn) is done up to the attestation; Stream C (the two-key attestation-poll-and-deliver process, end to end on devnet ↔ Sepolia with the reserve rule enforced) has not started. **Decision date 2026-11-13**: if Stream C is not running end to end by then, this is cut from beta and ships as v1.1. Cutting it costs nothing a user can see today — the Base yield gate refuses every pool at current emissions anyway (`docs/MODEL-NUMBERS-2026-09-13.md`), so the loop's destination is not yet worth reaching | Ships as v1.1 immediately after the audit if cut; ships in beta if Stream C lands by the valve date |
| cbZEC/USDC Morpho market on Base | Explicit decision D3 — wait for Aave or another curator to list cbZEC first, rather than Oilskin creating the market itself | Revisit when an external market lists cbZEC; no code change needed on our side beyond flipping the registry, which is exactly why `RISKS.md` §16 says a "registry flip away" is still a real access-control event, not a triviality |
| Two external audits (A9 EVM, B7 Solana) | By definition happen after the freeze, not part of the frozen code itself; A9 and B7 are both **not started** — `docs/AUDIT-SHORTLIST-2026-09.md` has the firm shortlist. `docs/ROADMAP.md` §0's whole argument is that sending the inquiry emails this week is the one action that is actually late | H1 (this week): inquiries sent, six questions, freeze date stated. H3: RFP packages sent at the tagged hash |
| Launch parameters (deposit cap, allowlist size, day-one funds at risk) | A launch decision, not a beta-scope one — `ROADMAP.md` §2 "End of year" puts this after both audits, not before | Decided at or after the H3 freeze |
| Long/short (perps), tokenized stocks | **Not in the current plan of record at all.** These were items 9–10 of the superseded `docs/BASE-PIVOT-2026-09.md` numbering (its own "v1.2" tier); D1–D7 and the Stream A/B/C framework that replaced it name neither. Reviving either needs a fresh founder decision, not a beta-scope toggle | A new decision, not on `ROADMAP.md` today |

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
