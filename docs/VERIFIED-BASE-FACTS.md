# Verified Base mainnet facts for the Base-first build (read live 2026-09-05 ~01:00 UTC, chain id 8453)

Method: `eth_getCode` / `eth_call` against public Base RPCs from a networked sandbox, selectors computed with
`cast sig`. **Every address below has been confirmed to hold code and to answer the calls stated.** Anything not
listed here is unverified and must be probed before code depends on it — this is the rule that would have caught
the C-2 mainnet-bricking bug (see `AUDIT-FINDINGS-2026-09-03.md`).

## Tokens (all verified: `symbol()`, `decimals()`, `totalSupply()`)

| Token | Address | Decimals | Total supply (live) | Notes |
|---|---|---|---|---|
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 6 | 4,250,344,054.96 | native Circle USDC |
| WETH | `0x4200000000000000000000000000000000000006` | 18 | 242,120.99 | OP-stack predeploy |
| cbBTC | `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf` | 8 | 45,244.24 | plain ERC-20 (code len 3,102) |
| **cbZEC** | `0xB2000000000000000000008501b13360000cb2EC` | 8 | **603.25** | **B20 precompile: `eth_getCode` returns `0xef`.** `name()` = "Coinbase Wrapped ZEC". `multiplier()` = 1e18 (rebase multiplier present, currently 1.0). `owner()` and `paused()` revert (not exposed). |
| AERO | `0x940181a94A35A4569E4529A3CDfB74e38FD98631` | 18 | 1,973,685,089.49 | |

## Aave v3 on Base (verified via PoolAddressesProvider → `getPool()` / `getPoolDataProvider()` / `getPriceOracle()`)

