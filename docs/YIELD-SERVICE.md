# The yield service — live Base rates, gauge emissions, the gate, and empirical bands

`services/yield` is the backend behind the app's yield numbers (Base module
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
   never-voted gauge (cbZEC/USDC until 2026-09-10) or a lapsed one (AERO/WETH
   since 2026-05-28) is `epochActive:false, emissions:0`.
   A `stakedLiquidity` reading more than 5× away from the pool's FIRST
   reading is flagged `outlier` and kept out of the rolling average.
3. **The gate** (`src/gate.ts`, `src/model.ts`).
   `qualifies(pool, setting, collateral)` ⇔ `lpNet > aaveUsdcBorrowApr`
   with every input live and fresh; every missing/stale/inactive/outlier/
   uncalibrated input is a specific refusal reason. Exposed on `/v1/pools`
   (per pool, every setting × collateral) and `/v1/gate` (503 when the rates
   are absent or stale — fail closed).
   **Since 2026-09-12 (BUILD-PLAN D4) the gate is information.** The same
   model is served as a forecast on `/v1/forecast` (`src/forecast.ts`): every
   cell is priced whenever emissions and σ exist — including the cells the
   gate refuses before pricing — and the borrow comparison is reported as
   `clearsBorrow`, never enforced; the only refusals are the safety list
   (`ForecastRefusal`: floor, unfundable borrow, stale rates, paused or
   inactive reserve, disabled asset, the venue's LTV). The borrow rate after
   the user's own borrow comes from the strategy's curve, read live with the
   rates (`sources/aave.ts`, `AaveBorrowCurve`). `samples/demo-forecast.json`
   is `evaluateForecast()`'s own output on the recorded inputs
   (`scripts/gen-demo-forecast.mjs`, pinned by `test/demo-forecast.test.ts`).
4. **Empirical bands** — the flagship: instead of quoting one modeled APY,
   backtest the engine's OWN on-chain position history and serve the
   distribution of what real positions actually kept (methodology
   `closed-position-flows-v2`, below). Where these exist they replace the
   model everywhere in the UI.

Zero runtime dependencies (the keeper in `agent/` uses viem; this service does not), plain `node:http`, TypeScript,
146-test offline suite on recorded on-chain fixtures (RPC mocked at the
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
  `realized = r(1−e^{−x})/x` and **`lpNet = (1−e^{−x})(r/x − 1)`**. Note
  `r/x` is width-independent: a pool that loses at one width loses at every
  width.
- **The boundary guard** (audit wave 1, lens D HIGH-1). The closed form above
  is correct algebra for a position that is ALWAYS in range: it ignores time
  out of range and the swap cost of every re-centre, so it is optimistic, and
  the error grows with the emissions level. That makes it smallest in today's
  deeply-negative cells (−1.1 … +5.5 pt on the 2026-09-12 words — the +5.46 pt
  at `aero-weth-cbbtc/working` is outside the sim's own tolerance and is
  recorded as a named breach, `RISKS.md` §14) and LARGEST at the boundary
  where the gate flips — +8.85 pt at `aero-cbbtc-usdc/working` and
  **+31.96 pt** at `aero-weth-cbbtc/working`, both wider than the 4.5174 %
  borrow rate being tested (2026-09-05: +7.45 / +32.02 at 4.828 %). The gate therefore
  also prices every cell with a Monte-Carlo-calibrated form,
  **`mcLpNet = net × inRangeEmissionsFactor + mcDragPct`**, and offers only
  when BOTH clear the borrow; in between it refuses with
  `within_model_uncertainty`. The two coefficients come from
  `samples/mc-calibration.json` (regenerated by `npm run model`) and are exact
  rather than fitted — MC lpNet is affine in the emissions rate because
  neither the in-range indicator nor the position's mint value depends on it,
  so one run per pool × setting prices the cell at every emissions level. A
  cell with no calibration, or one calibrated at a calmer σ or a narrower
  width than the live inputs, is refused (`mc_calibration_unavailable` /
  `mc_calibration_stale`) — there is no fallback to the closed form alone.
  `lpNetPct` stays the published headline; `mcLpNetPct` is served beside it.
- **User net** on the whole collateral position:
  `supply(collateral) + LTV × (lpNet − borrow)` at the shared LTV presets
  (30 %, 40 %, top = min(50 %, floor(LT/1.55)) from the LIVE LT).
- **σ inputs** live in `samples/volatility.json` with provenance per pool;
  a pool absent from it is refused with `no_volatility_input` — never a
  default. `breakEvenSigma` and `breakEvenEmissionsMultiple` are reported on
  every cell the gate actually prices — a cell refused BEFORE the model runs
  (no emissions, an uncorroborated staked anchor, an implausible APR, net
  emissions below the borrow, no σ) carries `null` in every model field and an
  empty `userNet`, because there is no number to report.

`npm run model` regenerates `samples/lp-model-<date>.json`,
`samples/MODEL-NUMBERS.md` and `samples/mc-calibration.json` from the recorded
inputs at an explicit `--as-of` (from which `epochActive` is DERIVED, exactly
as `gate.ts` derives it — the sample's recorded boolean is never trusted, and a
run whose `--as-of` falls outside a recorded-active epoch is a hard failure).
`npm run demo-gate` then produces `samples/demo-gate.json` by calling
`evaluateGate` itself, and mirrors it to `web/lib/demo-gate.json`, so demo mode
is a recording of the gate rather than a second implementation of it; `test/model-pin.test.ts`
replays the same raw words through the TypeScript source + gate and fails
if any served cell drifts from the generated numbers by > 0.01 pt, or if
`samples/model-inputs.json` drifts from what `@zyo/shared` exports.
**Verdict at the 2026-09-12 live borrow (4.5174 %): nothing clears, at any
borrow rate** — see `samples/MODEL-NUMBERS.md` and `docs/RISKS.md` §14.
`npm run model` takes every input from the sample file named in
`package.json` (`scripts/run-model.mjs`: as-of, borrow, supply, LT); nothing
is typed.

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
npm run model                  # re-run the sim + regenerate MODEL-NUMBERS.md from the sample package.json names (as-of, borrow, supply, LT are READ from that file by scripts/run-model.mjs — nothing typed)
npm run backfill -- all        # scan → timestamps → receipts → cohorts (resumable)
npm run yield                  # serve http://127.0.0.1:8787
```

Endpoints: `/healthz`, `/v1/pools`, `/v1/rates`, `/v1/gate[?pool=&setting=&collateral=]`,
`/v1/band?ltv=0.40&mix=aweth,acbbtc&collateral=cbBTC`, and since 2026-09-12
`/v1/forecast[?collateral=&entryHf=&deposit=&pool=&setting=]` — the forecast
(`src/forecast.ts`): every pool × setting at the chosen entry health factor, both
LP-net forms and their gap, the break-evens, the liquidation drawdown, the borrow
rate after this borrow on Aave's live curve, user net, the safety refusals and the
disclosure ids; never 503, a malformed query is a 400. Demo ids are accepted
(`aweth acbbtc wbtc link lst stab aero abtc zec`).

## Security & key handling

The Blockscout key is read from the environment at runtime, sent only as a
`Bearer` header to `api.blockscout.com`, and never logged. RPC URLs may
embed provider keys — they are never printed either. Upstream error text
never reaches a response (fixed reason enums). Keep `.env` gitignored.
