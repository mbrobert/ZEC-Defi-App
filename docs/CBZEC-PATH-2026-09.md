# The cbZEC path — three options, with the numbers read on 2026-09-10

Abbreviations: LP = liquidity provision; CL = concentrated liquidity (Aerodrome Slipstream);
NPM = NonfungiblePositionManager (the contract that mints CL positions); TVL = total value locked;
APR = annual percentage rate; B20 = Base's native token standard that cbZEC is built on.

This is a memo with options, not a choice. Every number is a chain read with its block and date, or
a derivation from one that is shown; code costs are estimates from the files named. The founder
decides.

## What was read (all 2026-09-10, Base mainnet, public RPC; `VERIFIED-BASE-FACTS.md` Addendum 8)

| Question | Answer | Block |
|---|---|---|
| Does the Slipstream SwapRouter `0xBE6D…18a5` route USDC → cbZEC through the cbZEC/USDC pool? | **No.** `exactInputSingle(USDC, cbZEC, tickSpacing 200, 1,000 USDC)` from a synthetic sender with balance and allowance set by `eth_call` state override reverts with **no data**; tick spacing 100 the same. The control — WETH → USDC at spacing 100 through the same router and overrides — returned 24.417813 USDC for 0.01 WETH, so the method works and the router works; it is bound to the CLFactory `0x5e7B…809A` (`factory()`), and the cbZEC pool was created by another factory. | 51,146,6xx |
| What is the second factory? | `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef`: a full Slipstream CLFactory — `owner()` = `swapFeeManager()` = `unstakedFeeManager()` = `0xE6A41fE61E7a1996B59d508661e3f524d6A32075`, `poolImplementation()` `0xc770…B665`, `voter()` the Aerodrome Voter `0x1661…80A5`, `swapFeeModule()` `0x87D8…E8CB`, `factoryRegistry()` `0x5C3F…37C0`, `allPoolsLength()` **1,414**, `tickSpacings()` [1, 50, 100, 200, 2000, 500, 10], `getPool(USDC, cbZEC, 200)` = the pool. It names no router. | 51,146,581 |
| Is it a sanctioned Aerodrome factory? | Yes. The FactoryRegistry `0x5C3F…37C0` lists four approved pool factories — `0x420D…40Da`, `0x5e7B…809A`, `0xaDe6…716a`, `0xf8f2…61Ef` — and maps `0xf8f2…61Ef` to votingRewardsFactory `0x45cA…B504` / gaugeFactory `0x3852…6AbB`. | 51,146,674 |
| Which NPM mints into the cbZEC pool? | `pool.nft()` = **`0xe1f8cd9AC4e4A65F54f38a5CdAfCA44f6dD68b53`** (49,087 B), whose `factory()` is `0xf8f2…61Ef`. The NPM this repo recorded on 2026-09-06, `0x8279…5b72`, is bound to the OLD factory and cannot mint here. | 51,146,674 |
| Does the engine list a cbZEC pool? | No — none of the 214 entries names cbZEC (Addendum 3, block 51,127,409). | 51,127,409 |
| Gauge for the pool | `0x8779E34E5d38358B0cB957c553B40cC1208C81FB`, `isPool` true, `pool()` the pool; **`rewardRate()` = 7,140,520,125,989,201 wei AERO/s** (= `rewardRateByEpoch(1788998400)`), `periodFinish()` **1,789,603,200** (2026-09-17 00:00 UTC), `rewardToken()` AERO. Voter: `isAlive(gauge)` true, `weights(pool)` 845,426,815,777,204,089,704,683 of `totalWeight()` 1,016,840,058,877,742,097,218,633,380 = **0.0831 %** of all votes; `epochNext(now)` = 1,789,603,200. On 2026-09-05 this gauge read `rewardRate() = 0`, `periodFinish() = 0`: **the first emissions vote landed in the epoch that began 2026-09-10.** | 51,146,581 |
| Pool state | `slot0` tick **−23,756**, sqrtPriceX96 24,158,478,068,572,882,064,475,621,010 → **≈ 1,075.5 USDC per cbZEC** (down from ≈ 1,217 at block 51,127,409 the same morning); `liquidity()` 21,276,159,996,193; balances **666,059 USDC** and **206.06 cbZEC** → TVL ≈ **$887.7k**; `stakedLiquidity()` **18,217,498,697** — **0.086 %** of the active liquidity is staked in the gauge. | 51,146,581–674 |
| AERO price | Chainlink AERO / USD `0x4EC5970fC728C5f65ba413992CD5fF6FD70fcfF0` (`description()` = "AERO / USD"): **0.54485438**, updated 1789082529. | 51,146,674 |
| Gas | base fee 0.005 gwei, `eth_gasPrice` 0.006 gwei; ETH/USD 2,437.27; the L1 data fee was not read. | 51,146,494 |

