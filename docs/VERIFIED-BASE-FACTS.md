# Verified Base mainnet facts for the Base module (first read 2026-09-05 ~01:00 UTC; top ledger re-read 2026-09-13 at block 51,241,497, 04:05:41 UTC; chain id 8453)

Method: `eth_getCode` / `eth_call` against public Base RPCs from a networked sandbox, selectors computed with
`cast sig`. **Every address below has been confirmed to hold code and to answer the calls stated.** Anything not
listed here is unverified and must be probed before code depends on it — this is the rule that would have caught
the C-2 mainnet-bricking bug (see `AUDIT-FINDINGS-2026-09-03.md`).

**Re-read 2026-09-13 (`scripts/refresh-demo-snapshot.mjs`).** Every number in this top section was read again, read-only, at one
pinned block — **51,241,497** (timestamp 1,789,272,341 = 2026-09-13T04:05:41Z), the block the 2026-09-13 yield sample was
taken at (`services/yield/samples/gauge-emissions-2026-09-13.json`) — with `cast call --block 51241497` (`scripts/ledger-read.sh`) against
`https://mainnet.base.org`, so the demo's market snapshot (`web/lib/demo.ts` `DEMO_MARKET`, the prototypes' `OIL_CHAIN_READ`), its
yield model and its forecast are one read. The 2026-09-12 figures (block 51,226,072) stay in the last column of each table as the drift.
Raw words: `docs/research/ledger-read-51241497.json`; the 2026-09-12 read's are in Addendum 14.

## Tokens (all verified: `symbol()`, `decimals()`, `totalSupply()`)

| Token | Address | Decimals | Total supply (2026-09-13, block 51,241,497) | Total supply (2026-09-12) | Notes |
|---|---|---|---|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | 4,276,493,282.04 | 4,279,450,714.61 | native Circle USDC |
| WETH | `0x4200000000000000000000000000000000000006` | 18 | 238,692.78 | 237,550.57 | OP-stack predeploy |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 | 45,846.25 | 45,881.88 | plain ERC-20 (code len 3,102) |
| **cbZEC** | `0xB2000000000000000000008501b13360000cb2EC` | 8 | **1,360.59** | 1,311.87 | **B20 precompile: `eth_getCode` returns `0xef`.** `name()` = "Coinbase Wrapped ZEC". `multiplier()` = 1e18 (rebase multiplier present, still 1.0). `owner()` and `paused()` revert (not exposed). |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | 18 | 1,978,450,301.48 | 1,978,450,301.48 | |

## Aave v3 on Base (verified via PoolAddressesProvider → `getPool()` / `getPoolDataProvider()` / `getPriceOracle()`)

- PoolAddressesProvider `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D`
- **Pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`**
- PoolDataProvider `0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A` (EIP-55 casing corrected 2026-09-05; the first print of this file had a non-checksum casing of the same hex, which viem's `getAddress` rejects — `packages/shared/src/base.ts` pins this form)
- AaveOracle `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156`

Reserve configuration (`getReserveConfigurationData`, bps) and rates (`getReserveData`, ray → %) at block 51,241,497
(2026-09-13T04:05:41Z); the last column is the 2026-09-12 read:

| Reserve | LTV | Liq. threshold | Liq. bonus | Collateral | Borrowable | Variable borrow APR | Supply APR | 2026-09-12 (borrow / supply) |
|---|---|---|---|---|---|---|---|---|
| cbBTC | 73.00% | **78.00%** | 7.5% | yes | yes | 0.6742% | 0.0117% | 0.6716% / 0.0115% |
| WETH | 80.00% | **83.00%** | 5.0% | yes | yes | 2.4008% | 1.7638% | 2.3861% / 1.7422% |
| USDC | 75.00% | **78.00%** | 5.0% | yes | yes | **4.5143%** | 3.5122% | 4.5174% / 3.5169% |
| cbZEC | — | — | — | **NOT LISTED** (the config call reverted at this read; it returned zeros on 2026-09-05) | | | | |

The rates are the ray words truncated at 1e-4 % exactly as the yield service's `rayToPct` does (integer division,
`services/yield/src/sources/aave.ts`), so the model, the demo and this table carry the same digits; the ray words
themselves, the reserves' `lastUpdateTimestamp` and the `getPaused` reads (false on all three) are in
`docs/research/ledger-read-51241497.json`.

Product implication: borrowing USDC against cbBTC at Aave costs **4.51%** today (4.5143 %; 4.52 % on 2026-09-12); the
liquidation threshold that drives our health-factor ladder is **0.78 for cbBTC and 0.83 for WETH** (per-asset, read from
chain, never a constant).

## Chainlink price feeds on Base (verified `description()` + `latestRoundData()`)

| Feed | Address | Answer at block 51,241,497 (2026-09-13) | Age at that block | 2026-09-12 answer (age) |
|---|---|---|---|---|
| BTC / USD | `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` | 77,186.69 | 454 s | 77,165.17 (226 s) |
| ETH / USD | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | 2,520.58 | 550 s | 2,520.38 (798 s) |
| USDC / USD | `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B` | 1.00 | 55,458 s (heartbeat-driven; raw answer 0.99986476) | 1.00 (24,608 s) |
| cbBTC / USD | `0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D` | 77,173.30 | 346 s | 77,140.83 (234 s) |

Aave's own sources: cbBTC → `0x3a932b286715abc4a86a4acaf68a6cdd89e0d446`, WETH → `0x9da00d23465282005db222a441a663ee7b9dfcc8`,
USDC → `0xf52d010c7d4ecbfda92c2509900593ce34535d86` (these are Aave's adapters, not the raw feeds).
~~**There is no Chainlink ZEC/USD feed on Base.**~~ **Superseded 2026-09-13 (Addendum 16): a
Chainlink `ZEC / USD` proxy IS live on Base at `0x69e5BC4988a9AF30Ec827C5609c0D41028446ec0` — 18
decimals (not 8), a `DualAggregator 1.0.0` behind it, same owner as the four feeds above. It prices
ZEC, not cbZEC.**

## Pyth on Base (verified)

- Pyth contract `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`
- `Crypto.ZEC/USD` price id `0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24`
- `getPriceUnsafe` at block 51,241,497 (2026-09-13): **$1,035.20 ± 0.16** (103,519,851,737 × 1e−8, conf 15,630,582),
  expo −8, `publishTime` 1,788,550,194 = 2026-09-04T19:29:54Z — **722,147 s (8.4 days) old at that block**, the same posted update the 2026-09-12 read saw (then 691,297 s / 192.0 h old): nobody has posted a ZEC/USD update on Base since, and the pool below has moved 9.7 % away from it. Pyth is
  pull-based: the on-chain price is only as fresh as the last update anyone posted. **Any oracle adapter must pull
  a fresh update (Hermes) inside the same transaction and enforce a max age, or it is pricing stale data.**

## Aerodrome (verified)

- Voter `0x16613524e02ad97eDfeF371bC883F2F5d6C480A5`
- **cbZEC/USDC Slipstream pool `0x0Fc47C17AF86078d809358db1b4db2DeBC988566`** (EIP-1167 clone, code len 92):
  token0 = USDC, token1 = cbZEC, fee 2000 (0.2%), tickSpacing 200. At block 51,241,497 (2026-09-13) slot0 tick −24,298 →
  **≈ 1,136 USDC per cbZEC** (100 × 1.0001^24,298 = 1,135.52; the pool is 9.7 % above Pyth's 8.4-day-old $1,035.20), active
  liquidity L = 161,874,864,892. On 2026-09-12: tick −24,205 → ≈ 1,125 USDC per cbZEC, L = 23,138,875,907,679. The depth here is a few ticks wide: the position holding most of it goes
  out of range when the price crosses a spacing boundary (seen an hour after the 2026-09-12 read, Addendum 14).
- **Gauge for that pool: `0x8779e34e5d38358b0cb957c553b40cc1208c81fb` — `rewardRate()` 7,140,520,125,989,201 wei/s
  (≈ 616.9 AERO/day), `periodFinish()` 1,789,603,200 (2026-09-17T00:00:00Z) at block 51,241,497.** On 2026-09-12: `rewardRate()` 7,140,520,125,989,201 wei/s (≈ 616.9 AERO/day), `periodFinish()` 1,789,603,200.
  The first emissions vote landed in the epoch that began 2026-09-10 (Addendum 8, 0.083 % of the Voter's weight).
- The MaxFi/Snuggle engine facts (index-getter `userPositions(address,uint256)`, replace-on-rekey, total-span
  widths, `slot0()` on CL pools) are in `AUDIT-FINDINGS-2026-09-03.md` Part 1 and still hold.

## Other infrastructure (code presence verified)

- Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` — present (15,623 bytes of code at block 51,241,497; the first print counted the
  31,248 hex characters of `eth_getCode`). Market listing via the
  public GraphQL API failed on schema field names three times on 2026-09-05; the working query (`marketId`, not
  `uniqueKey`/`id`; `OracleFeed` has `address` only) and both chain-verified ids are in the Morpho addendum
  below. No cbZEC market exists (consistent with the research).
- Compound v3 USDC Comet `0xb125E6687d4313864e53df431d5425969c15Eb2F` — present; `baseToken()` = USDC;
  utilization **90.69 %** at block 51,241,497 (90.5253 % on 2026-09-12; above the kink → borrow rate elevated; read the
  live rate before quoting it).
- Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` — present (9,152 bytes).
- CoW Protocol GPv2Settlement `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` — present (16,165 bytes).

## What this settles for the build

1. **v1 collateral = cbBTC and WETH on Aave v3**, with per-asset liquidation thresholds read from chain.
2. **cbZEC collateral is v1.1**: no market anywhere, no Chainlink feed, Pyth stale by default, ~$0.7M DEX depth.
3. **cbZEC LP had no emissions at the 2026-09-05 read** — it has some since the epoch of 2026-09-10 (Addendum 8;
   ≈ 616.9 AERO/day at the 2026-09-12 re-read), one
   vote's worth, re-voted weekly; the engine lists no cbZEC pool and the verified SwapRouter cannot reach the
   pool, so nothing in the product can earn them (`docs/CBZEC-PATH-2026-09.md`).
4. **Every contract path that touches cbZEC must survive a token whose `multiplier()` can change** (never cache
   balances; re-read after every external call).
5. Price feeds for v1 are Chainlink (cbBTC, ETH, USDC); the Pyth adapter with in-tx pull + max-age is v1.1.

## Not verified by this read (probe before use — `AUDIT-SCOPE.md` "Not verified")

> **Two of these were probed on 2026-09-06 and the Morpho ids on 2026-09-07 — see the Addenda below.** The
> Aerodrome Slipstream SwapRouter, Multicall3 and both Morpho market ids are now verified; the rest stands.

- **Aerodrome Slipstream SwapRouter** — address not read; `contracts/script/Deploy.s.sol` requires it from `AERODROME_SWAP_ROUTER` and refuses mainnet without it; `exactInputSingle` shape unprobed.
- **Multicall3** `0xcA11bde05977b3631167028862bE2a173976CA11` — not read; the web uses viem's `base` chain definition with a per-call fallback; the keeper does one `eth_call` per read.
- **Morpho Blue market ids** for cbBTC/USDC and WETH/USDC — ~~not discovered~~ **discovered and chain-verified 2026-09-07, re-read the same day at block 51,003,524 (see the Morpho addendum below)**; `MorphoBlueVenue` is built over them and re-derives each id from `idToMarketParams` at construction.
- **CoW GPv2VaultRelayer** — not read; the web reads `settlement.vaultRelayer()` at runtime.
- ~~**The engine's live end-of-list revert shape** for `userPositions(address,uint256)`~~ — **recorded 2026-09-10 at block 51,127,409 (Addendum 3): empty `0x`, at index 0 and at the canary index 2^256 − 1.** It is not `Panic(0x32)`, which is what `SnuggleLpVenue.positionsOf` pinned until slice A (2026-09-10) redesigned it for the measured shape — Addendum 4 and `RISKS.md` §12.
- **cbZEC B20 policy state** (blocklist, pause) — `owner()` / `paused()` revert on the precompile; only `multiplier()` was read (1e18).
- ~~**Gauge emissions** for the curated pools other than cbZEC/USDC — the yield model's inputs are the 2026-08-31 words (block 50675328), not this read.~~ **Read live 2026-09-12 at block 51,226,072 (Addendum 12) — the same block as this top ledger.**

## Addendum — probed 2026-09-06 (the "Not verified" items from the first pass)

| Contract | Address | Evidence |
|---|---|---|
| **Aerodrome Slipstream SwapRouter** | `0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5` | code present (19,818 B); `factory()` = `0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a`; `WETH9()` = the canonical WETH predeploy |
| Slipstream NonfungiblePositionManager | `0x827922686190790b37229fd06084350E74485b72` | code present (49,086 B); `factory()` = the SAME `0x5e7b…09a`, which is what confirms both belong to one Slipstream deployment |
| Slipstream CLFactory | `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A` | derived from both `factory()` reads above |
| Aerodrome v2 Router (non-CL) | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` | code present (47,164 B); not used by v1 |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | code present (7,618 B); `getCurrentBlockTimestamp()` answers |

**Negative result worth recording:** `0x6Cb442acF35158D5eDa88fe602Ef9Cf89694fFEa`, which circulates as an
Aerodrome "UniversalRouter", returns **`0x` — no code on Base**. Do not use it.

