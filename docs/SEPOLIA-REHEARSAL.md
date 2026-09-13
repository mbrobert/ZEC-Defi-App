# The Base Sepolia rehearsal — what it proves, what it cannot, and the checklist

One page (slice J, 2026-09-12). Base Sepolia (chain id 84532) is a rehearsal chain: real Aave v3
(its own test USDC and test WBTC, the WETH predeploy), real Chainlink BTC / ETH / USDC feeds, real
Pyth (nobody pushes ZEC/USD there), Permit2, Multicall3, Morpho Blue with no market — and
**doubles** for everything Base Sepolia does not have: cbZEC, AERO, the cbZEC/USDC pool, the
MaxFi/Snuggle engine, the Slipstream router (`DEPLOY-SEPOLIA.md` §1). Nothing is deployed yet
(`DEPLOYMENTS.md`). Every command in this file is read-only or the founder's to sign.

Acronyms: HF = health factor; LTV = loan-to-value; LT = liquidation threshold; LP = liquidity
provision; RPC = remote procedure call.

## What the rehearsal proves

- [ ] **The deploy order the audit reviewed runs on a real chain**: registry (immutable timelock)
      → `AaveV3Venue` against it → assets registered (WBTC stand-in and WETH offered at 5000 bps,
      the cbZEC double registered but disabled with its note) → two-step ownership hand-off →
      swap adapter → router. `scripts/sepolia-postdeploy-check.sh` reads all of §5.1–§5.4 back.
- [ ] **Wallet → factory → account → registry → `AaveV3Venue` → supply → borrow → `StrategyRouter`**
      against real Aave, real Permit2, real Chainlink — the account's `accountOf` determinism, the
      entry-HF floor read from Aave's live LT / LTV (8500 / 8350 WETH, 8300 / 8150 WBTC on
      2026-09-07), the two-step registry ownership.
- [ ] **The keeper's G1–G4 valuation, ladder, dispatch planning and per-venue snapshot, observe-only**:
      pointed at the deployment with `deploy/sepolia/keeper.observe-only.env.example`, no key. At
      startup it logs `NOT BASE MAINNET`, then the per-feed bounds it derived — compare them with
      the table below.
- [ ] **The web against a live chain that is not mainnet**: `deploy/sepolia/web.env.example`;
      `web/e2e/sepolia.spec.ts` (skipped by name until `DEPLOYMENTS.md` has addresses) checks the
      build names 84532, pins the cbZEC DOUBLE on sepolia.basescan.org, and says spot is mainnet-only.
- [ ] **The per-feed staleness rule on slower feeds than mainnet's**: measured, never typed.

### The feed bounds the keeper will derive (computed by the keeper's own code, 2026-09-12)

`node scripts/sepolia-feed-policy.mjs` — `agent/src/engine/feeds.ts` `buildFeedPolicies` against
the live aggregators at block **46,734,590** (18:24:28 UTC), the keeper's defaults **as they were on
2026-09-12** (6 rounds, slack × 2, floor 300 s, fallback 10,800 s):

> **The probe changed on 2026-09-13 (finding FEED-MED-1): the bound is measured over a 24-hour
> WINDOW of rounds, capped at 120 reads, not over six rounds.** Six rounds sampled in an active
> market contain only deviation-driven gaps, so the bound could land under a feed's own heartbeat.
> The measurement below stands as a record of that day; the bounds it derives are superseded.
> Re-read 2026-09-13 at block 46,782,519: **cbBTC/USD and WETH/USD 2,464 s** (a 1,232 s heartbeat
> inside the window, 101 and 113 rounds read), **USDC/USD 172,824 s** (86,412 s, two rounds) — every
> row `probe`, none `probe-short`.

| Keeper symbol | Sepolia feed | Gaps observed, newest first (s) | Max gap (s) | **Bound enforced (s)** | Round age at read (s) |
|---|---|---|---|---|---|
| cbBTC (priced by BTC / USD — there is no cbBTC/USD feed on Sepolia) | `0x0FB99723Aee6f420beAD13e6bBB79b7E6F034298` | 1222, 1230, 542, 1230, 1222 | 1,230 | **2,460** | 1,136 |
| WETH (ETH / USD) | `0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1` | 1202, 1230, 770, 1222, 1220 | 1,230 | **2,460** | 652 |
| USDC (USDC / USD) | `0xd30e2101a97dcbAeBCBC04F14C3f624E67A35165` | 86416, 86416, 86424, 86404, 86418 | 86,424 | **172,848** | 17,544 |

