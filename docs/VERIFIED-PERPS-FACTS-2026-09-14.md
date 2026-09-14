# Verified perps facts — read 2026-09-13/14, nothing typed from memory

Written because the founder asked on 2026-09-14 for perpetuals in beta. CLAUDE.md rule 3: every address,
parameter and rate below was read from the venue's own API or from chain, with the timestamp of the read.
Nothing here is taken from the 2026-09 research documents, which were written from one aggregator on one day
and are superseded by this file wherever they disagree.

Abbreviations: perp = perpetual future; OI = open interest; funding = the periodic payment between longs and
shorts that holds a perp near spot; CCTP = Circle's Cross-Chain Transfer Protocol; RPC = remote procedure
call; APR = annual percentage rate.

**The product this is for** (`BASE-PIVOT-2026-09.md` item 9, the only prior specification): *delta-neutral
"earn funding on your ZEC"* — the user keeps their ZEC and shorts a ZEC perp against it, so the price
exposure nets to about zero and the return is the funding the shorts are paid. It is **not** leverage and
must never be sold as "yield"; the short leg can be liquidated.

---

## 1 · There is no ZEC perp on Base

| Venue | Status | Read |
|---|---|---|
| **Avantis** (the live Base perps venue) | Crypto markets are **BTC 500× · ETH 500× · SOL 500× · XRP 75× · HYPE 75×**. **No ZEC.** The page says "more markets are added as vault capacity and hedging depth allow" | `docs.avantisfi.com/trading/upside-perps/assets-leverage.md`, 2026-09-13 |
| **Synthetix** | **Shut down on Base 2025-07-07**; the 2026 roadmap is Ethereum mainnet only | `docs/research/CAPITAL-AND-VENUES-2026-09.md` §4.5 |

**So the delta-neutral ZEC trade cannot be done on Base at all today.** This is the single fact that decides
the shape of the work: perps is not an extension of the Base module.

## 2 · Hyperliquid has a ZEC perp, and it is deep

`POST https://api.hyperliquid.xyz/info {"type":"meta"}` — 234 perps in the universe, read
**2026-09-13T23:52:20Z**:

```json
{"name": "ZEC", "szDecimals": 2, "maxLeverage": 10, "marginTableId": 52}
```

`{"type":"metaAndAssetCtxs"}` at the same moment:

| | Value |
|---|---|
| Mark price | **1,063.80** |
| Oracle price | 1,064.0805 |
| Open interest | **447,372.32 ZEC** ≈ **$476 M** at the mark |
| 24-hour notional volume | **$283,765,042** |
| Funding, 1 hour | 0.0000125 → **+10.95 %/yr paid by longs to shorts** |
| Premium | −0.00016963 |

Hyperliquid is the **only non-custodial venue found with a ZEC perp**. Every other venue carrying one —
Binance, OKX, Bybit, Kraken, Coinbase futures — is custodial and requires the user to give up their coins,
which is the opposite of this product.

## 3 · The funding, measured over 31 days rather than quoted from one day

`{"type":"fundingHistory","coin":"ZEC"}`, hourly samples. Two windows because the endpoint returns at most
500 samples per call. **Positive funding means shorts are PAID.**

| Window | Samples | Mean (annualised) | Median | Min | Max | Hours negative | Realised carry |
|---|---|---|---|---|---|---|---|
| 2026-08-15 00:00Z → 2026-09-04 19:00Z (20.8 d) | 500 | **+22.16 %** | +10.95 % | −30.18 % | +240.94 % | 15 / 500 = **3.0 %** | 1.273 % over the window ≈ **+22.35 %/yr** at that pace |
| 2026-09-04 00:00Z → 2026-09-13 23:00Z (10.0 d) | 240 | **+10.63 %** | +10.95 % | −64.47 % | +54.31 % | 12 / 240 = **5.0 %** | 0.292 % over the window ≈ **+10.69 %/yr** at that pace |

Sub-periods of the first window, annualised means: +23.95 % (n=163), +29.57 % (n=168), +13.08 % (n=169).

**What this says, and what it does not.** Over 31 days funding was positive to shorts in about **96 % of
hours**, and the realised carry ran between **+10.7 % and +22.4 % annualised**. That is a real return and it
is better than the ~11 % the 2026-09 research estimated from one aggregator on one day. **It is also 31 days
of a young, volatile market**: the extremes (−64 % and +241 % annualised) are large, funding flips negative
several percent of the time, and nothing here forecasts the next 31 days. This must be shown as a measured
history with its variance, never as a rate — and never as "yield" (`web/lib/copy.ts` BANNED_WORDS).

## 4 · A contract can hold the position itself — chain-verified

The thing that decides whether this can keep Oilskin's "you own your account" promise.

| | Value |
|---|---|
| HyperEVM chain id | **999** (read `eth_chainId` at `https://rpc.hyperliquid.xyz/evm`, block 45,908,920, 2026-09-14) |
| **CoreWriter** | `0x3333333333333333333333333333333333333333` — **544 bytes of code on chain**, not an empty address |
| Its function | `sendRawAction(bytes)` → selector **`0x17938e13`**, and `0x17938e13` is the selector in the deployed contract's own dispatch table (`cast code` head: `…610029575f3560e01c806317938e13…`) |
| Limit order | action id 1; asset, price, size, time-in-force |
| Cost | ~25,000 gas burned to emit the action log; ~47,000 gas typical |
| Delay | order actions from CoreWriter are **delayed a few seconds** on chain, so a contract cannot beat the L1 mempool |
| **Position ownership** | **the position belongs to the calling contract's own address on HyperCore** |

That last row is the important one: a per-user account contract on HyperEVM would own its own perp position,
exactly as `OilskinAccount` owns its Aave position on Base and the Solana PDA owns its Kamino obligation.
**The pattern generalises; it does not have to be fought.**

**Not yet chain-verified, and it must be before code depends on it:** the action encoding for a limit order
(id 1) byte for byte, the read precompiles for a position's size and margin, the ZEC asset index on
HyperCore, and the margin table behind `marginTableId: 52`. `0x2222…2222` also carries code, which is
consistent with the documented read-precompile range, but nothing was decoded from it.

## 5 · Getting USDC there is the rail we already built

Hyperliquid documents USDC deposits from **Arbitrum, Ethereum, Base and Polygon**, and transfers from other
chains **via CCTP** — the same Circle protocol the cross-chain loop already uses in both directions
(`VERIFIED-SOLANA-FACTS.md` Addenda 1, 3 and 4; `agent/src/solana/` and `StrategyRouter.closeLpAndBurn`).

**Not yet verified:** the Hyperliquid deposit address and its CCTP domain id, whether a deposit credits a
contract address the same way it credits an externally owned account, and the minimum deposit. Each must be
read before code depends on it.
