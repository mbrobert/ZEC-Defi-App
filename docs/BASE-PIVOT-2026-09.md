# The Base-first pivot — thinking, trade-offs, and the twenty things to fix

*Written 2026-09-05 in response to the founder's direction: fork the product into a Base-chain-first
approach built on cbZEC, accept a custodial entry, support cbBTC/WETH/other Base blue-chips as
collateral, aggregate best-in-class DeFi apps through their SDKs rather than rebuild them, and support
Coinbase Wallet, MetaMask and the popular self-custody wallets. Numbers below are from
`docs/research/VENUES-2026-09.md` and `INFRA-2026-09.md` (read 2026-09-04) and `docs/CBZEC-2026-09.md`;
anything not sourced there is marked as an estimate or an unknown.*

---

## 1. How cbZEC actually works (the founder's direct question)

cbZEC is **Coinbase Wrapped ZEC**, launched 1 September 2026, Base only, at
`0xB2000000000000000000008501b13360000cb2EC` (8 decimals). It is 1:1 backed by ZEC in Coinbase custody.

**Getting it — there is exactly one door, and it is Coinbase's.** A user with a Coinbase account deposits
ZEC to their Coinbase ZEC balance (a transparent address; sending from a shielded balance works because the
send itself de-shields), then in the app chooses **"Send ZEC on Base"**, gives any Base address, and cbZEC
arrives there. So yes: *a user converts the ZEC they hold on Coinbase into cbZEC by withdrawing it to Base.*
There is no on-chain mint, no smart contract a third party can call, and no way to get freshly-minted cbZEC
without a Coinbase account. Anyone can *buy* existing cbZEC on Base (the Aerodrome cbZEC/USDC pool), which is
how a non-Coinbase user would get some — at the cost of that pool's depth.

**Getting out** is the reverse: send cbZEC to a Coinbase address ("Receive ZEC on Base"), it auto-unwraps to a
ZEC balance, withdraw ZEC — **to transparent addresses only**. Full KYC (Know Your Customer) both ways.
Wrap/unwrap is **excluded in 100+ jurisdictions** — all of the EEA, Australia, Brazil, Singapore, Canada,
Japan, and New York — leaving effectively the US ex-NY (the UK is unverified). Fees, minimums and confirmation
counts are unpublished.

**Two technical facts that matter for us.** (1) cbZEC is a **B20 Asset-variant token** — Base's native
precompile token standard from the June 2026 Beryl upgrade — not a deployed ERC-20. B20 gives the issuer
blocklist policies, **`burnBlocked` (seize, not merely freeze)**, granular pause, a **rebase multiplier on
`balanceOf`**, and memos. Whether any restrictive policy is *configured* on cbZEC is an unpublished on-chain
read we must do before integrating; and every contract we write that holds cbZEC must be tested against a
token whose balance can change under it. (2) The proof-of-reserves page showed 570.96 ZEC held against 551.34
cbZEC on 2 Sep, in three transparent t-addresses, with no attestation firm and no stated cadence.

