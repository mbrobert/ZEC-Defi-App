# Solana ZEC lending — Kamino "ZCASH Market", read live 2026-09-11

Every figure below was read on 2026-09-11 between 10:06 and 10:08 UTC, from the
sources named next to it. Nothing is typed from memory or from press coverage.
Abbreviations: LTV = loan-to-value; LT = liquidation threshold; APY/APR = annual
percentage yield/rate; TVL = total value locked; MPC = multi-party computation;
CCTP = Circle's Cross-Chain Transfer Protocol.

**Why this file exists.** Kamino listed bridged ZEC as collateral for USDC on
Solana on 2026-09-07. Oilskin's Base-first v1 has cbZEC registered but disabled
because no Base lending market lists it (`README.md`). This is the primary-source
read that lets the founder compare the two routes on real numbers.

## 1 · The market

| Item | Value | Source |
|---|---|---|
| Market | "ZCASH Market", curated, not primary | `GET api.kamino.finance/v2/kamino-market` |
| Lending market pubkey | `GBJ3bzUiMfwC9ugaF3MM68EXMDyTUb5UryRRAcVjEowd` | same |
| ZEC reserve | `6e8XcrdencrXBjXtTqYkRS63nS36petvzkV3gBf2ezbH` | `…/kamino-market/<market>/reserves/metrics` |
| USDC reserve | `EW9vT7g2VH2aTFfcbaXRUCbF7jEfaLwMiJpckwDZwUZd` | same |
| Reserve accounts decoded at | Solana slot 446130392 | `getAccountInfo` + `@kamino-finance/klend-sdk` `Reserve.decode` |

## 2 · ZEC as collateral (on-chain reserve config)

| Parameter | Value | Note |
|---|---|---|
| Max LTV | **40 %** | `loanToValuePct` |
| Liquidation threshold | **65 %** | `liquidationThresholdPct` |
| Liquidation bonus | 2 % min → 7 % max; 0.1 % on bad debt | `min/maxLiquidationBonusBps` |
| Protocol share of liquidation fee | 50 % | `protocolLiquidationFeePct` |
| Deposit cap | 13,000 ZEC (≈ $14.3 M at $1,103) | `depositLimit` |
| Deposited now | 1,021.63 ZEC ≈ $1.128 M (7.9 % of cap) | API `totalSupply` |
| Withdrawal cap | 3,000 ZEC per 24 h | `depositWithdrawalCap` |
| Can ZEC be borrowed? | **No** — borrow limit 0; supply APY 0 % | `borrowLimit`, API `supplyApy` |
| Status | active (0); no elevation groups (no e-mode) | `status`, `elevationGroups` |

**Implied liquidation drawdown at max LTV:** 40 / 65 = 0.615 → a **−38.5 %** ZEC
move from entry liquidates a position opened at 40 % LTV. (Base, for
comparison: cbBTC LT 78 % at 50 % LTV → −35.9 %; WETH LT 83 % at 50 % LTV →
−39.8 %, per `docs/VERIFIED-BASE-FACTS.md`.)

**Against Oilskin's own entry rule** (`maxOfferedLtv = min(50 %, LT / 1.55)`,
`CollateralRegistry`): 65 / 1.55 = 41.9 %, capped by Kamino's 40 % → **40 %**.
Entry health factor at 40 % LTV = 65 / 40 = **1.625 ≥ 1.55** — the floor is
satisfied at Kamino's own maximum without any change to the rule.

## 3 · The ZEC price oracle

