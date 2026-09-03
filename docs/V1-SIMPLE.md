# Oilskin v1 — the simple build (pivot decision record, 2026-08-13)

Matt's call: the first live version must be stupid simple — good enough on
first touch that users come back, add more, and tell friends. Power-user
features are preserved for a later release. This file is the spec for what v1
is, what got cut, and why.

## The core (recommendation, adopted)

One sentence: **deposit ZEC, earn real yield, never sell it, get it back
whenever you want — with one wallet, the one you already have.**

Under the hood v1 runs exactly one strategy — the Full-strategy pipeline at
fixed safe parameters — because it's the only mode that delivers the thesis:
Simple-lending alone pays ~2% (not compelling), Direct-LP sells the user's
ZEC (off-thesis). So: collateral on the lending venue, a **bounded 3-stop
LTV setting — 30/40/50%, default 30% ("Sheltered")** — borrowed in USDC,
deployed across **two curated blue-chip pools** (WETH/USDC + cbBTC/USDC),
**auto-compounding always on**, rewards and withdrawals always returning to
**one pre-committed Zcash address**.

> **Amended 2026-08-15 (Matt's call):** fixed 30% → user-selectable
> 30/40/50. One honest dial users can handle; the unbounded slider stays
> cut. Drawdown-to-liquidation is stated at the moment of choice
> (57% / 43% / 29% at LT 0.70) and the docs say plainly that ~30% ZEC
> drawdowns happen in ordinary years — "Working hard" leans hardest on the
> protection ladder. Default remains Sheltered; setting locks at deposit.

Why 30% (not the power build's 35% default / 50% cap): liquidation requires a
**57% ZEC drawdown**, wide enough that the agent's protection ladder
(earnings repay the loan first → minimal unwind → full unwind) runs out of
road only in a true collapse. "Protected" has to be nearly unconditionally
true in v1 — the first liquidated user is the last new cohort.

## The five foot-guns v1 removes

1. **LTV slider** → a bounded 3-stop risk setting (30/40/50, default 30)
   with the required drawdown shown at the moment of choice. Nobody
   self-liquidates by typo; choosing thinner buffer is explicit and named.
2. **Pool choice** → curated allocation, shown transparently ("how your ZEC
   is earning"), never chosen. Nobody picks a degen pool.
3. **Reward-address entry & destination options** → one address, asked once,
   validated hard, locked at deposit. Nobody pastes an unsettleable address
   mid-flow; nobody routes funds to an exchange.
4. **Range/rebalance parameters** → engine presets, invisible. Nobody sets a
   0.5% range and churns themselves to death.
5. **Wallet connections** → none. QR/copy deposit from any Zcash wallet;
   passkey identity (production); withdrawals only to the locked address.
   Nobody signs a malicious transaction because there is nothing to sign.

## Guardrails that ship in v1

- Per-account cap (50 ZEC at launch) + protocol-wide cap, raised as the
  system proves out publicly. Minimum 0.25 ZEC.
- One position per account; new deposits top it up.
- Pre-committed payout address: withdrawals and earnings can only ever exit
  to the address locked at deposit — under any compromise, funds can't be
  redirected.
- Protection ladder always on (rewards-repay → partial unwind → full unwind),
  every action logged in Activity with its tx id.
- Withdrawals never pausable (contract invariant, unchanged).
- Fees only ever on earnings (10% Oilskin + 15% engine), one plain sentence,
  shown before deposit.
- Honest custody line in the deposit flow itself: who holds the ZEC during
  the ~2-minute bridge, and that failed transfers auto-refund.

## What's deferred to the power release (preserved, not deleted)

Adjustable LTV to 50% · pool picker + membership filter · Direct-LP mode ·
per-position range/rebalance/auto-compound controls · claim destinations
(Rhea repay / Base wallet) · compound-now button · EVM wallet binding for
direct on-chain withdrawal rights · multi-position accounts · the full
health-factor dashboard. All of it lives in `prototype/index.html` and the
`power-user` branch; the v1 surface is `prototype/simple.html`.

## Honesty rules carried over unchanged

Shielded funding is the default guidance; fresh deposit address per deposit;
the strategy legs are public and we say so; APY shown is net-of-everything
and labeled live-not-promised; per-step tx ids on every flow.

## Numbers note

Demo uses ZEC ≈ $487 (Aug 2026 market). Yield is computed honestly per
position: apy = ZEC supply (~0.8%) + LTV × (pool-mix gross fee APR × 0.765
fee factor − 13.2% USDC borrow rate). Pool fee APRs are sampled from live
volume/TVL and labeled with their sample date. Yield headline must always
be the computed trailing figure, never a promise.

> **Amended 2026-08-27 (Matt's call): curated pool menu.** "More blue-chip
> and stable pool choices, higher-yield options." v1 now offers an 8-pool
> curated menu (4 blue-chip incl. correlated WETH/cbBTC, 2 stable/LST,
> 2 volatile incl. AERO/cbBTC) — engine-approved venues only, equal-split allocation, mix
> locked at deposit like the LTV setting. Guardrails kept: minimum one
> pool; a mix earning less than the borrow cost warns "loses money at
> these rates"; volatile pools carry an explicit impermanent-loss warning
> and tight per-pool caps. At rates sampled 2026-08-27 the default
> blue-chip mix computes 13.2 / 17.4 / 21.5% at 30/40/50% LTV — the old
> 6.9% headline came from a stale calm-week sample, not a different
> strategy.

> **Amended 2026-08-27, second pass (Matt's review feedback): one pool, no
> cap, Aerodrome-only.** (1) **Single pool** — "Simple just uses one pool at
> a time, not mixing." The 8-pool menu stays but becomes single-select;
> multi-pool mixes move to Advanced. (2) **No Oilskin deposit cap** — "allow
> uncapped application deposits"; only external constraints (chiefly USDC
> liquidity on Rhea) bound size, and the 0.25 floor stays. The per-account
> 50 ZEC cap above is retired. (3) **Aerodrome × Snuggle only** — every menu
> pool is an Aerodrome pool the Snuggle engine supports; positions are
> staked in the pool's gauge and earn AERO incentives in lieu of trading
> fees (pool research: docs/POOLS.md). Aerodrome fees are dynamic — menus
> show each pool's on-chain fee() at sampling. (4) Both prototypes carry a
> footer risk disclaimer, a clickable BUILT-ON rail (Rhea, NEAR Intents,
> Base, Aerodrome, SnuggleFi), and the sequential fee math stated exactly
> (15% engine, then 10% Oilskin = 23.5% all-in on earnings). At rates
> sampled 2026-08-27 the default pool (WETH/USDC, 73.6% gross) computes
> 12.9 / 17.2 / 21.5% at 30/40/50% LTV.

> **Amended 2026-08-27 (Matt's call): empirical bands + live backend.**
> "Run with empirical. Start making all the backend now." `services/yield`
> ships: live pool/rate sampling plus realized-return bands backtested from
> the engine's own on-chain position history (closed-position USD flows,
> principal-weighted p25–p75 — docs/YIELD-SERVICE.md). The demo probes the
> service at boot: connected → live rates + banded headline + per-card band
> bars; not running → the static dated sample stands. Bands render only
> from real backfilled history — "pending backfill" is shown rather than
> any invented range.

> **Amended 2026-09-02 (measured yield + the five fixes).** (1) **The menu is
> now gated by measurement, not curation.** Every pool models
> `net = emissions(width) × 0.765 + IL drag(vol, width)` from the 2026-08-31
> on-chain gauge sample and the realized-vol Monte Carlo
> (docs/YIELD-REALITY-2026-08-31.md); a pool is offered at a setting only when
> net beats the live borrow rate. At sampled rates **nothing qualifies** — the
> page says so, shows the failing numbers on each greyed card, and offers
> lending-only (Rhea ZEC supply, 0.04%) instead of a leveraged loss. Empirical
> bands (backfill) override the model when present; the tester's kit carries
> labeled what-if switches so the full flow stays exercisable. (2) **Risk
> setting now also sets the engine preset**: Sheltered = Conservative ±25%
> (±12.5% correlated) / 48h; Steady = Moderate ±8% (±4%) / 12h; Working hard
> = Aggressive ±1.5% (±0.75%) / 2h — every pool card shows its width,
> rebalance delay, modeled time-in-range and rebalances/yr for the selected
> setting. (3) **Dashboard** adopts the advanced bones: four stat tiles,
> loan-health band, expandable position card (emissions → engine fee →
> Oilskin fee → net; range bar; backed-by; idle refunds), activity rail with
> per-chain tx links. (4) **Identity without login**: the locked payout
> address keys the position; localStorage keeps a local copy
> ("forget this device" clears it); **Find your position** restores by
> address from any browser — read-only-safe because funds can only exit to
> that address. Production: a passkey bound at deposit (OS-synced) gates
> state-changing actions, fallback = a dust-sized proof transaction from the
> locked address. (5) **Emissions-only language**: staked positions earn AERO
> emissions in lieu of trading fees, so the simple build no longer mentions
> fee rates at all — every yield word is emissions, IL, or the borrow cost.
> Engine refunds (single-sided deposits return sub-1% leftovers in the same
> tx) are booked idle to the position and redeployed at the next compound —
> surfaced in the FAQ and Activity.
