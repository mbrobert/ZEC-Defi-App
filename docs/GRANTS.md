# Grant landscape for Oilskin (researched 2026-08-13/15, sources in links)

Every program worth Matt's time, ranked by fit. Statuses verified this week;
grant programs churn — re-check before applying.

## The strategy in one paragraph

Apply **ZCG first** (forward-looking, rolling, perfect mission fit — Oilskin
is ZEC utility + shielded-pool demand, and ZCG funded the MetaMask Zcash
Snap). Ship v1, then file for the **FPF Coinholder retroactive** round the
following quarter — its pool is ~135K ZEC (≈$66M) and it pays for shipped,
verifiable work. Deploy the Base-side stack on **Avalanche C-Chain** to
qualify for **Retro9000** (live now, usage-based, 5× new-project multiplier)
plus a **Team1** $10–30K grant to fund that port. Register on Base's small
retro programs as a matter of course. Everything else is opportunistic.

## Ranked table

| # | Program | Status (Aug 2026) | Money | Form | Fit |
|---|---|---|---|---|---|
| 1 | **Zcash Community Grants** — zcashcommunitygrants.org | Open, rolling; biweekly committee | Recent $5K–$88K; larger possible; >$50K = KYC | Cash/ZEC, milestones, forward-looking | Perfect: ZEC-holder utility, shielded-first. July minutes show them favoring real-adoption apps (9 of 14 proposals declined) — that's exactly our pitch |
| 2 | **FPF Coinholder-Directed Retro Grants** — forum (Retroactive category) | Quarterly; Q3 closed Aug 14; **Q4 next** | Pool ≈135K ZEC (~$66M); asks $5K–$1.9M seen | ZEC, retroactive only, coinholder vote | Apply the quarter after v1 ships with usage evidence |
| 3 | **Avalanche Retro9000 (C-Chain)** — retro9000.avax.network | Live, Round 4+ | Up to 10K AVAX/round; 5× multiplier for new projects | AVAX, usage-based (no pitch) | Deploy the vault on C-Chain → get paid for the activity itself |
| 4 | **Avalanche Team1 Builder Grants** — grants.team1.network | Open; monthly decisions | $10K mini / $30K accelerator | Grant | Funds the Avalanche port + a CL venue integration (Uni v3 is live there; Pharaoh $27.5M TVL) |
| 5 | **Base Builder Grants / Builder Rewards** — docs.base.org/get-started/get-funded | Rolling, retroactive | 1–5 ETH; weekly 2-ETH rewards | ETH, no-strings | Ship publicly, post traction, get nominated — small but free |
| 6 | **Uniswap Foundation** — uniswapfoundation.org/grants | Rolling, case-by-case | Varies; audit subsidies up to 100% | Grant | Real hook: our engine routes into Uni v3 pools on Base; strongest ask = audit subsidy |
| 7 | **EF Ecosystem Support Program** | Open; privacy-heavy wishlist | Case-by-case (~$30K class) | Grant, must be open-source | Fund the open-source shielded-funding tooling slice, not the app |
| 8 | **Base Batches / Ecosystem Fund** | 2026 cohort done; next TBA | $10K grants; $50K+ investments | Grant + equity | Pipeline into Coinbase ecosystem when the next batch opens |
| 9 | **Arbitrum (Questbook S4 / Audit Program)** | S3 ended Mar 2026; S4 unclear; audit program ($10M) live | $25–50K class; audit subsidies | Grant | Only if we deploy there; audit subsidy is the practical ask |
| 10 | **Gitcoin Grants (GG25)** | GG24 had a $150K Privacy domain (Oct 2025); GG25 TBA — watch fall | QF matching | Crowdfund+match | Marketing value + privacy-community presence |
| 11 | **NEAR ecosystem** | No open Foundation grants; Protocol Rewards + House of Stake only | Small/political | Tokens | Better door: direct BD with the NEAR Intents/Defuse team (we drive their volume) and Proximity; NEAR Foundation invests directly (it seeded Templar's $4M round) |

Cautionary precedent for the ZCG application: the NEAR Intents team withdrew
a ~$500K retro ask in Feb 2026 after community pushback about a well-funded
team taking grant money. Position Oilskin as what it is — an independent
founder building ZEC-holder utility — ask for forward milestones, modest
numbers, and lead with shielded-by-default.

## "Will my code work on any EVM chain?" — the honest answer

**The contracts port; the integrations don't.** The vault + adapter contracts
are standard Solidity — they compile and run unchanged on Avalanche,
Arbitrum, or any EVM chain. Three things are chain-specific:

1. **The LP venue.** Our adapter targets the MaxFi/SnuggleFi engine, which
   exists on Base only. On another chain we write one new adapter against
   that chain's venue (the `ILPAdapter` interface exists for exactly this).
   Avalanche has Uniswap v3 (live since 2023) and Pharaoh (native CL,
   $27.5M TVL) — venues exist; managed-ALM infra there is thin, which is
   itself part of the grant pitch.
2. **The bridge leg.** Probed live (2026-08-13): 1-Click supports
   **Avalanche today — AVAX, USDC, USDT** as destination assets (and
   Arbitrum with 7 assets, Base with 17). Borrowed USDC can be delivered to
   Avalanche right now; cbBTC/WETH borrow variants stay Base-only for now.
3. **The borrow venue doesn't move at all.** ZEC collateral lives on
   Rhea/Templar regardless of where the LP side runs — deploying on
   Avalanche only re-points the deployment leg.

Net: an Avalanche deployment is roughly one adapter + one config profile +
re-running the fork-test suite against the new venue — real work, not a
rewrite.

## Pitch deck skeleton (numbers researched and sourced, ready to build)

1. **Cold open:** $8.3B of ZEC (16.9M coins, top-15 asset) — and less than
   1% of it earns anything. 25.9% sits shielded; most of the rest sits idle.
2. **Problem:** ZEC holders are yield-locked: no Aave listing anywhere,
   wrapping kills privacy (zenZEC), CeFi pays ~1% custodial and excludes the
   US. Existing attempts prove demand and the gap (Dew: 7 ZEC of traction).
3. **Product:** Oilskin — deposit native ZEC, never sell it; fixed-safe
   borrowing (30% LTV) deploys into blue-chip CL pools; auto-protected
   (earnings repay first, auto-deleverage ladder); one wallet, zero
   connections; funds exit only to the user's own locked address. Live
   demo: prototype.
4. **Why now:** shielded pool tripled in 2 years (8%→30% of supply);
   NEAR Intents does $2B/mo (ZEC rails proven inside Zashi/Zodl); Ironwood
   upgrade just landed; ZEC 10×'d and holders want productive positions
   without disposals.
5. **Market math:** capture 0.5% of ZEC supply → ~$40M TVL; 1.5% → ~$125M.
   Analog: BTC-fi holds ~0.5–0.8% of BTC supply — same asset psychology,
   and ZEC's yield options are far scarcer.
6. **What we bring the host chain** (chain-specific slide): every position
   is recurring swap volume, LP depth in the chain's deepest pools, bridge
   inflows, and a brand-new asset class of collateral flows the chain
   cannot otherwise touch (native ZEC never wraps onto competitors).
7. **Traction & verification culture:** fork-tested against live venues,
   85+ files of audited-pattern code, invariant suite (~82K transitions),
   every integration claim probed and documented — the diligence file IS
   the differentiator.
8. **Fees/business:** 10% performance-only on earnings; path to in-housing
   the engine's 15% at ~$25–30M TVL (break-even math documented).
9. **Risk honesty:** venue exploit history disclosed in-product; caps,
   independent monitoring, deposits-only kill-switch, never-pausable
   withdrawals.
10. **Team + ask:** milestones (audit → guarded mainnet with caps → cap
    raises), amount, and what gets verified at each step.

Numbers behind the slides (sourced Aug 15, 2026): ZEC $490 / $8.27B mcap /
16.88M supply; shielded pool 4.36M ZEC ≈ $2.2B (25.9%); NEAR Intents $1.96B
30-day volume, $25.2B cumulative; Base TVL $4.61B; Aerodrome $253M (merging
into "Aero" — re-verify engine routing); Pharaoh (AVAX) $27.5M TVL /
$835M 30-day volume; BTC-fi ~$7B TVL as the analog.

## Deck production note

Claude Design (Anthropic Labs, launched Apr 2026 — included in the Max plan)
is a good canvas for iterating the deck's look and collaborating on slides;
this workspace is where the deck's *content* lives — the researched numbers
above, the honest claims, the product screens. Recommended flow: build the
deck here first (pptx, correct numbers, real screenshots), then riff on
styling in Claude Design if wanted. The UI/UX itself stays here — it's
code, verified in a browser, shipped to the repo.