**Emissions in plain numbers.** 7,140,520,125,989,201 wei/s × 86,400 s = **616.94 AERO per day** ≈
**$336 per day** at $0.5449, ≈ $122.7k per year IF this epoch's rate held all year — it does not: it
is re-voted every epoch (next boundary 2026-09-17), and the vote behind it is 0.083 % of the Voter.
The gauge pays that to STAKED, IN-RANGE liquidity pro rata. Today only 1.82e10 of the pool's 2.13e13
active liquidity is staked, so a staked in-range position with liquidity L takes
L / (1.82e10 + L) of the day's 617 AERO: a position holding **10 % of the pool's active liquidity
(≈ 2.13e12, roughly $89k of the $888k TVL, both tokens, centred on the price)** would take 99.2 % of
it — ≈ $333 per day on ≈ $89k, ≈ **137 % APR from emissions alone while the vote and the range
hold**, and ≈ 0 the moment either does not. A position 1 % of the pool (≈ $8.9k) takes 92 %:
≈ $310 per day, ≈ 1,270 % APR — numbers that say "nobody is staked here yet", not "this is
sustainable". Trading fees are not counted (the pool's `fee()` is 2000 = 0.2 %; volume was not
read). Borrow cost against cbBTC / WETH at Aave was 4.633 % on 2026-09-10 (Addendum 3).

## The three options

### 1 — Direct Slipstream integration, bypassing the engine

**What it is.** An Oilskin `SlipstreamLpVenue` behind the same `ILpVenue` interface as the engine
venue: mint through the second deployment's NPM `0xe1f8…8b53` (dual-sided, a centred range Oilskin
chooses), stake the NFT in the gauge `0x8779…81FB` (`deposit(tokenId)` on a Slipstream gauge takes
the NFT), claim AERO with `getReward`, unstake and `decreaseLiquidity` / `collect` / `burn` on
close; swaps USDC ↔ cbZEC through the pool itself (`pool.swap` with a callback contract, because
the SwapRouter `0xBE6D…18a5` cannot reach this pool) or through a router bound to `0xf8f2…61Ef`
that this repo has not found and must not guess.

**Code cost (estimate).** New: `contracts/src/venues/SlipstreamLpVenue.sol` ≈ 450 lines (mint /
increase / close / closeMany / claim, the price band, the fee chokepoint, refunds, `positionsOf`
from the gauge's or the NPM's enumeration — the NPM is ERC-721 Enumerable, a real
`tokenOfOwnerByIndex`, unlike the engine); `contracts/src/adapters/SlipstreamPoolSwapAdapter.sol`
≈ 150 lines (`ISwapAdapter` over `pool.swap` + `uniswapV3SwapCallback`, the amount floor);
interfaces for the NPM, gauge and pool swap ≈ 120 lines; a `MockSlipstreamNpm` + `MockGauge`
≈ 350 lines; unit tests ≈ 700 lines; fork tests ≈ 200 lines (the swap and the mint can only be
proved on the LIVE node with state overrides, not in a fork EVM — the fork cannot execute the
cbZEC precompile, Addendum 3). Changed: `Deploy.s.sol` (+1 venue, +2 addresses), the registry
(no change), `packages/shared/src/pools.ts` (+1 curated pool with a real `poolAddress` and no
`enginePoolId`), the web's pool list and the yield service (a second `LpVenue` per pool ≈ 200
lines across `web/lib` and `services/yield`), the keeper's LP reader (`readLpState` assumes one
venue; ≈ 120 lines). Order of magnitude: **≈ 2,300 lines, 12 files, plus a second audit surface**.

