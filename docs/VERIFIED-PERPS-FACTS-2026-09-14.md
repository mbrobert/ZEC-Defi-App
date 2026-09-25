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

### The read precompiles, verified against the API at the same moment

Probed at `https://rpc.hyperliquid.xyz/evm`, **2026-09-14T22:53:44Z**. The **ZEC perp asset index is 214**
(its position in the `meta` universe of 234 perps — the index *is* the asset id a limit order takes).

| Precompile | Signature that answers | ZEC (index 214) raw | Decoded | The API at the same second |
|---|---|---|---|---|
| `0x…0806` | `(uint32 perp)` | 11,691,000 | **1,169.1000** | `markPx` **1169.1** ✔ |
| `0x…0807` | `(uint32 perp)` | 11,692,826 | **1,169.2826** | `oraclePx` **1169.2826** ✔ |
| `0x…0800` | `position(address, uint16 perp)` | six words of zero for an address with no position | — | shape confirmed; it does not revert |
| `0x…0801` | `spotBalance(address, uint64 token)` | three words | — | shape confirmed |
| `0x…0803` | `withdrawable(address)` | one word | — | shape confirmed |

**Price scaling: `10^(6 − szDecimals)`**, so 10^4 for ZEC — confirmed by the two exact matches above, not
assumed. `0x…0802` reverts `PrecompileError` on the input shapes tried; its signature is not yet known.

### The limit-order action, from the documentation (NOT yet byte-verified)

Version byte `0x01`, then the action id as three big-endian bytes `0x000001`, then
`abi.encode(uint32 asset, bool isBuy, uint64 limitPx, uint64 sz, bool reduceOnly, uint8 encodedTif,
uint128 cloid)` — `limitPx` and `sz` scaled by 10^8, `encodedTif` 1 = Alo / 2 = Gtc / 3 = Ioc, `cloid` 0 for
none. **This is the one load-bearing fact still taken from a document rather than from chain**, and the two
scalings disagree in a way worth noticing: the *prices the precompiles return* are scaled by 10^4 for ZEC,
while the *price a limit order carries* is documented as 10^8. Do not write an order encoder until that has
been proven against a real order on testnet.

**Still to verify before code depends on it:** the `position` struct's field order and types (six words read,
none decoded — needs Hyperliquid's own `L1Read.sol`), the margin table behind `marginTableId: 52`, and the
limit-order bytes above. `0x2222…2222` also carries code, consistent with the documented precompile range,
but nothing was decoded from it.

### One number that is not a fact but is a warning

Between the two reads in this file — **2026-09-13T23:52Z at $1,063.80** and **2026-09-14T22:53Z at
$1,169.10** — ZEC moved **+9.9 % in 23 hours**. That is the move the short leg of a delta-neutral position
has to survive on 10× maximum leverage, and it is why the liquidation distance of the short, not the funding,
is the thing the keeper will have to watch.

## 5 · Getting USDC there is the rail we already built

Hyperliquid documents USDC deposits from **Arbitrum, Ethereum, Base and Polygon**, and transfers from other
chains **via CCTP** — the same Circle protocol the cross-chain loop already uses in both directions
(`VERIFIED-SOLANA-FACTS.md` Addenda 1, 3 and 4; `agent/src/solana/` and `StrategyRouter.closeLpAndBurn`).

**Not yet verified:** the Hyperliquid deposit address and its CCTP domain id, whether a deposit credits a
contract address the same way it credits an externally owned account, and the minimum deposit. Each must be
read before code depends on it.

## 6 · Addendum (2026-09-25 22:16–22:18 UTC) · the margin table decoded, twelve more days of funding, the venue's own margining rules, and CCTP's HyperEVM domain

Read for the D1 design (`docs/PERPS-DESIGN-2026-09-25.md`), the same way as §2–§4: the venue's own API,
unauthenticated, and the venue's own documentation quoted verbatim where a rule is taken from a page. The raw
bodies for ZEC are in `docs/research/hyperliquid-zec-2026-09-25.json`.

### The API, `POST https://api.hyperliquid.xyz/info`