Still unverified and still gated: the CoW vault relayer, and cbZEC's B20 policy state (`owner()`/`paused()`
revert; only `multiplier()` reads — still 1e18 on 2026-09-10). The live engine's out-of-range revert *shape*
was measured on 2026-09-10 (Addendum 3): empty `0x`.

## Addendum — Morpho Blue markets on Base, read 2026-09-07 (block 50,977,561)

Discovered through the Morpho GraphQL API (`api.morpho.org/graphql`, filter `chainId_in:[8453]`,
`collateralAssetAddress_in:[cbBTC, WETH]`, `loanAssetAddress_in:[USDC]` — 50 markets returned, only two
`listed: true`), then **every field re-read from the chain**: `Morpho.idToMarketParams(id)`,
`Morpho.market(id)`, `oracle.price()`, and the oracle's feed getters. Each id was recomputed as
`keccak256(abi.encode(loanToken, collateralToken, oracle, irm, lltv))` and matched.

| | cbBTC / USDC | WETH / USDC |
|---|---|---|
| **Market id** | `0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836` | `0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda` |
| id recomputed from params | matches | matches |
| loanToken | USDC `0x8335…2913` | USDC `0x8335…2913` |
| collateralToken | cbBTC `0xcbB7…33Bf` | WETH `0x4200…0006` |
| LLTV (liquidation loan-to-value) | **86.0 %** (`860000000000000000`) | **86.0 %** |
| IRM (interest-rate model) | `0x46415998764C29aB2a25CbeA6254146D50D22687` | same |
| IRM `MORPHO()` | `0xBBBB…FFCb` (points back at Morpho Blue — it is the AdaptiveCurve IRM wired to this deployment) | same |
| Oracle | `0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9` | `0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4` |
| Oracle base feed 1 | Chainlink **BTC / USD** `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` (`description()` read = "BTC / USD" — NOT the cbBTC/USD feed) | Chainlink ETH / USD `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` |
| Oracle quote feed 1 | none (USDC taken as exactly $1) | Chainlink USDC / USD `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B` |
| Oracle `price()` (collateral in loan units) | 79,891.55 USDC per cbBTC | 2,502.04 USDC per WETH |
| totalSupplyAssets | 1,545,004,599.67 USDC | 89,379,967.23 USDC |
| totalBorrowAssets | 1,387,104,508.01 USDC | 80,086,694.94 USDC |
| Utilisation | 89.78 % | 89.60 % |
| Available liquidity (supply − borrow) | ≈ 157.9 M USDC | ≈ 9.29 M USDC |
| Borrow APY (API, same read) | 4.783 % | 4.787 % |
| Market fee | 0 | (not read) |
| Supplying MetaMorpho vaults (API) | 13 | 13 |
| Morpho Blue `owner()` | `0xcBa28b38103307Ec8dA98377ffF9816C164f9AFa` | same |

**What this settles.** (1) Both v1 collaterals have a deep, listed Morpho market at the same 86 % LLTV, so
`MorphoBlueVenue` can be enabled against real ids — no market creation, no seeding. (2) Morpho's borrow rate
(4.78 %) is within 5 bps of Aave's (4.828 % on 2026-09-05); the gate's "nothing clears" conclusion is
unchanged by switching venue. (3) The cbBTC market prices cbBTC with the **BTC/USD** feed, i.e. it assumes
cbBTC = BTC exactly; a cbBTC depeg is invisible to that oracle until liquidations already happened. Aave
uses the cbBTC/USD feed. Record this in `docs/RISKS.md` when the venue is enabled. (4) Both markets sit at
the IRM's 90 % utilisation target; the WETH market has only ≈ 9.3 M USDC free, so a large Oilskin borrow
there moves the rate — the venue must read `market()` before quoting.

Not read here: the two oracles' `SCALE_FACTOR()` were read (`0x52b7d2dcc80cd2e4000000` and
`0xd3c21bcecceda1000000`) but not re-derived; per-vault caps.

### Second read, 2026-09-07 15:53 UTC (block 51,003,524 → 51,003,550), before `MorphoBlueVenue` was built

Same discovery path: `api.morpho.org/graphql` `markets(where: {chainId_in:[8453], loanAssetAddress_in:[USDC],
collateralAssetAddress_in:[cbBTC, WETH]})` → 50 markets, the same two `listed: true`, the other 48 unlisted
with ≤ $900 supplied. Then every field re-read with `cast call` against `https://mainnet.base.org`, and each
id recomputed with `cast keccak (cast abi-encode ...)`. Nothing that governs the venue has changed since the
first read; the balances moved as expected for two hours of a live market.

| | cbBTC / USDC | WETH / USDC |
|---|---|---|
| `idToMarketParams(id)` | loan USDC, collateral cbBTC, oracle `0x663B…39B9`, IRM `0x4641…2687`, LLTV `860000000000000000` — **unchanged** | loan USDC, collateral WETH, oracle `0xFEa2…aFE4`, IRM `0x4641…2687`, LLTV `860000000000000000` — **unchanged** |
| id recomputed (`cast keccak`) | `0x9103…1836` matches | `0x8793…1bda` matches |
| `market()` totalSupplyAssets | 1,548,362,695.17 USDC | 89,293,293.39 USDC |
| `market()` totalBorrowAssets | 1,388,245,988.86 USDC | 80,286,890.23 USDC |
| `market()` totalSupplyShares / totalBorrowShares | 1.4019e21 / 1.2413e21 | 8.0131e19 / 7.0987e19 |
| `market()` lastUpdate / fee | 1788796387 (15:53:07 UTC) / 0 | 1788796255 (15:50:55 UTC) / 0 |
| Utilisation | 89.66 % | 89.91 % |
| Available liquidity | ≈ 160.1 M USDC | ≈ 9.0 M USDC |
| Oracle `price()` (1e36-scaled, loan per collateral) | `788119156674200000000000000000000000000` → **78,811.92 USDC per cbBTC** | `2473641698316604294897102882` → **2,473.64 USDC per WETH** |
| IRM `borrowRateView(params, market)` (per-second, WAD) | `1479443146` → 4.666 % APR simple, ≈ 4.776 % APY | `1486379142` → 4.687 % APR simple, ≈ 4.799 % APY |
| API `borrowApy` / `supplyApy` (same minute) | 4.776 % / 4.272 % | 4.799 % / 4.305 % |
| API `creationBlockNumber` | 19,326,981 | 15,504,029 |
| Morpho `isLltvEnabled(0.86e18)` / `isIrmEnabled(IRM)` | true / true | same |
| Morpho `owner()` / `feeRecipient()` | `0xcBa28b38103307Ec8dA98377ffF9816C164f9AFa` / `0x0000…0000` | same |
| IRM `MORPHO()` | `0xBBBB…FFCb` | same |

**What the venue was built on, and how it uses these numbers.** `MorphoBlueVenue` takes the two ids at
construction and reads `idToMarketParams` for each, refusing an id Morpho has no market for, an id whose
params do not hash back to it, an id that lends anything but USDC, or two ids for one collateral. The LLTV
is read from `idToMarketParams` on every call (`liquidationThresholdBps` = `maxLtvBps` = lltv / 1e14 =
**8600**; Morpho has one threshold). Debt is computed the way Morpho's `_accrueInterest` computes it
(`MorphoMath.expectedBorrowTotals`, third-order Taylor on `borrowRateView`), so a full repay approves
exactly what Morpho pulls. The registry's derived offer was min(8600 / 1.55 = 5548, 8600, cap 5000) =
**50 %** under the rule of the day, the same as on Aave (since 2026-09-12 the floor is 1.25 and there is no
cap: min(8600 / 1.25 = 6880, 8600) = **68.8 %**). The oracle for the cbBTC market is Chainlink **BTC/USD** with no quote feed
(USDC taken as $1); the WETH market's is Chainlink ETH/USD over USDC/USD. Both are the oracles already on the
markets; the venue does not choose an oracle and uses no Pyth feed. `docs/RISKS.md` §8 carries the
cbBTC = BTC assumption.

**Deploy shape.** `Deploy.s.sol` builds the venue over these two ids (`MORPHO_MARKET_IDS`, defaulting to the
constants) and leaves the registry pointing cbBTC and WETH at `AaveV3Venue`. Moving an asset to Morpho is
`proposeVenue` → 2-day `TIMELOCK_DELAY` → `acceptVenue` by the registry owner; the venue refuses a supply for
an asset the registry has not moved to it. On Base Sepolia no cbBTC/WETH–USDC market is known (the Morpho
API does not index chain 84532), so the venue deploys with no markets and reports `enabled() == false`.

## Addendum — Base Sepolia (chain id 84532), read 2026-09-07 (block 46,488,145)

