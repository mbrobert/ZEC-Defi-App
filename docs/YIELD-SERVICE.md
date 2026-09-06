# The yield service — live Base rates, gauge emissions, the gate, and empirical bands

`services/yield` is the backend behind the app's yield numbers (Base-first
v1, 2026-09-05). Four jobs, every one stamped with a sample timestamp and
every one refusing to invent data:

1. **Live rates — Aave v3 on Base** (`src/sources/aave.ts`). The USDC
   variable borrow APR (the strategy's funding cost) and, per enabled
   collateral (cbBTC, WETH), the supply APR and the liquidation threshold /
   LTV / flags, read from the `PoolDataProvider`
   (`getReserveData`, `getReserveConfigurationData`). Addresses come only
   from `@zyo/shared` (`docs/VERIFIED-BASE-FACTS.md`). Decoding is STRICT:
   exact word counts, plausibility bounds, boolean words ∈ {0,1}; anything
   else throws and nothing is read as zero. A half-readable sample is
   refused entirely.
2. **Gauge emissions — Aerodrome Slipstream** (`src/sources/gauges.ts`).
   Per Aerodrome pool, including the tracked cbZEC/USDC pool: the gauge via
   `Voter.gauges(pool)` (cross-checked against the registry's recorded
   gauge where there is one), `rewardRate()`, `periodFinish()`, the pool's
   `slot0()`, `stakedLiquidity()`, `fee()`. Converted to the marginal
   in-range APR at every shared range preset (`APR(bps)`, see the model).
   `epochActive` requires `rewardRate > 0 AND periodFinish > now`; a
   never-voted gauge (cbZEC/USDC today) is `epochActive:false, emissions:0`.
   A `stakedLiquidity` reading more than 5× away from the pool's FIRST
   reading is flagged `outlier` and kept out of the rolling average.
3. **The gate** (`src/gate.ts`, `src/model.ts`).
   `qualifies(pool, setting, collateral)` ⇔ `lpNet > aaveUsdcBorrowApr`
   with every input live and fresh; every missing/stale/inactive/outlier/
   uncalibrated input is a specific refusal reason. Exposed on `/v1/pools`
   (per pool, every setting × collateral) and `/v1/gate` (503 when the rates
   are absent or stale — fail closed).
4. **Empirical bands** — the flagship: instead of quoting one modeled APY,
   backtest the engine's OWN on-chain position history and serve the
   distribution of what real positions actually kept (methodology
   `closed-position-flows-v2`, below). Where these exist they replace the
   model everywhere in the UI.

Zero runtime dependencies (the keeper in `agent/` uses viem; this service does not), plain `node:http`, TypeScript,
105-test offline suite on recorded on-chain fixtures (RPC mocked at the
JSON-RPC boundary with real chain words).

## The model (`src/model.ts` — one place; the Python sim and the web pin to it)

- **Width.** `rangeWidthBps` is the TOTAL tick span (shared `RANGE_PRESETS`:
  4500/1500/300 uncorrelated, 2356/784/150 correlated; delays 48/12/2 h).
  The exact price half-width is `w = 1.0001^(bps/2) − 1` (4500 → ±25.23 %),
  never `bps/200`.
- **Concentration.** `f(w) = 2 − √(1−w) − 1/√(1+w)`; a position of
  liquidity L is worth `L·√P·f(w)` in token1.
- **Emissions.** `APR(w) = rewardRate·yr·AERO$ ÷ (stakedLiquidity·√P·f(w)/10^dec1·token1$)` —
  the marginal rate for new staked in-range liquidity at width w.
- **Fees.** Emissions are gross. Engine-routed pools keep
  `(1 − engine 15 %)(1 − FEES.performanceBps)` = 0.765; DIRECT pools keep
  `1 − FEES.performanceBps`. Nothing on principal, ever.
- **Drag + combining.** `x = σ²/(4·f(w))`; `drag = −100(1−e^{−x})`;
  emissions accrue on the drag-shrunk base, so
  `realized = r(1−e^{−x})/x` and **`lpNet = (1−e^{−x})(r/x − 1)`**. The
  Monte Carlo (`scripts/lp-sim.py`, hourly zero-drift GBM with re-centering
  after the preset's delay) matches this to ~0.1 pt at Conservative/Moderate
  and within ~5 pt at Aggressive (time out of range). Note `r/x` is
  width-independent: a pool that loses at one width loses at every width.
- **User net** on the whole collateral position:
  `supply(collateral) + LTV × (lpNet − borrow)` at the shared LTV presets
  (30 %, 40 %, top = min(50 %, floor(LT/1.55)) from the LIVE LT).
- **σ inputs** live in `samples/volatility.json` with provenance per pool;
  a pool absent from it is refused with `no_volatility_input` — never a
  default. `breakEvenSigma` and `breakEvenEmissionsMultiple` are reported
  for every failing cell.

`npm run model` regenerates `samples/lp-model-<date>.json` and
`samples/MODEL-NUMBERS.md` from the recorded inputs; `test/model-pin.test.ts`
replays the same raw words through the TypeScript source + gate and fails
if any served cell drifts from the generated numbers by > 0.01 pt, or if
`samples/model-inputs.json` drifts from what `@zyo/shared` exports.
**Verdict at the 2026-09-05 borrow (4.828 %): nothing clears** — see
`samples/MODEL-NUMBERS.md`.

## Staleness contract (audit Lens F / round 3)

Every sample stores `sampledAt` only. `stale` is DERIVED at serve time from
the sample's age against `YIELD_STALE_AFTER_MS` (default 10 min) — for the
rates, for each pool's emissions, and for the payload — so a source that
dies keeps flipping the flag as time passes; no code path stores it.
`epochActive` is likewise re-derived from `periodFinish` at serve time. The
gate refuses stale inputs; `/v1/gate` and `/v1/band` return 503 on absent or
stale rates; `/v1/rates` is 503 until the first successful sample and
`stale:true` afterwards whenever the sample is old.

## Methodology: `closed-position-flows-v2` (empirical bands)

A "position" is one economic position in the MaxFi/Snuggle engine, followed
through its full life:

- **Open** = `PositionCreated(tokenId, owner, poolId, …)`.
- **Rebalances RE-KEY the position** — `SnuggleRebalanced(oldId, newId, …)`
  mints a fresh id each time (verified live 2026-08-27 and 2026-09-03). The
  folder aliases every successor id back to the root.
- **Entry principal** = ERC-20 inflows on the owner→vault edge of the
  deposit tx MINUS the attributed same-tx vault→owner refunds. Inflows and
  refunds are stored SEPARATELY; a refund in the *other* pool token of a
  single-sided deposit counts (it used to be dropped — 32 pt understatement).
  Attribution: a refund counts only in a pool token or a deposited token; an
  unrelated vault→owner leg is ignored and counted. A deposit tx that
  created MORE THAN ONE position is refused (`ambiguous_entry`), never split
  by guesswork.
- **Exit flows** = `PositionWithdrawn` + `FeesHarvested` +
  `StakingRewardsClaimed`, attributed via the engine's `approvedPools`.
- **Strict event decoding**: a log whose topic0 is indexed but whose
  topic/data shape is wrong is a `MalformedLogError` — counted in the
  indexer state, never decoded to zeros.
- **Fees**: measured flows are ALREADY net of the engine's performance fee;
  bands apply only Oilskin's (`FEES.performanceBps`).
- **USD valuation**: day-close prices per token (stables pinned at $1;
  others via reference-pool OHLCV with runtime side-detection). A flow that
  can't be priced marks the position `unpriced`.
- **Cohorts**: positions whose close falls in the trailing 30/60/90 days.
  Exclusions counted per reason: `unpriced`, `ambiguous_entry`,
  `short_position` (< 1 day), `dust_principal` (< $1), and the **absolute
  outcome bound** `absurd_outcome` (|netApr| > 2000 %/yr — an attribution
  defect, not a return; asserted again on the produced band). Percentiles
  p10/25/50/75/90 are principal-weighted; the unweighted median ships
  alongside.

**Stated limitations:** open positions are not marked to market; exit flows
are valued at the close day; the equal-split mix band averages percentile
points across pools before the fee/LTV transform (`percentile-mean-v1`).
Each is labeled in the API, not hidden.

## Event map provenance (dual-verified 2026-08-27)

Topic constants in `src/engine/events.ts` come from the engine
implementation's VERIFIED source ABI (SnuggleVaultUpgradeable at
`0x359f90ee4c2e21cbf6e32c5a062eeef306822d28` behind proxy
`0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55`), hashed with a test-verified
keccak (now `packages/shared/src/keccak.ts`; the comment in `src/abi.ts` still names the
deleted `agent/src/vendor/keccak.ts`) and matched 1:1 against a live 2,000-block log sweep. Every function
selector the service uses (Aave, Voter, gauge, pool) is re-derived from its
signature in the test suite. After any engine upgrade run
`npm run backfill -- verify-events`.

## Running it

```bash
# .env (repo root, gitignored):
#   BASE_RPC_URL=…            # any Base RPC url — needed for Aave rates + gauges
#   BLOCKSCOUT_PRO_API_KEY=…  # optional; enables decoded-transfer receipts + verify-events

set -a; . ./.env; set +a

npm run backfill -- sample     # live gauge words + Aave rates → samples/gauge-emissions-<date>.json
npm run model                  # re-run the sim + regenerate MODEL-NUMBERS.md (edit the borrow/supply/LT args to the live values)
npm run backfill -- all        # scan → timestamps → receipts → cohorts (resumable)
npm run yield                  # serve http://127.0.0.1:8787
```

Endpoints: `/healthz`, `/v1/pools`, `/v1/rates`, `/v1/gate[?pool=&setting=&collateral=]`,
`/v1/band?ltv=0.40&mix=aweth,acbbtc&collateral=cbBTC`. Demo ids are accepted
(`aweth acbbtc wbtc link lst stab aero abtc zec`).

## Security & key handling

The Blockscout key is read from the environment at runtime, sent only as a
`Bearer` header to `api.blockscout.com`, and never logged. RPC URLs may
embed provider keys — they are never printed either. Upstream error text
never reaches a response (fixed reason enums). Keep `.env` gitignored.
