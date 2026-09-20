# The Solana-side reserve against ZEC's own price history — a model, not a decision (2026-09-19)

Abbreviations: HF = health factor; LTV = loan-to-value; LT = liquidation threshold; CCTP = Circle's
Cross-Chain Transfer Protocol; APR = annual percentage rate; OHLC = open / high / low / close candles.

**Status.** A model with every input stated (CLAUDE.md rule 4). It answers the open question in
`ROADMAP.md` §1 item 4 and `CROSSCHAIN-RUNBOOK-2026-09-13.md` §5 — *has the reserve been sized against a
real ZEC drawdown?* — with numbers, and leaves the decision where it belongs. **Nothing in code changes
because of this document.** The rule the program enforces (`deposit_for_burn` refuses a burn that would leave
the Account under R) is exactly what it was.

## 1 · The question

The cross-chain loop (D6) borrows USDC on Kamino against bridged ZEC and may send it to the user's own
Base account to be deployed. A repay on Solana would then be five signed steps across two chains with Circle
in the middle (`CROSSCHAIN-LOOP-2026-09-12.md` §3). So the Account keeps a **reserve** on Solana, never
bridged: the USDC that lifts HF from the repay rung to its disarm level with no collateral change —

```
R = D × (disarm₂ − rung₂) / disarm₂        4.11 % of the debt at entry HF 1.625 (1.40 → 1.46)
```

(`SOLANA-ARCHITECTURE.md` §14.3; shared `reserveFractionFor`; the program's `reserve_units_for`). It makes
**one** rung-2 repay atomic on Solana. Once spent it is not refilled automatically: the next USDC either
crosses from Base (the five steps) or, at rung 3, **the keeper sells the user's ZEC** — the outcome a loan
exists to avoid. So the reserve is a bet about how fast ZEC falls relative to how fast USDC can come back,
and the design said in so many words that the number had not been checked against a real drawdown.

Three things to measure, then, on ZEC's own candles:

1. **On the bridge's timescale** (seconds to minutes if Fast, minutes if Standard): how often does ZEC fall
   the whole distance from rung 2's disarm level to rung 3 — **15.8 %** — before a top-up could land?
2. **Over the weeks a position is open**: how often is the ladder's cushion spent at all, and how often does
   the keeper end up selling ZEC — with today's reserve, and with two, three, five times it?
3. **What each multiple costs**: the reserve is borrowed USDC that earns nothing while it waits.

## 2 · Inputs, every one dated

| Input | Value | Source |
|---|---|---|
| ZEC/USD candles | Kraken public OHLC, four intervals: 15 min (7.5 days), 1 h (30 days), 4 h (120 days), 1 day (2 years); 720 closed candles each | `services/yield/samples/zec-usd-kraken-2026-09-19.json`, fetched 2026-09-19T02:06Z; the open candle dropped |
| The regime those candles cover | $29.12 on 2024-09-29 → $1,562.79 on 2026-09-18 (the daily series); ×2.79 inside the 30-day hourly series | the sample |
| Entry HF | **1.625** — Kamino's ZEC LTV cap 40 % against its LT 65 % | `VERIFIED-SOLANA-FACTS.md`, the ZEC reserve rows (`loanToValuePct` 40, `liquidationThresholdPct` 65) |
| The ladder | `ladderFor(1.625)` = warn 1.57 · repay 1.40 · de-risk 1.23 · emergency 1.06, hysteresis 0.06; acting rungs capped at the 2.00 ladder above it (D10) | `packages/shared/src/health.ts` |
| The reserve rule | R = 4.11 % of the debt at 1.625 | `reserveFractionFor`; `SOLANA-ARCHITECTURE.md` §14.3 |
| Keeper cadence | one health poll every 30 s | `agent/src/solana/config.ts` `healthPollMs` |
| Carry on idle USDC | Kamino ZCASH-market USDC borrow APR **3.378 %** at the recorded read | `VERIFIED-SOLANA-FACTS.md` |
| Bridge time | Fast: "~8 s" advertised, **not measured**; Standard: waits for Base finality, minutes | `CROSSCHAIN-LOOP-2026-09-12.md` §1; `CROSSCHAIN-RUNBOOK-2026-09-13.md` §5 |

## 3 · Method

Three views of the same series, from the least to the most assumed; the code is `services/yield/src/reserveSizing.ts`,
the run is `services/yield/scripts/reserve-sizing.mjs`, and `services/yield/test/reserve-sizing.test.ts` pins both
the arithmetic and the headline numbers below to the committed sample.

- **Windows.** For every start bar, the drop from that close to the lowest low inside the next N bars — close to
  low, because the liquidation engine and the keeper see the wick. Reported: the worst, the 99th and 95th
  percentiles, and how many windows held a drop of at least the rung-2→3 gap. Overlapping windows, so one crash is
  counted in every window that contains it: a description of the record, not a probability.
- **Replay.** The ladder run over the history exactly as it happened, a position opened at every bar and held for
  the window, nothing resampled and the drift left in. Same overlap caveat.
- **Monte Carlo.** Each series' close-to-close log returns **with the mean removed** (a month in which ZEC nearly
  tripled would otherwise carry the rally as drift and show almost no drawdowns; `scripts/lp-sim.py` is zero-drift
  for the same reason), block-bootstrapped (6-hour, 24-hour and 5-day blocks), 10,000 paths per cell, the ladder
  run once per bar.