**Its state today (as of 2–4 Sep):** total supply ~604 tokens; one real venue, the Aerodrome Slipstream
cbZEC/USDC pool at `0x0Fc47C17AF86078d809358db1b4db2DeBC988566` (0.2% fee, ~$0.68M liquidity, ~$635K
day-one volume); a $51K Uniswap v4 pool; a cluster of counterfeit "ZEC" memecoins sharing the `0xb2000…`
address prefix. **No gauge, no emissions, no lending market, no Chainlink ZEC/USD feed on Base** (as of this plan; the gauge exists and carries one epoch's vote since 2026-09-10 — `CBZEC-PATH-2026-09.md`). Pyth has a
live `Crypto.ZEC/USD` pull feed (id `be9b59d1…bb24`).

---

## 2. Thoughts on the pivot

### What it fixes — and these are the things that were killing us

**It fixes the economics, which nothing else did.** The audit's central finding was that borrow-and-farm
against ZEC cannot clear its own borrow cost: the cheapest permissionless ZEC-collateral loan anywhere is
Rhea at **15.37%** (live 4 Sep), the best low-IL stable yield at scale is **~5.1%**, and emissions-only
Aerodrome positions are net negative after impermanent loss (IL) at every width. Break-even gross yield was
**20.1%**. On Base, USDC borrows at **4.60%** (Aave v3) and **3.99%** (Compound v3) — break-even drops to about
**6%**. That is the difference between a product that loses money by construction and one that can work.
*Caveat below: that rate is available today for cbBTC and WETH collateral, not yet for cbZEC.*

**It kills the NEAR leg and everything that came with it.** No NEAR Intents bridge (which pays out to
transparent addresses only and whose refund-address reuse has deanonymised users), no Rhea counterparty
(exploited for $18.4M on 16 April 2026, ~$4M of it in ZEC, compensation still "being finalised"), no 66.5%
effective liquidation line that we only verified this week, no 1-Click quote-tampering surface. Roughly a
third of the audit findings simply cease to exist.

**User-signed wallets kill the custody problem outright.** The single worst finding in two audit waves (D1)
was that the operator key was the position owner in the wallet-less design and could redirect principal.
With Coinbase Wallet / MetaMask / any EIP-6963 wallet signing, *the user's address owns the position on
Morpho, Aave and Aerodrome directly*. Our contracts stop being a custody vault and become a thin, stateless
**router** — one transaction that does "supply collateral → borrow → swap → deposit LP" and holds nothing
between calls. Smaller attack surface by an order of magnitude, and the paid audit gets cheaper.

**Multi-collateral makes the product real on day one.** cbBTC and WETH are *already* accepted on Aave v3,
Morpho and Compound on Base with deep liquidity and Chainlink feeds. "Deposit cbBTC, borrow USDC at 4.6%,
farm Aerodrome" works today with zero dependency on anything Coinbase or Chainlink does next. cbZEC becomes
the flagship asset that arrives when its market does — not the gate the whole launch waits behind.

**Aggregating instead of building is the right instinct.** Spot via an aggregator SDK, perps via a Base
perps venue's SDK, LP via Snuggle or direct Aerodrome, lending via Morpho/Aave — each is a mature integration
with its own audits. Our value is orchestration, monitoring, and holding the user's hand; rebuilding a perps
engine would be a year and a security nightmare.

### What it costs — stated plainly, because some of these are large

**The privacy thesis inverts.** Entry through Coinbase means Coinbase knows the person, the amount and the
destination address; reserves sit in transparent addresses; exits are transparent-only. The founder's own
read is that many large ZEC holders already hold on custodial exchanges, which is a real segment — but the
product must stop using the words "private", "shielded", and "non-custodial" about the entry, and the
privacy-first segment of the ZEC community may regard cbZEC as hostile. That is a positioning decision to
make consciously, not a detail.

**cbZEC is four days old and thin.** ~$0.68M of DEX liquidity is not enough for a lending market to be safe:
a liquidator who seizes $200K of cbZEC collateral has to sell it into that pool and will move the price
badly, which is how markets accrue bad debt. **Any cbZEC lending market — ours or Aave's — is only as safe as
cbZEC's exit liquidity.** This is the single biggest external dependency and it is out of our hands.

**B20 seize/pause/rebase is a new class of risk.** A lending market or LP position holding a token whose
issuer can burn balances or rebase them is exposed to policy changes we cannot see coming. Coinbase is a
credible issuer, and cbBTC has run for two years without incident — but cbBTC is a plain ERC-20 without
these powers. Our contracts must assume `balanceOf` can move.

**Jurisdiction limits shrink the addressable market at the entry.** US ex-NY (UK unverified) for
wrap/unwrap. Non-US users can still *buy* cbZEC on Base and use every other feature, and cbBTC/WETH users
are unaffected — but the "ZEC holder on Coinbase" onboarding story is US-only.

**Four product lines are four dependencies, each with its own failure modes and support burden.** LP
farming, spot, long/short, tokenized stocks — "one-stop shop" means being on the hook when any of them
breaks. The audit lesson applies: every integration needs its own adversarial pass, and the seams between
them are where defects live.

**The 15% Snuggle fee is still there on the LP leg**, and no managed-CL alternative beats it on verified
terms. Direct Aerodrome positions avoid it but then *we* are the rebalancer — a keeper we have to run and be
liable for.

**Some of the yield reality survives the move.** At a 4.6% borrow, blue-chip pools with real emissions can
clear — but the emissions-only, IL-drag model still applies and must be re-run before any pool is offered.
The gate stays computed, not curated.

---

## 3. The two things "out of our control" — and whether we should take control

### 3a. The cbZEC collateral market

There is no market. Aave/Morpho/Moonwell listing needs a price feed *and* a risk curator *and* lender
liquidity — Aave in particular is slow and governance-gated. The founder's instinct that these "will quickly
emerge" is probably right *eventually*; cbXRP got a Morpho market at launch — but only because a Chainlink
XRP/USD feed already existed.

**Can we build it ourselves? Yes — and it is a genuine business.** Morpho Blue market creation on Base is
**permissionless**: anyone can deploy a market with (loan token, collateral token, oracle, interest-rate
model, LLTV) and it is immutable thereafter. On top of it, a **MetaMorpho vault** ("Oilskin cbZEC-backed USDC")
aggregates lenders and charges a **curator/performance fee** — that is the revenue stream the founder asked
about. Euler v2 offers the same permissionless path. Being the first curated cbZEC market on Base is
first-mover positioning in the exact niche the product serves.

**What we would own if we do this — the honest side:**
- **We own the risk parameters.** The LLTV (liquidation loan-to-value) and oracle choice are ours. Set LLTV
  too high against thin liquidity and bad debt lands on *our* vault's lenders and *our* reputation. At today's
  depth, a defensible LLTV is far below what the product wants to advertise; an estimate, not a
  measurement: think 50–62.5% (Morpho's standard tiers), sized so a liquidation of the largest position is a
  small fraction of DEX depth. That needs a quantitative liquidity study before launch, not a guess.
- **We need lenders.** A market with no USDC supplied lends nothing. We seed it (capital at risk), attract
  lenders with the rate, or partner. This is a go-to-market problem as much as a technical one.
- **We run the oracle** (see 3b) and its circuit breaker.
- **cbZEC's peg to ZEC is a Coinbase promise, not a mechanism.** In a Coinbase incident, cbZEC trades below
  ZEC and a ZEC/USD oracle overvalues the collateral. The market must price the *risk of cbZEC*, not ZEC.

**Recommended shape (design, not a capital decision):** build the market and the vault as a v1.1 deliverable
behind a liquidity gate — deploy when cbZEC DEX depth clears a threshold we set from the liquidity study.
Launch v1 on cbBTC/WETH with existing Aave/Morpho markets, so the product is live and earning while cbZEC
matures. Everything about our router, monitoring and UI is identical either way.

### 3b. The price feed

No Chainlink ZEC/USD feed on Base. Chainlink lists a ZEC/USD CEX-price *Data Stream*, which is a different
product (pull-based, paid). **Pyth has a live ZEC/USD pull feed today.** A Morpho market takes any contract
implementing `IOracle.price()`, so a **Pyth-backed oracle adapter** is a ~100-line contract plus a keeper that
posts price updates. That is "reasonable", as the founder asked.

Two hard requirements on that adapter: **staleness** (revert or freeze borrows if the Pyth price is older than
N seconds) and a **peg circuit breaker** — compare the Aerodrome cbZEC/USDC time-weighted price against Pyth
ZEC/USD and pause new borrows when they diverge beyond a threshold. Without the breaker, the market prices
ZEC when it holds cbZEC. Pyth itself is a dependency with its own history; the adapter must fail closed.

---

## 4. The twenty things to address and fix — in priority order

Priority is by "blocks launch" first, then "blocks cbZEC", then "makes it good". Items marked **[own]** are
entirely in our control; **[ext]** depend on someone else and get a fallback.

**Foundation (everything else sits on these)**

1. **[own] Wallet connection and user-signed transactions.** wagmi + viem, EIP-6963 multi-wallet discovery,
   Coinbase Wallet SDK, MetaMask, WalletConnect. The user's address owns every position. This single change
   retires the operator-custody model, the `payoutHash` design, `openFor`, and the entire D1 finding. Replaces
   "find my position by payout address" with "connect wallet".
2. **[own] Retire the NEAR leg completely.** Remove Rhea SDK, 1-Click client, ZEC-address validation from the
   deposit path, NEAR rates from the yield service, and every doc/UI claim about shielded or private entry.
   Then grep the whole tree for anything that still refers to it (the founder's standing rule).
3. **[own] Collateral registry with per-asset risk parameters.** cbZEC, cbBTC, WETH (extensible): decimals,
   oracle source, the venue it is accepted at, max LTV we will *offer* (below the venue's LLTV by a margin
   derived from the ladder — the D2 arithmetic, now per asset), liquidity depth, and an `enabled` flag.
   cbZEC ships `enabled: false` until item 12 exists.
4. **[own] Lending-venue abstraction.** One `CollateralVenue` interface with Aave v3 and Morpho Blue
   implementations on Base (Compound v3 optional). Health factor, borrow, repay, withdraw, liquidation
   threshold — read from the venue, never hard-coded. Replaces `rhea.ts`/`rheaSdk.ts` and the 0.70 constant.
5. **[own] Stateless router contract.** One transaction: approve (Permit2) → supply collateral → borrow USDC
   → swap → deposit into the LP venue, with deadline and slippage on every hop, no balances held between
   calls, and no owner on the router itself. Unwind path is the mirror. This is the whole of our on-chain
   surface for v1 and it is small enough to audit properly.
   *(Corrected 2026-09-06: this item originally generalised the router's lack of an owner into a claim about
   the product. The router has no owner and holds nothing — but the `CollateralRegistry` does have an owner,
   with the powers set out in `RISKS.md` §16, so the generalisation was wrong and the phrasing is retired.)*
6. **[own] cbZEC B20 handling.** Read the live policy state (blocklist, pause, multiplier) on-chain before
   integration; test every contract path against a mock whose `balanceOf` rebases and whose transfers can be
   blocked; surface issuer-policy risk in the UI. Pin the real cbZEC address and show a counterfeit warning
   for any `0xb2000…` look-alike.

**The product lines (aggregated, not rebuilt)**

7. **[own] LP farming on Aerodrome — two modes.** Via Snuggle/MaxFi (their 15% fee, their keeper; the
   existing adapter knowledge carries over — user's wallet is the depositor) and **direct** (no engine fee, our
   keeper or the user rebalances). Emissions-only model, re-run at the Base borrow rate; gate stays computed.
8. **[own] Spot buy/sell through one aggregator SDK.** CoW Protocol for MEV-protected batch auctions (2 bps,
   free expiry) or 0x/Odos for coverage — one, not three. Quote → user signs → settle. No custody.
9. **[ext→own] Long/short.** Integrate a Base perps venue through its SDK (candidates to verify: Avantis,
   Synthetix Perps on Base). Delta-neutral "earn funding on your ZEC" is the one ZEC-linked return above
   borrow cost the research found (~11–13%/yr to shorts *today*, already negative on two venues) — offer it as
   an advanced strategy with the short-leg liquidation risk stated, never as "yield".
10. **[ext] Tokenized stocks.** Verify what is live on Base (Dinari dShares, Ondo, Backed xStocks) and which
    have Aerodrome pools with emissions; integrate only what has depth. Regulatory posture (KYC on the
    issuer's side, US-person restrictions) must be understood before it is offered.
11. **[own] Position dashboard read from chain, not from our store.** With user-owned positions the source of
    truth is Morpho/Aave/Aerodrome/Snuggle state for the connected address. Our indexer becomes a cache, never
    an authority — this also retires the two-tab and store-schema bugs.

**cbZEC specifically**

12. **[own, gated] The Oilskin cbZEC/USDC Morpho market + MetaMorpho vault.** Per §3a: liquidity study →
    LLTV → deploy behind a depth gate. This is the revenue line and the unblocker for cbZEC leverage.
13. **[own] Pyth ZEC/USD oracle adapter with staleness + peg circuit breaker.** Per §3b.
14. **[own] Coinbase-to-cbZEC onboarding flow.** "Have ZEC on Coinbase? Three steps." with the jurisdiction
    check up front, the transparent-only and KYC facts stated, and the counterfeit warning. Plus the
    "already on Base" path for cbZEC/cbBTC/WETH holders.

**Automation, honesty, and the security carry-overs**

15. **[own] Keeper with user-bounded permissions.** Rebalance / auto-compound / deleverage on the user's
    behalf via Coinbase Smart Wallet **Spend Permissions** or ERC-4337 session keys — per-token, per-period,
    revocable by the user. The health-factor ladder and hysteresis logic from the audit carries over
    unchanged; the venue it watches changes.
16. **[own] Yield model and gate re-run for Base.** Every pool × width × collateral at the live Base borrow
    rate; emissions-only; IL drag; nothing offered that does not clear. The three surfaces (simple, advanced,
    yield service) must agree to 0.1 pt from one generated source, as before.
17. **[own] Fee model, single source.** Decide what we charge (orchestration bps, performance share on
    realised yield, vault curator fee) and implement it in one place with a hard cap; every surface derives
    from it. The audit found the 10% fee "existed" in docs and nowhere on-chain — do not repeat that.
18. **[own] Transfer the security fixes that survive the pivot.** From `docs/AUDIT-FINDINGS-2026-09-03.md`:
    Snuggle `userPositions` index enumeration (C-2) if Snuggle stays; width bounds [150, 5000] and computed ±;
    refund folding; the re-mint price band from `slot0()`; `verify-abi.mjs` wired into the test suite;
    fail-closed health mapping; ladder hysteresis and re-arm; bounded accrual and deposit idempotence in the
    UI. Everything NEAR-specific is dropped, not ported.
19. **[own] Disclosures rewritten for the new reality.** Custodial entry, KYC, jurisdiction, B20 seize/rebase,
    cbZEC peg risk, our-own-market risk if item 12 ships, liquidation, IL, keeper dependence, smart-contract
    risk, demo status. The words "private", "shielded", "non-custodial", "locked payout address" leave the
    product unless a specific surface still earns them.
20. **[own] Pre-audit tooling and CI for the new surface.** Slither + Aderyn on every push, Halmos on the
    router invariants, Tenderly simulation of the full deposit/unwind against Base mainnet state, fork tests
    that run in CI against Base (Aave, Morpho, Aerodrome, cbZEC) — because C-2 was invisible to any suite
    that did not touch the chain.

---

## 5. Sequencing — what launches when

**v1 (launchable now, nothing external required):** items 1–8, 11, 15–20 on **cbBTC and WETH** collateral via
Aave/Morpho, LP farming on Aerodrome, spot via an aggregator. Every ZEC holder who already has cbBTC or WETH
can use it on day one; cbZEC holders can *use* cbZEC in LP and spot but not yet as collateral.

**v1.1 (the cbZEC unlock):** items 12–14, gated on the liquidity study. If Aave or another curator lists cbZEC
first, we integrate theirs through the item-4 abstraction and our market becomes a second venue rather than
the only one.

**v1.2:** items 9–10 after the perps and tokenized-stock venues are verified.

**What was lost and what is not.** The round-2/3 code was lost to a container recycle; its *findings* are in
`AUDIT-FINDINGS-2026-09-03.md`. Under this pivot roughly a third of those findings are moot (NEAR, 1-Click,
Rhea, payout-hash custody), a third transfer directly (item 18), and a third were about the wallet-less
design and are replaced by item 1. The base for the fork is the founder's 2026-08-29 working tree
(contracts 73 / agent 72 / yield 41 green after toolchain restore).

## 6. Open questions the founder should weigh (not decisions I am making)

- Positioning: does the product still speak to privacy-first ZEC holders, or explicitly to exchange-custodied
  ones? The copy, the name, and the community strategy all follow from this.
- Capital: does Oilskin seed its own cbZEC market's USDC side, and with how much at risk?
- The perps line: "earn funding on your ZEC" is the only ZEC-linked return above borrow cost the research
  found — and it is a leveraged short with liquidation risk. Is that a strategy the product should offer to
  the hand-held user it is designed for?
- Jurisdiction: is a US-ex-NY onboarding funnel acceptable for v1?