Purpose: what exists on the testnet for `contracts/script/Deploy.s.sol`. Addresses were taken from primary
sources (BGD Labs' `aave-address-book` `AaveV3BaseSepolia.sol`, Chainlink's reference-data directory for
`ethereum-testnet-sepolia-base-1`, Pyth's EVM contract-address page) and then **confirmed on chain**; the
Aave data provider and oracle were derived from the pool's own `ADDRESSES_PROVIDER()` rather than typed.

### Aave v3 (exists; parameters differ from mainnet)

| Contract | Address | Evidence |
|---|---|---|
| Pool | `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27` | code 3,708 B; `provider.getPool()` returns it |
| PoolAddressesProvider | `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00` | `pool.ADDRESSES_PROVIDER()` |
| PoolDataProvider | `0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b` | `provider.getPoolDataProvider()` |
| AaveOracle | `0x943b0dE18d4abf4eF02A85912F8fc07684C141dF` | `provider.getPriceOracle()`; matches the address book |

| Reserve | Token | dec | LTV | LT | bonus | collateral | borrowable | variable borrow rate | oracle price |
|---|---|---|---|---|---|---|---|---|---|
| WETH | `0x4200000000000000000000000000000000000006` | 18 | **8350** | **8500** | 10300 | yes | yes | 23.08 % | $2,504.68 |
| USDC (Aave test token, NOT Circle) | `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` | 6 | 8250 | 8600 | 10500 | yes | yes | 2.96 % | $0.99989 |
| WBTC (test token) | `0x54114591963CF60EF3aA63bEfD6eC263D98145a4` | 8 | 8150 | 8300 | 10500 | yes | **no** | 0 | $79,927.26 |

Mainnet comparison: WETH is 8000/8300 on mainnet, 8350/8500 here; there is no cbBTC reserve on Sepolia
(WBTC is the nearest stand-in and cannot be borrowed, which is fine — we only supply it). Because
`AaveV3Venue` and `CollateralRegistry` read LT/LTV live, the Sepolia registry will offer
`min(5000, floor(8500/1.55)) = 5000` bps for WETH and `min(5000, floor(8300/1.55)) = 5000` for WBTC under the
rule of the day — same top rung as mainnet; since 2026-09-12 (floor 1.25, no cap) that is `min(floor(8500/1.25) = 6800,
venue LTV)` and `min(floor(8300/1.25) = 6640, venue LTV)`. The Sepolia USDC borrow rate (2.96 %) is a test-pool artefact; never quote it.

### Price feeds

| Feed | Address | Latest | Age at read | Heartbeat (RDD) |
|---|---|---|---|---|
| Chainlink BTC / USD | `0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298` | 79,927.26 | 897 s | 1,200 s |
| Chainlink ETH / USD | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | 2,504.68 | 613 s | 1,200 s |
| Chainlink USDC / USD | `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165` | 0.99989 | 43,191 s | 86,400 s |
| Pyth (proxy) | `0xA2aa501b19aff244D90cc15a4Cf739D2725B5729` | ZEC/USD `getPriceUnsafe` = 770.62 | **984,543 s (11.4 days)** | pull-based |

The Sepolia Chainlink heartbeats (1,200 s for BTC and ETH) are NOT the mainnet cadences; the keeper's
per-feed staleness must come from each aggregator, never from a constant. Pyth on Sepolia has nobody
pushing ZEC/USD; the in-tx refresh path in `PythOracleAdapter` is the only way it will ever be fresh there.

### Present at the same address as mainnet

| Contract | Address | Code |
|---|---|---|
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | 15,623 B; `owner()` = `0x937Ce2d6c488b361825D2DB5e8A70e26d48afEd5` (a different owner from mainnet). The Morpho API does **not** index chain 84532, so any Sepolia market must be created by us (permissionless) and discovered from `CreateMarket` logs. |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9,152 B |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | 3,808 B |

### Absent on Base Sepolia (code = `0x` at the mainnet address)

Aerodrome Slipstream CLFactory, SwapRouter, NonfungiblePositionManager, Voter; the MaxFi/Snuggle engine
`0x7D27…Fd55`; cbZEC, cbBTC, and Circle USDC at their mainnet addresses. Aerodrome publishes no Base Sepolia
deployment. **Consequence for the testnet plan:** `SnuggleLpVenue` and `AerodromeSwapAdapter` cannot be
exercised on Sepolia against the real engine. **Done in `contracts/script/DeploySepolia.s.sol`**
(2026-09-07): stand-ins behind the same interfaces so the account → factory → registry → `AaveV3Venue`
→ router path runs end to end; see Addendum 2 below for the substitute table and `docs/DEPLOY-SEPOLIA.md`
for the runbook. The LP venue's real-engine behaviour is the job of the 8 mainnet fork tests
when `FORK_URL` is set; first run 2026-09-10 at block 51,127,409, Addendum 3 (`RISKS.md` §11–§12).


## Addendum 2 — Base Sepolia deploy dependencies, re-read 2026-09-07 15:11–15:15 UTC (block 46,512,825)

Purpose: close out every address `contracts/script/Deploy.s.sol` needs before a Base Sepolia
deployment, and record the two things the first Sepolia read did not cover — **how test collateral
is obtained** and **what the substitutes must be priced at**. Method as before: `cast code` /
`cast call` against `https://sepolia.base.org`, nothing typed from a website without a matching
on-chain read.

### Aave v3 wiring re-confirmed (unchanged from the 2026-09-07 09:xx read)

`provider.getPool()` → `0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27`,
`provider.getPoolDataProvider()` → `0xBc9f5b7E248451CdD7cA54e717a2BFe1F32b566b`,
`provider.getPriceOracle()` → `0x943b0dE18d4abf4eF02A85912F8fc07684C141dF`, and the round trip
`pool.ADDRESSES_PROVIDER()` → `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00`. Code sizes: provider
6,697 B, pool 1,853 B, data provider 7,435 B, oracle 2,662 B.

`getAllReservesTokens()` lists **six** reserves: USDC, USDT, WBTC, WETH, cbETH, LINK. The three the
deploy touches, read live at this block:

| Reserve | LTV | LT | Bonus | Reserve factor | Collateral | Borrowable | Active / frozen | Oracle price | Variable borrow rate |
|---|---|---|---|---|---|---|---|---|---|
| WETH `0x4200…0006` | 8350 | 8500 | 10300 | 1000 | yes | yes | active / not frozen | $2,483.389 | 23.09 % |
| USDC `0xba50…4D5f` | 8250 | 8600 | 10500 | 1000 | yes | yes | active / not frozen | $0.99988 | 2.954 % |
| WBTC `0x5411…45a4` | 8150 | 8300 | 10500 | 1000 | yes | **no** | active / not frozen | $79,092.017 | 0 |

Oracle sources are the Chainlink feeds directly (`getSourceOfAsset`): WETH → ETH/USD
`0x4aDC…7cb1`, USDC → USDC/USD `0xd30e…5165`, WBTC → BTC/USD `0x0FB9…4298`. All three feeds answer
`description()` ("ETH / USD", "USDC / USD", "BTC / USD") with `decimals()` = 8. Ages at read: ETH
456 s, BTC 480 s, USDC 6,180 s.

### How test collateral is obtained (new — this is what makes a Sepolia run possible)

The Aave test USDC and WBTC both answer `owner()` = **`0xD9145b5F45Ad4519c7ACcD6E0A4A82e83bB8A6Dc`**,
which is Aave's faucet (code 9,129 B, `owner()` = `0x956DE559DFc27678FD69d4f49f485196b50BDD0F`).

- **`isPermissioned()` = `false`** — anyone may mint. No allow-list, no key from Aave.
- `mint(address token, address to, uint256 amount)` returns `amount`; confirmed by `eth_call` for
  both tokens.
- **Per-call mint cap, measured by bisection with `eth_call`:** USDC `1_000_000e6` succeeds and
  `10_000_000e6` reverts `"Mint limit transaction exceeded"`; WBTC `1e8` (1 WBTC) succeeds and
  `10e8` reverts. `maxMintAmount()` is not exposed (reverts), so the cap is recorded as measured,
  not as a constant read.

WETH is the OP-stack predeploy: obtained by `deposit()`ing Sepolia ETH, not from the faucet.

### Pyth

`getValidTimePeriod()` = **60 s**. `getPriceUnsafe(Crypto.ZEC/USD)` = **770.62190497 ± 0.83912218**,
expo −8, publishTime 2026-08-26 16:01:32 UTC — **1,033,934 s (12.0 days) stale at read**. Nobody
pushes ZEC/USD on Sepolia. Unchanged conclusion: only `PythOracleAdapter`'s in-transaction refresh
can ever make that price usable, and the adapter is not deployed by default.

### Circle's own Base Sepolia USDC exists but is NOT usable here

`0x036CbD53842c5426634e7929541eC2318f3dCF7e` holds code (1,798 B), `symbol()` = "USDC",
`decimals()` = 6. It is **not an Aave reserve on this chain**, so it cannot be borrowed. The deploy
therefore uses Aave's own test USDC `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f` as the borrow
asset, and that address — not Circle's — is what `StrategyRouter.USDC()` will return on Sepolia.

### Absent, re-confirmed at this block (`eth_getCode` = `0x`)

Aerodrome Slipstream SwapRouter `0xBE6D…18a5`, NonfungiblePositionManager `0x8279…5b72`, CLFactory
`0x5e7B…809A`, Voter `0x1661…80A5`; the MaxFi/Snuggle engine `0x7D27…Fd55`; cbZEC `0xB200…b2EC`,
cbBTC `0xcbB7…33Bf`, Circle mainnet USDC `0x8335…2913`, AERO `0x9401…8631`. Present at their
mainnet addresses: Permit2 (9,152 B, `DOMAIN_SEPARATOR()` =
`0x010f27a92fb9a32622f44f001dc4d15706a85b33499cfc2ce9033113ab26592c`), Multicall3 (3,808 B), Morpho
Blue (15,623 B).

### The one mainnet number the Sepolia substitutes are priced from

Read on **Base mainnet** at block 51,002,395 (2026-09-07 15:15 UTC), cbZEC/USDC Slipstream pool
`0x0Fc47C17AF86078d809358db1b4db2DeBC988566`:

| Field | Value |
|---|---|
| `slot0().sqrtPriceX96` | 23,265,100,781,736,967,362,825,324,275 |
| `slot0().tick` | **−24,509** |
| `tickSpacing()` / `fee()` | 200 / 2000 |

Derived at that tick (token0 = USDC 6 dp, token1 = cbZEC 8 dp): **≈ 1,159.71 USDC per cbZEC**, up
from ≈ 1,020.30 at tick −23,228 on 2026-09-05. **The tick moved 1,281 ticks (≈ +13.7 %) in two
days** — which is exactly why `script/DeploySepolia.s.sol` bakes the tick as one overridable
constant (`CBZEC_USDC_TICK`, env `CBZEC_USDC_TICK`) and derives the mock pool price, its TWAP tick
and both mock swap rates from that single number, rather than typing a price anywhere.

### Substitutes used on Base Sepolia, and why each is honest

`SnuggleLpVenue` and `AerodromeSwapAdapter` have no real counterparty on this chain, so
`contracts/script/DeploySepolia.s.sol` deploys stand-ins **behind the same interfaces the mainnet
contracts are already compiled against** — the Oilskin contracts themselves are deployed by the
unchanged `Deploy.deploy()`, in the order the audit reviewed.

| Missing | Substitute | Fidelity |
|---|---|---|
| cbZEC | `MockB20` | 8 dp, live `multiplier()`, blocklist, pause — the B20 semantics from the mainnet read |
| cbBTC | Aave's **real** test WBTC reserve | a genuine Aave reserve; supply-only (not borrowable), which is how cbBTC is used anyway |
| AERO | `MockERC20` (18 dp) | reward token only; nothing emits it on Sepolia (the mainnet cbZEC gauge read `rewardRate() = 0` when this was written; it has a vote since 2026-09-10, Addendum 8) |
| Slipstream cbZEC/USDC pool | `MockCLPool` at tick −24,509 | verified token order (USDC = token0), spacing 200, fee 2000, `slot0()` + `observe()` |
| MaxFi/Snuggle engine | `MockSnuggleVault` | the chain-verified semantics (index getter that reverts past the end, replace-on-rekey, single-sided mint, 60 s hold) |
| Slipstream SwapRouter | `MockAerodromeSwapRouter` | priced from the same tick, zero fee (the real router charges 0.2 %, so the mock is only ever generous), funded with mock cbZEC and faucet USDC |

**What this does and does not prove.** It exercises wallet → factory → account → registry →
`AaveV3Venue` → borrow → `StrategyRouter` end to end against **real** Aave, real Permit2 and real
Chainlink. It proves nothing about the live engine or the live Slipstream router; that stays the
job of the 8 mainnet fork tests. The mocks keep their public test switches (`setPaused`,
`setGlitch`, `setMultiplier`, …), which **anyone on the testnet can call** — acceptable for a
testnet the founder alone exercises, and one more reason none of these addresses may ever be
referenced by a mainnet artefact.

## Addendum 3 — Base mainnet fork suite, first run, 2026-09-10 (block 51,127,409)

Purpose: run `contracts/test/fork/BaseFork.t.sol` against Base mainnet for the first time from this
tree, record what the chain answered, and reconcile this file with it. Method: Foundry 1.8.1 on the
founder's Mac, `FORK_URL=https://mainnet.base.org` (public RPC, no key), `forge test --match-path
test/fork/BaseFork.t.sol -vvv`, 12:42:43–12:43:02 UTC, every test forked at **block 51,127,409**
(chain id 8453); the Aave flow was re-run pinned with `FORK_BLOCK=51127409` after the one assertion
edit below. Every number here that the suite did not print was read with `cast call` / raw
`eth_call` against the same RPC between 12:42 and 12:58 UTC (blocks 51,127,412 → ≈ 51,127,9xx).
Nothing was signed or broadcast; `contracts/.env` was not written. The founder's own run on
2026-09-07 at block 51,001,138 produced the same 4 passes and the same 4 failures.

### Scorecard (4 passed / 4 failed / 0 skipped)

| Test | 2026-09-10 @ 51,127,409 | 2026-09-07 @ 51,001,138 | What the chain said |
|---|---|---|---|
| `test_fork_aaveProviderResolvesToVerifiedAddresses` | **PASS** | pass | `getPool` / `getPoolDataProvider` / `getPriceOracle` still resolve to the addresses in the Aave section above |
| `test_fork_reserveParamsAreLiveAndListed` | **PASS** | pass | cbBTC LT / LTV **7800 / 7300**, WETH **8300 / 8000** (unchanged since 2026-09-05); USDC variable borrow rate `46325731791087027683310557` ray = **4.633 % APR** (was 4.828 %); cbZEC LT = 0 (still not listed) |
| `test_fork_cbzecUsdcPoolSlot0` | **PASS** | pass | token0 USDC, token1 cbZEC, tickSpacing 200; `sqrtPriceX96` = `22706376861671914261124686885`, tick **−24,995** → **≈ 1,217.49 USDC per cbZEC** (−24,509 / ≈ 1,159.74 on 2026-09-07 15:15 UTC; −23,228 / ≈ 1,020.30 on 2026-09-05); `liquidity()` = `21992736132521` (was 15,382,171,343,960 on 2026-09-05) |
| `test_fork_permit2Present` | **PASS** | pass | Permit2, Morpho Blue and Pyth all hold code |
| `test_fork_cbzecIsAB20WithLiveMultiplier` | **FAIL** — `EvmError: Revert`; the first external call, `cbZEC.decimals()`, dies with `OpcodeNotFound` | fail (same) | **A fork EVM cannot execute the B20 native contract.** `eth_getCode` returns the single byte `0xef`, which Base's node routes to a native implementation and which revm treats as an invalid opcode. Not chain drift: read live with `cast` at ≈ block 51,127,412 — `decimals()` 8, `symbol()` "cbZEC", `name()` "Coinbase Wrapped ZEC", `multiplier()` `0x…0de0b6b3a7640000` = **1e18 (unchanged)**, `totalSupply()` `110768465960` = **1,107.68 cbZEC** (603.25 on 2026-09-05). This test can only ever pass outside a fork; the harness limitation is recorded in `TESTING.md`. **2026-09-12 (slice I): the test is retired; the same four assertions are `scripts/check-cbzec-b20.sh`, run with `cast` by the CI fork job at the suite's pinned block — OK at block 51,222,568, `multiplier()` still 1e18** |
| `test_fork_engineIndexGetterShape` | **FAIL** — `EnumerationFailed(0x)` from `SnuggleLpVenue.positionsOf` | fail (same) | The three shape assertions passed: `userPositions(address)` (`0x613cf420`) reverts, `userPositions(fresh, 0)` reverts, `poolIdsCount()` = **214**. **The live end-of-list revert is EMPTY — `0x`, zero bytes of data** — at index 0 and at the venue's canary index 2^256 − 1, through the proxy and at the unchanged implementation `0x359F90EE4c2e21Cbf6e32c5a062Eeef306822D28` (EIP-1967 slot re-read). A raw `eth_call` at "latest" returns `{"code":3,"message":"execution reverted"}` with no `data` field for both indices. It is not `Panic(0x32)`, which `positionsOf` pins, so the venue's enumeration fails closed against the live engine for **every** account. See `RISKS.md` §12 for what that means; no constant was changed |
| `test_fork_lpOpenCloseOnLiveEngine` | **FAIL** — custom error `0xd6234725` = `NotImplemented()` | fail (same) | The test's "first active WETH/USDC pool" is engine index 0, poolId `0x0ab2ff805defbd1a92e572facf1308c26e6365fcd8af3270a492f482ac0e65e2` → pool `0xd0b53D9277642d899DF5C87A3966A349A798F224`, which is the **Uniswap v3** WETH/USDC pool (`factory()` = `0x33128a8fC17869897dcE68Ed026d694621f6FDfD`, `fee()` 500, `tickSpacing()` 10), registered with an engine fee field of **9999** and position adapter `0xCCBfBA207D424c4711708c260Eba9C87f02cCED2` (3,697 B). Inside `depositSingleSided` the engine's library `0xf84b575E4E6D9fc07a3F2B863Cb6A23CC11DCDDc` calls `adapter.getTWAPTick(pool, 300)`, which reverts `NotImplemented()`; reproduced live with `cast call` → "execution reverted: NotImplemented". The open never reached the mint, so nothing about our venue was proved or disproved; the test's pool selection is what landed here (details below) |
| `test_fork_supplyBorrowRepayWithdrawUnderTheAccount` | **FAIL** — first `assertion failed: 99999999 != 100000000` at the collateral read; after the ±1 tolerance, `ERC20: transfer amount exceeds balance` inside `Pool.repay` | fail (`99999999 != 100000000`) | **Aave rounding dust, both directions.** Supply of 1e8 cbBTC → aToken `mint` scaled `99797385` at liquidityIndex `1002030255356308190911377929`, `Transfer` amount **99,999,999**; `PoolDataProvider.getUserReserveData(cbBTC, acct)` → currentATokenBalance **99,999,999**. Borrow of 10,000 USDC landed (balance `10000000000`), HF `6023489203404262689` wad = 6.02; `debt()` = **10,000,000,001** in the same block. `AaveV3Venue.repay(USDC, max)` approved 10,000,000,001 and Aave's `repay` pulled 10,000,000,001 from an account holding 10,000,000,000 → `ERC20: transfer amount exceeds balance`. The test fixture funds exactly the borrow; that fixture, and the `withdraw`/allowance assertions after it, were not reached and were left as written |

**What was changed in the test, and only that.** `assertEq(collateral, 1e8)` → `assertApproxEqAbs(collateral, 1e8, 1)` with the call and block quoted in the comment. No venue, router, keeper or web code was touched to make any test green; the three remaining failures are recorded here and in `RISKS.md`, not patched.

### The engine's registry, enumerated (`poolIdsCount()` = 214, read at "latest" 12:44–12:58 UTC)

All 214 `poolIds(i)` and their `approvedPools(id)` tuples were read with `cast call` (the full table is not reproduced; the rows that matter to the product are). **All 214** entries are flagged `active`. Four position adapters appear: `0xca4cF963C71234a4F7D44a750B4D3847B4deBabd` (55 entries), `0x0AedeEd5Ad8d45D3D928Fb872161EFaA559794D1` (63), `0xCCBfBA207D424c4711708c260Eba9C87f02cCED2` (81), `0xaD35ec92507566FC19581ab43a8EC9C6Edbf0a71` (15).

- **Eighty-one of the 214 entries name the same Uniswap v3 pool `0xd0b5…F224` under eighty-one different token pairs** (indices 0–16, 67–113 and eighteen more between 157 and 211: WETH/USDC, USDC/cbBTC, WETH/cbBTC, …), every one flagged active, with fee field 9999 and the `0xCCBf…CED2` adapter whose `getTWAPTick` reverts `NotImplemented()`. `depositSingleSided` into any of them reverts. Our `SnuggleLpVenue.poolTokens(poolId)` repeats whatever `approvedPools` says, so a user-typed id from this set would get the engine's `NotImplemented()` bubbled unchanged.
- The WETH/USDC entries that can mint: index 17 (`0x12fc2fd0…`, the same Uniswap v3 pool, fee 500, adapter `0xca4c…`), index 18 (`0x022308ba…`, Uniswap v3 `0x6c561B44…` fee 3000 / spacing 60, adapter `0xca4c…`), **index 24 (`0x0ea72f44…`, Aerodrome Slipstream CL100 `0xb2cc224c…`, adapter `0x0Aed…94D1`, reward adapter `0xBB8ea00a…`)**, index 28 (`0x4e58a13c…`, `0x72AB388E…` spacing 1, adapter `0xaD35…`, reward adapter `0x346CB3db…`). The Aerodrome cbBTC/USDC CL100 pool `0x4e962BB3…` is index 25 (`0xb1830be2…`, adapter `0x0Aed…`).
- **All twelve curated `enginePoolId`s in `packages/shared/src/pools.ts` are present in the registry** (indices 17, 18, 20, 22, 24, 25, 26, 27, 41, 62, 114, 179) **and every one points at a minting adapter** — `0xca4c…` for the four Uniswap v3 entries, `0x0Aed…94D1` (with the `0xBB8e…375a` reward adapter on the gauged ones) for the eight Aerodrome entries — none at the eighty-one stubs.
- **No entry of the 214 names cbZEC as token0 or token1.** The engine does not list the cbZEC/USDC pool `0x0Fc4…8566` at all, so cbZEC LP through the engine is not possible today regardless of the gauge (which still has no emissions vote, section "Aerodrome" above).

The fork test picks the first *active* entry whose tokens are WETH and USDC — index 0 — and so proves nothing about the Aerodrome path the product ships. Tightening that selection (to an entry whose pool's `factory()` is the Slipstream CLFactory, or whose adapter answers `getTWAPTick`) is a test-logic change and was not made in this pass; the proposal is in `TESTING.md`.

### One more thing the probes turned up: two Slipstream factories

The cbZEC/USDC pool `0x0Fc47C17AF86078d809358db1b4db2DeBC988566` answers `factory()` = **`0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`** (10,473 B of code; `voter()` = the Aerodrome Voter `0x1661…80A5`; `poolImplementation()` = `0xc770898522D2A9c8Da7A10D63989b6b58305B665`; `getPool(USDC, cbZEC, 200)` = the pool). The CLFactory this file derived on 2026-09-06, `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A`, answers `getPool(USDC, cbZEC, 200)` = **`0x0`**, while the Slipstream SwapRouter `0xBE6D…18a5` and the WETH/USDC CL100 pool `0xb2cc…DC59` both still report `factory()` = `0x5e7B…809A`. `Voter.gauges(pool)` = `0x8779E34E5d38358B0cB957c553B40cC1208C81FB`, `isGauge` = true — the gauge linkage in the Aerodrome section above holds. So the cbZEC/USDC pool was created by a second CL factory that shares the Voter, not by the one the SwapRouter is bound to. **Unverified consequence, gated:** a Slipstream router derives pool addresses from *its* factory, so whether `0xBE6D…18a5` can route USDC ↔ cbZEC at tickSpacing 200 through this pool is not known and must be probed before `AerodromeSwapAdapter` is pointed at that pair. Added to the "Not verified" list in spirit; nothing in code depends on it today (v1 swaps are WETH ↔ USDC).

### Drift summary against the earlier reads in this file

| Fact | Earlier read | 2026-09-10 | Drifted? |
|---|---|---|---|
| Aave provider → pool / data provider / oracle | 2026-09-05 | same | no |
| cbBTC / WETH LT & LTV | 7800/7300, 8300/8000 | same | no |
| USDC variable borrow APR | 4.828 % (09-05) | 4.633 % | rate, as expected |
| cbZEC `multiplier()` | 1e18 | 1e18 | no |
| cbZEC `totalSupply()` | 603.25 (09-05) | 1,107.68 | supply grew |
| cbZEC/USDC tick / price | −24,509 / ≈ 1,159.74 (09-07) | −24,995 / ≈ 1,217.49 | price moved |
| Engine implementation | `0x359f…2d28` (09-03) | same | no |
| Engine end-of-list revert shape | never recorded | empty `0x` | **first measurement; contradicted the venue's `Panic(0x32)` pin — redesigned in slice A, Addendum 4** |
| Engine `poolIdsCount()` | not recorded | 214 | first measurement |
| Engine WETH/USDC entry the test lands on | assumed mintable | stub adapter, `NotImplemented()` | **first measurement** |
| Aave aToken / debt rounding | not recorded | −1 / +1 unit | **first measurement** |
| cbZEC/USDC pool `factory()` | assumed `0x5e7B…809A` | `0xf8f2…61Ef` | **first measurement; SwapRouter routing to this pool unverified** |

## Addendum 4 — slice A, 2026-09-10: the engine's index getter, measured for the redesign

Purpose: give `SnuggleLpVenue.positionsOf` the numbers its redesign depends on (`RISKS.md` §12
"Design"). Method: the fork test `test_fork_engineIndexGetterShape`, re-run pinned at **block
51,127,409** (Foundry 1.8.1, `FORK_URL=https://mainnet.base.org`, `FORK_BLOCK=51127409`,
2026-09-10), meters each probe under the venue's own 200,000-gas stipend; `cast` reads against the
same RPC at **block 51,143,322** (2026-09-10, later the same day); and the implementation's verified
source on Blockscout. Nothing was signed or broadcast; `contracts/.env` was not written.