| Read | Value | Time |
|---|---|---|
| `meta` — ZEC | index **214** of 234, `{"szDecimals": 2, "name": "ZEC", "maxLeverage": 10, "marginTableId": 52}` — unchanged since 2026-09-13 | 22:16:56Z |
| `meta.marginTables[52]` | **`{"description": "tiered 10x (2)", "marginTiers": [{"lowerBound": "0.0", "maxLeverage": 10}, {"lowerBound": "20000000.0", "maxLeverage": 5}]}`** — §4's "margin table behind marginTableId: 52", now read rather than assumed: 10× up to $20 M notional, 5× above | 22:16:56Z |
| `meta.collateralToken` | **0** (USDC) | 22:16:56Z |
| `metaAndAssetCtxs` — ZEC | mark **1,533.30**, oracle **1,532.79**, mid 1,533.35, previous-day price 1,537.70, open interest **504,883.46 ZEC ≈ $774 M** at the mark, 24-hour notional volume **$551,357,900**, funding **0.0000125/h = +10.95 %/yr** to shorts, premium 0.00033 | 22:17:36Z |
| `fundingHistory`, ZEC, from 2026-09-13T23:00Z | **288 hourly samples to 2026-09-25T22:00Z (12.0 d)**: mean **+13.55 %/yr**, median +10.95 %, min **−24.02 %**, max **+147.24 %**, negative in **12 / 288 = 4.2 %** of hours, realised 0.446 % over the window ≈ +13.55 %/yr | 22:17:37Z |

**ZEC moved from $1,063.80 (2026-09-13T23:52Z) to $1,533.30 — +44.1 % in twelve days.** On a short with
$0.50 of margin per dollar of notional that is the whole distance to liquidation (design §4).

### The rules, quoted from Hyperliquid's documentation (`hyperliquid.gitbook.io/hyperliquid-docs`, read 2026-09-25)

- **Margining** (`/trading/margining`): *"The margin required to open a position is position_size × mark_price /
  leverage."* *"The maintenance margin is currently set to half of the initial margin at max leverage."* *"Cross
  margin is the default, which allows for maximal capital efficiency by sharing collateral between all other
  cross margin positions."* *"Isolated margin is also supported, which allows an asset's collateral to be
  constrained to that asset."* *"The leverage of an existing position can be increased without closing the
  position."* *"Unrealized pnl for cross margin positions will automatically be available as initial margin for
  new positions, while isolated positions will apply unrealized pnl as additional margin for the open position."*
  *"Unrealized pnl can be withdrawn from isolated positions or cross account, but only if the remaining margin is
  at least 10% of the total notional position value of all open positions."*
- **Margin tiers** (`/trading/margin-tiers`): *"maintenance_margin = notional_position_value ×
  maintenance_margin_rate − maintenance_deduction"*; *"maintenance_margin_rate(tier = n) = (Initial Margin Rate at
  Maximum leverage at tier n) / 2"*; *"maintenance_deduction(tier = 0) = 0"*, and for tier n the previous
  deduction plus *"notional_position_lower_bound(tier = n) × (maintenance_margin_rate(tier = n) −
  maintenance_margin_rate(tier = n − 1))"* — so ZEC's rate is **5 % under $20 M notional, 10 % above**, continuous.
- **Liquidations** (`/trading/liquidations`): *"A liquidation event occurs when a trader's positions move against
  them to the point where the account equity falls below the maintenance margin."* *"When the account equity drops
  below maintenance margin, the positions are first attempted to be entirely closed by sending market orders to
  the book."* *"If the account equity drops below 2/3 of the maintenance margin without successful liquidation
  through the book, a backstop liquidation happens through the liquidator vault."* *"During backstop liquidation,
  the maintenance margin is not returned to the user."* *"Liquidations use the mark price, which combines external
  CEX prices with Hyperliquid's book state."* *"For liquidatable positions larger than 100k USDC (10k USDC on
  testnet for easier testing), only 20% of the position will be sent as a market liquidation order to the book."*
  **`liq_price = price − side × margin_available / position_size / (1 − l × side)`**, *"side = 1 for long and −1
  for short"*, *"margin_available (cross) = account_value − maintenance_margin_required"*, *"margin_available
  (isolated) = isolated_margin − maintenance_margin_required"*, *"l = 1 / MAINTENANCE_LEVERAGE"*.