**What it proves.** That Oilskin can offer cbZEC LP at all, with a centred, dual-sided, staked
position — the shape the yield model prices — on Aerodrome's own infrastructure, with no engine
fee (the engine takes 15 % of earnings; Oilskin's own fee applies) and no engine risk (§12), and
with `positionsOf` that does not need slice A's four checks.

**Yield it could earn.** The emissions above, at the position's share of staked liquidity, while
the vote holds: ≈ 137 % APR on a $89k position today, 0 % next epoch if the vote goes. Plus 0.2 %
trading fees on volume not read. Minus IL on a cbZEC/USDC pair (§9: the model has no cbZEC
calibration; the tick moved −23,228 → −24,995 → −23,756 in five days, ≈ ±17 %).

**Risk lines it adds.** A new Oilskin contract holding the gauge position (§11 — unaudited code
that touches the user's principal); the gauge's `rewardRate` re-voted every epoch — a yield that
can go to zero on Thursday (§14); cbZEC depth: the pool IS the depth (≈ $888k, of which Oilskin
would be a tenth) — the liquidation path in §6 gets no better by Oilskin being the liquidity; the
B20 issuer's powers over the pool's cbZEC (§4) — a paused token freezes the position; the second
factory's owner `0xE6A4…2075` sets swap and unstaked fees for the pool (a new operator in the trust
list, §16); the `pool.swap` callback path is a new MEV surface (§13); and cbZEC still cannot be
collateral (no market, §7), so this is LP with USDC borrowed against cbBTC / WETH, or with the
user's own USDC — the leverage story does not change.

### 2 — cbZEC LP out of v1; cbZEC spot only

**What it is.** Ship v1 with cbBTC / WETH collateral, USDC borrowed, LP in the engine's WETH/USDC
Aerodrome entry (index 24, Addendum 5) — and cbZEC only as a CoW spot order (already built:
`web/app/spot`, `web/lib/cow.ts`). The cbZEC path is a signpost: the address pinned, the B20 probe
(this slice), the risks stated.

**Code cost.** ≈ 0 new lines. Removals: the cbZEC/USDC row in `packages/shared/src/pools.ts` and
the prototype's cbZEC LP cells (grep `POOL_CBZEC_USDC`, `cbZEC/USDC` in `web/`, `prototype/`,
`services/yield/`; ≈ 60 lines across 6 files, and the `MockCLPool` cbZEC fixture stays for the B20
tests). `docs/V1-SIMPLE.md` and `README.md` say so in one sentence each.

**What it proves.** Nothing new about cbZEC; it proves the product on the path that is actually
verified end to end on the fork (Addenda 3–7).

**Yield.** None from cbZEC. The WETH/USDC CL100 gauge at index 24 pays 395,705,710,963,192,131
wei AERO/s (≈ 34,189 AERO per day ≈ $18.6k per day at $0.5449) into a far deeper pool
(`liquidity()` 1.07e19 at block 51,145,283) — and, per Addendum 5, the engine's single-sided
deposit sits BELOW the price earning nothing until the price falls into it. So v1's LP yield is
not what the model priced either; that is the §12 question, not a cbZEC one.

**Risk lines it adds.** None; it removes §5–§7 and §13's cbZEC lines from the shipped surface.
What it costs is the pitch: "a Base DeFi app for ZEC holders" becomes "for ZEC holders who bring
cbBTC or WETH, and can buy cbZEC on the side".

### 3 — Wait for an engine listing

