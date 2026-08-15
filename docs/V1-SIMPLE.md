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
ZEC (off-thesis). So: collateral on the lending venue, a **fixed 30% LTV**
borrow in USDC, deployed across **two curated blue-chip pools** (WETH/USDC +
cbBTC/USDC), **auto-compounding always on**, rewards and withdrawals always
returning to **one pre-committed Zcash address**.

Why 30% (not the power build's 35% default / 50% cap): liquidation requires a
**57% ZEC drawdown**, wide enough that the agent's protection ladder
(earnings repay the loan first → minimal unwind → full unwind) runs out of
road only in a true collapse. "Protected" has to be nearly unconditionally
true in v1 — the first liquidated user is the last new cohort.

## The five foot-guns v1 removes

1. **LTV slider** → fixed 30%. Nobody self-liquidates.
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

Demo uses ZEC ≈ $487 (Aug 2026 market) and a ~6.9% current net yield —
computed honestly from: pool gross APR × 0.765 fee factor, minus the live
USDC borrow rate, on 30% of stack, plus ZEC supply APY. Yield headline must
always be the computed trailing figure, never a promise.