### The implementation, as verified (Blockscout, read 2026-09-10)

- Proxy `0x7D27…Fd55`: EIP-1967 implementation slot → `0x359f90ee4c2e21cbf6e32c5a062eeef306822d28`
  (unchanged since 2026-09-03); admin slot → `0x7885d796eeb6862dc798afa69dce8a0b25f486cb`. The
  source names `TransparentUpgradeableProxy` as the intended proxy.
- Implementation `0x359F…2D28`: `SnuggleVaultUpgradeable`, solc **0.8.33**, via-IR, optimizer runs 1,
  EVM cancun, linked library `SnuggleRebalanceLib` `0xf84b575E4E6D9fc07a3F2B863Cb6A23CC11DCDDc` (the
  library Addendum 3 saw calling `getTWAPTick`); Sourcify partial match.
- `mapping(address => uint256[]) public userPositions;` — the index getter IS the compiler-generated
  one. `_removePosition` swap-and-pops the owner's list, `_replacePositionId` replaces in place, and
  `positionIndexInUser[tokenId]` tracks each id's index, so every listed id is owned by the lister.
  Also public: `allPositionIds(uint256)`, `positionIndexInUser(uint256)`, `maxPositionsPerUser()`,
  `paused()`.

### Live reads (`cast`, block 51,143,322)

| Read | Answer |
|---|---|
| `maxPositionsPerUser()` | **500** (the venue's `MAX_ENUMERATION` = 512 sits above it) |
| `paused()` | false (the getters carry no `whenNotPaused`; a pause does not change enumeration) |
| `userPositions(0x…dEaD, 0)` under a 30,000 gas limit | `-32003 out of gas: gas required exceeds: 30000` — the end-of-list needs more than the ≈ 8.6k gas left after the intrinsic cost |
| the same under 100,000 | `execution reverted`, no data — a `REVERT`, not an `INVALID` |
| selector `0xdeadbeef` on the proxy | `execution reverted`, no data — the same shape as the end of a list |

### Gas per probe, metered on the fork (block 51,127,409, cold, through the proxy)

| Probe | Result | Gas used | Share of the 200,000 stipend |
|---|---|---|---|
| `userPositions(fresh, 0)` — end of an empty list | revert, `0x` | **12,660** | 1 / 15.8 |
| `userPositions(fresh, 2^256 − 1)` — the canary | revert, `0x` | **12,660** | 1 / 15.8 |
| `0xdeadbeef` — a selector the engine lacks | revert, `0x` | **11,127** | 1 / 18.0 |
| `userPositions(holder, 0)` — a successful index read | ok, 32 bytes | **15,275** | 1 / 13.1 |
| `positions(id)` — the 17-word struct | ok, 544 bytes | **24,463** | 1 / 8.2 |

The live holder was found from `allPositionIds(0)` → `positions(id).owner` =
`0xf4b4eF5bD7EcDC1d121604C14e43a6d369071b1f`, who held **42** ids at that block; the redesigned
`positionsOf` returned all 42, each owner-corroborated, with the id the global list named among
them, and an empty list for a fresh address. **What this settles:** the empty end-of-list is a cheap
`REVERT` that hands its gas back, so a probe that consumes the whole stipend is an out-of-gas and
nothing else; a selector miss (an implementation without the getter) costs within 1.6k gas of a real
end and is NOT told apart by gas — `RISKS.md` §12 residual (b). `PROBE_GAS = 200_000` is ≥ 8× the
dearest probe and must be re-measured on any change to the implementation slot.

### Fork scorecard after slice A (block 51,127,409): 5 passed / 3 failed / 0 skipped

`test_fork_engineIndexGetterShape` now PASSES (it also asserts the empty shape, the canary
agreement and the gas bounds above). Still failing, unchanged, for slices B and C:
`test_fork_lpOpenCloseOnLiveEngine` (`NotImplemented()` from the stub adapter at engine index 0),
`test_fork_supplyBorrowRepayWithdrawUnderTheAccount` (`ERC20: transfer amount exceeds balance` at
the repay — the +1 unit), and `test_fork_cbzecIsAB20WithLiveMultiplier` (harness limitation,
`OpcodeNotFound`; retired on 2026-09-12 for `scripts/check-cbzec-b20.sh`, Addendum 10).

## Addendum 5 — slice B, 2026-09-10: open → close on the engine's real Aerodrome entry, and the shapes the mocks now reproduce

Purpose: make `test_fork_lpOpenCloseOnLiveEngine` prove the product's path (the Aerodrome Slipstream
entry, not the stub the first run landed on), and measure every engine revert the mocks model.
Method: `contracts/test/fork/BaseFork.t.sol` pinned at **block 51,127,409** (Foundry 1.8.1,
`FORK_URL=https://mainnet.base.org`, `FORK_BLOCK=51127409`, 2026-09-10); entries selected by
PROPERTY (active, WETH/USDC, a position adapter that answers `getTWAPTick(pool, 300)`, then the pool's
`factory()` and whether a reward adapter is set), never by index — the index is only logged; `cast`
reads at block 51,145,283–51,145,333 for the live entry table; the verified sources of the
implementation and of `SnuggleRebalanceLib` (Sourcify, 33 files) for the mechanism. Nothing signed
or broadcast; `contracts/.env` not written.

### The two entries the tests select (engine `poolIdsCount()` = 214)

