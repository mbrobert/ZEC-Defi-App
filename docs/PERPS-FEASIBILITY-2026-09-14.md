# Perps and the cross-chain loop in beta — feasibility, cost, and the trade

Founder, 2026-09-14: *"These things need to be included in beta: cross chain loop, perps too. how feasible is
that?"* This answers it with measured numbers rather than an estimate, names what each costs, and names what
would have to come off — `ROADMAP.md` rule 2: **building something new means naming what comes off.**

Every external fact below is in `docs/VERIFIED-PERPS-FACTS-2026-09-14.md`, read from the venue's own API or
from chain on 2026-09-13/14. Abbreviations: perp = perpetual future; OI = open interest; LOC = lines of code;
CCTP = Circle's Cross-Chain Transfer Protocol; HF = health factor.

---

## The short answer

| | Feasible? | Why |
|---|---|---|
| **Cross-chain loop in beta** | **Yes — say yes today** | It is already built, on both chains, with tests. What is missing is not code: a two-key keeper process, an address lookup table, and one end-to-end run on devnet ↔ Sepolia. Including it costs the audit **nothing extra** — it is already in both RFP packages' scope |
| **Perps in beta** | **Yes, but it is a third chain and a new risk class** | The trade exists and pays (+10.7 % to +22.4 % annualised to shorts over the last 31 days, measured). The architecture fits better than expected — a contract can own its own position. But there is **no ZEC perp on Base**, so this is a new module on **HyperEVM**, not an extension of an existing one — and the audit inquiries went out on 2026-09-13 quoting a scope that does not contain it |

**The single most time-critical thing in this document:** if perps is in, **the audit firms must be told this
week, in the threads that are already open.** They are scoping now and have not quoted. Adding a chain to a
scope nobody has priced yet costs an email. Adding it in November costs weeks and, per `ROADMAP.md` §H3,
"a moving target is the one thing that reliably wastes an audit fee".

---

## 1 · Cross-chain loop — the easy yes

It was designated the **scope valve** (`ROADMAP.md` §3) with a decision date of 2026-11-13: if it was not
running end to end by then, it was cut. Putting it in beta closes that valve early. That is a reasonable call
because the code is not the risk any more:

| Piece | State |
|---|---|
| Base receiving side — `openLpOnly`, `setSolanaRecipient`, `closeLpAndBurn` | Built, `e931bc0`; 11 unit + 1 fork test with a real native-USDC burn |
| Solana side — entry-HF record, per-position ladder, reserve rule, `deposit_for_burn` | Built, `1bdbe63`; localnet 36 passing |
| The keeper's cross-chain pair, the burn as a rung action | Built, `b369e81` |
| Circle attestation, delivery, the resumable stage machine, the runbook | Built, `2868e7e`; `CROSSCHAIN-RUNBOOK-2026-09-13.md` |
| The cross-chain forecast, priced against Kamino | Built, `f69a377` |
| Internal audit of all of it | Done, `AUDIT-2026-09-13.md` Part 1 — two Medium defects found and fixed |

**What is genuinely left, and none of it is mine:**

1. A keeper process that holds a **Base key beside the Solana one** — the founder's decision about key
   custody, not a coding task.
2. The **address lookup table** both cross-chain transactions need — one signed transaction on Solana.
3. **One end-to-end run on Solana devnet ↔ Base Sepolia.** Nothing has crossed a chain for real. This is the
   only item that could still surprise us, and it is also what would measure Circle's claimed ~8 seconds.

**Cost of including it: zero extra audit surface** — both RFP packages already scope it and name it. The
honest risk is item 3: if the end-to-end run fails in a way the localnet clone hid, that is a November
problem with no valve left to pull. Keeping a **named fallback** is the price of closing the valve: if the
devnet ↔ Sepolia run has not passed by **2026-11-13**, the loop ships disabled behind a flag rather than
moving the freeze.

## 2 · Perps — feasible, and the architecture fits

### 2a. Where it has to live

**There is no ZEC perp on Base.** Avantis, the live Base venue, lists BTC, ETH, SOL, XRP and HYPE — no ZEC.
Synthetix left Base in July 2025. The only **non-custodial** venue found with a ZEC perp is **Hyperliquid**,
and it is not a toy: **$476 M open interest, $284 M of 24-hour volume, 10× maximum leverage.**

So perps means a **third chain: HyperEVM (chain id 999)**. That is the honest headline, and it is why this is
not a small addition.

### 2b. Why it fits better than a third chain usually would

Three things, each chain-verified rather than assumed:

1. **A contract owns its own position.** CoreWriter (`0x3333…3333`, 544 bytes of code on chain, its
   `sendRawAction(bytes)` selector `0x17938e13` confirmed in the deployed dispatch table) lets a contract
   send a limit order to HyperCore, and **the position belongs to the calling contract's address**. A
   per-user account on HyperEVM owns its own short, exactly as `OilskinAccount` owns its Aave position and
   the Solana PDA owns its Kamino obligation. **The product's core promise survives.**
