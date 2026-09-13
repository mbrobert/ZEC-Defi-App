# Audit inquiry — ready to send (draft, 2026-09-13)

`docs/ROADMAP.md` §0: "the single highest-leverage action on this roadmap
costs nothing and takes an afternoon: send the inquiry emails this week."
This is that email, drafted so sending it is a copy, three fills and a paste.
**Nobody has been contacted yet** — `docs/AUDIT-SHORTLIST-2026-09.md` states
that explicitly and this draft doesn't change it. Contact emails are not in
this repo and I have not looked any up; find each firm's current audit-intake
address or contact form yourself, or ask me to search for them.

Abbreviations: EVM = Ethereum Virtual Machine; LOC = lines of code;
RFP = request for proposal.

## The six questions (so quotes compare — say if you'd rather ask different ones)

`docs/AUDIT-SHORTLIST-2026-09.md` §5 item 6 names four of these ("timeline
asks"); I added the two most standard remaining diligence questions so the
set is complete and every firm answers the same six:

1. Earliest kickoff date you can commit to, against a target code freeze of
   **2026-12-11**.
2. Expected review length (engineer-weeks) for the scope below.
3. Does the engagement cover the off-chain keeper (TypeScript, `agent/`) as
   well as the on-chain contracts, or contracts only?
4. Fix-review process and turnaround once findings are delivered.
5. Pricing basis (day-rate / team-week / fixed fee) and a rough estimate for
   this scope.
6. Will you publish the final report, and under what conditions?

## The template

```
Subject: Security audit inquiry — Oilskin (Base + Solana DeFi, cross-chain, targeting Dec 2026 freeze)

Hi [FIRM],

We're Oilskin — a DeFi app where ZEC holders deposit collateral into their own
smart account, borrow USDC, and optionally deploy it into Aerodrome liquidity
on Base or hold it on Solana against Kamino. [ASK-FOR LINE — see table below].

Scope at a glance:
- Solidity contracts (Base): ~3,500 LOC today, ~4,500–5,500 LOC at freeze
  (account/registry/router/venues, Aave v3 + Morpho Blue collateral venues,
  Circle CCTP V2 receiving side).
- TypeScript keeper (`agent/`): ~5,500 LOC today, ~8,000–9,000 at freeze — runs
  inside a user-signed, scoped on-chain grant; this is in scope alongside the
  contracts.
[FOR SOLANA FIRMS, replace the two lines above with:]
- Anchor program (Rust): ~2,000–3,500 LOC — owns a Kamino ZCASH-market
  obligation via a program-derived address, CPIs into Kamino Lend and Circle's
  CCTP V2.

Trust model in one line: a timelocked, multisig-owned registry names which
collateral venue each asset uses; a keeper acts only inside a per-user grant
bounded by token and period budgets, revocable in one transaction; exits never
require the keeper.

Target code freeze: 2026-12-11 (tagged `beta-audit-1`), RFP package and fixed
commit hash sent at that hash.

Six questions so we can compare quotes across firms:
1. Earliest kickoff date you can commit to against that freeze?
2. Expected review length (engineer-weeks) for this scope?
3. Does your engagement cover the off-chain keeper code, or contracts only?
4. Fix-review process and turnaround once findings are delivered?
5. Pricing basis (day-rate / team-week / fixed fee) and a rough estimate?
6. Will you publish the final report, and under what conditions?

Happy to share the design docs and current test suite on request.

Thanks,
[YOUR NAME]
Oilskin
```

## Per-firm fills

Pulled verbatim from `docs/AUDIT-SHORTLIST-2026-09.md` §3–§4 — nothing added.
`docs/ROADMAP.md` §2 H1 asks for **4 EVM and 4 Solana**, not all eleven rows
below; which four per side is a firm-preference call the shortlist itself
doesn't rank (budget, existing relationships, none of that is in these docs)
— that's yours to make, not mine to guess at. Zellic is the one firm on both
lists, so it's a natural pick for at least one side.

| Firm | Chain | `[ASK-FOR LINE]` |
|---|---|---|
| Spearbit / Cantina | EVM | Looking for a 2-week team review of the contracts plus a keeper design review; open to pairing it with a Cantina competition on the same freeze. |
| Trail of Bits | EVM | Looking for 2 engineers × 3 weeks across the contracts and the off-chain keeper — your operator-powers and grant-model lens is exactly what we need eyes on. |
| OpenZeppelin | EVM | Looking for 2 engineers × 2–3 weeks; our account design is an EIP-1167 clone + factory + timelocked registry. |
| Cyfrin | EVM | Looking for a quote on the contracts. |
| Dedaub | EVM | Looking for a quote as our budget option. |
| Zellic | **Both** | We also have a Solana Anchor program on the other side of a CCTP bridge — could one engagement cover both, or should we scope them separately with you? |
| OtterSec | Solana | Looking for a full program review including the CPI paths into Kamino Lend — we understand you've reviewed Kamino's own programs. |
| Neodyme | Solana | Looking for a program review with an account-constraint focus. |
| Sec3 | Solana | Looking for a program review; also curious whether an automated X-Ray scan makes sense as a pre-audit step. |
| Accretion | Solana | Looking for a quote. |
| Offside Labs | Solana | Looking for a quote. |

Competitive-layer firms (Sherlock, Code4rena, the Cantina contest) come after
a private review closes, per the shortlist's own ordering (§3, §4) — not part
of this first round of inquiries.

## Before sending

- [ ] Fill `[YOUR NAME]`.
- [ ] Find each firm's actual audit-intake contact (email or web form) — not
      done here.
- [ ] `docs/ROADMAP.md` §2 H1 checklist: tick "Audit inquiries sent" once these
      eight go out (4 EVM + 4 Solana, per the shortlist's non-competitive rows).
