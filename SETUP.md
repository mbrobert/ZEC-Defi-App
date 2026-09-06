# Oilskin — setup

Base-first v1 (2026-09-05). What is in the tree, how to build it, how to run
it. Status and risks: `README.md`, `docs/RISKS.md`. Nothing here is deployed;
every "live" path below needs addresses that do not exist yet.

Abbreviations: EVM = Ethereum Virtual Machine; ABI = application binary
interface; RPC = remote procedure call (a chain node endpoint); LP = liquidity
provision; LTV = loan-to-value; HF = health factor; CI = continuous integration.

## Toolchain

- Node ≥ 22 and npm (workspaces: `packages/shared`, `agent`, `services/yield`, `web`).
- Foundry (`forge`) for `contracts/`; solc 0.8.24, via-IR, EVM `cancun`
  (transient storage is used by `OilskinAccount` and `PythOracleAdapter`).
  Offline containers with a pre-fetched compiler: `FOUNDRY_PROFILE=local`
  (`contracts/foundry.toml`).
- Playwright Chromium for the web e2e and the prototype suites
  (`PLAYWRIGHT_BROWSERS_PATH` / `CHROMIUM_PATH`).
- Python 3 for the LP model (`services/yield/scripts/lp-sim.py`).

## Clone and build

```bash
git clone https://github.com/mbrobert/ZEC-Defi-App.git && cd ZEC-Defi-App
npm install                                   # all workspaces
npm run build -w @zyo/shared                  # every consumer imports shared's dist/
cd contracts                                  # vendored libraries are NOT committed:
git clone --depth 1 --branch v5.7.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
git clone --depth 1 --branch v1.16.2 https://github.com/foundry-rs/forge-std lib/forge-std
forge build
```

The compiled artifacts feed two ABI (application binary interface) seams:
`node scripts/verify-abi.mjs --write` regenerates `contracts/abi/oilskin-abi.json`
(266 selectors / topics / errors across 17 contracts); `web/scripts/sync-abi.mjs`
generates `web/lib/abi/oilskin.generated.ts` from that bundle; the agent's
`scripts/verify-abi.mjs` checks its hand-written encoders against
`contracts/out` (36 checks; runs inside `npm test -w @zyo/agent`; set
`VERIFY_ABI_STRICT=1` in CI so a missing artifact is fatal instead of a loud skip).

## Test everything

See `README.md` ("Run every suite") for the commands and `docs/TESTING.md`
for what each suite proves. Summary for this tree: contracts 181 pass / 8
fork tests skipped without `FORK_URL`; agent 139; yield 105; web 89 unit +
12 Playwright; shared 52; prototypes 216 checks.

## Run

### Keeper (`agent/`)