The ladder walk, in every view: HF = C · p · LT / D with the price 1 and the debt LT ÷ 1.625 at entry; debt is
constant apart from repayments (a month of interest is two orders of magnitude under the moves here). Each bar
the keeper acts on the worst rung crossed — **emergency** unwinds everything; **de-risk** sells exactly the ZEC
that lifts HF to its disarm level, x = (target·D − C·p·LT) ÷ (p·(target − LT)); **repay** spends idle USDC up to
what lifts HF to *its* disarm level and, if short, requests one R from Base that lands after the stated delay
(one in flight at a time). A rung that fires stays fired until HF regains its disarm level — the hysteresis the
keeper runs, and the reason a rung fires **once per episode**. HF under 1 counts as liquidation and ends the path.

**What a bar cannot see.** Coarser bars make the keeper look slower than it is: it polls every 30 s, so on a daily
bar it would have acted at rung 2 long before the close, and the daily and 4-hour regimes overstate what falls
straight through the ladder. Close-to-close ignores the wick, so every regime understates the intra-bar low. The
two errors pull opposite ways and neither is small; the hourly regime is the least wrong and covers only the last
30 days.

## 4 · Results — generated

_Generated by `node services/yield/scripts/reserve-sizing.mjs` from `samples/zec-usd-kraken-2026-09-19.json` (fetched 2026-09-19T02:06:39.674Z), 10,000 paths per cell._

**The series.** Kraken ZEC/USD, the open candle dropped:

| Interval | Candles | From | To | Last close | Realized vol per bar | Annualized |
|---|---|---|---|---|---|---|
| 15 min | 720 | 2026-09-11T14:00:00Z | 2026-09-19T01:45:00Z | $1,554.49 | 0.68 % | **128 %** |
| 60 min | 720 | 2026-08-20T02:00:00Z | 2026-09-19T01:00:00Z | $1,554.49 | 1.39 % | **130 %** |
| 240 min | 720 | 2026-05-22T00:00:00Z | 2026-09-18T20:00:00Z | $1,562.79 | 2.73 % | **128 %** |
| 1440 min | 720 | 2024-09-29T00:00:00Z | 2026-09-18T00:00:00Z | $1,562.79 | 6.91 % | **132 %** |

