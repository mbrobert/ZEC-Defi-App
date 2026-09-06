*Historical record — describes the pre-pivot NEAR→Base design, superseded by the Base-first pivot of 2026-09-05. Kept because the audit ledgers and research cite it.*

# Yield reality check — measured 2026-08-31

The question this document answers: **after fees and impermanent loss, does any
curated pool return a true positive yield on borrowed USDC?** The answer, at the
rates measured on 2026-08-31, is **no** — and the product now says so instead of
quoting a headline. This page shows the work so the conclusion can be attacked.

## Why the old numbers were wrong

Until 2026-08-31 the demo used each pool's **whole-pool trading-fee APR**
(volume × fee ÷ TVL × 365) as "the honest proxy" for what a staked position
earns, on the assumption that gauge emissions track fees at equilibrium. Two
things were wrong with that:

1. **Staked positions don't earn fees at all** (they earn AERO emissions; fees
   go to veAERO voters) — and measurement shows emissions do NOT track fees.
2. **A whole-pool APR is not what a position of a given width earns.** Emissions
   are split by in-range *liquidity*, and a ±25% position holds ~9× less
   liquidity per dollar than the ~±3% average width of the capital it competes
   with. Width matters enormously, and impermanent loss was never modeled.

The headline "12.9 / 17.2 / 21.5%" figures derived from that proxy are retired.

## What was measured (all on-chain, block 50675328, 2026-08-31T01:34Z)

Per pool, from Base RPC (`base-rpc.publicnode.com`): the Aerodrome Voter's
gauge, the gauge's `rewardRate()` and `periodFinish()`, the pool's `slot0()`,
`liquidity()`, `stakedLiquidity()` and dynamic `fee()`; AERO $0.478 and pool
TVLs from GeckoTerminal. Raw sample: `services/yield/samples/gauge-emissions-2026-08-31.json`.

In-range emissions APR for a position of width ±w:
`APR(w) = rewardRate·yr·AERO$ ÷ (stakedLiquidity·√P·f(w)/10^dec1·token1$)`,
`f(w) = 2 − √(1−w) − 1/√(1+w)` — the marginal rate for new liquidity at that
width, given the staked liquidity it shares emissions with.

| Pool | TVL | whole-pool emissions | ±25% | ±8% | ±1.5% | note |
|---|---|---|---|---|---|---|
| WETH/USDC | $7.9M | 65.0% | 7.7% | 23.5% | 123% | 92% of liquidity staked |
| cbBTC/USDC | $5.6M | 31.7% | 14.3% | 43.5% | 229% | |
| WETH/cbBTC | $19.9M | 19.2% | 2.7% (±12.5%) | 8.3% (±4%) | 44% (±0.75%) | correlated widths |
| WETH/LINK | $0.3M | 31.8% | 17.6% | 53.7% | 282% | fails the $5M depth rule |
| USDT/USDC | $1.1M | 1.9% | — | — | — | stable; tight-range regime |
| cbETH/WETH | $3.1M | 4.1% | — | — | — | stable; tight-range regime |
| AERO/WETH | $1.3M | **0** | 0 | 0 | 0 | **gauge epoch ended 2026-05-28 — no emissions** |
| AERO/cbBTC | $1.2M | 60.0% | 23.4% | 71.2% | 375% | venue-token IL |

Realized volatility (GeckoTerminal OHLCV, daily, Mar→Aug 2026, annualized):
ETH/USD 0.56, BTC/USD 0.39, ETH/BTC 0.26–0.43 (hourly/daily blend). The model
uses ETH 0.55, BTC 0.40, ETH/BTC 0.33.

## The simulation

`services/yield/scripts/lp-sim.py` (Monte Carlo, 3,000 paths × 1 year, hourly
steps, zero-drift GBM at the realized vols): a centered position of the
setting's width, re-centered after being out of range for the setting's full
rebalance delay, paying the pool fee + 5 bps slippage on the swapped half at
each rebalance; emissions accrue at APR(w) only while in range. Output:
`services/yield/samples/lp-model-2026-08-31.json`.