| | Aerodrome (gauged) — `test_fork_lpOpenCloseOnLiveEngine` | Un-gauged — `test_fork_engineRefusalShapesOnUnstakedEntry` |
|---|---|---|
| index (logged) | **24** | **17** |
| poolId | `0x0ea72f44ccaf524e3fda5e4a6682fda7a79e42dc2858ee27be311e9337aa72a8` | `0x12fc2fd09d3d3bfeca3b2a731167f3740c3a543755afa8d0d93fd95889e41796` |
| pool | `0xb2cc224c1c9feE385f8ad6a55b4d94E92359DC59` — `factory()` = **`0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A`** (the CLFactory the SwapRouter is bound to), token0 WETH, token1 USDC, `tickSpacing()` 100, `fee()` 803 (dynamic, 0.0803 %), `gauge()` `0xF33a96b5932D9E9B9A0eDA447AbD8C9d48d2e0c8` | `0xd0b53D9277642d899DF5C87A3966A349A798F224` — the Uniswap v3 WETH/USDC 0.05 % pool (Addendum 3) |
| engine fee field / tickSpacing | 100 / 100 | 500 / 10 |
| position adapter | `0x0AedeEd5Ad8d45D3D928Fb872161EFaA559794D1` — `getTWAPTick(address,uint32)(int24)` answers (**−198,283** at block 51,145,333); the `(address,uint256)` spelling reverts | `0xca4cF963C71234a4F7D44a750B4D3847B4deBabd` — answers |
| reward adapter | `0xBB8ea00aEa2f9D0643E5c0f80C177aa4A264375a` — `isStaked(id)` = **true** right after the deposit (auto-staked) | none (`address(0)`) |
| gauge (`cast`, block 51,145,333) | `rewardRate()` **395,705,710,963,192,131** wei AERO/s ≈ 0.3957 AERO/s ≈ 34,189 AERO/day across the pool's staked in-range liquidity; `periodFinish()` **1,789,603,200** (2026-09-17 00:00 UTC); `rewardToken()` AERO | — |
| pool `slot0()` at block 51,145,283 | sqrtPriceX96 `3920167856124431975155485`, tick **−198,289**, cardinality 3010, `liquidity()` `10667942621563466123` | — |

The stub adapter `0xCCBfBA207D424c4711708c260Eba9C87f02cCED2` still reverts `NotImplemented` on
`getTWAPTick(0xd0b5…F224, 300)` (re-read with `cast`, block 51,145,333), so the property filter
excludes all 81 stub entries without naming any of them.

### What the open → close proved (Aerodrome entry, block 51,127,409)

