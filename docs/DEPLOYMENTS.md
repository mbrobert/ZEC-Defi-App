# Deployments — every address Oilskin has put on a chain, with its date and block

**Status: nothing is deployed anywhere.** This file is the template a deployment fills in, and the
one place any other file may take a deployed address from — the keeper's and the web's env
files, the Sepolia Playwright suite (`web/e2e/sepolia.spec.ts`, which skips by name while the
table below holds no addresses) and `scripts/sepolia-postdeploy-check.sh` all read it. A row is
filled by the person who ran the deploy, from the script's own log, the same day. Nothing here
is ever a mainnet artefact until a **Base mainnet (8453)** section exists — and none does.

Acronyms: RPC = remote procedure call; LP = liquidity provision; ABI = application binary interface.

The parsers look for the first `0x…` (40 hex characters) on each row whose first cell is the key
in the table; an empty or non-address second cell means "not deployed". Keep the keys as they are.

## Base Sepolia (chain id 84532) — rehearsal, not a product deployment

| Key | Value | Where it comes from |
|---|---|---|
| chainId | 84532 | fixed |
| deployedAtBlock | | the `Chain 84532` block in the broadcast log (`DEPLOY-SEPOLIA.md` §4) |
| deployedAtUtc | | the wall clock when §4 finished, ISO 8601 |
| deployer | | the address `cast wallet import oilskin-sepolia` printed (§2b) |
| treasury | | `TREASURY` exported in §2b (may equal the deployer on a testnet) |
| registryOwner | | `REGISTRY_OWNER` exported in §2b — a second address; **pending** until `acceptOwnership()` (§5.5a), then **accepted** with its tx hash below |
| registryOwnerAccepted | | `pending` or the `acceptOwnership()` tx hash |
| OilskinAccountFactory | | script log, Oilskin addresses |
| OilskinAccountImplementation | | `cast call $FACTORY 'IMPLEMENTATION()(address)'` |
| CollateralRegistry | | script log |
| AaveV3Venue | | script log |
| SnuggleLpVenue | | script log |
| AerodromeSwapAdapter | | script log |
| MorphoBlueVenue | | script log (built over NO markets on Sepolia — `enabled()` is false) |
| StrategyRouter | | script log |
| PythOracleAdapter | | script log, if deployed (nobody pushes ZEC/USD on Sepolia) |
| cbZEC double (MockB20) | | script log, `Base Sepolia substitutes (NOT mainnet artefacts)` → keeper `CBZEC_ADDRESS`, web `NEXT_PUBLIC_CBZEC_ADDRESS` |
| AERO double (MockERC20) | | substitutes list → keeper `AERO_ADDRESS`, web `NEXT_PUBLIC_AERO_ADDRESS` |
| cbZEC/USDC pool double (MockCLPool) | | substitutes list |
| engine double (MockSnuggleVault) | | substitutes list |
| swap router double (MockAerodromeSwapRouter) | | substitutes list |
| cbzecUsdcTick | | the tick the script logged (`CBZEC_USDC_TICK` if overridden; −24509 was the 2026-09-07 mainnet value) |
| cbzecPoolId | 0x446b5f09e94e0becef972a2a3f2f0111ccb8cacb3146aa704bf8f75a6fe3e1d9 | `keccak256("aero-cl200-USDC-cbZEC")`, fixed |
| deployTxHashes | | every hash `--broadcast` printed, comma-separated (`contracts/broadcast/DeploySepolia.s.sol/84532/run-latest.json` is the source; that file stays untracked) |
| keeperAddress | | the observe-only keeper's address, if one is ever given a key on Sepolia (none is planned; observe-only has no key) |

Real Sepolia dependencies the deployment binds to (not deployed by us; verified in
`VERIFIED-BASE-FACTS.md`, "Addendum — Base Sepolia" and "Addendum 2"): Aave `PoolAddressesProvider`
`0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00`, test USDC `0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f`,
WETH `0x4200000000000000000000000000000000000006`, test WBTC `0x54114591963CF60EF3aA63bEfD6eC263D98145a4`,
Chainlink BTC/USD `0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298`, ETH/USD
`0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1`, USDC/USD `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165`,
Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`. These are in `packages/shared` `CHAINS[84532]`
and are never typed into an env file.

## Base mainnet (chain id 8453)

Not deployed. No section is added here until the founder deploys with `contracts/script/Deploy.s.sol`
(its guard refuses a treasury equal to the broadcaster and a registry owner that is not a contract),
and every address then goes through `VERIFIED-BASE-FACTS.md` first.
