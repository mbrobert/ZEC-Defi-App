# Feedback round 1 — answers & decisions (2026-08-13)

Every question from the 2026-08-13 feedback, answered. Research behind the
market/wallet claims was done today with sources; anything not yet verified
first-hand is labelled. The prototype changes shipped alongside this doc are
listed at the end, mapped item-by-item to the feedback.

**One finding you need before anything else:** Rhea Finance — our lending
venue — was exploited for **$18.4M on April 16, 2026** via a slippage/margin
validation flaw. Confirmed across The Block, Halborn's post-mortem, and
rekt.news; reporting indicates funds were substantially recovered/returned and
the protocol continues operating. This does not kill the plan, but it changes
posture: see §3 for what we do about it, including a credible alternative
venue (Templar) that didn't exist in our original research.

---

## 1 · Wallets: what ZEC holders use, and the web3 question

**First, one correction to the question's premise: Rhea runs on NEAR, not
Solana.** Aerodrome runs on Base. So the chains in play are Zcash ⇄ NEAR ⇄
Base — Solana is not in our stack.

**Second, and more important: in our architecture the user's Zcash wallet
never needs to speak web3 at all.** That is a deliberate design decision, and
the wallet research confirms it's the right one:

- The user funds a position by sending plain ZEC (L1) to a fresh deposit
  address we display. Any Zcash wallet can do that.
- The NEAR leg (Rhea) and Base leg (LP engine) are driven by our agent and
  contracts, not by the user's wallet.
- The user receives rewards/withdrawals as plain ZEC back to an address they
  give us. Again, any wallet.