2. **It is EVM.** Solidity, Foundry, the ABI seam, the clone-factory account pattern, the grant model, the
   keeper's EVM adapter — all of it carries over. The Solana module had to reinvent every one of those in
   Rust and Anchor. This is much closer to a second Base than to a second Solana.
3. **USDC gets there on the rail we already built.** Hyperliquid accepts USDC from Base and via **CCTP** —
   the same Circle protocol, contracts and attestation client the cross-chain loop already uses in both
   directions.

### 2c. What it would cost to build

Sized against the Solana module, the only precedent for "a whole new venue class", measured from this tree:

| Piece | Solana module (actual) | HyperEVM perps (estimate) | Why different |
|---|---|---|---|
| On-chain program | 2,644 lines Rust | **~700–900 lines Solidity** | An EVM account + a perps venue adapter, mirroring `OilskinAccount` (668) and a thin venue |
| On-chain tests | 1,496 lines of localnet specs | ~1,200 lines Foundry + a fork suite | Foundry forks HyperEVM; no cloned-validator harness needed |
| Keeper path | 2,821 lines | **~1,200–1,600 lines** | Reuses the EVM reader, grants and dispatcher; new: funding accrual, the short's own liquidation distance |
| Keeper tests | 864 lines | ~700 lines | |
| Yield/forecast service | 655 lines | ~400 lines | Funding history and its variance, shown as a measured history |
| Web flow | 814 lines | ~600 lines | A fourth wizard, an acknowledgment, a position page |
| **Internal audit pass** | one wave | **one wave, and it is the expensive one** | A new risk class, not a new copy of an old one |

**Calendar: 3–5 weeks of focused work**, against a freeze on **2026-12-11** that is 12½ weeks away and
already carries the Sepolia deploy, the cross-chain end-to-end run, the founder's manual walkthrough and the
pre-freeze polish pass.

### 2d. What is genuinely new risk, not just new code

This is the part that deserves the audit fee, and it is why perps is not "one more venue":

- **The short leg can be liquidated.** Delta-neutral is only neutral while both legs are open. If ZEC rips
  upward and the perp margin is exhausted, the user is left long spot ZEC with a realised loss on the short —
  the opposite of what they were sold. The keeper's ladder has no concept of this today: every rung it knows
  is about a *borrow* against collateral, not a *short* against a spot holding.
- **Funding flips.** Measured: negative in 3–5 % of hours, as low as −64 % annualised. A position opened for
  carry can bleed. The product must show the 31-day history with its extremes, and must never quote a rate.
- **A third key and a third chain to be down on.** The keeper already needs a Base key beside a Solana one;
  this makes three.
- **Nothing on HyperCore is `cast call`-able the way Aave is.** Positions and margin live in the L1 state
  behind read precompiles; the encoding is documented but **not yet decoded or verified by us**.

---

## 3 · The trade — rule 2

Perps is roughly the size of the Solana module and lands in the last quarter before a freeze that is not
moving. Four honest options:

| Option | What it means | My read |
|---|---|---|
| **A. Perps in beta, tell the firms this week** | Scope grows by one EVM chain + one venue class. Both RFPs get a diff, not a new package, while quotes are still being prepared | **Only viable if the email goes this week.** After the quotes land, this becomes option D at a worse price |
| **B. Perps in beta, and the Morpho venue comes off** | `MorphoBlueVenue` is a *second* lending venue on Base that duplicates Aave's role; D3 keeps cbZEC off it and it is disabled on Sepolia because no market exists there. Removing it from beta scope takes a venue adapter out of the audit | **The cleanest trade available.** It costs users nothing today and frees roughly the surface perps adds |
| **C. Perps in beta, freeze moves to January** | Everything fits, nothing comes off | Breaks `ROADMAP.md` §H3's one non-negotiable and pushes audit kickoff past the year end — the thing the whole roadmap is arranged to prevent |
| **D. Perps as v1.1, right after the audit** | Build it now, ship it in the release after the audited one | Costs nothing today and keeps the freeze. Costs the beta its most differentiated feature |

**My recommendation: A + B together.** Put perps in beta, send the firms the diff **this week**, and take the
Morpho venue out of beta scope to pay for it. That keeps the freeze date, keeps the audit honest, and the
thing you give up is a duplicate lending venue nobody is using rather than a feature a user can see.

**If only one of the two can be true, keep the cross-chain loop and make perps v1.1.** The loop is finished
code waiting on a key; perps is a quarter of work waiting on a decision.

---

## 4 · What I need from you to start writing perps code

One answer, and it is the only thing blocking:

**Is Hyperliquid the venue?** It is the only non-custodial venue with a ZEC perp, so the alternatives are
not other on-chain venues — they are *custodial* ones (Binance, OKX, Bybit, Kraken), which would mean the
user handing over their coins and the end of "you own your account". If the answer is "no custodial venues",
then Hyperliquid is not a preference, it is the only door, and I will start on the HyperEVM account.

Everything else I can decide and bring back to you: the account shape, the grant the keeper needs for a
short, how the ladder learns about a liquidation distance that is not a borrow, and what the screen says.

**What I will not do without you:** put a number on the funding in any user-facing copy. The measured history
goes on the screen with its extremes and its negative hours, or nothing does.
