/**
 * The recorded inputs both demo generators evaluate on — ONE rebuild of the emissions sample and
 * the Aave rates from the committed files, so gen-demo-gate.mjs and gen-demo-forecast.mjs can
 * never disagree about what the recorded words were (2026-09-12, BUILD-PLAN A3).
 */
import { readFileSync } from "node:fs";
import { BASE_TOKENS } from "@zyo/shared";
import { MIN_GATE_STAKED_SAMPLES } from "../dist/src/gate.js";
import { emissionsAprPct, modelWidthsBps, priceHalfWidth, round2 } from "../dist/src/model.js";

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The Aave sample the gate reads, rebuilt from the model's recorded live figures (the gate generator's shape). */
export function ratesFromModel(model, asOfIso) {
  const borrowAprPct = model.inputs?.borrowAprPct;
  if (typeof borrowAprPct !== "number") throw new Error("lp-model inputs.borrowAprPct missing");
  const reserve = (symbol, over) => ({
    symbol,
    address: BASE_TOKENS[symbol]?.address?.toLowerCase() ?? "0x",
    supplyAprPct: 0,
    variableBorrowAprPct: 0,
    ltvBps: 0,
    liquidationThresholdBps: 0,
    liquidationBonusBps: 0,
    usageAsCollateralEnabled: true,
    borrowingEnabled: true,
    isActive: true,
    isFrozen: false,
    isPaused: false,
    ...over,
  });
  return {
    source: "aave-v3-base",
    dataProvider: model.inputs?.dataProvider ?? "0x",
    borrow: reserve("USDC", { variableBorrowAprPct: borrowAprPct }),
    collateral: Object.fromEntries(
      Object.entries(model.inputs?.collateral ?? {}).map(([symbol, c]) => [
        symbol,
        reserve(symbol, { supplyAprPct: c.supplyAprPct, liquidationThresholdBps: c.liquidationThresholdBps }),
      ])
    ),
    sampledAt: model.inputs?.ratesSampledAt ?? asOfIso,
    stale: false,
  };
}

/**
 * The emissions sample the gate reads, rebuilt from the raw chain words with the SAME formula
 * `sources/gauges.ts` uses (`emissionsAprPct` per width) — never the sample's own precomputed
 * `aprByWidthPct` table, whose keys are half-widths rather than the bps the gate looks up.
 *
 * `corroborated`/`samples`: the recorded words are one verified block read, so there is no rolling
 * history to corroborate against. Demo mode is a recording of a warm service, so the sample is
 * marked corroborated and the provenance string says exactly what that means. A LIVE service still
 * has to earn it.
 */
export function emissionsFromSample(sample, pool, nowSeconds) {
  const s = sample.pools?.[pool.id];
  if (!s) return null;
  const rewardRate = BigInt(s.rewardRateWeiPerSec);
  const sqrtPriceX96 = BigInt(s.sqrtPriceX96);
  const periodFinish = Number(s.periodFinish ?? 0);
  const epochActive = rewardRate > 0n && periodFinish > nowSeconds;
  const staked = Number(s.stakedLiquidity ?? 0);
  let aprByWidthPct = {};
  if (epochActive && staked > 0) {
    for (const bps of modelWidthsBps()) {
      const apr = emissionsAprPct({
        rewardRateWeiPerSec: rewardRate,
        aeroUsd: sample.aeroUsd,
        stakedLiquidity: staked,
        sqrtPriceX96,
        token1Decimals: s.dec1,
        token1Usd: s.token1Usd,
        halfWidth: priceHalfWidth(bps),
      });
      if (apr === null) {
        aprByWidthPct = null;
        break;
      }
      aprByWidthPct[String(bps)] = round2(apr);
    }
  } else if (!epochActive) {
    for (const bps of modelWidthsBps()) aprByWidthPct[String(bps)] = 0;
  } else {
    aprByWidthPct = null;
  }
  return {
    poolId: pool.id,
    pool: s.pool,
    gauge: s.gauge,
    rewardRateWeiPerSec: s.rewardRateWeiPerSec,
    periodFinish,
    epochActive,
    wholePoolAprPct: aprByWidthPct === null ? null : round2(s.wholePoolAprPct ?? 0),
    aprByWidthPct,
    stakedLiquidity: String(s.stakedLiquidity ?? "0"),
    samples: MIN_GATE_STAKED_SAMPLES,
    corroborated: true,
    outlier: false,
    sqrtPriceX96: s.sqrtPriceX96,
    feePips: Math.round(s.feeBpsLive * 100),
    aeroUsd: sample.aeroUsd,
    sampledAt: sample.sampledAt,
    stale: false,
  };
}

export const STAKED_LIQUIDITY_PROVENANCE =
  "one verified block read; marked corroborated because demo mode records a warm service. " +
  "A live sample must earn corroboration from MIN_STAKED_SAMPLES independent readings.";

export const relSample = (p) => p.replace(/^.*\/(services\/yield\/samples\/[^/]+)$/, "$1");