**What it is.** Ask the engine's operator to add the cbZEC/USDC pool (`approvedPools` is
owner-set; the 214 entries include 81 stubs, so listings are cheap for them) with a position adapter
for the SECOND factory's pools (their Aerodrome adapter `0x0Aed…94D1` is built for the old NPM
`0x8279…5b72`; a pool under `0xe1f8…8b53` needs an adapter that knows that NPM and that gauge
factory — whether they have one was not read).

**Code cost.** ≈ 0 for Oilskin if the adapter exists on their side: `packages/shared/src/pools.ts`
gets the `enginePoolId` when it is listed; the `SnuggleLpVenue` already works on any listed entry
whose adapter answers `getTWAPTick` (slice B). If the listing lands with a stub adapter, nothing
works and the property filter in the fork test says so.

**What it proves.** Nothing until it lands; Oilskin has no lever on the timing.

**Yield.** The same emissions as option 1, minus the engine's 15 % of earnings, and — the
Addendum 5 finding — placed one-sided by the engine's single-sided deposit unless the open is
dual-sided (`deposit`, a centred range, which needs a swap of half the USDC into cbZEC first: a
swap the SwapRouter cannot do for this pool, option 1's problem again).

**Risk lines it adds.** The engine's (§12) on top of option 1's cbZEC lines; and a dependency on
a third party's roadmap for the product's headline asset.

## What is common to all three

- cbZEC cannot be collateral anywhere (§7); the leverage is against cbBTC / WETH in every option.
- The emissions exist as of this epoch and are 0.083 % of the Voter: a number to re-read every
  Thursday, never to bake into copy (the yield service's corroborated-anchor rule, `YIELD-SERVICE.md`,
  would refuse it for two more refreshes anyway).
- The B20 probe now shipped tells a user whether THEIR address can move cbZEC right now and what
  the multiplier is; it cannot see the issuer's policy (§4).
- The SwapRouter this repo verified cannot swap into this pool; any cbZEC swap on Oilskin's side is
  either CoW (as today) or a pool-direct path that does not exist yet.

## The question for the founder — answered

Whether a v1 that ships without cbZEC LP (option 2) is still the product — or whether option 1's
≈ 2,300 lines and its own audit surface are the price of the pitch, knowing the yield behind it is
one epoch's vote.

**Decided by the founder, 2026-09-10: option 1, direct Slipstream integration bypassing the
engine.** To be built in its own session against the second deployment's addresses recorded in
Addendum 8 (factory `0xf8f2…61Ef`, NPM `0xe1f8…8b53`, gauge `0x8779…81FB`, gauge factory
`0x3852…6AbB`), with the swap path settled first (a pool-direct adapter, or a router bound to that
factory that must be found and probed, never guessed).

**Built 2026-09-11 (slice F).** `contracts/src/venues/SlipstreamLpVenue.sol` (833 lines),
`contracts/src/swap/SlipstreamPoolSwapAdapter.sol` (190 — the pool-direct path with the callback;
no router bound to the second factory was found, and none was guessed), `interfaces/ISlipstream.sol`
(166, every signature from the verified sources — `VERIFIED-BASE-FACTS.md` Addendum 9),
`libraries/LiquidityAmounts.sol` (97, vendored), mocks (`MockSlipstream.sol`, `MockCLPool.sol`
extended), `test/SlipstreamLpVenue.t.sol` (24 tests), two fork tests, `Deploy.s.sol` (+1 venue, +1
adapter, +3 addresses, `DEPLOY_DIRECT_LP_VENUE`), the router (a second venue and adapter, resolved by
pool id on open and by `ownedPool` on unwind), the keeper (both venues' `positionsOf`), the web (the
pool id is the padded pool address, `lpPoolId`; claims target the direct venue; positions carry their
venue) and the yield service unchanged (it already gated the pool live). The order of magnitude the
memo estimated (≈ 2,300 lines) held. `RISKS.md` §12 carries the design and its residuals.
