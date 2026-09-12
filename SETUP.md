# Oilskin — setup

Base module v1 (2026-09-06, after the wave-1 audit fix round). What is in the
tree, how to build it, how to run it. Status and risks: `README.md`,
`docs/RISKS.md`; what the audit found and changed: `docs/AUDIT-2026-09-06.md`.
Nothing here is deployed; every "live" path below needs addresses that do not
exist yet.

Abbreviations: EVM = Ethereum Virtual Machine; ABI = application binary
interface; RPC = remote procedure call (a chain node endpoint); LP = liquidity
provision; LTV = loan-to-value; HF = health factor; CI = continuous integration.

## Toolchain

- Node ≥ 22 and npm (workspaces: `packages/shared`, `agent`, `services/yield`, `web`, `solana`).
- Rust, the Solana CLI (Agave 4.2.2) and Anchor 1.2.0 for `solana/` only — `solana/SETUP.md`; no existing
  suite needs them, and `npm test -w @zyo/solana` (the ladder seam) runs without them.
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
(**321** selectors / topics / errors across 17 contracts); `web/scripts/sync-abi.mjs`
generates `web/lib/abi/oilskin.generated.ts` from that bundle; the agent's
`scripts/verify-abi.mjs` checks its hand-written encoders against
`contracts/out` (**54** checks, including two structural ones — the keeper must
plan exactly one grant selector, and it must be `StrategyRouter.unwind` with
`allowCallback: true`; runs inside `npm test -w @zyo/agent`; set
`VERIFY_ABI_STRICT=1` in CI so a missing artifact is fatal instead of a loud skip).

The 2026-09-06 ABI is **not** compatible with anything encoded before it: `Call`
carries a `callback` flag, `exec` is a plain call with `execWithCallback` as the
opt-in, `Permission` carries `allowCallback`, `unwind` takes a `SwapQuote`, and
`openBorrowOnly` replaces the hand-built hold batch. `docs/CONTRACT-ABI.md` §0
is the short version; encode from the JSON, never from prose.

## Test everything

See `README.md` ("Run every suite") for the commands and `docs/TESTING.md`
for what each suite proves. Summary for this tree, all counted by running them
on 2026-09-12: contracts **380** pass / 11 fork tests skipped without `FORK_URL`
(**11 / 11** pass against Base at block 51,222,568, plus `scripts/check-cbzec-b20.sh`);
keeper **242** tests + ABI seam **110/110**; yield **131**; web **167** unit (165 + 2
skipped; the **12** Playwright scenarios were last run 2026-09-06); shared **75**;
Solana seam **4**; prototypes **118 + 109 + 56** checks + **6** fuzz; root ABI seam
**424**. CI runs every one of these on push (`docs/TESTING.md` "CI").

## Run

### Keeper (`agent/`)

