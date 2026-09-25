# Perps module — design (D1, drafted 2026-09-25; nothing built)

**Status: a design for the founder to read, BUILD-PLAN Stream D step D1.** Founder's decisions D12 and D13
(2026-09-14): perps is in beta and Hyperliquid is the venue. This document is the piece BUILD-PLAN §4 calls
"the one with no precedent in the tree" — how a keeper protects a *short* rather than a *borrow* — written
before any code, the way `SOLANA-ARCHITECTURE.md` was. Every external number is from
`docs/VERIFIED-PERPS-FACTS-2026-09-14.md` (its §6 addendum carries today's reads); a fact still taken from a
document is marked **[doc]** and listed in §2 as a gate on code. Nothing here is a rate, a promise, or advice.

Abbreviations: perp = perpetual future; HF = health factor; CCTP = Circle's Cross-Chain Transfer Protocol;
EIP = Ethereum Improvement Proposal; LP = liquidity provision; mmr = maintenance margin rate; OI = open
interest; IOC = immediate-or-cancel; ATA = associated token account.

---

## 0 · What it is, and what it is not

A user who holds ZEC — in a Zcash wallet, on Solana, anywhere Oilskin cannot see — opens a **short ZEC perp
of the same size** on Hyperliquid, from an account contract on HyperEVM that they own. While both legs are
open the price exposure nets to about zero and the position earns (or pays) the hourly **funding** the venue
moves between longs and shorts. Measured, not forecast: funding was paid *to* shorts in ≈ 96 % of hours over
the 43 days read so far, at a realised pace between **+10.7 % and +22.4 %** annualised in the three windows
(§2). The user keeps their ZEC. Nothing is borrowed.

What it is not: not leverage (the offered range is a short no larger than the ZEC the user says they hold),
not "yield" (`web/lib/copy.ts` will refuse the word), and **not delta-neutral by construction** — Oilskin
cannot see the spot leg, so the hedge is the user's assertion and the screen says so in those words.

What is new, in one sentence: **the short leg is liquidated when ZEC goes *up***. Every rung the keeper knows
is about a borrow that dies when collateral falls. ZEC moved **+44.1 %** between the facts file's first read
and today's (§2), which on a 2× short is most of the distance to liquidation in twelve days. §4 is the answer.

## 1 · The shape

```
 user's wallet (owner)
   │ signs: open / close / add margin / withdraw / grant / exec (the hatch)
   ▼
 OilskinPerpAccount  ── EIP-1167 clone on HyperEVM (chain 999), owner = the wallet, one per user
   │  the SAME account contract shape as OilskinAccount on Base: exec / execAsKeeper / grant / revoke,
   │  reentrancy guard, the peripheral rule; plus a PerpGrant and an entry record (§3)
   │
   ├─ USDC in:  Base OilskinAccount ─CCTP domain 6→19 (Standard only)─▶ this account (HyperEVM USDC)
   │            ─ERC-20 transfer to USDC's system address─▶ HyperCore spot balance of THIS address
   │            ─CoreWriter 7 "USD class transfer"─▶ HyperCore perp balance   (§6)
   │
   ├─ the position: CoreWriter 1 "limit order" (isBuy = false, reduceOnly = false) — the short is OWNED BY
   │  THIS CONTRACT'S ADDRESS on HyperCore (chain-verified, facts §4); cross margin, one position per account
   │
   ├─ reads: precompiles 0x800 position · 0x801 spot balance · 0x803 withdrawable · 0x806 mark · 0x807 oracle
   │
   └─ USDC out: CoreWriter 13 "send asset" ─▶ HyperEVM ─CCTP 19→6─▶ the user's Base OilskinAccount

 keeper (agent/, a third chain adapter): reads the precompiles + an independent price, values the short as an
 EQUIVALENT HF (§4), runs the SAME shared ladder, and acts through execAsKeeper inside the PerpGrant:
   top-up (spot → perp, action 7) · reduce (reduce-only IOC sell-to-close of ⅓, action 1) · close (all)
```

The three things that carry over unchanged: the account pattern and its grant model (`CONTRACT-ABI.md` §0,
"Keeper grants"), the shared ladder (`packages/shared` `ladderFor` / `hysteresisFor`, D7, D9, D10), and the
keeper's dispatcher discipline (re-value now, read the grant as the chain will judge it, plan, simulate,
persist before send, confirm by reading the world). The three things that are new: the venue adapter
(CoreWriter out, precompiles in), the valuation of a short, and a leg that cannot be atomic with its hedge.