| Pool | Setting (width · delay) | time in range | rebal/yr | IL+rebal drag | emissions gross | net on the borrowed slice* |
|---|---|---|---|---|---|---|
| cbBTC/USDC | Sheltered ±25% · 48h | 98% | 1.7 | −15.5% | 13.2% | **−5.4%** |
| cbBTC/USDC | Steady ±8% · 12h | 96% | 17 | −39.4% | 33.1% | **−14.1%** |
| cbBTC/USDC | Working ±1.5% · 2h | 89% | 392 | −92.5% | 72.8% | **−36.8%** |
| WETH/USDC | Sheltered ±25% · 48h | 97% | 3.1 | −27.1% | 6.5% | **−22.1%** |
| WETH/USDC | Steady ±8% · 12h | 94% | 28 | −60.2% | 14.4% | **−49.1%** |
| WETH/cbBTC | Sheltered ±12.5% · 48h | 96% | 4.4 | −20.0% | 2.3% | **−18.2%** |

\* net = emissions × 0.765 (after the 15% engine + 10% Oilskin fees) + drag.
Against a USDC borrow cost of **13.47%** (Rhea, sampled 2026-08-27), every row
is negative — the best (cbBTC/USDC Sheltered) is −5.4% before even paying the
borrow. Cheaper debt doesn't save it: borrowing cbBTC at 2.76% against the
cbBTC/USDC pool still nets ≈ −8% on the slice. The theory cross-check: the
drag matches the closed-form concentrated-LP volatility cost σ²/(4·f(w))
passed through 100·(1−e^(−x/100)) within ~2 points at every width — this is
the standard "LP is short volatility" result, not an artifact.

**And lending-only earns 0.04%** — the Rhea ZEC supply rate is effectively
zero because almost nobody borrows ZEC.

## What the product does with this

- The simple build models `net = emissions(width) × 0.765 + drag(vol, width)`
  per pool per setting and **only offers a pool when net > the live borrow
  rate**. Today that menu is empty; the page says so in plain words, shows the
  numbers that failed, and offers lending-only (0.04%) rather than a leveraged
  loss. The gate re-evaluates from live data (gauge emissions via
  `services/yield`), so a pool is offered the moment conditions change.
- The advanced build prices any width with the same measured curve
  (`emissions(w) = ek/f(w)`) minus the calibrated drag — including negative
  results, shown unfloored. The AERO/WETH gauge is flagged inactive.
- The tester's kit carries labeled **what-if** switches (AERO ×2/×4, borrow
  8%/4%) so the full deposit flow can be exercised under a hypothetical that
  is visibly tagged as one.

## What would flip the gate

Any of, roughly: AERO ~2.5× (emissions in USD scale linearly); USDC borrow
under ~5% with today's emissions (cbBTC/USDC Sheltered turns positive near
−5.4% → needs borrow < −? no — needs emissions ↑ too; the pair (AERO ×1.6,
borrow 6%) crosses); realized BTC vol under ~30% (drag ∝ σ²); or a venue where
staked positions also earn fees. The gate computes this continuously — no one
has to remember to re-run a spreadsheet.

## Standing caveats (attack here first)

1. `APR(w)` uses a **snapshot** of staked in-range liquidity; the service now
   keeps a rolling average, but a longer time-average could move the emissions
   figures by tens of percent (in either direction — it will not close a 5–20
   point gap against a 13.5% borrow on its own).
2. The drag model is zero-drift GBM at daily-realized vol. Mean reversion at
   intraday scales would reduce the drag for the tightest ranges; it barely
   changes Sheltered. A directional ETH/BTC view changes everything — but then
   it's a trade, not yield.
3. The definitive answer is empirical: the yield service's backfill measures
   what the engine's own closed positions actually kept (IL, rebalances, fees
   and all). Once `npm run backfill -- all` has run, realized bands replace
   this model everywhere in the UI. If real positions systematically beat the
   model, the model loses and the menu reopens — that's the point of building
   the empirical pipeline first.
