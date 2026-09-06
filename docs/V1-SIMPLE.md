> **History.** Decision record for the pre-pivot "simple build" (ZEC deposit to a bridge address, Rhea collateral, one pre-committed Zcash payout address). That product no longer exists (`BASE-PIVOT-2026-09.md`). Decisions that survived into the Base-first v1: the Simple ⇄ Advanced split, the bounded 30 / 40 / top setting (now derived per asset from the live liquidation threshold), one pool at a time in Simple, Aerodrome × Snuggle only, the computed (never curated) gate, and empirical bands from the engine's own history. The numbers in this file are the dated samples of their day, not today's.

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