## 2 · Facts this rests on, and the gate before code

**Read from the venue's own API and chain** (facts §2, §4, and §6 for 2026-09-25):

| Fact | Value | Read |
|---|---|---|
| ZEC perp asset index | **214** of 234; `szDecimals` 2; `maxLeverage` 10; `marginTableId` 52 | `meta`, 2026-09-13 and 2026-09-25 |
| Margin table 52 | **"tiered 10x (2)": 10× up to $20,000,000 notional, 5× above** | `meta.marginTables`, **2026-09-25** — D0b's third item, settled |
| Collateral token | index **0** (USDC) | `meta.collateralToken`, 2026-09-25 |
| Mark / oracle | 1,063.80 / 1,064.08 on 2026-09-13 → **1,533.30 / 1,532.79 on 2026-09-25** (**+44.1 %** in 12 days) | `metaAndAssetCtxs` |
| Open interest | 447,372 ZEC ≈ $476 M → **504,883 ZEC ≈ $774 M** | same |
| Funding, three windows, hourly | +22.16 % (20.8 d) · +10.63 % (10.0 d) · **+13.55 % (12.0 d, 2026-09-13 → 25)** annualised means; negative in 3.0 % · 5.0 % · **4.2 %** of hours; extremes −64 % / +241 % | `fundingHistory` |
| CoreWriter | `0x3333…3333`, 544 bytes of code, `sendRawAction(bytes)` `0x17938e13` in its dispatch table; **the position belongs to the calling contract** | `cast code`, 2026-09-14 |
| Read precompiles | `0x…0806` mark and `0x…0807` oracle match the API to the last digit; `0x…0800` `position(address,uint16)` returns six words and does not revert | 2026-09-14 |
| HyperEVM | chain id **999**, `https://rpc.hyperliquid.xyz/evm` | 2026-09-14 |
| CCTP | **HyperEVM is CCTP V2 domain 19** — Standard Transfer ✅, **Fast Transfer N/A**, upfront fees ✅, forwarding ✅ | Circle's supported-blockchains page, 2026-09-25 |

