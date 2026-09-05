# Project Oilskin — Capital, Oracle and Venue Research (Base / cbZEC)

*Compiled 2026-09-05. All figures are as-of the access date unless a source date is given. Every claim carries a URL; "(fetched 2026-09-05)" means the page was read on that date. Nothing here is a capital recommendation — scenarios only.*

---

## 0. Ground truth on cbZEC as of 5 Sep 2026

| Item | Value | Source |
|---|---|---|
| Token | Coinbase Wrapped ZEC (cbZEC), B20 token, **8 decimals**, address `0xB2000000000000000000008501b13360000cb2EC` | [BaseScan token page](https://basescan.org/token/0xB2000000000000000000008501b13360000cb2EC) (fetched 2026-09-05) |
| Launch | 1 Sep 2026, alongside cbHYPE; "No supply figures, trading volumes, or specific protocol integration details accompanied the initial rollout" | [Crypto Briefing, 2026-09-01](https://cryptobriefing.com/base-launches-cbhype-cbzec-coinbase-custody/) |
| Total supply | **603.247 cbZEC**, 231 holders, 4,989 transfers | BaseScan (above) |
| ZEC spot | ~$1,027 (CoinGecko), new 9-year high >$1,000 on 4 Sep 2026 after Grayscale ZEC ETF (NYSE, 25 Aug 2026) inflows and a short squeeze | [CoinGecko](https://www.coingecko.com/en/coins/zcash) (fetched 2026-09-05); [The Coin Republic, 2026-09-04](https://www.thecoinrepublic.com/2026/09/04/heres-why-zcash-price-soars-past-1000-whats-next-for-zec/) |
| **Entire cbZEC float in USD** | **≈ $0.48M–0.62M** (603 × $800–$1,030). This caps every lending scenario below. | derived |
| Aerodrome cbZEC/USDC pool | `0x0Fc47C17AF86078d809358db1b4db2DeBC988566`, created 1 Sep 2026 (unix 1788334787). Two DexScreener cache snapshots: **(A)** price $1,015, liquidity $822.7K = **54.1 cbZEC + 767,771 USDC**, 24h vol $647K, 2,356 txns; **(B)** price $815, liquidity $727.9K = 168.7 cbZEC + 590,455 USDC, 24h vol $635K | [DexScreener API](https://api.dexscreener.com/latest/dex/tokens/0xB2000000000000000000008501b13360000cb2EC) (fetched 2026-09-05, two cache states) |
| Pool type | Not verifiable via API; the extreme reserve skew (≈$55K cbZEC vs $768K USDC) is impossible for a 50/50 constant-product pool, so it is almost certainly a **Slipstream concentrated-liquidity pool** whose price has drifted toward the top of the LP range. Tick range unknown. | inference; flagged in §7 |
| Other venues | Uniswap v4 cbZEC/USDC ~$51–61K liquidity; v3 ~$5K; Hydrex ~$0.6K; long tail of memecoin/cbZEC v4 pools <$10K each | DexScreener API (above) |
| B20 standard | Native precompile token standard (Beryl upgrade); full ERC-20 call compatibility; adds PolicyRegistry allow/blocklists, `burnBlocked` freeze-and-seize, and independent pause on TRANSFER/MINT/BURN. Lending markets "must respect transfer blocklists… pausability (temporary TRANSFER pauses halt liquidations/transfers)". Explorers cannot yet read B20 admin metadata. | [Base docs: B20](https://docs.base.org/base-chain/specs/upgrades/beryl/b20); [Unchained, 2026-07-09](https://unchainedcrypto.com/coinbases-base-launches-a-native-token-standard-with-freeze-and-seize-built-in/) |

Two consequences that shape everything else: (1) a $500K borrow against cbZEC at any Morpho-enabled LLTV needs more cbZEC than exists (see §1c); (2) a B20 issuer-level TRANSFER pause would freeze liquidations of cbZEC collateral, a risk no curator framework currently prices.

---

## 1. Capital to stand up a cbZEC/USDC lending market — and ways to not own it

### 1a. Morpho Blue market creation on Base

| Question | Answer | Source |
|---|---|---|
| Permissionless? | Yes: "Creating a Morpho Market is permissionless." | [Morpho docs: Market](https://docs.morpho.org/learn/concepts/market/) (fetched 2026-09-05) |
| What a market needs | `createMarket(MarketParams{loanToken, collateralToken, oracle, irm, lltv})`; LLTV is 18-dec (1e18 = 100%, not enabled) | [Morpho docs: Create a Market](https://docs.morpho.org/curate/tutorials-market-v1/creating-market/) |
| Enabled LLTV set | **0%, 38.5%, 62.5%, 77.0%, 86.0%, 91.5%, 94.5%, 96.5%, 98.0%** (governance-approved) | Morpho docs: Market (above) |
| Enabled IRM | Only **AdaptiveCurveIRM** (Base: `0xd334eb112CfD1EB4a50FB871b7D9C28f46B829f`) | Morpho docs: Market; [Morpho addresses](https://docs.morpho.org/get-started/resources/addresses/) |
| Oracle | Any contract implementing `IOracle.price() returns (uint256)` = price of 1 unit of collateral in loan token, scaled 1e36 × 10^(loanDec − collDec). Reference impl `MorphoChainlinkOracleV2` + factory; Chainlink, RedStone, API3, Pyth, Chronicle all listed as compatible | [Morpho docs: Oracle](https://docs.morpho.org/learn/concepts/oracle/) |
| Immutable? | Yes: markets are "immutable (cannot be changed after deployment)… once created, rules never change" | Morpho docs: Market |
| Base core contract | Morpho Blue `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb`; MorphoChainlinkOracleV2Factory `0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d` (BaseScan label) / docs also list `0x3585E3fD72F8d1b02250E1F6496b706c6e092884`; Vault V1.1 factory `0x83A7f60c9fc57cEf1e8001bda98783AA1A53E4b1`; Vault V2 factory `0xecCd168c7d8e40f7166Fe226B4cf2cA3Db7A9754`; Bundler3 `0x1FA4431bC113D308beE1d46B0e98Cb805FB48C13` | [BaseScan](https://basescan.org/address/0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb); [BaseScan oracle factory](https://basescan.org/address/0x2DC205F24BCb6B311E5cdf0745B0741648Aebd3d); Morpho addresses page. **Two factory addresses appear in different sources — verify on-chain before use (§7).** |
| Gas | Not published by Morpho. Base user actions on Morpho run "sub-$0.01" per Morpho's CEO (June 2024); `createMarket` + oracle deploy + first supply is a handful of transactions — expect **cents, not dollars**. | [Paul Frambot on X, 2024-06](https://x.com/PaulFrambot/status/1803349801871847631) |
| Anti-inflation seed | Docs recommend supplying ≥1e9 shares on behalf of `0x…dEaD` for "permanent protection" against share-inflation front-running | Morpho docs: Create a Market |
| Liquidation incentive | `LIF = min(1.15, 1/(0.3·LLTV + 0.7))` → **62.5% LLTV ⇒ 12.7% bonus; 77% ⇒ 7.4%; 86% ⇒ 4.4%; 38.5% ⇒ 15% (cap)**. Partial liquidations allowed. Bad debt (debt left with zero collateral) is realized and socialized across the market's suppliers. | [Morpho docs: Liquidation](https://docs.morpho.org/learn/concepts/liquidation/) |
| Protocol fee | Morpho takes **0%** on markets today ("Morpho Blue – No revenue for Morpho protocol"); DAO cap is 25% | [DefiLlama: Morpho](https://defillama.com/protocol/morpho) (fetched 2026-09-05) |

Bottom line: **creating** the market costs ~nothing. All the capital is in (i) supplying USDC and (ii) absorbing bad debt.

### 1b. Morpho Vaults (V1 "MetaMorpho" and V2)

| | Vault V1 / V1.1 (MetaMorpho) | Vault V2 |
|---|---|---|
| Creation | Permissionless via factory (`0x83A7…E4b1` on Base) | Permissionless via factory (`0xecCd…9754` on Base); "permissionless vault framework" |
| Roles | Owner, Curator, Allocator, Guardian | Owner (appoints Curator/Sentinels), Curator (adapters, caps, fees, rate limits), Allocator (executes `allocate` to adapters), Sentinel (can only de-risk) |
| Allocation | Owner/curator enables markets and sets per-market supply caps (timelocked); allocator moves funds | Allocates through **adapters** (Morpho Market V1 adapter etc.); curator sets **absolute and relative caps** per id (e.g. "max 20% of vault to any market using a specific new oracle") |
| Timelock | Cap increases timelocked; fee changes immediate in V1 | "All potentially harmful curator actions are protected by configurable timelocks (0 to 3 weeks)"; fee changes timelocked |
| Fees | Performance fee only, **max 50%** of interest | Performance fee **max 50%** of yield + management fee **max 5%/yr** of totalAssets; both minted as shares to fee recipients on interaction |
| Bad debt | V1.0 realizes and socializes; **V1.1 does not auto-realize bad debt** (persists until manual action); V2 realizes via `convertToAssets` | Morpho docs: Liquidation |
| Sources | [Fees](https://docs.morpho.org/curate/concepts/fee/); [Vault V2](https://docs.morpho.org/learn/concepts/vault-v2/); [Addresses](https://docs.morpho.org/get-started/resources/addresses/) | |

**What leading curators actually charge** (performance fee on interest; secondary reporting, treat as ±):

| Curator | Fee observed | Assets curated (Morpho) | Source |
|---|---|---|---|
| Steakhouse Financial | 15% (Eco); **25% on the Coinbase-routed USDC vault, shared with Coinbase** (Yahoo/CoinDesk) | $1.79B (Morpho data page) | [Eco, 2026](https://eco.com/support/en/articles/14745618-best-stablecoin-vaults-in-2026); [Yahoo Finance, 2025-10](https://finance.yahoo.com/news/coinbase-profits-bitcoin-backed-loans-183845343.html); [data.morpho.org/curation](https://data.morpho.org/curation) |
| Gauntlet | 15% (Eco) | $252M | same |
| Re7 Labs | 10–15% | n/a on Base list | same |
| MEV Capital | 12–15% | — | same |
| Block Analitica (+B.Protocol, curates Moonwell's Morpho vaults) | 15% | — | same |
| Spark (SparkLend USDC vault on Morpho) | 10% of a ~6% APY | ~$700M | Yahoo Finance (above) |
| Yearn | 5–10% of native lending APY; 10% on V3 allocator vaults | $200M+ | [Yearn docs](https://docs.yearn.fi/getting-started/products/curating/morpho-curating) |
| Armitage (Wintermute) | undisclosed | $121M | [data.morpho.org/curation](https://data.morpho.org/curation) |
| Protocol-wide | "Annualised curation fees" **$11.4M** across 36 curators / $4.0B curated | data.morpho.org/curation (fetched 2026-09-05) |

Curator range in practice: **5%–25%** of interest, clustered at 10–15%. On a $500K market earning 4% that is $200–1,000/yr — no professional curator will engage for the fee; they engage for Coinbase/ecosystem strategic reasons or because someone else brings the capital.

### 1c. Economics of self-seeding $500K / $1M USDC

**Interest model.** AdaptiveCurveIRM constants: target utilization 90%, curve steepness 4, initial rateAtTarget 4%/yr, min 0.1%, max 200%, adjustment speed 50/yr ([ConstantsLib.sol](https://github.com/morpho-org/morpho-blue-irm/blob/main/src/adaptive-curve-irm/libraries/ConstantsLib.sol)). Below target, borrow APR = rateAtTarget × (0.75·err + 1) with err = (u−0.9)/0.9, and rateAtTarget decays exponentially toward the 0.1% floor while utilization stays below 90%.

**Demand ceiling.** All 603 cbZEC deposited at $1,000 supports at most **$377K** of debt at 62.5% LLTV or **$465K** at 77% — and nobody deposits 100% of the float. A realistic near-term demand band is $50K–$250K.

| Supply | Borrow | Util | Borrow APR day 0 | Supply APR day 0 | Borrow APR after 30 d | Supply APR after 30 d | Founder $/yr (30-d rate) |
|---|---|---|---|---|---|---|---|
| $500K | $50K | 10% | 1.33% | 0.13% | 0.03% | 0.00% | $17 |
| $500K | $100K | 20% | 1.67% | 0.33% | 0.07% | 0.01% | $68 |
| $500K | $250K | 50% | 2.67% | 1.33% | 0.43% | 0.21% | $1,073 |
| $500K | $400K | 80% | 3.67% | 2.93% | 2.32% | 1.86% | $9,290 |
| $500K | $450K | 90% | 4.00% | 3.60% | 4.00% | 3.60% | $18,000 |
| $1M | $100K | 10% | 1.33% | 0.13% | 0.03% | 0.00% | $35 |
| $1M | $250K | 25% | 1.83% | 0.46% | 0.09% | 0.02% | $236 |
| $1M | $450K | 45% | 2.50% | 1.13% | 0.32% | 0.14% | $1,441 |
| $1M | $900K | 90% | 4.00% | 3.60% | 4.00% | 3.60% | $36,000 |

Reading: **over-seeding drives the rate to the floor within weeks**; at plausible demand ($100–250K) a $500K–$1M self-seed earns tens to low-hundreds of dollars a year. The market only "works" for the lender at ≥80–90% utilization, i.e. when supply is sized to demand (≈$100–300K), not to the raise. Morpho takes 0%; a vault wrapper would take 5–25% of that interest.

**Bad-debt exposure — the liquidation-impact model.**

Assumptions (all stated; model script in the appendix):
- Collateral is sold into the Aerodrome cbZEC/USDC pool only (no CEX unwind, no other venues, no new LPs). Uniswap v3-style single-position math: selling Δx cbZEC moves √P by Δx/L; USDC out = L(√P₀ − √P₁); the range is exhausted when √P hits √pₐ.
- The pool's **USDC side** (what a liquidator sells into) is taken from the two DexScreener snapshots: **A = 767,771 USDC at P₀ = $1,015** and **B = 590,455 USDC at P₀ = $815**.
- Because the tick range is unknown, three shapes are modelled: liquidity's USDC spread evenly (in √P space) down to **−20% (tight)**, **−50% (medium)**, **−80% (wide)** below spot. Tight is the most favourable at spot and the most dangerous in a crash.
- Liquidation fires exactly at the LLTV boundary at the oracle price; the liquidator seizes debt × LIF worth of cbZEC (LIF 1.127 at 62.5% LLTV, 1.074 at 77%) and sells it all at once. Liquidator PnL = USDC received − debt repaid. Negative PnL ⇒ nobody liquidates ⇒ bad debt accrues to suppliers.
- Swap fee ignored for CL (fee tier unknown); 0.3% in the v2 benchmark.

*Snapshot A (P₀ = $1,015, 767.8K USDC), liquidation at spot:*

| LLTV | Debt | cbZEC sold | USDC out (tight / medium / wide) | Price impact (t/m/w) | Liquidator PnL (t/m/w) |
|---|---|---|---|---|---|
| 62.5% | $100K | 111 | $111.0K / $108.0K / $104.2K | 1.5% / 4.1% / 7.5% | +$11.0K / +$8.0K / +$4.2K |
| 62.5% | $250K | 277 | $271.2K / $254.4K / $234.2K | 3.7% / 9.7% / 16.9% | +$21.2K / +$4.4K / **−$15.8K** |
| 62.5% | $500K | 555 | $522.9K / $463.7K / $400.8K | 7.2% / 17.7% / 28.9% | +$22.9K / **−$36.3K** / **−$99.2K** |
| 77% | $100K | 106 | $105.8K / $103.2K / $99.7K | 1.5% / 3.9% / 7.2% | +$5.8K / +$3.2K / −$0.3K |
| 77% | $250K | 264 | $259.0K / $243.6K / $225.0K | 3.6% / 9.3% / 16.2% | +$9.0K / **−$6.4K** / **−$25.0K** |
| 77% | $500K | 529 | $500.1K / $445.7K / $387.3K | 6.9% / 17.0% / 27.9% | +$0.1K / **−$54.3K** / **−$112.7K** |
| v2 benchmark (768K USDC + 756 cbZEC) | $100K / $250K / $500K @62.5% | | $98.0K / $205.6K / $324.4K | 13% / 27% / 42% | **−$2.0K / −$44.4K / −$175.6K** |

*Snapshot B (P₀ = $815, 590.5K USDC) is uniformly worse: at 62.5% LLTV the $250K position is already loss-making in the medium shape (−$2.8K) and the $500K position loses $60K–$131K.*

*Crash scenario — ZEC −30% before the liquidation fires (snapshot A ranges, no new LPs):*

| Shape | USDC left in pool at $711 | $100K @62.5% | $250K @62.5% | $500K @62.5% |
|---|---|---|---|---|
| Tight (−20%) | **$0 — range exhausted, DEX depth is zero** | no DEX exit | no DEX exit | no DEX exit |
| Medium (−50%) | $339.6K | +$7.2K (4.9% impact) | −$0.4K (11.4%) | **−$160.4K, pool exhausted** |
| Wide (−80%) | $540.9K | +$2.7K (8.8%) | −$23.3K (19.5%) | −$120.6K (32.7%) |

*Largest single position that still liquidates at break-even, one shot, DEX only (snapshot A / B):*

| Shape | 62.5% LLTV | 77% LLTV |
|---|---|---|
| Tight | $768K / $590K (= the whole USDC side) | $502K / $386K |
| Medium | **$295K / $227K** | $181K / $139K |
| Wide | $156K / $120K | $96K / $74K |

Interpretation, without recommending anything:
- A **$100K** position liquidates profitably in every shape at spot and survives a −30% crash unless the LP range is tight; it is the only size that is robust to the unknowns.
- A **$250K** position is safe only if the Aerodrome LP range is tight-to-medium *and* the crash hasn't already emptied it; in the wide/crash cases the liquidator loses $16–24K and the market eats it.
- A **$500K** position **cannot exist today** (needs 800 cbZEC at 62.5% vs 603 in existence) and, if supply grew, would be uneconomic to liquidate in every shape except "tight at spot", where the entire pool would have to be consumed.
- The v2 benchmark shows why the pool type matters: with the same USDC, constant-product depth would make even $100K marginal.
- The offsetting fact (not in the model): cbZEC is 1:1 redeemable for ZEC on Coinbase, and ZEC does ~$1.3B/day globally ([CoinGecko](https://www.coingecko.com/en/coins/zcash)). Anthias Labs made exactly this argument for cbXRP on Moonwell — "liquidators can tap into CEX liquidity rather than being constrained by on-chain liquidity, using Coinbase as a bridge" ([Moonwell forum, 2025-06-09](https://forum.moonwell.fi/t/add-cbxrp-market-to-moonwell-on-base/1753)). Wintermute's Armitage sells exactly this: "Wintermute is able to execute liquidations itself across every supported market. As a result, Armitage will accept collateral types that other curators cannot" ([Wintermute, 2026-05-19](https://www.wintermute.com/insights/news/wintermute-launches-armitage-bringing-its-defi-and-trading-expertise-to-vault-curation)). The CEX path requires a KYC'd Coinbase account, unwrap latency, and works only while Coinbase's mint/redeem window is open — it does not help in a B20 TRANSFER pause.
- Who eats the loss: if the founder is the only supplier, 100% of bad debt is his; in a V1.1 vault it sits unrealized; in a market with third-party suppliers it is pro-rata.

### 1d. "Liquidity as a service" — can someone else's capital bootstrap the market?

| Route | What exists | Terms observed | cb-asset precedent | Sources |
|---|---|---|---|---|
| **Professional curators allocating existing vault TVL** (Steakhouse, Gauntlet, Re7, MEV Capital, Block Analitica, Armitage, Clearstar, kpk…) | The standard bootstrap: a curator adds the new market to an existing USDC vault with a cap. The curator supplies *depositors'* money, not its own. | Curator keeps 5–25% of interest (table above); the market creator typically pays nothing but must deliver an oracle the curator accepts, and on Base curators have overwhelmingly required Chainlink | **cbBTC**: Block Analitica/B.Protocol proposed cbBTC/USDC (86%) and cbBTC/WETH (91.5%) markets on Base and Ethereum with Chainlink BTC/USD and 20M USDC caps on **15 Sep 2024, three days after cbBTC launched** ([Morpho forum](https://forum.morpho.org/t/adding-cbbtc-collateral-on-blockanalitica-b-protocol-flagship-vaults/789)). **cbXRP/cbDOGE/cbADA/cbLTC**: Coinbase turned on Morpho-routed loans on 18 Feb 2026 at 49% max LTV / 62.5% liquidation, $100K cap per borrower ([The Block, 2026-02-18](https://www.theblock.co/news/business/2026-02-18-coinbase-xrp-dogecoin-cardano-litecoin-loans-morpho-390403)); a cbXRP/USDC 62.5% market exists on Base ([Morpho app](https://app.morpho.org/base/variable/0xd4a903dc6d949519060c7707f9604fdc9772c046e05c2e3a8fce0bd7196e4109/cbxrp-usdc)). Curator/oracle/initial supply for that market could not be read from the JS-rendered page (§7). | |
| **Wintermute Armitage** | Curation arm launched 19 May 2026 with two USDC vaults on Morpho, explicitly positioned to accept "collateral types that other curators cannot" because Wintermute self-liquidates | Fees undisclosed; whether Wintermute commits proprietary capital is not stated | None public for cb-assets yet | [Wintermute, 2026-05-19](https://www.wintermute.com/insights/news/wintermute-launches-armitage-bringing-its-defi-and-trading-expertise-to-vault-curation); [Crypto Briefing on USDT vaults](https://cryptobriefing.com/armitage-usdt-vaults-morpho-expansion/) |
| **Market makers (GSR, Keyrock, Flowdesk)** | Sell "DeFi liquidity"/"liquidity pool management" as a service to *token issuers*; standard model is the issuer lends inventory + pays a retainer/option package; they LP DEX pools, they do not lend USDC into money markets for third parties | Bespoke; no public rate card | No public cb-asset engagement | [GSR DeFi liquidity](https://www.gsr.io/defi-liquidity); [Keyrock LP management](https://keyrock.com/service/liquidity-pool-management/); [Spark comparison](https://www.spark.money/tools/crypto-market-maker-comparison) |
| **Morpho ecosystem programs** | Morpho DAO pays MORPHO/URD rewards on selected vaults/markets (~$12.9M/yr of incentive distributions per DefiLlama); reward campaigns are permissionless via Merkl/URD (anyone can fund) | You fund the campaign; Morpho DAO co-funding is discretionary | Rewards were used on cbBTC markets in 2024–25 | [DefiLlama: Morpho](https://defillama.com/protocol/morpho); [Morpho docs: Rewards](https://docs.morpho.org/learn/concepts/rewards/) |
| **Base ecosystem** | Base Ecosystem Fund = Coinbase Ventures pre-seed/seed equity (no check size published); **Base Batches: $100K investment + demo day**; partner credits (AWS/Azure/Alchemy), priority onramp/Coinbase Prime access. No DEX-liquidity or lender-capital program. | Equity | — | [Base docs: Get funded](https://docs.base.org/get-started/get-funded) (fetched 2026-09-05) |
| **Aerodrome** | Emissions go where veAERO votes go; anyone can post voter incentives ("bribes") on a gauge; "Top protocols engaging in the Aerodrome flywheel in positive sum ways will qualify for a veAERO voting power grant for the duration of their programs" | Grant of voting power, not capital; you still need LPs | The cbZEC gauge has no votes yet (founder's observation) | [Aerodrome tokenomics (Medium)](https://medium.com/@aerodromefi/aerodrome-launch-tokenomics-30b546654a91); [Blockworks Aerodrome dashboard](https://blockworks.com/insights/aerodrome-finance) (TVL $240M, ~50–55% AERO locked) |
| **Coinbase itself** | Coinbase routes its own users' USDC into Steakhouse-curated Morpho vaults ("nearly $500 million in USDC deposits into Morpho vaults on Base" by Aug 2026) and its borrow product into Morpho markets; cbXRP/cbDOGE/cbADA/cbLTC got their Coinbase-routed markets **~8.5 months** after token launch | Coinbase collects a one-time origination fee and a share of the 25% Steakhouse performance fee | This is the only route with actual lender capital pre-committed | [Crypto Briefing, 2026-08-17](https://cryptobriefing.com/base-onchain-lending-usdc-vaults/); [The Defiant, 2026-06-11](https://thedefiant.io/news/cefi/coinbase-usdc-lending-vaults-morpho-steakhouse-ethena-risk-tier); Yahoo Finance (above) |

**Did any cb-asset get its first lending market bootstrapped by leased capital?** Not that is documented. The pattern is: (1) Chainlink feed appears before/at launch, (2) a governance-run pool (Moonwell) or an existing curated vault (Block Analitica/B.Protocol, Gauntlet, Seamless) lists it within days using depositors' capital, (3) Coinbase's own product follows months later. cbXRP specifically: launched 5 Jun 2025 with ~2.3M tokens; **Moonwell proposal filed the same day** with Gauntlet recommending 70% CF, 1M cbXRP supply cap, 500K borrow cap, 30% reserve factor, Chainlink oracle `0x9f0C1dD78C4CBdF5b9cf923a549A201EdC676D34`; Moonwell "grew to $1.2M in cbXRP liquidity"; Aave TEMP CHECK 10 Aug 2025 (LTV 60/LT 69/LB 9%, caps 400K/200K cbXRP) citing "combined DEX depth exceeds $375k"; Coinbase Morpho loans 18 Feb 2026 ([99Bitcoins, 2026-07-30](https://99bitcoins.com/news/altcoins/cbxrp-defi-doppler-finance-base/); [Moonwell forum](https://forum.moonwell.fi/t/add-cbxrp-market-to-moonwell-on-base/1753); [Aave TEMP CHECK](https://governance.aave.com/t/temp-check-onboard-cbxrp-to-aave-v3-base-instance/22877)). Note the Aave proposal was willing to cap at ~$1.27M supply against $375K of DEX depth — a 3.4× ratio; cbZEC's ratio today would be ~0.6–0.8× (float vs USDC depth), i.e. the *whole float* is smaller than the pool.

### 1e. Alternatives: Euler v2, Compound v3, Aave

| Venue | Model | Time / cost to list cbZEC | Sources |
|---|---|---|---|
| **Euler v2 (EVK) on Base** | Permissionless vault deployment via factory; governed vaults (curator sets LTVs, caps, IRM, oracle router) or ungoverned/immutable; escrow vaults; cross-vault collateral via EVC. Oracle router supports Chainlink, Pyth, RedStone, Chronicle, API3, TWAPs. Euler Earn aggregator vaults: performance fee capped at 50%. Curators active: Gauntlet, Re7, MEV Capital, Apostro, K3, Alterscope, Tulipa, Swaap. Audits: Spearbit, ChainSecurity, Certora, OpenZeppelin, Cantina competition. v1 lost $197M in Mar 2023 (returned). **Base TVL only $14.8M** of $355M total (Monad $244M). | Same as Morpho: minutes and cents to deploy; capital problem identical; Base liquidity/liquidator ecosystem thinner than Morpho's $3.3–4.0B | [Eco: Euler v2](https://eco.com/support/en/articles/14800904-euler-v2-modular-lending-vault-design); [OAK Research, 2025-06](https://oakresearch.io/en/analyses/fundamentals/deep-dive-into-euler-products-vaults-markets-earn-eulerswap); [Euler Earn docs](https://docs.euler.finance/developers/euler-earn/creating-managing-vaults/); [DefiLlama: Euler](https://defillama.com/protocol/euler) (fetched 2026-09-05); [Euler on Base](https://euler.finance/blog/euler-is-live-on-base) |
| **Compound v3 (Comet) on Base** | Governance-listed collateral only. Process: forum request with checklist → community/Gauntlet risk analysis + simulations → deploy aux contracts → optional OpenZeppelin proposal audit → on-chain vote → post-launch parameters. **Price feeds must implement Chainlink `AggregatorV3Interface`**. Compound paused deposits across seven LST/LRT listings on 1 Sep 2026 — appetite for long-tail collateral is low. | Weeks to months; needs a Chainlink feed first | [OpenZeppelin listing process](https://github.com/OpenZeppelin/compound-assets-listing/blob/master/Process.md); [CryptoTimes, 2026-09-01](https://www.cryptotimes.io/2026/09/01/compound-pauses-new-deposits-across-seven-lst-lrt-listings/) |
| **Aave v3 on Base** | Technical Asset Listing Framework (28 May 2026, post-KelpDAO $293M exploit): "A Chainlink price feed must exist on the target chain"; no fee-on-transfer/ERC777/whitelisting; upgrade authority ≥ multisig with 48h timelock; recent audit with no open Crit/High; bug bounty; annual re-review. Governance Framework v2 (20 Jul 2026): ARFC 4 d → Snapshot 4 d → AIP 3–10 d vote + 1–7 d timelock = **13 days standard** (9 days direct-to-AIP) *after* Chaos Labs/LlamaRisk sign off. B20 freeze/seize and blocklist semantics would be scrutinized under the "address whitelisting" and "burning cannot target arbitrary user wallets" clauses. | Realistically 1–3 months from feed availability; cbXRP's TEMP CHECK (Aug 2025) has no visible AIP outcome (§7) | [Aave ARFC: Technical Asset Listing Framework](https://governance.aave.com/t/arfc-technical-asset-listing-framework/24988); [Aave ARFC: Governance Framework v2](https://governance.aave.com/t/arfc-governance-framework-v2/25348); [CoinDesk, 2026-05-07](https://www.coindesk.com/business/2026/05/07/aave-to-overhaul-collateral-and-listing-standards-after-kelpdao-exploit) |
| **Moonwell** | Governance pool that listed cbXRP day-1 — but see §4: three oracle-driven losses in 11 months ($11.5M), all Base core-market borrows capped at 1 wei after 27 Aug 2026 | Not a venue to build on right now | [TechTimes, 2026-08-27](https://www.techtimes.com/articles/325839/20260827/moonwell-oracle-exploit-exceeds-full-annual-revenue-third-failure-11-months.htm) |

### 1f. "Build and wait": how fast have Aave/Morpho markets appeared after cb-asset launches?

| Asset | Launch | First Morpho market/vault | First Aave listing | Chainlink feed | Coinbase's own loans |
|---|---|---|---|---|---|
| cbBTC | 12 Sep 2024 | Forum proposal to add cbBTC/USDC 86% + cbBTC/WETH 91.5% on Base & Ethereum: **15 Sep 2024 (+3 d)** | ARFC 10 Sep 2024 (pre-launch); Chaos/LlamaRisk 13 Sep; Snapshot ~23 Sep; live ~25 Sep 2024 (**~2 weeks**); Merit incentives 24 Oct 2024; 63% of cbBTC supply on Aave by 31 Oct | BTC/USD used initially; dedicated CBBTC/USD proxy on Base created 1 May 2026 | Jan 2025 (cbBTC-backed USDC loans; >$1B originated by Oct 2025) |
| cbXRP / cbDOGE | 5 Jun 2025 | Moonwell proposal same day; Morpho cbXRP/USDC 62.5% market exists (date not verifiable) | TEMP CHECK 10 Aug 2025 (+66 d); outcome not verified | cbXRP/USD proxy created **28 May 2025 (8 days before launch)** | 18 Feb 2026 (**+258 d**) |
| cbADA / cbLTC | 26 Jun 2025 (cbADA ~$1.7M, cbLTC ~$1M supply in 24h) | — | — | ADA/USD exists on Base; no LTC/USD in Base directory | 18 Feb 2026 (+237 d) |
| cbZEC / cbHYPE | 1 Sep 2026 | none | none | **none** (no ZEC/USD or HYPE/USD Data Feed on Base) | none |
| Coinbase tokenized stocks (B20) | 24 Aug 2026 | Morpho accepted them **day 1**; carry-trade vaults (628 Labs, Superform, IPOR, Portals) 26 Aug | — | Chainlink feeds **live at launch** | — |

Sources: [Aave cbBTC ARFC](https://governance.aave.com/t/arfc-onboard-cbbtc-to-aave-v3-on-base-and-mainnet/18988); [CryptoPotato, 2024-10-31](https://cryptopotato.com/aave-sees-200m-weekly-increase-in-cbbtc-inflows-but-theres-a-catch/); [Morpho forum cbBTC](https://forum.morpho.org/t/adding-cbbtc-collateral-on-blockanalitica-b-protocol-flagship-vaults/789); [BaseScan cbXRP/USD proxy](https://basescan.org/address/0x9f0C1dD78C4CBdF5b9cf923a549A201EdC676D34) (created 28 May 2025); [Term Finance feed list](https://developers.term.finance/term-finance-protocol/protocol-contracts/price-feeds) (labels it cbXRP/USD, Chainlink, 24h/0.5%); [BaseScan CBBTC/USD proxy](https://basescan.org/address/0x10509b4053385b49145Fab2D6B1c58e96Eac5b79); [The Block cbADA/cbLTC, 2025-06-26](https://www.theblock.co/post/359792/coinbase-wrapped-ada-ltc-live-on-base); [CoinDesk tokenized stocks, 2026-08-24](https://www.coindesk.com/business/2026/08/24/coinbase-debuts-tokenized-stocks-on-base-network-joining-race-to-bring-equities-on-blockchain); [Crypto Briefing carry vaults, 2026-08-26](https://cryptobriefing.com/base-carry-trade-vaults-coinbase-tokenized-stocks/).

Pattern: when Coinbase wants a market, the Chainlink feed is there **before** launch and Morpho/Moonwell markets follow in **0–3 days**. cbZEC launched **without** a feed, which is the strongest signal that Coinbase has not (yet) prioritized cbZEC lending; the wait for a Coinbase-routed product was ~8 months for the previous batch.

---

## 2. Pyth vs Chainlink for ZEC/USD on Base

| Dimension | Chainlink | Pyth | Sources |
|---|---|---|---|
| ZEC/USD on Base **today** | **No push Data Feed** on Base (Base directory has XRP/USD, DOGE/USD ×2, ADA/USD, CBBTC/USD, cbETH-ETH; **no ZEC, LTC or HYPE**). A **ZEC/USD Data Stream** page exists (pull-based, subscription), but the page returned HTTP 403 to automated fetch and Base availability/feed-ID could not be confirmed. | **Yes** — Pyth Core feed `Crypto.ZEC/USD`, id **`0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eaae3e9048a65788c529b125bb24`**, readable on Base via the Pyth contract (`0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a`, upgraded address `0xbC16aee60f64864882BC6C4E428e148Fc0E272F5` after 26 Aug 2026) | [Chainlink Base feed directory JSON](https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-base-1.json) (fetched 2026-09-05); [Chainlink ZEC/USD stream page](https://data.chain.link/streams/zec-usd) (403); [Hermes feed lookup](https://hermes.pyth.network/v2/price_feeds?query=ZEC&asset_type=crypto); [Pyth EVM addresses](https://docs.pyth.network/price-feeds/core/contract-addresses/evm) |
| Update model | Push: DON writes on deviation (0.5% on Base crypto feeds) or heartbeat (86,400 s on Base low-risk feeds). Data Streams: pull, off-chain report + on-chain verifier, subscription billing ("pay-per-verification… deprecated"; "Contact us… for Mainnet pricing"). | Pull: anyone fetches a signed update from Hermes and calls `updatePriceFeeds` (on-chain fee now **0** after OP-PIP-128); consumer reads `getPriceNoOlderThan(id, maxAge)`. Pyth Data Association sponsors pushes for *some* feeds; sponsored-feeds page for EVM returned 404, so ZEC/USD sponsorship on Base is unconfirmed → **assume you run the pusher.** | Chainlink JSON (above); [Data Streams billing](https://docs.chain.link/data-streams/billing); [Pyth EVM pull guide](https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/evm); [Pyth current fees](https://docs.pyth.network/price-feeds/current-fees); [OP-PIP-128](https://forum.pyth.network/t/passed-op-pip-128-pyth-core-sunset-fee-zeroing-balance-repatriation/2662) |
| **Big 2026 change** | — | **Pyth Core → Pyth Pro migration (OP-PIP-100 passed)**: compatibility layer 1 Apr 2026, contracts redirected 1 Jul 2026, Pythnet sunset "by end of August 2026". "Pyth Core upgrade completed successfully on August 26, 2026. Hermes now requires an API Key." Hermes endpoint is now `https://pyth.dourolabs.app/hermes/` with `Authorization: Bearer`. Plans: **Free $0 = view-only, no API**; **Starter $500/mo = all crypto symbols, 1-s updates, API key**; Pro from $2,500/mo. CryptoSlate: 316 protocols / $2.7B TVS had to patch; "either problem halts price-update transactions until corrected." | [OP-PIP-100](https://forum.pyth.network/t/passed-op-pip-100-pyth-core-to-pyth-pro-migration/2420); [Pyth Core Upgrade blog, 2026-05-26](https://www.pyth.network/blog/the-pyth-core-upgrade); [Pyth plans](https://app.pyth.com/plans); [Pyth Core docs banner](https://docs.pyth.network/price-feeds/core); [CryptoSlate, 2026-08-26](https://cryptoslate.com/pyth-networks-api-overhaul-threatens-to-freeze-unpatched-smart-contracts-across-300-defi-protocols/); [Bitrue explainer](https://www.bitrue.com/blog/pyth-core-upgrade-july-2026) |
| Staleness risk | Push feeds go stale only if the DON stalls; a 24h heartbeat with 0.5% deviation is fine for a lending oracle because deviation triggers dominate. Morpho's Chainlink oracle does **not** check `updatedAt` — staleness bounds are the market creator's problem. | Price on-chain is exactly as fresh as your last push; `MorphoPythOracle` enforces `PRICE_FEED_MAX_AGE` and **reverts** if older → *liquidations stop when your keeper stops*. Keeper needs a paid Hermes key; a lapsed subscription or rate-limit (10 req/10 s per IP) freezes the market. | [Pyth × Morpho docs](https://docs.pyth.network/price-feeds/core/use-pyth-for-morpho); [Pyth rate limits](https://docs.pyth.network/price-feeds/core/rate-limits); Morpho docs: Oracle |
| What Morpho markets typically use | Overwhelmingly **MorphoChainlinkOracleV2 via the factory** (cbBTC, cbXRP, tokenized-stock markets all Chainlink) | Pyth ships `MorphoPythOracleFactory` on **Base `0x0A250c472cb43fb4F476cc6f47da9CA85E071Bbb`** (constructor: pyth, base/quote vaults, feeds, decimals, `priceFeedMaxAge`, salt); Gauntlet piloted Pyth on a UNI/USDC market (Jun 2024). Rare on Base. | [pyth-morpho-wrapper](https://github.com/pyth-network/pyth-morpho-wrapper); [Pyth blog, 2024-06-20](https://www.pyth.network/blog/gauntlet-selects-pyth-to-power-morpho-lending-vaults) |
| Getting a **new Chainlink feed** on Base | No public form or SLA; docs say "contact the Chainlink Labs team"; new feeds launch in the "🆕 New Token" category with a probation period. Evidence of speed: cbXRP/USD proxy deployed 8 days *before* cbXRP launch; tokenized-stock feeds live at launch; Coinbase and Chainlink have a deepening relationship (CCIP exclusive bridge Dec 2025; DataLink for Coinbase exchange data Mar 2026). For an unaffiliated builder the realistic path is **ask Coinbase/Base BD to ask Chainlink**; timing 2–8 weeks is typical but unverified (§7). | n/a — feed already exists | [Chainlink: Selecting feeds](https://docs.chain.link/data-feeds/selecting-data-feeds); [The Block CCIP, 2025-12-11](https://www.theblock.co/post/382230/coinbase-chainlink-ccip-wrapped-assets-exclusive-deal); [Chainlink Today DataLink, 2026-03-25](https://chainlinktoday.com/coinbase-adopts-chainlinks-datalink-to-bring-exchange-data-powering-billions-in-trading-volume-onchain/) |
| Cost to integrator | Push feeds: free to read; you pay only gas. Data Streams: subscription, quote-on-request. | $500/mo Starter (crypto, 1-s) for the Hermes key + keeper infra + Base gas for pushes (~cents each; a 0.5%-deviation/1-h-heartbeat pusher is a few thousand tx/month) | plans page; current-fees page |
| Security history | Sept 2021 n/a. **May 29 2025**: deUSD/USD on Avalanche/Euler reported $1.03, $500K liquidated — Chaos Labs blamed a 25-min delayed update and illiquid-pool sourcing, Chainlink/ACI said "Chainlink did their job". **Feb 15 2026**: Moonwell cbETH — governance used cbETH/ETH ratio as USD price ($1.12), $1.78M bad debt (integrator error). **Mar 10 2026**: Aave wstETH CAPO desync (~2.85% off, ~$26–27M liquidations, refunded). Oct 2025 crash: both Chainlink and Pyth propagated Binance-dislocated prices per one analysis; Aave's oracle set-up held. | **Sept 20 2021**: BTC printed $5,402, DOGE >$0.88 for 11 h, AMC $772 — bad publisher inputs, confidence intervals ignored by consumers, Mango liquidations. **Aug 26 2026**: forced API-key migration; no confirmed outage but "freeze" risk for unpatched pull integrations. | [CryptoSlate, 2025-05-29](https://cryptoslate.com/chainlink-oracle-malfunction-sparks-500k-in-defi-liquidations-reignites-reliability-debate/); [CryptoDaily, 2026-08](https://cryptodaily.co.uk/2026/08/oracle-staleness-defi-without-hack); [The Defiant, 2021-09](https://thedefiant.io/news/defi/pyth-solana-bad-pricing-meltdown); [Medium: Oct-2025 crash](https://medium.com/@nicolakharvey/infrastructure-failures-that-amplified-the-crash-545656ab1c09) |

**Verdict, stated plainly.**
- **Chainlink is the better choice whenever a ZEC/USD push feed exists on Base**: zero keeper dependency, zero subscription, the oracle every Base curator, Aave, Compound and Moonwell already require, and the factory path (`MorphoChainlinkOracleV2Factory`) is what cbXRP/cbBTC markets use. Getting the feed is a business-development task, not an engineering one, and cbXRP shows Chainlink can ship a cb-asset feed in under two weeks when Coinbase asks. Any market meant to attract third-party curator capital should be built on Chainlink.
- **Pyth is the only choice if you must launch before a Chainlink feed exists** — which is the situation today. It works (feed id above, Base factory above), but as of 26 Aug 2026 it is a paid, keepered dependency: $500/mo Starter key, your own pusher, `priceFeedMaxAge` reverts if the pusher dies, and Morpho's largest curators have not adopted Pyth-oracle markets on Base. A Pyth-oracle market is realistically a **self-funded market** (1c) with a plan to migrate to a new Chainlink-oracle market later — and because Morpho markets are immutable, "migrate" means creating a second market and moving positions.
- Chainlink **Data Streams** (ZEC/USD stream exists) is not a drop-in: pull-based, subscription-priced, needs a custom `IOracle` adapter with its own keeper — it inherits Pyth's operational profile without Pyth's ecosystem tooling for Morpho.

---

## 3. Aerodrome's agent tooling (https://aerodrome-finance.github.io/agents/)

The page is the landing for **Sugar**: "Aerodrome, wrapped for AI agents. A Python SDK, CLI and Claude Code skill." ([page](https://aerodrome-finance.github.io/agents/), fetched 2026-09-05). Repo: [velodrome-finance/sugar-sdk](https://github.com/velodrome-finance/sugar-sdk).

| Aspect | Finding |
|---|---|
| Form | Python SDK (async + sync), `sugar` CLI (python-fire), Claude Code skill at `.claude/skills/sugar/`. **No MCP server.** Install: `pip install git+https://github.com/velodrome-finance/sugar-sdk.git@v0.4.2` (page) — README/tags show v0.4.0 (24 May 2026) and v0.4.1; version drift (§7). License: page says MIT, repo says Apache-2.0. |
| Chains | Base (8453), Optimism (10), Unichain (130), Lisk (1135); RPC via `SUGAR_RPC_URI_<chainId>` (public defaults are rate-limited; private RPC recommended for writes). |
| Read actions | `pools` (list/filter), `positions` (by owner), `quote` (output, price impact, oracle price), `epochs-latest` / `epochs` (votes, emissions, fees, incentives with USD values), `get_prices`. |
| Write actions (unsigned tx builders) | `swap` / `swap_from_quote` (incl. cross-chain "superswaps" via Velodrome relayer), `deposit` (basic stable/volatile **and Slipstream concentrated positions** via `quote_concentrated_deposit`, tick ranges), `withdraw` (partial fraction; CL burn requires fraction=1.0), `stake` / `unstake` (gauge deposit/withdraw; CL positions by NFT id), `claim_emissions`, `claim_fees`, `pool_spec` (define a new pool). |
| **Not offered** | veAERO locking, **voting**, bribes/incentive deposits, relays, automation/scheduling, signing, broadcasting. |
| Auth model | "The SDK never signs." Every write returns `[{from,to,data,value}]` JSON; `--wallet=0xADDRESS` only, private keys are refused; "Your signer broadcasts" (cast, viem, ethers, MetaMask, or a server signer). "Local-first · real-time onchain calls · full privacy." No API key, no fee. |
| Slipstream CL & gauge staking | **Yes** for deposit/withdraw/stake/unstake/claim on CL positions; tight ranges need smaller slippage; NFPM burn semantics handled. |

**Does it change the need for the Snuggle/MaxFi engine (15% fee) or a self-run keeper?** Sugar removes the *encoding* work (routing, quotes, CL position construction, gauge calls) and gives an agent a clean, audited-by-usage transaction builder — so the engineering cost of a self-run LP/keeper drops materially. It does **not** remove the need for one: it has no scheduler, no signer, no position-health monitor, no rebalance/compounding logic, and no voting/bribe management. A managed engine (Snuggle/MaxFi-type) is still what supplies the *decision loop, custody and uptime*; Sugar is what such an engine (or your own keeper) would call. If the 15% fee is buying "someone else's keeper + signer + rebalancing strategy", Sugar makes an in-house replacement cheaper to build (days, not weeks) but not free to run, and it leaves the veAERO/vote/bribe side untouched. It also does nothing for the *unvoted gauge*: attracting emissions still means bribing voters or obtaining a partner veAERO grant.

---

## 4. Other Base infrastructure for a hand-held, one-stop product

Legend: **Flags** — ⚠ exploited ≤12 mo · 🔒 KYC-gated · ❓ audit not located.

### 4.1 Onboarding, fiat, wallets

| Product | What it does | SDK/API/MCP | Fees | Audit | Role for Oilskin | Flags | Sources |
|---|---|---|---|---|---|---|---|
| **Coinbase Onramp / Headless Onramp** | Card, Apple/Google Pay, ACH, Coinbase balance → crypto to any address; guest checkout without a Coinbase account (was 15 lifetime tx / $500/wk; since 26 Jun 2026 unlimited lifetime, **$2,500/wk after light KYC**: name, DOB, last-4 SSN); hosted widget guest checkout deprecated 30 Jun 2026 → use Headless API; session tokens single-use, 5-min TTL | REST (session token, config, options, quote, status) | Standard Coinbase spread/fees; **0% on USDC on/off-ramps "to select apps upon request"** (Nov 2024 program); "self-serve API access with no monthly fees" | Coinbase | First-dollar entry for no-DeFi users: USDC straight into a Base Account | 🔒 (light KYC above $500/wk; US-only guest) | [Onramp overview](https://docs.cdp.coinbase.com/onramp-&-offramp/onramp-apis/onramp-overview); [Headless update, 2026-06-26](https://www.coinbase.com/en-it/developer-platform/discover/launches/headless-onramp-h2); [Zero-fee USDC](https://www.coinbase.com/developer-platform/discover/launches/zero-fee-usdc) |
| **Base Account (Coinbase Smart Wallet) + CDP Paymaster** | Passkey ERC-4337 smart account; gas sponsorship via ERC-7677/EIP-5792 with contract/function allowlists | Base Account SDK; CDP Paymaster JSON-RPC | **Up to $15K free gas credits** (Base Gasless Campaign), then **gas + 7%** monthly invoiced | Cantina audit Apr 2024; $5M Coinbase bounty on Cantina | Gasless first transactions; no seed phrase | — | [Paymaster docs](https://docs.cdp.coinbase.com/paymaster/introduction/welcome); [Base Account sponsor-gas](https://docs.base.org/base-account/improve-ux/sponsor-gas/paymasters); [Cantina smart-wallet audit](https://github.com/coinbase/smart-wallet/blob/main/audits/Cantina-April-2024.pdf) |
| **Spend Permissions** | User signs EIP-712 {token, allowance, period}; app's `spender` pulls ERC-20/native within the recurring allowance via `SpendPermissionManager` | Base Account SDK (`prepareSpendCallData`) | none | Cantina competition Oct 30–Nov 6 2024 ($75K pool, 395 submissions) | The "hand-held" primitive: user grants a USDC/cbZEC allowance once; your keeper rebalances, repays, tops up collateral without wallet pop-ups | — | [Spend Permissions docs](https://docs.base.org/base-account/improve-ux/spend-permissions); [Cantina competition](https://cantina.xyz/competitions/6837e02a-0a87-4577-a047-4e1ea71cff01) |
| **CDP Server Wallets / Smart Accounts, Trade API, AgentKit, Base MCP** | Custodial server wallets (no key exposure); Trade API = 0x-powered swaps on Ethereum/Base/Arbitrum/Optimism/Polygon with optional gas sponsorship; AgentKit (TS/Python) + Base MCP (26 May 2026) with Morpho, Moonwell, Uniswap, Aerodrome, Avantis actions; x402 payments; "Coinbase for Agents" trade access (11 Jun 2026) | SDKs + MCP | Trade API fee not published (§7) | Coinbase | Back-office automation and agentic execution layer; Trade API doubles as a swap route with CDP-native signing | — | [Trade API](https://docs.cdp.coinbase.com/trade-api/welcome); [The Agent Report, 2026-06](https://the-agent-report.com/2026/06/coinbase-mcp-agent-integration/) |
| **Privy / Dynamic / ZeroDev / Alchemy Account Kit** | Embedded wallets + AA. Privy: 1,000 MAU free, $599/mo for 10K; Dynamic: 500 MAU free, $499/mo 5K, $999/mo 25K, 30+ chains incl. non-EVM; ZeroDev: 10K UserOps free, $299/mo 100K, Kernel ERC-7579 accounts, session keys, L2 sponsorship ~$0.0005–0.005/op; Alchemy: free bundler tier, no gas markup | SDKs | above | ❓ (comparison piece lists none) | Alternative to Base Account if you want email/social login or non-Coinbase branding; ZeroDev session keys ≈ Spend Permissions | ❓ | [The Signal comparison, 2026](https://thesignal.directory/intelligence/account-abstraction-providers-compared-2026) |

### 4.2 Swaps

| Venue | On Base? | SDK/API | Fees | Notes / audit | Role | Sources |
|---|---|---|---|---|---|---|
| **Aerodrome (Sugar)** | Yes — the cbZEC venue | Python SDK/CLI (§3) | Pool fee only | Core contracts audited (Velodrome lineage); Sugar itself unaudited utility code | Primary cbZEC↔USDC route; LP/gauge ops | §3 |
| **Uniswap v4 + Trading API** | Yes (v4 cbZEC pools exist, $5–61K) | Trading API (`x-api-key`, quote + swap calldata, fee disbursement, Permit2) | API fee not published; integrator fee via quote | Uniswap v4 audited/competition (2024–25) | Secondary route; API is the simplest "one-call swap" | [Uniswap Trading API](https://developers.uniswap.org/docs/api-reference/create_swap_transaction) |
| **0x Swap API v2** | Yes (powers CDP Trade API) | REST; Standard plan **10 RPS, 0.15% on select pairs charged on-chain**; custom volume plans; integrator fee + positive-slippage capture | above | 0x settler audited | Aggregation with monetization hook | [0x pricing FAQ](https://help.0x.org/en/articles/10970779-0x-api-pricing-faq) |
| **Odos** | Yes | REST, **free 600 req/5 min per IP**; paid tiers in beta | none published | ❓ audit page not located | Backup aggregator | [Odos API plans](https://docs.odos.xyz/build/api_pricing) |
| **KyberSwap Aggregator** | Yes | REST + SDK | none for API | Aggregator separate from KyberSwap Elastic (which lost ~$47M, Nov 2023) | Backup aggregator | [Hacken post-mortem](https://hacken.io/insights/kyberswap-hack-explained/) |
| **CoW Protocol** | Docs say "Ethereum and EVM-compatible chains"; Base support and fee terms not confirmed from the fetched page (§7) | SDK | — | — | Intent/MEV-protected swaps if confirmed on Base | [CoW docs](https://docs.cow.fi/cow-protocol) |

### 4.3 Lending

| Protocol | Base status | SDK/API | Fees | Audit / incidents | Role | Flags | Sources |
|---|---|---|---|---|---|---|---|
| **Morpho** | $3.3–4.0B on Base; permissionless markets (§1) | Blue API (GraphQL), Bundler3, SDKs; Base MCP action provider | 0% protocol; curator 5–25% | Multiple audits + formal verification; oracle-config incidents in third-party markets (PAXG $230K Oct 2024; Pendle PT $36M liquidation cascade 26 Aug 2026 via oracle design, not Morpho core) | Core venue | — | [DefiLlama](https://defillama.com/protocol/morpho); [MPost, 2026-08-26](https://mpost.io/llamaguard-proposes-bounded-oracle-redesign-as-36m-morpho-liquidation-episode-renews-defi-risk-architecture-debate/) |
| **Aave v3 Base** | Governance-listed; cbBTC, cbETH etc.; no cb long-tail | aave-utilities, GraphQL | reserve factors | Aave core audited; KelpDAO-related $293M loss (Apr 2026) drove the new listing framework; wstETH CAPO incident Mar 2026 | USDC yield leg or blue-chip borrow leg | — | §1e |
| **Euler v2 Base** | $14.8M TVL | EVK/EVC SDKs | governor-set interest fee | see §1e | Fallback permissionless venue | — | §1e |
| **Moonwell** | Borrows on all Base core markets capped at 1 wei since 27 Aug 2026 | SDK | — | **⚠ $8.7M MAMO spot-oracle manipulation 27 Aug 2026; $1.78M cbETH oracle misconfig 15 Feb 2026; ~$1M wrsETH oracle Nov 2025** | Avoid for now | ⚠ | [The Block, 2026-08-27](https://www.theblock.co/news/defi/2026-08-27-moonwell-investigates-base-lending-market-issue-412913); [TechTimes](https://www.techtimes.com/articles/325839/20260827/moonwell-oracle-exploit-exceeds-full-annual-revenue-third-failure-11-months.htm) |

### 4.4 Yield / vaults

| Product | Base | SDK/API | Fees | Audit | Role | Sources |
|---|---|---|---|---|---|---|
| **Morpho Vaults (V1.1/V2)** | Yes — $1.62B curated USDC on Base | ERC-4626 + Blue API | 5–25% perf (curator) | §1b | Where borrowed USDC parks (Steakhouse Prime ~3.5–4%, High Yield ~8.8% per The Defiant, Jun 2026) | §1b, [The Defiant](https://thedefiant.io/news/cefi/coinbase-usdc-lending-vaults-morpho-steakhouse-ethena-risk-tier) |
| **Beefy** | Yes (Aerodrome/CL "Cowcentrated" vaults) | ERC-4626 wrapper, Zap | 4.05% of yield typical (up to 9.5% newer vaults), ≤0.1% withdrawal, 0.05% Zap | 12+ audits (CertiK, Zellic, Cyfrin, Certora, Sherlock, OpenZeppelin), Immunefi bounty | Auto-compounded Aerodrome LP incl. CL — an off-the-shelf alternative to a self-run LP keeper | [Beefy fees](https://docs.beefy.finance/ecosystem/beefy-bulletins/beefy-finance-fees-breakdown); [Beefy audits](https://docs.beefy.finance/safety/bug-bounty-program) |
| **Yearn v3** | Yes (Yearn OG USDC on Morpho Base; "Morpho Gauntlet USDC Prime Compounder") | ERC-4626 | 5–10% of native APY; 10% on V3 allocator vaults | Yearn audits | Compounded stablecoin leg | [Yearn docs](https://docs.yearn.fi/getting-started/products/curating/morpho-curating) |

### 4.5 Perps on Base

| Venue | Status | Fees | Audit | Role | Flags | Sources |
|---|---|---|---|---|---|---|
| **Avantis** | Live; v2 deployed Aug 2026; ~90 markets incl. FX/commodities, up to 500× | 0.06% maker/taker; "zero-fee" BTC/ETH/SOL claim | Zellic + Sherlock (v1.5); Guardian/Sherlock/Zellic v2 "reports to be added"; Chaos Labs economic params | Hedge/leverage leg; in Base MCP | v2 audit reports not yet published ❓ | [Avantis audits](https://docs.avantisfi.com/security/audits); [perps.info](https://perps.info/dex/avantis) |
| **Synthetix** | **Shut down on Base 7 Jul 2025** ("close trades & withdraw"); 2026 roadmap is Ethereum-mainnet only | — | — | Not usable on Base | — | [TradingView/CoinMarketCal](https://www.tradingview.com/news/coinmarketcal:169a4d189094b:0-synthetix-network-snx-base-shutdown-07-jul-2025); [Synthetix 2026 roadmap](https://blog.synthetix.io/2026-roadmap/) |

### 4.6 Tokenized stocks on Base

| Issuer | Live on Base? | Eligibility | Composability | Sources |
|---|---|---|---|---|
| **Coinbase tokenized stocks (B20)** | Yes, since 24 Aug 2026: AAPL, NVDA, META, GOOGL first; docs list 14 tickers (AAPL, AMZN, COIN, CRCL, GOOGL, INTC, META, MSFT, MSTR, NVDA, SNDK, SPCX, TSLA + registry); $4.55M minted / $3.06M DEX liquidity / $10.8M volume day 1; Chainlink 24/5 total-return feeds | **Non-US only** for mint/redeem (Alpaca custody, ADGM oversight); secondary trading "permissionless" but PolicyRegistry blocklists apply | Aerodrome pools; Morpho lending day 1; carry-trade vaults (628 Labs, Superform, IPOR, Portals) | [CoinDesk, 2026-08-24](https://www.coindesk.com/business/2026/08/24/coinbase-debuts-tokenized-stocks-on-base-network-joining-race-to-bring-equities-on-blockchain); [Base docs](https://docs.base.org/base-chain/asset-issuance/tokenized-stocks-on-base); [Crypto Briefing, 2026-08-26](https://cryptobriefing.com/base-carry-trade-vaults-coinbase-tokenized-stocks/) | 🔒 |
| **Dinari dShares** | Yes since 27 Aug 2024; 700+ tickers added Aug 2026; partner API | "qualified non-US users" (and a separate US product launched 2026) | Designed for DeFi integration | [Dinari on Base](https://dinari.com/blog/dinari-dshares-now-live-on-base); [CryptoTimes, 2026-08-05](https://www.cryptotimes.io/2026/08/05/dinari-adds-700-tokenized-u-s-stocks-to-onchain-platform/) | 🔒 |
| **Ondo Global Markets / "Ondo Stocks"** | Solana-first (200+ tickers); Base availability **not confirmed** | non-US | — | [Genfinity, 2026-07-13](https://genfinity.io/2026/07/13/ondo-global-markets-becomes-ondo-stocks-tokenized-equities-leader/) | 🔒 ❓ |
| **Backed xStocks** | Solana, BNB, Hyperliquid, Kraken/OKX; **no Base deployment found** | non-US | — | [xStocks news](https://xstocks.fi/us/news) | 🔒 |

### 4.7 Risk and data

| Service | What | Access/price | Role | Sources |
|---|---|---|---|---|
| **DefiLlama** | TVL, fees, prices free; Pro API $300/mo or $3K/yr (1,000 rpm, 1M calls) | free / Pro | Yields & TVL panels in-app | [DefiLlama Pro](https://docs.llama.fi/pro-api) |
| **Chaos Labs** | Risk Oracles, due diligence, allocation optimization for vault curators; Edge oracle; Aave/Avantis risk provider | bespoke | Parameter setting if the market grows; not economical at $500K | [Chaos Labs, 2025-11-21](https://chaoslabs.xyz/posts/vault-management-risk-management) |
| **LlamaRisk** | Aave risk provider; publishes Morpho vault collateral disclaimers; LlamaGuard bounded-oracle proposal (Aug 2026) | bespoke | Same | [LlamaRisk](https://www.llamarisk.com/research/morpho-vaults-risk-disclaimer) |
| **Blockscout (Base)** | Open explorer/API + MCP server; can read B20 balances (but not B20 admin policy metadata yet) | free | Tx/position tracing in-app | [Unchained on B20 explorer gap](https://unchainedcrypto.com/coinbases-base-launches-a-native-token-standard-with-freeze-and-seize-built-in/) |

---

## 5. Comparison summary tables

**Lending venue for cbZEC**

| | Morpho Blue | Euler v2 | Compound v3 | Aave v3 | Moonwell |
|---|---|---|---|---|---|
| Permissionless listing | Yes | Yes | No | No | No |
| Oracle freedom | Any `IOracle` (Chainlink/Pyth factories) | Router: Chainlink/Pyth/RedStone… | Chainlink `AggregatorV3` only | Chainlink mandatory | Chainlink |
| Time to live | Hours | Hours | Weeks–months | ≥13 d governance after risk review; realistically months | Days (but ⚠) |
| Base depth | $3.3–4.0B | $14.8M | n/a | large | frozen |
| Who supplies USDC | You / curators | You / curators | pool | pool | pool |

**Oracle**

| | Chainlink push feed | Chainlink Data Stream | Pyth Core/Pro |
|---|---|---|---|
| ZEC/USD on Base today | No | Stream exists; Base availability unverified | Yes |
| Keeper needed | No | Yes | Yes |
| Recurring cost | $0 | subscription (quote) | $500/mo Starter key |
| Curator acceptance on Base | Universal | Rare | Rare |
| Fails when | DON stalls (rare) | your keeper/subscription | your keeper/subscription |

---

## 6. Appendix — model scripts

Liquidation model (Python, run 2026-09-05):

```python
import math
def lif(lltv): return min(1.15, 1/(0.3*lltv+0.7))
def sell_into_cl(L, P, pa, dx):           # sell dx token0 into one CL position over [pa, ·]
    s0, sa = math.sqrt(P), math.sqrt(pa)
    if dx >= L*(1/sa-1/s0): return L*(s0-sa), pa, True   # range exhausted
    s1 = 1/(1/s0+dx/L);  return L*(s0-s1), s1*s1, False
def L_from_usdc(Q, P, pa): return Q/(math.sqrt(P)-math.sqrt(pa))
# Snapshot A: P0=1015.42, USDC side Q0=767771; shapes pa = 0.8, 0.5, 0.2 x P0
# For debt D at LLTV: seized cbZEC = D*lif(LLTV)/P0 ; PnL = usdc_out - D
# Crash: P1 = 0.7*P0, remaining USDC = L*(sqrt(P1)-sqrt(pa)) if P1>pa else 0
```

IRM model: AdaptiveCurveIRM per `ConstantsLib.sol` (steepness 4, target 0.9, r₀ 4%, min 0.1%, max 200%, speed 50/yr); borrow APR = rateAtTarget × ((1−1/4)·err + 1) for u<0.9 with err=(u−0.9)/0.9; rateAtTarget(t)=r₀·exp(50·err·t/yr) clamped. Supply APR = borrow APR × u × (1 − 0 protocol fee).

---

## 7. Unknowns / could not verify

1. **Aerodrome pool geometry.** Whether `0x0Fc4…8566` is Slipstream CL (inferred from reserve skew) and its tick range/fee tier — the model's tight/medium/wide shapes bracket this. DexScreener served two inconsistent cache snapshots (price $815 vs $1,015); both are modelled.
2. **cbZEC/ZEC price basis.** DexScreener showed cbZEC at $815 in one snapshot vs ZEC ~$1,027 on CoinGecko — likely cache timing, possibly a real discount on a thin pool. Not resolved.
3. **Chainlink ZEC/USD Data Stream** details (feed ID, Base verifier availability, schema) — `data.chain.link` returned 403 to automated fetch; only the page's existence is confirmed.
4. **Chainlink Base feed directory completeness.** The reference JSON returned 60 entries and omits the cbXRP/USD proxy that BaseScan/Term Finance/Moonwell attest to; treat "no ZEC/HYPE/LTC feed" as *not in the public directory* rather than proven absent. Direct check of `data.chain.link/feeds/base/base/zec-usd` also returned 403.
5. **Chainlink new-feed SLA** — no public process, form, or timeline; "2–8 weeks" is an inference from cb-asset precedents.
6. **Pyth free-tier API access.** Plans page says Free = "no API permissions"; the Terminal page advertises "Generate a Pyth Pro access token instantly… Get a Free API Trial." Whether a trial key sustains a production pusher is unconfirmed; assume $500/mo. Sponsored-feeds page for EVM (Base) returned 404, so PDA-sponsored ZEC/USD pushes on Base are unconfirmed.
7. **Morpho cbXRP/USDC market internals** (curator, oracle address, creation date, initial supply) — Morpho app is JS-rendered and the Blue API GraphQL was blocked by the fetch proxy. Only LLTV 62.5% and existence are confirmed.
8. **MorphoChainlinkOracleV2Factory on Base** — two addresses appear (`0x2DC205…bd3d` labelled on BaseScan; `0x3585E3…2884` on the docs addresses page). Verify before deploying.
9. **Morpho `createMarket` gas** — no published figure; "cents" is inferred from Base fee levels.
10. **Curator fee percentages** for Gauntlet/Steakhouse/Re7/MEV Capital/Block Analitica come from a secondary explainer (Eco) plus one press figure (Steakhouse 25% on the Coinbase vault); exact per-vault fees were not readable from Morpho's app.
11. **Aave cbXRP listing outcome** (Snapshot/AIP) after the Aug 2025 TEMP CHECK — not found.
12. **Armitage terms** (fee, proprietary capital, willingness to take cbZEC) — not disclosed.
13. **CDP Trade API fee**, Uniswap Trading API fee/rate limits, CoW Protocol Base support/fees, Odos paid tiers — not published on the fetched pages.
14. **Sugar SDK version** — page says v0.4.2, repo README v0.4.1, latest release listed v0.4.0; license stated as MIT on the page and Apache-2.0 in the repo.
15. **Ondo on Base** — not confirmed; **xStocks on Base** — not found.
16. **B20 freeze/pause behaviour inside Morpho** — no curator or Morpho documentation addresses liquidation of paused B20 collateral.
17. **Avantis v2 audit reports** — "will be added shortly" as of fetch.
