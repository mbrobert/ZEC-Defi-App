# Integration facts (verified 2026-08-05)

Everything the code assumes about external systems, with how it was verified.
Re-verify before mainnet.

## NEAR Intents · 1-Click API ✅ verified against live API + docs

- Base URL: `https://1click.chaindefuser.com`
- `GET /v0/tokens` — no auth; includes USD prices
- `POST /v0/quote` — Bearer JWT optional; **omitting JWT costs 0.2%/swap** —
  request a JWT before production volume
- `POST /v0/deposit/submit` — optional nudge `{depositAddress, txHash}`
- `GET /v0/status?depositAddress=…` — statuses: `PENDING_DEPOSIT`,
  `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`,
  `REFUNDED`, `FAILED`
- Quote request fields as implemented in `agent/src/services/oneClick.ts`
  (`dry, swapType, slippageTolerance, originAsset, depositType,
  destinationAsset, amount, refundTo, refundType, recipient, recipientType,
  deadline`)

Asset IDs (pulled from the live `/v0/tokens` list):

| Asset | assetId | decimals |
|-------|---------|----------|
| ZEC (native Zcash) | `nep141:zec.omft.near` | 8 |
| USDC on Base | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | 6 |
| cbBTC on Base | `nep141:base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near` | 8 |
| WETH on Base | `nep141:base-0x4200000000000000000000000000000000000006.omft.near` | 18 |
| USDC native NEAR | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | 6 |

Zcash: chain supported (`zec`); transparent addresses fully supported, unified
partially — UI warns on `u1…`.

## Snuggle.fi ✅ verified against snuggle.fi/docs

- Chains: **Base** + Arbitrum; DEXes: Uniswap v3, Aerodrome, PancakeSwap,
  Sushi v3, Camelot v3 (58+ pools)
- Range width: single-tick (~0.01%) to 50%; presets **Aggressive 0.5–3% ·
  Moderate 3.5–15% · Conservative 15–50%** (our presets mirror these bands)
- Rebalance delay: 0h (5–10 min effective) to 7 days
- Auto-compound: matching-token fees reinvest; non-matching to wallet
- Auto-snuggle: automatic repositioning toggle; zero-swap rebalancing =
  single-sided repositioning at range edge, no forced swaps
- Fees: 15% performance on earnings only; deposits/withdrawals/compounding free
- Single-token (single-sided) deposits supported

## MaxFi / Snuggle engine ✅ VERIFIED ON-CHAIN (2026-08-05)

The MaxFi Vault proxy's verified implementation is **SnuggleVaultUpgradeable**
("Core contract for Snuggle protocol") — MaxFi and SnuggleFi sharing contracts
is now confirmed at the bytecode level, not just asserted.

- Vault proxy (Base): `0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55`
- Implementation: `0x359f90ee4c2e21cbf6e32c5a062eeef306822d28` (solc 0.8.33)
- Also deployed: UniswapV3Adapter, AerodromePositionAdapter +
  AerodromeRewardAdapter, PancakeSwap adapters, StakingManager, ViewHelper,
  KeepersHelper (full list: maxfi.tech/security)
- Audits: 30 AI-audit cycles, 0 crit/high/med, 8 low accepted — **no
  third-party firm audit yet** (their own disclosure; factor into risk)

Real ABI facts our adapter now encodes (`ISnuggleVault.sol`):
`depositSingleSided(bytes32 poolId, token, amount, uint24 rangeWidthBps,
rebalanceDelay, autoSnuggle, autoCompound, deadline, ref) → tokenId`;
dual-sided `deposit(...)`; `withdraw(tokenId, returnNFT)` is FULL-CLOSE ONLY
(partials emulated adapter-side: close → pay share → re-deposit); fees pay by
transfer net of a 15% performance fee via `harvest` (unstaked) /
`claimStakingRewards` (staked); pools are a bytes32 registry
(`approvedPools`); range status via `outOfRangeSince`; `ref` = referral
(locked on first deposit — point it at the treasury); NO pending-fee views
(agent estimates off-chain).

## Rhea Finance ◐ asserted by project research, SDK unverified in-session

- rhea.finance: swaps, cross-chain lending, liquid staking; guide.rhea.finance
  is the doc root; active Zcash Gateway work (Zcash forum thread).
- Project research (see project instructions) asserts:
  `@rhea-finance/cross-chain-sdk` with MCA creation, intent-based native ZEC
  supply, borrow up to ~60% LTV, health factor reads, cross-chain delivery of
  borrowed assets. Encoded behind `RheaService`; wire per
  `agent/integrations/README.md`.
- Also on npm: `@rhea-finance/cross-chain-aggregation-dex` (swap aggregation).

## Rhea SDK reality check (2026-08-05)

`github.com/ref-finance/ref-sdk` (Rhea = rebranded Ref Finance) is the **swap
SDK** — v1 swaps, stable swaps, DCL, widget. It contains no lending, MCA, or
cross-chain-intents surface. The lending stack is the merged Burrow protocol;
`RheaService` should be wired against Burrow's NEAR contract views (health
factor, supplied/borrowed) + the intents deposit flow, with
`@rhea-finance/cross-chain-sdk` (npm) reconciled when installable.

## ⚠️ Open items before mainnet

1. Enumerate live bytes32 poolIds from the engine registry
   (`forge script script/Deploy.s.sol:EnumeratePools --rpc-url $BASE_RPC_URL`)
   and pin the curated list to them; verify SnuggleFi's own proxy address.
2. Wire `RheaService` to Burrow contract views over NEAR RPC (+ reconcile the
   npm cross-chain SDK when installable).
3. 1-Click JWT: request via the partner dashboard at
   https://partners.near-intents.org/home → set `ONE_CLICK_JWT` in `.env`
   (removes the 0.2% per-swap fee).
4. viem integration for agent writes (`agent/integrations/`).
5. Dry-run deposit/withdraw/harvest against the live engine on a Base fork
   (`forge test --fork-url $BASE_RPC_URL`) to validate ISnuggleVault against
   deployed bytecode.

Sources: [1-Click API docs](https://docs.near-intents.org/integration/distribution-channels/1click-api/quickstart/making-a-request),
[asset support](https://docs.near-intents.org/resources/asset-support),
[Snuggle docs](https://www.snuggle.fi/docs), [MaxFi](https://www.maxfi.tech/),
[Rhea](https://www.rhea.finance/), [Rhea guide](https://guide.rhea.finance/),
[Zcash forum — Rhea Zcash Gateway](https://forum.zcashcommunity.com/t/rhea-finance-zcash-gateway-browser-wallet-cross-chain-defi/55073).