- **Funding** (`/trading/funding`): *"The funding rate on Hyperliquid is paid every hour"*, on
  *"position_size × oracle_price × funding_rate"*; *"Funding Rate (F) = Average Premium Index (P) + clamp
  (interest rate − Premium Index (P), −0.0005, 0.0005)"*, the interest rate *"predetermined at 0.01% every 8
  hours"*; *"Funding on Hyperliquid is capped at 4%/hour"*; *"The funding rate is added or subtracted from the
  balance of contract holders at the funding interval."*
- **CoreWriter** (`/for-developers/hyperevm/interacting-with-hypercore`): encoding *"Byte 1: Encoding version"*
  (version 1), *"Bytes 2-4: Action ID"* big-endian; limit order **id 1** `(asset, isBuy, limitPx, sz, reduceOnly,
  encodedTif, cloid)` as `(uint32, bool, uint64, uint64, bool, uint8, uint128)` with *"limitPx and sz should be
  sent as 10^8 × the human readable value"*; *"Order actions and vault transfers sent from CoreWriter are delayed
  onchain for a few seconds."* The action table, as the page lists it: 1 limit order · 2 vault transfer · 3 token
  delegate · 4 staking deposit · 5 staking withdraw · 6 spot send · **7 USD class transfer `(ntl, toPerp)` as
  `(uint64, bool)`** · 8 finalize EVM contract · 9 add API wallet · 10 cancel by oid · 11 cancel by cloid · 12
  approve builder fee · **13 send asset `(destination, subAccount, source_dex, destination_dex, token, wei)`** ·
  15 borrow/lend operation · 16 set abstraction · 17 outcome operation. **No action sets leverage or moves
  isolated margin.** *"The precompile addresses start at 0x0000000000000000000000000000000000000800."*
- **Transfers** (`/for-developers/hyperevm/hypercore-less-than-greater-than-hyperevm-transfers`): *"Transferring
  tokens from HyperEVM to HyperCore can be done using an ERC20 transfer with the corresponding system address as
  the destination."* *"The tokens are credited to the Core based on the emitted Transfer from the linked contract."*
  *"Transferring tokens from HyperCore to HyperEVM can be done using a sendAsset action (or via the frontend) with
  the corresponding system address as the destination."*
- **Deposits** (`/onboarding/how-to-start-trading`): *"You can send USDC on Arbitrum/Ethereum/Base/Polygon to the
  deposit address shown"*; *"You can also transfer USDC from other chains via CCTP."*
- **Circle** (`developers.circle.com/cctp/cctp-supported-blockchains`, read 2026-09-25): **HyperEVM is CCTP V2
  domain 19** — Standard Transfer supported, **Fast Transfer "N/A"**, upfront fees and the forwarding service
  supported. (The full domain list read that day: 0 Ethereum · 1 Avalanche · 2 OP · 3 Arbitrum · 5 Solana · 6
  Base · 7 Polygon · 9 Aptos · 10 Unichain · 11 Linea · 12 Codex · 13 Sonic · 14 World Chain · 15 Monad · 16 Sei
  · 17 BNB · 18 XDC · **19 HyperEVM** · 21 Ink · 22 Plume · 25 Starknet · 26 Arc · 27 Stellar · 28 EDGE · 29
  Injective · 30 Morph · 31 Pharos · 32 Cronos · 33 Plasma · 37 X Layer.)

### From secondary sources only — NOT the venue's own file

The `position` precompile's struct, **`int64 szi; uint64 entryNtl; int64 isolatedRawUsd; uint32 leverage; bool
isIsolated`**, is quoted by two developer guides (Chainstack, Ambit Labs) from Hyperliquid's `L1Read.sol`, which
the docs attach as a file this read could not open. Six words were read from `0x…0800` on 2026-09-14 and none
decoded. It stays **[secondary]** until a real position is decoded on testnet.

### Still not verified (the D0b gate, `PERPS-DESIGN-2026-09-25.md` §2)

The limit-order bytes on testnet; the `position` struct from the primary file or a live decode; whether a
contract address is credited on HyperCore by the system-address transfer; USDC's HyperEVM contract and system
address; the leverage a fresh contract account carries at its first order; Circle's CCTP V2 contracts on
HyperEVM and the 6→19 / 19→6 fees; what a backstop liquidation leaves; a test that action 7 and action 13 do
what the table says from a contract.