- The only place a web3 wallet appears is Base-side position custody (the
  vault authorizes withdrawals by the user's EVM address). **MetaMask is fine
  for this**: it supports Base natively (and Solana since 2025, and NEAR only
  via a community Snap — irrelevant to us).

**What ZEC holders actually use (researched today, sourced):**

| Wallet | Shielded ZEC | Web3 / dApps | Notes |
|---|---|---|---|
| **Zodl** (ex-Zashi, the flagship — ECC team spun out Feb 2026) | Yes, shielded-by-default | **None** | Scans ZIP-321 payment QRs; auto-shields received ZEC |
| Ywallet | Yes | None | Flagged "Ironwood not ready" after the July 2026 network upgrade — treat as degraded |
| Zingo | Yes | None | First Orchard wallet |
| **Unstoppable** | **Yes (Orchard, 1-tap shield)** | **Yes — WalletConnect + Base + Solana** | The one genuine single-wallet option |
| Edge | Sapling only | Yes — WalletConnect + Base | Second single-wallet option |
| Trust Wallet | **Transparent only** | Yes | Holds t-ZEC + EVM dApps |
| Exodus | **Transparent only** (official) | Yes | |
| Brave Wallet | Yes (desktop, Orchard) | Yes (EVM/Solana dApps) | Desktop only for ZEC |
| MetaMask | Via ChainSafe "Zcash Shielded Wallet" Snap (audited, live Jul 2025) | Yes | Extension only |
| Ledger / Trezor | **Transparent only** | via pairing | |
| Exchanges | t-addresses (exception: Gemini does shielded withdrawals) | — | ~70% of ZEC supply is still unshielded |

**Answers to your specific questions:**

- *"Which wallet are ZEC holders likely to use?"* Zodl is the flagship and
  what z.cash points people at; Ywallet/Zingo for power users; a large share
  of holders still sit on exchanges/transparent addresses. Design for Zodl
  first (our wallet picker already does), accept everything.
- *"Does it support chains like Solana/Base?"* Zodl supports nothing but
  Zcash — and that's fine, because our flow never asks the ZEC wallet to touch
  another chain. Users who want one app for both sides can use **Unstoppable**
  (shielded ZEC + WalletConnect + Base) — we should document that as the
  recommended single-wallet setup.
- *"Does MetaMask support that?"* MetaMask: Base ✓ (native), Solana ✓ (native
  since 2025), NEAR ✗, Zcash ✗ (only via the ChainSafe Snap). MetaMask is the
  right default for the Base side only.
- *"The ZEC wallet will have to support web3 apps."* It genuinely doesn't —
  and there is **no standard by which it could**: there is no
  `window.zcash`, no WalletConnect-for-Zcash, and shielded balances are
  unreadable by third parties *by design* (that's the product ZEC holders are
  buying). The practical bridge is **ZIP-321 payment URIs**: we render a QR
  encoding `zcash:ADDRESS?amount=X`, the user scans it in Zodl/Ywallet, and
  the send is pre-filled from their shielded balance. That's now in the
  deposit flow. Two-wallet UX is the honest default; one-wallet
  (Unstoppable) is the documented alternative.

**Consequences you asked about elsewhere but that belong here:** the "MAX"
button can never read a Zcash balance (no API + shielded balances are
private even from us), and the reward-address box can't auto-populate from
the connected wallet (that wallet is EVM — an 0x address can't receive ZEC).
What we can do, and now do: remember the last payout address you used and
offer it back with an explicit reuse warning (fresh addresses are better for
privacy), and pre-fill the amount into the wallet via the QR.

---

## 2 · The 15% fee: fork the engine, or ride it? (the big one)

**Where the fee actually sits:** verified from the deployed contracts — the
engine (MaxFi/SnuggleFi are the same protocol at bytecode level,
`SnuggleVaultUpgradeable`) takes **15% of earnings only** (trading fees +
staking incentives, at harvest). Deposits, withdrawals and principal are
never touched. So the fee scales with yield, not TVL.

**Can we just copy their contracts?** Technically the source is verified and
public on Blockscout. Three hard realities before "copy-paste":

1. **License — unverified, must check first.** Many DeFi vault systems ship
   under BUSL (Business Source License), which prohibits production forks for
   several years. Action item: read the SPDX header on the verified source.
   If it's MIT/GPL, forking is legal; if BUSL, copying verbatim is not an
   option (a clean-room reimplementation still is).
2. **The contracts are the cheap half.** The engine's real product is its
   keeper infrastructure: range monitoring, rebalance execution, gauge
   staking, compounding across 206 pools. Fork the contracts and none of that
   comes along — our agent would have to do full position management (tick
   math, rebalance timing, MEV-protected execution), not just parameter
   passing. That's the difference between the thin-adapter architecture that
   held up under fork testing and owning an ALM.
3. **Copied code is new attack surface.** Gamma's own vault logic was hacked
   for $3.4M; our fork tests found two real bugs (F-1, F-4) in just our thin
   adapter seam. A fork needs its own audit ($30–80k) and ongoing ops.

**The honest math** (assumptions: full-strategy TVL at 40% avg LTV, so
deployed LP ≈ 40% of collateral; 20% gross LP APR; illustrative):

| Collateral TVL | Deployed LP | Gross rewards/yr | Engine path: our 10% after their 15% | Self-run path: 15% all ours | Delta |
|---|---|---|---|---|---|
| $2M | $0.8M | $160k | $13.6k | $24k | +$10k |
| $10M | $4M | $800k | $68k | $120k | +$52k |
| $30M | $12M | $2.4M | $204k | $360k | +$156k |

Self-running costs roughly $100–150k up front (build + audit) plus ongoing
keeper ops. **Break-even sits around $25–30M TVL** — not $2M. Below that, the
fork burns money and time you should spend on distribution.

**Recommendation — phase it:**

- **Phase 1 (now): ride the engine, charge a platform performance fee on
  top.** Ship revenue this quarter with zero new audit surface. The engine's
  15% is their fee for genuinely running the positions.
- **Phase 2 (trigger: ~$25M TVL, or the engine raising fees/becoming a
  dependency risk): move to our own position manager** — ideally a lean
  clean-room build, not a verbatim copy. The migration story is clean for
  users: at a 15% self-run fee they keep exactly what they keep today; at
  12% they're strictly better off *and* every fee dollar is ours.
- **Phase 1.5 (cheap, do it soon): email the SnuggleFi team about an
  integrator revenue share.** ALM protocols routinely share performance fees
  with front-ends that bring TVL. Unverified whether they offer it — one
  email finds out, and any share moves the break-even further out.

**Your own fee — design answers:**

- **Base it on rewards, not deposits.** A deposit fee punishes principal,
  deters the large depositors you want most, and reads as CeFi. A performance
  fee only earns when the user earns — that alignment is also your marketing
  copy.
- **Recurring, not one-time** — netted automatically at every harvest/claim
  (same event where the engine takes its cut), itemized in the UI. One-time
  fees decouple your revenue from TVL retention, which is the metric that
  matters.
- **Rate: 10% of rewards at launch.** Benchmarks: Beefy ≤9.5% total, Gamma's
  class ~10–15%, Yearn historically 20%. Stacked on the engine, users keep
  ~76.5% of gross — that is heavier than Beefy, which is exactly the phase-2
  argument. Two softeners worth considering: a launch promo (0% platform fee
  for the first 60 days or first $1M TVL — social proof is worth more than
  the ~$5k it forgoes), and Simple-lending mode staying free or at 5%
  (it costs us almost nothing to run and is the on-ramp).
- The prototype now shows the platform fee as its own itemized line
  everywhere yield is broken down. No hiding it — fee opacity is the #1
  documented complaint against the ALM incumbents.

---

## 3 · Competitors — who's doing this, and what they got wrong

**Direct answer: nobody runs the full loop** (native ZEC in → collateralized
borrow → cross-chain LP → auto-compound → native ZEC home, privacy-first).
The seat is empty. The closest things, researched today:

- **Dew Finance "Zcash Vault"** (Meteor Wallet's sister co., on NEAR via
  Rhea): deposit-ZEC-and-forget, ~8% APY. First to market — and had **7 ZEC**
  deposited after ten days. Lesson: for shielded-money holders, distribution
  = trust; APY converts nobody by itself. Win the Zcash forum and wallet
  relationships before polishing anything.
- **Templar Protocol**: borrow USDC/USDT against **native ZEC with no
  bridging** — collateral held by a 30-node MPC, NEAR Chain Signatures, no
  KYC, floating 0–8% borrow rates, liquidation at 120% collateral ratio.
  Borrow-side only — no deployment loop, no compounding, no ZEC-home routing.
  **This is our most credible adjacent competitor AND a candidate second
  venue**: if their rails hold up, "borrow against ZEC without your
  collateral ever leaving Zcash-native custody" is a privacy story that beats
  bridging to NEAR. Worth a serious evaluation for v2.
- **Rhea itself** lends ZEC (6–12% supply APY marketing) — and was exploited
  for $18.4M in April (margin-engine validation flaw; attacker partly exited
  through Zcash's shielded pool, which the press noticed). Funds largely
  recovered per post-mortems; protocol operating. What this means for us:
  per-venue exposure caps from day one, our agent independently monitoring
  collateral/borrow invariants rather than trusting venue UI numbers, a
  kill-switch that pauses **new deposits only** (withdrawals stay
  unpausable — already our invariant), and honest acknowledgment in our docs.
  Expect "ZEC = hacker exit ramp" headlines to be thrown at the privacy
  narrative; pre-write the response.
- **zenZEC (Zenrock, Solana)**: wrapped ZEC as a transparent SPL token —
  privacy destroyed at the wrap, plus bridge-custody dependency. $15M volume
  proves demand for ZEC-in-DeFi; their design proves the gap we fill.
- **Maya Protocol**: native ZEC swaps + ZEC/CACAO LP (~5% APY, $4.4M TVL) —
  forces 50% exposure to CACAO (~91% off ATH). Their own contributor
  publicly conceded cross-chain "shielded" swaps still leak metadata.
- **CeFi**: Kraken auto-earn (geo-blocked for US, commission undisclosed),
  Gate ~0.9%, OKX ~1%, custodial. Ledn went Bitcoin-only in 2025 and dropped
  altcoin users entirely. That's the incumbent offer: ~1%, custodial,
  US-excluded. **Our real competitor is "HODL shielded at 0%"** — price and
  message against that.

**Mistakes to not repeat (each documented, each now reflected in product):**

1. Gauntlet's ALM study: Arrakis V1 median APY was **1–3%**, and ~half of
   Gamma's ~15% was unsustainable external incentives → we display fee APR
   and incentive APR as separate components, and show trailing realized
   yield, not projections dressed as promises.
2. ZachXBT deanonymized Zashi's own NEAR-Intents flow via **reused refund
   addresses and timing correlation** (Oct 2025; ECC had to retrofit
   ephemeral addresses) → our refund-address and reuse rules aren't
   paranoia, they're the exact failure mode; privacy must hold on failure
   paths (refunds, retries, dust), not just the happy path.
3. Summer.fi's automation layer was exploited (~$6M, Jul 2026) — the keeper
   had too much authority → our agent's least-privilege split (operator can
   manage yield, can never redirect principal) is the defense; keep it
   absolute.
4. Coinbase BTC loans: **$170M liquidated in one week** (Feb 2026) despite
   30-minute alerts → notifications don't save volatile-collateral
   borrowers; conservative default LTV + automatic soft-deleveraging do
   (§5).
5. Fee opacity is the top recurring complaint against ALMs → itemized fee
   lines everywhere, a Fees page in the docs, no asterisks.
6. Arrakis lost $300M TVL to one whale withdrawal → whale-concentrated TVL
   is fake traction; per-pool caps (which we already have for exit-quality
   reasons) also cap this.

---

## 4 · Liquidation: how it works, soft vs hard

Two layers, and the design goal is that users only ever meet the first one.

**Hard liquidation (Rhea's, protocol-level).** If account health factor
reaches 1.0, third-party liquidators repay a portion of the debt and seize
collateral at a discount (partial liquidations, standard money-market
mechanics — exact bonus/close-factor parameters to re-verify post-exploit
before mainnet). This is the worst outcome: the discount is paid by you, at
the worst price, at the worst time.

**Soft deleveraging (ours, agent-level) — runs before Rhea ever gets
involved.** Your instinct ("first repayment comes from any available rewards,
then start selling off bits") is exactly right, and it's now the specified
ladder:

| Trigger | Action |
|---|---|
| HF ≤ 1.5 | Warn + notify. New borrows blocked. Compounding continues. |
| HF ≤ 1.35 | **Rewards-first repay**: all claimable rewards route to debt repayment instead of compounding — zero principal touched. |
| HF ≤ 1.2 | **Minimal unwind**: sell just enough LP to restore HF to 1.6. |
| HF ≤ 1.05 | Emergency full unwind of LP → repay → collateral safe. Slippage floors still apply (a wider emergency tier, but never uncapped). |

**"What's the optimal amount to repay?"** Closed form. With debt *D*,
collateral value *C*, liquidation threshold *LT* (0.70 on Rhea for ZEC), to
restore a target health factor *HF\*.*:

> repay = D − (C × LT) / HF\*

Example: C = $27,246, LT = 0.7, D = $10,027 → HF = 1.90. ZEC drops 40% → C =
$16,348, HF = 1.14. To restore HF 1.6: repay = 10,027 − 16,348×0.7/1.6 =
**$2,875** — about 29% of the debt, not all of it. Unwind order: pending
rewards first, then the most out-of-range / lowest-yielding LP slice, then
pro-rata. Minimal unwinds mean minimal realized slippage and minimal taxable
events.

One nuance now shown in the UI: Rhea collateral is account-level (one MCA
per user), so the health factor is one number across all your positions, not
per-position.

---

## 5 · Mechanics you asked to have explained

**How "Compound now" works.** Click → engine harvest collects accrued
trading fees + incentives → engine nets its 15%, we net our platform fee →
remainder is re-deposited into the same position at the same range → the
60-second hold restarts (every deposit restarts it, including this internal
one). Now available on **every** position regardless of the auto-compound
setting — auto-compound just means the agent does this for you when
economics clear.

**What triggers auto-compound.** Not a timer. The agent evaluates every
cycle and fires when **claim economics clear**: accrued ≥ 3× (gas + bridge
cost), ≥ $5 absolute, or 30 days elapsed with anything accrued — whichever
gates. It also compounds opportunistically during rebalances, because a
rebalance collects fees anyway (the marginal cost of compounding at that
moment is ~zero). So: economics-gated, with a free ride on every rebalance.

**Claim economics, explained.** Claiming costs real money (Base gas +, for
ZEC-home routing, bridge cost). Claiming $0.40 of rewards for $1.50 of costs
is negative yield theater — some incumbents do it anyway because it looks
active. Our rule: claim when rewards ≥ 3× the cost of claiming, with a $5
floor and a 30-day maximum hold. Worked example: costs $1.80 → trigger is
max(3×$1.80, $5) = $5.40. The $5 floor also does privacy double duty: every
ZEC payout is comfortably above wallet auto-shield dust thresholds, so
payouts never strand as unshieldable dust.

**Claimable rewards — where do the funds go?** Wherever you point them, per
claim. Every position now offers three destinations:

1. **Your Zcash wallet** — converts via 1-Click (quote hard-verified:
   recipient must equal your stored address, asset must be native ZEC) and
   lands as ZEC.
2. **Your Rhea position** — repays debt first (raising your health factor —
   this is usually the smartest destination when you're borrowing, since
   borrow APR > supply APY), any surplus tops up collateral.
3. **Your Base wallet** — the raw reward tokens (USDC/WETH/AERO…) sent to
   your connected EVM address, no conversion.

"Claim all" on the dashboard uses each position's saved preference.

**How withdraw works.** Partial withdrawals: the engine has no partial-exit
call, so the adapter closes the position and re-opens the remainder — which
is why a fresh 60s hold applies to what stays. Where the money goes is now a
choice in the withdraw modal: repay loan (default when you have debt — HF
preview shown before you confirm), send home as ZEC via 1-Click, or keep as
tokens on Base. Withdrawn funds do **not** silently re-supply to Rhea;
repaying debt beats adding collateral (it reduces interest paid, and frees
collateral mathematically faster).

**The slippage floor.** Before any exit, we compute what the position should
be worth from current pool state and set `minOut` = that value minus a small
tolerance. If an MEV bot sandwiches the exit and the real proceeds would come
in under the floor, the transaction reverts instead of accepting the bad
price. This came directly out of fork-test finding F-4 ($250k round-trip
losing >1% in a thin pool) — the floor plus per-pool exposure caps are the
fix.

**The 60-second hold, again, plainly.** It's the engine's flash-loan/JIT
defense (`MIN_POSITION_HOLD_TIME`, verified on-chain): a position must exist
60s before it can exit. It restarts on *every* deposit into the position —
including compounds and the internal re-deposit behind a partial withdrawal.
Cosmetic in normal use; the UI shows the countdown so it never surprises.

**Health factor when there's no debt.** It's infinite, and the UI now says
so — "∞ · no debt" with a full green band — instead of showing a stale
number. HF also now recomputes live on every action that changes collateral
or debt (withdraw, repay, claim-to-Rhea, new borrow). And the bug you found
is fixed properly: **you can no longer withdraw Rhea collateral past the
point your debt allows** — the app enforces post-withdraw HF ≥ 1.2 (stricter
than the protocol's 1.0), the slider caps there, and withdrawing everything
requires debt = 0. A one-click "Unwind everything" (close LPs → repay →
release collateral → send home) is the escape hatch.

**"Adjust parameters" now actually works.** The modal edits range width,
rebalance delay, auto-compound, and the payout address; applying calls the
engine's `updateParameters` (no close/re-open, no new hold) and you can see
the position card update. In the prototype it mutates the demo position so
you can test the full flow.

**APR projections — source and honesty.** In the prototype: illustrative
demo numbers, seeded from a GeckoTerminal snapshot of real pool volume/TVL
(2026-08-05), labeled as estimates. In production they must be computed, not
quoted: fee APR = trailing 7-day swap-fee growth from pool contracts,
annualized; incentive APR = gauge emission rate × token price ÷ staked TVL;
each displayed as its own component (the Gauntlet lesson), minus both fee
layers, labeled "7-day trailing, not a forecast," with the data path recorded
in docs/VERIFIED.md. Any number we can't compute from chain data doesn't
ship.

**What's the engine pool id?** The `bytes32` key the engine's on-chain
registry uses to identify each approved pool — it is the exact argument our
deposits pass (`depositSingleSided`). We show it so anyone can verify against
the registry that the pool you picked is the pool you got. It's now behind an
ⓘ in the wizard (with this explanation) and stays fully visible in the Pools
table for the auditors.

**Pool list & the missing-pairs bug.** Fixed as you specified: the wizard now
shows **every pool containing the borrowed asset** on either side (borrow
WETH → WETH/USDC, cbBTC/WETH, cbETH/WETH, AERO/WETH all appear). Expansion:
the registry enumeration (2026-08-06) found 47 major-pair pools; we curate 10
today and have 5 named next candidates already engine-verified as pairs
(EURC/USDC, WETH/EURC, EURC/cbBTC, cbETH/cbBTC, WETH/wstETH) — their ids get
pinned at the next enumeration run before they're depositable. Criteria for
listing: in the engine registry + ≥$1M TVL + real sustained volume + one side
in {USDC, cbBTC, WETH} or a correlated pair.

**Direct-to-LP (no borrow) — added.** Third mode in the wizard: swap ZEC
straight into the pool assets and LP, no loan, no liquidation risk. The
trade-off is stated in the flow: swapping ZEC is a disposal — the
borrow-against-collateral route exists precisely so holders can earn without
selling (not tax advice, but the mechanism is real and it's why Full
strategy leads).

---

## 6 · Max LTV to 75%? No — and here's the math

Two independent blockers:

1. **The venue won't allow it.** Rhea's protocol max for ZEC is ~60%
   (recorded during integration; re-verify post-exploit). 75% can't be
   selected regardless of what our slider says.
2. **The math is brutal at ZEC volatility.** Liquidation begins when price
   falls by 1 − LTV/LT. At LT = 0.70:

| LTV | Price drop to liquidation |
|---|---|
| 35% (our default) | −50% |
| 50% (our cap) | −29% |
| 60% (venue max) | −14% |
| 75% | **instantly liquidatable — LTV exceeds LT** |

ZEC regularly moves 15%+ in days. At 60% LTV a normal bad week liquidates
you; at 75% you're underwater at inception. Coinbase's BTC borrowers — far
less volatile collateral — lost $170M in one week in February. Every forced
liquidation is a user who tells the Zcash forum we lost their coins.

Keep 50% as the hard cap and 35% as the default. If capital efficiency is
the goal, two better levers: prefer **cbBTC as the borrow asset** (it's
partially correlated with ZEC, so a ZEC drawdown drags the debt down too,
cushioning HF — USDC debt has zero cushion), and later consider an "expert
mode" 55% behind an explicit red-gate acknowledgment. I'd ship neither until
the soft-deleveraging ladder (§4) is live and proven.

---

## 7 · Growth & trust

**TVL / social proof metric.** Good instinct, and cheaper than you think: we
don't need a new smart-contract stack — **our contracts already exist**
(PositionVault + adapters on Base, plus the Rhea MCA positions). TVL = vault
holdings + Rhea collateral, read by a small indexer; "Total value processed"
= cumulative deposit volume from our own event logs (monotonic — never goes
down in a drawdown, which is why it's the better early number). Both now
show in the app (demo-labeled). Two rules: never show a fake number publicly
(this audience reads chains for sport), and get listed on DefiLlama at
launch — that's the social proof that actually converts DeFi users, and it's
free.

**Reducing friction → repeat users.** Shipped in this round: 2-click deposit
path (presets + advanced collapsed), deposit QR that pre-fills the user's
wallet send (ZIP-321), live per-step progress with verifiable tx links, an
in-app Docs tab, per-position claim/compound buttons, honest fee lines,
mobile layout. The next tier, recommended in order of conversion impact:
(1) **gas abstraction** — the user never needs NEAR or ETH for gas, costs
fold into the fee (invisible plumbing is the single biggest "this feels like
an app, not DeFi" move); (2) email/push alerts for health factor and payouts
(opt-in — no account required otherwise); (3) a public demo mode (this
prototype, hosted); (4) "you'll receive ~X ZEC" quotes before every
confirmation; (5) publish the audit + a visible per-pool cap ("your position
is ≤2% of pool liquidity") — trust features are conversion features for this
audience.

**Mobile.** The prototype now has a responsive pass: nav collapses, stat
grid stacks, position rows reflow, wizard columns stack, tooltips work on
tap. A native app is not warranted yet; mobile web done well is.

**Docs tab.** Added, structured like the references you liked (sidebar
sections → content): Getting started · Modes · Deposits & funding · Health &
liquidations · Rewards & claiming · Withdrawals · Fees · Privacy · Risks &
venue status · FAQ. The Fees and Risks pages say the quiet parts out loud
(engine fee, our fee, the Rhea exploit and our caps) — see §3 for why.

**Activity tx links.** Every activity row now carries its transaction id
linking to the right explorer for that leg (Zcash explorer / nearblocks /
basescan). Same per-step ids in the deposit progress modal — there is no
single cross-chain explorer, so per-step links per chain is the correct
answer, exactly as you suggested.

---

## 8 · Names

Criteria: short, ownable, gestures at gold/privacy/yield without screaming
"DeFi template," and ideally means something to Zcash insiders. Shortlist
(⚠ = needs a trademark/domain check before committing — I have not verified
availability):

| Name | Why |
|---|---|
| **Canopy** ⚠ | Zcash's 2020 network upgrade was literally named Canopy — insiders get it instantly; to everyone else it reads as shelter/cover over your assets. My favorite. |
| **Zield** ⚠ | ZEC + yield + shield in five letters. Does what it says. |
| **Gilt** ⚠ | Gilded = gold-covered; "gilts" are the safest yield instruments in traditional finance. Premium, quiet. |
| **Auric** ⚠ | "Of gold." Clean, brandable. |
| **Grove** ⚠ | Sapling → Orchard → Grove: extends Zcash's own naming lineage (their shielded protocols) without squatting on their exact names. |
| **Halo** ⚠ | Zcash's proving system is Halo 2 — the deepest insider nod. Likely crowded trademark space. |
| **Zenith** ⚠ | Z + peak. Safe, a bit generic. |
| **Hearth** ⚠ | Warm-gold + "rewards come home." Matches the send-home mechanic. |
| **Warden** ⚠ | Guards your collateral. Darker tone. |
| **Still** ⚠ | Quiet/private + distillation of yield. Very brandable, very abstract. |

My top three: **Canopy**, **Zield**, **Gilt**. Check canopy.finance /
zield.fi / gilt.fi and USPTO class 36/42 before falling in love. "ZYO" stays
a fine internal codename regardless.

---

## 9 · Open verification items (added to the queue)

1. **Engine source license (SPDX)** — decides whether a verbatim fork is even
   legal. Read from Blockscout verified source.
2. **Rhea post-exploit lending parameters** (ZEC max LTV, LT, liquidation
   bonus, close factor) — re-probe before mainnet; our LT=0.70 is
   pre-exploit data.
3. **1-Click `/v0/status` response fields** — confirm it returns per-leg tx
   hashes (needed to make the live progress view real, not simulated).
4. **Expansion-pool engine ids** — next registry enumeration run.
5. **SnuggleFi integrator revenue share** — one email, potentially moves the
   fork break-even by years.
6. **Name availability** — domains + trademark screen for the §8 shortlist.
7. **Templar Protocol due diligence** — as a second/alternative collateral
   venue (native-ZEC custody, no bridge).

---

## 10 · What changed in the prototype (item → status)

| Your feedback | Status |
|---|---|
| ⓘ tooltips show nothing on hover | **Fixed** — custom tooltip system (hover + tap), all ⓘ everywhere |
| Liquidation mechanics unclear | **Answered §4** + soft-ladder now described in Docs; agent thresholds shown in health card |
| Claimable rewards — where do funds go | **Fixed** — claim modal with 3 destinations on every position |
| Competitors | **Answered §3** |
| How does compound now work | **Answered §5** + Compound now button on every position |
| Withdraw / slippage floor / 60s hold / destination | **Answered §5** + withdraw modal destinations with HF preview |
| Adjust parameters not functional | **Fixed** — working modal, edits apply to the position |
| Real token logos | **Fixed** — faithful vector marks embedded (the container can't fetch the official raster assets; the web build swaps in official token-list PNGs, noted in the code) |
| Compound-on-demand + claim-now on every position | **Fixed** |
| Auto-compound trigger | **Answered §5** (economics-gated + free on rebalance) |
| HF must update on withdraw/unwind; block withdraw-all with debt | **Fixed** — live HF engine + hard guard + slider cap |
| Show token amounts, not just USD | **Fixed** — ZEC + per-token composition shown |
| HF should be max with no debt | **Fixed** — ∞ · no debt state |
| Swap ZEC straight into LP | **Fixed** — third mode, with the taxable-event note |
| MAX button — is it connected? | **Answered §1** — can't be, by design; demo-labeled, QR pre-fills amount instead |
| Auto-compound in simple lending | **Answered §5** — interest self-accrues; toggle hidden in Simple mode |
| Claim economics | **Answered §5** |
| Engine fee / build our own | **Answered §2** — phased plan + own fee shipped in UI |
| Pools must include every pair containing the borrowed asset | **Fixed** |
| APR projection source | **Answered §5** + labeled in UI |
| "Borrows $3,500 cbBTC against $10,000 ZEC" phrasing | **Fixed** — exactly that format |
| Engine pool id? More pools | **Answered §5** — ⓘ explainer + 5 named expansion pools |
| Live deposit progress + per-step tx ids | **Fixed** — animated steps, per-step ids + explorer links |
| Raise max LTV to 75% | **Answered §6** — recommend no; kept 50% |
| Auto-populate reward address from wallet | **Answered §1** — impossible cross-chain; "reuse last" helper added instead |
| Less friction / conversion | **Answered §7** + shipped items listed |
| TVL / total value processed metric | **Fixed** in UI (demo-labeled) + plan §7 |
| Mobile | **Fixed** — responsive pass |
| Docs tab | **Fixed** — full in-app docs |
| Better name | **§8 shortlist** |
| Activity tx ids + explorer links | **Fixed** |