**The ladder at entry HF 1.625** (`ladderFor`, Kamino's 40 % cap against LT 65 %): Warning 1.57 (re-arms 1.63) · Repay 1.4 (re-arms 1.46) · De-risk 1.23 (re-arms 1.29) · Emergency 1.06 (re-arms 1.12). The reserve is **4.11 % of the debt** — one rung-2 repay, 1.4 → 1.46.

| Price move needed | Warn | Repay | De-risk | Emergency | Liquidation (HF 1) |
|---|---|---|---|---|---|
| from entry | −3.4 % | −13.8 % | −24.3 % | −34.8 % | −38.5 % |
| from rung 2's disarm level (the reserve just spent) | — | — | −15.8 % | −27.4 % | −31.5 % |

**How far ZEC has actually fallen inside a window** — close to the lowest low within the next N bars, every start bar in the series. The column that matters is the last: how often the window held a drop of at least **15.8 %**, which takes a position from rung 2's disarm level straight to rung 3 (ZEC sold).

| Window | Bars | Windows | Worst | p99 | p95 | ≥ rung-2→3 gap |
|---|---|---|---|---|---|---|
| 15 min | 1 × 15 min | 719 | **−5.1 %** | −2.2 % | −1.4 % | never |
| 1 h (15-min bars) | 4 × 15 min | 716 | **−6.2 %** | −4.3 % | −2.7 % | never |
| 1 h | 1 × 60 min | 719 | **−17.1 %** | −4.5 % | −2.8 % | 0.14 % of windows |
| 4 h | 4 × 60 min | 716 | **−18.6 %** | −6.5 % | −5.0 % | 0.42 % of windows |
| 24 h | 24 × 60 min | 696 | **−18.6 %** | −14.7 % | −10.4 % | 0.43 % of windows |
| 24 h (4-h bars) | 6 × 240 min | 714 | **−56.0 %** | −27.6 % | −9.7 % | 1.40 % of windows |
| 3 d | 18 × 240 min | 702 | **−59.8 %** | −58.1 % | −15.9 % | 5.13 % of windows |
| 7 d | 42 × 240 min | 678 | **−59.8 %** | −58.1 % | −52.7 % | 16.52 % of windows |
| 1 d | 1 × 1440 min | 719 | **−45.4 %** | −20.8 % | −12.3 % | 2.36 % of windows |
| 3 d (daily) | 3 × 1440 min | 717 | **−59.8 %** | −32.6 % | −21.7 % | 10.74 % of windows |
| 7 d (daily) | 7 × 1440 min | 713 | **−59.8 %** | −45.1 % | −31.3 % | 24.40 % of windows |
| 14 d | 14 × 1440 min | 706 | **−62.2 %** | −55.8 % | −43.1 % | 36.54 % of windows |
| 30 d | 30 × 1440 min | 690 | **−62.8 %** | −59.7 % | −54.2 % | 48.12 % of windows |

**Monte Carlo.** Each regime block-bootstraps its own series' close-to-close log returns **with the mean removed** (a month in which ZEC rallied would otherwise carry the rally as drift; `scripts/lp-sim.py` is zero-drift for the same reason), every path starting at entry HF 1.625 with the ladder run once per bar. Coarser bars make the keeper look slower than it is — it polls every 30 s, so on a daily bar it would have acted at rung 2 long before the bar's close — and close-to-close ignores the wick, so the daily regime overstates what falls through the ladder and every regime understates the intra-bar low; the two errors pull opposite ways and neither is small. The bridge cases: the top-up lands after one bar (Fast or Standard — no series here resolves the difference), after a day (an outage), never (the loop unbuilt, or Circle down).

| hourly bars, last 30 days, 7 d · reserve = k × R | k | rung 2 reached | ZEC sold (rung 3 or 4) | liquidated | bridge needed | repays / path | idle USDC, % of debt | carry, % of debt / yr |
|---|---|---|---|---|---|---|---|---|
| lands in 1 h | 1 | 38.5 % | **3.88 %** | 0.00 % | 38.5 % | 0.68 | 4.1 % | 0.14 % |
| lands in 1 h | 2 | 38.2 % | **2.90 %** | 0.00 % | 19.8 % | 0.69 | 8.2 % | 0.28 % |
| lands in 1 h | 3 | 39.1 % | **2.77 %** | 0.00 % | 9.0 % | 0.73 | 12.3 % | 0.42 % |
| lands in 1 h | 5 | 38.5 % | **2.02 %** | 0.00 % | 1.1 % | 0.73 | 20.5 % | 0.69 % |
| lands in 24 h | 1 | 38.6 % | **4.97 %** | 0.00 % | 38.6 % | 0.54 | 4.1 % | 0.14 % |
| lands in 24 h | 2 | 38.2 % | **3.31 %** | 0.00 % | 19.8 % | 0.64 | 8.2 % | 0.28 % |
| lands in 24 h | 3 | 39.1 % | **2.92 %** | 0.00 % | 9.0 % | 0.71 | 12.3 % | 0.42 % |
| lands in 24 h | 5 | 38.5 % | **2.03 %** | 0.00 % | 1.1 % | 0.73 | 20.5 % | 0.69 % |
| never lands | 1 | 38.7 % | **6.22 %** | 0.00 % | 38.7 % | 0.39 | 4.1 % | 0.14 % |
| never lands | 2 | 38.2 % | **3.62 %** | 0.00 % | 19.8 % | 0.59 | 8.2 % | 0.28 % |
| never lands | 3 | 39.1 % | **3.07 %** | 0.00 % | 9.0 % | 0.70 | 12.3 % | 0.42 % |
| never lands | 5 | 38.5 % | **2.03 %** | 0.00 % | 1.1 % | 0.73 | 20.5 % | 0.69 % |

| hourly bars, last 30 days, 30 d · reserve = k × R | k | rung 2 reached | ZEC sold (rung 3 or 4) | liquidated | bridge needed | repays / path | idle USDC, % of debt | carry, % of debt / yr |
|---|---|---|---|---|---|---|---|---|
| lands in 1 h | 1 | 68.7 % | **22.72 %** | 0.00 % | 68.7 % | 2.62 | 4.1 % | 0.14 % |
| lands in 1 h | 2 | 68.0 % | **21.09 %** | 0.00 % | 54.8 % | 2.59 | 8.2 % | 0.28 % |
| lands in 1 h | 3 | 68.0 % | **19.87 %** | 0.00 % | 43.6 % | 2.67 | 12.3 % | 0.42 % |
| lands in 1 h | 5 | 67.9 % | **17.34 %** | 0.00 % | 23.4 % | 2.70 | 20.5 % | 0.69 % |
| lands in 24 h | 1 | 68.8 % | **28.56 %** | 0.00 % | 68.8 % | 2.06 | 4.1 % | 0.14 % |
| lands in 24 h | 2 | 68.2 % | **25.36 %** | 0.00 % | 55.3 % | 2.22 | 8.2 % | 0.28 % |
| lands in 24 h | 3 | 67.8 % | **22.91 %** | 0.00 % | 43.1 % | 2.37 | 12.3 % | 0.42 % |
| lands in 24 h | 5 | 68.1 % | **18.72 %** | 0.00 % | 23.8 % | 2.59 | 20.5 % | 0.69 % |
| never lands | 1 | 68.3 % | **39.10 %** | 0.00 % | 68.3 % | 0.68 | 4.1 % | 0.14 % |
| never lands | 2 | 67.7 % | **32.69 %** | 0.00 % | 55.0 % | 1.25 | 8.2 % | 0.28 % |
| never lands | 3 | 67.7 % | **27.93 %** | 0.00 % | 43.0 % | 1.69 | 12.3 % | 0.42 % |
| never lands | 5 | 68.2 % | **21.23 %** | 0.00 % | 24.1 % | 2.31 | 20.5 % | 0.69 % |

| 4-hour bars, last 120 days, 7 d · reserve = k × R | k | rung 2 reached | ZEC sold (rung 3 or 4) | liquidated | bridge needed | repays / path | idle USDC, % of debt | carry, % of debt / yr |
|---|---|---|---|---|---|---|---|---|
| lands in 4 h | 1 | 28.1 % | **5.82 %** | 2.67 % | 28.1 % | 0.36 | 4.1 % | 0.14 % |
| lands in 4 h | 2 | 27.1 % | **4.85 %** | 2.23 % | 10.3 % | 0.35 | 8.2 % | 0.28 % |
| lands in 4 h | 3 | 28.4 % | **4.70 %** | 2.20 % | 4.0 % | 0.37 | 12.3 % | 0.42 % |
| lands in 4 h | 5 | 27.9 % | **4.06 %** | 2.30 % | 0.4 % | 0.37 | 20.5 % | 0.69 % |
| lands in 24 h | 1 | 28.1 % | **6.10 %** | 2.69 % | 28.1 % | 0.33 | 4.1 % | 0.14 % |
| lands in 24 h | 2 | 27.1 % | **4.85 %** | 2.23 % | 10.3 % | 0.35 | 8.2 % | 0.28 % |
| lands in 24 h | 3 | 28.4 % | **4.71 %** | 2.20 % | 4.0 % | 0.37 | 12.3 % | 0.42 % |
| lands in 24 h | 5 | 27.9 % | **4.06 %** | 2.30 % | 0.4 % | 0.37 | 20.5 % | 0.69 % |
| never lands | 1 | 28.1 % | **6.30 %** | 2.75 % | 28.1 % | 0.28 | 4.1 % | 0.14 % |
| never lands | 2 | 27.1 % | **4.88 %** | 2.23 % | 10.3 % | 0.34 | 8.2 % | 0.28 % |
| never lands | 3 | 28.4 % | **4.71 %** | 2.20 % | 4.0 % | 0.36 | 12.3 % | 0.42 % |
| never lands | 5 | 27.9 % | **4.06 %** | 2.30 % | 0.4 % | 0.37 | 20.5 % | 0.69 % |

| 4-hour bars, last 120 days, 30 d · reserve = k × R | k | rung 2 reached | ZEC sold (rung 3 or 4) | liquidated | bridge needed | repays / path | idle USDC, % of debt | carry, % of debt / yr |
|---|---|---|---|---|---|---|---|---|
| lands in 4 h | 1 | 61.7 % | **28.44 %** | 8.15 % | 61.7 % | 1.35 | 4.1 % | 0.14 % |
| lands in 4 h | 2 | 60.6 % | **26.61 %** | 7.99 % | 42.9 % | 1.34 | 8.2 % | 0.28 % |
| lands in 4 h | 3 | 61.9 % | **24.85 %** | 8.17 % | 29.1 % | 1.39 | 12.3 % | 0.42 % |
| lands in 4 h | 5 | 61.6 % | **21.37 %** | 7.58 % | 10.2 % | 1.42 | 20.5 % | 0.69 % |
| lands in 24 h | 1 | 61.6 % | **29.31 %** | 8.19 % | 61.6 % | 1.26 | 4.1 % | 0.14 % |
| lands in 24 h | 2 | 60.7 % | **26.89 %** | 8.07 % | 42.9 % | 1.29 | 8.2 % | 0.28 % |
| lands in 24 h | 3 | 61.8 % | **24.98 %** | 8.26 % | 29.0 % | 1.36 | 12.3 % | 0.42 % |
| lands in 24 h | 5 | 61.6 % | **21.44 %** | 7.58 % | 10.2 % | 1.42 | 20.5 % | 0.69 % |
| never lands | 1 | 61.6 % | **33.79 %** | 9.20 % | 61.6 % | 0.62 | 4.1 % | 0.14 % |
| never lands | 2 | 60.7 % | **29.49 %** | 8.44 % | 43.0 % | 0.93 | 8.2 % | 0.28 % |
| never lands | 3 | 61.7 % | **26.33 %** | 8.37 % | 29.1 % | 1.16 | 12.3 % | 0.42 % |
| never lands | 5 | 61.5 % | **21.75 %** | 7.62 % | 10.3 % | 1.36 | 20.5 % | 0.69 % |

| daily bars, last 2 years, 7 d · reserve = k × R | k | rung 2 reached | ZEC sold (rung 3 or 4) | liquidated | bridge needed | repays / path | idle USDC, % of debt | carry, % of debt / yr |
|---|---|---|---|---|---|---|---|---|
| lands in 1 d | 1 | 27.3 % | **5.30 %** | 0.03 % | 27.3 % | 0.29 | 4.1 % | 0.14 % |
| lands in 1 d | 2 | 27.8 % | **4.05 %** | 0.02 % | 12.3 % | 0.30 | 8.2 % | 0.28 % |
| lands in 1 d | 3 | 26.1 % | **3.22 %** | 0.02 % | 3.4 % | 0.29 | 12.3 % | 0.42 % |
| lands in 1 d | 5 | 27.3 % | **3.35 %** | 0.00 % | 0.1 % | 0.30 | 20.5 % | 0.69 % |
| never lands | 1 | 27.3 % | **5.33 %** | 0.03 % | 27.3 % | 0.27 | 4.1 % | 0.14 % |
| never lands | 2 | 27.8 % | **4.07 %** | 0.02 % | 12.3 % | 0.30 | 8.2 % | 0.28 % |
| never lands | 3 | 26.1 % | **3.23 %** | 0.02 % | 3.4 % | 0.29 | 12.3 % | 0.42 % |
| never lands | 5 | 27.3 % | **3.35 %** | 0.00 % | 0.1 % | 0.30 | 20.5 % | 0.69 % |

| daily bars, last 2 years, 30 d · reserve = k × R | k | rung 2 reached | ZEC sold (rung 3 or 4) | liquidated | bridge needed | repays / path | idle USDC, % of debt | carry, % of debt / yr |
|---|---|---|---|---|---|---|---|---|
| lands in 1 d | 1 | 62.0 % | **32.72 %** | 1.50 % | 62.0 % | 1.00 | 4.1 % | 0.14 % |
| lands in 1 d | 2 | 63.0 % | **29.80 %** | 1.33 % | 43.2 % | 1.05 | 8.2 % | 0.28 % |
| lands in 1 d | 3 | 61.8 % | **25.79 %** | 1.40 % | 26.7 % | 1.06 | 12.3 % | 0.42 % |
| lands in 1 d | 5 | 62.1 % | **24.30 %** | 1.01 % | 7.6 % | 1.08 | 20.5 % | 0.69 % |
| never lands | 1 | 62.0 % | **35.49 %** | 1.86 % | 62.0 % | 0.62 | 4.1 % | 0.14 % |
| never lands | 2 | 63.0 % | **30.94 %** | 1.50 % | 43.3 % | 0.84 | 8.2 % | 0.28 % |
| never lands | 3 | 61.8 % | **26.70 %** | 1.47 % | 26.6 % | 0.95 | 12.3 % | 0.42 % |
| never lands | 5 | 62.0 % | **24.41 %** | 1.00 % | 7.6 % | 1.06 | 20.5 % | 0.69 % |

**Replay — the ladder run over the history exactly as it happened**, one window per start bar, nothing resampled and the drift left in. A position opened at every bar of the series and held for the window; the share of those windows on which the ladder sold ZEC. Overlapping windows, so one crash counts in every window that contains it — a description of the record, not an estimate.

| Series | Window | Windows | k = 1: rung 2 reached | k = 1: ZEC sold | k = 3: ZEC sold | k = 5: ZEC sold | liquidated (k = 1) |
|---|---|---|---|---|---|---|---|
| 60 min bars | 7 d | 552 | 4.0 % | **0.00 %** | 0.00 % | 0.00 % | 0.00 % |
| 240 min bars | 30 d | 540 | 35.6 % | **11.30 %** | 7.41 % | 3.52 % | 14.81 % |
| 1440 min bars | 30 d | 690 | 46.2 % | **22.61 %** | 18.26 % | 17.68 % | 2.17 % |
| 1440 min bars | 90 d | 630 | 58.3 % | **36.67 %** | 32.86 % | 32.38 % | 10.63 % |

**Sensitivity — the entry HF against the reserve.** The same 30-day, hourly-regime, nothing-lands cell at other entries (LT 65 %, so the loan-to-value each entry means is 0.65 ÷ HF); above 2.00 the acting rungs are the 2.00 ladder's (D10).

| Entry HF (LTV) | k = 1: ZEC sold | k = 3: ZEC sold | k = 5: ZEC sold | rung 2 reached | idle USDC at k = 1 |
|---|---|---|---|---|---|
| 1.625 (40.0 %) | **39.10 %** | 27.93 % | 21.23 % | 68.3 % | 4.11 % of debt |
| 1.8 (36.1 %) | **31.51 %** | 20.76 % | 15.12 % | 63.9 % | 4.43 % of debt |
| 2 (32.5 %) | **24.10 %** | 14.57 % | 9.78 % | 59.3 % | 5.20 % of debt |
| 2.2 (29.5 %) | **14.89 %** | 8.78 % | 5.78 % | 42.8 % | 5.20 % of debt |

Carry is the idle USDC × Kamino's USDC borrow APR (3.378 % at the recorded read): the reserve is borrowed money that earns nothing while it waits (§14.3).

## 5 · What the numbers say

1. **On the bridge's own timescale the reserve is not the binding constraint.** In 7.5 days of 15-minute candles
   no window fell 15.8 %; the worst was −5.1 %. In 30 days of hourly candles one hour did — −17.1 % on
   2026-08-22 between 04:00 and 05:00 UTC ($820 → $680), 0.14 % of the hourly windows — and 0.43 % of 24-hour
   windows. Whether a top-up lands in eight seconds or in fifteen minutes barely moves the ladder's outcome;
   the Fast-versus-Standard question in the runbook is about cost and stalls, not about this number.

2. **Over the weeks a position is open, the ladder's whole cushion is spent routinely.** At ZEC's realized
   volatility — 128–132 % annualized on every interval — rung 2 (−13.8 % from entry) is reached on roughly a
   quarter to two fifths of 7-day paths and about two thirds of 30-day paths in every regime, and in the replay of
   the two-year daily record on 46 % of 30-day windows and 58 % of 90-day ones. Almost half of all 30-day windows
   in the two-year record held a drop of at least the rung-2→3 gap.

3. **The multiple buys little.** Five times today's reserve — 20.5 % of the borrowed USDC held idle instead of
   4.1 % — cuts the share of 30-day paths on which ZEC is sold from **39 % to 21 %** when nothing comes back from
   Base, and from **23 % to 17 %** when the top-up lands within the hour (hourly regime); from 33 % to 24 % in the
   daily regime; in the replay of the last 30 days of 4-hour candles, from 11 % to 4 %. Two reasons, both
   structural: a rung fires once per episode, so idle USDC beyond one requirement only matters across a bounce and
   a second fall; and a 4 % lift in HF is small against an asset that moves 7 % on a typical day.

4. **Today's reserve is short by the tick's overshoot on nearly every rung-2 event.** R lifts 1.40 → 1.46
   exactly; the keeper's tick finds HF a little under 1.40, the requirement at that HF is a little over R, and a
   top-up is requested for the few basis points of difference — in the model, "bridge needed" equals "rung 2
   reached" at k = 1. An engineering observation rather than a sizing one: a top-up threshold in the keeper, or a
   reserve of 1.25 R, would stop the loop crossing a chain for pennies. Recorded in `BACKLOG.md`.

5. **The lever is the entry, not the reserve.** Holding the reserve at one requirement and opening at HF 2.2
   (an LTV of 29.5 % instead of Kamino's 40 % cap) cuts the 30-day ZEC-sold share from 39 % to 15 % — more than
   five reserves do at the cap. `CROSSCHAIN-LOOP-2026-09-12.md` §3 item 3 proposed exactly this for a cross-chain
   class ("could stop at 30 %"); D7 then made the entry the user's choice on a continuous slider, so the product
   question is what the cross-chain wizard **marks and says**, not a new rule.

6. **The liquidations in the coarse regimes are the June crash seen through a wide bar.** ZEC fell 45 % on
   2026-06-04 ($459 → $250) and 60 % over the three days to 06-05; on 4-hour bars a fifth of that day lands in one
   bar and the model liquidates 9–15 % of windows, on daily bars 2 %, on hourly bars none. A keeper that ticks every
   30 s would act at rungs 2, 3 and 4 on the way down — *if* it can: Solana priority fees, Kamino's 180-second
   oracle-staleness gate and the sequencer are the §3 concerns, and a day like that is when they bind. The model
   cannot price them; the devnet ↔ Sepolia run and a real crash are the only evidence there will be.

## 6 · What this does not say

- Nothing finer than 15 minutes, and only 7.5 days of it; 30 days of hourly history, inside a ×2.79 rally.
- The bridge time is not measured (runbook §5); "lands in one bar" stands in for both Fast and Standard.
- Interest, Kamino's 20 % close factor per liquidation, Solana fees, the oracle gate, and the Base-side LP's own
  value are all outside the model. The reserve is a Solana-side question; the user's Base position is not in it.
- A block bootstrap of de-meaned returns is a choice: it keeps the last month's clustering and removes its
  drift. The replay rows carry neither assumption and agree in direction.
- Rule 4: a model, not advice. The multiple, the entry mark for cross-chain positions and the top-up threshold
  are the founder's calls.

## 7 · For the founder — the decision, with the numbers beside each option

| Option | What it costs | What the model says it buys (30-day, hourly regime, k = 1 → option) |
|---|---|---|
| **Keep k = 1** — the rule as built | 4.1 % of the debt idle; carry 0.14 % of the debt per year | ZEC sold on 23 % of paths with the bridge working, 39 % without |
| **Raise the multiple for the cross-chain class** (k = 3, or 5) | 12.3 % / 20.5 % idle; 0.42 % / 0.69 % carry — and that much less USDC deployed on Base | 20 % / 17 % with the bridge, 28 % / 21 % without |
| **Mark a lower entry for cross-chain positions** (HF 2.0, LTV 32.5 %; or 2.2, LTV 29.5 %) | a smaller loan for the same ZEC — the slider already allows it; the change is the wizard's mark and copy | 24 % / 15 % at k = 1 without the bridge |
| **Add a top-up threshold** (keeper) or hold 1.25 R | one line in the keeper, or a 1 % larger reserve | the bridge is not crossed for basis points (§5 item 4); no change to the sold share |
| **Leave it until the devnet run** | nothing | the bridge time measured; the sizing above unchanged, since it barely depends on it |

Whatever is chosen, the enforced rule stays `deposit_for_burn`'s; a larger multiple is a keeper and wizard
setting on top of it, not a program change.

## 8 · Regenerating

```bash
npm run build -w @zyo/yield
node services/yield/scripts/reserve-sizing.mjs            # the tables in §4, from the committed sample
node services/yield/scripts/reserve-sizing.mjs --fetch    # a new dated sample from Kraken, then the tables
npm test -w @zyo/yield                                    # pins §4's headline numbers to the sample
```

A new sample gets a new date in its name and a new pin file; this document is the 2026-09-19 run and stays so.