Required env: `BASE_RPC_URL` (http/https), `ACCOUNT_FACTORY_ADDRESS`,
`DISCOVERY_FROM_BLOCK` (the factory's deployment block), `STORE_PATH`
(absolute path, no whitespace). Add `KEEPER_PRIVATE_KEY` and
`STRATEGY_ROUTER_ADDRESS` to act; without a key the keeper runs observe-only
(rungs recorded, every on-chain action `REFUSED`, never silent —
`agent/src/dispatch/observeOnly.ts`). Optional knobs (`agent/src/config.ts`,
every one strictly parsed, floors > 0): `CHAIN_ID` (8453; or 84532 for a Base Sepolia rehearsal, which also needs `CBZEC_ADDRESS` and `AERO_ADDRESS` — the deploy-time doubles `DeploySepolia` printed — and refuses any other chain, or a missing double, by name; slice 6, 2026-09-10), `HEALTH_POLL_MS`,
`RPC_DEADLINE_MS`, `WATCHDOG_STALL_MS` (must exceed the RPC deadline),
`BACKOFF_MAX_MS`, `CONCURRENCY`, `DISCOVERY_CHUNK_BLOCKS`, `PRICE_MAX_AGE_S`,
`ORACLE_DEVIATION_BPS`, `HF_TOLERANCE_BPS`, `BAND_TOLERANCE_BPS`,
`TX_DEADLINE_S`, `LOG_LEVEL`. There is no health-factor, LTV (loan-to-value)
or width knob: the ladder comes from `packages/shared/src/health.ts`.

**New since the fix round** (all validated, all defaulted): `PRICE_MAX_AGE_S` is
now only the fallback for a feed whose cadence cannot be measured — the keeper
walks each Chainlink feed's own `getRoundData` history and enforces a per-feed
bound. `PRICE_MAX_AGE_S_<SYMBOL>` overrides one feed deliberately;
`FEED_HEARTBEAT_SLACK` (2), `FEED_HEARTBEAT_ROUNDS` (6), `FEED_MIN_MAX_AGE_S`
(300) shape the measurement; **`FEED_SELFCHECK` (`fatal` by default) makes a
staleness policy that would leave every account UNKNOWN a startup failure
rather than a silent no-op** — set it to `warn` only deliberately. Also:
`SWAP_MAX_SLIPPAGE_BPS` (100, hard-capped at the adapter's 500),
`BAND_MAX_TOLERANCE_BPS` (500), `MAX_VALUE_PROBES` (24), `GRANT_EXPIRY_WARN_S`
(7 d), `DISPATCH_DEADLINE_MS` (60 s, ≥ `RPC_DEADLINE_MS`), `MAX_RESUME_PER_TICK`
(25), `MAX_RECORD_STALLS` (3), `MAX_RUNG_REFIRES` (2), `CLOCK_DRIFT_MAX_S`
(120), `NOTIFY_WEBHOOK_URL` / `NOTIFY_WEBHOOK_TOKEN` / `NOTIFY_DEADLINE_MS`
(10 s), `STORE_KEEP_TERMINAL_PER_ACCOUNT` (50), `STORE_LOCK_STALE_MS` (5 min).
The store format is **v3**; a v2 store is migrated in place on load.

Without `NOTIFY_WEBHOOK_URL` the keeper's only channel is its own log. Every
rung and escalation is still produced — but nothing reaches a user
(`docs/RISKS.md` §10).

```bash
cd agent && npm run build && node dist/src/index.js      # or: npm run dev
```

The keeper address is `privateKeyToAccount(KEEPER_PRIVATE_KEY).address`, logged
at startup as `keeper`. The web needs it as `NEXT_PUBLIC_OILSKIN_KEEPER` to
offer the protection grant. The web/keeper grant seam that used to leave LP
positions unprotected is closed: the keeper now plans **one** root
`StrategyRouter.unwind` per pool, which is exactly the single `Permission` the
web asks users to sign, and `agent/scripts/verify-abi.mjs` fails the build if
that ever stops being true. The grant must carry `allowCallback: true` — without
it every dispatch reverts `NotActivePeripheral` inside the router while the UI
shows the protection as live (`docs/FLOWS.md` §5).

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

All configuration is public (`web/lib/env.ts`): `NEXT_PUBLIC_CHAIN_ID` (8453, or 84532 for a
Base Sepolia rehearsal — then `NEXT_PUBLIC_CBZEC_ADDRESS` and `NEXT_PUBLIC_AERO_ADDRESS` must name
the deploy-time doubles, and the build fails at load, by name, for any other chain or a missing
double; `web/lib/chain.ts`, slice 6), `NEXT_PUBLIC_BASE_RPC_URL` (default: the chain's public
endpoint), `NEXT_PUBLIC_YIELD_URL` (default
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
`TREASURY`, `REGISTRY_OWNER` and `AERODROME_SWAP_ROUTER` are set — the
SwapRouter is now code-verified as
`0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5` in the 2026-09-06 addendum to
`docs/VERIFIED-BASE-FACTS.md`, and the circulating "UniversalRouter"
`0x6Cb442acF35158D5eDa88fe602Ef9Cf89694fFEa` has **no code on Base**; every
dependency address holds code; and Aave's `PoolAddressesProvider` still resolves
to the verified pool / data provider / oracle (`AaveProviderDrift` otherwise).

Deploy order is **registry → venue → assets**: `AaveV3Venue` now takes the
registry at construction so it can enforce the offer and the entry
health-factor floor itself. `REGISTRY_TIMELOCK_DELAY` (default 172800 = 2 days,
bounded [1 h, 30 d]) is the **immutable** delay on replacing the venue an asset
points at; it is the only owner power that waits. The script then registers
cbBTC and WETH as enabled, cbZEC as disabled with its note, and hands the
registry to `REGISTRY_OWNER` in two steps (`acceptOwnership` is a separate
transaction). **Make `REGISTRY_OWNER` a multisig**: nothing on chain requires
it, and the powers that owner keeps are set out in `docs/RISKS.md` §16.
Optional: `DEPLOY_PYTH_ADAPTER=true` deploys the v1.1 oracle adapter, unused.

### Base Sepolia (chain id 84532) — prepared, not deployed

`contracts/script/DeploySepolia.s.sol` is the testnet path, and
**`docs/DEPLOY-SEPOLIA.md` is the runbook**: the exact dry-run and `--broadcast`
commands, and a post-deploy `cast` checklist. It exists because Aerodrome
Slipstream and the MaxFi/Snuggle engine have **no code on Base Sepolia**, so
the LP venue and the swap adapter are pointed at stand-ins behind the same
interfaces (`MockSnuggleVault`, `MockCLPool`, `MockAerodromeSwapRouter`,
`MockB20` for cbZEC, Aave's real test WBTC in place of cbBTC). Aave v3,
Permit2, Chainlink, Pyth and Morpho Blue are the real thing there. The Oilskin
contracts are still deployed by the unchanged `Deploy.deploy()`, so the audited
order is what runs. Every address and the mint caps on Aave's open faucet are
in `docs/VERIFIED-BASE-FACTS.md`, "Addendum 2" (read 2026-09-07). A dry run
against the live chain cleared the guard on 2026-09-07 and estimated
19,505,395 gas (≈ 0.000215 ETH); nothing has been broadcast.

## CI

`.github/workflows/ci.yml` runs the contracts suite and the agent + yield
suites on every push to `main` and on pull requests. It does **not** yet run
the shared, web, or prototype suites, does not run the fork suite (no
`BASE_RPC_URL` secret), and does not compile contracts before the agent job
(so the agent's `verify-abi` skips loudly there — set `VERIFY_ABI_STRICT=1`
once the ordering is fixed). Those are gaps, listed in `docs/TESTING.md`.
