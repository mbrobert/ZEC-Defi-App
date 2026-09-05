# Oilskin Base-first v1 — build spec (all engineers build to THIS; deviations are reported, not improvised)
Read first: /home/claude/zyo/docs/BASE-PIVOT-2026-09.md (why), /home/claude/zyo/docs/VERIFIED-BASE-FACTS.md
(every address/parameter — use ONLY these; anything else must be probed before use), and
/home/claude/zyo/docs/AUDIT-FINDINGS-2026-09-03.md (what went wrong last time; Part 6 lessons are binding).
Repo: /home/claude/zyo (branch master; base = founder's 2026-08-29 tree; contracts 73 / agent 72 / yield 41 green).
Toolchain: node 22, npm registry reachable (install what you need), forge at /root/.foundry/bin/forge with
FOUNDRY_PROFILE=local (solc /root/.solc/solc-0.8.24), Playwright chromium at /opt/pw-browsers/chromium.
NO chain RPC from the container. No secrets. Never construct/sign/broadcast a real transaction.

## Product (v1, launchable with nothing external)
A connected wallet (Coinbase Wallet, MetaMask, WalletConnect, any EIP-6963) deposits cbBTC or WETH as
collateral on Aave v3, borrows USDC at the live rate, and deploys it into an Aerodrome LP position via the
Snuggle/MaxFi engine — or simply holds, or swaps spot via CoW. Positions are OWNED BY THE USER. Earnings are
claimable to the user's wallet. cbZEC: usable in spot and (once its gauge is voted) LP; as COLLATERAL it is
v1.1 and ships `enabled:false` with the reason shown. No NEAR, no Rhea, no 1-Click, no ZEC addresses in the
money path, no operator custody.

## Ownership model (replaces PositionVault/RewardRouter/PositionHolder — delete them)
- `OilskinAccount` — EIP-1167 clone per user; `owner` = the user's wallet address (immutable after init).
  `exec(target,value,data)` / `execBatch(Call[])` owner-only. Keeper permissions: `grant(keeper, Permission{
  target, selector, maxValuePerPeriod?, tokenSpendLimit{token,amountPerPeriod}, expiry})` owner-only,
  `revoke` owner-only, keeper calls go through `execAsKeeper` and are checked against the grant. ERC-721 and
  ERC-1155 receivers. `receive()` allowed. NEVER caches a token balance across an external call (cbZEC is a
  B20 with a live rebase multiplier). Reentrancy-guarded. No admin, no upgrade, no fee logic inside the
  account. This is the user's smart account; the router and venues are libraries/peripherals it calls.
- `OilskinAccountFactory` — CREATE2, `accountOf(owner)` predictable before deployment, `createAccount(owner)`
  anyone may call (deploys for that owner only). Emits `AccountCreated(owner, account)`.
- Positions on Aave live under the ACCOUNT address (account is `onBehalfOf`); Snuggle positions are minted to
  the account (it is `msg.sender` to the engine). The user can always `exec` anything from their own account —
  full self-custody, no lock-in.

## Venues
- `ICollateralVenue { supply, withdraw, borrow, repay, healthFactor(account), liquidationThresholdBps(asset),
  maxLtvBps(asset), debt(account,asset), collateral(account,asset), borrowRateRay(asset) }`.
- `AaveV3Venue` (library-style; addresses from VERIFIED-BASE-FACTS; e-mode NOT used in v1; reads LT/LTV from
  `PoolDataProvider` at call time — no constants). `MorphoBlueVenue`: interface + skeleton + a documented TODO
  to discover live market params (id = keccak of MarketParams); ships disabled.
- `ILpVenue { open(params) → positionId, increase, close(positionId, band) → (out0,out1,rewards), claim,
  positionsOf(account) }`. `SnuggleLpVenue` implements it over ISnuggleVault with the C-2 index enumeration
  (`userPositions(address,uint256)` until revert, canary-measured end-of-list), refund folding after every
  deposit, decimals-aware dust floor, per-id try/catch close paying what closed, and the re-mint price band
  read from the pool's `slot0()` failing closed. Width bounds [150, 5000] total tick span; presets from shared.
- `CollateralRegistry` (owner-set): asset → {venue, decimals, priceFeed, enabled, maxOfferedLtvBps, note}.
  maxOfferedLtvBps is DERIVED on-chain as floor(liquidationThresholdBps / entryHfFloor) capped at 5000, never
  typed. cbZEC registered with enabled=false, note="no collateral market on Base yet".
- `StrategyRouter` — stateless; `openLeveragedLp(OpenParams)` executes, via the caller's OilskinAccount
  (creating it if absent): Permit2 pull → venue.supply → venue.borrow(USDC) → swap to the LP entry token if
  needed (via a minimal `ISwapAdapter`; v1 implementation = direct Aerodrome router call with minOut+deadline;
  CoW is off-chain and handled in web) → lpVenue.open. `unwind(...)` is the mirror. Every hop has deadline
  and minOut. Router holds NOTHING between transactions and has NO owner powers over user funds.
- `PythOracleAdapter` (v1.1, build now, ship unused): Morpho `IOracle.price()`; requires a fresh Pyth update
  posted in the same tx (`updatePriceFeeds` with fee) and enforces `maxAge`; peg circuit breaker compares the
  Aerodrome cbZEC/USDC pool TWAP against Pyth ZEC/USD and reverts `PegBreak` beyond `maxDeviationBps`.

## Fees — one source of truth (packages/shared `FEES`), consumed everywhere, capped on-chain
- performanceBps = 1000 on REALISED yield (rewards/LP fees at claim/compound), MAX_PERFORMANCE_BPS = 2000
  immutable; never on principal; taken at the single chokepoint in `SnuggleLpVenue.claim/close`.
- No orchestration fee in v1. curatorBps (v1.1 vault) = 1000. Treasury address is a constructor param.

## Health-factor ladder — per asset, derived (packages/shared), consumed by keeper, web, prototypes
entryHfFloor 1.55; rungs warn 1.50 / repay 1.35 / derisk 1.20 / emergency 1.05, hysteresis 0.05 (disarm at
rung+0.05). entryHf(asset, ltv) = LT(asset)/ltv with LT read from the venue. LTV presets 30/40/50 %; the top
preset is min(50%, floor(LT/1.55)) per asset → cbBTC (LT 0.78) → 50%, WETH (0.83) → 50%. All computed.

## Yield gate (services/yield) — unchanged rule, new inputs
Offer a pool at a setting only when emissions×(1−perfFee) + IL drag > the LIVE Base USDC borrow rate (Aave
DataProvider). Emissions-only; cbZEC/USDC pool tracked but has rewardRate 0 → never offered until voted.

## Web (Next.js in /home/claude/zyo/web)
wagmi v2 + viem + @coinbase/wallet-sdk + WalletConnect via ConnectKit or RainbowKit (pick one), Base chain
only, EIP-6963. Flows: Connect → (Onboarding for ZEC holders: "ZEC on Coinbase → cbZEC on Base" with the
US-ex-NY jurisdiction check, KYC/transparent-only facts, counterfeit-address warning pinning the real cbZEC
address) → Choose collateral (cbBTC / WETH live; cbZEC shown disabled with reason) → Choose setting (30/40/50)
→ Choose strategy (pools that clear the gate / hold USDC / spot) → Review (every number computed; the risk
list) → Sign (account creation if first time, then the router call). Dashboard reads the connected address's
account positions FROM CHAIN (viem multicall) with the indexer as cache. Spot via CoW SDK (quote → sign
order). Demo mode when no wallet. Disclosures per BASE-PIVOT §4 item 19. Zero typed ±/HF/LTV literals.

## Keeper (agent/) — replaces the Rhea monitor
Watches every OilskinAccount's Aave health via viem, runs the ladder with hysteresis and idempotent dispatch
(design from AUDIT-FINDINGS Part 5), acts ONLY through `execAsKeeper` within the user's grant, fail-closed on
any unreadable input, progress watchdog. rhea.ts / rheaSdk.ts / oneClick.ts are DELETED, not stubbed.

## Non-negotiables
1. Push discipline: every engineer writes /tmp/build/done-<AREA>.md the moment their suite is green.
2. No typed derived numbers (±, HF, LTV, fee). 3. No claim in UI/docs the code does not enforce.
4. Every external address from VERIFIED-BASE-FACTS only. 5. Tests for every behaviour; suites green.
6. Remove, don't stub, the NEAR/Rhea/1-Click/ZEC-address code in your area, then grep the WHOLE repo for
   references to what you removed and list them in your report (the founder's standing rule).