Required env: `BASE_RPC_URL` (http/https), `ACCOUNT_FACTORY_ADDRESS`,
`DISCOVERY_FROM_BLOCK` (the factory's deployment block), `STORE_PATH`
(absolute path, no whitespace). Add `KEEPER_PRIVATE_KEY` and
`STRATEGY_ROUTER_ADDRESS` to act; without a key the keeper runs observe-only
(rungs recorded, every on-chain action `REFUSED`, never silent —
`agent/src/dispatch/observeOnly.ts`). Optional knobs (`agent/src/config.ts`,
every one strictly parsed, floors > 0): `CHAIN_ID` (8453), `HEALTH_POLL_MS`,
`RPC_DEADLINE_MS`, `WATCHDOG_STALL_MS` (must exceed the RPC deadline),
`BACKOFF_MAX_MS`, `CONCURRENCY`, `DISCOVERY_CHUNK_BLOCKS`, `PRICE_MAX_AGE_S`,
`ORACLE_DEVIATION_BPS`, `HF_TOLERANCE_BPS`, `BAND_TOLERANCE_BPS`,
`TX_DEADLINE_S`, `LOG_LEVEL`. There is no health-factor, LTV (loan-to-value)
or width knob: the ladder comes from `packages/shared/src/health.ts`.

```bash
cd agent && npm run build && node dist/src/index.js      # or: npm run dev
```

The keeper address is `privateKeyToAccount(KEEPER_PRIVATE_KEY).address`, logged
at startup as `keeper`. The web needs it as `NEXT_PUBLIC_OILSKIN_KEEPER` to
offer the protection grant. Note the grant gap in `docs/RISKS.md`
("Keeper dependence"): the web grants only `StrategyRouter.unwind`, while the
keeper also plans `SnuggleLpVenue.closeMany` and refuses without that grant.

### Yield service (`services/yield/`)

`.env` at the repo root (git-ignored): `BASE_RPC_URL` (needed for Aave rates
and gauge reads; `/v1/rates` and `/v1/gate` answer 503 until the first
successful sample), `BLOCKSCOUT_PRO_API_KEY` (optional, speeds the backfill).

```bash
set -a; . ./.env; set +a
npm run yield                     # http://127.0.0.1:8787  (/healthz /v1/pools /v1/rates /v1/gate /v1/band)
npm run backfill -- sample        # live gauge words + Aave rates → samples/gauge-emissions-<date>.json
npm run model -w @zyo/yield       # re-run the LP model; regenerates samples/MODEL-NUMBERS.md
npm run backfill -- all           # engine history → empirical bands (resumable)
```

### Web (`web/`)

All configuration is public (`web/lib/env.ts`): `NEXT_PUBLIC_BASE_RPC_URL`
(default `https://mainnet.base.org`), `NEXT_PUBLIC_YIELD_URL` (default
`http://localhost:8787`), `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (WalletConnect
wallets only; Coinbase Wallet and injected wallets work without it),
`NEXT_PUBLIC_OILSKIN_FACTORY`, `NEXT_PUBLIC_OILSKIN_ROUTER` (registry, venues and
engine are read from the router — `readDeployment`), `NEXT_PUBLIC_OILSKIN_KEEPER`
(optional), `NEXT_PUBLIC_COW_APP_CODE`, `NEXT_PUBLIC_FORCE_DEMO=1` (e2e).

```bash
npm run web                       # http://localhost:3000 — demo mode until the factory/router are set
```

The web never holds a secret and never broadcasts itself: the wallet signs.

### Prototypes (`prototype/`)

Open `prototype/simple.html` or `prototype/index.html` directly, or use the
one-click scripts at the repo root: `bash start-demo.command` installs on first
run, builds shared + yield, starts the yield API on `127.0.0.1:8787`, serves
`prototype/` on `127.0.0.1:8788` and opens the simple build;
`bash stop-demo.command` stops both (PID files in `.demo/`, logs there too).
Be clear about what that gives you: the prototypes are pinned to the
2026-09-05 chain read (`docs/VERIFIED-BASE-FACTS.md`) and to
`docs/MODEL-NUMBERS-2026-09-05.md` and **do not read the yield API**
(`grep fetch prototype/simple.html` finds only the Simple ⇄ Advanced toggle
probe). The yield API the script starts is there for the web app and for
`curl`; the "LIVE chip" of the earlier demo no longer exists.

## Deploying (not done; here is what the script demands)

`contracts/script/Deploy.s.sol` refuses to run unless: chain id is 8453 with
`CONFIRM_BASE_MAINNET=true` (or `ALLOW_ANY_CHAIN=true` for a local chain);
`TREASURY`, `REGISTRY_OWNER` (a Safe) and `AERODROME_SWAP_ROUTER` are set —
the SwapRouter address is **not** in `docs/VERIFIED-BASE-FACTS.md` and must be
probed first; every dependency address holds code; and Aave's
`PoolAddressesProvider` still resolves to the verified pool / data provider /
oracle (`AaveProviderDrift` otherwise). It then registers cbBTC and WETH as
enabled, cbZEC as disabled with its note, and hands the registry to
`REGISTRY_OWNER` in two steps (`acceptOwnership` is a separate transaction).
Optional: `DEPLOY_PYTH_ADAPTER=true` deploys the v1.1 oracle adapter, unused.

## CI

`.github/workflows/ci.yml` runs the contracts suite and the agent + yield
suites on every push to `main` and on pull requests. It does **not** yet run
the shared, web, or prototype suites, does not run the fork suite (no
`BASE_RPC_URL` secret), and does not compile contracts before the agent job
(so the agent's `verify-abi` skips loudly there — set `VERIFY_ABI_STRICT=1`
once the ordering is fixed). Those are gaps, listed in `docs/TESTING.md`.
