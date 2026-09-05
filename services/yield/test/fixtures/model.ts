/**
 * Model-side fixtures: an Aave rates sample carrying the VERIFIED 2026-09-05
 * facts, emissions samples in the service's own shape, and the recorded
 * volatility inputs. Nothing here is a number the code could not have read.
 */

import { readFileSync } from "node:fs";
import { AAVE_V3, BASE_TOKENS } from "@zyo/shared";
import type { VolatilityInputs } from "../../src/config.js";
import type { AaveRatesSample, AaveReserve, Address, EmissionsSample } from "../../src/types.js";

export const NOW_MS = Date.UTC(2026, 8, 5, 1, 0, 0);
export const NOW_S = Math.floor(NOW_MS / 1000);

export function reserve(symbol: string, over: Partial<AaveReserve> = {}): AaveReserve {
  const table: Record<string, Partial<AaveReserve>> = {
    USDC: { address: BASE_TOKENS.USDC.address.toLowerCase() as Address, supplyAprPct: 3.921, variableBorrowAprPct: 4.828, ltvBps: 7500, liquidationThresholdBps: 7800, liquidationBonusBps: 500 },
    cbBTC: { address: BASE_TOKENS.cbBTC.address.toLowerCase() as Address, supplyAprPct: 0.012, variableBorrowAprPct: 0.673, ltvBps: 7300, liquidationThresholdBps: 7800, liquidationBonusBps: 750 },
    WETH: { address: BASE_TOKENS.WETH.address.toLowerCase() as Address, supplyAprPct: 1.843, variableBorrowAprPct: 2.454, ltvBps: 8000, liquidationThresholdBps: 8300, liquidationBonusBps: 500 },
  };
  const base = table[symbol] as Omit<AaveReserve, "symbol" | "usageAsCollateralEnabled" | "borrowingEnabled" | "isActive" | "isFrozen">;
  return {
    ...base,
    symbol,
    usageAsCollateralEnabled: true,
    borrowingEnabled: true,
    isActive: true,
    isFrozen: false,
    ...over,
  };
}

export function ratesFixture(over: Partial<AaveRatesSample> = {}, sampledAtMs = NOW_MS): AaveRatesSample {
  return {
    source: "aave-v3-base",
    dataProvider: AAVE_V3.poolDataProvider.toLowerCase() as Address,
    borrow: reserve("USDC"),
    collateral: { cbBTC: reserve("cbBTC"), WETH: reserve("WETH") },
    sampledAt: new Date(sampledAtMs).toISOString(),
    ...over,
  };
}

export function emissionsFixture(
  poolId: string,
  aprByWidthPct: Record<string, number> | null,
  over: Partial<EmissionsSample> = {},
  sampledAtMs = NOW_MS
): EmissionsSample {
  return {
    poolId,
    pool: ("0x" + "11".repeat(20)) as Address,
    gauge: ("0x" + "22".repeat(20)) as Address,
    rewardRateWeiPerSec: "340364640583415175",
    periodFinish: NOW_S + 5 * 86_400,
    epochActive: true,
    wholePoolAprPct: 65,
    aprByWidthPct,
    stakedLiquidity: "5678459724668201957",
    samples: 1,
    outlier: false,
    sqrtPriceX96: "3897149340279738881397267",
    feePips: 364,
    aeroUsd: 0.478,
    sampledAt: new Date(sampledAtMs).toISOString(),
    ...over,
  };
}

export function volatilityFixture(): VolatilityInputs {
  return JSON.parse(readFileSync(new URL("../../../samples/volatility.json", import.meta.url), "utf8")) as VolatilityInputs;
}