| Item | Value |
|---|---|
| Oracle | Kamino **Scope** aggregator, price feed `3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH`, index **430** |
| Type | `MostRecentOf` (composite of several underlying feeds; mapping account `4zh6bmb77qX2CL7t5AJYCqa6YqFafbz3QJNeFvZjLowg`, price-info `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ`) |
| Price at read | **$1,109.08** at slot 446130526 (reserve's own cached `marketPriceSf` $1,103.42 at ts 1789120769) |
| Staleness limits | price ≤ 180 s, TWAP ≤ 240 s, max TWAP divergence 10 % |
| Sanity band | $400 – $2,000 (`heuristic` lower 4000 / upper 20000, exp 1) |

Note the ZEC price: ≈ $1,100. The repo's pre-pivot numbers used ≈ $487 (Aug 2026).

## 4 · USDC on the borrow side (on-chain reserve config + API)

| Parameter | Value |
|---|---|
| Supplied | **$801,627** (801,692 USDC) |
| Borrowed | **$388,147** (388,178 USDC) |
| Available to borrow now | **≈ $413,500** |
| Utilisation | **48.4 %** |
| Borrow APY now | **2.777 %** |
| Supply APY now | 1.201 % |
| Protocol take rate | 10 % of interest |
| Supply cap / borrow cap | $2,000,000 / $2,000,000 |
| Withdrawal caps | $1,000,000 per 24 h, deposits and debt alike |
| Borrow-rate curve (utilisation → APY) | 0 % → 1.19 · 50 % → 2.79 · 90 % → 7.25 · 92 % → 8.97 · 100 % → 38.6 (linear between points) |

**What the curve means for a product that would become most of this market.**
Every dollar Oilskin's users borrow moves the rate for all of them. Holding
today's $801.6 K supply fixed (scenario, not a forecast):

| Extra USDC borrowed by Oilskin users | Utilisation | Borrow APY |
|---|---|---|
| $0 (today) | 48.4 % | 2.78 % |
| +$100 K | 60.9 % | ≈ 4.0 % |
| +$200 K | 73.4 % | ≈ 5.4 % |
| +$300 K | 85.8 % | ≈ 6.8 % |
| +$400 K | 98.3 % | ≈ 32 % |
| +$413 K | 100 % | 38.6 % — and nothing left to borrow |

Beyond ≈ $200 K of new borrowing the rate is above Base's; beyond ≈ $413 K the
pool is empty until new lenders arrive. The cap ($2 M) is not the binding limit;
the actual supply is.

## 5 · Base, read the same minute, for the comparison

| Aave v3 Base — USDC reserve | Value |
|---|---|
| Supplied | **$183.28 M** |
| Variable debt | **$158.40 M** |
| Utilisation | 86.4 % |
| Variable borrow APR | **4.513 %** (was 4.828 % on 2026-09-05, `README.md`) |
| Supply APR | 3.511 % |
| Read at | Base block 51,165,984 (ts 1789121249), `PoolDataProvider.getReserveData(USDC)` via `base-rpc.publicnode.com` |

The Base pool is ≈ 230× the size of Kamino's ZEC-market USDC pool. A $1 M borrow
moves Base utilisation by 0.5 points; the same borrow cannot happen on Kamino
today at all.

## 6 · The bridged ZEC itself

| Item | Value | Source |
|---|---|---|
| Token | "OmniBridge Bridged Zcash (Solana)", symbol ZEC | CoinGecko / Solscan listing |
| Mint | `A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS`, SPL Token (legacy program), 8 decimals | `getAccountInfo` jsonParsed |
| Supply on Solana | **95,850.61 ZEC** ≈ $106.6 M | mint `supply` 9585060611979 |
| Mint authority | `FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds` — a **System-program-owned address with no on-chain program logic** | `getAccountInfo` (owner `1111…`, not executable) |
| Freeze authority | **none** — balances cannot be frozen | mint `freezeAuthority: null` |
| Bridge | NEAR Intents / OmniBridge (NEAR chain-signature MPC); from Solana's side the mint is controlled by a key, not by a verifying contract | press + the mint-authority read above |

## 7 · Solana DEX depth for ZEC (matters for liquidations and unwinds)

GeckoTerminal, `/networks/solana/tokens/<mint>/pools`, read 2026-09-11:

| Pool | DEX | TVL | 24 h volume |
|---|---|---|---|
| ZEC / USDC | Orca | $2.02 M | $9.99 M |
| ZEC / ZCAT | Raydium CLMM | $1.42 M | $4.82 M |
| ZEC / SOL | Meteora | $1.02 M | $4.99 M |
| ZEC / USDC | Meteora | $0.32 M | $0.89 M |
| ZEC / SOL | Orca | $0.35 M | $1.72 M |
| (15 more, each < $0.35 M) | | | |
| **Total reserves, all pools** | | **≈ $4.0 M** | **≈ $39.2 M / 24 h** |

A liquidator selling $400 K of ZEC is selling ≈ 10 % of all on-chain ZEC
liquidity on Solana in one go. Kamino's 2–7 % liquidation bonus is what pays for
that slippage; whether it covers it in a fast market is not something this read
can answer.

## 8 · What is NOT on Solana

- No Aerodrome, no Slipstream, no Snuggle/MaxFi engine. Aero's announced
  expansion is Ethereum and Circle's Arc, not Solana (`docs/research/…`, DL News
  2026-05). The "Solana tokens on Aerodrome" that exist are Universal's wrapped
  assets (uSOL etc.) — Solana assets brought onto Base, the opposite direction.
- The LP leg on Solana would be Orca / Meteora DLMM / Raydium CLMM, with a
  different engine, different code, no reuse of `contracts/`, `agent/`, or the
  EVM account model.
- USDC can cross Solana → Base natively via CCTP in minutes; that is the one
  clean hop.

## 9 · Reproduce

```bash
curl -s https://api.kamino.finance/v2/kamino-market | jq '.[] | select(.name|test("ZCASH"))'
curl -s https://api.kamino.finance/kamino-market/GBJ3bzUiMfwC9ugaF3MM68EXMDyTUb5UryRRAcVjEowd/reserves/metrics | jq
# reserve config: node + @kamino-finance/klend-sdk → Reserve.decode(getAccountInfo(<reserve>).data)
# oracle: @kamino-finance/scope-sdk OraclePrices.decode(getAccountInfo(3t4JZcue…).data).prices[430]
# Base: cast call 0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A "getReserveData(address)" 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 --rpc-url $BASE_RPC_URL
```
