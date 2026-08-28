# The yield service — live rates + empirical realized-return bands

`services/yield` is the backend behind the app's yield numbers. It does two
jobs, both stamped with sample timestamps and both refusing to invent data:

1. **Live sampling** — current pool fee APRs (volume × feeTier ÷ TVL × 365,
   GeckoTerminal), live Rhea borrow + supply rates (bare NEAR JSON-RPC view
   calls on the Burrow contract), refreshed continuously.
   ⚠️ **Aerodrome Slipstream fees are DYNAMIC** (pool.fee(), selector
   `0xddca3f43`, moves with volatility — verified on-chain 2026-08-27:
   WETH/USDC read 0.056%, AERO/WETH 0.30% where the old label said 1%).
   The curated list's `feeTierBps` now carries each Aerodrome pool's
   sampled fee() and must be refreshed on re-sampling; the honest upgrade
   is reading fee() live per sample — tracked as a TODO in
   `src/sources/gecko.ts`. Uniswap tiers are static.
2. **Empirical bands** — the flagship: instead of quoting one modeled APY,
   backtest the engine's OWN on-chain position history and serve the
   distribution of what real positions actually kept. Matt's call
   2026-08-27: empirical over analytical-LVR.

Zero runtime dependencies (mirrors `agent/`), plain `node:http`, TypeScript,
41-test offline suite on recorded on-chain fixtures.

## Methodology: `closed-position-flows-v1`

A "position" is one economic position in the MaxFi/Snuggle engine, followed
through its full life:

- **Open** = `PositionCreated(tokenId, owner, poolId, …)`.
- **Rebalances RE-KEY the position** — `SnuggleRebalanced(oldId, newId, …)`
  mints a fresh id each time (verified live: `positions(oldId)` empties
  after the event and later events reference the new id). The folder
  aliases every successor id back to the root, so one position stays one
  lifecycle. Miss this and every rebalanced position looks like it never
  closed — the single biggest correctness trap in this pipeline.
- **Entry principal** = ERC-20 amounts on the owner→vault edge of the
  deposit tx minus same-tx vault→owner refunds (internal vault↔adapter dust
  legs excluded — verified against a live deposit receipt).
- **Exit flows** = `PositionWithdrawn` amounts + `FeesHarvested` +
  `StakingRewardsClaimed` (AERO emissions), attributed to token0/token1 via
  the engine's own `approvedPools` registry.
- **Fees**: measured flows are ALREADY net of the engine's 15% performance
  fee (`PerformanceFeeCollected` fires before owner payouts), so bands
  apply only Oilskin's 10%: `user = supply + LTV × (engineNet × 0.90 −
  borrow)`. The demo's static path multiplies GROSS samples by 0.765
  (= 0.85 × 0.90) — same economics, pinned by a test.
- **USD valuation**: day-close prices per token (stables pinned at $1;
  others via reference-pool OHLCV with runtime side-detection). A flow that
  can't be priced marks the position excluded — counted in the payload,
  never guessed.
- **Cohorts**: positions whose close falls in the trailing 30/60/90 days.
  Per position: `netApr = (outUsd − principalUsd)/principalUsd × 365/days`.
  Percentiles p10/25/50/75/90 are principal-weighted (a $200k position
  moves the band more than a $50 one); the unweighted median ships
  alongside. Exclusions (unpriced, open <1 day, principal <$1) are counted
  in `excluded`.

**Stated limitations (v1):** open positions are not marked to market (the
cohort is closed positions only — the payload says so); exit flows are
valued at the close day (harvests cluster near close for short-lived
positions); the equal-split mix band averages percentile points across
pools before the fee/LTV transform (`percentile-mean-v1` — true mix
percentiles need joint distributions). Each is labeled in the API, not
hidden.

## Event map provenance (dual-verified 2026-08-27)

Topic constants in `src/engine/events.ts` come from the engine
implementation's VERIFIED source ABI (SnuggleVaultUpgradeable at
`0x359f90ee4c2e21cbf6e32c5a062eeef306822d28` behind proxy
`0x7d27cdfbfcc878f7e7349e216d44204bfd2afd55`, base.blockscout.com,
33 events), hashed with the test-verified vendored keccak, then matched 1:1
against a live 2,000-block log sweep (OutOfRangeStatusUpdated ×631,
SnuggleRebalanced ×48, PerformanceFeeCollected ×44, FeesHarvested ×31,
PositionCreated ×27, StakingRewardsClaimed ×18, PositionWithdrawn ×12).
After any engine upgrade run `npm run backfill -- verify-events` — it
resolves the EIP-1967 implementation slot, pulls the verified ABI through
Blockscout, and diffs the event set against our constants.

Other live verifications the code pins against (same date): Burrow
`get_asset` returns `borrow_apr`/`supply_apr` as decimal-fraction strings
(USDC borrow 13.56%, supply 8.70%; ZEC `zec.omft.near` supply 0.04%);
GeckoTerminal OHLCV rows are `[ts,o,h,l,c,vol]` with USD closes and
`meta.base` naming the priced token; the engine registry stores the Aero
WETH/USDC pool with fee word `100` (units differ per DEX — the raw word is
kept as `engineFeeRaw` and NEVER used as bps; display math uses the curated
list's fee tiers).

## Running it

```bash
# .env (repo root, gitignored) — the service reads the same file the agent uses:
#   BASE_RPC_URL=…            # any Base RPC url (1rpc/Alchemy/…)
#   BLOCKSCOUT_PRO_API_KEY=…  # optional; enables decoded-transfer receipts,
#                             # verify-events, and the PRO json-rpc gateway
#   NEAR_RPC_URL=…            # defaults to rpc.mainnet.near.org

set -a; . ./.env; set +a       # or: node --env-file=.env …

npm run backfill -- all        # scan → timestamps → receipts → cohorts
                               # (resumable at every step; state in services/yield/data/)
npm run yield                  # serve http://127.0.0.1:8787
```

Endpoints: `/healthz`, `/v1/pools` (live samples + bands + rates, `stale`
flag, per-item `sampledAt`), `/v1/rates`, `/v1/band?ltv=0.40&mix=aweth,acbbtc`
(demo pool ids accepted). Failing sources serve the last good sample flagged
`stale:true` rather than 500ing. Bands are `null` with
`bandsUnavailableReason:"backfill_pending"` until a backfill has produced
`data/bands.json` — the frontend renders "pending backfill", never an
invented range.

**Demo wiring**: `prototype/simple.html` probes `http://127.0.0.1:8787` at
boot. Service up → LIVE chip, live rates through the same `apyModel`,
banded headline (p25–p75 + typical), per-card band bars, live sample times.
Service down → the static dated sample stands (one tolerated
`ERR_CONNECTION_REFUSED` console line is that probe). The hosted demo
(https) never probes — browsers block localhost from https pages.

## Security & key handling

The Blockscout key is read from the environment at runtime, sent only as a
`Bearer` header to `api.blockscout.com`, and never logged. 401/403 stops
immediately with a key message; 402 (credits) stops cleanly;
`x-credits-remaining` is tracked and printed after receipt batches. RPC
URLs may embed provider keys — they are never printed either. Keep `.env`
gitignored (it is), and rotate any key that has ever appeared in a chat,
log, or screenshot.