Read: the two moving feeds publish on a 1,200-second heartbeat (1,212–1,230 s between rounds, with
deviation rounds at 542 s and 770 s inside the window), so the keeper allows about 41 minutes
before it calls a BTC or ETH price stale on Sepolia — against mainnet's faster cadence this is the
loosest bound the product will ever run with, and it is still 4.4 × tighter than the old global
3-hour constant. USDC/USD publishes daily; its bound of two days is what makes the borrow leg
valuable at all (audit C-HIGH-2: the old constant made every account UNKNOWN). The bounds move a
little from read to read because the max gap does; the rule does not. The 2026-09-07 read
(`VERIFIED-BASE-FACTS.md` "Addendum — Base Sepolia") recorded the same 1,200 s / 86,400 s
heartbeats from Chainlink's reference data; this table is the measurement.

## What it cannot prove

- **Nothing about the live MaxFi/Snuggle engine, the live Aerodrome Slipstream router, cbBTC,
  cbZEC or AERO.** Those are doubles or absent. The 11 mainnet fork tests at a pinned block, plus
  `scripts/check-cbzec-b20.sh`, remain the only evidence about them (`TESTING.md`, "Contracts, fork").
- **Nothing about yields, gauges, the gate or the CoW spot** — all mainnet-only data; the
  rehearsal web runs without the yield service and offers hold-USDC / spot only, which is also
  today's mainnet verdict (`RISKS.md` §14).
- **Nothing about cbBTC's own price feed.** "cbBTC" on Sepolia is Aave's test WBTC priced by the
  BTC/USD feed; the keeper's residual (b) cross-check has nothing to disagree with there.
- **Nothing about the Morpho venue.** It deploys over no markets (`enabled() == false`) and the
  registry refuses to point an asset at it; rehearsing a venue switch means creating a market
  there first (`DEPLOY-SEPOLIA.md` §6.3, unchanged).
- **Nothing about the keeper signing.** Observe-only has no key; every rung is planned and logged,
  none is sent. Whether a signed keeper ever runs on Sepolia is the founder's decision.
- **Nothing about mainnet gas or the mainnet guard** (`Deploy.s.sol` refuses a treasury equal to
  the broadcaster and a registry owner that is not a contract; `DeploySepolia.s.sol` does not).
- **The mocks' public test switches** (`setPaused`, `setGlitch`, `setMultiplier`, …) are callable
  by anyone on the testnet — acceptable for a chain the founder alone exercises, and one more
  reason no Sepolia address may ever appear in a mainnet artefact.

## The checklist, in order (the founder's minutes are the signed steps only)

1. [ ] `DEPLOY-SEPOLIA.md` §2 — key imported, three exports, Sepolia ETH, tick re-read. *(minutes)*
2. [ ] §3 dry run passes (`SIMULATION COMPLETE`, `Chain 84532`). *(seconds)*
3. [ ] §4 deploy — the one broadcast. *(minutes)*
4. [ ] Fill the `DEPLOYMENTS.md` "Base Sepolia" table from the script log. *(minutes)*
5. [ ] `scripts/sepolia-postdeploy-check.sh` prints `… 0 FAIL`. *(read-only, seconds)*
6. [ ] §5.5a `acceptOwnership()` from the registry owner's key; re-run step 5 (the ownership line flips to "accepted"). *(one signature)*
7. [ ] Copy `deploy/sepolia/keeper.observe-only.env.example` → fill four addresses + `DISCOVERY_FROM_BLOCK` → start the keeper; its startup log shows `NOT BASE MAINNET` and per-feed bounds matching the table above within a few seconds' drift. *(observe-only, no key)*
8. [ ] Copy `deploy/sepolia/web.env.example` → `web/.env.local` → `npm run dev -w @zyo/web`; `cd web && npx playwright test -c playwright.sepolia.config.ts` now runs instead of skipping. *(read-only)*
9. [ ] §5.5b–c mint test collateral and create the account; the keeper discovers it on its next tick. *(two or three signatures)*
10. [ ] Record the date, block and tx hashes of steps 6 and 9 in `DEPLOYMENTS.md`.
