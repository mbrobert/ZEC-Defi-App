# Pool research — blue-chip Aerodrome pools the Snuggle engine supports

Research date: **2026-08-27** (all figures are that day's samples; fee tiers
are dynamic and TVL/volume swing — treat every number as dated, none as a
promise). Written for Matt's ask: *"list all pools that have blue chips (no
meme coins) and coins that are ranked in the top 50 by market cap that
snuggle fi supports."*

## Method (all on-chain / primary-source)

1. **Enumerated the engine registry** — vault proxy
   `0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55` (Base), `approvedPools`,
   batched through Multicall3 `0xca11bde05977b3631167028862be2a173976ca11`:
   **209 approved pools, 67 distinct tokens**.
2. **Classified each pool's factory**: Aerodrome Slipstream
   (`0x5e7bb104…`) **63 active** · Uniswap V3 (`0x33128a8f…`) 52 ·
   PancakeSwap 15. Only Aerodrome pools qualify for the v1 menu (positions
   are staked in Aerodrome gauges via the Snuggle engine and earn AERO).
3. **Top-50 filter**: both tokens must rank in the top 50 by market cap
   (live CoinGecko ranks, 2026-08-27), with wrapped/bridged forms mapped to
   their underlying: WETH→ETH, cbBTC→BTC, cbETH→ETH, cbXRP→XRP, cbADA→ADA,
   cbDOGE→DOGE, cbLTC→LTC, uSOL→SOL, USDC/USDT are themselves top-50.
4. **Sampled each qualifier**: on-chain `fee()` (selector `0xddca3f43` —
   Slipstream fees are DYNAMIC, they move with volatility) + GeckoTerminal
   TVL and 24h volume → gross fee APR = vol × fee ÷ TVL × 365.

## The 13 qualifying blue-chip pools

| Pool | Address | Engine id | Fee (on-chain) | TVL | 24h vol | Gross fee APR | Verdict |
|---|---|---|---|---|---|---|---|
| WETH/USDC | `0xb2cc224c…dc59` | `0x0ea72f44…72a8` | 0.056% | $8.81M | $31.8M | **73.6%** | ✅ menu |
| USDC/cbBTC | `0x4e962bb3…e778` | `0xb1830be2…37e6` | 0.044% | $5.69M | $21.1M | **59.6%** | ✅ menu |
| WETH/cbBTC | `0x70acdf2a…bae1` | `0xc97cb5ca…c35f` | 0.253% | $15.4M | $5.5M | **33.0%** | ✅ menu |
| WETH/LINK | `0x72be417a…b59c` | `0x477c2374…ab24` | 0.25% | $1.65M | $0.64M | **35.5%** | ✅ menu |
| cbETH/WETH | `0x47ca96ea…7348` | `0xcfdea513…d419` | 0.007% | $3.73M | $5.86M | **3.7%** | ✅ menu (stable/LST) |
| USDC/USDT | `0xa41bc0af…fcd1` | `0x0ff8167e…abd7` | 0.001% | $1.31M | $3.70M | **0.9%** | ✅ menu (stable; negative carry vs USDC borrow today) |
| cbETH/cbBTC | `0x579b8f41…` | `0xece3b88c…` | — | thin | thin | — | ⏳ thin TVL, joins when liquidity can absorb positions |
| cbADA/cbBTC | — | — | — | thin | thin | — | ⏳ thin TVL |
| WETH/cbADA | — | — | — | thin | thin | — | ⏳ thin TVL |
| cbLTC/cbBTC | — | — | — | thin | thin | — | ⏳ thin TVL |
| WETH/cbXRP | `0xa382a069…` | `0x3937a02f…` | — | **$1** | ~0 | — | ❌ DEAD pool — excluded |
| cbBTC/cbDOGE | — | — | — | — | — | — | ❌ DOGE is a memecoin — excluded by the no-meme rule despite its rank |
| WETH/uSOL | `0x0225ba89…` | `0x806396cb…` | — | $1.06M | $0.83M | 43.1% | ⏳ candidate — uSOL is a wrapped-SOL representation with its own wrapper risk; hold for diligence |

**Borderline, offered with eyes open (not "blue chip"):**

- **AERO/WETH** (`0x82321f3b…` / `0x6d9490cf…c1d1`) — fee 0.30%, $1.43M TVL,
  $1.13M/day → 86.9% gross. AERO is the venue's own token, not top-50.
  In the menu as VOLATILE with an explicit IL warning.
- **AERO/cbBTC** (`0xdfe5f275…` / `0xa893d6d3…9bfc`) — fee 0.075%, $1.28M
  TVL, $3.85M/day → 82.4% gross. Same caveats, VOLATILE.
- **EURC pairs** — fiat-backed euro stablecoin, engine-approved, but EURC is
  not top-50-ranked; deferred.

## The shipped v1 menu (8 pools)

4 blue-chip (WETH/USDC, USDC/cbBTC, WETH/cbBTC, WETH/LINK) + 2 stable/LST
(cbETH/WETH, USDC/USDT) + 2 volatile venue-token pairs (AERO/WETH,
AERO/cbBTC). Simple picks **one pool at a time** (Matt's call 2026-08-27);
Advanced keeps multi-position freedom. All positions are **staked in the
pool's Aerodrome gauge**: trading fees go to veAERO voters and the position
earns AERO emissions instead — at equilibrium emissions track fees, so the
gross fee APR above is the honest proxy for gauge pay.

## Standing corrections this research produced

- `cbeth-weth` in the curated registry pointed at a different venue's pool
  (`0xa9dafa…`/`0x81360d12…`) — corrected to `0x47ca96ea…`/`0xcfdea513…`
  (verified active via `approvedPools` 2026-08-28).
- `aero-usdt-usdc` likewise: `0xd56da2b7…`/`0x340448ed…` → corrected to
  `0xa41bc0af…`/`0x0ff8167e…` (verified active 2026-08-28).
- Old static fee labels were wrong where fees are dynamic: AERO/WETH is
  0.30% today (was labeled 1%), AERO/cbBTC 0.075% (was labeled 0.6%).