- PoolAddressesProvider `0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D`
- **Pool `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5`**
- PoolDataProvider `0x0F43731EB8d45A581f4a36DD74F5f358bc90C73A` (EIP-55 casing corrected 2026-09-05; the first print of this file had a non-checksum casing of the same hex, which viem's `getAddress` rejects — `packages/shared/src/base.ts` pins this form)
- AaveOracle `0x2Cc0Fc26eD4563A5ce5e8bdcfe1A2878676Ae156`

Reserve configuration, live (`getReserveConfigurationData`, bps) and rates (`getReserveData`, ray → %):

| Reserve | LTV | Liq. threshold | Liq. bonus | Collateral | Borrowable | Variable borrow APR | Supply APR |
|---|---|---|---|---|---|---|---|
| cbBTC | 73.00% | **78.00%** | 7.5% | yes | yes | 0.673% | 0.012% |
| WETH | 80.00% | **83.00%** | 5.0% | yes | yes | 2.454% | 1.843% |
| USDC | 75.00% | 78.00% | 5.0% | yes | yes | **4.828%** | 3.921% |
| cbZEC | — | — | — | **NOT LISTED** (config returns zeros) | | | |

Product implication: borrowing USDC against cbBTC at Aave costs **4.83%** today; the liquidation threshold that
drives our health-factor ladder is **0.78 for cbBTC and 0.83 for WETH** (per-asset, read from chain, never a constant).

## Chainlink price feeds on Base (verified `description()` + `latestRoundData()`)

| Feed | Address | Live answer | Age at read |
|---|---|---|---|
| BTC / USD | `0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F` | 79,593.77 | 109 s |
| ETH / USD | `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` | 2,453.45 | 625 s |
| USDC / USD | `0x7e860098F58bBFC8648a4311b374B1D669a2bc6B` | 1.00 | 44,475 s (heartbeat-driven) |
| cbBTC / USD | `0x07DA0E54543a844a80ABE69c8A12F22B3aA59f9D` | 79,630.89 | 833 s |

Aave's own sources: cbBTC → `0x3a932b286715abc4a86a4acaf68a6cdd89e0d446`, WETH → `0x9da00d23465282005db222a441a663ee7b9dfcc8`,
USDC → `0xf52d010c7d4ecbfda92c2509900593ce34535d86` (these are Aave's adapters, not the raw feeds).
**There is no Chainlink ZEC/USD feed on Base.**

## Pyth on Base (verified)

- Pyth contract `0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`
- `Crypto.ZEC/USD` price id `0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24`
- Live `getPriceUnsafe`: **$1,035.20 ± 0.16**, expo −8 — **but publishTime was 19,779 s (5.5 h) old**. Pyth is
  pull-based: the on-chain price is only as fresh as the last update anyone posted. **Any oracle adapter must pull
  a fresh update (Hermes) inside the same transaction and enforce a max age, or it is pricing stale data.**

## Aerodrome (verified)

- Voter `0x16613524e02ad97eDfeF371bC883F2F5d6C480A5`
- **cbZEC/USDC Slipstream pool `0x0Fc47C17AF86078d809358db1b4db2DeBC988566`** (EIP-1167 clone, code len 92):
  token0 = USDC, token1 = cbZEC, fee 2000 (0.2%), tickSpacing 200, slot0 tick −23228 → **≈ 1,020 USDC per cbZEC**
  (within 1.5% of Pyth's stale $1,035 — peg holding at read time), active liquidity L = 15,382,171,343,960.
- **Gauge for that pool EXISTS: `0x8779e34e5d38358b0cb957c553b40cc1208c81fb` — but `rewardRate() = 0` and
  `periodFinish() = 0`.** The gauge has been created and has never received an emissions vote. **cbZEC LP earns
  no AERO today.** (Emissions-only positions in this pool have zero yield until a vote lands.)
- The MaxFi/Snuggle engine facts (index-getter `userPositions(address,uint256)`, replace-on-rekey, total-span
  widths, `slot0()` on CL pools) are in `AUDIT-FINDINGS-2026-09-03.md` Part 1 and still hold.

## Other infrastructure (code presence verified)

- Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` — present (31,248 bytes). Market listing via the
  public GraphQL API failed on schema field names three times on 2026-09-05; the working query (`marketId`, not
  `uniqueKey`/`id`; `OracleFeed` has `address` only) and both chain-verified ids are in the Morpho addendum
  below. No cbZEC market exists (consistent with the research).
- Compound v3 USDC Comet `0xb125E6687d4313864e53df431d5425969c15Eb2F` — present; `baseToken()` = USDC;
  utilization **90.05%** (above the kink → borrow rate elevated; read the live rate before quoting it).
- Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` — present.
- CoW Protocol GPv2Settlement `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` — present.

## What this settles for the build

1. **v1 collateral = cbBTC and WETH on Aave v3**, with per-asset liquidation thresholds read from chain.
2. **cbZEC collateral is v1.1**: no market anywhere, no Chainlink feed, Pyth stale by default, ~$0.7M DEX depth.
3. **cbZEC LP has no emissions today** — offering it as a yield venue would be a lie until the gauge is voted.
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
- ~~**The engine's live end-of-list revert shape** for `userPositions(address,uint256)`~~ — **recorded 2026-09-10 at block 51,127,409 (Addendum 3): empty `0x`, at index 0 and at the canary index 2^256 − 1.** It is not `Panic(0x32)`, which is what `SnuggleLpVenue.positionsOf` pins, so the venue's enumeration fails closed against the live engine (`RISKS.md` §12).
- **cbZEC B20 policy state** (blocklist, pause) — `owner()` / `paused()` revert on the precompile; only `multiplier()` was read (1e18).
- **Gauge emissions** for the curated pools other than cbZEC/USDC — the yield model's inputs are the 2026-08-31 words (block 50675328), not this read.

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
exactly what Morpho pulls. The registry's derived offer is min(8600 / 1.55 = 5548, 8600, cap 5000) =
**50 %**, the same as on Aave. The oracle for the cbBTC market is Chainlink **BTC/USD** with no quote feed
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
`min(5000, floor(8500/1.55)) = 5000` bps for WETH and `min(5000, floor(8300/1.55)) = 5000` for WBTC —
same top rung as mainnet. The Sepolia USDC borrow rate (2.96 %) is a test-pool artefact; never quote it.

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
| AERO | `MockERC20` (18 dp) | reward token only; nothing emits it on Sepolia, matching the mainnet gauge's `rewardRate() = 0` |
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
| `test_fork_cbzecIsAB20WithLiveMultiplier` | **FAIL** — `EvmError: Revert`; the first external call, `cbZEC.decimals()`, dies with `OpcodeNotFound` | fail (same) | **A fork EVM cannot execute the B20 native contract.** `eth_getCode` returns the single byte `0xef`, which Base's node routes to a native implementation and which revm treats as an invalid opcode. Not chain drift: read live with `cast` at ≈ block 51,127,412 — `decimals()` 8, `symbol()` "cbZEC", `name()` "Coinbase Wrapped ZEC", `multiplier()` `0x…0de0b6b3a7640000` = **1e18 (unchanged)**, `totalSupply()` `110768465960` = **1,107.68 cbZEC** (603.25 on 2026-09-05). This test can only ever pass outside a fork; the harness limitation is recorded in `TESTING.md` |
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
| Engine end-of-list revert shape | never recorded | empty `0x` | **first measurement; contradicts the venue's `Panic(0x32)` pin** |
| Engine `poolIdsCount()` | not recorded | 214 | first measurement |
| Engine WETH/USDC entry the test lands on | assumed mintable | stub adapter, `NotImplemented()` | **first measurement** |
| Aave aToken / debt rounding | not recorded | −1 / +1 unit | **first measurement** |
| cbZEC/USDC pool `factory()` | assumed `0x5e7B…809A` | `0xf8f2…61Ef` | **first measurement; SwapRouter routing to this pool unverified** |
