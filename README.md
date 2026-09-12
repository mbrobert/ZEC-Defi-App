# Oilskin — chain-agnostic, ZEC-holder-centric

Wherever a market for ZEC exists, a ZEC holder can deploy it there through
Oilskin (founder's direction, `docs/DIRECTION-2026-09-11.md`). Two modules under
one policy layer — the health ladder, the entry rule, the copy rules and the one
website live in `packages/shared` and `web/`; the account container and the venue
adapters are built per chain:

- **Base module (v1, this tree):** everything below this paragraph.
- **Solana module (built 2026-09-12, proven on localnet, not deployed):** bridged
  ZEC on Kamino's ZCASH market, USDC borrowed, the same ladder run by an Anchor
  program + program-derived account the wallet owns, protected by the keeper's
  Solana path (`agent/src/solana/`) — `docs/VERIFIED-SOLANA-FACTS.md` (read live),
  `docs/SOLANA-ARCHITECTURE.md` (the design, the founder's decisions, what the
  localnet runs proved), `solana/` (the program, the localnet harness, 26 specs).

A loan never crosses a chain.

## Base module — v1

Oilskin lets a wallet on Base (Coinbase Wallet, MetaMask, WalletConnect, or any
EIP-6963 wallet — EIP is an Ethereum Improvement Proposal) deposit **cbBTC or
WETH** as collateral on **Aave v3**, borrow **USDC** at the live rate, and
either keep the USDC or put it into an **Aerodrome Slipstream** concentrated-
liquidity (CL) position through the **Snuggle/MaxFi engine** — but only when the
yield gate says that pool clears the borrow rate. Spot swaps go through **CoW
Protocol** batch auctions. **cbZEC** (Coinbase Wrapped ZEC) is usable in spot; it
is registered as collateral but **disabled** with the reason shown, because no
lending market on Base lists it (`CollateralRegistry.register(cbZEC, …,
enabled=false, "no collateral market on Base yet")` in
`contracts/script/Deploy.s.sol`).

Every position is owned by the user's own `OilskinAccount` — an EIP-1167 clone
whose `owner` is the wallet that created it and can never change
(`contracts/src/account/OilskinAccount.sol`). Oilskin's contracts hold nothing
between transactions: the router's balance of every token it touches is
**unchanged** across every call, asserted as a delta rather than a zero
(`StrategyRouter._assertUnchanged` — asserting a zero on a public address was
the audit's Critical, because one base unit sent by anybody would have bricked
the protocol permanently). A keeper may act on an account only within a grant
the owner signed and can revoke (`OilskinAccount.grant` / `revoke` /
`revokeAll`), and since 2026-09-06 that grant is a single root call
(`StrategyRouter.unwind`) whose peripheral rights only the owner can enable.

**Oilskin does have one privileged role, and says so.** The `CollateralRegistry`
owner chooses which asset is offered at which venue contract. It can disable any
asset **instantly**, move the entry health-factor floor **instantly** within
(1.0, 10.0], and replace a venue **after an immutable on-chain delay** (2 days
as deployed) — after which that new contract receives every calling account's
peripheral rights. The delay and its events are a warning, not a prohibition.
The product therefore makes no claim of being free of operator powers — the
phrasings that used to appear in the UI copy are now in a banned-words list and
grep-tested in `web/test/copy.test.ts` and `prototype/test/verify-toggle.mjs`.
See `docs/RISKS.md` §16.

**This is a demo-status build.** Nothing is deployed on Base, no transaction has
been signed or broadcast, and no external audit has been done — an internal
adversarial audit (wave 1, four lenses) and its fix round are recorded in
`docs/AUDIT-2026-09-06.md`. The web app runs in demo mode until a deployment's
addresses are configured (`web/lib/env.ts: contractsConfigured()`).

Abbreviations used below: LP = liquidity provision; LTV = loan-to-value; RPC =
remote procedure call (a chain node endpoint); ABI = application binary
interface; KYC = Know Your Customer.

## The honest yield forecast

Since 2026-09-12 (`docs/BUILD-PLAN-2026-09-12.md` D4/D5, step A3) the yield model is a
**forecast, not a gate**: every curated pool × setting is shown with both of the model's
LP-net numbers, the gap between them, the impermanent-loss drag, the break-evens, the
user's net at the loan-to-value they chose, the liquidation drawdown and the borrow
rate *after* their own borrow on the venue's curve — and any of them may be opened after
an acknowledgment that names those numbers. The only refusals are safety: the registry
entry floor, a borrow the pool cannot fund, stale rates, a paused or inactive reserve, a
disabled asset. `GET /v1/forecast` serves it (`services/yield/src/forecast.ts`); the site
consumes it (`web/lib/forecast.ts`) and the demo snapshot is the evaluator's own output
on the recorded inputs (`services/yield/samples/demo-forecast.json`, pinned cell for cell).

What the forecast says today is unchanged from what the gate said. At the USDC variable
borrow rate of **4.5174 %** (Aave v3 Base `PoolDataProvider.getReserveData(USDC)`, read live
2026-09-12 19:31 UTC at block 51,226,072 together with every Aerodrome gauge word,
`docs/VERIFIED-BASE-FACTS.md` Addendum 12) **no pool × setting beats the borrow on both
models**: 0 of 27 cells in `docs/MODEL-NUMBERS-2026-09-12.md` (generated by
`services/yield/scripts/lp-sim.py` from that sample — `npm run model` reads every input
from the sample file — and pinned cell-by-cell by `services/yield/test/model-pin.test.ts`,
`web/test/snapshot.test.ts` and `prototype/test/verify-toggle.mjs`). The best cell,
cbBTC/USDC at the "sheltered" width, forecasts **−10.92 %/yr** on the LP slice after the
engine's 15 % fee, Oilskin's 10 % performance fee and the impermanent-loss drag at the
recorded volatility (the stricter Monte-Carlo form says −10.89 %); it would need **4.56×**
today's net emissions to break even. Every priced cell's LP slice is negative, so no borrow
rate would turn one positive at today's emissions. The cbZEC/USDC gauge carries its first
emissions vote (≈ 617 AERO a day to 2026-09-17) — 1 to 17 % gross across the widths — and
still sits below the borrow at the two wider widths, with no calibrated σ at the narrowest.

The model prices every cell **twice** — the published closed form and a Monte-Carlo-
calibrated form — and reports both, with the gap: at the boundary where the closed form
used to flip, it is 0.1–32 points optimistic (`docs/MODEL-NUMBERS-2026-09-12.md`; one cell,
WETH/cbBTC at the working width, also breaches the closed form's own tolerance at today's
emissions — `docs/RISKS.md` §14). Where the two forms disagree the site says so; it no
longer refuses.

Gauge-emission inputs are the 2026-09-12 words (block 51,226,072); σ is the 2026-08-31
realized volatility; the USDC borrow curve and pool liquidity are the 2026-09-12 20:25 UTC
read at block 51,227,701 (Addendum 13). Re-run `npm run backfill -- sample` (with
`BASE_RPC_URL` set to a Base RPC that serves the batched read and
`GECKO_MIN_INTERVAL_MS=15000` for GeckoTerminal), `npm run model` and
`npm run demo-forecast` in `services/yield` before believing any number.

What the product does with the forecast: Simple mode shows every pool at its best setting
and names the least-bad one as a loss when it is one (`web/lib/recommend.ts`); Advanced mode
shows every pool × setting with both numbers and the gap; before any new position — LP,
hold or spot — the user ticks one sentence that states the forecast, the borrow cost and the
drawdown to liquidation for that position. The forecast is computed, never curated.

## Repo layout

| Path | What | Verified state (2026-09-10, this tree) |
|---|---|---|
| `contracts/` | Foundry — `OilskinAccount` + factory, `StrategyRouter`, `AaveV3Venue`, `SnuggleLpVenue`, `SlipstreamLpVenue` + `SlipstreamPoolSwapAdapter` (cbZEC/USDC held directly on the second Slipstream deployment, 2026-09-11), `CollateralRegistry`, `AerodromeSwapAdapter`, `MorphoBlueVenue` (built over the two verified Base markets; not the registry's venue until propose → timelock → accept), `PythOracleAdapter` (v1.1, unused) | 374 passed / 0 failed / 12 skipped (2026-09-11; the 12 fork tests need `FORK_URL` — 10 of them run against Base on 2026-09-10: 9 pass / 1 fail, `docs/TESTING.md`), 29 suites |
| `agent/` | Keeper daemon (viem) — discovers accounts, values health fail-closed across every venue the registry names (the Aave pool cross-checked by G1–G4, any other venue against the Chainlink feeds by V1–V4, the worst venue runs the ladder) with per-feed staleness, acts only via one root `StrategyRouter.unwind` inside the user's grant, and notifies | 233 tests / 45 suites; `verify-abi` 72/72 |
| `services/yield/` | Live Aave rates, Aerodrome gauge emissions, the two-model yield gate, the LP model, empirical bands — HTTP API + backfill CLI | 131 tests |
| `web/` | Next.js 14 — wallet connect, cbZEC onboarding, wizard, venue-aware chain-read dashboard with a keeper panel and a pending-venue banner, CoW spot; demo mode without a wallet | 152 unit tests (150 passed, 2 skipped); Playwright 12/12 |
| `packages/shared/` | The one source for addresses, fees, the health-factor ladder, LTV presets, widths, pools | 59 tests |
| `prototype/` | `simple.html` and `index.html` — dependency-free walkthroughs pinned to the same facts and model numbers | 289 checks (118 + 109 + 56) + 6 fuzz |
| `scripts/verify-abi.mjs` | Generates / diffs `contracts/abi/oilskin-abi.json` from `contracts/out` | 327/327 |
| `docs/` | `ARCHITECTURE` · `FLOWS` · `DEPOSIT-FLOW` · `RISKS` · `AUDIT` · `AUDIT-SCOPE` · `AUDIT-2026-09-06` · `TESTING` · `PRIVACY` · `CONTRACT-ABI` · `VERIFIED-BASE-FACTS` · `BASE-PIVOT-2026-09` · `BUILD-SPEC-2026-09` · `YIELD-SERVICE` · `MODEL-NUMBERS-2026-09-05` · `CHANGELOG` | this build |

## Run every suite

```bash
# Contracts — Foundry. Libraries are not vendored; clone the pinned versions once:
cd contracts
git clone --depth 1 --branch v5.7.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git clone --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std lib/forge-std
forge test                                   # 380 pass, 0 fail, 11 fork tests SKIPPED without FORK_URL (2026-09-12) (isolation pinned in foundry.toml; --no-isolate is green too)
FORK_URL=<Base RPC> forge test --match-path test/fork/BaseFork.t.sol -vv   # the 11 fork tests — 2026-09-12 against Base at block 51,222,568: 11 pass / 0 fail; cbZEC's B20 shape is scripts/check-cbzec-b20.sh (no fork EVM can run it)
# (offline container with a pre-fetched solc: FOUNDRY_PROFILE=local forge test)

# Root ABI seam — regenerates or diffs contracts/abi/oilskin-abi.json against contracts/out
node scripts/verify-abi.mjs                  # exits 1 on drift; --write to regenerate

# Node workspaces (Node ≥ 22). Build shared first; every consumer imports its dist/.
npm install
npm test -w @zyo/shared                      # 53
npm test -w @zyo/agent                       # tsc + verify-abi (54/54) + 171 tests
npm test -w @zyo/yield                       # tsc + 131 tests (RPC mocked with recorded chain words)
npm test -w @zyo/web                         # 125 unit tests (ABI drift + both MODEL-NUMBERS pins run, not skipped)
cd web && PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npx playwright test   # 12 (6 scenarios × 2 viewports)

# Prototypes (Playwright + Chromium)
CHROMIUM_PATH=/opt/pw-browsers/chromium node prototype/test/run-all.mjs   # 118 + 109 + 56 + 6
```

`docs/TESTING.md` says what each suite proves and how the counts were obtained.

## Run the apps

```bash
# Keeper — observe-only without KEEPER_PRIVATE_KEY (rungs recorded, on-chain actions REFUSED)
cd agent && BASE_RPC_URL=<rpc> ACCOUNT_FACTORY_ADDRESS=<factory> DISCOVERY_FROM_BLOCK=<factory deploy block> \
  STORE_PATH=/abs/keeper.json npm run dev
# add KEEPER_PRIVATE_KEY=<hex> STRATEGY_ROUTER_ADDRESS=<router> to act via execAsKeeper

# Yield service — http://127.0.0.1:8787 (rates 503 until BASE_RPC_URL yields a sample)
BASE_RPC_URL=<rpc> npm run yield

# Web — http://localhost:3000; demo mode until NEXT_PUBLIC_OILSKIN_FACTORY / _ROUTER are set
npm run web

# Prototypes — open prototype/simple.html or prototype/index.html, or `bash start-demo.command`
```

## What is real and what is a plan

Real, in this tree: the contracts above with their tests; the keeper; the
yield service and model; the web app in demo mode; the prototypes.

Prepared, not run: a **Base Sepolia** deployment — script, offline tests, a
dry run that cleared the live guard, and a runbook in `docs/DEPLOY-SEPOLIA.md`;
the founder holds the keys and nothing has been broadcast.

Plans, not shipped: a deployment on Base mainnet; an external audit; a multisig
registry owner and a watcher on `VenueChangeProposed`; a keeper notification
channel that actually reaches a person; the cbZEC
collateral market and the Pyth oracle adapter in use (v1.1, `docs/BASE-PIVOT-2026-09.md`
§3); moving cbBTC/WETH from Aave to the Morpho Blue venue (built and tested, and the keeper and the web now read whichever venue the registry names; the registry owner's propose → timelock → accept, not run); the perps and
tokenized-stock lines (v1.2). `docs/RISKS.md` states every risk with what
mitigates it and what does not; `docs/PRIVACY.md` states plainly that the cbZEC
entry runs through a Coinbase account and that everything on Base is public.
