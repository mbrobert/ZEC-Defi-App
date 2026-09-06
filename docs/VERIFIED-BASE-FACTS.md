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
  public GraphQL API failed on schema field names three times; **market ids for cbBTC/USDC and WETH/USDC must be
  discovered by the venue-adapter engineer (API introspection or on-chain `CreateMarket` events) before use.**
  No cbZEC market exists (consistent with the research).
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

- **Aerodrome Slipstream SwapRouter** — address not read; `contracts/script/Deploy.s.sol` requires it from `AERODROME_SWAP_ROUTER` and refuses mainnet without it; `exactInputSingle` shape unprobed.
- **Multicall3** `0xcA11bde05977b3631167028862bE2a173976CA11` — not read; the web uses viem's `base` chain definition with a per-call fallback; the keeper does one `eth_call` per read.
- **Morpho Blue market ids** for cbBTC/USDC and WETH/USDC — not discovered; `MorphoBlueVenue` ships disabled.
- **CoW GPv2VaultRelayer** — not read; the web reads `settlement.vaultRelayer()` at runtime.
- **The engine's live end-of-list revert shape** for `userPositions(address,uint256)` — logged by `test_fork_engineIndexGetterShape` when the fork suite runs with `FORK_URL`; never recorded here.
- **cbZEC B20 policy state** (blocklist, pause) — `owner()` / `paused()` revert on the precompile; only `multiplier()` was read (1e18).
- **Gauge emissions** for the curated pools other than cbZEC/USDC — the yield model's inputs are the 2026-08-31 words (block 50675328), not this read.
