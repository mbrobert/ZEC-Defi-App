# Oilskin

**Oilskin lets you borrow against a coin you do not want to sell, and decide for
yourself how much risk that costs you.** You deposit the coin as collateral, you
borrow US dollars (USDC) against it, and you either keep those dollars or put
them to work — all inside a smart account that only your own wallet owns. It is
built for ZEC holders first: wherever a market for ZEC exists, a ZEC holder
should be able to deploy it there through Oilskin
(`docs/DIRECTION-2026-09-11.md`).

**Who it is for.** Someone who has never used DeFi. One decision per screen,
plain words, the risk stated before the button, and a Simple / Advanced toggle
that hides or shows the machinery. Nothing here is advice: the app shows its
numbers and you choose.

**You set the risk, on a slider.** One continuous control sets your *health
factor* — how far your collateral can fall before the position is liquidated —
and moves the borrow amount with it, in both directions. It cannot go below the
floor the on-chain registry enforces (1.25) or above the lending venue's own
limit; "Sheltered" (1.55) and "Expert" (1.30) are marks on that slider, not
modes. Every protective step the keeper later takes is derived from the number
you picked.

**Base module.** Deposit **cbBTC** or **WETH** on Base, borrow **USDC** on Aave
v3 or Morpho Blue, and — if you want — deploy that USDC into an **Aerodrome
Slipstream** liquidity position, after seeing what the model forecasts it will
earn or lose. **cbZEC** is spendable in spot swaps and is registered as
collateral but **disabled**, with the reason shown, because no lending market on
Base lists it yet.

**Solana module.** Deposit **bridged ZEC** on Kamino's ZCASH market, borrow
**USDC**, and have the same risk ladder run by an Anchor program whose account
your wallet owns. It is borrow-and-hold: there is no liquidity-provision leg on
Solana, so the loan either sits or comes home.

**A loan stays on the chain it was borrowed on.** The debt, the collateral and
the repayment never move. What *may* cross is the borrowed USDC: Circle's
Cross-Chain Transfer Protocol (CCTP) can carry it from a Solana loan to your own
Base account and into Aerodrome, and close and burn it back the other way
(`docs/BUILD-PLAN-2026-09-12.md` D6). If that transfer stalls, the Solana loan is
still repayable from a reserve on its own chain.

**Nothing is deployed.** No transaction has ever been signed or broadcast from
this repository, no external audit has been done, and the web app runs in demo
mode until a deployment's addresses exist. `docs/STATUS.md` — generated, never
typed — carries what is deployed, what every suite counts today, what the
forecast says and what the internal audits found.

```bash
npm install
npm run build -w @zyo/shared    # every workspace imports its dist/
npm run web                     # http://localhost:3000, demo mode
```