**Read from Hyperliquid's documentation, quoted in facts §6 [doc]** — the rules the health model uses:
maintenance margin is *"half of the initial margin at max leverage"*, so **5 % of notional** in table 52's
first tier (10 % in the second, with the tier formula's deduction keeping the total continuous); liquidation
*"when the account equity falls below the maintenance margin"*, first by market orders to the book, then a
backstop at ⅔ of maintenance through the liquidator vault, and *"the maintenance margin is not returned"*;
*"liquidations use the mark price"*; positions over $100,000 are liquidated 20 % at a time; the liquidation
price is **`liq_price = price − side × margin_available / position_size / (1 − l × side)`** with `side = −1`
for a short, `margin_available (cross) = account_value − maintenance_margin_required`, `l = 1 /
MAINTENANCE_LEVERAGE`; funding is paid **hourly** on `position_size × oracle_price × funding_rate`, from the
account balance, with an interest component of 0.01 % per 8 hours and a cap of 4 %/hour; cross margin is the
default, *"the leverage of an existing position can be increased without closing"*; CoreWriter order actions
are *"delayed onchain for a few seconds"*; the CoreWriter action table (17 actions) has **no action that sets
leverage or moves isolated margin** — which is why §3 runs cross margin; HyperEVM → HyperCore is an ERC-20
transfer to the token's system address, credited to the *sender*; HyperCore → HyperEVM is `sendAsset`.

**The gate — D0b, expanded.** No order encoder, no valuation and no keeper rung is written until each of these
has been read from chain or proven on testnet and recorded in the facts file:

1. The limit-order bytes: `0x01` · `0x000001` · `abi.encode(uint32 asset, bool isBuy, uint64 limitPx, uint64
   sz, bool reduceOnly, uint8 encodedTif, uint128 cloid)` with `limitPx` and `sz` as 10⁸ × the human value
   **[doc]** — proven by one order on testnet whose fill the precompile then shows. The scaling *differs* from
   the precompiles' 10⁴ (facts §4); that is exactly the kind of thing a document gets wrong.
2. The `position` struct's fields — `int64 szi; uint64 entryNtl; int64 isolatedRawUsd; uint32 leverage; bool
   isIsolated` **[secondary: two developer guides, not Hyperliquid's own `L1Read.sol`]** — decoded against a
   real testnet position, sign of `szi` for a short confirmed.
3. Whether a **contract address** on HyperEVM is credited on HyperCore by the system-address transfer and may
   hold a perp balance (the docs' CoreWriter example acts "on behalf of its own contract address", which says
   yes for actions; the credit path is not stated).
4. USDC's HyperEVM contract address and its system address; the `usdClassTransfer` (action 7) semantics for a
   contract; what leverage setting a fresh contract account carries at its first order (it cannot call
   `updateLeverage`; if the default is under 10× the initial-margin check binds earlier than §4 assumes).
5. Circle's CCTP V2 contracts on HyperEVM (the messenger, the transmitter, USDC), probed the way Addendum 3
   probed Base's; the Standard-only fee on 6→19 and 19→6 from `/v2/burn/USDC/fees/6/19` and `/19/6`.
6. What a **backstop** liquidation leaves in the account (the docs say the maintenance margin is kept) and
   what a book liquidation charges — one liquidated testnet position, read back.
7. The margin-tier formula's second tier is irrelevant under $20 M notional; the launch cap (D8: $25,000 per
   user) keeps every beta position in tier 0. Recorded so nobody builds the tiered path for beta.

## 3 · The account, and what it stores

`OilskinPerpAccount` is `OilskinAccount` with a perps venue instead of lending venues: the same clone factory,
`owner`, `exec` (the hatch — always open, never gated, D9's rule about re-recording applies), `execAsKeeper`
with the `(target, selector)` root check, `grant` / `revoke` / `revokeAll`, `grantEpoch`, the reentrancy guard
and the peripheral rule. The venue adapter `HyperliquidPerpVenue` is the one peripheral: it encodes CoreWriter
actions and decodes precompile reads, and is the *only* code that knows the byte layouts of §2 item 1–2.

**Owner path** (each one instruction, each re-records the entry per D9):

| Call | Does | Refuses |
|---|---|---|
| `open(sz, marginUsdc, entryDistanceBps)` | moves `marginUsdc` spot → perp (action 7), places a reduce-only-false IOC sell of `sz` at the mark less the band (action 1), records the entry (§4) | below the registry floor; notional over the deposit cap; mark/oracle disagree beyond the band; funding history unread (the screen must have shown it) |
| `addMargin(usdc)` | spot → perp | — |
| `reduce(sz)` / `close()` | reduce-only IOC buy | — |
| `withdrawToBase(usdc)` | perp → spot (action 7), spot → HyperEVM (action 13), CCTP burn 19→6 to the user's Base `OilskinAccount` (§6) | leaves the position under the floor; leaves the reserve short (§6) |
| `setReserveMultiple(k)` | Advanced only (§6) | — |

**Keeper path — one instruction**, `protect(rung, topUpUsdc, reduceSz)`, the twin of Solana's
`keeper_protect`: refreshes the reads, checks the rung is crossed on the account's own ladder, checks the
`PerpGrant` (live, rung allowed, `topUpUsdc` ≤ the period's top-up budget, `reduceSz` ≤ the period's reduce
budget), executes action 7 and/or a reduce-only IOC buy of `reduceSz` at the mark plus the grant's slippage
allowance, and **records the intent**; because CoreWriter actions land seconds later, the effect is judged by
the keeper's next read, not in the same transaction (§5). The grant is the Solana shape, not the Base one —
the Base `Permission`'s token budgets bound ERC-20 movement, and here nothing leaves the account: what must be
bounded is *how much of the short the keeper may close per period* and *how much reserve it may move*.

```
struct PerpGrant { address keeper; uint40 expiry; uint40 period; uint40 periodStart; uint8 allowedRungs;
                   uint64 topUpUsdcPerPeriod; uint64 reduceSzPerPeriod; uint16 maxSlippageBps;
                   uint64 topUpSpent; uint64 reduceSpent; uint32 epoch; }
```

**The entry record**: `entryDistanceBps` (§4) and `entrySz`, written by every owner action that moves size or
margin (D9), never by `protect` (the keeper does not mark its own homework). `MAX_LADDER_ENTRY_HF` and
`MIN_LADDER_ENTRY_HF` apply to the *equivalent* HF (§4) exactly as on the other two chains.

## 4 · Health of a short, and the ladder — the piece with no precedent

**The number.** Under cross margin with one position, the venue's own liquidation rule (§2 [doc]) gives, for a
short of size `s` at mark `P` with account value `A` (perp balance plus unrealised PnL) and maintenance
requirement `MM = mmr × P × s` (tier 0):

    margin_available = A − MM
    liq_price        = P + margin_available / (s × (1 + mmr))          (side = −1, l = mmr)
    distance d       = (liq_price − P) / P = (A / (P × s) − mmr) / (1 + mmr)

`d` is the **up-move that liquidates**, the mirror of the borrow's "drawdown to liquidation" in BUILD-PLAN §2b.
At entry with margin `m` and notional `P₀ s`, writing `L = P₀ s / m` (notional per unit of margin, **1 = the
margin equals the notional**), `d₀ = (1/L − mmr) / (1 + mmr)`. With `mmr = 5 %`:

| L | margin per $1 shorted | d₀, the up-move to liquidation | equivalent HF (below) | today's +44.1 % in 12 days |
|---|---|---|---|---|
| 1 | $1.00 | **90.5 %** | 10.5 → acting rungs at D10's cap | survives |
| 1.5 | $0.67 | **58.7 %** | 2.42 → cap | survives |
| 2 | $0.50 | **42.9 %** | 1.75 | **liquidated on the 12th day, keeper or not** |
| 3 | $0.33 | 27.0 % | 1.37 | liquidated in the first week |
| 5 | $0.20 | 14.3 % | 1.17 | liquidated in days |
| 10 | $0.10 | 4.8 % | 1.05 | liquidated within hours |

**The mapping, so the ladder is shared code and not a third one.** A borrow at health factor `HF` is
liquidated on a fall of `1 − 1/HF`; a short at distance `d` is liquidated on a rise of `d`. Define the short's
**equivalent health factor** `HF_eq = 1 / (1 − d)` (clamped: `d` is taken as at most 0.99), and the account's
ladder is `ladderFor(HF_eq at entry)` from `packages/shared` — the same four multipliers 0.91 / 0.64 / 0.36 /
0.09, the same hysteresis rule, D10's cap at 2.00 for the acting rungs, and the emergency rung's floor of
1.05, which is a **4.76 % move** on either kind of position. Each rung's HF converts back to a distance,
`d_rung = 1 − 1/HF_rung`, and the keeper compares the *live* `d` against it. Worked, at the proposed floor:

| entry | d₀ | HF_eq | warn | top-up (the "repay" rung) | reduce (the "de-risk" rung) | close (emergency) |
|---|---|---|---|---|---|---|
| L = 2 | 42.9 % | 1.75 | d 40.6 % (HF 1.68) | 32.4 % (1.48) | 21.3 % (1.27) | **6.3 %** (1.0675) |
| L = 1.5 | 58.7 % | 2.42 | 56.4 % (2.29, warn keeps deriving) | 39.0 % (1.64, the cap's) | 26.5 % (1.36) | **8.3 %** (1.09) |
| L = 1 | 90.5 % | 10.5 | 89.6 % (9.65) | 39.0 % | 26.5 % | 8.3 % |

Why the same shape is right and not just convenient: the rungs exist to give the keeper's action time to land
before the venue's own engine acts. A borrow's engine and a short's engine both act on a price move measured
from the same mark, and the keeper's transaction takes the same seconds on either chain — so the distances
that make a rung useful are the same distances. What differs is only the *direction* of the move, which the
mapping absorbs. The alternative — rungs at fixed fractions of `d₀` — was considered and gives nearly the
same numbers at L = 2 (39 / 27 / 15 / 3.9 %) with an emergency rung under the 4.76 % floor; it was not taken.

**The slider (D7 parity).** The user drags the up-move to liquidation `d₀` (or types the margin), the other
field follows through the identity above, and the forecast panel recomputes the funding history's realised
carry *on their margin* (funding is paid on the notional, so the carry per dollar of margin scales with `L`),
the liquidation price in dollars, and the distance. Marks, not modes: **"Sheltered" at L = 1.5 (58.7 %)** and
**"Expert" at L = 2 (42.9 %)**; the acknowledgment below Sheltered names the move that liquidates and the fact
that the last twelve days moved 44.1 %. **The floor is the founder's number.** Proposed: **L = 2, d₀ = 42.9 %,
HF_eq 1.75** — ZEC's own twelve days say a 2× short opened on 2026-09-13 would have crossed its top-up rung
inside the first quarter of that rise and its reduce rung soon after, and is alive today only if the reserve
of §6 was there to spend or a third of it was closed; anything under 2× is a position that
is more likely than not to be liquidated in a month of this market, and Simple mode should not offer it. The
floor is one on-chain parameter in the venue adapter, `EntryDistanceTooLow` below it, as `EntryHfTooLow` is.

**Down-moves cost nothing.** When ZEC falls the short gains, `d` grows, every rung re-arms; the only thing the
keeper does is nothing. The user's spot ZEC is worth less by the same amount — that is the hedge working, and
the screen's position card shows the two legs side by side *as the user stated them*.

**Funding that flips.** Negative funding is paid hourly out of the account balance, so `A` erodes and `d`
shrinks slowly with no price move; the ladder catches it the same way (a warn, then a top-up from the reserve),
and the position card shows the last 24 hours of funding paid or received, signed.

## 5 · The keeper's perps path (`agent/src/perps/`, the Base/Solana pattern)

| Module | Does | What is new |
|---|---|---|
| reader | discovers accounts from the factory (Base pattern); reads `position`, `spotBalance`, `withdrawable`, mark, oracle through the precompiles by `eth_call`; reads the `PerpGrant` and the entry record | a precompile read is an `eth_call` on chain 999; a **forked** HyperEVM cannot execute them (the cbZEC B20 lesson, `VERIFIED-BASE-FACTS.md`), so the reader is tested against a mock at those addresses and proven on testnet |
| valuation | `A`, `MM`, `d`, `HF_eq` from the reads; **two prices** — the precompile mark and an independent read of `metaAndAssetCtxs` from the venue's API — within `PERPS_ORACLE_DEVIATION_BPS` or the valuation is UNKNOWN and no rung acts (fail closed, the Solana rule); the mark's block against the head for staleness | the independent source is the same venue's API rather than a different venue (there is no other ZEC perp) — recorded in RISKS as a weaker check than Jupiter-versus-Scope |
| policy | for a fired rung: **top-up** from the spot reserve to reach the rung's disarm distance plus the plan margin; else **reduce** the smallest `reduceSz` that reaches it, capped at ⅓ of the position (the de-risk fraction) and the grant's budget; **close** everything at the emergency rung; every clamp named | the sizing identity is §4's, inverted for `A` and for `s` |
| dispatcher | `execAsKeeper([{venue, protect(rung, topUp, reduceSz)}])`: simulate, persist the nonce, send; **confirm** is a re-read of the position on a later tick — an order landed if `szi` moved by `reduceSz` and the perp balance by `topUp`; an IOC that did not fill (the book moved) is a rung that re-arms and re-plans, not a failure | the few-seconds CoreWriter delay: `confirm` waits at least `PERPS_ACTION_DELAY_BLOCKS` before judging, and a record is never CONFIRMED on the sending receipt alone |
| monitor | the shared `SolanaMonitor` / `HealthMonitor` shape with the store generic over the account id (Base codec); resolves the ladder from the recorded entry (D9), quarantines stalls, escalates UNKNOWN streaks | nothing |
| notify | the same channels | copy: "your short is N % from liquidation; ZEC is at $P" |

The keeper key on HyperEVM is a **third key**; the process question of `CROSSCHAIN-RUNBOOK-2026-09-13.md` §4
item 3 gets a third leg and is still the founder's.

## 6 · USDC in and out, and the reserve (D5)

**In.** The user's Base `OilskinAccount` is the hub it already is for the cross-chain loop: USDC there — the
user's own, or delivered from a Kamino borrow by the loop — is burned to **CCTP domain 19** with the HyperEVM
account as `mintRecipient` (a 20-byte address left-padded, the Base form). That is one router change:
`StrategyRouter` today burns only to domain 5 with the owner-recorded Solana recipient; it gains
`setPerpRecipient(account)` (owner, 20 bytes, checked to be a clone of the perp factory by address derivation
where possible — Base cannot verify HyperEVM state, so this is the same O-4 shape as the Solana recipient, and
the UI derives it) and a `burnToPerp(amount, maxFee, minFinalityThreshold)` under the same `CrossChainDisabled`
guard. **HyperEVM has no Fast Transfer**: every crossing is Standard, minutes, fee 0 today [to read]. The
arrival on HyperEVM is a plain `receiveMessage` any relayer may send (Stream C's delivery, on an EVM chain
this time — simpler than Solana's); then the account moves the USDC to HyperCore (system-address transfer) and
into the perp balance (action 7) in its `open`.

**Out.** `withdrawToBase`: action 7 (perp → spot), action 13 (`sendAsset` to the HyperEVM side), a CCTP burn
19→6 to the user's Base account. Three signatures if the user drives it; one owner instruction on the account
does the first two, the burn is the third.

**The reserve.** The top-up rung needs USDC that is *already on HyperCore* — a crossing takes minutes and the
rung exists because minutes are too long. So the account holds a **spot-balance reserve**: USDC sitting in the
HyperCore spot balance, never in the perp balance (where it would already be counted as margin and buy
nothing at the rung), sized as the Solana reserve is: the top-up the rung-2 crossing requires at the chosen
entry, `k ×` that amount (Advanced may set `k`; Simple takes the default), refused short at `open` and at
`withdrawToBase` — the same two gates as `deposit_for_burn` and `transfer_out`… with the same honesty as
BACKLOG O-6: the hatch (`exec`) can always empty it, and the keeper reports the shortfall. The Solana model's
finding (`MODEL-RESERVE-2026-09-19.md`) transfers with the sign flipped: on the bridge's timescale the reserve
is not the constraint; the entry is.

**The composition nobody has to design (v1.1, not beta).** A user whose margin USDC was borrowed on Kamino
against their ZEC holds two positions with opposite liquidation directions: ZEC down threatens the loan while
the short *gains*; ZEC up threatens the short while the loan *gets healthier*. Each leg's gain is the other's
rescue, and the CCTP rail moves it. Through the Base hub this needs no new contract — only a keeper that reads
both ladders as one book. It is named here so the account shapes do not preclude it; it is not in beta
(ROADMAP rule 2 would want something named to come off, and the audit scope diff has gone out).

## 7 · The screen (a fourth wizard, D6)

One decision per screen, the Base wizard's spine:

1. **Your ZEC** — "How much ZEC do you hold, and where?" Free text for *where* (informational; Oilskin cannot
   see it and says so), a number for *how much*. The short is capped at that number.
2. **The history** — the funding, as measured: the three windows' realised carry, the median, the extremes,
   the share of negative hours, each dated; the current hour's rate; **never** a projected rate, never the word
   yield. A sentence: "Between 2026-09-13 and 2026-09-25 ZEC rose 44 %; a short with less than $0.50 of margin
   per dollar would have been liquidated."
3. **Margin and distance** — the slider of §4 with the marks, the liquidation price in dollars, the up-move,
   the carry on *their* margin over each window; the acknowledgment below Sheltered.
4. **The keeper** — the PerpGrant in plain words: "may move up to $X of your reserve into the position per day,
   may close up to a third of the short per day if the price is within N % of liquidation, may close all of it
   at M %"; Advanced may set `reduceSzPerPeriod` to zero (the sell-budget-of-zero twin: then rungs 3–4 can
   only top up, and Hyperliquid liquidates at zero distance whatever the keeper may do).
5. **Review** — both legs as stated, the reserve that stays in spot, the crossing's time (minutes, Standard),
   the three disclosures: Circle can freeze USDC (the cross-chain copy, verbatim); Hyperliquid's CoreWriter and
   precompiles are upgradeable by Hyperliquid and a **backstop liquidation keeps the maintenance margin**; the
   hedge is only as good as the ZEC the user actually holds.
6. **Sign** — the crossing (Base), the open (HyperEVM), the grant.

The position page: the two legs, `d` as a bar with the rungs marked, the last 24 hours of funding signed, the
reserve, the keeper's last action, the exit hatch (`close` then `withdrawToBase`).

## 8 · Risks specific to this module (for `RISKS.md` §23 and the copy)

1. **The short is liquidated by a rise.** The whole of §4. Named on every screen after the first.
2. **Delta-neutral is asserted, not enforced.** A user who sells their ZEC keeps a naked short.
3. **Funding flips.** 4.2 % of the last 288 hours; −64 % annualised at the worst hour measured. Shown, not
   forecast.
4. **Seconds of delay on every action.** CoreWriter order actions land "a few seconds" later; the emergency rung's
   4.76 % floor is what those seconds are for, and ZEC's worst measured hour was −17.1 % (the reserve model) —
   in the other direction, but the number is the number.
5. **One venue, one price.** The independent price is the venue's own API; the check is against the venue
   lying to its precompile, not against the venue being wrong.
6. **Upgradeable venue system contracts.** CoreWriter and the precompiles are Hyperliquid's; a change to the
   action encoding is a change to what the account signs. The adapter pins the encoding by test and the keeper
   refuses to act when a read does not decode.
7. **Backstop liquidation keeps the maintenance margin**; partial liquidation over $100 k notional changes the
   size under the keeper's feet (the reader re-reads before every plan).
8. **A third key, a third chain to be down on**, and no Fast Transfer to it.
9. **Beta caps apply**: D8's $25,000 per user keeps every position in margin tier 0 and under the partial-
   liquidation size.

## 9 · Audit surface and the test plan

**Solidity, estimated** (feasibility §2c): the account ≈ the size of `OilskinAccount` (668 lines) less the
venue plumbing it does not need, plus a venue adapter of a few hundred lines and the router's two functions —
**700–900 lines**, all EVM, in the existing Foundry tree and the ABI seam. **Keeper**: a third chain adapter
reusing the store, the ladder engine, the notifier and the dispatcher discipline — 1,200–1,600 lines. **Yield
service**: the funding history reader and its windows — the numbers on the screen come from a dated sample,
regenerated by a script, like `demo-forecast.json`.

**Tests, in the order the Solana module proved works:**

1. Foundry unit: a `MockCoreWriter` that records the bytes it is sent, and mock precompiles `vm.etch`ed at
   `0x800`–`0x807` returning scripted positions and prices; every owner and keeper path, every refusal by
   name; the encoding of action 1 and 7 pinned byte-for-byte to what testnet later accepts.
2. Invariants: the keeper cannot move the position beyond the grant in any sequence; the entry record moves
   only on owner actions; the reserve gates hold except through the hatch.
3. **Testnet is the localnet**: the D0b gate (§2) is a script against Hyperliquid's testnet — one real order,
   one real position read, one real top-up, one real reduce, one liquidation observed — recorded in the facts
   file with the block and the bytes. A mainnet fork cannot run the precompiles.
4. Keeper: ladder replay on the equivalent HF; the monitor's Base tests re-run over the perps reader; the
   CoreWriter delay modelled as "the position moves N blocks after the receipt".
5. Web: the wizard on a recorded sample; the banned-words scan; Playwright on the demo.
6. An internal audit pass (D7) with the short-leg question asked adversarially: **can the keeper ever make the
   user's hedge worse than doing nothing?** (A reduce un-hedges; the answer is the grant's fraction and the
   rung's distance, and the pass must say whether that is enough.)

## 10 · Decisions for the founder

1. **The floor** — proposed L = 2 (a 42.9 % up-move, HF_eq 1.75); Sheltered 1.5, Expert 2 as marks. Yours.
2. **Cross margin, one position per account** — forced by CoreWriter's action table (no leverage or isolated-
   margin action) and the cleanest for the health model. Confirm, or the design waits for a venue change.
3. **The keeper may close the whole short at the emergency rung** — the twin of decision 1 of 2026-09-12 (it
   may sell collateral). Default on; Advanced may set the reduce budget to zero.
4. **The reserve multiple's default** — proposed 1 (the top-up rung's own requirement), the Solana model's
   finding that the entry matters more than the multiple carried over.
5. **Margin source in beta: the user's Base account only**, by CCTP Standard. The Kamino-funded composition
   (§6) is v1.1.
6. **The third key.** Where the HyperEVM keeper key lives, beside the other two.
7. **Testnet before Foundry**, or Foundry first with mocks and testnet as the gate? The Solana module did
   localnet first and it paid; the proposal is the D0b script first (§2), a week, and it decides whether any of
   §3's assumptions about a contract's HyperCore account are wrong before a line of Solidity exists.

## 11 · Not in this design

Isolated margin (no CoreWriter action); more than one perp per account; any long; a ZEC spot leg on
Hyperliquid (none exists); vault deposits (action 2); builder fees; the Kamino-funded composition (named in §6,
built later); portfolio margin; anything on Base's perps venues (there is no ZEC perp there — facts §1).

## 12 · Order of work (BUILD-PLAN Stream D, D0b → D7)

| Step | This document's section | Gate |
|---|---|---|
| D0b | §2's seven items, as a testnet script and a facts addendum | every item read, dated, recorded |
| D1 | this document | **the founder has read it and answered §10** |
| D2 | §3 — the account, the venue adapter, the router's two functions | Foundry green, ABI regenerated |
| D3 | §3's adapter against testnet | the D0b bytes accepted live |
| D4 | §4–§5 — the equivalent HF, the shared ladder, the keeper path | ladder replay green; testnet rungs observed |
| D5 | §6 — CCTP 6↔19, the reserve | one crossing each way on Base Sepolia ↔ HyperEVM testnet |
| D6 | §7 — the wizard, the measured history, the position page | Playwright; banned words green |
| D7 | §9 item 6 | `docs/AUDIT-<date>.md` |

The valve date for perps is **2026-11-13** (ROADMAP §3, D12): not building by then is v1.1. From today that is
seven weeks; §9's estimate is three to five of focused work after D0b.
