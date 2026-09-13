# Verified Solana mainnet facts for the Solana module (read live 2026-09-12 00:36–00:57 UTC, slots 446,294,693 → 446,298,641)

Method: JSON-RPC `getAccountInfo` / `getProgramAccounts` / `getSignaturesForAddress` / `getTransaction`
against the public endpoint `https://api.mainnet-beta.solana.com` at `finalized` commitment, decoded with
`@kamino-finance/klend-sdk` 12.0.0 (Kamino's own account layouts) and, for the Scope oracle, a byte-level decode
checked against the account sizes the Scope SDK publishes. **Every address below has been confirmed to exist on
chain and to answer the reads stated.** Nothing here was signed or sent. The reader is committed as
`solana/scripts/read-facts.mjs` (+ `read-authorities.mjs`) and its raw output as
`docs/research/solana-facts-2026-09-12.json`, so every number can be traced to the bytes it came from.

A note on provenance. The handoff and `DIRECTION-2026-09-11.md` cite a research file
`docs/research/SOLANA-ZEC-KAMINO-2026-09.md`. **That file did not exist in the repository or on the founder's Mac when this file was written**
(searched 2026-09-12 00:36 UTC); it arrived with Cowork's bundle on the evening of 2026-09-12 and now sits at that
path (its numbers were read 2026-09-11 10:06–10:08 UTC). The direction memo carries its headline numbers, and this
file re-reads each of them from the chain; the "Drift" section at the end says where the memo's numbers have
moved. This file, not the research file, is what code pins to.

Abbreviations: LTV = loan-to-value; LT = liquidation threshold; HF = health factor; APR = annual percentage rate;
APY = annual percentage yield (compounded); PDA = program-derived address (an account a program, not a key,
controls); RPC = remote procedure call; TWAP = time-weighted average price; SPL = Solana Program Library (the
token standard); ATA = associated token account; CPI = cross-program invocation; MPC = multi-party computation;
DEX = decentralised exchange.

## Programs (all `executable`, all owned by the BPF upgradeable loader — every one has a live upgrade authority)

| Program | Id | Last deploy slot | Upgrade authority | Authority kind |
|---|---|---|---|---|
| Kamino Lend (klend) | `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` | 440,486,775 | `GzFgdRJXmawPhGeBsyRCDLx4jAKPsvbUqoqitzppkzkW` | off-curve, system-owned, no data — a PDA (consistent with a multisig vault; the controlling program was not identified) |
| Scope (Kamino's oracle aggregator) | `HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ` | 443,102,298 | `4R33WT7isNgzALNyvpZKiZQARtZNAXarWB3prUbPkXX7` | same shape |
| Kamino Farms | `FarmsPZpWu9i7Kky8tPN37rs2TpmMrAZrC7S7vJa91Hr` | 444,035,168 | `CivjSDKgTpmkRNL4zYcmv9D9QqPJg6yTxBVxMGcXvMuY` | same shape |
| **Bridge token program (mints ZEC)** | `dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe` | 428,811,242 | `5kx8AapW8tPkiFbuHiuEBcmN3ddwpBWZfCrZgxXgWeb6` | same shape |
| Wormhole core bridge | `worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth` | 425,583,168 | `2rCAC1VKz5YP1jZTHcVfWDhHMs2iEruUaATdeZe5Fjk5` | off-curve, account absent (Wormhole's own governance PDA) |
| Metaplex token metadata | `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s` | — | — | read only for the ZEC name/symbol |

Also seen in the bridge's transactions, role not identified: `EtZMZM22ViKMo4r5y4Anovs3wKQ2owUmDpjygnMMcdEX`.

**Product implication.** Every program in the trust path can be upgraded by an authority that is not a burned key.
That is the Solana norm and the copy must say so, the same way `RISKS.md` §16 says a timelocked registry owner is
still an owner. Whether any of the four PDAs is a multisig, and with what threshold and delay, is **not verified**.

## The ZCASH market (`LendingMarket` `GBJ3bzUiMfwC9ugaF3MM68EXMDyTUb5UryRRAcVjEowd`, 4,664 bytes, owner = klend)

Decoded with `LendingMarket.decode` (klend-sdk 12.0.0):

| Field | Value | Meaning |
|---|---|---|
| `name` | `ZCASH Market` | as shown on kamino.com; the Borrow page labels its curator **Allez Labs** and tags it **New** |
| `lendingMarketOwner` (= `…OwnerCached`) | `A11EznxnJM3JrjUvAq16wqoVyPRNz522mdQm6mSmzMeR` | the key or PDA that can change every reserve parameter below; not probed further |
| `version` | 1 | |
| `emergencyMode` / `borrowDisabled` / `autodeleverageEnabled` | 0 / 0 / 0 | market open; no protocol-driven deleveraging |
| `liquidationMaxDebtCloseFactorPct` | 20 | a liquidation may repay at most 20 % of an obligation's debt at once … |
| `maxLiquidatableDebtMarketValueAtOnce` | 500,000 | … and at most $500,000 of it |
| `insolvencyRiskUnhealthyLtvPct` | 95 | above 95 % LTV the close factor no longer applies (full liquidation allowed) |
| `minFullLiquidationValueThreshold` | 2 | debt below $2 is closed in full |
| `minInitialDepositAmount` | 100,000 base units | 0.001 ZEC / 0.10 USDC — first deposit floor |
| `minNetValueInObligationSf` | 1,152,921,504,607 (= 1e-6 in 2^60 scaled-fraction) | dust floor on an obligation's net value |
| `globalAllowedBorrowValue` | 45,000,000 | market-wide borrow ceiling in USD |
| `referralFeeBps` | 0 | |
| `priceRefreshTriggerToMaxAgePct` | 0 | |
| elevation groups | none active | no e-mode on this market |
| `obligationOrderCreationEnabled` / `…ExecutionEnabled` | 0 / 0 | **Kamino's own stop-loss / take-profit orders are not available on this market** — a keeper of our own is the only automated protection a position can have here |

## Reserves — exactly two (chain enumeration: `getProgramAccounts` on klend, `dataSize` 8,624, `lendingMarket` at offset 32)

| | ZEC reserve | USDC reserve |
|---|---|---|
| Address | `6e8XcrdencrXBjXtTqYkRS63nS36petvzkV3gBf2ezbH` | `EW9vT7g2VH2aTFfcbaXRUCbF7jEfaLwMiJpckwDZwUZd` |
| Liquidity mint | `A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS` (8 dp) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 dp) |
| Token program | SPL Token (`Tokenkeg…`) | SPL Token |
| Supply vault / fee vault | `7muPXroaziH8RTD62Ea4gQ3NuAPZswf8Gj7iuPZ6Ae6Y` / `3oxg1uptz3hSYvPiZEPW1UK2T2G5UUniyc2yjrszQC7R` | `C7ipQ9XPEncrVhCLXfHE4aCXPSk1HpPQUr127RwgVG9h` / `HwgFUiBaEHv2QnrpgVxPmWuUC5nqt7iGSna99ZQL8oTB` |
| Collateral (cToken) mint / vault | `FQc32zaNbQnUZmQxd3Fqhg3enqfozyX6K74xcCCHw4NU` / `8yr67socgzkzXYPMPC8KNCh8eLDPjGvqucLGXmCGdwq4` | `HfwrP5s6bL8pGuqAQUGr6S79AEfyWm2F8W6WJkuXmT53` / `GV12UJQSNK3cQPAGea9bHXcu7STuAadaCLeSwEKirWtQ` |
| Farms (collateral / debt) | none / none | none / none |
| `status` | 0 (active) | 0 (active) |
| **`loanToValuePct`** | **40** | 0 (not collateral) |
| **`liquidationThresholdPct`** | **65** | 0 |
| Liquidation bonus (`min` / `max` / bad-debt) bps | 200 / 700 / 10 | 200 / 700 / 10 |
| `protocolLiquidationFeePct` | 50 (of the bonus) | 0 |
| `borrowFactorPct` | 150 | 100 |
| `protocolTakeRatePct` | 0 | **10** (of interest) |
| Origination / flash-loan fee | 0 / 0 | 0 / 0 |
| **`depositLimit`** | **13,000 ZEC** (9.2 % used) | 2,000,000 USDC |
| **`borrowLimit`** | **0 — ZEC cannot be borrowed** | 2,000,000 USDC |
| Deposit-withdrawal cap | 3,000 ZEC per 86,400 s | 1,000,000 USDC per 86,400 s |
| Debt-withdrawal cap | — | 1,000,000 USDC per 86,400 s |
| `utilizationLimitBlockBorrowingAbovePct` | 0 (off) | 0 (off) |
| `autodeleverageEnabled` / `deleveragingThresholdDecreaseBpsPerDay` | 0 / 24 | 0 / 24 |
| `interestRateBasis` | 0 | 1 (meaning not verified — see below) |
| Borrow curve (utilisation → APR) | flat 10 % (moot: not borrowable) | (0 %, 1.19 %) · (50 %, 2.79 %) · (90 %, 7.25 %) · (92 %, 8.97 %) · (100 %, 38.60 %), linear between points |
| Oracle max age price / TWAP | **180 s / 240 s** | 180 s / 240 s |
| Max TWAP divergence | 1,000 bps | 300 bps |
| Price heuristic (sanity band) | **$400 – $2,000** (`lower` 4000, `upper` 20000, `exp` 1) | $0.98 – $1.02 |
| Scope price chain / TWAP chain | **[430]** / [429] | [13] / [456] |
| Pyth / Switchboard configuration | none (`nu11…`) | none |
| `lastUpdate` slot / `stale` / `priceStatus` | 446,297,685 / 0 / 63 | 446,296,905 / 0 / 0 |
| Cached `marketPriceSf` (ts) | $1,159.571 (1789174315) | $0.99986 (1789171383) |
| **Total supply** | **1,192.03654662 ZEC ≈ $1.38 M** | **800,695.99 USDC** |
| Borrowed | 0 | **442,516.97 USDC** |
| Available | 1,192.04 ZEC | **358,198.99 USDC** |
| Utilisation | 0 % | **55.27 %** |
| Borrow APR from the curve at that utilisation | — | **3.378 %** (Kamino's API shows it compounded: 3.43 % APY borrow, 1.69 % APY supply) |
| Accumulated protocol fees | 0 | 19.97 USDC |
| cToken total supply | 119,203,654,662 (= liquidity supply, 1:1) | 800,285,603,703 |

`priceStatus` 63 on the ZEC reserve reads as all six status bits set in klend's `PriceStatusFlags` (loaded,
age-checked, TWAP-checked, TWAP-age-checked, heuristic-checked, usage-allowed); the bit meanings were not
re-derived from the klend source in this read and must be before code depends on them.

## What a new Oilskin borrow does to the USDC pool (the pool-size gate's inputs, computed from the curve above)

Base's Aave v3 USDC variable borrow rate, read at the same time for the comparison the direction memo makes
(`PoolDataProvider.getReserveData(USDC)`, block 51,192,187, 2026-09-12 00:41:59 UTC): **4.5469 % APR**
(supply 3.5630 %; $183,117,044 supplied).

| New borrowing on Kamino | Borrowed | Utilisation | Borrow APR |
|---|---|---|---|
| +$0 | $442,517 | 55.27 % | 3.378 % |
| +$50,000 | $492,517 | 61.51 % | 4.073 % |
| **+$84,000** | $526,517 | 65.76 % | **4.547 % — crosses Base's rate** |
| +$100,000 | $542,517 | 67.76 % | 4.770 % |
| +$150,000 | $592,517 | 74.00 % | 5.466 % |
| +$200,000 | $642,517 | 80.24 % | 6.162 % |
| +$250,000 | $692,517 | 86.49 % | 6.859 % |
| +$300,000 | $742,517 | 92.73 % | 11.674 % |
| +$350,000 | $792,517 | 98.98 % | 34.822 % |
| **+$358,199** | $800,696 | 100 % | **pool empty** (bound by available liquidity, not by the $2 M borrow limit) |

## Scope oracle — how ZEC is priced (`OraclePrices` `3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH`, 28,712 bytes = 8 + 32 + 512 × 56; `OracleMappings` `4zh6bmb77qX2CL7t5AJYCqa6YqFafbz3QJNeFvZjLowg`, 29,704 bytes = 8 + 512 × 58; both owned by Scope)

The klend SDK ships this feed as `SCOPE_MAINNET_KLEND_FEED`; the Hubble feed
(`3NJYftD5sjVfxSnUdZ1wVML8f3aC6mp1CXCL6L7TnU8C`) is a different account and is **not** the one this market uses.

| Index | Type (Scope `OracleType`) | Source / parameters | Price at read | Age |
|---|---|---|---|---|
| **430** (ZEC price) | **`MostRecentOf` (28)** | sources **[407, 428]**, `maxDivergenceBps` **1,500**, `sourcesMaxAgeS` **7,200** | $1,157.125 | 30 s |
| 407 | `PythLazer` (29) | generic `4200083200…` (first u16 = 66; the Lazer feed-id mapping is not verified) | $1,157.125 | 30 s |
| 428 | `Chainlink` (26) | price-info slot `14CrXQzP5Ero3NvmW92uLSqgWDRqU2eEdKJTP8CMsuL` — **no account existed at that address at read**; TWAP enabled | $1,157.716 | 6 s |
| 429 (ZEC TWAP) | `ScopeTwap` (12) | over source 428 | $1,160.547 | 48 s |
| 13 (USDC price) | `CappedFloored` (33) | generic `0900010c0001bd00…` (source 9; cap/floor bytes not decoded) | $0.99988834 | 49 s |
| 456 (USDC TWAP) | type 48 — **not in scope-sdk 10.2.6's table** | | $0.99989476 | 49 s |

So the ZEC price Kamino liquidates against is the more recent of a Pyth Lazer and a Chainlink reading, refused if
they diverge by more than 15 % or if the fresher one is older than two hours, and the reserve additionally refuses a
price older than 180 s, a TWAP older than 240 s, a TWAP more than 10 % away, or a price outside $400–$2,000. Which
source wins when both are fresh, and what Scope does when only one passes, is **not verified** here.

## Bridged ZEC — the mint, its authority, and who mints

| Fact | Value |
|---|---|
| Mint | `A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS`, SPL Token, 8 decimals, initialised |
| Supply | 95,932.18 ZEC at 00:47 UTC → 95,933.18 at 00:57 UTC (minting is live) |
| **Mint authority** | `FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds` — **off-curve: a PDA, not a key.** Proven: `findProgramAddress(["authority"], dahPEoZG…CPxe)` = this address, bump 255 |
| Freeze authority | **none** |
| Who mints | the bridge token program `dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe` — observed `mintTo` 0.98807555 ZEC with that PDA as authority, tx `32LUBFhfuxgpNZJBTJhXKRXKzw6jbtFSKQSZ1ThueSRyvBURCWLcD2vJ5597zx5iLz6XHbrrGkVCGQLo9W7y9zdQ`, slot 446,297,457, 2026-09-12 00:51:05 UTC. Earlier transactions on the same PDA invoked the Wormhole core bridge alongside it |
| Metaplex metadata (PDA `5mRY96MiFac9DBToh16j5dgq6kiJCPqhPXPzpoNNtxmw`) | name **Zcash**, symbol **ZEC**, update authority = the same mint-authority PDA, **mutable**, uri `https://arweave.net/cEDMVkvUHsXSckakyWWCQlMnG-SlWlXyFEGnLqCamug` → `{"name":"Zcash","symbol":"ZEC","description":"","image":…}` |

**What this settles.** The direction memo's "mint authority is a key" is not what the chain says: the authority is a
PDA of an upgradeable program whose upgrade authority is itself a PDA. The token has no freeze authority (nobody
can freeze a holder's ZEC on Solana), but the program that mints it can be upgraded, so the supply is as sound as
that program's governance. This is the bridge operator in the trust path that `DIRECTION-2026-09-11.md` §4.1 says
the deposit flow must state.

USDC on Solana, for contrast: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, 6 dp, supply 8,095,154,548.94,
mint authority `BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG`, **freeze authority
`7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar`** — the issuer can freeze a USDC token account, including one an
Oilskin account PDA owns.

## Who is in the market (all 45 obligations under the ZCASH market, `dataSize` 3,344, decoded)

| Fact | Value |
|---|---|
| Obligations | 45; 36 carry USDC debt |
| ZEC deposited across them | 1,192.0355 (matches the reserve) |
| USDC debt across them (principal at each obligation's last refresh) | $442,341.84 (reserve: $442,516.97; the gap is interest accrued since) |
| **Largest borrower** `74VYE88JRBuQ9PmbyqWLgZqeL6Qfqjww7drc7te6uPBY` | **$259,911.91 = 58.8 % of all debt**, 612.15 ZEC deposited (≈ 36.7 % LTV at $1,157), last refreshed slot 445,404,219 |
| Top 5 / top 10 share of debt | 78.4 % / 88.8 % |

One obligation is most of this market. A liquidation of it alone would be a $260 K sale into the depth below.

## Liquidation depth — where a forced ZEC sale would land (read 2026-09-12 00:39–00:40 UTC)

Jupiter aggregator quotes, ZEC → USDC, exact-in, 50 bps slippage setting (`lite-api.jup.ag/swap/v1/quote`,
route context slot 446,295,162–170):

| Sell | Receive | Effective price | Price impact |
|---|---|---|---|
| 10 ZEC | 11,612.14 USDC | $1,161.21 | 0.028 % |
| 100 ZEC | 115,982.99 USDC | $1,159.83 | 0.130 % |
| **400 ZEC (≈ $462 K)** | 461,944.86 USDC | $1,154.86 | **0.556 %** |
| 1,000 ZEC (≈ $1.14 M) | 1,139,049.31 USDC | $1,139.05 | 1.930 % |

DexScreener (secondary source, same minute): **30 Solana pairs, $4,476,697 total liquidity**; the four that matter
are Orca ZEC/USDC `GTHKH8s82ZR8GTSFZ1dUu6wfdxhy59wpMShxzG5zjiPm` ($2.16 M, $13.75 M 24 h volume), Meteora ZEC/SOL
`8eybKAvjKJryVweQLg8SRgwUfdP7wHYJ5yyqgfE82DQA` ($1.04 M), Orca ZEC/SOL ($358 K) and Meteora ZEC/USDC ($356 K). The
memo's "~$4 M of ZEC liquidity across Solana DEXs; a $400 K liquidation is ~10 % of it" holds as a share; the
measured impact of that sale today is half a percent, well inside Kamino's 2–7 % liquidation bonus.

## Kamino's own disclosure wording (the floor for Oilskin's copy)

Read from kamino.com → Borrow → ZCASH Market → "What is Zcash?" tooltip, 2026-09-12 00:57 UTC, verbatim:

> ZEC is the native currency of Zcash, a payments blockchain supporting transparent and shielded transactions.
> Shielded transactions use zero-knowledge proofs to protect financial information. On Solana, ZEC is a bridged
> representation available through NEAR Intents. Holding or transferring it on Solana does not provide Zcash's
> shielded transaction privacy.

Its "Learn More" links to `https://z.cash/learn/what-is-zcash/`. The same page shows the market as **New**,
curated by **Allez Labs**, market size **$2.18 M**, borrow APY **3.43 %**. Kamino's documentation
(`kamino.com/docs`, the risk framework and the oracle pages) carries **no ZEC-specific wording**; its generic
framework sentence for a token like this is "elevated risk in one or more dimensions — perhaps limited oracle
coverage, a newer smart contract without extensive battle-testing, or thin market liquidity." Press coverage
(Crypto Briefing, 2026-09-07 launch) paraphrases Kamino and quotes nothing directly.

Oilskin's copy must say at least what the tooltip says, and additionally: that the mint is controlled by an
upgradeable bridge program; that Circle can freeze USDC; and that Kamino's market owner can change every parameter
above. None of the words in `web/lib/copy.ts` `BANNED_WORDS` may be used to describe any of it.

## What this settles for the build

- **Entry rule on Solana.** `maxOfferedLtvBps(6500)` from `packages/shared` = floor(6500 / 1.25) = 5200 →
  the 52 % stop (since 2026-09-12: floor 1.25, no product cap; under the earlier rule it was min(5000,
  floor(6500 / 1.55)) = 4193); **Kamino's own LTV cap is 40 %**, so the offer is min(shared rule, venue LTV) =
  **40 %** either way, entry HF = 65 / 40 = **1.625** (above the floor). Rungs of the floor's ladder (1.23 /
  1.16 / 1.09 / 1.05, what the Solana keeper runs until the program carries the entry HF) at 40 % LTV against
  LT 65 %: warn fires after a **24.3 %** ZEC drop, repay **28.6 %**, de-risk **32.9 %**, emergency **35.4 %**,
  liquidation **38.5 %** (`rungDropPct` / `liquidationDropPct`, shared; the old 1.55 table gave 7.7 / 16.9 /
  26.2 / 35.4 %).
- **The pool is small and lopsided.** $358 K borrowable; +$84 K of new borrowing prices Kamino above Base's Aave;
  one borrower is 59 % of the debt. The yield service's pool-size gate (`SOLANA-ARCHITECTURE.md` §7) reads
  these three numbers live and refuses to offer what the pool cannot fund below the threshold.
- **Protection must be ours.** Kamino's obligation orders are disabled on this market; a keeper with a
  scoped, revocable delegation is the only automated ladder a position can have.
- **Oracle facts to pin.** Scope index 430 = MostRecentOf(407 Pyth Lazer, 428 Chainlink), 15 % divergence,
  7,200 s source age, 180 s reserve age, $400–$2,000 band; TWAP 429 over Chainlink; USDC 13 / 456.

## Drift against `DIRECTION-2026-09-11.md` (read 2026-09-11) — one day later

| Memo | This read | Direction |
|---|---|---|
| 1,022 ZEC deposited | 1,192.04 ZEC | +17 % |
| USDC pool $802 K | $800,696 supplied | flat |
| $413 K left to borrow | $358,199 | −13 % (borrowed rose from ≈ $389 K to $442.5 K) |
| borrow 2.78 % APY | 3.378 % APR (3.43 % APY) | up |
| "+$200 K crosses Base's rate" | **+$84 K** (Base at 4.547 %) | earlier than the memo said |
| "+$413 K empties the pool" | +$358 K | earlier |
| "mint authority is a key" | **a PDA of the bridge program** | corrected |
| Base Aave USDC 4.51 % | 4.547 % | flat |
| "~$4 M DEX liquidity" | $4.48 M (DexScreener); 400 ZEC sells at 0.56 % impact (Jupiter) | confirmed, with a measurement |

## Not verified by this read (probe before use)

1. What controls the four upgrade-authority PDAs (Kamino lend, Scope, Farms, the bridge program): which multisig
   program, which signers, what threshold, any timelock.
2. The market owner `A11Ezn…zMeR`: key or PDA, and whether Allez Labs holds it.
3. Scope's `MostRecentOf` selection rule and single-source fallback; the Pyth Lazer feed-id → ZEC/USD mapping;
   how the `Chainlink` type obtains its report when its price-info slot names an account that does not exist.
4. klend `interestRateBasis` = 1 on the USDC reserve, and the exact `PriceStatusFlags` bit meanings.
5. The NEAR side of the bridge (OmniBridge signer set, MPC/TSS custody of the locked ZEC, withdrawal delay) and
   the role of `EtZMZM22…cdEX`.
6. Kamino's compute budget and account list for the CPI path an Oilskin PDA would take (`initObligation` with a
   PDA owner, `refreshReserve` → `refreshObligation` → `repayObligationLiquidityV2` in one transaction) — to be
   measured on the local validator, `SOLANA-ARCHITECTURE.md` §11.
7. Anything about Solana devnet: the ZCASH market exists on mainnet only; localnet with cloned accounts is the
   test surface.

## Addendum 1 (2026-09-12 20:10 UTC) · CCTP V2 — the Solana → Base USDC rail, probed live

Cowork's draft of this file (bundle `docs/handoff/2026-09-12-cowork/VERIFIED-SOLANA-FACTS.md`, rows dated slot
446,507,284 / Base block 51,225,715 / 19:19 UTC) carried the CCTP rows below. Every one was re-read here,
read-only, at a fresher slot and block; where the two reads differ the fresher value is kept and the draft's is
noted. CCTP = Circle's Cross-Chain Transfer Protocol; bp = basis point (0.01 %).

### Solana programs (`getMultipleAccounts`, `finalized`, slot **446,516,913**, `api.mainnet-beta.solana.com`)

| Program | Id | Probe |
|---|---|---|
| CCTP V2 TokenMessengerMinterV2 | `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` | executable; owner BPF upgradeable loader (36-byte program account → a live upgrade authority, not identified) |
| CCTP V2 MessageTransmitterV2 | `CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC` | executable; BPF upgradeable loader |
| Base–Solana bridge, Solana side (**not** this loop's rail — it mints a wrapped ERC-20, `CROSSCHAIN-LOOP-2026-09-12.md` §1) | `HNCne2FkVaNghhjKXapxJzPaBvAKDG1Ge3gqhZyfVWLM` | executable; BPF upgradeable loader |
| ZCASH market address-lookup table (the Kamino API's market entry) | `4X1udqAdw8912WyBUfUFnpkNTsiL2YSNRgXevWKowxu2` | exists; owner `AddressLookupTab1e…`; 728 bytes = 56-byte header + 21 addresses |

### Base contracts (`cast` against `base-rpc.publicnode.com`, block **51,227,239**, 2026-09-12 20:10 UTC)

| Contract | Address | Probe (a real selector answered) |
|---|---|---|
| TokenMessengerV2 | `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | code 2,175 bytes (a proxy); `localMessageTransmitter()` → `0x81D4…4B64`; `localMinter()` → `0xfd78…D002` |
| MessageTransmitterV2 | `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | code 2,175 bytes (a proxy); `localDomain()` → **6**; `version()` → **1** |
| TokenMinterV2 | `0xfd78EE919681417d192449715b2594ab58f5D002` | code 9,295 bytes; `localTokenMessenger()` → `0x28b5…cf5d`; `burnLimitsPerMessage(USDC 0x8335…2913)` → **10,000,000 USDC per message** |

The three answer with each other's addresses (messenger → transmitter and minter, minter → messenger), which is
the probe that they are one deployment and not three look-alikes. `localDomain()` reverts on TokenMessengerV2 —
that selector is not on it; the domain is read from the transmitter.

### Circle's fee and allowance API (`iris-api.circle.com`, 2026-09-12 20:10:38 UTC)

| Item | Value | Endpoint |
|---|---|---|
| Fast Transfer minimum fee, Solana (domain 5) → Base (domain 6) | **1 bp** (`finalityThreshold` 1000) | `/v2/burn/USDC/fees/5/6` |
| Standard fee, Solana → Base | 0 (`finalityThreshold` 2000) | same |
| Fast Transfer minimum fee, Base → Solana | **1.3 bp** | `/v2/burn/USDC/fees/6/5` |
| Standard fee, Base → Solana | 0 | same |
| Fast-burn allowance, one pool shared by every Fast route | **$53,140,871.26** at 2026-09-12T20:10:04Z (Cowork's read at 19:19:03Z: $52,510,328) | `/v2/fastBurn/USDC/allowance` |
| CCTP domain ids | Solana **5**, Base **6** | the fee-endpoint paths; `localDomain()` above |

The allowance moved by ≈ $630 K in 51 minutes. A busy day elsewhere can push a rung's transfer onto the Standard
path (source-chain finality, minutes); the keeper must handle both, and the cross-chain position class holds its
Solana-side reserve for exactly that reason (`CROSSCHAIN-LOOP-2026-09-12.md` §3, `BUILD-PLAN-2026-09-12.md` A5).

### Not verified by this addendum (probe before code depends on it)

1. Circle's published "~8 s" Fast Transfer time — measure one real transfer on Solana devnet ↔ Base Sepolia and
   record it here.
2. The `depositForBurn` account layout on Solana and the `mintRecipient` encoding of a Base `OilskinAccount`
   (bytes32, the 20-byte address left-padded) — decode from the program's own IDL, not from documentation.
3. The upgrade authorities of the two CCTP programs and the admins of the Base proxies.
4. Whether Base's `TokenMinterV2` maps Solana USDC (`EPjF…Dt1v`) as domain 5's remote token
   (`remoteTokensToLocalTokens`) — a read, not yet done.

## Addendum 2 (2026-09-13 02:42 UTC, slot 446,591,426) · klend byte offsets, the LendingMarket flags, Squads Protocol v4

Read live from `api.mainnet-beta.solana.com`; the offsets computed from klend-sdk 12.0.0's borsh layouts
(`Reserve.layout.offsetOf`, `ReserveConfig.layout().offsetOf`, …) and checked byte for byte against the
2026-09-12 capture (slot 446,506,191, `services/yield/test/fixtures/solana-mainnet-2026-09-12.json`, the same
bytes `agent/test/fixtures/solana/` holds) and the LendingMarket read here. `services/yield/src/sources/kamino.ts`
and `agent/src/solana/layouts.ts` decode at these offsets; both are pinned to the captures.

| `Reserve` (8,624 bytes; discriminator sha256("account:Reserve")[..8]) | Offset | Type |
|---|---|---|
| `lastUpdate.slot` / `.stale` / `.priceStatus` | 16 / 24 / 25 | u64 / u8 / u8 |
| `lendingMarket` | 32 | pubkey |
| `liquidity.mintPubkey` / `.totalAvailableAmount` / `.borrowedAmountSf` / `.marketPriceSf` / `.mintDecimals` | 128 / 224 / 232 / 248 / 272 | pubkey / u64 / u128 (2^60) / u128 / u64 |
| `collateral.mintTotalSupply` | 2,592 | u64 |
| `config.status` / `.loanToValuePct` / `.liquidationThresholdPct` | 4,856 / 4,872 / 4,873 | u8 |
| `config.borrowRateCurve` | 4,920 | 11 × { utilizationRateBps u32, borrowRateBps u32 } |
| `config.borrowFactorPct` / `.depositLimit` / `.borrowLimit` | 5,008 / 5,016 / 5,024 | u64 |
| `config.tokenInfo.name` / `.heuristic {lower, upper, exp}` / `.maxTwapDivergenceBps` / `.maxAgePriceSeconds` / `.maxAgeTwapSeconds` | 5,032 / 5,064 · 5,072 · 5,080 / 5,088 / 5,096 / 5,104 | [u8;32] / u64 ×3 / u64 / u64 / u64 |
| `config.tokenInfo.scopeConfiguration {priceFeed, priceChain[4], twapChain[4]}` | 5,112 / 5,144 / 5,152 | pubkey / u16 ×4 / u16 ×4 (65535 = unused) |
| `config.depositWithdrawalCap` / `.debtWithdrawalCap` — `{configCapacity i64, currentTotal i64, lastIntervalStartTimestamp u64, configIntervalLengthSeconds u64}` | 5,416 / 5,448 | 32 bytes each |
| `config.utilizationLimitBlockBorrowingAbovePct` / `.borrowLimitOutsideElevationGroup` | 5,501 / 5,504 | u8 / u64 |

| `LendingMarket` (4,664 bytes; discriminator `f6 72 32 62 48 9d 1c 78`) | Offset |
|---|---|
| `lendingMarketOwner` | 24 |
| `emergencyMode` / `autodeleverageEnabled` / `borrowDisabled` | 122 / 123 / 124 |

Scope `OraclePrices` (28,712 bytes): entry *i* at 40 + 56·*i* — `price.value u64`, `price.exp u64`,
`lastUpdatedSlot u64`, `unixTimestamp u64`.

**Values at the 2026-09-12 capture (slot 446,506,191), decoded by SDK and by offset alike:** USDC available
355,599.950997, borrowed 446,186.304801 (`borrowedAmountSf` 514417785866375382064880048244), utilisation
55.65 %, curve APR **3.4199 %**; debt-withdrawal cap current total 3,622.993258 USDC in the window; ZEC supplied
1,202.60719100, deposit-withdrawal cap current total **−111.01606145 ZEC**; heuristics ZEC `4000 / 20000 / exp 1`
($400–$2,000) and USDC `98 / 102 / exp 2` ($0.98–$1.02); max TWAP divergence 1,000 / 300 bps; Scope chains
[430, 65535…] / [13, 65535…], TWAP [429…] / [456…]. **LendingMarket at slot 446,591,426:** owner
`A11EznxnJM3JrjUvAq16wqoVyPRNz522mdQm6mSmzMeR`, `emergencyMode` 0, `autodeleverageEnabled` 0, `borrowDisabled` 0.

**What the negative counter settles.** klend's `deposit_withdrawal_cap` accumulates **withdrawals** of
deposits per interval and deposits subtract from it (hence −111 ZEC after a day of net deposits);
`debt_withdrawal_cap` accumulates **borrows** and repayments subtract. Deposits are bounded by `depositLimit`
alone; borrows by `borrowLimit` and the 1,000,000 USDC / 86,400 s cap; withdrawals by the 3,000 ZEC / 86,400 s
cap. The earlier reading of the 3,000 ZEC cap as a deposit cap (SOLANA-ARCHITECTURE.md §7, first draft) was
wrong and is corrected there.

**Squads Protocol v4 (the multisig the program's upgrade authority goes to, §12 (2)).** Program
`SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu`: `executable`, owner the BPF upgradeable loader; its
`ProgramData` `Q1xCTDDfdfB4jk2Wicw1HdutFVdRik5LMKYMcZdT2rU`, last deploy slot 178,977,035, **upgrade authority
NONE — the program is immutable.** Read 2026-09-13 02:42 UTC. What it settles: the multisig program itself cannot
be changed under a vault that holds our upgrade authority. Not read here: the multisig and vault PDA seeds;
the hand-over script (`solana/scripts/authority.mjs`) checks a vault by its owner program on chain, not by
re-deriving seeds.

## Addendum 3 (2026-09-13 03:11–03:16 UTC) · CCTP V2 — the instruction surface on both chains, for the burn code

Addendum 1 probed that the CCTP V2 contracts and programs exist and know each other. Before `deposit_for_burn`
(Solana, BUILD-PLAN B3) and `closeLpAndBurn` (Base, A5) could be written, this read settled the exact call shapes,
the accounts each side needs, and the message format the Base mock must reproduce. Every value below was read
here; nothing is typed from memory. CCTP = Circle's Cross-Chain Transfer Protocol; PDA = program-derived
address; ABI = application binary interface.

### Base — the implementations behind the proxies (`cast` against `base-rpc.publicnode.com`, block **51,239,874**, 03:11:36 UTC; Blockscout verified-source names)

| Proxy (Addendum 1) | Implementation (EIP-1967 slot `0x3608…bbc`, read live) | Verified name | Code |
|---|---|---|---|
| TokenMessengerV2 `0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d` | `0x555E272506C06e7E559d57418563742AFE363ec8` | `TokenMessengerV2` (proxy: `AdminUpgradableProxy`) | 14,890 bytes |
| MessageTransmitterV2 `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64` | `0x7Db629f6Acc20Be49a0A7565c21CC178E9Ac21e3` | `MessageTransmitterV2` (proxy: `AdminUpgradableProxy`) | 16,882 bytes |

**TokenMessengerV2 ABI (verified source, Blockscout `get_contract_abi` on the implementation).** The two entry
points the router can call, with selectors computed by `cast sig`:

| Function | Selector |
|---|---|
| `depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)` | `0x8e0250ee` |
| `depositForBurnWithHook(…same seven…, bytes hookData)` | `0x779b432d` |

Event: `DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient,
uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee,
uint32 indexed minFinalityThreshold, bytes hookData)`. Views that matter: `messageBodyVersion()` → **1**;
`remoteTokenMessengers(5)` → `0xa65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e93893`, which is
exactly the Solana TokenMessengerMinterV2 program id `CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe` base58-decoded
(so a Base burn addressed to domain 5 is delivered to that program); `isDenylisted(address)` exists — **Circle
holds a denylist on the messenger** (`isDenylisted(0x0)` → false; a denylisted account cannot burn, and the
keeper's simulation would surface that revert); `feeRecipient()` → `0xBEA3621Ef88850E062cF4baCCaD72877E2c3e4Eb`;
`localMinter()` → `0xfd78…D002` (Addendum 1).

**MessageTransmitterV2 ABI.** `receiveMessage(bytes message, bytes attestation) returns (bool success)`,
selector `0x57ecfd28` — anyone may call it; the mint lands at the message's `mintRecipient`, so the receiving
Base account signs nothing. `sendMessage(uint32,bytes32,bytes32,uint32,bytes)` (what the messenger calls).
Events `MessageSent(bytes message)` and `MessageReceived(address indexed caller, uint32 sourceDomain, bytes32
indexed nonce, bytes32 sender, uint32 indexed finalityThresholdExecuted, bytes messageBody)`; `usedNonces(bytes32)`.
State at block **51,239,965** (03:14:37 UTC): `paused()` false; `signatureThreshold()` **2**;
`getNumEnabledAttesters()` **2**; `maxMessageBodySize()` 8,192; `localDomain()` 6; `version()` 1.

**TokenMinterV2 `0xfd78EE919681417d192449715b2594ab58f5D002`:** `getLocalToken(5, Solana USDC mint as bytes32
0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61)` → **`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`**,
Base's native USDC — the chain's own statement that the Solana → Base route mints the token every Base pool uses
(the correction in `CROSSCHAIN-LOOP-2026-09-12.md` §1, now verified rather than argued). `burnLimitsPerMessage(USDC)`
10,000,000 USDC, unchanged.

### The V2 message format (Circle's technical guide, `developers.circle.com/cctp/technical-guide`, read 2026-09-13)

The Base mock (`contracts/test/mocks/MockCctpV2.sol`) reproduces this byte for byte; the keeper's Stream C
reads the same fields off `MessageSent`. Header, 148 bytes: `version u32 @0` (1) · `sourceDomain u32 @4` ·
`destinationDomain u32 @8` · `nonce bytes32 @12` · `sender bytes32 @44` · `recipient bytes32 @76` ·
`destinationCaller bytes32 @108` (zero = anyone may deliver) · `minFinalityThreshold u32 @140` ·
`finalityThresholdExecuted u32 @144` · `messageBody @148`. BurnMessageV2 body, 228 bytes + hook data:
`version u32 @0` (1) · `burnToken bytes32 @4` · `mintRecipient bytes32 @36` · `amount uint256 @68` ·
`messageSender bytes32 @100` · `maxFee uint256 @132` · `feeExecuted uint256 @164` · `expirationBlock uint256 @196`
· `hookData @228`. Finality thresholds: **1000 = Fast Transfer**, **2000 = Standard** (source-chain finality).
Address encoding as `bytes32`: an EVM address is left-padded with 12 zero bytes; a Solana `mintRecipient` is the
**token account** (the recipient's USDC associated token account), not the wallet or PDA that owns it.

### Solana — TokenMessengerMinterV2's `deposit_for_burn` (Circle's source, `github.com/circlefin/solana-cctp-contracts` master, `programs/v2/token-messenger-minter-v2/src/token_messenger_v2/instructions/deposit_for_burn.rs`, read 2026-09-13)

`DepositForBurnParams { amount: u64, destination_domain: u32, mint_recipient: Pubkey, destination_caller: Pubkey,
max_fee: u64, min_finality_threshold: u32 }` (`Pubkey::default()` as `destination_caller` = anyone may deliver).
Accounts, in order: `owner` (**signer; the burn token account's owner — `has_one = owner`**, so the burn
authority is the token account's owner and nothing else: for Oilskin that is the Account PDA, signing by
`invoke_signed`), `event_rent_payer` (signer, mut), `sender_authority_pda` (`["sender_authority"]`),
`burn_token_account` (mut), `denylist_account` (`["denylist_account", owner]` — absent unless Circle denylisted
that owner), `message_transmitter` (mut), `token_messenger`, `remote_token_messenger` (its `domain` must equal
`destination_domain`), `token_minter`, `local_token` (mut, `["local_token", mint]`), `burn_token_mint` (mut — a
real burn, the supply falls), `message_sent_event_data` (**signer, mut — a fresh keypair per burn; the message
bytes are written into it, rent from `event_rent_payer`**), `message_transmitter_program`,
`token_messenger_minter_program`, `token_program`, `system_program`, then the Anchor `#[event_cpi]` pair
(`event_authority` `["__event_authority"]` of the messenger program, and the program itself). The instruction
CPIs `message_transmitter_v2::send_message` with `event_rent_payer`, `sender_authority_pda`,
`message_transmitter`, `message_sent_event_data`, the sender program and `system_program`.

**The PDAs, derived with those seeds and read at slot 446,596,935 (03:11:53 UTC) and 446,597,419 (03:14:24 UTC),
`api.mainnet-beta.solana.com`, `finalized`:**

| Account | Seeds (program) | Address | Read |
|---|---|---|---|
| `token_messenger` | `["token_messenger"]` (TokenMessengerMinterV2) | `AawthJCGRmggpfv9MMWV6Jmo9cue4gL9wUZgRBShg58W` | exists, owner the messenger program, 177 bytes |
| `token_minter` | `["token_minter"]` | `E1bQJ8eMMn3zmeSewW3HQ8zmJr7KR75JonbwAtWx2bux` | exists, 74 bytes |
| `local_token` (USDC) | `["local_token", USDC mint]` | `CRBBbuLCyrkQy4dCTHxqstSmDQv4ajBeUVb9qUdMVaP1` | exists, 130 bytes; `mint` = `EPjF…Dt1v`; **`burn_limit_per_message` 10,000,000 USDC** (the same cap as Base's); `messages_sent` 393,207, `messages_received` 272,705 at the slot |
| `remote_token_messenger` (Base) | `["remote_token_messenger", "6"]` | `BwmDYtQ7jFj8ddaTmKa7fz9hyuK9n58mvc8G7DYNcKjM` | exists, 44 bytes; `domain` **6**, `token_messenger` = Base's `0x28b5…cf5d` left-padded — the two sides name each other |
| `sender_authority` | `["sender_authority"]` | `45hzrGLQ2EGo1Ln7QpXjDwb589GDQ9H2aEXXw6ds6BFE` | no account (a signing PDA; expected) |
| `denylist_account` (probe) | `["denylist_account", zero pubkey]` | `CJPnLYncUgWDCwAeNvM5oGzP96NBjmHerSc9Zzhaa571` | absent — the state of every owner Circle has not denylisted |
| `message_transmitter` | `["message_transmitter"]` (MessageTransmitterV2) | `W1k5ijkaSTo5iA5zChNpfzcy796fLhkBxfmJuR8W8HU` | exists, 225 bytes; `paused` 0, `local_domain` **5**, `version` 1, `signature_threshold` 2, 2 attesters, `max_message_body_size` 8,192 — the same attestation policy as Base's transmitter |

Custody token account named by `local_token`: `6xTBTqJMBr5m7BKqVxmW2x11DfqUwtD3TJsqpxELx72L` (not used by a burn).

**USDC's mint authority on Solana (slot 446,597,739):** `BJE5MMbqXjVwjAF7oxwPYXnTXDyspzZyt4vwenNw5ruG` is an SPL
Token **multisig, 2 of 4** (signers `42XHrxUX5skic589HER817BWiJ5xvhJurrFVKjYCPwnb`,
`BwdZnHHaC7Ho7xAAirLqWVLa9m7iWMkUN7PiZknActzy`, `Cf4s35LcAf9YC7wpdXTSxFg3i3GrvSYMavCVVefw3jd`,
`HvhFE75zWkXvL7gAyjvatQcNrPA99ttFEz78kAgPF31v`); freeze authority `7dGbd2QZcCKcTndnHcTL8q7SMVXAkp688NTQYwrRCrar`.
None of the four is the V1 (`DBD8hAwLDRQkTsu6EqviaYNGKPnsAMmQonxf7AH8ZcFY`) or V2 (`E1bQ…2bux`) `token_minter`
PDA, so **how CCTP mints USDC on Solana is not settled by this read** — it does not matter for the burn (a burn
needs only the token account's owner), it matters for Stream C's receive path on localnet, which will mock the
mint rather than clone Circle's authority.

### What this settles for the build

1. The Base router's burn is one `approve(USDC → TokenMessengerV2, amount)` and one `depositForBurn(amount, 5,
   recipientTokenAccount, USDC, 0, maxFee, threshold)` executed AS the account; the mint on the other side needs
   no signature from the recipient. Both are bounded by the keeper grant's USDC budget.
2. The Solana program's burn is one CPI with the Account PDA as `owner`; the client supplies a fresh
   `message_sent_event_data` keypair and pays its rent; `mint_recipient` is the Base `OilskinAccount` left-padded.
3. `maxFee` / `max_fee` and the finality threshold are inputs the caller reads from Circle's API at send time
   (Addendum 1: Fast 1 bp Solana→Base, 1.3 bp Base→Solana, Standard 0); the contracts and the program carry no
   fee number of their own.

### Not verified by this addendum (probe before code depends on it)

1. The Anchor discriminator of `deposit_for_burn` (`sha256("global:deposit_for_burn")[..8]`) and the
   `#[event_cpi]` account pair — pinned by the localnet run against the cloned program, not by this read.
2. `feeExecuted` at delivery against `maxFee` — the keeper's Stream C measures one real transfer on devnet ↔
   Sepolia (Addendum 1's open item 1 stands).
3. The four multisig signers' identities.

### Addendum 3, follow-up (2026-09-13, localnet against the cloned programs) — the three open items, two settled

1. **The discriminator and the `#[event_cpi]` pair — settled.** `sha256("global:deposit_for_burn")[..8]` =
   `[215, 60, 61, 46, 114, 55, 128, 176]`, with the event authority `["__event_authority"]` of the messenger program
   and the program itself appended last: the cloned TokenMessengerMinterV2 accepted the instruction as
   `solana/programs/oilskin/src/cctp.rs` builds it (`tests/crosschain.spec.ts`, 2026-09-13). Two facts the run added:
   the account list (Kamino's refresh context plus Circle's) is **1,422 bytes as a legacy transaction, over the 1,232
   limit** — the burn rides a v0 transaction with an address lookup table (which itself has to be extended in chunks
   of ≈ 12 addresses); and Circle's `MessageSent` account is `8-byte discriminator + rent_payer (32) + created_at (8)
   + message (Vec<u8>)`, its body's `messageSender` being the **burn token account's owner** — the Account PDA — not
   the wallet that signed.
2. `feeExecuted` against `maxFee` at delivery — still open (Stream C, devnet ↔ Sepolia).
3. The multisig signers — still open.

## Addendum 4 (2026-09-13 14:41–14:45 UTC) · CCTP V2 — the RECEIVE side on Solana and Circle's attestation service

Addendum 3 settled the burn. This one settles what happens to the message afterwards, for Stream C: the
accounts `receive_message` needs on Solana, and the shape of Circle's attestation answer read against a real
transfer. CCTP = Circle's Cross-Chain Transfer Protocol; PDA = program-derived address; ATA = associated token
account.

### The receive-side accounts (seeds from Circle's source; derived and read, `finalized`, slot **446,728,203**)

`MessageTransmitterV2.receive_message(message, attestation)` takes: `payer` (signer, mut), `caller` (signer),
`authority_pda`, `message_transmitter`, `used_nonce` (**init** — `["used_nonce", the message's 32-byte nonce]`),
`receiver` (executable, not the transmitter itself), `system_program`, the Anchor `#[event_cpi]` pair, then the
receiver's own accounts as **remaining accounts**. It verifies the attestation, records the nonce, and CPIs into
the receiver — `handle_receive_finalized_message` when `finalityThresholdExecuted ≥ 2000`, the *unfinalized*
handler below it.

| Account | Seeds (program) | Address | Read |
|---|---|---|---|
| `authority_pda` | `["message_transmitter_authority", TokenMessengerMinterV2]` (MessageTransmitterV2), bump 255 | `DsAdX23SVpTPYhKP2ua1mx8gTPqLyzx7a43cyxYjS2up` | no account — a signing PDA (expected) |
| `token_pair` (Base USDC) | `["token_pair", "6", Base USDC as bytes32]` (TMM), bump 251 | `3udrkuozTYGBVMyMdxmXWVTUrnpmSh7kEZiq67A8jTws` | 77 bytes; `remote_domain` **6**, `remote_token` `0x…833589fc…2913`, `local_token` = the USDC local token of Addendum 3 |
| `custody_token_account` | `["custody", USDC mint]` (TMM), bump 255 | `6xTBTqJMBr5m7BKqVxmW2x11DfqUwtD3TJsqpxELx72L` | an SPL **token account** (165 bytes) holding **50,130,046.985279 USDC** |
| `fee_recipient_token_account` | ATA(`token_messenger.fee_recipient`, USDC) | `6zNSMmZGMhNyqZMHkx2L63DLuqh5qoqBhaQJPJD7Fvt3` | exists, 165 bytes, balance 0 at the read |
| MessageTransmitterV2 `__event_authority` | `["__event_authority"]` | `2PcXTomVAbX5Es1NUZUkxwuCm8tvV4NmRk3fmQWFCWoV` | signing PDA |
| TokenMessengerMinterV2 `__event_authority` | `["__event_authority"]` | `6TCCnJ9R1m1RXFzyoH7GYH2J6NJDtZaUvfipPuLWxHNd` | signing PDA |

**`token_messenger` decoded** (the 177-byte account of Addendum 3): `message_body_version` **1**,
`authority_bump` **254**, `min_fee` **0**, `denylister` `7dT4WrwkfZXrgP7dxt6oDpiL3fNEGRwciY8o2pCTrYkm`, `owner`
`4GiscJFQXMibpSXDRK8YFpX5SGXLVjWGJBCB9Ls7FZEs`, `fee_recipient` `4BPnUzFDibVcWQ5zzixGodRUHwqDxHYpUPdPYus3Bn56`,
`min_fee_controller` `5UzrTqTFDELUqbB2UNVhtTJCKarivMrkQxJoDeJ48yyv`.

**What the custody account settles.** CCTP does **not** mint USDC on Solana on delivery — it pays out of a
custody token account it already holds, so the 2-of-4 mint multisig of Addendum 3 is irrelevant to a receive.
A localnet delivery therefore needs the custody account cloned and funded, not a mint authority.

**`message_transmitter` attesters** (same account, decoded): `signature_threshold` **2**, enabled attesters
`0x725b06f73ff761ef5390e39315e2bfbf60d33f96` and `0x52ed4cbff8dce6a19748043f3240ec03c834bcef` — 20-byte
Ethereum addresses stored right-aligned in a 32-byte field. Circle's program recovers each signature with
`secp256k1_recover` over the message hash and requires the recovered signers to be **strictly ascending**.

### Circle's attestation service, read against a real transfer (2026-09-13 14:45 UTC)

`GET https://iris-api.circle.com/v2/messages/{sourceDomain}?transactionHash=…` (or `?nonce=…`); the sandbox is
`https://iris-api-sandbox.circle.com`. Read for Base burn
`0xa9cb69894a97d99530c1274e8d8c7e7b148fc1b0e8b57a7ba267f5ed4ac32737` (block 51,260,534), recorded verbatim in
`docs/research/cctp-attestation-a9cb6989.json`.

Answer: `{ messages: [ { attestation, message, eventNonce, cctpVersion, status, decodedMessage, delayReason } ],
sourceTxHash }`. On that transfer: `status` **"complete"**, `cctpVersion` **2**, the attestation **130 bytes =
2 × 65** (the threshold), the message **464 bytes** (148 header + 228 body + 88 of hook data), `maxFee` 1,557
and **`feeExecuted` 1,298** — the first live observation that the executed fee lands below the burn's bound
(Addendum 3's open item 2). Numeric fields come back as **strings**.

**The finding that shapes the code: `decodedMessage` is null-filled for a non-EVM destination.** That transfer
went to domain 27, and Circle returned `recipient`, `destinationCaller` and `decodedMessageBody.mintRecipient`
as **`null`** while the raw `message` carried them perfectly. A Solana-bound burn (domain 5) is non-EVM the same
way. So the keeper decodes the raw bytes with `packages/shared` `decodeCctpBurnMessageV2` and matches nonce,
recipient, amount and domain itself (`parseAttestationResponse`); Circle's decoded fields are never trusted. Our
decoder reproduces Circle's own numbers on that message exactly — nonce, both domains, amount and fee all agree.

### Not verified by this addendum

1. A delivery actually executed (no Solana-bound Oilskin burn exists yet); the localnet spec mocks the
   transmitter because an attestation needs Circle's attester keys.
2. Circle's Fast Transfer wall-clock time (Addendum 1's open item stands).