Read next: **`docs/BUILD-PLAN-2026-09-12.md`** (the plan of record — decisions
D1–D13), then `SETUP.md` (build and run everything), `docs/STATUS.md` (today's
numbers), `docs/RISKS.md` (every risk, and what does *not* mitigate it),
`docs/TESTING.md` (what each suite proves), `docs/ROADMAP.md` (dates and
trade-offs). The full index of `docs/` is generated into
[`docs/STATUS.md`](docs/STATUS.md#every-document-in-docs).

Abbreviations used below: LP = liquidity provision; LTV = loan-to-value; HF =
health factor; RPC = remote procedure call (a chain node endpoint); ABI =
application binary interface; EIP = Ethereum Improvement Proposal; PDA =
program-derived address (a Solana account a program owns).

## Who holds what

Every Base position is owned by the user's own `OilskinAccount` — an EIP-1167
clone whose `owner` is the wallet that created it and can never change. Oilskin's
own contracts hold nothing between transactions: the router's balance of every
token it touches is asserted **unchanged** across every call, as a delta rather
than a zero. (Asserting a zero was the internal audit's one Critical: a single
base unit of USDC sent by a stranger would have bricked the protocol
permanently.) On Solana the equivalent is a PDA the user's wallet owns; because
Kamino refuses to hand a PDA-owned obligation to a wallet, the exit there is
always through the program.

A keeper may act on an account only inside a grant the owner signed and can
revoke, and that grant is a single root call whose peripheral rights only the
owner can switch on.

**Oilskin does have one privileged role, and says so.** The `CollateralRegistry`
owner chooses which asset is offered at which venue. It can disable any asset
**instantly**, move the entry health-factor floor **instantly** within (1.0,
10.0], and replace a venue **after an immutable on-chain delay** — after which
the new contract receives every calling account's peripheral rights. The delay
and its events are a warning, not a prohibition. So the product makes no claim
to be free of operator powers: the phrasings that used to say otherwise are in a
banned-words list and grep-tested in `web/test/copy.test.ts`. See
`docs/RISKS.md` §16.

## The forecast is a forecast, not a gate

Every curated pool × setting is shown with both of the model's LP-net numbers
(a published closed form and a Monte-Carlo-calibrated one), the gap between
them, the impermanent-loss drag, the break-evens, your net at the health factor
you chose, the drawdown to liquidation, and the borrow rate *after* your own
borrow moves the venue's curve. Any of them may then be opened, once you tick
one sentence that names those numbers (`docs/BUILD-PLAN-2026-09-12.md` D4/D5).

The only refusals are safety: the registry's entry floor, a borrow the pool
cannot fund, stale rates, a paused or inactive reserve, a disabled asset, an
unfunded cross-chain reserve. The model is computed from recorded chain reads,
never curated — `GET /v1/forecast` serves it, the site consumes it, and
`docs/STATUS.md` carries what it says today.

## Repo layout

| Path | What is in it |
|---|---|
| `contracts/` | Foundry (Solidity 0.8.24, via-IR) — `OilskinAccount` + factory, `StrategyRouter` (including the CCTP arrival, `openLpOnly` and `closeLpAndBurn`), `AaveV3Venue`, `MorphoBlueVenue`, `SnuggleLpVenue`, `SlipstreamLpVenue` + `SlipstreamPoolSwapAdapter`, `CollateralRegistry`, `AerodromeSwapAdapter`, `PythOracleAdapter` (v1.1, unused) |
| `solana/` | Anchor workspace — the `oilskin` program (the PDA position, the Kamino CPIs, the entry-HF record, the per-position ladder, the USDC reserve, `deposit_for_burn`), its localnet harness and fixtures, and `scripts/gen-ladder.mjs`, which generates the program's ladder constants from `packages/shared` so the two chains cannot drift |
| `agent/` | The keeper daemon — discovers accounts, values health fail-closed across every venue the registry names (with per-feed staleness), acts only through one root `StrategyRouter.unwind` inside the user's grant, and notifies. `agent/src/solana/` is the same job on Solana, plus the cross-chain class that watches a CCTP transfer and falls back when it stalls |
| `services/yield/` | Live Aave and Kamino rates, Aerodrome gauge emissions, the two-model yield forecast (`/v1/forecast`), the LP model and its empirical bands — an HTTP API plus a backfill CLI |
| `web/` | Next.js 14 — wallet connect, cbZEC onboarding, the wizard and the risk slider, a venue-aware dashboard reading the chain, the keeper panel, CoW Protocol spot swaps, the `/solana` flow; demo mode without a wallet |
| `packages/shared/` | The one source for addresses, fees, the health-factor ladder (`ladderFor(entryHf)`), the slider's bounds, the widths and the pools — imported by every other workspace and by the Solana program's generated constants |
| `prototype/` | `simple.html` and `index.html` — dependency-free walkthroughs pinned to the same facts and model numbers |
| `scripts/` | `verify-abi.mjs` (generates and diffs `contracts/abi/oilskin-abi.json` — the ABI is never hand-typed), `status.mjs` (writes `docs/STATUS.md`), and the chain-reading tools |
| `docs/` | The plan, the verified facts, the audits, the risks. Index: [`docs/STATUS.md`](docs/STATUS.md#every-document-in-docs) |

## Tests, and today's numbers

```bash
npm run status              # runs the suites and rewrites docs/STATUS.md
npm run status -- --all     # plus fork, Solana localnet, cargo and Playwright
npm run status -- --check   # exits 1 if docs/STATUS.md is out of date
```

Counts live in `docs/STATUS.md` because that file is generated; this one is not,
and README counts went stale three different ways at once before the generator
existed. What each suite *proves* is `docs/TESTING.md`; every suite's own
command is in both. `SETUP.md` covers the prerequisites — Node ≥ 22, Foundry
with two libraries cloned into `contracts/lib`, and for `solana/` the Rust,
Solana CLI and Anchor toolchain.

## Running the pieces

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

Never run the keeper, the yield service or the web app against mainnet with a
signing key.

## What is real and what is a plan

**Real, in this tree:** the contracts and their suites; the Solana program,
proven on a local validator; the keeper on both chains, including the
cross-chain path; the yield service and its model; the web app in demo mode;
the prototypes.

**Prepared, not run:** a **Base Sepolia** deployment — script, offline tests, a
dry run that cleared the live guard, and a runbook (`docs/DEPLOY-SEPOLIA.md`).
The founder holds the keys; nothing has been broadcast. The cross-chain loop is
built on both chains but **has never moved value across one**: it still needs a
process holding a Base key beside the Solana one, the address lookup table both
transactions need, and a devnet ↔ Sepolia run
(`docs/CROSSCHAIN-RUNBOOK-2026-09-13.md`).

**Internal audits, not an external one:** three adversarial waves, each with its
fix round — wave 1 (`docs/AUDIT-2026-09-06.md`), wave 2
(`docs/AUDIT-2026-09-07.md`) and wave 3 (`docs/AUDIT-2026-09-11.md`) — plus the
nightly invariant finding (`docs/AUDIT-2026-09-12.md`) and the four passes of
2026-09-13 over the Solana module, the cross-chain code, the keeper's feed
staleness, the risk slider and the forecast service
(`docs/AUDIT-2026-09-13.md`). Every finding's severity, fix commit and
regression test is in its own record, and the regressions run in
`contracts/test/audit-regressions/`. Inquiries to external firms went out on
2026-09-13. `docs/STATUS.md` tabulates all of it.

**Plans, not shipped:** a Base mainnet deployment; an external audit; a multisig
registry owner with a watcher on `VenueChangeProposed`; a keeper notification
channel that actually reaches a person; a cbZEC collateral market and the Pyth
oracle adapter in use; moving cbBTC/WETH from Aave to Morpho Blue (built and
tested — the registry owner's propose → timelock → accept has not been run); the
perps and tokenized-stock lines. `docs/RISKS.md` states every risk with what
mitigates it and what does not; `docs/PRIVACY.md` says plainly that the cbZEC
entry runs through a Coinbase account and that everything on Base is public.