| Step | Measured |
|---|---|
| `open` — 1,000 USDC single-sided (amount1), width 1500, band ±10 % of `poolSqrtPriceX96` = `3911693647682676357029293` | id **76,585,495** minted to the account; `positionsOf(account)` = [76,585,495] (slice A on the live engine); account holds 0 USDC and 0 WETH after (nothing bounced) |
| where the engine put it | `positions(id)` ticks **[−199,900, −198,400]** (a 1,500-tick span, the requested width) with the pool at tick **−198,333** at open: the whole range sits BELOW the price, 67 ticks under the upper bound — **out of range at open**, holding only USDC, as the verified library's `calculateSnuggleRange` builds it for a token1 deposit |
| `close` inside the 60 s hold (bubbled untouched through the venue) | `0xb586467e` = **`MinimumHoldTimeNotMet()`**, 4 bytes |
| raw `harvest(id)` on the fresh staked id | `0x59c0b75c` = **`UseClaimStakingRewards()`** |
| raw `claimStakingRewards(id)` on the fresh staked id | **no revert**, `earned` = 0 (the venue's `_claimOne` first try succeeds with nothing to pay) |
| `closeMany([never minted, ours, 1])` inside the hold | `failed` = all three (two the venue refuses as not ours, ours as the engine's hold), the position untouched |
| `close` at hold + 2 min | **out0 (WETH) = 0, out1 (USDC) = 999,999,999, rewards = 0**; both paid to the account; `positionsOf` = []; the venue holds 0 USDC / 0 WETH / 0 AERO |
| round trip | 999.999999 of 1,000 USDC back at the pool price after the close = **9,999 bps**; the test's bound is 98 % |

**The single-sided deposit is NOT swapped to ratio** — the correction of FACT 4 in
`ISnuggleVault.sol`. The verified `SnuggleRebalanceLib.executeMint` (linked library
`0xf84b…DCDDc`) takes the `singleSided` branch: `SnuggleLogic.selectConservativeTick` picks, for a
token1 (USDC) deposit, the LOWER of the adapter's TWAP tick and spot tick, and
`TickMath.calculateSnuggleRange` → `_buildDirectionalRange` builds the range on that token's side
of the price — BELOW it for USDC — with no swap; only the dual-token `deposit` uses
`calculateCenteredRange`. The position therefore holds only USDC until the price falls into the
range, earns no trading fees and no gauge emissions while it sits there (Slipstream gauges pay
staked liquidity that is in range), and converts into WETH as the price descends through it. That
is the mechanism the Snuggle name describes and the mock already modelled (a single-sided deposit
is kept in the deposited token); it is NOT what the interface header claimed and NOT what the yield
model's in-range assumption prices. `RISKS.md` §12 carries it; the memo (slice E) and the
founder's questions carry the product consequence.

### The engine's refusal shapes (un-gauged entry, block 51,127,409; id 5,967,878 minted for 500 USDC)

Raw calls from the account, every reason exactly 4 bytes:

| Call | Revert | Selector |
|---|---|---|
| `withdraw(foreign id, false)` (the global list's first id, owned by `0xf4b4…1b1f`) | `NotPositionOwner()` | `0x70d645e3` |
| `withdraw(never-minted id, false)` | `NotPositionOwner()` | `0x70d645e3` |
| `harvest(foreign id)` | `NotPositionOwner()` | `0x70d645e3` |
| `claimStakingRewards(foreign id)` | `NotPositionOwner()` | `0x70d645e3` |
| `harvest(own fresh id)` | `NoFeesToHarvest()` | `0xcee1c2c5` |
| `claimStakingRewards(own id, entry without a reward adapter)` | `NoRewardAdapter()` | `0x6d21e668` |
| the venue's `claim([foreign id])` | reported in `failed`, no revert, position untouched | — |
| `close` at hold + 2 min | out0 = 0, out1 = **499,999,999** (one unit of CL rounding), list empty | — |

From the verified source, not exercisable on demand here: `NotStaked()` `0x039f2e18`
(`claimStakingRewards` on a gauged entry whose id is not staked), `DeadlineExpired()` `0x1ab7da6b`,
`PoolNotApproved()` `0xdb30f2ac`, `TokenNotInPool()` `0x07326195`; the pause is OZ 4.x
`whenNotPaused` on `deposit` / `depositSingleSided` / the rebalance paths only — `withdraw`,
`harvest` and `claimStakingRewards` carry none. `MockSnuggleVault` now declares these errors by the
engine's names and arities, reverts them under the same conditions, keeps its own test switches
(`WithdrawRefused`, `ClaimRefused`, `setUnreachable`) labelled as such, and no longer pauses views
or exits; the header says which is which.

### Fork scorecard after slice B (block 51,127,409): 7 passed / 2 failed / 0 skipped of 9

`test_fork_lpOpenCloseOnLiveEngine` and the new `test_fork_engineRefusalShapesOnUnstakedEntry` PASS.
Still failing, unchanged, for slice C and the harness limit:
`test_fork_supplyBorrowRepayWithdrawUnderTheAccount` (the +1 unit at the repay) and
`test_fork_cbzecIsAB20WithLiveMultiplier` (`OpcodeNotFound`; retired on 2026-09-12 for
`scripts/check-cbzec-b20.sh`, Addendum 10).

## Addendum 6 — slice C, 2026-09-10: the Aave round trip, funded as a user would be, and the dust it leaves

Purpose: make `test_fork_supplyBorrowRepayWithdrawUnderTheAccount` green against the real pool and
record the rounding the dust policy (`RISKS.md` §8, `packages/shared/src/dust.ts`) is built on.
Pinned at **block 51,127,409** (Foundry 1.8.1, public RPC, 2026-09-10); the account is funded by
the borrow and by nothing else until the venue's own `debt()` says what is missing. Nothing signed
or broadcast.

| Call (through `OilskinAccount.execWithCallback` → `AaveV3Venue`) | Result |
|---|---|
| `deal(cbBTC, account, 1e8)`; `supply(cbBTC, 1e8)` | `collateral()` reads **99,999,999** (one unit under: the aToken is a scaled balance) |
| `borrow(USDC, 10,000e6)` | the account holds exactly **10,000,000,000** USDC; `healthFactor()` 6.02; `debt()` reads **10,000,000,001** in the same block |
| `repay(USDC, max)` holding exactly the borrow | **repaid 10,000,000,000** (everything held — the venue now clamps to the balance instead of dying in Aave's `transferFrom`); `debt()` after = **2** units (the unit Aave read over, plus one more from the burn's own rounding); ≤ `LOAN_DUST_UNITS` = 100; allowance 0 |
| `withdraw(cbBTC, max)` with those 2 units outstanding | **reverts `0x6679996d` = `HealthFactorLowerThanLiquidationThreshold()`** — Aave v3's custom error (the Base deployment reverts with typed errors, not the older `"35"` string); collateral untouched |
| `deal(USDC, account, 2)`; `repay(USDC, max)` | repaid **2**; `debt()` = 0; `healthFactor()` = `type(uint256).max` |
| `withdraw(cbBTC, max)` | **withdrawn 99,999,999** — the aToken balance, one unit under what was supplied; `collateral()` = 0; both allowances 0 |

**What this settles.** (1) The residual after an exact-balance `repay(max)` is 2 units here, not 1:
one from the debt read, one from the repay's own rounding — the threshold must not be "1". (2) The
venues do not forgive dust: Aave refuses to release the last of the collateral while 2 units
(0.000002 USDC) are owed. The app's Close must ask the user for the full `debt()` the venue reports,
never for the borrow, and the threshold governs only what the app says and which book the router
and keeper act on. (3) One unit of cbBTC (≈ $0.0008 at this block) is lost to the aToken's
rounding on a supply-then-withdraw; it is not recoverable and is now stated in `RISKS.md` §8.

## Addendum 7 — slice D, 2026-09-10: the two-book withdraw leg, metered on the fork

Purpose: put numbers on the two options for the two-book Close (`RISKS.md` §8). Pinned at **block
51,127,409**; a `MorphoBlueVenue` deployed in the test over the two verified Morpho markets
(`0x9103…1836`, `0x8793…1bda`) against the fork's own registry; cbBTC moved from the fork's
`AaveV3Venue` to it by `proposeVenue` → `vm.warp(2 days)` → `acceptVenue` (the test contract is
that registry's owner); a book on each venue (0.5 cbBTC + 5,000 USDC borrowed on Aave first, the
same on Morpho after the switch); everything metered raw through `OilskinAccount.execWithCallback`.
Nothing signed or broadcast.

| Measured | Value |
|---|---|
| debt after the two-day warp, Aave / Morpho | 5,001,269,399 / 5,000,000,001 USDC units (Aave accrued ≈ 1.27 USDC of interest across the timelock; Morpho's read is the +1 `toAssetsUp`) |
| the router's views per venue (`debt` + `collateral`), Aave / Morpho | **158,648** / **63,987** gas |
| `withdraw(cbBTC, max)` through the account, Morpho / Aave | **125,152** / **203,462** gas |
| cbBTC back after both legs | 100,000,037 (Morpho's 0.5 exactly; Aave's aToken balance grown by two days of supply interest, 37 units) |

Gas price context, read at block 51,146,494 the same day: `eth_gasPrice` 6,000,000 wei (0.006 gwei),
base fee 5,000,000 wei (0.005 gwei); Chainlink ETH/USD `latestRoundData` = 2,437.27 (updated
1789082053); cbBTC/USD = 76,623.97. The L1 data fee Base charges per transaction is not in these
figures and was not read.

## Addendum 8 — slice E, 2026-09-10: the cbZEC path, probed read-only

Purpose: the numbers behind `docs/CBZEC-PATH-2026-09.md` and the B20 probe (`RISKS.md` §4).
Method: `cast call` / raw `eth_call` against `https://mainnet.base.org`, blocks **51,146,494 →
51,146,674** (2026-09-10, 17:5x–18:1x UTC); `eth_call` state overrides (`--override-state`) on USDC
for the routing test, with the storage slot verified first. Nothing signed or broadcast.

### Does the verified SwapRouter route USDC → cbZEC?

| Step | Result |
|---|---|
| USDC `balances` slot: `keccak256(abi.encode(pool 0x0Fc4…8566, 9))` read with `cast storage` | `0x9b1437fdde` = 666,059,144,670 = `balanceOf(pool)` at the same moment — **slot 9 is `balances`**; `allowed` is slot 10 (FiatTokenV2 layout) |
| `exactInputSingle((USDC, cbZEC, tickSpacing 200, sender, deadline, 1,000e6, 0, 0))` on `0xBE6D…18a5`, `--from 0x1111…1111`, with that sender's USDC balance and allowance to the router overridden to 1,000e6 | **`execution reverted`, no data** |
| the same at tickSpacing 100 | **`execution reverted`, no data** |
| control: `exactInputSingle((WETH, USDC, 100, sender, deadline, 0.01e18, 0, 0))` with the sender's WETH balance (slot 3) and allowance (slot 4) overridden | **`0x1749615` = 24,417,813** = 24.417813 USDC for 0.01 WETH (≈ 2,441.78 USDC/WETH) — the method and the router both work; the router cannot reach a pool it did not create |

### The second factory and its deployment

| Read | Value | Block |
|---|---|---|
| `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef` `owner()` = `swapFeeManager()` = `unstakedFeeManager()` | `0xE6A41fE61E7a1996B59d508661e3f524d6A32075` | 51,146,581 |
| `poolImplementation()` / `voter()` / `swapFeeModule()` / `factoryRegistry()` | `0xc770898522D2A9c8Da7A10D63989b6b58305B665` / `0x16613524e02ad97eDfeF371bC883F2F5d6C480A5` / `0x87D8f999BBa9343E8099552426775B51C338E8CB` / `0x5C3F18F06CC09CA1910767A34a20F771039E37C0` | 51,146,581 |
| `allPoolsLength()` / `tickSpacings()` / `getPool(USDC, cbZEC, 200)` | **1,414** / [1, 50, 100, 200, 2000, 500, 10] / `0x0Fc47C17AF86078d809358db1b4db2DeBC988566` | 51,146,581 |
| FactoryRegistry `poolFactories()` | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da`, `0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A`, `0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a`, `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef` — both CL factories approved; `factoriesToPoolFactory(0xf8f2…)` = votingRewardsFactory `0x45cA74858C579E717ee29A86042E0d53B252B504`, gaugeFactory `0x385293CaE378C813F16f0C1334d774AdDDf56AbB` | 51,146,674 |
| the pool's `nft()` | **`0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53`** (49,087 B), `factory()` = `0xf8f2…61Ef` — the NPM that mints into this pool; the NPM recorded on 2026-09-06 (`0x8279…5b72`) has `factory()` = `0x5e7B…809A` | 51,146,674 |
| The second factory names no router. | | |

### Gauge, Voter, pool, prices

| Read | Value | Block |
|---|---|---|
| gauge `0x8779…81FB` `rewardRate()` / `rewardRateByEpoch(1788998400)` | **7,140,520,125,989,201** wei AERO/s (both) ≈ 616.94 AERO/day | 51,146,581 |
| gauge `periodFinish()` / `rewardToken()` / `pool()` / `isPool()` | 1,789,603,200 (2026-09-17 00:00 UTC) / AERO / the pool / true; `totalSupply()` and `stakedLiquidity()` revert on this gauge | 51,146,581 |
| Voter `isAlive(gauge)` / `weights(pool)` / `totalWeight()` / `epochNext(now)` | true / 845,426,815,777,204,089,704,683 / 1,016,840,058,877,742,097,218,633,380 (**0.0831 %**) / 1,789,603,200 | 51,146,581 |
| pool `slot0` / `liquidity()` / `stakedLiquidity()` | tick **−23,756**, sqrtPriceX96 24,158,478,068,572,882,064,475,621,010 (≈ **1,075.5 USDC/cbZEC**) / 21,276,159,996,193 / **18,217,498,697** (0.086 % of active liquidity is staked) | 51,146,581–674 |
| pool balances | USDC **666,059,144,670** (666,059 USDC), cbZEC **20,606,032,105** (206.06) → TVL ≈ $887.7k | 51,146,581 |
| Chainlink AERO / USD `0x4EC5970fC728C5f65ba413992CD5fF6FD70fcfF0` (`description()` = "AERO / USD") | **0.54485438**, updated 1789082529 | 51,146,674 |
| base fee / `eth_gasPrice` / ETH / USD / cbBTC / USD | 0.005 gwei / 0.006 gwei / 2,437.27 / 76,623.97 | 51,146,494 |

**What this settles.** (1) The SwapRouter this repo verified cannot route to the cbZEC/USDC pool;
`AerodromeSwapAdapter` must never be pointed at that pair. (2) The pool lives on a second, sanctioned
Slipstream deployment (factory `0xf8f2…61Ef`, NPM `0xe1f8…8b53`, gauge factory `0x3852…6AbB`) with its
own fee manager `0xE6A4…2075`; a direct integration would bind to THOSE, not to the 2026-09-06
addresses. (3) The gauge has one epoch's vote worth ≈ $336/day of AERO at the read, paid to
almost nobody (0.086 % of the liquidity is staked) — a number that is re-voted on 2026-09-17 and
must never be baked in. (4) Nothing in the product can earn it today.

## Addendum 9 — slice F, 2026-09-10/11: the second Slipstream deployment, read for the direct venue

Purpose: the pointers and shapes `SlipstreamLpVenue` and `SlipstreamPoolSwapAdapter` bind to
(`docs/CBZEC-PATH-2026-09.md` option 1, decided 2026-09-10). Method: `cast call` against
`https://mainnet.base.org` between blocks **51,149,609 and 51,149,744** (2026-09-10, ≈ 19:0x UTC),
and the verified sources from Sourcify (`/server/v2/contract/8453/<addr>?fields=all`). Nothing signed
or broadcast. Abbreviations: NPM = NonfungiblePositionManager (the ERC-721 that mints Slipstream
positions); CL = concentrated liquidity.

### Pointers (all at blocks 51,149,609–625)

| Read | Value |
|---|---|
| CLFactory `0xf8f2…61Ef` `isPool(0x0Fc4…8566)` | true |
| Voter `0x1661…80A5` `gauges(0x0Fc4…8566)` | `0x8779E34E5d38358B0cB957c553B40cC1208C81FB` — the gauge Addendum 8 recorded |
| pool `gauge()` / `nft()` / `factory()` | `0x8779…81FB` / `0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53` / `0xf8f2…61Ef` — **this deployment's pools answer `gauge()`** (the 2026-09-06 pool `0xb2cc…DC59` reverts on it) |
| gauge `nft()` / `rewardToken()` | `0xe1f8…8b53` / AERO `0x9401…8631` |
| gauge `stakedValues(0x…01)` | `[]` (answers; an empty list for a fresh address) |
| NPM `name()` / `supportsInterface(0x780e9d63)` / `totalSupply()` | "Slipstream Position NFT v1" / **true — ERC-721 Enumerable** / 1,557,619 |
| CLFactory `getPool(WETH, USDC, 100)` / `(cbBTC, USDC, 100)` / `(WETH, USDC, 200)` | zero, zero, zero — the majors' pools are on the OLD factory; this one has no WETH/USDC at 100 or 200 |
| gauge factory `0x3852…6AbB` `implementation()` / `nft()` | `0x434BCcaB043311a20b16021C137EA81702790f7B` / `0xe1f8…8b53` |

### Verified sources (Sourcify, all `exact_match`, solc 0.7.6+commit.7338295f)

| Contract | Source | What the venue relies on |
|---|---|---|
| NPM `0xe1f8…8b53` | `NonfungiblePositionManager.sol` (59 files) | `mint(MintParams)` pulls both tokens from `msg.sender` (`PeripheryPayments.pay` → `transferFrom`) and mints to `recipient` with a plain `_mint`; `MintParams` carries `tickSpacing` and a `sqrtPriceX96` that creates the pool when non-zero (Oilskin passes 0); `decreaseLiquidity`, `collect`, `burn` require `msg.sender` to own or be approved for the id; `burn` requires liquidity and both `tokensOwed` at zero ("NC"); `positions(id)` is the 12-field tuple |
| CLFactory `0xf8f2…61Ef` | `CLFactory.sol` + `CLPool.sol` (37 files) | `swap(recipient, zeroForOne, amountSpecified, sqrtPriceLimitX96, data)`: exact input when positive; the limit must sit strictly between the price and the tick bound ("SPL"); the output is sent to `recipient` BEFORE `ICLSwapCallback(msg.sender).uniswapV3SwapCallback(amount0, amount1, data)`, after which the pool checks its own balance ("IIA") |
| CLGauge implementation `0x434B…0f7B` (the pool's gauge is an EIP-1167 clone of it, per Blockscout) and gauge factory `0x3852…6AbB` | `CLGauge.sol`, `CLGaugeFactory.sol` (37 / 39 files) | `deposit(tokenId)`: `nft.ownerOf(tokenId) == msg.sender` ("NA"), `voter.isAlive(gauge)` ("GK"), the position's tokens and spacing must be the pool's ("PM"); it calls `nft.collect(→ msg.sender)` and `nft.safeTransferFrom(msg.sender, gauge, tokenId)` — so the depositor must `approve(gauge, tokenId)` first. `withdraw(tokenId)`: collects, pays the reward to `msg.sender` (`_getReward`, less `gaugeFactory.penaltyRate()` while `block.timestamp < depositTimestamp + minStakeTimes(pool)`), unstakes and `safeTransferFrom`s the NFT back (the receiver needs `onERC721Received` — the account has it). `getReward(tokenId)` pays without unstaking. `stakedValues(depositor)`, `stakedContains(depositor, tokenId)`, `stakedLength` are the only depositor views: there is **no id → depositor view**, which is why `ILpVenue.ownedPool(id, account)` exists |

### A sibling pool for the fork test (block 51,149,744)

`CLFactory.allPools(0)` = **`0x493E74Eda2720e127BAcCC1A19B2D567Bc14aB43`**: token0 WETH, token1
USDC, tickSpacing **10**, gauge `0xBb43264000215f475EB6b456cF1Bbf0EF5a726FA` (via `voter.gauges`),
`liquidity()` 1,008,288,662,761,661. Ordinary ERC-20s on both sides, so a fork EVM can run the
venue end to end on this deployment's live NPM and gauge
(`test_fork_directVenueOpenCloseOnTheSecondDeployment`); the cbZEC pool itself cannot be exercised
in a fork EVM (Addendum 3) and is proved by its pointers only
(`test_fork_directVenueBindsToTheCbzecPool`). The next entries: `allPools(1..4)` are WETH or USDC
against `0x9d0E…d083`, `0x6985…71cd`, `0xacfE…21bf`, `0x9126…86Eb` (all gauged); `allPools(5..7)` have
no gauge (zero) and two of them zero liquidity.

**What this settles.** (1) The venue's four constructor cross-checks (`pool.nft`, `pool.gauge`,
`gauge.nft`, `gauge.pool`, `gauge.rewardToken`, and the adapter's `POOL()`) hold on the live
cbZEC/USDC pointers. (2) A staked position is the gauge's on the NFT's books and the account's on
the gauge's; enumeration is `stakedValues` plus the NPM's `tokenOfOwnerByIndex` filtered by pool.
(3) The pool-direct swap pays the pool inside the callback, from the account, exactly the positive
delta the pool reports. (4) Read 2026-09-11 at block **51,193,797** (W3-LOW-5): gauge factory `0x3852…6AbB`
`penaltyRate()` = **10,000 bps** and `minStakeTimes(0x0Fc4…8566)` = **10 seconds**; the gauge's
`gaugeFactory()` = `0x3852…6AbB`, `minter()` = `0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5`,
`depositTimestamp(1)` = 0 (no such stake). So `_applyPenalty` forfeits **all** of a position's AERO
to the minter when it is unstaked (`withdraw` or `getReward`) within ten seconds of its
`deposit`, and nothing after that; `SlipstreamLpVenue.earlyWithdrawPenalty(id, account)` reads
these live and the position card and the Close plan show the window while it is open.

## Addendum 10 — slice I, 2026-09-12: the fork suite at block 51,222,568, all green, and the B20 read done with `cast`

Purpose: the first all-green run of `contracts/test/fork/BaseFork.t.sol`, at a block CI now pins
(`FORK_BLOCK` in `.github/workflows/ci.yml`), and the words the chain answered. Method: Foundry
1.8.1 on the founder's Mac, `FORK_URL=https://mainnet.base.org` (public RPC, no key),
`FORK_BLOCK=51222568` (the tip at 17:34:39 UTC), 17:35–17:41 UTC; `scripts/check-cbzec-b20.sh`
at the same block with `cast`. Nothing was signed or broadcast. Every derived figure below is
computed from the raw word beside it.

### Re-read on the CI runner, 2026-09-13 (12 tests, all green)

The same block, proved a second time and by a second machine: GitHub Actions run `34768905298`
(`workflow_dispatch`, head `16cf235`, job `103754763916`, 16:32:50 UTC) with `BASE_RPC_URL` set to an
archive-capable Base endpoint. The job's summary line and the B20 step, verbatim:

```
fork: 12 passed / 0 failed / 0 skipped of 12 at block 51222568 (chain tip at run time: 51264012)
check-cbzec-b20: OK at block 51222568 (pinned), chain 8453
  code(cbZEC)   = 0xef  (B20 native contract; no fork EVM can execute it)
  decimals()    = 8
  symbol()      = cbZEC
  multiplier()  = 1000000000000000000  (1.000000000000000000 × — a rebase factor, printed not pinned)
```

Twelve tests, not the eleven below: A5.1 added `test_fork_cctpV2_theAccountsBurnLegBurnsNativeUsdcToASolanaRecipient`
(2026-09-13). The chain tip had moved to 51,264,012 by then — about 41,400 blocks past `FORK_BLOCK` — which is why
the endpoint must keep ARCHIVE state: a pruned node serves the tip and answers
`state at block #51222569 is pruned` for the pin (`docs/TESTING.md` "CI" records the three secret values it took).
The suite itself was also walked cold on the founder's Mac the same day against `https://mainnet.base.org`
(`--no-storage-caching`, no warm `~/.foundry/cache`): 12 / 12 in 85.6 s, the same block, the same B20 words.

### Scorecard, first run (founder's Mac, 2026-09-12): 11 passed / 0 failed / 0 skipped (12 → 11 tests)

`test_fork_cbzecIsAB20WithLiveMultiplier` is retired — its first external call died
`OpcodeNotFound` at every block it was ever run (Addendum 3) because cbZEC's code is the single B20
byte `0xef` that no fork EVM executes — and its four assertions are `scripts/check-cbzec-b20.sh`:
**OK at 51,222,568** — `eth_getCode` `0xef`, `decimals()` **8**, `symbol()` **cbZEC**,
`multiplier()` `1000000000000000000` = **1e18, unchanged** since 2026-09-05.

`test_fork_directVenueOpenCloseOnTheSecondDeployment` ran against Base for the first time. It
failed `NotOwner()` on the first run: the close's `PriceBand` was computed inline *after*
`vm.prank(alice)`, and `_forkBand`'s `slot0()` staticcall consumed the prank, so the close reached
the account from the test contract. Harness defect; the band is now read before the prank; no
product code changed. Everything else passed unchanged.

### What the chain said (block 51,222,568 unless noted)

| Read | Word | Derived / note |
|---|---|---|
| Aave cbBTC LT / LTV | 7800 / 7300 | unchanged since 2026-09-05 |
| Aave WETH LT / LTV | 8300 / 8000 | unchanged |
| Aave USDC variable borrow rate | `45204616058225984156951817` ray | **4.5205 % APR** (4.633 % on 2026-09-10 at 51,127,409; 4.828 % on 2026-09-05) |
| cbZEC LT on Aave | 0 | still not listed |
| cbZEC/USDC pool `slot0` | `sqrtPriceX96 23465594535294725364452820347`, tick **−24,338** | ≈ **1,140.07 USDC per cbZEC** (1.0001^tick, 6 vs 8 decimals); −24,995 / ≈ 1,217.49 on 2026-09-10 |
| cbZEC/USDC pool `liquidity()` | `17633782327660` | 21,992,736,132,521 on 2026-09-10 |
| cbZEC/USDC gauge `0x8779…81FB` `rewardRate()` / `periodFinish()` | `7140520125989201` / `1789603200` | **≈ 616.94 AERO / day, epoch ending 2026-09-17 00:00 UTC — the gauge now has an emissions vote** (it had none on 2026-09-10, Addendum 8; the yield sample of slice K reads it live); Voter `isAlive` true |
| Engine `poolIds(i)` past the end / canary / unknown selector / live index / `positions(id)` | 12,660 / 12,660 / 11,127 / 15,275 / 24,463 gas | identical to Addendum 4; live holder `0xf4b4…1b1f` now enumerates **44** ids (42 on 2026-09-10) |
| Aave round trip under the account | collateral read 99,999,999 after 1e8; HF 6.026 after 10,000 USDC; debt `10000000001`; `repay(max)` leaves 2 units; `withdraw(max)` refused `0x6679996d` while owed; +2 repaid; withdrawn 99,999,999 | Addendum 6's shape, unchanged |
| Second-deployment WETH/USDC ts-10 pool `0x493E…aB43` | gauge **`0xBb43264000215f475EB6b456cF1Bbf0EF5a726FA`**, `isAlive` true, `rewardRate()` `621935145009867` (≈ 53.74 AERO / day), `fee()` 500 pips, tick **−197,891** (≈ 2,547.61 USDC per WETH) | first read of this gauge |
| Direct venue open on that pool, 400 USDC single-sided, width 1500, through the account | **1,276,935 gas** (whole tx); left idle after open: 0 USDC, `15990198080511094` WETH (0.0160) | the to-ratio swap bought slightly more WETH than the mint used; the venue and the adapter hold nothing; no allowance survives |
| Direct venue close after 1 h | **534,277 gas**; paid `62856322894720550` WETH (0.0629) + `199837790` USDC + 0 AERO (net) | round trip **400.724285 USDC-equivalent** back of 400 (WETH at the pool's own price) — within the 3 % the test allows, above par because of the fee tier and the price moving inside the hour; position burnt; `positionsOf` empty |
| Permit2 / Morpho Blue / Pyth | code present | unchanged |

Not verified here, still gated: everything Addendum 9 lists — the cbZEC/USDC pool's own mint has
never executed anywhere (the B20 precompile), and the gauge factory's early-withdraw penalty for
the cbZEC pool was not read.

## Addendum 11 — slice J, 2026-09-12: the Base Sepolia feeds re-measured, and the bounds the keeper derives from them

Purpose: the per-feed staleness bounds the observe-only keeper will enforce on Base Sepolia,
computed by the keeper's own `buildFeedPolicies` (`agent/src/engine/feeds.ts`) against the live
aggregators, before any deployment exists there (`scripts/sepolia-feed-policy.mjs`). Method:
`https://sepolia.base.org`, read-only, 18:20–18:24 UTC, blocks 46,734,469 → 46,734,590; ten
historical rounds per feed read with `cast` first (`getRoundData`), then the keeper's six-round
window through its own code. Nothing was signed.

| Feed (keeper symbol) | Address | Latest at the read | Gaps between the last 10 rounds (s, newest first) | Keeper's 6-round window: max gap → bound (× 2, floor 300) |
|---|---|---|---|---|
| BTC / USD (cbBTC) | `0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298` | 77,172.94 at 18:05:32 UTC | 1222, 1230, 542, 1230, 1222, 1220, 1222, 1230, 1212, 1220 | 1,230 → **2,460 s** |
| ETH / USD (WETH) | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | 2,524.98 at 18:13:36 UTC | 1202, 1230, 770, 1222, 1220, 1222, 1222, 1230, 68, 1230 | 1,230 → **2,460 s** |
| USDC / USD (USDC) | `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165` | 0.99981758 at 13:32:04 UTC | 86416, 86416, 86424, 86404, 86418, 86402, 86422, 86420, 86414, 86408 | 86,424 → **172,848 s** |

The 1,200-second heartbeat recorded from Chainlink's reference data on 2026-09-07 is what the
chain shows: consecutive rounds 1,212–1,230 s apart, with deviation-triggered rounds inside the
window (542 s, 770 s, 68 s). USDC/USD publishes once a day (86,402–86,424 s). None of the three was
stale against its own bound at the read (ages 1,136 / 652 / 17,544 s). The bounds move a little
from read to read because the largest gap in the window does; the rule (`max gap × slack`,
floored) does not. `docs/SEPOLIA-REHEARSAL.md` carries the same table as the rehearsal's
reference; the keeper logs its own at startup for comparison.

## Addendum 12 — slice K, 2026-09-12: the yield sample read live (gauges, Aave rates, prices) at block 51,226,072

Purpose: the inputs `docs/MODEL-NUMBERS-2026-09-12.md` was generated from — the first live gauge
sample since 2026-08-31 — recorded with their block and time. Method: `npm run backfill -w
@zyo/yield -- sample` against `https://base-rpc.publicnode.com` (public, no key; `mainnet.base.org`
refused the batched burst with `over rate limit`), token prices from GeckoTerminal at the same
instant, `GECKO_MIN_INTERVAL_MS=15000` between the nine pool requests. Output:
`services/yield/samples/gauge-emissions-2026-09-12.json`. Nothing was signed.

- **Sampled at 2026-09-12T19:31:30.077Z, block 51,226,072**; AERO $0.5634 ($0.4782 on 2026-08-31).
- **Aave v3 (PoolDataProvider, live):** USDC variable borrow **4.5174 %** (4.828 % on 2026-09-05, 4.633 % on 2026-09-10 at 51,127,409, 4.5205 % at 51,222,568 earlier this day), USDC supply 3.5169 %; cbBTC supply **0.0115 %**, LT 7800 / LTV 7300; WETH supply **1.7422 %**, LT 8300 / LTV 8000. Thresholds unchanged since 2026-09-05; every rate moved.
- **Gauges (Voter `0x16613524e02ad97edfef371bc883f2f5d6c480a5`), one reading each** — the service withholds a marginal APR until three readings corroborate the staked anchor, so the sample carries the raw words and the model computes the APR from them:

| Pool | Gauge | rewardRate (wei / s) | periodFinish | Epoch at the sample | stakedLiquidity | fee (bps) | Gross marginal APR at sheltered / steady / working (model) |
|---|---|---|---|---|---|---|---|
| `aero-cbbtc-usdc` | `0x6399ed6725cc163d019aa64ff55b22149d7179a8` | `113025843134787251` (≈ 9,765.4 AERO / day) | 1789603200 (2026-09-17) | live | `4866057281767` | 4.48 | 6.15 % / 19.41 % / 98.69 % |
| `aero-usdc-weth-5` | `0xf33a96b5932d9e9b9a0eda447abd8c9d48d2e0c8` | `395705710963192131` (≈ 34,189.0 AERO / day) | 1789603200 (2026-09-17) | live | `14724958676260069756` | 5.94 | 3.93 % / 12.42 % / 63.13 % |
| `aero-weth-cbbtc` | `0x41b2126661c673c2bedd208cc72e85dc51a5320a` | `97932138830729886` (≈ 8,461.3 AERO / day) | 1789603200 (2026-09-17) | live | `236247594590505401` | 25.05 | 4.33 % / 13.32 % / 70.21 % |
| `aero-weth-link` | `0xd66c27ec3c0dfcd20678ff5f5c3cbb6ede033b92` | `8919467888046610` (≈ 770.6 AERO / day) | 1789603200 (2026-09-17) | live | `14560466473061927093701` | 25 | 26.39 % / 83.35 % / 423.69 % |
| `aero-usdt-usdc` | `0xbd85d45f1636fceb2359d9dcf839f12b3cf5af3f` | `240675878787964` (≈ 20.8 AERO / day) | 1789603200 (2026-09-17) | live | `4057662150871269` | 0.09 | 0.00 % / 0.00 % / 0.01 % |
| `cbeth-weth` | `0xf5550f8f0331b8caa165046667f4e6628e9e3aac` | `5390865703388402` (≈ 465.8 AERO / day) | 1789603200 (2026-09-17) | live | `10158957826336983034926643` | 0.65 | 0.00 % / 0.01 % / 0.05 % |
| `aero-aero-weth` | `0xde8ff0d3e8ab225110b088a250b546015c567e27` | `151916281777765901` (≈ 13,125.6 AERO / day) | 1779926400 (2026-05-28) | LAPSED | `3010492983052584166390` | 30 | 0.00 % / 0.00 % / 0.00 % |
| `aero-aero-cbbtc` | `0x2b74b62c564456c48055bd515a62594742b3f545` | `37554462218874000` (≈ 3,244.7 AERO / day) | 1789603200 (2026-09-17) | live | `1132942732640778303` | 7.5 | 11.67 % / 36.85 % / 187.32 % |
| `aero-cbzec-usdc` | `0x8779e34e5d38358b0cb957c553b40cc1208c81fb` | `7140520125989201` (≈ 616.9 AERO / day) | 1789603200 (2026-09-17) | live | `14816700185765` | 20 | 1.06 % / 3.34 % / 16.99 % |

What moved since the 2026-08-31 words the previous model used: the AERO price rose 18 %, but the
gauges of the three calibrated pools pay far less to a marginal staker — cbBTC/USDC sheltered
14.13 → **6.15 %** gross, WETH/USDC sheltered 7.63 → **3.93 %** (now below the borrow before any
drag), WETH/cbBTC steady 8.32 → 13.32 % — and **the cbZEC/USDC gauge has an emissions vote for the
first time** (none on 2026-09-10, Addendum 8): 1.06 / 3.34 / 16.99 % gross at the three widths on
about $0.97 M of pool TVL, refused below the borrow at the two wider widths and for lack of a σ at
the narrowest. AERO/WETH's epoch is still the one that ended 2026-05-28. The model's verdict on
these words is `RISKS.md` §14.

## Addendum 13 — slice A3, 2026-09-12: the USDC borrow curve and pool liquidity on Aave v3 Base, read live at block 51,227,701 (20:25:49 UTC)

Read with `cast` against `https://base-rpc.publicnode.com`, for the forecast's two new numbers — the
borrow rate AFTER a borrow of a given size, and the "cannot fund" hard-refusal (BUILD-PLAN-2026-09-12
§2 item 2, step A3). Raw words are in `services/yield/samples/aave-usdc-reserve-2026-09-12.json`; the
live service reads the same calls every sample (`services/yield/src/sources/aave.ts`) and the demo
forecast (`samples/demo-forecast.json`) is evaluated on this file. Abbreviations: APR = annual
percentage rate; bps = basis points (0.01 %).

| Read | Value |
|---|---|
| `PoolDataProvider.getInterestRateStrategyAddress(USDC)` | `0x86AB1C62A8bf868E1b3E1ab87d587Aba6fbCbDC5` — `DefaultReserveInterestRateStrategyV2`, code 4,038 bytes; the address is read every sample, never pinned |
| `strategy.getInterestRateDataBps(USDC)` | optimal usage **9000** bps, base **0**, slope 1 **470** bps (4.70 %), slope 2 **1000** bps (10 %); the ray getters agree (`getOptimalUsageRatio` 9e26, slopes 4.7e25 / 1e26) |
| `getReserveData(USDC)` — totalAToken / totalVariableDebt | **182,806,571.520498** / **158,038,067.327137** USDC (words 2 and 4); stable debt 0; accrued to treasury 1,025.51 (scaled) |
| `getReserveData(USDC)` — variableBorrowRate / liquidityRate | **4.5146 %** / 3.5126 % (ray words 45146359479383945382496577 / 35126312304323992397609966) |
| `getReserveConfigurationData(USDC)` | decimals 6, LTV 7500, LT 7800, bonus 10500, reserve factor **1000** bps |
| `getReserveTokensAddresses(USDC)` aToken; its USDC balance | `0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB`; **24,769,842.218084** USDC available |

**What the curve says, checked against the live word.** Utilisation U = debt ÷ supplied =
158,038,067.33 ÷ 182,806,571.52 = 86.45 %, under the 90 % kink, so the rate is
0 + 4.70 % × 0.8645 ÷ 0.90 = **4.5147 %** against the live **4.5146 %** — the 0.0001-point gap is the
denominator: the strategy uses the virtual balance + debt (24,769,842.22 + 158,038,067.33 =
182,807,909.55), which is `totalAToken` plus the treasury accrual, 0.0007 %. Above the kink the rate is
4.70 % + 10 % × (U − 0.90) ÷ 0.10: 14.70 % at 100 %. A $1 M borrow moves utilisation by 0.55 points and
the rate by ≈ 0.03 points; a $100 M borrow (more than the pool's cap for this product by orders of
magnitude) would land at 97.2 % and ≈ 11.9 %. Available to lend from the totals: 24,768,504.19 USDC
(the aToken balance less the accrual); the forecast refuses a borrow above it as `pool_cannot_fund`.

Not read here, probe before use: the Morpho Blue markets' `AdaptiveCurveIRM` rate after a borrow (the
forecast's "after" rate is Aave-only in A3; `MorphoBlueVenue` positions get today's rate with the
basis named), and whether Aave's `reserveFactor` applies to the borrow side (it does not — it is the
protocol's share of the supply-side interest, and the borrow rate above is what the borrower pays).

## Addendum 14 — the top ledger re-read at block 51,226,072, 2026-09-12 (19:31:31 UTC), read-only

**Why.** After slice K the demo carried two dated reads: the market snapshot from 2026-09-05 (4.828 % borrow,
0.012 % / 1.843 % supply, the 2026-09-05 prices) and the yield gate from the 2026-09-12 sample (4.5174 %). The
snapshot is now the sample's own block, so the web demo, the prototypes and the model quote one set of digits.

**How.** `scripts/ledger-read.sh <rpc> <block>` (committed the same evening) — `cast call --block 51226072` /
`cast code` calls, one per line and paced 0.4 s, against
`https://mainnet.base.org` (`https://base-rpc.publicnode.com` refuses pinned-block calls without a token — HTTP 403
"Archive requests require a personal token" — and `mainnet.base.org` rate-limits bursts, hence the pacing). No key,
nothing signed. A first pass at the tip (block 51,227,849, 20:30:45Z) is kept only for one observation: an hour after
the pinned read the cbZEC/USDC pool's tick was −24,181 and `liquidity()` 149,697,093,831 — the price had crossed the
−24,200 spacing boundary and the position holding most of the depth (L = 23,138,875,907,679 at the pinned block) was
out of range; the depth there is a few ticks wide. (Since 2026-09-13 the top section is generated by
`scripts/refresh-demo-snapshot.mjs` from `docs/research/ledger-read-<block>.json` and points here for it.)

**Raw words (block 51,226,072, chain 8453, timestamp 1,789,241,491).**

- Aave `getReserveData` liquidityRate / variableBorrowRate (ray, 1e27 = 100 %): cbBTC
  115,298,540,067,590,828,029,797 / 6,716,616,420,500,513,381,718,706 (`lastUpdateTimestamp` 1,789,241,353); WETH
  17,422,849,858,127,856,469,344,578 / 23,861,562,954,708,311,602,665,542 (1,789,241,361); USDC
  35,169,783,164,602,044,799,521,966 / 45,174,286,468,906,891,751,289,102 (1,789,241,465). Percent = ray × 100 / 1e27
  truncated at 1e-4 (`rayToPct`), the digits the table, the model and the demo carry. `getReserveConfigurationData`:
  cbBTC (decimals 8, LTV 7300, LT 7800, bonus 10750, reserve factor 5000), WETH (18, 8000, 8300, 10500, 1500), USDC
  (6, 7500, 7800, 10500, 1000), each collateral-enabled, borrowing-enabled, active, not frozen; `getPaused` false ×3;
  cbZEC: the call reverts.
- Chainlink `latestRoundData` (answer, `updatedAt`): BTC/USD 7,716,516,740,235 (1,789,241,265); ETH/USD
  252,038,469,819 (1,789,240,693); USDC/USD 99,986,476 (1,789,216,883); cbBTC/USD 7,714,083,271,370 (1,789,241,257).
  Answers are × 1e−8.
- Pyth `getPriceUnsafe(ZEC/USD)`: (103,519,851,737, 15,630,582, −8, 1,788,550,194).
- cbZEC/USDC pool: `slot0` sqrtPriceX96 23,621,847,466,826,436,891,048,482,815, tick −24,205, observation index 899,
  cardinality 2048 / 2048, unlocked; `liquidity()` 23,138,875,907,679; `fee()` 2000. Gauge `rewardRate()`
  7,140,520,125,989,201, `periodFinish()` 1,789,603,200.
- Compound USDC Comet `getUtilization()` 905,253,049,459,064,184 (90.53 %).
- `totalSupply()`: USDC 4,279,450,714,608,620; WETH 237,550,568,132,051,277,367,037; cbBTC 4,588,188,005,686; cbZEC
  131,186,968,779 (`multiplier()` 1,000,000,000,000,000,000); AERO 1,978,450,301,483,024,928,860,547,401.
- Code sizes (bytes): Morpho Blue 15,623; Permit2 9,152; GPv2Settlement 16,165; Pyth 680; cbZEC `0xef`.

**Where the digits went (same commit).** `web/lib/demo.ts` (`DEMO_SNAPSHOT_AT` 2026-09-12T19:31:31Z,
`DEMO_SNAPSHOT_BLOCK`, `DEMO_MARKET`, and the pool price the demo spot quote uses for cbZEC), `web/lib/copy.ts` (the
demo banner's date), `prototype/index.html` and `prototype/simple.html` `OIL_CHAIN_READ` (byte-equal), and the tests
that had typed the old digits (`web/test/wizard.test.ts`, `model-numbers.test.ts`, `e2e/demo-flow.spec.ts`,
`prototype/test/verify-*.mjs`), which now derive them from the snapshot object instead.

## Addendum 15 — CCTP V2 on Base, 2026-09-13: where the facts live, and the fork run that used them

Circle's Cross-Chain Transfer Protocol (CCTP) V2 contracts on Base are recorded in `docs/VERIFIED-SOLANA-FACTS.md`
because the loop they serve is the Solana module's (BUILD-PLAN D6): **Addendum 1** (2026-09-12 20:10 UTC, block
51,227,239) for the three proxies, the fee API and the domain ids, **Addendum 3** (2026-09-13 03:11–03:16 UTC,
blocks 51,239,874 / 51,239,965) for the implementations behind the proxies, the verified ABIs, the message
byte layout and the Solana side. `script/Deploy.s.sol::BaseAddresses` mirrors four of them — TokenMessengerV2
`0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d`, MessageTransmitterV2 `0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`,
domain 6 (Base), domain 5 (Solana) — pinned by `test/Deploy.t.sol`.

**Fork run, block 51,222,568 (the suite's pin), `mainnet.base.org`, 2026-09-13:** `test/fork/BaseFork.t.sol`
`test_fork_cctpV2_theAccountsBurnLegBurnsNativeUsdcToASolanaRecipient` — the messenger's
`localMessageTransmitter()` is the recorded transmitter, whose `localDomain()` is 6 and `version()` 1;
`messageBodyVersion()` 1; `remoteTokenMessengers(5)` is Solana's TokenMessengerMinterV2 as bytes32; an
`OilskinAccount`'s approve → `depositForBurn(1,000 USDC, 5, recipient, USDC, 0, maxFee 2 USDC, 1000)` → approve-zero
burned 1,000 native USDC (FiatToken `totalSupply()` fell by exactly 1,000,000,000 base units) and emitted Circle's
`DepositForBurn` with our recipient and domain. Note for the next runner: `base-rpc.publicnode.com` does not
serve state at that block (the whole fork suite's `setUp` reverts there); `mainnet.base.org` does.

## Addendum 16 — a Chainlink ZEC/USD feed EXISTS on Base, read live 2026-09-13 at block 51,260,504 (14:39:15 UTC)

**This supersedes "There is no Chainlink ZEC/USD feed on Base" in the Chainlink section above and every
claim built on it** (`BASE-PIVOT-2026-09.md` §3b, `CBZEC-2026-09.md`, `docs/research/*`,
`packages/shared/src/base.ts` `CHAINLINK_ZEC_USD = null`). The founder supplied the proxy address on
2026-09-13; every line below was read read-only with `cast call` against `https://mainnet.base.org`.
No code depends on it yet — this addendum is the prerequisite, not the change.

| | Value |
|---|---|
| **Proxy (the address to integrate)** | `0x69e5BC4988a9AF30Ec827C5609c0D41028446ec0` |
| `description()` | **"ZEC / USD"** — ZEC, **not** cbZEC (see the peg note below) |
| `decimals()` | **18** — every other Chainlink feed on Base in this file is **8** |
| `version()` | 6 |
| `phaseId()` | 1 |
| Underlying `aggregator()` | `0xb00e68fb3754EE8CC7B5F61348a2f09d53fB2e0e` (23,186 B) |
| Aggregator `typeAndVersion()` | **"DualAggregator 1.0.0"** — not the classic `AccessControlledOffchainAggregator` |
| Aggregator `minAnswer()` / `maxAnswer()` | 1 / 95,780,971,304,118,053,647,396,689,196,894,323,976,171,195,136,475,135 (≈9.578e52) — **effectively unbounded; the aggregator provides no usable circuit breaker** |
| `owner()` (proxy and aggregator) | `0xf0Db7318A51a21C413CaDd4AbDC1E8a500fE5B1b` |
| Live `latestRoundData()` | roundId 18446744073709552619 (phase 1, round 1003), answer **1,097,340,468,259,499,400,000** = **$1,097.3405** at 18 dp, `updatedAt` 1,789,310,019 → **336 s old** at the tip read (block 51,260,504, ts 1,789,310,355) |

**Provenance.** `owner()` on this proxy is the SAME address that owns all four Chainlink feeds this
file already verified (BTC/USD, ETH/USD, USDC/USD, cbBTC/USD — each re-read 2026-09-13 and each
`decimals() == 8`). The answer also matches the market price of ZEC at read time (~$1,096–1,102 from
two independent token trackers). That is the evidence it is genuinely Chainlink's, not a look-alike.

**Measured update cadence (rounds 996 → 1003, read one by one).** Gaps between `updatedAt`, newest first:
**1,350 s · 1,052 s · 1,110 s · 270 s · 270 s · 242 s · 3,090 s**. Prices across that window ran
$1,077.35 → $1,102.97, about a 2.4 % range, so the short gaps are deviation-driven and the long ones are
the quiet-market floor. **Largest gap observed: 3,090 s (51.5 min).** The heartbeat and deviation
threshold are NOT published by any getter on this contract and have NOT been read from a primary
source — do not type one.

**Correction, same day.** A first pass here proposed 6,180 s as a max-age bound, from the keeper's
`buildFeedPolicies` rule (`max(ceil(max gap × 2), 300 s)`) over that eight-round sample. The fork test
added in the same commit disproves it: at the pinned fork block 51,222,568 (2026-09-12T17:34:43Z) the
feed's latest round was round 967 at `updatedAt` 1,789,226,255, answer $1,142.3308 — **8,228 s old**,
longer than the largest gap the sample contained. The sample was drawn from an active window and does
not bound the quiet-market cadence. No max-age is pinned anywhere in the tree as a result: it is a
deploy-time parameter of `ChainlinkOracleAdapter`, and choosing it needs either Chainlink's published
heartbeat or a measurement over a much longer window.

**Three things that must be true of any integration.**

1. **18 decimals, not 8.** Every existing consumer here assumes 8 (`packages/shared/src/base.ts`
   `CHAINLINK_FEEDS` entries carry `decimals: 8`; the web's base-unit helpers; the Aave oracle path).
   The keeper's valuation already reads `decimals` from the feed and calls `normaliseTo8` on it, so it
   is safe by construction, but anything that assumes 8 is off by 10^10. This is the Moonwell cbETH
   failure class recorded in `docs/research/CAPITAL-AND-VENUES-2026-09.md` ($1.78 M of bad debt from an
   integrator using the wrong price basis).
2. **It prices ZEC, not cbZEC.** The wrapper peg and the B20 `multiplier()` are separate risks, exactly
   as they were under Pyth. The existing `PythOracleAdapter` design — price source plus an Aerodrome
   cbZEC/USDC TWAP cross-check plus a max-age bound, failing closed — carries over unchanged; only the
   price source would swap. `RISKS.md` §5 and `BASE-PIVOT-2026-09.md` §3b state the requirement.
3. **No circuit breaker from the aggregator.** `minAnswer`/`maxAnswer` are effectively unbounded, so the
   TWAP breaker and the staleness bound are the only protections. Do not rely on the feed to bound itself.

**Not yet known** (do not invent): the official heartbeat and deviation threshold; whether Chainlink lists
this feed in its public reference directory (the Base directory JSON did **not** contain any ZEC entry
when fetched on 2026-09-13, and a Blockscout contract search on Base surfaced only tokens); whether a
cbZEC/USD feed, as opposed to this ZEC/USD one, exists or is planned.

